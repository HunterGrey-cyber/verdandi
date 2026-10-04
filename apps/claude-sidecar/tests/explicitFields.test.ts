import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  createSession,
  PROVIDER_PROMPT_TOOL_DENY,
  STRUCTURED_OUTPUT_CARRIER_TOOLS,
  WEBFETCH_PRIVATE_DENY,
  type ClaudeRuntimeEvent,
  type ClaudeRuntimeSession,
  type QueryFn,
} from '@verdandi/claude-runtime';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { buildKernelSessionConfig, createRuntimeServiceImpl, mapClaudeHostPolicy, validatePolicy, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { translateEvent } from '../src/eventTranslation.js';
import { startSidecar } from '../src/lifecycle.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import {
  ConfigurationProfile,
  CreateSessionRequest,
  CreateSessionResponse,
  EgressProbe,
  ExecutableSource,
  HandshakeResponse,
  InitCheck,
  PermissionMode,
  PersistenceMode,
  RuntimeServiceClient,
  SessionEvent,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
  type SessionReady,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { FakeSdk, type FakeProvider } from './compat/fakeSdk.js';
import { goldenRequests } from './compat/eitri.js';
import { REPO_ROOT } from './compat/paths.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/**
 * The explicit fields of protocol 3.13, each tested twice: ABSENT, which must behave exactly as a 3.12
 * sidecar did for the same request, and SET. Driven through the production handlers, the production
 * request mapping and the real kernel, with only the SDK's query() replaced (compat/fakeSdk.ts).
 *
 *   - ToolAllowList.init_check
 *   - CreateSessionRequest.await_account_identity / CreateSessionResponse.account_identity
 *   - HandshakeResponse.egress_probe / structured_output_tools
 *   - SessionReady.effective_disallowed_tools / effective_tools
 */

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };
const HOST_CLI_PATH = '/opt/fake/claude';
const SCHEMA = '{"type":"object"}';

const liveSessions: ClaudeRuntimeSession[] = [];
after(async () => {
  for (const session of liveSessions) {
    session.close();
  }
  // One PumpDriver tick, so every driver sees its session_closed and stops.
  await new Promise((r) => setTimeout(r, 100));
});

