import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_ACCOUNT_INFO, makeFakeQuery } from './fakeQuery.js';
import { accountIdentityFromInfo } from '../src/accountIdentity.js';
import {
  createSession,
  policyToBaseOptions,
  DEFAULT_HOST_CLI_PATH,
  CONSERVATIVE_BYPASS_DENY,
  usesDefaultBypassDeny,
  type QueryFn,
} from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { MinimalQuery } from '../src/queryTypes.js';

const NATIVE_INTERACTIVE_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'host_cli',
  executable: 'host_cli',
};

/** Builds a session the same way `createSession` normally does, but captures the `Options` object
 * actually passed to `queryFn` -- this is how these tests inspect what hook installation did
 * (Task 4 Finding 4) without needing the fake to separately track installed hooks itself (Task 4
 * Finding 5: that tracking used to live in `fakeQuery.ts` as a dead, never-written-to field). The
 * installed hook's own callback function lives at `options.hooks.PreToolUse[0].hooks[0]` and can
 * be invoked directly, exactly like `permissionBroker.test.ts` invokes it in isolation, but here
 * exercised through the full `createSession`/`ClaudeRuntimeSession` wiring. `extra` optionally
 * carries `resume`/`fork` through to `createSession`'s own config, for the resume/fork coverage
 * added in the third whole-branch review round. */
function createSessionCapturingOptions(
  query: MinimalQuery,
  policy: ClaudeHostPolicy,
  extra: Partial<Pick<ClaudeSessionConfig, 'resume' | 'fork' | 'model' | 'effort'>> = {},
): { session: ReturnType<typeof createSession>; options: Options } {
  let captured: Options | undefined;
  const queryFn: QueryFn = (params) => {
    captured = params.options;
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy, ...extra }, queryFn);
  return { session, options: captured! };
}

test('policyToBaseOptions: native+host_cli maps to settingSources user/project/local and persistSession true', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project');
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.equal(options.persistSession, true);
  assert.equal(options.permissionMode, 'default');
});

/**
 * `settingSources: []` covers exactly three settings.json layers plus CLAUDE.md (sdk.d.ts's own
 * `settingSources` doc). It does NOT cover `$CLAUDE_CONFIG_DIR/.claude.json`, auto-memory, or any
 * MCP source -- so an `isolated` session that only emptied `settingSources` still inherited the
 * host's MCP servers (project `.mcp.json`, user settings, plugins, agent frontmatter, and the
 * claude.ai connectors reachable through whichever account is logged in) and still read and wrote
 * auto-memory. This test asserts the whole closed set, not just the one field, precisely because
 * the earlier version of it asserted only `settingSources` and therefore recorded a partially
 * isolated session as a passing one.
 */
test('policyToBaseOptions: isolated closes settings, MCP and auto-memory, not just settingSources', () => {
  const options = policyToBaseOptions(
    { configuration: 'isolated', permissions: 'interactive', persistence: 'ephemeral', executable: 'host_cli' },
    '/tmp/project',
    { baseEnv: { PATH: '/usr/bin' } },
  );
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.settings, { autoMemoryEnabled: false });
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('policyToBaseOptions: native leaves the MCP and auto-memory knobs alone', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project', { baseEnv: { PATH: '/usr/bin' } });
  assert.equal(options.strictMcpConfig, undefined);
  assert.equal(options.mcpServers, undefined);
  assert.equal(options.settings, undefined);
});

/** The shipped default: nothing pinned, no `env` override at all, so the SDK's own
 * `env: {...process.env}` default stands and the subprocess uses whatever account the host
 * environment already names (a plain install: `~/.claude`). */
test('policyToBaseOptions: native with no account sets no env override whatsoever', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project', { baseEnv: { PATH: '/usr/bin' } });
  assert.equal(options.env, undefined);
});

test('policyToBaseOptions: an account overlays the four-variable tuple onto the inherited env', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project', {
    account: { name: 'work', configDir: '/home/nobody/.claude-work', anthropicConfigDir: '/home/nobody/.config/anthropic-work' },
    baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/nobody/.claude-team' },
  });
  // Overlay, not replacement: PATH and everything else the host needs survives.
  assert.equal(options.env?.PATH, '/usr/bin');
  // An account already named by the inherited environment is overridden, not merged with.
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, '/home/nobody/.claude-work');
  assert.equal(options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/home/nobody/.claude-work');
  assert.equal(options.env?.ANTHROPIC_CONFIG_DIR, '/home/nobody/.config/anthropic-work');
  assert.equal(options.env?.CLAUDE_PROFILE, 'work');
  // native does not disable auto-memory -- that is the isolated profile's business, not the
  // account binding's.
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

test('policyToBaseOptions: an account at the CLI default location removes the inherited tuple and still sets env', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project', {
    account: { name: 'work', configDir: '/home/nobody/.claude', anthropicConfigDir: '', defaultLocation: true },
    baseEnv: { PATH: '/usr/bin', CLAUDE_PROFILE: 'team', CLAUDE_CONFIG_DIR: '/home/nobody/.claude-team', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/nobody/.claude-team', ANTHROPIC_CONFIG_DIR: '/x' },
  });
  // env is set even though the account adds nothing: leaving the SDK default would let the inherited
  // CLAUDE_CONFIG_DIR above decide which login runs.
  assert.notEqual(options.env, undefined);
  assert.equal(options.env?.PATH, '/usr/bin');
  for (const name of ['CLAUDE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR']) {
    assert.equal(name in (options.env ?? {}), false, `${name} must be absent`);
  }
});

/**
 * `executable` was declared in the policy, translated at the sidecar boundary, and then read by
 * nobody -- so every session ran the SDK's bundled CLI regardless, including under the default
 * policy, which asks for `host_cli`. On this host the two are different programs at different
 * versions (bundled 2.1.252 vs installed 2.1.270), so "which one ran" was never a detail.
 */
test('policyToBaseOptions: host_cli points the SDK at the machine CLI, sdk_bundled leaves it unset', () => {
  const hostCli = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, executable: 'host_cli' }, '/tmp/project', {
    hostCliPath: '/home/someone/.local/bin/claude',
  });
  assert.equal(hostCli.pathToClaudeCodeExecutable, '/home/someone/.local/bin/claude');

  const bundled = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, executable: 'sdk_bundled' }, '/tmp/project', {
    hostCliPath: '/home/someone/.local/bin/claude',
  });
  assert.equal(bundled.pathToClaudeCodeExecutable, undefined);
});

test('policyToBaseOptions: host_cli with no resolved path falls back to a PATH lookup', () => {
  const options = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, executable: 'host_cli' }, '/tmp/project');
  assert.equal(options.pathToClaudeCodeExecutable, DEFAULT_HOST_CLI_PATH);
  assert.equal(DEFAULT_HOST_CLI_PATH, 'claude');
});

