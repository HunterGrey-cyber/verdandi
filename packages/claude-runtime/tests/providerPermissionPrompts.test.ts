import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { PermissionBroker } from '../src/permissionBroker.js';
import {
  buildSessionOptions,
  createSession,
  policyToBaseOptions,
  PROVIDER_PROMPT_TOOL_DENY,
  usesProviderPermissionPrompts,
  type QueryFn,
} from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import type { MinimalQuery } from '../src/queryTypes.js';

/**
 * `ClaudeHostPolicy.providerPermissionPrompts`: an INTERACTIVE session opted into it gets an SDK
 * `canUseTool` callback, so an ask the CLI raises on its own after the PreToolUse gate allowed a call
 * (its sensitive-file safety check on `.git/`, `.claude/`, ...) reaches the host as a
 * `permission_requested` with `origin: 'provider_prompt'` instead of being refused headlessly with
 * nobody asked. Evidence: neovibe's O3 spike (2026-09-27, CLI 2.1.283, SDK 0.3.252).
 */

const INTERACTIVE: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'host_cli',
  executable: 'host_cli',
};
const OPTED_IN: ClaudeHostPolicy = { ...INTERACTIVE, providerPermissionPrompts: true };

/** What the CLI's `can_use_tool` for a sensitive-file Write looks like once the SDK has mapped it
 * (the spike's variant a, `.git/probe`), including the suggestion that must never be echoed back. */
function sensitiveWriteOptions(signal: AbortSignal): Parameters<CanUseTool>[2] {
  return {
    signal,
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    decisionReason: 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.',
    displayName: 'Write',
    description: '.git/probe',
    toolUseID: 'toolu_sensitive',
    requestId: 'req-1',
  };
}
const WRITE_INPUT = { file_path: '/p/.git/probe', content: 'o3 2' };

function makeBroker(): { broker: PermissionBroker; events: ClaudeRuntimeEvent[] } {
  const events: ClaudeRuntimeEvent[] = [];
  return { broker: new PermissionBroker((e) => events.push(e)), events };
}

function requested(events: ClaudeRuntimeEvent[]): Extract<ClaudeRuntimeEvent, { type: 'permission_requested' }>[] {
  return events.filter((e): e is Extract<ClaudeRuntimeEvent, { type: 'permission_requested' }> => e.type === 'permission_requested');
}

// --- The broker's canUseTool callback ----------------------------------------------------------

test('canUseTool: raises a provider_prompt permission_requested carrying the CLI reason, and waits for the host', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));

  assert.equal(broker.pendingCount(), 1);
  const [request] = requested(events);
  assert.deepEqual(request, {
    type: 'permission_requested',
    permissionId: request.permissionId,
    toolUseId: 'toolu_sensitive',
    toolName: 'Write',
    input: WRITE_INPUT,
    origin: 'provider_prompt',
    providerReason: 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.',
    providerDescription: '.git/probe',
  });

  let settled = false;
  void answer.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the callback must wait for the host, not answer on its own');

  assert.equal(broker.resolve(request.permissionId, { allow: true }), true);
  await answer;
});

test('canUseTool: a host allow is EXACTLY { behavior: allow, updatedInput: input } -- never the CLI suggestions, never updatedPermissions', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
  broker.resolve(requested(events)[0].permissionId, { allow: true, reason: 'a reason the allow must not carry anywhere' });

  const result = await answer;
  // deepEqual on the whole object is the assertion: no updatedPermissions (echoing the suggestion
  // switched the spike's CLI session to acceptEdits), no toolUseID (the SDK adds its own), nothing else.
  assert.deepEqual(result, { behavior: 'allow', updatedInput: WRITE_INPUT });
  assert.equal(Object.hasOwn(result as object, 'updatedPermissions'), false);
  assert.equal(events.at(-1)?.type, 'permission_resolved');
  assert.equal((events.at(-1) as { outcome: string }).outcome, 'allowed');
});

test('canUseTool: a host deny carries the host reason as the deny message', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
  broker.resolve(requested(events)[0].permissionId, { allow: false, reason: 'not in this repository' });

  assert.deepEqual(await answer, { behavior: 'deny', message: 'not in this repository' });
  assert.equal((events.at(-1) as { outcome: string }).outcome, 'denied');
});

test('canUseTool: a host deny with no reason, or a blank one, still gives the CLI a non-empty message', async () => {
  for (const reason of [undefined, '', '   ']) {
    const { broker, events } = makeBroker();
    const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
    broker.resolve(requested(events)[0].permissionId, { allow: false, reason });
    const result = (await answer) as PermissionResult & { behavior: 'deny' };
    assert.equal(result.behavior, 'deny', `reason ${JSON.stringify(reason)}`);
    assert.equal(result.message, 'denied by the host', `reason ${JSON.stringify(reason)}`);
    assert.deepEqual(Object.keys(result).sort(), ['behavior', 'message'], 'no interrupt: a denied prompt fails that tool call, not the turn');
  }
});