type Call = { request: unknown; cancelled?: boolean };
type Handler = (call: never, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => unknown;

function rpc<T>(handler: Handler, request: unknown, extra: Omit<Call, 'request'> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    void handler({ request, ...extra } as never, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
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

/**
 * The sidecar's handlers over the real kernel and the fake SDK. `accountInfo` replaces the SDK's
 * answer (e.g. with one that never comes); `accountInfoTimeoutMs` shortens the probe's deadline, which
 * production leaves at its default.
 */
function sidecar(opts: { accountInfo?: () => Promise<AccountInfo>; accountInfoTimeoutMs?: number; egressRestricted?: boolean } = {}) {
  const sdk = new FakeSdk({ tools: [] });
  const registry = new SessionRegistry();
  const sessions: ClaudeRuntimeSession[] = [];
  const queryFn: QueryFn = (params) => {
    const query = sdk.queryFn(params);
    if (opts.accountInfo !== undefined) {
      query.accountInfo = opts.accountInfo;
    }
    return query;
  };
  const impl = createRuntimeServiceImpl(
    registry,
    (config: ClaudeSessionConfigLike) => {
      const session = createSession(
        {
          ...buildKernelSessionConfig(config, { hostCliPath: HOST_CLI_PATH }),
          ...(opts.accountInfoTimeoutMs !== undefined ? { accountInfoTimeoutMs: opts.accountInfoTimeoutMs } : {}),
        },
        queryFn,
      );
      sessions.push(session);
      liveSessions.push(session);
      return session;
    },
    VERSIONS,
    { sdkBundledAvailable: true, ...(opts.egressRestricted !== undefined ? { egressRestricted: opts.egressRestricted } : {}) },
  );
  return { impl, sdk, registry, sessions };
}

/** A completion-shaped request: bypass, isolated, an explicit allow list, structured output. */
function completionRequest(allow: string[], extra: { initCheck?: InitCheck; deny?: string[]; awaitAccountIdentity?: boolean } = {}): CreateSessionRequest {
  return CreateSessionRequest.fromPartial({
    cwd: '/tmp/project',
    policy: {
      configuration: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED,
      permissions: PermissionMode.PERMISSION_MODE_BYPASS,
      persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      settingSources: { sources: [] },
      toolPolicy: { deny: extra.deny ?? [], allow: { tools: allow, ...(extra.initCheck !== undefined ? { initCheck: extra.initCheck } : {}) } },
    },
    outputFormat: { jsonSchemaJson: SCHEMA },
    ...(extra.awaitAccountIdentity !== undefined ? { awaitAccountIdentity: extra.awaitAccountIdentity } : {}),
  });
}

/** Creates a session, sends one turn, has the CLI answer with `initTools`, and waits for the turn or the session to end. */
async function runOneTurn(s: ReturnType<typeof sidecar>, request: CreateSessionRequest, initTools: string[]) {
  const { sessionId } = await rpc<{ sessionId: string }>(s.impl.createSession as Handler, request);
  const session = s.sessions.at(-1)!;
  const provider: FakeProvider = s.sdk.last;
  await rpc(s.impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'score these' });
  await provider.nextUserMessage();
  provider.init({ tools: initTools });
  provider.emit({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', terminal_reason: 'completed', structured_output: {} });
  const done = (e: ClaudeRuntimeEvent) => e.type === 'session_closed' || e.type === 'turn_completed';
  await until('the turn or the session to end', () => session.eventLog().some(done));
  // A violation closes right after the session_ready, so give a passing turn the same chance to be closed.
  await new Promise((r) => setTimeout(r, 60));
  return { sessionId, session, provider, events: [...session.eventLog()] };
}

function wireSessionReady(events: readonly ClaudeRuntimeEvent[]): SessionReady {
  const ready = events.find((e) => e.type === 'session_ready');
  assert.ok(ready !== undefined, 'no session_ready');
  const full = SessionEvent.fromPartial({ sessionId: 's', sequence: 1n, occurredAt: 0n, ...translateEvent(ready) });
  const decoded = SessionEvent.decode(SessionEvent.encode(full).finish()).sessionReady;
  assert.ok(decoded !== undefined);
  return decoded;
}

// ---- (a) ToolAllowList.init_check -------------------------------------------------------------

test('init_check absent: a request from a client that predates it maps to exactly the kernel policy it mapped to at 3.12', () => {
  // Built and encoded with the frozen b3aa188 types, so the field cannot be there, then decoded the way
  // this sidecar decodes it.
  const frozen = old.ClaudeHostPolicy.fromPartial({
    permissions: old.PermissionMode.PERMISSION_MODE_BYPASS,
    toolPolicy: { deny: ['Bash'], allow: { tools: ['WebFetch'] } },
  });
  const decoded = CreateSessionRequest.decode(old.CreateSessionRequest.encode(old.CreateSessionRequest.fromPartial({ cwd: '/tmp/p', policy: frozen })).finish());
  assert.equal(decoded.policy?.toolPolicy?.allow?.initCheck, InitCheck.INIT_CHECK_UNSPECIFIED);
  const mapped = mapClaudeHostPolicy(decoded.policy);
  assert.deepEqual(mapped.toolPolicy, { deny: ['Bash'], allow: ['WebFetch'], unrestricted: false }, 'no initCheck key: the kernel config is the 3.12 one');
  // An in-process caller that builds the object by hand and never heard of the field gets the same.
  const handBuilt = { ...decoded.policy!, toolPolicy: { ...decoded.policy!.toolPolicy!, allow: { tools: ['WebFetch'] } } } as unknown as ClaudeHostPolicyProto;
  assert.deepEqual(mapClaudeHostPolicy(handBuilt), mapped);
  assert.doesNotThrow(() => validatePolicy(handBuilt, { sdkBundledAvailable: true }));
});

test('init_check set: VERIFY and REPORT_ONLY reach the kernel; an unknown value is refused before any session exists', async () => {
  const withCheck = (initCheck: InitCheck) => completionRequest([], { initCheck }).policy;
  assert.equal(mapClaudeHostPolicy(withCheck(InitCheck.INIT_CHECK_VERIFY)).toolPolicy?.initCheck, 'verify');
  assert.equal(mapClaudeHostPolicy(withCheck(InitCheck.INIT_CHECK_REPORT_ONLY)).toolPolicy?.initCheck, 'report_only');
  assert.equal('initCheck' in (mapClaudeHostPolicy(withCheck(InitCheck.INIT_CHECK_UNSPECIFIED)).toolPolicy ?? {}), false);

  const unknown = 7 as InitCheck;
  assert.throws(() => validatePolicy(withCheck(unknown), { sdkBundledAvailable: true }), /init_check is 7, which is not a check this sidecar knows/);
  const s = sidecar();
  await assert.rejects(
    () => rpc(s.impl.createSession as Handler, completionRequest([], { initCheck: unknown })),
    (err: grpc.ServiceError) => err.code === grpc.status.INVALID_ARGUMENT,
  );
  assert.equal(s.sessions.length, 0, 'no session, and so no CLI, for a check that cannot be honoured');
});

test('init_check over the sidecar: absent and VERIFY close over an extra init tool exactly alike; REPORT_ONLY reports it and runs on', async () => {
  const extra = [...STRUCTURED_OUTPUT_CARRIER_TOOLS, 'Bash'];
  const outcomes = new Map<string, { types: string[]; closeReason: string | undefined; fingerprint: string[] | undefined; providerClosed: boolean }>();
  for (const [name, initCheck] of [['absent', undefined], ['verify', InitCheck.INIT_CHECK_VERIFY], ['report_only', InitCheck.INIT_CHECK_REPORT_ONLY]] as const) {
    const s = sidecar();
    const { events, provider } = await runOneTurn(s, completionRequest([], initCheck === undefined ? {} : { initCheck }), extra);
    const closed = events.find((e) => e.type === 'session_closed');
    outcomes.set(name, {
      types: events.map((e) => e.type),
      closeReason: closed?.type === 'session_closed' ? closed.reason : undefined,
      fingerprint: wireSessionReady(events).initFingerprint?.tools,
      providerClosed: provider.closed,
    });
  }
  const absent = outcomes.get('absent')!;
  assert.equal(absent.closeReason, 'tool_policy_violation', 'absent verifies, as at 3.12');
  assert.equal(absent.providerClosed, true);
  assert.deepEqual(outcomes.get('verify'), absent);
  const reportOnly = outcomes.get('report_only')!;
  assert.equal(reportOnly.closeReason, undefined, 'REPORT_ONLY never closes over the mismatch');
  assert.equal(reportOnly.providerClosed, false);
  assert.ok(reportOnly.types.includes('turn_completed'));
  assert.deepEqual(reportOnly.fingerprint, extra, 'the fingerprint still reports what the CLI built');
});

// ---- (b) CreateSessionRequest.await_account_identity ------------------------------------------

test('await_account_identity absent or false: CreateSession answers at once with the session id alone, and never asks for the identity', async () => {
  const { makeFakeSession } = await import('./fakeSession.js');
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => {
    const m = makeFakeSession();
    made.push(m);
    return m.session;
  }, VERSIONS);
  // The fake's identity never settles unless told to, so a handler that awaited it would hang here.
  for (const request of [{ cwd: '/tmp/p', policy: undefined }, { cwd: '/tmp/p', policy: undefined, awaitAccountIdentity: false }]) {
    const res = await rpc<Record<string, unknown>>(impl.createSession as Handler, request);
    assert.deepEqual(Object.keys(res), ['sessionId'], 'nothing beside the id');
    assert.deepEqual(
      Buffer.from(CreateSessionResponse.encode(CreateSessionResponse.fromPartial(res as never)).finish()),
      Buffer.from(old.CreateSessionResponse.encode({ sessionId: res.sessionId as string }).finish()),
      'the response bytes a 3.12 sidecar sent',
    );
  }
  for (const m of made) {
    assert.equal(m.controller.accountIdentityCalls, 0, 'no wait on the probe');
    m.session.close();
  }
});

test('await_account_identity absent: Eitri 0.2.0\'s own request decodes to false, and its CreateSession does not wait on a probe that never answers', async () => {
  const golden = goldenRequests().get('create_session_fresh_partial');
  assert.ok(golden !== undefined);
  const request = CreateSessionRequest.decode(golden);
  assert.equal(request.awaitAccountIdentity, false);
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 10_000 });
  const started = Date.now();
  const res = await rpc<Record<string, unknown>>(s.impl.createSession as Handler, request);
  assert.ok(Date.now() - started < 1_000, `CreateSession took ${Date.now() - started} ms`);
  assert.deepEqual(Object.keys(res), ['sessionId']);
});

test('await_account_identity: the response carries the identity the probe found, and no turn has been sent', async () => {
  const s = sidecar();
  const res = await rpc<{ sessionId: string; accountIdentity: unknown }>(s.impl.createSession as Handler, completionRequest([], { awaitAccountIdentity: true }));
  const wire = CreateSessionResponse.decode(CreateSessionResponse.encode(CreateSessionResponse.fromPartial(res as never)).finish());
  assert.deepEqual(wire.accountIdentity, { email: 'fake-account@example.invalid', organization: 'Fake Organization', subscriptionType: 'pro', tokenSource: 'fake', error: undefined });
  assert.deepEqual(s.sdk.last.userMessages, []);
  // The completion-shaped hold is still there; with the identity already settled it does not wait.
  await rpc(s.impl.sendTurn as Handler, { sessionId: res.sessionId, commandId: 'c1', text: 'go' });
  assert.equal(await s.sdk.last.nextUserMessage(), 'go');
});

test('await_account_identity: a probe that never answers returns after the deadline with error set, and no turn was sent', async () => {
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 150 });
  const started = Date.now();
  const res = await rpc<{ sessionId: string; accountIdentity: { error?: string; email?: string } }>(
    s.impl.createSession as Handler,
    completionRequest([], { awaitAccountIdentity: true }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 140, `answered after ${elapsed} ms, before the deadline`);
  assert.match(res.accountIdentity.error ?? '', /did not answer within 150ms/);
  assert.equal(res.accountIdentity.email, undefined);
  assert.deepEqual(s.sdk.last.userMessages, [], 'nothing reached the CLI');
  assert.ok(s.registry.get(res.sessionId) !== undefined, 'the session itself is alive; deciding what to do is the caller\'s');
});