test('createSession threads the account through to the options the SDK actually receives', () => {
  const { query } = makeFakeQuery();
  let captured: Options | undefined;
  const queryFn: QueryFn = (params) => {
    captured = params.options;
    return query;
  };
  createSession(
    {
      cwd: '/tmp/project',
      policy: NATIVE_INTERACTIVE_POLICY,
      account: { name: 'work', configDir: '/home/nobody/.claude-work', anthropicConfigDir: '/home/nobody/.config/anthropic-work' },
    },
    queryFn,
  );
  assert.equal(captured?.env?.CLAUDE_CONFIG_DIR, '/home/nobody/.claude-work');
});

test('policyToBaseOptions: bypass permissions sets permissionMode bypassPermissions', () => {
  const options = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, permissions: 'bypass' }, '/tmp/project');
  assert.equal(options.permissionMode, 'bypassPermissions');
});

/**
 * A gated session STATES `default`; it never leaves the starting mode to be filled in. Unset, the CLI
 * takes the first mode it finds, and after `--permission-mode` the next place it looks is
 * `permissions.defaultMode` in the project and local settings tiers -- files in the repository being
 * worked on, which a native session and neovibe (`[project, local]`) both load. So a cloned repo
 * could start a gated session in `acceptEdits` (measured: realSdk.defaultMode.integration.test.ts),
 * and whatever the hook leaves undecided would be that mode's call. (The pinned SDK happens to fill
 * in `default` itself today; see policyToBaseOptions.)
 *
 * Every combination that could plausibly route around the assignment is walked, through the Options
 * `createSession` actually hands the SDK -- not `policyToBaseOptions` alone -- because resume, fork,
 * the switchable flag and the settings tiers are all layered on in different places.
 */
test('createSession: every gated session states permissionMode default, fresh or resumed; bypass states bypassPermissions', () => {
  const gated: ClaudeHostPolicy['permissions'][] = ['interactive', 'verdandi_rules'];
  const resumes: Array<Partial<Pick<ClaudeSessionConfig, 'resume' | 'fork'>>> = [
    {},
    { resume: { providerSessionId: 'sess-resume' } },
    { resume: { providerSessionId: 'sess-resume' }, fork: true },
  ];
  let checked = 0;
  for (const permissions of [...gated, 'bypass' as const]) {
    for (const permissionModeSwitchable of [undefined, false, true]) {
      for (const configuration of ['native', 'isolated'] as const) {
        for (const settingSources of [undefined, [], ['project', 'local']] as ClaudeHostPolicy['settingSources'][]) {
          for (const extra of resumes) {
            const policy: ClaudeHostPolicy = { ...NATIVE_INTERACTIVE_POLICY, permissions, permissionModeSwitchable, configuration, settingSources };
            const { session, options } = createSessionCapturingOptions(makeFakeQuery().query, policy, extra);
            session.close();
            const label = JSON.stringify({ policy, extra });
            assert.equal(options.permissionMode, permissions === 'bypass' ? 'bypassPermissions' : 'default', label);
            // The switchable flag still rides alongside `default`: it makes bypass AVAILABLE, never in force.
            assert.equal(options.allowDangerouslySkipPermissions, permissions !== 'bypass' && permissionModeSwitchable === true ? true : undefined, label);
            if (extra.resume !== undefined) {
              assert.equal(options.resume, 'sess-resume', label);
            }
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 3 * 3 * 2 * 3 * 3);
});

test('createSession + pump: a system init message becomes session_ready', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  // Settled first, so this session_ready carries the answer. An interactive session does not hold
  // its first turn (only a completion-shaped one does), so an init that beat the answer would report
  // it unavailable instead -- see tests/accountIdentity.test.ts.
  await session.accountIdentity();

  controller.emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp/project', permissionMode: 'default' } as never);
  const events = await session.pump();

  assert.deepEqual(events, [
    {
      type: 'session_ready',
      sessionId: 'sess-1',
      providerSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      cwd: '/tmp/project',
      permissionMode: 'default',
      accountIdentity: accountIdentityFromInfo(FAKE_ACCOUNT_INFO),
      // An interactive session with no tool policy hands the SDK no disallowedTools and no tools.
      effectiveToolOptions: { disallowedTools: [] },
    },
  ]);
});

test('pump: a message that arrives while a prior pump() call left its rawQuery.next() outstanding is retrieved by a later pump() call, not lost', async () => {
  // Regression test for the concurrency bug this task's real-CLI verification found: the
  // original (unfixed) pump() issued a brand-new rawQuery.next() call on every invocation and
  // never reused a still-pending one. Against the fake here that bug is invisible on its own
  // (the fake's `waiters` array happens to deliver an emitted message to whichever call is
  // waiting, even an orphaned one), but the ORIGINAL implementation still loses the message
  // end-to-end: an orphaned call's resolution is never read by anything, so a subsequent pump()
  // call -- which under the original code issues a *different*, freshly created next() call --
  // never sees it. Against the real SDK this is a total, permanent loss of every message (see the
  // task report); this test pins the fixed behavior (the message survives across pump() calls)
  // so a future change that reverts pump() toward the original shape fails here immediately
  // instead of only failing against real API cost.
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  await session.accountIdentity();

  // Nothing queued yet -- pump() must return empty without blocking, leaving its internal
  // rawQuery.next() call outstanding.
  const firstDrain = await session.pump();
  assert.deepEqual(firstDrain, []);

  controller.emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp/project', permissionMode: 'default' } as never);

  // The fake's own next() can take one extra pump() call to actually hand back an emitted
  // message to an already-outstanding call, so poll a few times rather than asserting on the
  // very first call after emit -- what matters is that the message eventually arrives at all.
  let events: Awaited<ReturnType<typeof session.pump>> = [];
  for (let attempt = 0; attempt < 5 && events.length === 0; attempt++) {
    events = await session.pump();
  }

  assert.deepEqual(events, [
    {
      type: 'session_ready',
      sessionId: 'sess-1',
      providerSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      cwd: '/tmp/project',
      permissionMode: 'default',
      accountIdentity: accountIdentityFromInfo(FAKE_ACCOUNT_INFO),
      // An interactive session with no tool policy hands the SDK no disallowedTools and no tools.
      effectiveToolOptions: { disallowedTools: [] },
    },
  ]);
});

test('sendTurn: turn_started comes back from pump(), not only from eventLog()', async () => {
  // This assertion used to read `session.eventLog()` with no pump() at all, and passed while
  // `turn_started` was pushed straight into `this.events` -- where pump() never returns it. pump()
  // is the ONLY channel a non-calling consumer has (the gRPC sidecar's WatchSessionEvents
  // subscribers, for one), so that green test was hiding a real gap: measured against a real
  // sidecar and a real CLI, two real turns produced ZERO turn_started events on the wire while
  // turn_completed arrived for both. Assert the channel consumers actually read.
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  const { turnId } = session.sendTurn('hello');
  const drained = await session.pump();

  assert.deepEqual(drained, [{ type: 'turn_started', turnId }], 'pump() must return turn_started');
  assert.deepEqual(session.eventLog(), [{ type: 'turn_started', turnId }], 'and it must still be logged exactly once');

  // Drained, not duplicated: a second pump with nothing new must not re-emit it.
  assert.deepEqual(await session.pump(), []);
  assert.deepEqual(session.eventLog(), [{ type: 'turn_started', turnId }]);
});

test('sendTurn: turn_started is emitted before any message from the provider arrives', async () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  const { turnId } = session.sendTurn('hello');
  const drained = await session.pump();
  assert.equal(drained.length, 1, 'nothing from the provider should have arrived yet');
  assert.equal(drained[0]?.type, 'turn_started');
  assert.equal((drained[0] as { turnId: string }).turnId, turnId);
});

test('sendTurn: a second call while a turn is in progress throws, never silently queues', () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  session.sendTurn('first');
  assert.throws(() => session.sendTurn('second'), /already in progress/);
});

test('pump: a result message clears turn-in-progress and emits turn_completed with outcome completed', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  const { turnId } = session.sendTurn('hello');

  controller.emit({ type: 'result', subtype: 'success', is_error: false, result: 'hi there', stop_reason: null } as never);
  const events = await session.pump();

  // Both events, in order. This used to assert turn_completed ALONE -- which held only because
  // turn_started never reached pump() at all (fixed 2026-09-11). Pinning the pair also pins the
  // ordering a consumer depends on: a turn must be announced before it is reported finished.
  assert.deepEqual(events, [
    { type: 'turn_started', turnId },
    { type: 'turn_completed', turnId, outcome: 'completed', resultText: 'hi there', isError: false, stopReason: null, resultSubtype: 'success' },
  ]);

  // Session must accept a further turn now that turnInProgress cleared.
  assert.doesNotThrow(() => session.sendTurn('second turn'));
});

