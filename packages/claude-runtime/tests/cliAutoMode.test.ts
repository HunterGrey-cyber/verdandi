import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanUseTool, HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { PermissionAnswerError, PermissionBroker, type GateDecision } from '../src/permissionBroker.js';
import {
  cliPermissionModeProblem,
  createSession,
  gateDecision,
  permissionDeniedEventsFor,
  policyToBaseOptions,
  providerPermissionMode,
  PermissionModeError,
  type QueryFn,
} from '../src/session.js';
import { translateMessage } from '../src/eventTranslation.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import type { MinimalQuery } from '../src/queryTypes.js';

/**
 * The CLI's own auto mode under the gate, kernel half:
 *
 *   - `ClaudeHostPolicy.cliPermissionMode`: `'auto'` runs the CLI in `auto` with the PreToolUse gate
 *     still installed; absent is byte-identical to before; `'auto'` only with `interactive`.
 *   - `resolvePermission(..., { defer: true })`: no decision (an empty hook output), modelled on the
 *     bypass abstention. Only an explicit defer does that; every timeout, abort and failure still denies.
 *   - `system/permission_denied` becomes a `permission_denied` event, only for a session that stated
 *     `cliPermissionMode`.
 *
 * The measured CLI behaviour these are built on (2.1.284, TEST profile, 2026-10-02): a PreToolUse hook
 * returning no decision under `--permission-mode auto` left `git push --force` to the classifier, which
 * denied it with `[Git Destructive]` and emitted the `system/permission_denied` reproduced below; a hook
 * `allow` skipped the classifier; `system/init` reported `permissionMode: "auto"`.
 */

const INTERACTIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const AUTO: ClaudeHostPolicy = { ...INTERACTIVE, cliPermissionMode: 'auto' };

/** The 2.1.284 message, field for field (message text abridged; it is not forwarded). */
const MEASURED_DENIAL = {
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Bash',
  tool_use_id: 'toolu_017CZ9vk9wjuHQmght9KZgQo',
  decision_reason_type: 'classifier',
  decision_reason: '[Git Destructive]',
  message: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive]. ...',
  uuid: 'f6b6345b-0835-43c7-9239-d4871073356e',
  session_id: '8acde311-9acc-404d-a80e-25fdb0dd14a7',
} as unknown as SDKMessage;

function start(policy: ClaudeHostPolicy, query: MinimalQuery = makeFakeQuery().query): { session: ReturnType<typeof createSession>; options: Options } {
  let captured: Options | undefined;
  const queryFn: QueryFn = (params) => {
    captured = params.options;
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy }, queryFn);
  return { session, options: captured! };
}

function hookOf(options: Options): HookCallback {
  const matchers = options.hooks?.PreToolUse;
  assert.ok(matchers !== undefined && matchers.length === 1, 'exactly one PreToolUse matcher');
  return matchers[0].hooks[0];
}

function callHook(hook: HookCallback, toolName: string, signal: AbortSignal = new AbortController().signal, id = 'toolu_1') {
  return hook(
    { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command: 'git push --force origin main' }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never,
    id,
    { signal },
  );
}

function decisionOf(output: unknown): string | undefined {
  return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
}

function brokerWithEvents(): { broker: PermissionBroker; events: ClaudeRuntimeEvent[]; hook: HookCallback } {
  const events: ClaudeRuntimeEvent[] = [];
  const broker = new PermissionBroker((e) => events.push(e));
  return { broker, events, hook: broker.buildHookMatcher().hooks[0] };
}

function requestedIds(events: ClaudeRuntimeEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'permission_requested' ? [e.permissionId] : []));
}

function outcomes(events: ClaudeRuntimeEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'permission_resolved' ? [e.outcome] : []));
}

// ---- (a) absent: byte-identical -----------------------------------------------------------------

test('cliPermissionMode absent: the Options are exactly what they were, and explicit default changes none of them', () => {
  for (const permissions of ['interactive', 'verdandi_rules', 'bypass'] as const) {
    for (const permissionModeSwitchable of [undefined, true]) {
      const base: ClaudeHostPolicy = { ...INTERACTIVE, permissions, ...(permissionModeSwitchable ? { permissionModeSwitchable } : {}) };
      const absent = policyToBaseOptions(base, '/tmp/project');
      assert.equal(absent.permissionMode, permissions === 'bypass' ? 'bypassPermissions' : 'default');
      assert.deepEqual(policyToBaseOptions({ ...base, cliPermissionMode: 'default' }, '/tmp/project'), absent, `${permissions} switchable=${String(permissionModeSwitchable)}`);
    }
  }
});