test('await_account_identity holds only its own call: the handshake and another CreateSession are answered meanwhile', async () => {
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 400 });
  let waitingAnswered = false;
  const waiting = rpc<{ accountIdentity: { error?: string } }>(s.impl.createSession as Handler, completionRequest([], { awaitAccountIdentity: true })).then((res) => {
    waitingAnswered = true;
    return res;
  });
  const handshake = await rpc<{ protocolMajor: number }>(s.impl.handshake as Handler, { clientProtocolMajor: 3 });
  assert.equal(handshake.protocolMajor, 3);
  const other = await rpc<Record<string, unknown>>(s.impl.createSession as Handler, completionRequest([]));
  assert.deepEqual(Object.keys(other), ['sessionId']);
  assert.equal(waitingAnswered, false, 'the waiting call is still waiting');
  assert.match((await waiting).accountIdentity.error ?? '', /did not answer within 400ms/);
});

/** A unary call as grpc-js hands it to the handler: the request, `cancelled`, and its 'cancelled' event. */
function fakeUnaryCall(request: unknown) {
  const listeners: Array<() => void> = [];
  return {
    request,
    cancelled: false,
    on(event: 'cancelled', listener: () => void) {
      if (event === 'cancelled') {
        listeners.push(listener);
      }
      return this;
    },
    /** What grpc-js does when the client cancels, and also -- as its own end-of-call notice -- right after it sent an answer. */
    cancel() {
      this.cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

async function fakeSessionImpl() {
  const { makeFakeSession } = await import('./fakeSession.js');
  const made = makeFakeSession();
  const registry = new SessionRegistry();
  const impl = createRuntimeServiceImpl(registry, () => made.session, VERSIONS);
  return { made, impl, registry };
}

test('await_account_identity: a provider that exits while the call waits fails CreateSession with the close reason, not OK with a dead id', async () => {
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 10_000 });
  const started = Date.now();
  const waiting = rpc(s.impl.createSession as Handler, completionRequest([], { awaitAccountIdentity: true }));
  await until('the session to be registered', () => s.registry.allSessionIds().length === 1);
  s.sdk.last.end();
  await assert.rejects(waiting, (err: grpc.ServiceError) => {
    assert.equal(err.code, grpc.status.UNAVAILABLE);
    assert.match(err.message, /the session ended \(provider_exited\) while CreateSession was waiting/);
    return true;
  });
  assert.ok(Date.now() - started < 2_000, 'at once, not at the probe deadline');
});

test('await_account_identity: a session closed while the call waits fails CreateSession with closed_by_host', async () => {
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 10_000 });
  const waiting = rpc(s.impl.createSession as Handler, completionRequest([], { awaitAccountIdentity: true }));
  await until('the session to be registered', () => s.registry.allSessionIds().length === 1);
  await rpc(s.impl.closeSession as Handler, { sessionId: s.registry.allSessionIds()[0], commandId: 'close-1' });
  await assert.rejects(waiting, (err: grpc.ServiceError) => err.code === grpc.status.UNAVAILABLE && /\(closed_by_host\)/.test(err.message));
});