test('pump: a result message with terminal_reason max_turns maps to limit_reached', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  session.sendTurn('hello');

  controller.emit({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: null, terminal_reason: 'max_turns' } as never);
  const events = await session.pump();

  // Indexed by type, not by position: this drain legitimately also carries the turn_started that
  // sendTurn queued (see the test above), and a positional assertion would silently re-break the
  // moment the out-of-band buffer gains another producer.
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.ok(completed !== undefined, `expected a turn_completed, got ${JSON.stringify(events)}`);
  assert.equal((completed as { outcome: string }).outcome, 'limit_reached');
});

test('close(): calls close() on the underlying query and stops the input queue', () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  session.close();
  assert.equal(controller.closed, true);
});

test('close(): a second call is a no-op, never calling the underlying query.close() twice', () => {
  const { query, controller } = makeFakeQuery();
  let realCloseCalls = 0;
  const countingQuery: typeof query = { ...query, close: () => { realCloseCalls += 1; query.close(); } };
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => countingQuery);

  session.close();
  session.close();

  assert.equal(realCloseCalls, 1);
  assert.equal(controller.closed, true);
});

test('interrupt(): calls interrupt() on the underlying query', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  await session.interrupt();
  assert.equal(controller.interruptCalls, 1);
});

test('pump: an unrecognized message type produces a provider_notice, never a thrown error', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  controller.emit({ type: 'some_future_type' } as never);
  const events = await session.pump();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_notice');
});

// --- Task 4 review findings ---------------------------------------------------------------

test('createSession: installs exactly one PreToolUse hook matcher with matcher "*" for a non-bypass policy, and never sets canUseTool', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);

  assert.equal(options.hooks?.PreToolUse?.length, 1);
  assert.equal(options.hooks?.PreToolUse?.[0].matcher, '*');
  assert.equal(options.canUseTool, undefined);
});

test('createSession: a bypass policy installs no PreToolUse hook at all', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, { ...NATIVE_INTERACTIVE_POLICY, permissions: 'bypass' });

  assert.equal(options.hooks, undefined);
  assert.equal(options.canUseTool, undefined);
});

test('createSession + pump: a permission_requested event from the installed hook is returned by pump(), not just eventLog()', async () => {
  const { query } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  // This pins the pendingPermissionEvents fix at the session level (not just the isolated
  // broker level permissionBroker.test.ts already covers): before that fix, this pump() call
  // would return [] forever, since the event only ever reached eventLog(), never pump()'s own
  // return value.
  const events = await session.pump();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'permission_requested');
  const permissionId = (events[0] as { permissionId: string }).permissionId;

  session.resolvePermission(permissionId, { allow: true });
  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'allow');
});

test('close(): fails closed a pending permission request created via the installed hook, and the resolution reaches eventLog()', async () => {
  const { query } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  session.close();

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');

  // Fourth whole-branch review round: close() now routes its termination events through
  // `pendingPermissionEvents` (the same buffer the permission broker already uses) rather than
  // pushing directly into `this.events`, so the safety property above (the hook itself denies)
  // is immediate and synchronous, but the event only reaches `eventLog()` once some `pump()`
  // call next drains that buffer -- exactly like the `done`/catch termination paths already
  // worked. A single poll is enough to observe it here.
  const events = await session.pump();
  assert.ok(events.some((e) => e.type === 'permission_resolved'));

  const resolved = session.eventLog().find((e) => e.type === 'permission_resolved') as { outcome: string } | undefined;
  assert.equal(resolved?.outcome, 'cancelled_by_session_close');
});

test('interrupt(): fails closed a pending permission request created via the installed hook', async () => {
  const { query } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  await session.interrupt();

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
});

test('interrupt(): still fails closed pending permissions even when rawQuery.interrupt() itself rejects, and the rejection still propagates', async () => {
  const { query } = makeFakeQuery();
  const brokenQuery: MinimalQuery = { ...query, interrupt: () => Promise.reject(new Error('interrupt failed')) };
  const { session, options } = createSessionCapturingOptions(brokenQuery, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  await assert.rejects(() => session.interrupt(), /interrupt failed/);

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
});

test('pump: a rejected rawQuery.next() fails closed pending permissions, marks the session closed, and never throws', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  controller.rejectNext(new Error('provider crashed'));

  const events = await session.pump();
  // Third whole-branch review round, Important #3: `terminate()` now drains
  // `pendingPermissionEvents` into `drained` (the array THIS pump() call returns), not into
  // `this.events` directly -- a pump()-only consumer must be able to see the resolution in the
  // very call that produced it, not only via a later eventLog() inspection. So this pump() call
  // returns all three: the request (already buffered before this call even started, picked up by
  // the top-of-loop drain), its resolution (emitted by failAllPending() inside terminate()), and
  // the terminal event, in that order.
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'permission_requested');
  assert.equal(events[1].type, 'permission_resolved');
  assert.equal((events[1] as { outcome: string }).outcome, 'provider_failed');
  assert.deepEqual(events[2], { type: 'session_closed', reason: 'provider_failed' });

  // eventLog() reflects the exact same three events (appended after pump() returns them).
  const resolved = session.eventLog().find((e) => e.type === 'permission_resolved') as { outcome: string } | undefined;
  assert.equal(resolved?.outcome, 'provider_failed');

  // The underlying query is actually released here, not left for a later close() call that
  // (per the second review round's finding) would now be a no-op since the session is already
  // terminal and can never perform the cleanup itself.
  assert.equal(controller.closed, true);

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');

  // A further pump() call must not throw, even though the underlying query is now dead --
  // `pendingNext` was cleared in the catch, so this issues a fresh (harmless, unresolved) call
  // rather than re-awaiting (and re-throwing) the same rejected promise forever.
  await assert.doesNotReject(() => session.pump());
});

