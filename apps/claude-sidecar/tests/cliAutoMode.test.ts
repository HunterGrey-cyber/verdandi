import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { createSession, type ClaudeRuntimeEvent, type ClaudeRuntimeSession, type QueryFn } from '@verdandi/claude-runtime';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { buildKernelSessionConfig, createRuntimeServiceImpl, mapClaudeHostPolicy, validatePolicy, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { translateEvent } from '../src/eventTranslation.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import {
  CliPermissionMode,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  PermissionMode,
  PermissionOutcome,
  ResolvePermissionRequest,
  SessionEvent,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { FakeSdk, type FakeProvider } from './compat/fakeSdk.js';
import { eitriCreate, goldenRequests, undecodableArms } from './compat/eitri.js';
import { withHarness } from './compat/harness.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/**
 * Protocol 3.14, the wire half: ClaudeHostPolicy.cli_permission_mode, ResolvePermissionRequest.defer
 * (with PERMISSION_OUTCOME_DEFERRED) and the PermissionDenied event. Each is tested ABSENT -- what a
 * 3.13 client sends, which must behave exactly as before -- and SET. Driven through the production
 * handlers, the production request mapping and the real kernel, with only the SDK's query() replaced
 * (compat/fakeSdk.ts). The kernel half is packages/claude-runtime/tests/cliAutoMode.test.ts.
 */

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };
const HOST_CLI_PATH = '/opt/fake/claude';

/** The CLI 2.1.284 message, as measured (its long model-facing `message` abridged). */
const MEASURED_DENIAL = {
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Bash',
  tool_use_id: 'toolu_017CZ9vk9wjuHQmght9KZgQo',
  decision_reason_type: 'classifier',
  decision_reason: '[Git Destructive]',
  message: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive]. ...',
};

const liveSessions: ClaudeRuntimeSession[] = [];
after(async () => {
  for (const session of liveSessions) {
    session.close();
  }
  await new Promise((r) => setTimeout(r, 100));
});

type Handler = (call: never, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => unknown;

function rpc<T>(handler: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    void handler({ request } as never, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

/** The ErrorDetail code a failed call carries, as a client reads it. */
function codeOf(err: unknown): ErrorCode | undefined {
  const bytes = (err as grpc.ServiceError).metadata?.get('grpc-status-details-bin')[0];
  return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer).code;
}

function rejectsWith(code: ErrorCode, grpcStatus: grpc.status) {
  return (err: unknown) => codeOf(err) === code && (err as grpc.ServiceError).code === grpcStatus;
}

async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sidecar() {
  const sdk = new FakeSdk();
  const sessions: ClaudeRuntimeSession[] = [];
  const queryFn: QueryFn = (params) => sdk.queryFn(params);
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    (config: ClaudeSessionConfigLike) => {
      const session = createSession(buildKernelSessionConfig(config, { hostCliPath: HOST_CLI_PATH }), queryFn);
      sessions.push(session);
      liveSessions.push(session);
      return session;
    },
    VERSIONS,
    { sdkBundledAvailable: true },
  );
  return { impl, sdk, sessions };
}

/** Eitri 0.2.0's own request shape, with the new field set (or not). */
function request(cliPermissionMode?: CliPermissionMode, extra: Partial<ClaudeHostPolicyProto> = {}): CreateSessionRequest {
  const base = CreateSessionRequest.decode(old.CreateSessionRequest.encode(eitriCreate('/tmp/project', old.StreamingMode.STREAMING_MODE_PARTIAL)).finish());
  return { ...base, policy: { ...base.policy!, ...(cliPermissionMode !== undefined ? { cliPermissionMode } : {}), ...extra } };
}

type Session = { sessionId: string; session: ClaudeRuntimeSession; provider: FakeProvider };

async function open(s: ReturnType<typeof sidecar>, req: CreateSessionRequest): Promise<Session> {
  const { sessionId } = await rpc<{ sessionId: string }>(s.impl.createSession as Handler, req);
  return { sessionId, session: s.sessions.at(-1)!, provider: s.sdk.last };
}

/** Sends a turn, plays system/init, and has the CLI ask the gate about one call; resolves with the request's id. */
async function gatedCall(s: ReturnType<typeof sidecar>, t: Session, toolUseId = 'toolu_1') {
  if (!t.session.eventLog().some((e) => e.type === 'turn_started')) {
    await rpc(s.impl.sendTurn as Handler, { sessionId: t.sessionId, commandId: `turn-${toolUseId}`, text: 'push it' });
    await t.provider.nextUserMessage();
    t.provider.init();
  }
  const before = requested(t.session).length;
  const ask = t.provider.ask('Bash', { command: 'git push --force origin main' }, toolUseId);
  await until('the request to reach the session', () => requested(t.session).length > before);
  return { ask, permissionId: requested(t.session).at(-1)!.permissionId };
}

function requested(session: ClaudeRuntimeSession) {
  return session.eventLog().filter((e): e is Extract<ClaudeRuntimeEvent, { type: 'permission_requested' }> => e.type === 'permission_requested');
}

function resolvedOutcomes(session: ClaudeRuntimeSession): string[] {
  return session.eventLog().flatMap((e) => (e.type === 'permission_resolved' ? [e.outcome] : []));
}

/** The event log fills on the PumpDriver's next poll: waits until it holds `count` resolutions. */
async function outcomesOnceSettled(session: ClaudeRuntimeSession, count: number): Promise<string[]> {
  await until(`${count} permission_resolved`, () => resolvedOutcomes(session).length >= count);
  // One more poll, so a resolution that should NOT have happened has had its chance to show up.
  await new Promise((r) => setTimeout(r, 50));
  return resolvedOutcomes(session);
}

function resolve(s: ReturnType<typeof sidecar>, t: Session, permissionId: string, commandId: string, answer: { allow?: boolean; reason?: string; defer?: boolean }) {
  return rpc(s.impl.resolvePermission as Handler, { sessionId: t.sessionId, commandId, permissionId, allow: answer.allow ?? false, reason: answer.reason ?? '', ...(answer.defer !== undefined ? { defer: answer.defer } : {}) });
}

/** A kernel event as it goes on the wire, encoded. */
function encoded(event: ClaudeRuntimeEvent): Uint8Array {
  return SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's', sequence: 1n, occurredAt: 0n, ...translateEvent(event) })).finish();
}