test('await_account_identity: a probe that answered just before the provider died still fails CreateSession', async () => {
  const { made, impl } = await fakeSessionImpl();
  const waiting = rpc(impl.createSession as Handler, { cwd: '/tmp/p', policy: undefined, awaitAccountIdentity: true });
  // Both before the handler resumes: the identity is a good one, but the session is already gone.
  made.controller.settleAccountIdentity({ status: 'answered', email: 'x@example.invalid', organization: null, subscriptionType: null, tokenSource: null });
  made.controller.endSession('provider_failed');
  await assert.rejects(waiting, (err: grpc.ServiceError) => err.code === grpc.status.UNAVAILABLE && /\(provider_failed\)/.test(err.message));
});

test('await_account_identity: an identity that cannot be read closes the session before the error is answered', async () => {
  const { made, impl } = await fakeSessionImpl();
  made.controller.makeNextAccountIdentityReject(new Error('probe exploded'));
  await assert.rejects(rpc(impl.createSession as Handler, { cwd: '/tmp/p', policy: undefined, awaitAccountIdentity: true }), /probe exploded/);
  assert.equal(made.controller.closeCalls, 1, 'nobody holds the id, so the session is closed');
});

test('await_account_identity: a cancel during the wait closes the session at once and sends no answer', async () => {
  const s = sidecar({ accountInfo: () => new Promise<AccountInfo>(() => {}), accountInfoTimeoutMs: 10_000 });
  const call = fakeUnaryCall(completionRequest([], { awaitAccountIdentity: true }));
  let answered = false;
  const started = Date.now();
  const handled = (s.impl.createSession as Handler)(call as never, () => {
    answered = true;
  });
  await until('the session to exist', () => s.sessions.length === 1);
  call.cancel();
  assert.equal(s.sessions[0]!.closeReason(), 'closed_by_host', 'closed synchronously by the cancel, not when the probe settles');
  await handled;
  assert.ok(Date.now() - started < 2_000, `the handler took ${Date.now() - started} ms; the probe deadline is 10 s`);
  assert.equal(answered, false, 'nobody to answer');
});