test('pump: a rejected rawQuery.next() releases the underlying query exactly once, and a later explicit close() never calls it again', async () => {
  // Regression test for the second review round's finding: the first fix for a rejected
  // rawQuery.next() set `this.closed = true` inside pump()'s catch (correctly, to stop e.g. a
  // later close() from calling rawQuery.close() a second time) but never actually performed the
  // cleanup itself -- so a later close() call returned immediately via the existing idempotency
  // guard (`if (this.closed) return;`) without ever reaching `rawQuery.close()`, permanently
  // leaking the underlying query/process. Uses the same close-counting-wrapper technique as the
  // pre-existing `close(): a second call is a no-op...` test above, applied to the provider-
  // failure path instead of the explicit-close path.
  const { query, controller } = makeFakeQuery();
  let closeCalls = 0;
  const countingQuery: typeof query = { ...query, close: () => { closeCalls += 1; query.close(); } };
  const { session, options } = createSessionCapturingOptions(countingQuery, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  controller.rejectNext(new Error('provider crashed'));
  await session.pump();

  assert.equal(closeCalls, 1, 'rawQuery.close() must be called exactly once, from inside pump()\'s catch');
  assert.equal(controller.closed, true);

  session.close();
  assert.equal(closeCalls, 1, 'a later explicit close() must not call the underlying query a second time');

  await outputPromise;
});

// --- Third whole-branch review round -------------------------------------------------------

test('createSession: resume sets options.resume to the given providerSessionId, and forkSession stays unset without fork', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY, {
    resume: { providerSessionId: 'some-id' },
  });

  assert.equal(options.resume, 'some-id');
  assert.equal(options.forkSession, undefined);
});

test('createSession: resume + fork sets both options.resume and options.forkSession', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY, {
    resume: { providerSessionId: 'some-id' },
    fork: true,
  });

  assert.equal(options.resume, 'some-id');
  assert.equal(options.forkSession, true);
});

test('createSession: no resume means neither options.resume nor options.forkSession is set, even with a stray fork flag', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY, { fork: true });

  assert.equal(options.resume, undefined);
  assert.equal(options.forkSession, undefined);
});

test('Critical finding: a clean provider exit (next() resolving {done: true}) fails closed a pending permission request', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  controller.end(); // clean exit, no rejection and no explicit close()

  const events = await session.pump();
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'permission_requested');
  assert.equal(events[1].type, 'permission_resolved');
  assert.deepEqual(events[2], { type: 'session_closed', reason: 'provider_exited' });

  const output = await outputPromise;
  assert.equal(
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    'deny',
    'a clean provider exit must still deny the pending hook, not leave it hanging forever',
  );
});

test('pump: terminal state latches -- polling a terminated session repeatedly emits session_closed exactly once total (Important #2)', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  controller.end(); // clean provider exit, no explicit close()

  let sessionClosedCount = 0;
  for (let i = 0; i < 5; i++) {
    const events = await session.pump();
    sessionClosedCount += events.filter((e) => e.type === 'session_closed').length;
  }

  assert.equal(sessionClosedCount, 1, 'session_closed must be emitted exactly once total across repeated polling, not re-emitted on every call');
  assert.equal(session.eventLog().filter((e) => e.type === 'session_closed').length, 1);
});

test('pump: a session that dies from a provider failure mid-turn synthesizes turn_completed with outcome failed', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  const { turnId } = session.sendTurn('hello');

  controller.rejectNext(new Error('provider crashed mid-turn'));

  const events = await session.pump();
  const completed = events.find((e) => e.type === 'turn_completed') as { turnId: string; outcome: string; isError: boolean } | undefined;
  assert.ok(completed, 'expected a synthesized turn_completed when the provider dies mid-turn -- otherwise a host polling until turn_completed spins to its deadline');
  assert.equal(completed?.turnId, turnId);
  assert.equal(completed?.outcome, 'failed');
  assert.equal(completed?.isError, true);
  assert.ok(events.some((e) => e.type === 'session_closed'));

  // The session must genuinely accept no further turns -- turnInProgress was cleared as part of
  // synthesizing turn_completed, but the session is also now terminal.
  assert.throws(() => session.sendTurn('another'), /session is closed/);
});

test('pump: a session that ends cleanly mid-turn also synthesizes turn_completed with outcome failed', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  const { turnId } = session.sendTurn('hello');

  controller.end();

  const events = await session.pump();
  const completed = events.find((e) => e.type === 'turn_completed') as { turnId: string; outcome: string } | undefined;
  assert.ok(completed);
  assert.equal(completed?.turnId, turnId);
  assert.equal(completed?.outcome, 'failed');
});

test('sendTurn(): throws a distinct "session is closed" error on an already-terminated session, not the misleading "already in progress" error', () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  session.close();

  assert.throws(() => session.sendTurn('hello'), /session is closed/);
});

test('pump: overlapping calls do not duplicate events (Important #4) -- one returns the message, the other returns [], and eventLog() has it once', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  controller.emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp/project', permissionMode: 'default' } as never);

  const [first, second] = await Promise.all([session.pump(), session.pump()]);
  const results = [first, second];
  const nonEmpty = results.filter((r) => r.length > 0);
  const empty = results.filter((r) => r.length === 0);

  assert.equal(nonEmpty.length, 1, 'exactly one of the two overlapping pump() calls should have drained the message');
  assert.equal(empty.length, 1, 'the other overlapping call should have returned [] via the reentrancy guard, not duplicated the same event');
  assert.equal(session.eventLog().length, 1, 'the event must appear exactly once in eventLog(), not twice');
});

// --- Fourth whole-branch review round: close()'s terminal events must reach a pump()-only host ---

test('an out-of-band close() (no turn in flight) delivers its session_closed to the very next pump() call, not stranded, and a further poll returns []', async () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);

  // close() runs out of band -- not from inside any pump() call's own loop -- exactly the
  // scenario the re-review verified head-to-head: before this round's fix, a host polling
  // pump() after this never saw the terminal event (184 polls to a test deadline); after, it
  // must arrive within a handful of polls.
  session.close();

  let sessionClosed: unknown;
  for (let i = 0; i < 5 && sessionClosed === undefined; i++) {
    const events = await session.pump();
    sessionClosed = events.find((e) => e.type === 'session_closed');
  }
  assert.deepEqual(sessionClosed, { type: 'session_closed', reason: 'closed_by_host' });

  // A further poll must return [] -- the buffer is now empty, and terminal state must not
  // re-emit the same event a second time.
  const again = await session.pump();
  assert.deepEqual(again, []);

  // eventLog() reflects it exactly once (it was appended by whichever pump() call drained it).
  assert.equal(session.eventLog().filter((e) => e.type === 'session_closed').length, 1);
});