test('cliPermissionMode absent: a session gets the same hook, and the same answers, as before', async () => {
  const { session, options } = start(INTERACTIVE);
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.hooks?.PreToolUse?.[0].matcher, '*');
  const answer = callHook(hookOf(options), 'Bash');
  const [request] = (await session.pump()).filter((e) => e.type === 'permission_requested');
  assert.ok(request !== undefined && request.type === 'permission_requested');
  assert.equal(session.resolvePermission(request.permissionId, { allow: true, reason: 'ok' }), true);
  assert.deepEqual(await answer, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' } });
  assert.deepEqual(outcomes(await session.pump()), ['allowed']);
  session.close();
});

// ---- (b) AUTO -----------------------------------------------------------------------------------

test('providerPermissionMode: interactive + auto is the CLI\'s auto; every other combination maps as before', () => {
  assert.equal(providerPermissionMode('interactive', 'auto'), 'auto');
  for (const cli of [undefined, 'default' as const]) {
    assert.equal(providerPermissionMode('interactive', cli), 'default');
    assert.equal(providerPermissionMode('verdandi_rules', cli), 'default');
    assert.equal(providerPermissionMode('bypass', cli), 'bypassPermissions');
  }
  // Never reachable through createSession (refused below), and still never weaker than before.
  assert.equal(providerPermissionMode('verdandi_rules', 'auto'), 'default');
  assert.equal(providerPermissionMode('bypass', 'auto'), 'bypassPermissions');
});

test('AUTO: the SDK is told permissionMode auto, the PreToolUse gate stays installed with matcher *, and it still asks about every call', async () => {
  const { session, options } = start(AUTO);
  assert.equal(options.permissionMode, 'auto');
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.hooks?.PreToolUse?.[0].matcher, '*');
  assert.equal(gateDecision({ permissions: 'interactive', bypassFloor: false }, 'Bash').kind, 'ask');
  const answer = callHook(hookOf(options), 'Bash');
  const requested = (await session.pump()).filter((e) => e.type === 'permission_requested');
  assert.equal(requested.length, 1, 'the host is asked first, as in default');
  session.resolvePermission((requested[0] as { permissionId: string }).permissionId, { allow: false, reason: 'no' });
  assert.equal(decisionOf(await answer), 'deny');
  session.close();
});

// ---- (c) AUTO only with interactive --------------------------------------------------------------

test('AUTO with verdandi_rules, bypass or permissionModeSwitchable is refused before any query exists', () => {
  const refused: ClaudeHostPolicy[] = [
    { ...AUTO, permissions: 'verdandi_rules' },
    { ...AUTO, permissions: 'bypass' },
    { ...AUTO, permissionModeSwitchable: true },
  ];
  for (const policy of refused) {
    assert.match(cliPermissionModeProblem(policy) ?? '', /cli_permission_mode auto/, JSON.stringify(policy));
    let queried = false;
    assert.throws(() => createSession({ cwd: '/tmp/project', policy }, () => ((queried = true), makeFakeQuery().query)), /cli_permission_mode auto/);
    assert.equal(queried, false, 'no CLI for a policy that cannot be honoured');
  }
  for (const policy of [AUTO, INTERACTIVE, { ...INTERACTIVE, cliPermissionMode: 'default' as const }, { ...INTERACTIVE, permissions: 'bypass' as const, cliPermissionMode: 'default' as const }, { ...INTERACTIVE, permissionModeSwitchable: true, cliPermissionMode: 'default' as const }]) {
    assert.equal(cliPermissionModeProblem(policy), null, JSON.stringify(policy));
  }
});