test('await_account_identity: a cancelled call gets no answer even when the identity then fails to read', async () => {
  const { made, impl } = await fakeSessionImpl();
  made.controller.makeNextAccountIdentityReject(new Error('probe exploded'));
  const call = fakeUnaryCall({ cwd: '/tmp/p', policy: undefined, awaitAccountIdentity: true });
  let answered = false;
  const handled = (impl.createSession as Handler)(call as never, () => {
    answered = true;
  });
  // Before the handler resumes from its await: the cancel lands first, the rejection after it.
  call.cancel();
  await handled;
  assert.equal(answered, false, 'the client is gone: no error answer either');
  assert.ok(made.controller.closeCalls >= 1, 'and the session is closed');
});

test('await_account_identity: grpc-js\'s cancelled notice after the answer does not close the session it handed out', async () => {
  const { made, impl } = await fakeSessionImpl();
  const call = fakeUnaryCall({ cwd: '/tmp/p', policy: undefined, awaitAccountIdentity: true });
  let res: { sessionId?: string } | undefined;
  const handled = (impl.createSession as Handler)(call as never, (_err, r) => {
    res = r as { sessionId?: string };
    call.cancel();
  });
  made.controller.settleAccountIdentity({ status: 'answered', email: 'x@example.invalid', organization: null, subscriptionType: null, tokenSource: null });
  await handled;
  assert.ok(res?.sessionId !== undefined);
  assert.equal(made.controller.closeCalls, 0);
  made.session.close();
});