test('an out-of-band close() while a turn is in flight delivers BOTH turn_completed(failed) and session_closed to the next pump() call', async () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  const { turnId } = session.sendTurn('hello');

  session.close();

  let events: Awaited<ReturnType<typeof session.pump>> = [];
  for (let i = 0; i < 5 && !events.some((e) => e.type === 'session_closed'); i++) {
    events = await session.pump();
  }

  const completed = events.find((e) => e.type === 'turn_completed') as { turnId: string; outcome: string } | undefined;
  assert.ok(completed, 'expected a synthesized turn_completed for the in-flight turn, delivered by the same pump() call as session_closed');
  assert.equal(completed?.turnId, turnId);
  assert.equal(completed?.outcome, 'failed');
  assert.ok(events.some((e) => e.type === 'session_closed'));

  const again = await session.pump();
  assert.deepEqual(again, []);
});

test('close() with a pending permission request delivers permission_resolved, then session_closed, to the next pump() call, in that order', async () => {
  const { query } = makeFakeQuery();
  const { session, options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY);
  const hookCallback = options.hooks!.PreToolUse![0].hooks[0];

  const outputPromise = hookCallback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  // Drain the permission_requested first so this test isolates what close() itself delivers.
  const requested = await session.pump();
  assert.equal(requested.length, 1);
  assert.equal(requested[0].type, 'permission_requested');

  session.close();
  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');

  const events = await session.pump();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'permission_resolved');
  assert.equal((events[0] as { outcome: string }).outcome, 'cancelled_by_session_close');
  assert.deepEqual(events[1], { type: 'session_closed', reason: 'closed_by_host' });
});

// ---------------------------------------------------------------------------------------------
// Resume outcome (2026-09-12 protocol hardening).
//
// Before this, `createSession` read `config.resume`, handed it to the SDK, and forgot it -- nothing
// downstream held the requested id, and `pump()`'s catch bound no error at all (`} catch {`). A
// refused resume was therefore shape-identical to any other provider crash: two events,
// turn_completed{failed} and session_closed{provider_failed}, with the provider's own explanation
// ("No conversation found with session ID: ...") discarded on the way past.
// ---------------------------------------------------------------------------------------------

function resumingSession(providerSessionId: string, fork = false) {
  const { query, controller } = makeFakeQuery();
  const session = createSession(
    { cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY, resume: { providerSessionId }, fork },
    () => query,
  );
  return { session, controller };
}

type ResumeOutcomeEvent = Extract<ClaudeRuntimeEvent, { type: 'resume_outcome' }>;

/** Narrows to the real union member, so these tests read its fields by name instead of casting --
 * a cast would also keep compiling if the event's shape changed underneath them. */
function resumeOutcomes(events: ClaudeRuntimeEvent[]): ResumeOutcomeEvent[] {
  return events.filter((e): e is ResumeOutcomeEvent => e.type === 'resume_outcome');
}

test('resume: the provider refusing the id is reported as REJECTED, carrying its own words', async () => {
  const { session, controller } = resumingSession('does-not-exist');
  controller.rejectNext(new Error('Claude Code returned an error result: No conversation found with session ID: does-not-exist'));

  const events = await session.pump();
  const outcomes = resumeOutcomes(events);

  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], {
    type: 'resume_outcome',
    requestedProviderSessionId: 'does-not-exist',
    status: 'rejected',
    forked: false,
    detail: 'Claude Code returned an error result: No conversation found with session ID: does-not-exist',
  });
  // Ordered before the termination it explains, so a consumer folding in order knows WHY the
  // session is about to close rather than having to infer it from a bare provider_failed.
  const outcomeIndex = events.findIndex((e) => e.type === 'resume_outcome');
  const closedIndex = events.findIndex((e) => e.type === 'session_closed');
  assert.ok(outcomeIndex < closedIndex, `resume_outcome must precede session_closed (got ${outcomeIndex} vs ${closedIndex})`);
});

test('resume: a provider failure that is NOT a refusal is INITIALIZATION_FAILED, not REJECTED', async () => {
  const { session, controller } = resumingSession('sess-abc');
  controller.rejectNext(new Error('spawn ENOENT'));

  const outcomes = resumeOutcomes(await session.pump());

  // The distinction matters to a user: "that conversation is gone" and "something is wrong with the
  // provider" call for different next actions. Classifying every death as a refusal would tell
  // someone their conversation had been deleted when it had not.
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'initialization_failed');
  assert.equal(outcomes[0].detail, 'spawn ENOENT');
});

test('resume: a provider that exits before reporting a session id is INITIALIZATION_FAILED', async () => {
  const { session, controller } = resumingSession('sess-abc');
  controller.end();

  const outcomes = resumeOutcomes(await session.pump());

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'initialization_failed');
  // Not "rejected": the provider said nothing about the id, so claiming it does not exist would be
  // inventing a reason.
  assert.match(outcomes[0].detail ?? "", /before reporting a session id/);
});

test('resume: a session id arriving at the first turn is reported as ATTACHED, ahead of session_ready', async () => {
  const { session, controller } = resumingSession('sess-abc');
  controller.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-abc',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
  } as never);

  const events = await session.pump();
  const outcomes = resumeOutcomes(events);

  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], {
    type: 'resume_outcome',
    requestedProviderSessionId: 'sess-abc',
    status: 'attached',
    forked: false,
    attachedProviderSessionId: 'sess-abc',
  });
  const outcomeIndex = events.findIndex((e) => e.type === 'resume_outcome');
  const readyIndex = events.findIndex((e) => e.type === 'session_ready');
  assert.ok(outcomeIndex < readyIndex, 'the verdict must arrive before the id it is a verdict about');
});

test('resume: a DIFFERENT session id is reported as attached-to-what-it-actually-got, not silently equal', async () => {
  const { session, controller } = resumingSession('sess-requested');
  controller.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-something-else',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
  } as never);

  const outcomes = resumeOutcomes(await session.pump());

  // The kernel reports what happened; comparing the two ids is the consumer's call, because with
  // fork a differing id is CORRECT. What must never happen is the difference going unreported.
  assert.equal(outcomes[0].attachedProviderSessionId, 'sess-something-else');
  assert.equal(outcomes[0].requestedProviderSessionId, 'sess-requested');
});

test('resume: fork is carried on the outcome, because forking legitimately changes the id', async () => {
  const { session, controller } = resumingSession('sess-original', true);
  controller.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-forked-copy',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
  } as never);

  const outcomes = resumeOutcomes(await session.pump());

  // Measured against the real CLI: `fork: true` returns a different id by design. A consumer that
  // compared ids without reading this flag would report every successful fork as a substitution.
  assert.equal(outcomes[0].forked, true);
  assert.equal(outcomes[0].status, 'attached');
});