test('canUseTool: the SDK aborting the prompt denies it, emits expired, and a late host answer is a no-op', async () => {
  const { broker, events } = makeBroker();
  const controller = new AbortController();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(controller.signal));
  const { permissionId } = requested(events)[0];

  controller.abort();

  const result = await answer;
  assert.equal(result?.behavior, 'deny');
  assert.equal(broker.pendingCount(), 0);
  const resolved = events.filter((e) => e.type === 'permission_resolved');
  assert.deepEqual(resolved, [{ type: 'permission_resolved', permissionId, outcome: 'expired' }]);
  assert.equal(broker.resolve(permissionId, { allow: true }), false, 'the CLI gave up on it: a late allow must not be recorded');
  assert.equal(events.filter((e) => e.type === 'permission_resolved').length, 1);
});

test('canUseTool: a prompt whose signal is already aborted is denied at once, and nobody is asked', async () => {
  const { broker, events } = makeBroker();
  const controller = new AbortController();
  controller.abort();
  const result = await broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(controller.signal));
  assert.equal(result?.behavior, 'deny');
  assert.equal(broker.pendingCount(), 0);
  assert.deepEqual(events, []);
});

test('canUseTool: failAllPending (interrupt, close) denies a waiting prompt exactly as it denies a hook request', async () => {
  for (const outcome of ['cancelled_by_interrupt', 'cancelled_by_session_close', 'provider_failed'] as const) {
    const { broker, events } = makeBroker();
    const controller = new AbortController();
    const prompt = broker.buildCanUseTool()('Write', WRITE_INPUT, sensitiveWriteOptions(controller.signal));
    const hook = broker.buildHookMatcher().hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_hook', session_id: 's', transcript_path: '', cwd: '' } as never,
      'toolu_hook',
      { signal: new AbortController().signal },
    );
    assert.equal(broker.pendingCount(), 2);

    broker.failAllPending(outcome);

    assert.equal(broker.pendingCount(), 0);
    assert.equal((await prompt)?.behavior, 'deny', outcome);
    assert.equal(((await hook) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny', outcome);
    assert.deepEqual(
      events.filter((e) => e.type === 'permission_resolved').map((e) => (e as { outcome: string }).outcome),
      [outcome, outcome],
    );
    controller.abort();
    assert.equal(events.filter((e) => e.type === 'permission_resolved').length, 2, 'an abort after the fail-close is inert');
  }
});

test('canUseTool: a prompt with no toolUseID still produces an encodable event (empty id, never undefined)', async () => {
  const { broker, events } = makeBroker();
  const options = { ...sensitiveWriteOptions(new AbortController().signal), toolUseID: undefined as unknown as string };
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, options);
  assert.equal(requested(events)[0].toolUseId, '');
  broker.failAllPending('cancelled_by_session_close');
  await answer;
});

test('canUseTool: a rule-forced prompt carries the matched ask rule and the blocked path, verbatim', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Bash', { command: 'cat /etc/passwd' }, {
    signal: new AbortController().signal,
    toolUseID: 'toolu_rule',
    requestId: 'r',
    decisionReason: 'Permission rule requires approval',
    blockedPath: '/etc/passwd',
    matchedAskRule: { source: 'projectSettings', toolName: 'Bash', ruleContent: 'cat:*' },
  });
  const [request] = requested(events);
  assert.equal(request.providerBlockedPath, '/etc/passwd');
  assert.deepEqual(request.providerMatchedAskRule, { source: 'projectSettings', toolName: 'Bash', ruleContent: 'cat:*' });
  broker.failAllPending('cancelled_by_session_close');
  await answer;
});

test('canUseTool: a matched ask rule without ruleContent carries none (absent, not empty)', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, {
    signal: new AbortController().signal,
    toolUseID: 'toolu_rule',
    requestId: 'r',
    matchedAskRule: { source: 'localSettings', toolName: 'Write' },
  });
  const [request] = requested(events);
  assert.deepEqual(request.providerMatchedAskRule, { source: 'localSettings', toolName: 'Write' });
  assert.equal(Object.hasOwn(request.providerMatchedAskRule!, 'ruleContent'), false);
  broker.failAllPending('cancelled_by_session_close');
  await answer;
});

test('canUseTool: null or non-string provider fields from the CLI are dropped, never forwarded (they would not encode)', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, {
    signal: new AbortController().signal,
    toolUseID: null as unknown as string,
    requestId: 'r',
    decisionReason: null as unknown as string,
    description: 42 as unknown as string,
    blockedPath: null as unknown as string,
    matchedAskRule: { source: null, toolName: 'Write' } as unknown as { source: string; toolName: string },
  });
  const [request] = requested(events);
  assert.equal(request.toolUseId, '');
  for (const key of ['providerReason', 'providerDescription', 'providerBlockedPath', 'providerMatchedAskRule']) {
    assert.equal(Object.hasOwn(request, key), false, key);
  }
  broker.failAllPending('cancelled_by_session_close');
  await answer;
});