test('await_account_identity over a real socket: the session handed out stays usable, and a client cancel closes a waiting one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-await-'));
  const socketPath = join(dir, 'sidecar.sock');
  const sdk = new FakeSdk({ tools: [] });
  let probeAnswers = true;
  const sessions: ClaudeRuntimeSession[] = [];
  let server: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  try {
    server = await startSidecar({
      socketPath,
      sessionFactory: (config: ClaudeSessionConfigLike) => {
        const answers = probeAnswers;
        const session = createSession({ ...buildKernelSessionConfig(config, { hostCliPath: HOST_CLI_PATH }), accountInfoTimeoutMs: 10_000 }, (params) => {
          const query = sdk.queryFn(params);
          if (!answers) {
            query.accountInfo = () => new Promise<AccountInfo>(() => {});
          }
          return query;
        });
        sessions.push(session);
        liveSessions.push(session);
        return session;
      },
      getClaudeCodeVersions: () => VERSIONS,
      classifyCliVersion: () => ({ kind: 'supported' }),
    });
    const c = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
    client = c;

    const created = await new Promise<CreateSessionResponse>((resolve, reject) =>
      c.createSession(completionRequest([], { awaitAccountIdentity: true }), (err, r) => (err ? reject(err) : resolve(r))),
    );
    assert.equal(created.accountIdentity?.email, 'fake-account@example.invalid');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sessions[0]!.closeReason(), undefined, 'the answered call did not close its session');
    await new Promise<void>((resolve, reject) =>
      c.sendTurn({ sessionId: created.sessionId, commandId: 'c1', text: 'go' }, (err) => (err ? reject(err) : resolve())),
    );
    assert.equal(await sdk.last.nextUserMessage(), 'go');

    probeAnswers = false;
    const started = Date.now();
    const pending = c.createSession(completionRequest([], { awaitAccountIdentity: true }), () => {});
    await until('the second session to exist', () => sessions.length === 2);
    pending.cancel();
    await until('the cancelled call\'s session to close', () => sessions[1]!.closeReason() !== undefined, 2_000);
    assert.equal(sessions[1]!.closeReason(), 'closed_by_host');
    assert.ok(Date.now() - started < 2_000, 'well before the 10 s probe deadline');
  } finally {
    client?.close();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (c) the handshake: egress_probe, structured_output_tools ---------------------------------

test('handshake: egress_probe is NOT_RUN unless startup proved loopback blocked; structured_output_tools is the carrier list', async () => {
  for (const [egressRestricted, probe] of [[undefined, EgressProbe.EGRESS_PROBE_NOT_RUN], [false, EgressProbe.EGRESS_PROBE_NOT_RUN], [true, EgressProbe.EGRESS_PROBE_LOOPBACK_BLOCKED]] as const) {
    const s = sidecar(egressRestricted === undefined ? {} : { egressRestricted });
    const res = await rpc<HandshakeResponse>(s.impl.handshake as Handler, { clientProtocolMajor: 3 });
    const wire = HandshakeResponse.decode(HandshakeResponse.encode(res).finish());
    assert.equal(wire.egressProbe, probe, `egressRestricted=${egressRestricted}`);
    assert.equal(wire.capabilities.includes('egress_restricted'), egressRestricted === true, 'egress_restricted is advertised exactly as before');
    assert.deepEqual(wire.structuredOutputTools, ['StructuredOutput']);
    assert.deepEqual(wire.structuredOutputTools, [...STRUCTURED_OUTPUT_CARRIER_TOOLS]);
  }
});

// ---- (d) SessionReady.effective_disallowed_tools / effective_tools ----------------------------

test('effective tools, web completion: the caller\'s deny then the private-address rules; Options.tools is the allow list exactly, no carrier', async () => {
  const s = sidecar();
  const allow = ['WebFetch', 'WebSearch'];
  const { events, provider } = await runOneTurn(s, completionRequest(allow, { deny: ['Bash'] }), [...STRUCTURED_OUTPUT_CARRIER_TOOLS, ...allow]);
  assert.equal(events.some((e) => e.type === 'session_closed'), false);
  const ready = wireSessionReady(events);
  assert.deepEqual(ready.effectiveDisallowedTools, ['Bash', ...WEBFETCH_PRIVATE_DENY]);
  assert.deepEqual(ready.effectiveDisallowedTools, provider.options.disallowedTools, 'exactly what the SDK was told');
  assert.deepEqual(ready.effectiveTools, { tools: allow });
  assert.deepEqual(ready.effectiveTools?.tools, provider.options.tools, 'exactly what the SDK was told');
  assert.equal(ready.effectiveTools?.tools.includes('StructuredOutput'), false, 'the carrier is the CLI\'s addition, reported in the handshake');
});

test('effective tools, zero-tool completion: an empty list is present and empty, nothing is disallowed', async () => {
  const s = sidecar();
  const { events, provider } = await runOneTurn(s, completionRequest([]), [...STRUCTURED_OUTPUT_CARRIER_TOOLS]);
  const ready = wireSessionReady(events);
  assert.deepEqual(ready.effectiveTools, { tools: [] });
  assert.deepEqual(ready.effectiveDisallowedTools, []);
  assert.equal(provider.options.disallowedTools, undefined, 'the SDK was handed no disallowedTools at all');
});

test('effective tools, Eitri 0.2.0\'s request: the three prompt-tool denies, and no tool list', async () => {
  const golden = goldenRequests().get('create_session_fresh_partial');
  assert.ok(golden !== undefined);
  const s = sidecar();
  const { sessionId } = await rpc<{ sessionId: string }>(s.impl.createSession as Handler, CreateSessionRequest.decode(golden));
  const provider = s.sdk.last;
  await rpc(s.impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'hello' });
  await provider.nextUserMessage();
  provider.init();
  const session = s.sessions.at(-1)!;
  await until('session_ready', () => session.eventLog().some((e) => e.type === 'session_ready'));
  const ready = wireSessionReady(session.eventLog());
  assert.deepEqual(ready.effectiveDisallowedTools, [...PROVIDER_PROMPT_TOOL_DENY]);
  assert.deepEqual(ready.effectiveDisallowedTools, provider.options.disallowedTools);
  assert.equal(ready.effectiveTools, undefined);
  assert.equal(provider.options.tools, undefined);
  assert.equal(ready.permissionMode, 'default', 'the verbatim permission mode is untouched');
});