// ---- The handshake ---------------------------------------------------------------------------------

test('protocol 3.14 advertises cli_auto_mode, permission_defer and permission_denied_events, before the executable pair', async () => {
  assert.equal(PROTOCOL_MINOR, 14);
  const { capabilities } = await rpc<{ capabilities: string[] }>(sidecar().impl.handshake as Handler, { clientProtocolMajor: 3 });
  const firstExecutable = capabilities.indexOf('executable_host_cli');
  for (const name of ['cli_auto_mode', 'permission_defer', 'permission_denied_events']) {
    const at = capabilities.indexOf(name);
    assert.ok(at >= 0 && at < firstExecutable, `${name} at ${at}`);
  }
});

// ---- (a) absent: byte-identical to 3.13 ---------------------------------------------------------------

test('cli_permission_mode absent: Eitri\'s golden CreateSession maps to the kernel policy and SDK options it mapped to at 3.13', async () => {
  const golden = CreateSessionRequest.decode(goldenRequests().get('create_session_fresh_partial')!);
  assert.equal(golden.policy?.cliPermissionMode, CliPermissionMode.CLI_PERMISSION_MODE_UNSPECIFIED);
  const mapped = mapClaudeHostPolicy(golden.policy);
  assert.equal(Object.hasOwn(mapped, 'cliPermissionMode'), false, 'no key: the kernel policy is the 3.13 one');
  // A hand-built request from an in-process caller that never heard of the field maps the same.
  const { cliPermissionMode: _absent, ...handBuilt } = golden.policy!;
  assert.deepEqual(mapClaudeHostPolicy(handBuilt as ClaudeHostPolicyProto), mapped);
  assert.doesNotThrow(() => validatePolicy(golden.policy, { sdkBundledAvailable: false }));

  const s = sidecar();
  const t = await open(s, golden);
  assert.equal(t.provider.options.permissionMode, 'default');
  assert.equal((t.provider.options.hooks?.PreToolUse?.[0] as { matcher?: string }).matcher, '*');
  // Explicit DEFAULT reaches the SDK with exactly the same options (only the session's events differ).
  const stated = await open(s, { ...golden, policy: { ...golden.policy!, cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT } });
  const strip = (o: object) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'hooks' || k === 'canUseTool' ? undefined : v)));
  assert.deepEqual(strip(stated.provider.options), strip(t.provider.options));
});