test('canUseTool: a prompt without a decisionReason or description carries neither field (absent, not empty)', async () => {
  const { broker, events } = makeBroker();
  const answer = broker.buildCanUseTool()('Write', WRITE_INPUT, { signal: new AbortController().signal, toolUseID: 'toolu_x', requestId: 'r' });
  const [request] = requested(events);
  for (const key of ['providerReason', 'providerDescription', 'providerBlockedPath', 'providerMatchedAskRule']) {
    assert.equal(Object.hasOwn(request, key), false, key);
  }
  assert.equal(request.origin, 'provider_prompt');
  broker.failAllPending('cancelled_by_session_close');
  await answer;
});

test('the PreToolUse hook states origin hook and carries no provider fields', async () => {
  const { broker, events } = makeBroker();
  const hook = broker.buildHookMatcher().hooks[0](
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );
  const [request] = requested(events);
  assert.deepEqual(request, {
    type: 'permission_requested',
    permissionId: request.permissionId,
    toolUseId: 'toolu_1',
    toolName: 'Bash',
    input: { command: 'ls' },
    origin: 'hook',
  });
  broker.resolve(request.permissionId, { allow: true });
  await hook;
});

// --- Which sessions get it: the policy predicate and the Options -------------------------------

test('usesProviderPermissionPrompts: only an INTERACTIVE policy that states true', () => {
  assert.equal(usesProviderPermissionPrompts(OPTED_IN), true);
  assert.equal(usesProviderPermissionPrompts(INTERACTIVE), false);
  assert.equal(usesProviderPermissionPrompts({ ...INTERACTIVE, providerPermissionPrompts: false }), false);
  assert.equal(usesProviderPermissionPrompts({ ...OPTED_IN, permissions: 'verdandi_rules' }), false);
  assert.equal(usesProviderPermissionPrompts({ ...OPTED_IN, permissions: 'bypass' }), false);
});