test('resume: the outcome is reported at most once, even across several pumps', async () => {
  const { session, controller } = resumingSession('sess-abc');
  controller.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-abc',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
  } as never);
  const first = resumeOutcomes(await session.pump());

  // A later provider failure is a session death, not a second verdict on a resume that already
  // succeeded. Without the latch a consumer would see ATTACHED contradicted by a later REJECTED.
  controller.rejectNext(new Error('Claude Code returned an error result: No conversation found with session ID: sess-abc'));
  const second = resumeOutcomes(await session.pump());

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('a session that never asked to resume never reports a resume outcome', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  controller.rejectNext(new Error('Claude Code returned an error result: No conversation found with session ID: x'));

  assert.deepEqual(resumeOutcomes(await session.pump()), []);
});

// ---------------------------------------------------------------------------------------------
// setting_sources + tool_policy (ClaudeHostPolicy tags 7 and 6)
// ---------------------------------------------------------------------------------------------

const BYPASS_POLICY: ClaudeHostPolicy = { ...NATIVE_INTERACTIVE_POLICY, permissions: 'bypass' };

/**
 * T3 -- the crux of the whole `setting_sources` design: the new field overrides AXIS A ONLY.
 *
 * `configuration` is two axes wearing one name. Axis A is `Options.settingSources`; axis B is
 * whether the non-settings ambient channels (MCP discovery, auto-memory) are closed, and axis B has
 * no other expression anywhere in the protocol. So an implementation that let `settingSources`
 * short-circuit the `if (policy.configuration === 'isolated')` block -- which is the obvious way to
 * write it, and the way "replace the enum with a source list" would force -- would silently revert
 * the four behaviours that made `isolated` actually isolate, while this test's first assertion still
 * passed. All five are asserted together for exactly that reason.
 *
 * This combination is also the one the design exists to make expressible at all: the project's own
 * CLAUDE.md loaded, with the operator's ~/.claude excluded AND MCP and auto-memory closed --
 * strictly stronger than anything the legacy CLI path can ask for.
 */
test('policyToBaseOptions: isolated + explicit settingSources overrides axis A only, leaving MCP and auto-memory closed', () => {
  const options = policyToBaseOptions(
    {
      configuration: 'isolated',
      permissions: 'interactive',
      persistence: 'ephemeral',
      executable: 'host_cli',
      settingSources: ['project', 'local'],
    },
    '/tmp/project',
    { baseEnv: { PATH: '/usr/bin' } },
  );
  assert.deepEqual(options.settingSources, ['project', 'local']);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.settings, { autoMemoryEnabled: false });
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('policyToBaseOptions: an absent settingSources still defers to configuration, byte-identically to before the field existed', () => {
  assert.deepEqual(policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project').settingSources, ['user', 'project', 'local']);
  assert.deepEqual(
    policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, configuration: 'isolated' }, '/tmp/project').settingSources,
    [],
  );
});

/** `??`, not `||`. An explicit empty list is a stated request ("load no filesystem settings tiers")
 * and must not fall through to the preset the way a falsy-check would send it. */
test('policyToBaseOptions: an explicit empty settingSources is honoured under native, not treated as absent', () => {
  const options = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, settingSources: [] }, '/tmp/project');
  assert.deepEqual(options.settingSources, []);
  // ...and it is still `native`, so axis B stays open. The two axes are independent in both
  // directions, not just the one T3 covers.
  assert.equal(options.strictMcpConfig, undefined);
});

/**
 * T4 -- `allow` reaches `Options.tools` and NEVER `Options.allowedTools`.
 *
 * The SDK on `allowedTools`: "List of tool names that are auto-allowed without prompting for
 * permission. These tools will execute automatically without asking the user for approval. To
 * restrict which tools are available, use the `tools` option instead."
 *
 * So mapping an allow list there would WIDEN access under a field named allow -- every named tool
 * would stop prompting. The `=== undefined` half of this test is the load-bearing half: without it,
 * a mutation that wrote to `allowedTools` instead would pass while quietly auto-approving the lot.
 */
test('policyToBaseOptions: toolPolicy.allow maps to Options.tools and never to Options.allowedTools', () => {
  const options = policyToBaseOptions(
    { ...NATIVE_INTERACTIVE_POLICY, toolPolicy: { allow: ['Read', 'Grep'] } },
    '/tmp/project',
  );
  assert.deepEqual(options.tools, ['Read', 'Grep']);
  assert.equal(options.allowedTools, undefined);
});

/** The SDK documents `Options.tools: []` as "Disable all built-in tools", so present-but-empty is a
 * stated request that must survive as `[]` rather than collapsing into absence. */
test('policyToBaseOptions: a present-but-empty allow list reaches Options.tools as [], not as undefined', () => {
  const options = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, toolPolicy: { allow: [] } }, '/tmp/project');
  assert.deepEqual(options.tools, []);
});

/** T5 -- bypass with no tool policy at all gets the conservative default. This is the one permission
 * mode that installs no PreToolUse hook, so "nothing stated" would otherwise mean "no gate of any
 * kind, and nothing said so". */
test('policyToBaseOptions: bypass with NO toolPolicy gets the conservative deny list', () => {
  const options = policyToBaseOptions(BYPASS_POLICY, '/tmp/project');
  assert.deepEqual(options.disallowedTools, [...CONSERVATIVE_BYPASS_DENY]);
  assert.deepEqual(CONSERVATIVE_BYPASS_DENY, ['Bash', 'Write', 'Edit', 'NotebookEdit']);
});

/** T6 -- a stated deny list is honoured verbatim and the default is NOT appended to it. Second-
 * guessing a stated policy is how a policy layer becomes unpredictable; the guarantee is "silence
 * cannot reach zero gates", not "nothing can". */
test('policyToBaseOptions: bypass with a STATED deny list is honoured verbatim, with nothing appended', () => {
  const options = policyToBaseOptions(
    { ...BYPASS_POLICY, toolPolicy: { deny: ['WebFetch'] } },
    '/tmp/project',
  );
  assert.deepEqual(options.disallowedTools, ['WebFetch']);
});

/** T7 -- the present-but-empty escape hatch, closed. `{}` and `{ deny: [] }` are the shapes a caller
 * reaches by forgetting rather than by choosing, so keying the default on `toolPolicy === undefined`
 * instead of on emptiness would let a bypass session with a hollow ToolPolicy reach zero gates while
 * looking configured. */
test('policyToBaseOptions: bypass with a PRESENT but empty toolPolicy still gets the default', () => {
  assert.deepEqual(
    policyToBaseOptions({ ...BYPASS_POLICY, toolPolicy: {} }, '/tmp/project').disallowedTools,
    [...CONSERVATIVE_BYPASS_DENY],
  );
  assert.deepEqual(
    policyToBaseOptions({ ...BYPASS_POLICY, toolPolicy: { deny: [] } }, '/tmp/project').disallowedTools,
    [...CONSERVATIVE_BYPASS_DENY],
  );
});

