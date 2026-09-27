import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import {
  createSession,
  gateDecision,
  PermissionModeError,
  policyToBaseOptions,
  CONSERVATIVE_BYPASS_DENY,
  type QueryFn,
} from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import type { MinimalQuery } from '../src/queryTypes.js';

/**
 * SetPermissionMode, kernel half: the CLI's mode and this session's PreToolUse gate change together,
 * in an order that is never weaker than either mode on its own, and a session created under bypass
 * refuses to pretend it can be gated again.
 */

/** Gated and opted in to switching (the only kind of gated session that may enter bypass). */
const INTERACTIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'host_cli', permissionModeSwitchable: true };
const INTERACTIVE_UNRESTRICTED: ClaudeHostPolicy = { ...INTERACTIVE, toolPolicy: { unrestricted: true } };
/** Gated, NOT opted in: what every client that predates the field sends. */
const INTERACTIVE_FIXED: ClaudeHostPolicy = { ...INTERACTIVE_UNRESTRICTED, permissionModeSwitchable: false };
const BYPASS: ClaudeHostPolicy = { ...INTERACTIVE, permissions: 'bypass', toolPolicy: { unrestricted: true } };

function start(query: MinimalQuery, policy: ClaudeHostPolicy): { session: ReturnType<typeof createSession>; options: Options } {
  let captured: Options | undefined;
  const queryFn: QueryFn = (params) => {
    captured = params.options;
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy }, queryFn);
  return { session, options: captured! };
}

function hookOf(options: Options): HookCallback {
  return options.hooks!.PreToolUse![0].hooks[0];
}