test('PROVIDER_PROMPT_TOOL_DENY is the three tools --permission-prompt-tool adds (spike t1/t2), and frozen', () => {
  assert.deepEqual([...PROVIDER_PROMPT_TOOL_DENY], ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  assert.equal(Object.isFrozen(PROVIDER_PROMPT_TOOL_DENY), true);
});

test('policyToBaseOptions: opted in, the three prompt-tool additions are disallowed after the caller deny list, without duplicates', () => {
  assert.deepEqual(policyToBaseOptions(OPTED_IN, '/p').disallowedTools, ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  assert.deepEqual(
    policyToBaseOptions({ ...OPTED_IN, toolPolicy: { deny: ['Bash', 'EnterPlanMode'] } }, '/p').disallowedTools,
    ['Bash', 'EnterPlanMode', 'AskUserQuestion', 'ExitPlanMode'],
  );
});

test('policyToBaseOptions: flag off, or a mode it does not apply to, gives byte-for-byte the Options it gave before the flag existed', () => {
  const cases: Array<[string, ClaudeHostPolicy, ClaudeHostPolicy]> = [
    ['interactive, false', { ...INTERACTIVE, providerPermissionPrompts: false }, INTERACTIVE],
    ['verdandi_rules, true', { ...INTERACTIVE, permissions: 'verdandi_rules', providerPermissionPrompts: true }, { ...INTERACTIVE, permissions: 'verdandi_rules' }],
    ['bypass, true', { ...INTERACTIVE, permissions: 'bypass', providerPermissionPrompts: true }, { ...INTERACTIVE, permissions: 'bypass' }],
    ['interactive + deny list, false', { ...INTERACTIVE, toolPolicy: { deny: ['Bash'] }, providerPermissionPrompts: false }, { ...INTERACTIVE, toolPolicy: { deny: ['Bash'] } }],
  ];
  for (const [label, withFlag, without] of cases) {
    assert.deepEqual(buildSessionOptions({ cwd: '/p', policy: withFlag }), buildSessionOptions({ cwd: '/p', policy: without }), label);
  }
});

// --- createSession: installation, and the whole path through pump() -----------------------------

function createCapturing(query: MinimalQuery, policy: ClaudeHostPolicy): { session: ReturnType<typeof createSession>; options: Options } {
  let captured: Options | undefined;
  const queryFn: QueryFn = (params) => {
    captured = params.options;
    return query;
  };
  const session = createSession({ cwd: '/p', policy }, queryFn);
  return { session, options: captured! };
}

/** Options with every function replaced by a marker, so two sessions' Options compare by shape. */
function shape(options: Options): unknown {
  return JSON.parse(JSON.stringify(options, (_k, v: unknown) => (typeof v === 'function' ? '<fn>' : v)));
}

test('createSession: opted in, installs canUseTool beside the unchanged PreToolUse hook', () => {
  const { options } = createCapturing(makeFakeQuery().query, OPTED_IN);
  assert.equal(typeof options.canUseTool, 'function');
  assert.equal(options.hooks?.PreToolUse?.length, 1);
  assert.equal(options.hooks?.PreToolUse?.[0].matcher, '*');
  assert.equal(options.permissionPromptToolName, undefined, 'the SDK refuses canUseTool together with permissionPromptToolName');
  assert.equal(options.permissionMode, 'default');
});

test('createSession: flag off, verdandi_rules or bypass installs no canUseTool and hands the SDK the same Options as before', () => {
  const cases: Array<[string, ClaudeHostPolicy, ClaudeHostPolicy]> = [
    ['interactive, absent', INTERACTIVE, INTERACTIVE],
    ['interactive, false', { ...INTERACTIVE, providerPermissionPrompts: false }, INTERACTIVE],
    ['verdandi_rules, true', { ...OPTED_IN, permissions: 'verdandi_rules' }, { ...INTERACTIVE, permissions: 'verdandi_rules' }],
    ['bypass, true', { ...OPTED_IN, permissions: 'bypass' }, { ...INTERACTIVE, permissions: 'bypass' }],
  ];
  for (const [label, withFlag, without] of cases) {
    const a = createCapturing(makeFakeQuery().query, withFlag).options;
    const b = createCapturing(makeFakeQuery().query, without).options;
    assert.equal(a.canUseTool, undefined, label);
    assert.deepEqual(shape(a), shape(b), label);
    for (const tool of PROVIDER_PROMPT_TOOL_DENY) {
      assert.ok(!(a.disallowedTools ?? []).includes(tool), `${label}: ${tool} must not be touched`);
    }
  }
});

test('createSession + pump: a provider prompt reaches pump() and the host allow goes back to the CLI as a bare allow', async () => {
  const { session, options } = createCapturing(makeFakeQuery().query, OPTED_IN);
  const answer = options.canUseTool!('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));

  const events = await session.pump();
  const [request] = requested(events);
  assert.equal(request.origin, 'provider_prompt');
  assert.equal(request.toolUseId, 'toolu_sensitive');
  assert.equal(request.providerReason, 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.');

  assert.equal(session.resolvePermission(request.permissionId, { allow: true }), true);
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: WRITE_INPUT });
  const after = await session.pump();
  assert.deepEqual(after, [{ type: 'permission_resolved', permissionId: request.permissionId, outcome: 'allowed' }]);
});

test('createSession: interrupt() denies a waiting provider prompt (cancelled_by_interrupt)', async () => {
  const { session, options } = createCapturing(makeFakeQuery().query, OPTED_IN);
  const answer = options.canUseTool!('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
  const [request] = requested(await session.pump());

  await session.interrupt();

  assert.equal((await answer)?.behavior, 'deny');
  assert.deepEqual(await session.pump(), [{ type: 'permission_resolved', permissionId: request.permissionId, outcome: 'cancelled_by_interrupt' }]);
  assert.equal(session.resolvePermission(request.permissionId, { allow: true }), false);
});

test('createSession: close() denies a waiting provider prompt (cancelled_by_session_close)', async () => {
  const { session, options } = createCapturing(makeFakeQuery().query, OPTED_IN);
  const answer = options.canUseTool!('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
  const [request] = requested(await session.pump());

  session.close();

  assert.equal((await answer)?.behavior, 'deny');
  const closing = await session.pump();
  assert.deepEqual(closing[0], { type: 'permission_resolved', permissionId: request.permissionId, outcome: 'cancelled_by_session_close' });
  assert.equal(closing.at(-1)?.type, 'session_closed');
});

test('createSession: after a switch to bypass the installed callback still asks the host rather than allowing on its own', async () => {
  const { session, options } = createCapturing(makeFakeQuery().query, { ...OPTED_IN, permissionModeSwitchable: true });
  await session.setPermissionMode('bypass');
  await session.pump();
  // The SDK documents that a CLI in bypassPermissions does not call canUseTool. If it ever does, the
  // host decides: nothing here may turn "the CLI asked" into an allow nobody gave.
  const answer = options.canUseTool!('Write', WRITE_INPUT, sensitiveWriteOptions(new AbortController().signal));
  const [request] = requested(await session.pump());
  assert.equal(request.origin, 'provider_prompt');
  session.resolvePermission(request.permissionId, { allow: false, reason: 'host said no' });
  assert.deepEqual(await answer, { behavior: 'deny', message: 'host said no' });
});