test('defer absent: Eitri\'s golden ResolvePermission bytes decode with defer false, and answer allow/deny exactly as before', async () => {
  for (const [name, allow] of [['resolve_permission_allow', true], ['resolve_permission_deny', false]] as const) {
    const decoded = ResolvePermissionRequest.decode(goldenRequests().get(name)!);
    assert.equal(decoded.defer, false, name);
    assert.equal(decoded.allow, allow, name);
  }
  const s = sidecar();
  const t = await open(s, request());
  const allowed = await gatedCall(s, t, 'toolu_a');
  await resolve(s, t, allowed.permissionId, 'c-allow', { allow: true });
  assert.equal((await allowed.ask.result).hookSpecificOutput?.permissionDecision, 'allow');
  const denied = await gatedCall(s, t, 'toolu_d');
  await resolve(s, t, denied.permissionId, 'c-deny', { allow: false, reason: 'no', defer: false });
  assert.deepEqual(await denied.ask.result, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  assert.deepEqual(await outcomesOnceSettled(t.session, 2), ['allowed', 'denied']);
  // defer:false and an absent defer are one payload: the same command id replays rather than conflicting.
  await resolve(s, t, denied.permissionId, 'c-deny', { allow: false, reason: 'no' });
});

test('PermissionDenied absent: a session that did not state cli_permission_mode gets the ProviderNotice it always got, never the new arm', async () => {
  const s = sidecar();
  const t = await open(s, request());
  t.provider.emit(MEASURED_DENIAL);
  await until('the notice', () => t.session.eventLog().some((e) => e.type === 'provider_notice' && e.subtype === 'permission_denied'));
  assert.ok(!t.session.eventLog().some((e) => e.type === 'permission_denied'));
  for (const event of t.session.eventLog()) {
    assert.deepEqual(undecodableArms(encoded(event)), [], `${event.type} would be dropped by a 3.12 client`);
  }
});

test('the frozen Eitri 0.2.0 client meeting a CLI permission_denied: a ProviderNotice it decodes, and nothing silent', async () => {
  // withHarness fails the scenario if any event any watcher received carries an arm Eitri cannot decode.
  await withHarness({}, async (h) => {
    const sid = await h.createGolden('create_session_fresh_partial');
    const watch = h.watch(old.WatchSessionEventsRequest.fromPartial({ sessionId: sid, start: old.ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: 0n }));
    await h.sendTurn(sid, 'push it');
    await h.sdk.last.nextUserMessage();
    h.sdk.last.init();
    h.sdk.last.emit(MEASURED_DENIAL);
    // A sentinel after it, so the watcher has received whatever the denial became before anything is judged.
    h.sdk.last.systemNotice('status', { status: 'requesting' });
    assert.ok(await watch.until(() => watch.of('providerNotice').some((n) => n.subtype === 'status')));
    // First the tripwire itself (withHarness repeats it at the end): nothing this session was sent is
    // an arm Eitri 0.2.0 would drop.
    h.assertNoSilentEvents();
    assert.ok(watch.of('providerNotice').some((n) => n.subtype === 'permission_denied'), 'the denial reached Eitri as the notice it always was');
    assert.equal(watch.of('sessionReady')[0]?.permissionMode, 'default');
    watch.cancel();
  });
});

// ---- (b) AUTO -----------------------------------------------------------------------------------------

test('AUTO: the SDK is told permissionMode auto, the gate stays installed with matcher *, and SessionReady reports auto', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  assert.equal(t.provider.options.permissionMode, 'auto');
  assert.equal((t.provider.options.hooks?.PreToolUse?.[0] as { matcher?: string }).matcher, '*');
  assert.ok(t.provider.options.canUseTool !== undefined, 'Eitri\'s provider prompts stay routed under auto');
  const { ask, permissionId } = await gatedCall(s, t);
  const ready = t.session.eventLog().find((e) => e.type === 'session_ready');
  assert.equal(ready?.type === 'session_ready' ? ready.permissionMode : undefined, 'auto');
  // The gate still asks the host first, and an allow is still an allow.
  await resolve(s, t, permissionId, 'c1', { allow: true });
  assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'allow');
});