/** T8 -- an allow list is itself a stated restriction, so it takes the default off. A caller that
 * narrowed the base tool set has said what it wants; adding an unrequested deny on top would make
 * the resulting session something neither side asked for. */
test('policyToBaseOptions: bypass with an allow list and no deny gets NO injected deny list', () => {
  const options = policyToBaseOptions({ ...BYPASS_POLICY, toolPolicy: { allow: ['Read'] } }, '/tmp/project');
  assert.equal(options.disallowedTools, undefined);
  assert.deepEqual(options.tools, ['Read']);
});

/**
 * T8b -- `unrestricted` is the STATED form of "no restriction", and it takes the default off.
 *
 * Before this field the only way to decline the conservative floor was to state some other
 * restriction -- T6's deny list, T8's allow list, or a fake entry naming no real tool. So a caller
 * that genuinely wanted every tool had to lie about wanting something narrower, and the wire could
 * not tell that lie apart from a typo. This is the honest spelling of it.
 */
test('policyToBaseOptions: bypass with unrestricted gets NO injected deny list', () => {
  const options = policyToBaseOptions({ ...BYPASS_POLICY, toolPolicy: { unrestricted: true } }, '/tmp/project');
  assert.equal(options.disallowedTools, undefined);
  assert.equal(options.tools, undefined);
  assert.equal(options.permissionMode, 'bypassPermissions');
});

/**
 * T8c -- `unrestricted: false` is not a way to say anything. It is what a proto3 scalar decodes to
 * when the field was never set, so it must behave exactly like silence and still get the default.
 * Keying the predicate on presence (`'unrestricted' in toolPolicy`) rather than on the value would
 * make every proto3 caller that never heard of this field look like one that declined the floor.
 */
test('policyToBaseOptions: bypass with unrestricted FALSE still gets the conservative deny list', () => {
  assert.deepEqual(
    policyToBaseOptions({ ...BYPASS_POLICY, toolPolicy: { unrestricted: false } }, '/tmp/project').disallowedTools,
    [...CONSERVATIVE_BYPASS_DENY],
  );
});

/**
 * T8d -- a contradiction must not be resolved HERE by widening.
 *
 * `unrestricted` together with a stated deny is refused at the sidecar boundary (validatePolicy), so
 * it should never reach the kernel. If it does anyway -- a kernel consumer that does not go through
 * the sidecar -- the stated deny still stands. The dangerous direction is dropping it, so that is
 * the one pinned.
 */
test('policyToBaseOptions: unrestricted never drops a deny list the caller also stated', () => {
  const options = policyToBaseOptions(
    { ...BYPASS_POLICY, toolPolicy: { unrestricted: true, deny: ['Write'] } },
    '/tmp/project',
  );
  assert.deepEqual(options.disallowedTools, ['Write']);
});

/**
 * T8e -- and the announce side of T8b. A notice claiming `bypass_default_deny_applied` on a session
 * that asked for no restriction and got none would be a false statement about what was applied --
 * the same apply/announce divergence T10b measured in the opposite direction.
 */
test('createSession: a bypass session that states unrestricted emits no provider_notice', async () => {
  const { query } = makeFakeQuery();
  const session = createSession(
    { cwd: '/tmp/project', policy: { ...BYPASS_POLICY, toolPolicy: { unrestricted: true } } },
    () => query,
  );
  assert.deepEqual(await session.pump(), []);
});

/** T9 -- the bypass default must not leak into any other permission mode. Every existing
 * interactive caller (Neovibe's Auto mode, the Go control plane's investigator) would silently lose
 * Bash/Write/Edit/NotebookEdit if the injection ever escaped its guard. */
test('policyToBaseOptions: an interactive policy with no toolPolicy sets neither tools nor disallowedTools', () => {
  const options = policyToBaseOptions(NATIVE_INTERACTIVE_POLICY, '/tmp/project');
  assert.equal(options.disallowedTools, undefined);
  assert.equal(options.tools, undefined);
  const rules = policyToBaseOptions({ ...NATIVE_INTERACTIVE_POLICY, permissions: 'verdandi_rules' }, '/tmp/project');
  assert.equal(rules.disallowedTools, undefined);
  assert.equal(rules.tools, undefined);
});

/**
 * T10 -- the default is ANNOUNCED, through the one channel a WatchSessionEvents subscriber can
 * actually observe.
 *
 * Asserted on `pump()`'s RETURN VALUE, not on `eventLog()`, and with no provider message emitted
 * first. Those two details are the test: an event pushed into `this.events` instead of
 * `pendingPermissionEvents` would show up in the log and never reach a broadcast subscriber -- the
 * exact bug this file already records for `turn_started`, where two real turns produced zero
 * `turn_started` events on the wire while the in-process log looked fine.
 */
test('createSession: a bypass session with no tool policy emits exactly one provider_notice from the FIRST pump()', async () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: BYPASS_POLICY }, () => query);

  const events = await session.pump();

  assert.deepEqual(events, [
    {
      type: 'provider_notice',
      kind: 'verdandi_policy',
      subtype: 'bypass_default_deny_applied',
      raw: { disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'] },
    },
  ]);
  // Exactly once, not once per poll.
  assert.deepEqual(await session.pump(), []);
});

/**
 * T10b -- the same guarantee for the two shapes a caller reaches by FORGETTING, driven through
 * `createSession` rather than through the predicate.
 *
 * T10 covers only `toolPolicy: undefined` and T12 compares the predicate against
 * `policyToBaseOptions` without ever constructing a session, so before this test the announce side
 * of `{}` and `{ deny: [] }` was asserted by nothing. Measured: keying the announce site on
 * `config.policy.toolPolicy === undefined` instead of on `usesDefaultBypassDeny` left the entire
 * kernel suite green while a bypass session with `{ deny: [] }` got the conservative default applied
 * IN SILENCE -- a narrowing nobody asked for and nobody was told about, which is the one outcome the
 * carve-out exists to prevent.
 *
 * Note the asymmetry this closes. The opposite drift -- announcing unconditionally under bypass --
 * was already caught by T11. Only the silent direction was open, and silent is the dangerous one.
 */