test('SetPermissionMode on an AUTO session is refused for every target, before the CLI is asked; DEFAULT sessions switch as before', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = start(AUTO, query);
  for (const mode of ['interactive', 'verdandi_rules', 'bypass'] as const) {
    await assert.rejects(session.setPermissionMode(mode), (err: unknown) => err instanceof PermissionModeError && err.kind === 'refused' && /cli_permission_mode auto/.test(err.message), mode);
  }
  assert.deepEqual(controller.setPermissionModeCalls, [], 'the CLI was never asked');
  // The gate is untouched: it still asks.
  void callHook(hookOf(options), 'Read');
  assert.equal((await session.pump()).filter((e) => e.type === 'permission_requested').length, 1);
  assert.ok(!(await session.pump()).some((e) => e.type === 'permission_mode_changed'));
  session.close();

  const other = makeFakeQuery();
  const { session: stated } = start({ ...INTERACTIVE, cliPermissionMode: 'default' }, other.query);
  assert.deepEqual(await stated.setPermissionMode('verdandi_rules'), { permissionMode: 'default', bypassDefaultDenyApplied: false });
  assert.deepEqual(other.controller.setPermissionModeCalls, ['default']);
  stated.close();
});

// ---- (d) defer ---------------------------------------------------------------------------------

test('defer: the hook answers the CLI with NO decision ({}), the reason is ignored, and the request resolves deferred', async () => {
  const { broker, events, hook } = brokerWithEvents();
  const answer = callHook(hook, 'Bash');
  const [id] = requestedIds(events);
  assert.equal(broker.resolve(id, { allow: false, reason: 'ignored', defer: true }), true);
  assert.deepEqual(await answer, {}, 'exactly the output the bypass abstention gives');
  assert.deepEqual(outcomes(events), ['deferred']);
  assert.equal(broker.pendingCount(), 0);
  // Answered once: a second answer of any kind finds nothing, exactly as after allow/deny.
  assert.equal(broker.resolve(id, { allow: true }), false);
  assert.equal(broker.resolve(id, { allow: false, defer: true }), false);
});

test('defer with allow true is a contradiction: refused before anything is looked up, and the request stays pending', async () => {
  const { broker, events, hook } = brokerWithEvents();
  const answer = callHook(hook, 'Bash');
  const [id] = requestedIds(events);
  for (const target of [id, 'no-such-id']) {
    assert.throws(() => broker.resolve(target, { allow: true, defer: true }), (err: unknown) => err instanceof PermissionAnswerError && err.kind === 'contradictory_answer', target);
  }
  assert.equal(broker.pendingCount(), 1);
  assert.deepEqual(outcomes(events), []);
  assert.equal(broker.resolve(id, { allow: false, reason: 'no' }), true);
  assert.equal(decisionOf(await answer), 'deny');
});

test('defer: the same output the bypass abstention gives, through a real session in AUTO', async () => {
  const { session, options } = start(AUTO);
  const answer = callHook(hookOf(options), 'Bash');
  const [request] = (await session.pump()).filter((e) => e.type === 'permission_requested');
  assert.ok(request?.type === 'permission_requested');
  assert.equal(session.resolvePermission(request.permissionId, { allow: false, defer: true }), true);
  assert.deepEqual(await answer, {});
  assert.deepEqual(outcomes(await session.pump()), ['deferred']);
  session.close();
});

test('defer: an unknown or already-resolved id is false, as for any answer, and changes nothing', async () => {
  const { broker, events, hook } = brokerWithEvents();
  assert.equal(broker.resolve('no-such-id', { allow: false, defer: true }), false);
  const answer = callHook(hook, 'Bash');
  const [id] = requestedIds(events);
  assert.equal(broker.resolve(id, { allow: false, reason: 'no' }), true);
  assert.equal(decisionOf(await answer), 'deny');
  assert.equal(broker.resolve(id, { allow: false, defer: true }), false);
  assert.deepEqual(outcomes(events), ['denied']);
});

test('defer on a provider prompt is refused (PermissionAnswerError), the request stays pending, and a real answer still works', async () => {
  const { broker, events } = brokerWithEvents();
  const canUseTool: CanUseTool = broker.buildCanUseTool();
  const answer = canUseTool('Write', { file_path: '/p/.git/probe' }, { signal: new AbortController().signal, toolUseID: 'toolu_p', requestId: 'r', decisionReason: 'sensitive' } as Parameters<CanUseTool>[2]);
  const [id] = requestedIds(events);
  assert.throws(() => broker.resolve(id, { allow: false, defer: true }), (err: unknown) => err instanceof PermissionAnswerError && err.kind === 'defer_not_allowed');
  assert.equal(broker.pendingCount(), 1, 'still pending');
  assert.deepEqual(outcomes(events), [], 'nothing resolved');
  assert.equal(broker.resolve(id, { allow: false, reason: 'no' }), true);
  assert.deepEqual(await answer, { behavior: 'deny', message: 'no' });
});