// ---- (c) AUTO only with INTERACTIVE ---------------------------------------------------------------------

test('AUTO with BYPASS, VERDANDI_RULES or permission_mode_switchable, and an unknown CLI mode, are INVALID_CONFIGURATION before any session exists', async () => {
  const s = sidecar();
  const refused: Array<[string, CreateSessionRequest]> = [
    ['bypass', request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO, { permissions: PermissionMode.PERMISSION_MODE_BYPASS })],
    ['verdandi_rules', request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO, { permissions: PermissionMode.PERMISSION_MODE_VERDANDI_RULES })],
    ['switchable', request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO, { permissionModeSwitchable: true })],
    ['unknown value', request(9 as CliPermissionMode)],
  ];
  for (const [label, req] of refused) {
    await assert.rejects(rpc(s.impl.createSession as Handler, req), rejectsWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT), label);
  }
  assert.equal(s.sdk.providers.length, 0, 'no CLI was started for any of them');
  // UNSPECIFIED permissions is read as INTERACTIVE, here as everywhere.
  await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO, { permissions: PermissionMode.PERMISSION_MODE_UNSPECIFIED }));
  assert.equal(s.sdk.last.options.permissionMode, 'auto');
  // DEFAULT combines with anything, as an absent field does.
  for (const permissions of [PermissionMode.PERMISSION_MODE_BYPASS, PermissionMode.PERMISSION_MODE_VERDANDI_RULES]) {
    await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT, { permissions, permissionModeSwitchable: true }));
  }
});

test('SetPermissionMode on an AUTO session is INVALID_CONFIGURATION for every target, and records nothing a retry could replay', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  for (const mode of [PermissionMode.PERMISSION_MODE_INTERACTIVE, PermissionMode.PERMISSION_MODE_VERDANDI_RULES, PermissionMode.PERMISSION_MODE_BYPASS]) {
    for (const attempt of [1, 2]) {
      await assert.rejects(
        rpc(s.impl.setPermissionMode as Handler, { sessionId: t.sessionId, commandId: `m-${mode}`, mode }),
        rejectsWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT),
        `${PermissionMode[mode]} attempt ${attempt}`,
      );
    }
  }
  assert.ok(!t.session.eventLog().some((e) => e.type === 'permission_mode_changed'));
});

// ---- (d) defer -------------------------------------------------------------------------------------------

test('defer: the CLI gets no decision ({}), the request resolves DEFERRED on the wire, and a replay of the same command is a no-op', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  const { ask, permissionId } = await gatedCall(s, t);
  await resolve(s, t, permissionId, 'c1', { allow: false, reason: 'ignored', defer: true });
  assert.deepEqual(await ask.result, {}, 'no decision at all: the classifier decides');
  assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['deferred']);
  const resolved = t.session.eventLog().find((e) => e.type === 'permission_resolved')!;
  assert.equal(SessionEvent.decode(encoded(resolved)).permissionResolved?.outcome, PermissionOutcome.PERMISSION_OUTCOME_DEFERRED);
  // Idempotent per command id: the same payload replays; the same id without defer is a different
  // payload and conflicts.
  await resolve(s, t, permissionId, 'c1', { allow: false, reason: 'ignored', defer: true });
  await assert.rejects(resolve(s, t, permissionId, 'c1', { allow: false, reason: 'ignored' }), rejectsWith(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, grpc.status.FAILED_PRECONDITION));
  await assert.rejects(resolve(s, t, permissionId, 'c1', { allow: false, reason: 'ignored', defer: false }), rejectsWith(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, grpc.status.FAILED_PRECONDITION));
  // A fresh command for the already-resolved id: not found, as for any answer.
  await assert.rejects(resolve(s, t, permissionId, 'c2', { defer: true }), rejectsWith(ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND, grpc.status.NOT_FOUND));
  assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['deferred']);
});