test('createSession: every "stated nothing" shape of toolPolicy under bypass is announced, not just an absent one', async () => {
  const silentShapes: { label: string; toolPolicy: ClaudeHostPolicy['toolPolicy'] }[] = [
    { label: 'absent', toolPolicy: undefined },
    { label: 'present but empty', toolPolicy: {} },
    { label: 'empty deny list', toolPolicy: { deny: [] } },
  ];

  for (const { label, toolPolicy } of silentShapes) {
    const { query } = makeFakeQuery();
    const session = createSession({ cwd: '/tmp/project', policy: { ...BYPASS_POLICY, toolPolicy } }, () => query);
    assert.deepEqual(
      await session.pump(),
      [
        {
          type: 'provider_notice',
          kind: 'verdandi_policy',
          subtype: 'bypass_default_deny_applied',
          raw: { disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'] },
        },
      ],
      `${label}: the conservative default was applied without announcing it`,
    );
  }
});

/** T11 -- the cry-wolf direction. A notice on a correctly-configured session is a permanently-lit
 * warning, which is a warning nobody reads. */
test('createSession: a bypass session that STATES a deny list emits no provider_notice', async () => {
  const { query } = makeFakeQuery();
  const session = createSession(
    { cwd: '/tmp/project', policy: { ...BYPASS_POLICY, toolPolicy: { deny: ['Bash'] } } },
    () => query,
  );
  assert.deepEqual(await session.pump(), []);
});

test('createSession: a non-bypass session never emits the bypass notice', async () => {
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: NATIVE_INTERACTIVE_POLICY }, () => query);
  assert.deepEqual(await session.pump(), []);
});

/**
 * T12 -- the announce rule and the apply rule are the same rule.
 *
 * `usesDefaultBypassDeny` has two call sites: `policyToBaseOptions` (decides whether to inject) and
 * `createSession` (decides whether to announce). Inlining the predicate at either one and then
 * editing that copy produces either a default applied in silence, or a notice about a default that
 * was never applied. The table walks every corner so the two can only ever be observed agreeing.
 */
test('usesDefaultBypassDeny agrees with what policyToBaseOptions actually injected, across every corner', () => {
  const corners: Array<{ label: string; policy: ClaudeHostPolicy }> = [
    { label: 'bypass, no toolPolicy', policy: BYPASS_POLICY },
    { label: 'bypass, empty toolPolicy', policy: { ...BYPASS_POLICY, toolPolicy: {} } },
    { label: 'bypass, empty deny', policy: { ...BYPASS_POLICY, toolPolicy: { deny: [] } } },
    { label: 'bypass, stated deny', policy: { ...BYPASS_POLICY, toolPolicy: { deny: ['Bash'] } } },
    { label: 'bypass, empty allow', policy: { ...BYPASS_POLICY, toolPolicy: { allow: [] } } },
    { label: 'bypass, stated allow', policy: { ...BYPASS_POLICY, toolPolicy: { allow: ['Read'] } } },
    { label: 'bypass, unrestricted', policy: { ...BYPASS_POLICY, toolPolicy: { unrestricted: true } } },
    { label: 'bypass, unrestricted false', policy: { ...BYPASS_POLICY, toolPolicy: { unrestricted: false } } },
    { label: 'bypass, unrestricted with stated deny', policy: { ...BYPASS_POLICY, toolPolicy: { unrestricted: true, deny: ['Bash'] } } },
    { label: 'interactive, no toolPolicy', policy: NATIVE_INTERACTIVE_POLICY },
    { label: 'verdandi_rules, no toolPolicy', policy: { ...NATIVE_INTERACTIVE_POLICY, permissions: 'verdandi_rules' } },
    { label: 'interactive, stated deny', policy: { ...NATIVE_INTERACTIVE_POLICY, toolPolicy: { deny: ['Bash'] } } },
  ];
  for (const { label, policy } of corners) {
    const options = policyToBaseOptions(policy, '/tmp/project');
    const injected =
      options.disallowedTools !== undefined &&
      options.disallowedTools.length === CONSERVATIVE_BYPASS_DENY.length &&
      CONSERVATIVE_BYPASS_DENY.every((name, i) => options.disallowedTools![i] === name) &&
      (policy.toolPolicy?.deny ?? []).length === 0;
    assert.equal(
      usesDefaultBypassDeny(policy),
      injected,
      `${label}: usesDefaultBypassDeny said ${usesDefaultBypassDeny(policy)} but policyToBaseOptions produced disallowedTools=${JSON.stringify(options.disallowedTools)}`,
    );
  }
});

// --- partial streaming the CLI did not actually deliver (2026-09-18) ----------------------------
//
// End to end through the real actor, because the fix is split across two files on purpose: the
// translator decides, and this loop is what tells it whether the deltas arrived. A unit test of
// either half alone would pass with the other half missing.
//
// The symptom these were written against -- a turn that got past its permission round trip and
// completed with no ContentDelta -- was reported downstream on CLI 2.1.272 and then re-attributed,
// by its reporter, to that consumer's own test. See eventTranslation.ts's
// `streamedSinceLastAssistant` doc: this is a guard against a silent, total failure direction, not
// a regression test for something anyone has observed.

const PARTIAL_POLICY: ClaudeHostPolicy = { ...NATIVE_INTERACTIVE_POLICY, streaming: 'partial' };

/** Drains repeatedly rather than once: the fake query hands an emitted message to an already
 *  outstanding next() a pump later, so a single drain can legitimately return nothing yet (the same
 *  reason the session_ready test above polls). Accumulates across drains in arrival order. */
async function textFrom(session: ReturnType<typeof createSession>): Promise<string[]> {
  const text: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const event of await session.pump()) {
      if (event.type === 'text_delta') {
        text.push((event as Extract<ClaudeRuntimeEvent, { type: 'text_delta' }>).text);
      }
    }
  }
  return text;
}

test('partial streaming: a CLI that honours includePartialMessages streams once, never twice', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL_POLICY }, () => query);
  session.sendTurn('hello');
  await session.pump();

  controller.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } } as never);
  controller.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } } as never);
  controller.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } } as never);

  assert.deepEqual(await textFrom(session), ['Hello ', 'there'], 'the complete message must not repeat what streamed');
  session.close();
});

test('partial streaming: a CLI that sends no stream events still delivers the reply', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL_POLICY }, () => query);
  session.sendTurn('hello');
  await session.pump();

  // includePartialMessages was requested and simply not honoured -- no stream_event ever arrives.
  controller.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } } as never);

  assert.deepEqual(await textFrom(session), ['Hello there'], 'the reply must not vanish when the deltas never came');
  session.close();
});

/** Per message, not per turn: a turn whose first message streamed and whose second did not must
 * recover the second, rather than staying armed from the first. */
test('partial streaming: the suppression is judged per assistant message, not per turn', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL_POLICY }, () => query);
  session.sendTurn('hello');
  await session.pump();

  controller.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } } } as never);
  controller.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } } as never);
  controller.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } } as never);

  assert.deepEqual(await textFrom(session), ['first', 'second']);
  session.close();
});

test('createSession: model and effort reach the SDK options when set, and stay unset otherwise', () => {
  const { query } = makeFakeQuery();
  const { options } = createSessionCapturingOptions(query, NATIVE_INTERACTIVE_POLICY, { model: 'sonnet', effort: 'medium' });
  assert.equal(options.model, 'sonnet');
  assert.equal(options.effort, 'medium');

  const { query: q2 } = makeFakeQuery();
  const { options: plain } = createSessionCapturingOptions(q2, NATIVE_INTERACTIVE_POLICY, {});
  // Unset is what keeps the CLI default in force -- the behaviour before these existed.
  assert.equal(plain.model, undefined);
  assert.equal(plain.effort, undefined);
});