test('fail-closed is unchanged: a hook timeout (abort), interrupt, close and provider death still DENY, and a defer after any of them is not found', async () => {
  // The CLI's hook timeout, which reaches the hook as its signal aborting.
  {
    const { broker, events, hook } = brokerWithEvents();
    const controller = new AbortController();
    const answer = callHook(hook, 'Bash', controller.signal);
    const [id] = requestedIds(events);
    controller.abort();
    assert.equal(decisionOf(await answer), 'deny', 'a timed-out request is denied, never left to the CLI');
    assert.deepEqual(outcomes(events), ['expired']);
    assert.equal(broker.resolve(id, { allow: false, defer: true }), false);
  }
  // Already aborted when the hook ran.
  {
    const { hook } = brokerWithEvents();
    const controller = new AbortController();
    controller.abort();
    assert.equal(decisionOf(await callHook(hook, 'Bash', controller.signal)), 'deny');
  }
  // interrupt, close and provider death, through a real AUTO session.
  for (const end of ['interrupt', 'close', 'provider death'] as const) {
    const { query, controller } = makeFakeQuery();
    const { session, options } = start(AUTO, query);
    const answer = callHook(hookOf(options), 'Bash');
    const [request] = (await session.pump()).filter((e) => e.type === 'permission_requested');
    assert.ok(request?.type === 'permission_requested');
    if (end === 'interrupt') {
      await session.interrupt();
    } else if (end === 'close') {
      session.close();
    } else {
      controller.rejectNext(new Error('the CLI died'));
    }
    // The pump is where a provider death is noticed (a poll or two later); for the other two it only
    // drains the events.
    const after: ClaudeRuntimeEvent[] = [];
    for (let i = 0; i < 20 && !after.some((e) => e.type === 'permission_resolved'); i += 1) {
      after.push(...(await session.pump()));
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(decisionOf(await answer), 'deny', end);
    assert.equal(session.resolvePermission(request.permissionId, { allow: false, defer: true }), false, end);
    const expected = { interrupt: 'cancelled_by_interrupt', close: 'cancelled_by_session_close', 'provider death': 'provider_failed' }[end];
    assert.deepEqual(outcomes(after), [expected], end);
    session.close();
  }
});

test('a defer racing a timeout: whichever settles first wins, and a timeout is never turned into "no decision"', async () => {
  // Defer first, then the CLI gives up: the hook already returned {}, and the late abort records nothing.
  {
    const { broker, events, hook } = brokerWithEvents();
    const controller = new AbortController();
    const answer = callHook(hook, 'Bash', controller.signal);
    const [id] = requestedIds(events);
    assert.equal(broker.resolve(id, { allow: false, defer: true }), true);
    controller.abort();
    assert.deepEqual(await answer, {});
    assert.deepEqual(outcomes(events), ['deferred'], 'no stray expired');
  }
  // Timeout first, then the defer: denied, and the defer finds nothing.
  {
    const { broker, events, hook } = brokerWithEvents();
    const controller = new AbortController();
    const answer = callHook(hook, 'Bash', controller.signal);
    const [id] = requestedIds(events);
    controller.abort();
    assert.equal(broker.resolve(id, { allow: false, defer: true }), false);
    assert.equal(decisionOf(await answer), 'deny');
    assert.deepEqual(outcomes(events), ['expired']);
  }
});

// ---- (e) permission_denied ------------------------------------------------------------------------

test('translateMessage: the measured system/permission_denied becomes permission_denied, strings verbatim -- only when asked for', () => {
  assert.deepEqual(translateMessage(MEASURED_DENIAL, { currentTurnId: 't', permissionDeniedEvents: true }), [
    { type: 'permission_denied', toolUseId: 'toolu_017CZ9vk9wjuHQmght9KZgQo', toolName: 'Bash', reasonType: 'classifier', reason: '[Git Destructive]' },
  ]);
  for (const ctx of [{ currentTurnId: 't' }, { currentTurnId: 't', permissionDeniedEvents: false }]) {
    assert.deepEqual(translateMessage(MEASURED_DENIAL, ctx), [{ type: 'provider_notice', kind: 'system', subtype: 'permission_denied', raw: MEASURED_DENIAL }]);
  }
  // A CLI that leaves the optional fields out, or sends junk in the required ones.
  const sparse = { type: 'system', subtype: 'permission_denied', tool_name: 7, message: 'x' } as unknown as SDKMessage;
  assert.deepEqual(translateMessage(sparse, { currentTurnId: undefined, permissionDeniedEvents: true }), [{ type: 'permission_denied', toolUseId: '', toolName: '' }]);
});

test('permission_denied events: only a session whose policy states cliPermissionMode gets them; any other gets the provider_notice it always got', async () => {
  assert.equal(permissionDeniedEventsFor(INTERACTIVE), false);
  assert.equal(permissionDeniedEventsFor({ ...INTERACTIVE, cliPermissionMode: 'default' }), true);
  assert.equal(permissionDeniedEventsFor(AUTO), true);
  for (const [policy, expected] of [
    [INTERACTIVE, 'provider_notice'],
    [{ ...INTERACTIVE, permissions: 'bypass' as const }, 'provider_notice'],
    [{ ...INTERACTIVE, cliPermissionMode: 'default' as const }, 'permission_denied'],
    [AUTO, 'permission_denied'],
  ] as const) {
    const { query, controller } = makeFakeQuery();
    const { session } = start(policy, query);
    controller.emit(MEASURED_DENIAL);
    const events = await session.pump();
    const kinds = events.filter((e) => (e.type === 'provider_notice' && e.subtype === 'permission_denied') || e.type === 'permission_denied').map((e) => e.type);
    assert.deepEqual(kinds, [expected], JSON.stringify(policy));
    session.close();
  }
});

// ---- defer only where the session cannot be switched to bypass -----------------------------------------

/** Gated, DEFAULT stated, switchable, no tool policy: the conservative floor applies on entering bypass. */
const SWITCHABLE: ClaudeHostPolicy = { ...INTERACTIVE, permissionModeSwitchable: true, cliPermissionMode: 'default' };
const FIXED_DEFAULT: ClaudeHostPolicy = { ...INTERACTIVE, cliPermissionMode: 'default' };

function isDeferRefusal(err: unknown): boolean {
  return err instanceof PermissionAnswerError && err.kind === 'defer_not_allowed' && /permission_mode_switchable/.test(err.message);
}

async function pendingRequest(session: ReturnType<typeof createSession>) {
  const [request] = (await session.pump()).filter((e) => e.type === 'permission_requested');
  assert.ok(request?.type === 'permission_requested');
  return request;
}

test('a switchable session refuses defer before any switch: the request stays pending, and a later deny or abort lands as deny', async () => {
  for (const ending of ['deny', 'abort'] as const) {
    const { session, options } = start(SWITCHABLE);
    const signal = new AbortController();
    const answer = callHook(hookOf(options), 'Bash', signal.signal);
    const request = await pendingRequest(session);
    assert.throws(() => session.resolvePermission(request.permissionId, { allow: false, defer: true }), isDeferRefusal);
    assert.deepEqual(outcomes(await session.pump()), [], 'nothing resolved by the refused defer');
    if (ending === 'deny') {
      assert.equal(session.resolvePermission(request.permissionId, { allow: false, reason: 'no' }), true);
    } else {
      signal.abort();
    }
    assert.equal(decisionOf(await answer), 'deny', ending);
    assert.deepEqual(outcomes(await session.pump()), [ending === 'deny' ? 'denied' : 'expired']);
    session.close();
  }
});

test('the reviewed race: setPermissionMode(bypass) queued, then a synchronous defer -- refused, so the floor still holds for that call', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = start(SWITCHABLE, query);
  const hook = hookOf(options);
  const answer = callHook(hook, 'Bash');
  const request = await pendingRequest(session);
  // Queued on the switch chain: nothing has reached the gate state or the CLI yet.
  const switching = session.setPermissionMode('bypass');
  assert.throws(() => session.resolvePermission(request.permissionId, { allow: false, defer: true }), isDeferRefusal);
  assert.deepEqual(await switching, { permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: true });
  assert.deepEqual(controller.setPermissionModeCalls, ['bypassPermissions']);
  // Still refused after the switch, and the call is still the host's to answer.
  assert.throws(() => session.resolvePermission(request.permissionId, { allow: false, defer: true }), isDeferRefusal);
  assert.equal(decisionOf(await callHook(hook, 'Bash', new AbortController().signal, 'toolu_2')), 'deny', 'a fresh Bash meets the floor');
  assert.equal(session.resolvePermission(request.permissionId, { allow: false, reason: 'no' }), true);
  assert.equal(decisionOf(await answer), 'deny');
  session.close();
});