test('defer works on a DEFAULT session too (the CLI\'s normal ask decides), and the reverse: a command first sent without defer conflicts with defer', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT));
  assert.equal(t.provider.options.permissionMode, 'default');
  const first = await gatedCall(s, t, 'toolu_1');
  await resolve(s, t, first.permissionId, 'c1', { allow: false, reason: 'no' });
  assert.equal((await first.ask.result).hookSpecificOutput?.permissionDecision, 'deny');
  await assert.rejects(resolve(s, t, first.permissionId, 'c1', { allow: false, reason: 'no', defer: true }), rejectsWith(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, grpc.status.FAILED_PRECONDITION));
  const second = await gatedCall(s, t, 'toolu_2');
  await resolve(s, t, second.permissionId, 'c2', { defer: true });
  assert.deepEqual(await second.ask.result, {});
});

test('defer for an unknown permission id is PERMISSION_NOT_FOUND, exactly as allow and deny are', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  for (const answer of [{ defer: true }, { allow: true }, { allow: false }]) {
    await assert.rejects(resolve(s, t, 'no-such-permission', `c-${JSON.stringify(answer)}`, answer), rejectsWith(ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND, grpc.status.NOT_FOUND));
  }
});

test('defer on a PROVIDER_PROMPT request is INVALID_CONFIGURATION; the request stays pending and a real answer still lands', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  await rpc(s.impl.sendTurn as Handler, { sessionId: t.sessionId, commandId: 't1', text: 'write it' });
  await t.provider.nextUserMessage();
  t.provider.init();
  const prompt = t.provider.prompt('Write', { file_path: '/tmp/project/.git/probe', content: 'x' }, 'toolu_p', { decisionReason: 'sensitive file' });
  await until('the provider prompt', () => requested(t.session).some((r) => r.origin === 'provider_prompt'));
  const { permissionId } = requested(t.session).find((r) => r.origin === 'provider_prompt')!;
  for (const attempt of [1, 2]) {
    await assert.rejects(resolve(s, t, permissionId, 'c1', { defer: true }), rejectsWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT), `attempt ${attempt}`);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(resolvedOutcomes(t.session), [], 'nothing resolved');
  await resolve(s, t, permissionId, 'c2', { allow: false, reason: 'not that file' });
  assert.deepEqual(await prompt.result, { behavior: 'deny', message: 'not that file' });
  assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['denied']);
});

test('fail-closed in a defer-capable AUTO session: hook timeout, interrupt, close and provider death all still DENY, and a late defer is not found', async () => {
  for (const end of ['hook timeout', 'interrupt', 'close', 'provider death'] as const) {
    const s = sidecar();
    const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
    const { ask, permissionId } = await gatedCall(s, t);
    if (end === 'hook timeout') {
      ask.abort();
    } else if (end === 'interrupt') {
      await rpc(s.impl.interruptTurn as Handler, { sessionId: t.sessionId, commandId: 'i1' });
    } else if (end === 'close') {
      await rpc(s.impl.closeSession as Handler, { sessionId: t.sessionId, commandId: 'x1' });
    } else {
      t.provider.fail(new Error('the CLI died'));
    }
    const output = await ask.result;
    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny', `${end}: denied, never left to the classifier`);
    const expected = { 'hook timeout': 'expired', interrupt: 'cancelled_by_interrupt', close: 'cancelled_by_session_close', 'provider death': 'provider_failed' }[end];
    assert.deepEqual(await outcomesOnceSettled(t.session, 1), [expected], end);
    // The session may be gone (close, provider death), in which case the registry answers first.
    await assert.rejects(
      resolve(s, t, permissionId, 'late', { defer: true }),
      (err: unknown) => codeOf(err) === ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND || codeOf(err) === ErrorCode.ERROR_CODE_SESSION_NOT_FOUND,
      end,
    );
    assert.deepEqual(await outcomesOnceSettled(t.session, 1), [expected], `${end}: the late defer changed nothing`);
  }
});

// ---- (e) PermissionDenied --------------------------------------------------------------------------------