test('effective tools on the wire: absent and present-but-empty stay apart', () => {
  const roundTrip = (effectiveTools: { tools: string[] } | undefined) =>
    SessionEvent.decode(
      SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's', sessionReady: { sessionId: 'p', effectiveTools } })).finish(),
    ).sessionReady?.effectiveTools;
  assert.equal(roundTrip(undefined), undefined);
  assert.deepEqual(roundTrip({ tools: [] }), { tools: [] });
});

// ---- (e) the ledger -----------------------------------------------------------------------------

test('protocol 3.13 records these fields, and its capabilities sit before the executable pair', async () => {
  // At least: later minors add their own fields on top, and this test is about what 13 recorded.
  assert.ok(PROTOCOL_MINOR >= 13, `protocol minor ${PROTOCOL_MINOR}`);
  const source = JSON.parse(readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json'), 'utf8')) as {
    capabilities: Array<{ name: string; since_minor: number }>;
    minors: Array<{ minor: number; wire_additions?: string[] }>;
  };
  const added = ['init_check', 'await_account_identity', 'egress_probe', 'structured_output_tools', 'effective_tool_report'];
  for (const name of added) {
    assert.equal(source.capabilities.find((c) => c.name === name)?.since_minor, 13, name);
  }
  const recorded = source.minors.find((m) => m.minor === 13)?.wire_additions ?? [];
  for (const field of ['init_check = 2', 'await_account_identity = 9', 'account_identity = 2', 'egress_probe = 15', 'structured_output_tools = 16', 'effective_disallowed_tools = 8', 'effective_tools = 9']) {
    assert.ok(recorded.some((line) => line.endsWith(field)), `minor 13 does not record ${field}`);
  }
  const res = await rpc<{ capabilities: string[] }>(sidecar().impl.handshake as Handler, { clientProtocolMajor: 3 });
  const firstExecutable = res.capabilities.indexOf('executable_host_cli');
  for (const name of added) {
    const at = res.capabilities.indexOf(name);
    assert.ok(at >= 0 && at < firstExecutable, `${name} is advertised before the executable pair`);
  }
});

test('the frozen client decodes the 3.13 handshake and SessionReady, dropping only the new fields', () => {
  const handshake = HandshakeResponse.fromPartial({ protocolMajor: 3, egressProbe: EgressProbe.EGRESS_PROBE_LOOPBACK_BLOCKED, structuredOutputTools: ['StructuredOutput'], capabilities: ['handshake'] });
  const oldHandshake = old.HandshakeResponse.decode(HandshakeResponse.encode(handshake).finish());
  assert.equal(oldHandshake.protocolMajor, 3);
  assert.deepEqual(oldHandshake.capabilities, ['handshake']);
  const event = SessionEvent.fromPartial({
    sessionId: 's',
    sessionReady: { sessionId: 'p', permissionMode: 'default', effectiveDisallowedTools: ['AskUserQuestion'], effectiveTools: { tools: [] } },
  });
  const oldEvent = old.SessionEvent.decode(SessionEvent.encode(event).finish());
  assert.equal(oldEvent.sessionReady?.permissionMode, 'default');
});