function callHook(hook: HookCallback, toolName: string, id = 'toolu_1') {
  return hook(
    { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never,
    id,
    { signal: new AbortController().signal },
  );
}

function decisionOf(output: unknown): string | undefined {
  return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
}

/** Resolves true if `promise` settles within a few macrotasks. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  return settled;
}

test('only an opted-in gated session is launched with bypass AVAILABLE (never in force); others are unchanged', () => {
  // Not opted in -- absent or false -- gets no flag: the CLI refuses it as root/sudo without IS_SANDBOX=1.
  for (const policy of [INTERACTIVE_FIXED, { ...INTERACTIVE, permissionModeSwitchable: undefined }, { ...INTERACTIVE, permissions: 'verdandi_rules' as const, permissionModeSwitchable: false }]) {
    const options = policyToBaseOptions(policy, '/tmp/project');
    assert.equal(options.allowDangerouslySkipPermissions, undefined, JSON.stringify(policy));
    assert.equal(options.permissionMode, 'default');
  }
  const gated = policyToBaseOptions(INTERACTIVE, '/tmp/project');
  // Without this the CLI refuses set_permission_mode bypassPermissions (`bypass_not_launched`).
  assert.equal(gated.allowDangerouslySkipPermissions, true);
  assert.equal(gated.permissionMode, 'default', 'it must still START in default -- stated, so no settings tier can choose it');

  const bypass = policyToBaseOptions({ ...BYPASS, permissionModeSwitchable: true }, '/tmp/project');
  assert.equal(bypass.permissionMode, 'bypassPermissions');
  assert.equal(bypass.allowDangerouslySkipPermissions, undefined, 'bypass sessions get exactly the options they always got');
});

test('gateDecision: ask in gated modes; abstain in bypass; deny only the floor tools when the floor holds', () => {
  assert.deepEqual(gateDecision({ permissions: 'interactive', bypassFloor: false }, 'Bash'), { kind: 'ask' });
  assert.deepEqual(gateDecision({ permissions: 'verdandi_rules', bypassFloor: true }, 'Bash'), { kind: 'ask' }, 'a stale floor flag never matters outside bypass');
  assert.deepEqual(gateDecision({ permissions: 'bypass', bypassFloor: false }, 'Bash'), { kind: 'abstain' });
  assert.deepEqual(gateDecision({ permissions: 'bypass', bypassFloor: true }, 'Read'), { kind: 'abstain' });
  for (const tool of CONSERVATIVE_BYPASS_DENY) {
    assert.equal(gateDecision({ permissions: 'bypass', bypassFloor: true }, tool).kind, 'deny', tool);
  }
});

test('interactive -> bypass: the CLI is told bypassPermissions, the gate stops asking, and the change is announced', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = start(query, INTERACTIVE_UNRESTRICTED);
  const hook = hookOf(options);

  const result = await session.setPermissionMode('bypass');
  assert.deepEqual(result, { permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: false });
  assert.deepEqual(controller.setPermissionModeCalls, ['bypassPermissions']);

  const output = await callHook(hook, 'Bash');
  // Abstains -- no decision at all -- so the CLI's own bypass decides, as with no hook installed.
  assert.deepEqual(output, {});
  const events = await session.pump();
  assert.deepEqual(events, [{ type: 'permission_mode_changed', permissions: 'bypass', permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: false }]);
  assert.ok(!events.some((e) => e.type === 'permission_requested'), 'an abstaining gate asks nobody');
  session.close();
});

test('bypass -> interactive on a session created gated: the gate asks again, and it starts asking BEFORE the CLI is told', async () => {
  let releaseCli: (() => void) | undefined;
  const { query, controller } = makeFakeQuery({
    setPermissionMode: (mode) => (mode === 'default' ? new Promise<void>((r) => (releaseCli = r)) : Promise.resolve()),
  });
  const { session, options } = start(query, INTERACTIVE_UNRESTRICTED);
  const hook = hookOf(options);
  await session.setPermissionMode('bypass');
  await session.pump();

  const switching = session.setPermissionMode('interactive');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(controller.setPermissionModeCalls, ['bypassPermissions', 'default']);
  // The CLI has not acknowledged yet; a call arriving now must already be ASKED about.
  const pendingCall = callHook(hook, 'Write');
  const raised = await session.pump();
  assert.equal(raised.length, 1);
  assert.equal(raised[0].type, 'permission_requested');

  releaseCli!();
  assert.deepEqual(await switching, { permissionMode: 'default', bypassDefaultDenyApplied: false });
  const changed = await session.pump();
  assert.deepEqual(changed, [{ type: 'permission_mode_changed', permissions: 'interactive', permissionMode: 'default', bypassDefaultDenyApplied: false }]);

  session.resolvePermission((raised[0] as { permissionId: string }).permissionId, { allow: false });
  assert.equal(decisionOf(await pendingCall), 'deny');
  session.close();
});

test('interactive -> bypass: the gate keeps asking until the CLI acknowledged', async () => {
  let releaseCli: (() => void) | undefined;
  const { query } = makeFakeQuery({ setPermissionMode: () => new Promise<void>((r) => (releaseCli = r)) });
  const { session, options } = start(query, INTERACTIVE_UNRESTRICTED);
  const hook = hookOf(options);

  const switching = session.setPermissionMode('bypass');
  await new Promise((r) => setImmediate(r));
  const asked = callHook(hook, 'Bash');
  const raised = await session.pump();
  assert.equal(raised[0]?.type, 'permission_requested', 'still gated while the CLI has not switched');

  releaseCli!();
  await switching;
  assert.deepEqual(await callHook(hook, 'Bash', 'toolu_2'), {}, 'abstains once the CLI is in bypass');
  session.resolvePermission((raised[0] as { permissionId: string }).permissionId, { allow: true });
  assert.equal(decisionOf(await asked), 'allow', 'a request pending across the switch is left for the host to answer');
  session.close();
});

test('entering bypass with no stated tool restriction applies the conservative floor through the gate, and says so', async () => {
  const { query } = makeFakeQuery();
  const { session, options } = start(query, INTERACTIVE);
  const hook = hookOf(options);

  const result = await session.setPermissionMode('bypass');
  assert.equal(result.bypassDefaultDenyApplied, true);
  for (const tool of CONSERVATIVE_BYPASS_DENY) {
    assert.equal(decisionOf(await callHook(hook, tool)), 'deny', `${tool} must be refused by the floor`);
  }
  assert.deepEqual(await callHook(hook, 'Read'), {}, 'anything else is left to the CLI');

  const events = await session.pump();
  assert.deepEqual(
    events.map((e) => e.type === 'provider_notice' ? `${e.type}:${e.subtype}` : e.type),
    ['provider_notice:bypass_default_deny_applied', 'permission_mode_changed'],
  );
  assert.equal((events[1] as Extract<ClaudeRuntimeEvent, { type: 'permission_mode_changed' }>).bypassDefaultDenyApplied, true);

  // And the floor lifts when the session leaves bypass: the gate asks about Bash again.
  await session.setPermissionMode('interactive');
  void callHook(hook, 'Bash', 'toolu_9');
  const after = await session.pump();
  assert.ok(after.some((e) => e.type === 'permission_requested'));
  session.close();
});

test('a session created under bypass cannot be switched to a gated mode: refused, and the CLI is never asked', async () => {
  const { query, controller } = makeFakeQuery();
  const { session } = start(query, BYPASS);
  await assert.rejects(session.setPermissionMode('interactive'), (err: unknown) => err instanceof PermissionModeError && err.kind === 'refused');
  assert.deepEqual(controller.setPermissionModeCalls, []);
  assert.deepEqual(await session.pump(), [], 'nothing is announced for a refused switch');

  // bypass -> bypass is accepted (it is what the session already is) and does not re-announce the floor.
  assert.deepEqual(await session.setPermissionMode('bypass'), { permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: false });
  session.close();
});

test('a CLI refusal fails the switch with the CLI\'s own words and leaves the gate as it was', async () => {
  const { query } = makeFakeQuery({
    setPermissionMode: () => Promise.reject(new Error('Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration')),
  });
  const { session, options } = start(query, INTERACTIVE_UNRESTRICTED);
  const hook = hookOf(options);

  await assert.rejects(
    session.setPermissionMode('bypass'),
    (err: unknown) => err instanceof PermissionModeError && err.kind === 'provider_refused' && /disabled by settings/.test(err.message),
  );
  void callHook(hook, 'Bash');
  const events = await session.pump();
  assert.deepEqual(events.map((e) => e.type), ['permission_requested'], 'still gated, and no permission_mode_changed');
  session.close();
});

test('a switch on a closed session is refused as closed', async () => {
  const { query } = makeFakeQuery();
  const { session } = start(query, INTERACTIVE);
  session.close();
  await assert.rejects(session.setPermissionMode('bypass'), (err: unknown) => err instanceof PermissionModeError && err.kind === 'closed');
});

test('overlapping switches apply in call order, so the gate ends where the CLI ends', async () => {
  const releases: Array<() => void> = [];
  const { query, controller } = makeFakeQuery({ setPermissionMode: () => new Promise<void>((r) => releases.push(r)) });
  const { session, options } = start(query, INTERACTIVE_UNRESTRICTED);
  const hook = hookOf(options);

  const first = session.setPermissionMode('bypass');
  const second = session.setPermissionMode('interactive');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(controller.setPermissionModeCalls, ['bypassPermissions'], 'the second waits for the first');
  releases.shift()!();
  await first;
  assert.equal(await settlesSoon(second), false);
  assert.deepEqual(controller.setPermissionModeCalls, ['bypassPermissions', 'default']);
  releases.shift()!();
  await second;

  void callHook(hook, 'Bash');
  const events = await session.pump();
  assert.ok(events.some((e) => e.type === 'permission_requested'), 'the last call wins: gated');
  session.close();
});

test('a gated session that did not opt in cannot enter bypass: refused before the CLI is asked, gate unchanged', async () => {
  const { query, controller } = makeFakeQuery();
  const { session, options } = start(query, INTERACTIVE_FIXED);
  await assert.rejects(
    session.setPermissionMode('bypass'),
    (err: unknown) => err instanceof PermissionModeError && err.kind === 'refused' && /permission_mode_switchable/.test(err.message),
  );
  assert.deepEqual(controller.setPermissionModeCalls, []);
  // Switching between the gated modes needs no flag and still works.
  assert.deepEqual(await session.setPermissionMode('verdandi_rules'), { permissionMode: 'default', bypassDefaultDenyApplied: false });
  void callHook(hookOf(options), 'Bash');
  const events = await session.pump();
  assert.deepEqual(events.map((e) => e.type), ['permission_mode_changed', 'permission_requested']);
  session.close();
});