test('PermissionDenied: the measured 2.1.284 message reaches a session that stated the CLI mode as the new event, strings verbatim', async () => {
  for (const mode of [CliPermissionMode.CLI_PERMISSION_MODE_AUTO, CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT]) {
    const s = sidecar();
    const t = await open(s, request(mode));
    t.provider.emit(MEASURED_DENIAL);
    await until('the event', () => t.session.eventLog().some((e) => e.type === 'permission_denied'));
    assert.ok(!t.session.eventLog().some((e) => e.type === 'provider_notice' && e.subtype === 'permission_denied'), 'the event replaces the notice, it does not duplicate it');
    const denied = t.session.eventLog().find((e) => e.type === 'permission_denied')!;
    const wire = SessionEvent.decode(encoded(denied));
    assert.deepEqual(wire.permissionDenied, { toolUseId: 'toolu_017CZ9vk9wjuHQmght9KZgQo', toolName: 'Bash', reasonType: 'classifier', reason: '[Git Destructive]' }, CliPermissionMode[mode]);
    assert.equal(wire.turnId, undefined, 'like the other permission events, it carries no turn id');
    assert.deepEqual(undecodableArms(encoded(denied)), [23], 'arm 23: exactly what a 3.12 client cannot decode, which is why it is gated');
  }
});

test('PermissionDenied: absent optional strings stay absent on the wire', () => {
  const wire = SessionEvent.decode(encoded({ type: 'permission_denied', toolUseId: '', toolName: 'Read' }));
  assert.equal(wire.permissionDenied?.toolUseId, '');
  assert.equal(wire.permissionDenied?.toolName, 'Read');
  assert.equal(wire.permissionDenied?.reasonType, undefined);
  assert.equal(wire.permissionDenied?.reason, undefined);
});

// ---- defer refusals that leave the request pending ---------------------------------------------------------

test('allow true with defer true is INVALID_CONFIGURATION; nothing is recorded, so the same command id can then carry a real answer', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_AUTO));
  const { ask, permissionId } = await gatedCall(s, t);
  for (const attempt of [1, 2]) {
    await assert.rejects(resolve(s, t, permissionId, 'c1', { allow: true, defer: true }), rejectsWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT), `attempt ${attempt}`);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(resolvedOutcomes(t.session), [], 'still pending');
  await resolve(s, t, permissionId, 'c2', { allow: true });
  assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'allow');
  assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['allowed']);
});

test('a switchable session refuses defer -- before any switch, and in the reviewed race (SetPermissionMode(BYPASS) queued, then a defer) -- as INVALID_CONFIGURATION; the request stays pending and a deny lands', async () => {
  const s = sidecar();
  const t = await open(s, request(CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT, { permissionModeSwitchable: true, toolPolicy: undefined }));
  const { ask, permissionId } = await gatedCall(s, t);
  const refused = rejectsWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT);
  await assert.rejects(resolve(s, t, permissionId, 'c1', { defer: true }), refused, 'before any switch');
  // Both calls are issued in the same tick: the switch is still queued when the defer is answered.
  const switching = rpc(s.impl.setPermissionMode as Handler, { sessionId: t.sessionId, commandId: 'm1', mode: PermissionMode.PERMISSION_MODE_BYPASS });
  const deferring = resolve(s, t, permissionId, 'c2', { defer: true });
  await assert.rejects(deferring, refused, 'with the switch queued');
  await switching;
  const fresh = t.provider.ask('Bash', { command: 'rm -rf build' }, 'toolu_fresh');
  assert.equal((await fresh.result).hookSpecificOutput?.permissionDecision, 'deny', 'the floor denies a fresh Bash');
  await assert.rejects(resolve(s, t, permissionId, 'c3', { defer: true }), refused, 'after the switch');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(resolvedOutcomes(t.session), []);
  await resolve(s, t, permissionId, 'c4', { allow: false, reason: 'no' });
  assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['denied']);
});

test('a non-switchable session accepts defer, DEFAULT and AUTO alike', async () => {
  for (const mode of [CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT, CliPermissionMode.CLI_PERMISSION_MODE_AUTO]) {
    const s = sidecar();
    const t = await open(s, request(mode, { permissionModeSwitchable: false }));
    const { ask, permissionId } = await gatedCall(s, t);
    await resolve(s, t, permissionId, 'c1', { defer: true });
    assert.deepEqual(await ask.result, {}, CliPermissionMode[mode]);
    assert.deepEqual(await outcomesOnceSettled(t.session, 1), ['deferred']);
  }
});