test('switchability is the creation policy\'s: editing the caller\'s policy object afterwards changes neither defer nor switching', async () => {
  // A switchable session whose caller later clears the flag still refuses defer.
  const switchable: ClaudeHostPolicy = { ...SWITCHABLE };
  const first = start(switchable);
  const pendingAnswer = callHook(hookOf(first.options), 'Bash');
  const request = await pendingRequest(first.session);
  switchable.permissionModeSwitchable = false;
  assert.throws(() => first.session.resolvePermission(request.permissionId, { allow: false, defer: true }), isDeferRefusal);
  assert.equal(first.session.resolvePermission(request.permissionId, { allow: false, reason: 'no' }), true);
  assert.equal(decisionOf(await pendingAnswer), 'deny');
  first.session.close();

  // A non-switchable session whose caller later sets the flag still cannot be switched to bypass.
  const fixed: ClaudeHostPolicy = { ...FIXED_DEFAULT };
  const { query, controller } = makeFakeQuery();
  const second = start(fixed, query);
  fixed.permissionModeSwitchable = true;
  await assert.rejects(second.session.setPermissionMode('bypass'), (err: unknown) => err instanceof Error && /permission_mode_switchable/.test(err.message));
  assert.deepEqual(controller.setPermissionModeCalls, []);
  second.session.close();
});

test('a non-switchable DEFAULT session and an AUTO session accept defer; a non-switchable one may still switch between the gated modes', async () => {
  for (const policy of [FIXED_DEFAULT, AUTO, INTERACTIVE]) {
    const { session, options } = start(policy);
    for (const tool of ['Bash', 'Write', 'Read']) {
      const answer = callHook(hookOf(options), tool, new AbortController().signal, `toolu_${tool}`);
      const request = await pendingRequest(session);
      assert.equal(session.resolvePermission(request.permissionId, { allow: false, defer: true }), true, `${JSON.stringify(policy)} ${tool}`);
      assert.deepEqual(await answer, {}, tool);
    }
    session.close();
  }
  // interactive <-> verdandi_rules needs no flag and keeps the CLI in `default`, so deferring stays safe.
  const { session, options } = start(FIXED_DEFAULT);
  await session.setPermissionMode('verdandi_rules');
  const answer = callHook(hookOf(options), 'Bash');
  const request = await pendingRequest(session);
  assert.equal(session.resolvePermission(request.permissionId, { allow: false, defer: true }), true);
  assert.deepEqual(await answer, {});
  session.close();
});

test('defence in depth: a broker whose gate would not ask about the call refuses the defer, and the request stays pending', async () => {
  let decision: GateDecision = { kind: 'ask' };
  const events: ClaudeRuntimeEvent[] = [];
  const broker = new PermissionBroker((e) => events.push(e), () => decision);
  for (const later of [{ kind: 'abstain' } as GateDecision, { kind: 'deny', reason: 'floor' } as GateDecision]) {
    decision = { kind: 'ask' };
    const answer = callHook(broker.buildHookMatcher().hooks[0], 'Bash');
    const id = requestedIds(events).at(-1)!;
    decision = later;
    assert.throws(() => broker.resolve(id, { allow: false, defer: true }), (err: unknown) => err instanceof PermissionAnswerError && err.kind === 'defer_not_allowed', later.kind);
    assert.equal(broker.pendingCount(), 1);
    assert.equal(broker.resolve(id, { allow: false, reason: 'no' }), true);
    assert.equal(decisionOf(await answer), 'deny');
  }
});
