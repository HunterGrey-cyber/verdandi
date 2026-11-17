import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClientInteractions } from '../src/types.js';

/**
 * While the CLI is in plan mode, a plan session does not pass a host `allow` on for a call that changes
 * files or runs a command: the hook makes no decision, the CLI's own plan mode decides (CLI 2.1.311:
 * its plan file is written, a write elsewhere is asked through `canUseTool`), and a notice says so.
 */

const AUTO: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true, cliPermissionMode: 'auto' };
const PLAN: ClientInteractions = { questions: false, planMode: true };

const status = (permissionMode: string) => ({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: 'u', session_id: 'c1' }) as unknown as SDKMessage;

function setup(clientInteractions: ClientInteractions | undefined = PLAN) {
  let options: Options | undefined;
  const { query, controller } = makeFakeQuery();
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return query;
  };
  const session = createSession({ cwd: '/w', policy: AUTO, ...(clientInteractions === undefined ? {} : { clientInteractions }) }, queryFn, { onDiagnostic: () => {} });
  const feed = async (...frames: SDKMessage[]): Promise<ClaudeRuntimeEvent[]> => {
    for (const frame of frames) controller.emit(frame);
    const out: ClaudeRuntimeEvent[] = [];
    for (let quiet = 0; quiet < 3; ) {
      const events = await session.pump();
      out.push(...events);
      quiet = events.length === 0 ? quiet + 1 : 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return out;
  };
  const hook = options!.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  return { session, feed, hook };
}

/** Calls the hook for `toolName`, answers its permission request with `allow`, and returns the hook's
 * output with every event the session produced on the way. */
async function allowThrough(
  ctx: ReturnType<typeof setup>,
  toolName: string,
  extra: { permissionMode?: string; agentId?: string } = {},
): Promise<{ output: unknown; events: ClaudeRuntimeEvent[] }> {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: '/w/src/x.txt', content: 'x' },
    tool_use_id: 'toolu_w',
    session_id: 's',
    transcript_path: '',
    cwd: '/w',
    ...(extra.permissionMode === undefined ? {} : { permission_mode: extra.permissionMode }),
    ...(extra.agentId === undefined ? {} : { agent_id: extra.agentId }),
  } as never;
  const pending = ctx.hook(input, 'toolu_w', { signal: new AbortController().signal });
  const events = await ctx.session.pump();
  const requested = events.find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested', `${toolName}: the gate asks the host`);
  assert.equal(ctx.session.resolvePermission(requested.permissionId, { allow: true, reason: 'host allowed' }), true);
  const output = await pending;
  events.push(...(await ctx.session.pump()));
  return { output, events };
}

const notices = (events: ClaudeRuntimeEvent[]) =>
  events.filter((e) => e.type === 'provider_notice' && (e.subtype === 'plan_allow_deferred' || e.subtype === 'plan_allow_asked'));
const decision = (output: unknown) => (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

test('in plan a host allow for Write becomes an abstention with a notice', async () => {
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    const ctx = setup();
    await ctx.feed(status('plan'));
    const { output, events } = await allowThrough(ctx, tool, { permissionMode: 'plan' });
    assert.deepEqual(output, {}, `${tool}: no decision, the CLI's plan mode decides`);
    assert.deepEqual(notices(events), [{ type: 'provider_notice', kind: 'verdandi_policy', subtype: 'plan_allow_deferred', raw: { toolName: tool } }]);
    // The host's answer is still recorded as the answer it was.
    assert.deepEqual(events.filter((e) => e.type === 'permission_resolved').map((e) => e.type === 'permission_resolved' && e.outcome), ['allowed']);
    ctx.session.close();
  }
});

test('in plan a host allow for Bash becomes an ask with a notice', async () => {
  // Left to the CLI, a command that is not read-only would go to its auto-mode classifier and could run
  // with nobody asked; a hook ask sends it to the CLI's permission prompt, which reaches canUseTool.
  const ctx = setup();
  await ctx.feed(status('plan'));
  const { output, events } = await allowThrough(ctx, 'Bash', { permissionMode: 'plan' });
  assert.equal(decision(output), 'ask');
  assert.match((output as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason, /plan mode/);
  assert.deepEqual(notices(events), [{ type: 'provider_notice', kind: 'verdandi_policy', subtype: 'plan_allow_asked', raw: { toolName: 'Bash' } }]);
  ctx.session.close();
});

test('in plan a host defer for Bash becomes an ask too, and a defer for Write stays no decision', async () => {
  for (const [tool, expected] of [
    ['Bash', 'ask'],
    ['Write', undefined],
  ] as const) {
    const ctx = setup();
    await ctx.feed(status('plan'));
    const pending = ctx.hook(
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: 'toolu_d', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'plan' } as never,
      'toolu_d',
      { signal: new AbortController().signal },
    );
    const requested = (await ctx.session.pump()).find((e) => e.type === 'permission_requested');
    assert.ok(requested !== undefined && requested.type === 'permission_requested');
    ctx.session.resolvePermission(requested.permissionId, { allow: false, defer: true });
    assert.equal(decision(await pending), expected, tool);
    const said = (await ctx.session.pump()).filter((e) => e.type === 'provider_notice' && e.kind === 'verdandi_policy');
    assert.deepEqual(said.map((e) => e.type === 'provider_notice' && e.subtype), tool === 'Bash' ? ['plan_defer_asked'] : [], tool);
    ctx.session.close();
  }
});

test('an older status frame read after a fresher hook cannot clear plan', async () => {
  // The CLI was in plan, left it (status auto, still unread), and is in plan again: a later hook call
  // says plan. A Write raised while it said auto waits for the host; the pump then reads the old auto.
  const ctx = setup();
  await ctx.feed(status('plan'));
  const hookCall = (tool: string, id: string, permissionMode: string) =>
    ctx.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/w', permission_mode: permissionMode } as never, id, {
      signal: new AbortController().signal,
    });
  const write = hookCall('Write', 'toolu_w', 'auto');
  const enter = hookCall('EnterPlanMode', 'toolu_e', 'plan');
  assert.deepEqual(await enter, {});
  // The stale auto is read only now, after the hook that said plan.
  const events = await ctx.feed(status('auto'));
  const requested = events.find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested');
  ctx.session.resolvePermission(requested.permissionId, { allow: true });
  assert.deepEqual(await write, {}, 'the allow is not sent while the freshest account says plan');
  ctx.session.close();
});

test('a stale report cannot retire a newer acknowledged enter: the allow is withheld', async () => {
  // Enter, leave, enter acknowledged; the first two frames read, the last plan frame not. The hook says
  // auto, so only the pending acknowledgement can hold the allow.
  for (const [tool, expected] of [
    ['Write', {}],
    ['Edit', {}],
    ['NotebookEdit', {}],
    ['Bash', 'ask'],
  ] as const) {
    const ctx = setup();
    await ctx.session.setPlanning(true);
    await ctx.session.setPlanning(false);
    await ctx.session.setPlanning(true);
    await ctx.feed(status('plan'), status('auto'));
    const { output } = await allowThrough(ctx, tool, { permissionMode: 'auto' });
    if (expected === 'ask') assert.equal(decision(output), 'ask', tool);
    else assert.deepEqual(output, expected, tool);
    ctx.session.close();
  }
});

test('out of order: a plan acknowledgement stays pending past a non-matching frame, and the queue drains in order', async () => {
  const ctx = setup();
  await ctx.session.setPlanning(true);
  await ctx.session.setPlanning(false);
  // A frame from before the switches: it matches neither the oldest acknowledgement nor retires one.
  await ctx.feed(status('auto'));
  assert.deepEqual((await allowThrough(ctx, 'Write', { permissionMode: 'auto' })).output, {}, 'the enter is not yet reported');
  // Both reports read in order: nothing pending, every account says auto.
  await ctx.feed(status('plan'), status('auto'));
  assert.equal(decision((await allowThrough(ctx, 'Write', { permissionMode: 'auto' })).output), 'allow');
  ctx.session.close();
});

/** Calls the hook with any `permission_mode` (or none), answers allow, and returns the hook's output. */
async function allowWithMode(ctx: ReturnType<typeof setup>, tool: string, id: string, mode: unknown, omit = false): Promise<unknown> {
  const pending = ctx.hook(
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/w', ...(omit ? {} : { permission_mode: mode }) } as never,
    id,
    { signal: new AbortController().signal },
  );
  const requested = (await ctx.session.pump()).find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested', `${tool}: the gate asks`);
  ctx.session.resolvePermission(requested.permissionId, { allow: true });
  return pending;
}

/** The model's own EnterPlanMode as its hook shows it: the CLI is still in auto as it makes the call. */
async function modelEnters(ctx: ReturnType<typeof setup>): Promise<void> {
  const output = await ctx.hook(
    { hook_event_name: 'PreToolUse', tool_name: 'EnterPlanMode', tool_input: {}, tool_use_id: 'toolu_enter', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'auto' } as never,
    'toolu_enter',
    { signal: new AbortController().signal },
  );
  assert.deepEqual(output, {}, 'the plan tool itself is left to the CLI');
}

const WITHHELD = { Write: 'abstain', Edit: 'abstain', NotebookEdit: 'abstain', Bash: 'ask' } as const;
const verdict = (output: unknown) => (decision(output) === undefined && JSON.stringify(output) === '{}' ? 'abstain' : decision(output));

test('after the model enters plan, a hook with no mode or an unknown mode withholds the allow', async () => {
  for (const [label, mode, omit] of [
    ['missing', undefined, true],
    ['unknown', 'planning-v2', false],
    ['empty', '', false],
    ['not a string', 7, false],
  ] as const) {
    for (const [tool, expected] of Object.entries(WITHHELD)) {
      const ctx = setup();
      await modelEnters(ctx);
      // The status frame saying plan has not been read.
      assert.equal(verdict(await allowWithMode(ctx, tool, `toolu_${tool}`, mode, omit)), expected, `${label}: ${tool}`);
      ctx.session.close();
    }
  }
});

test('a hook with no mode withholds the allow on a plan session even with no plan evidence at all', async () => {
  for (const [tool, expected] of Object.entries(WITHHELD)) {
    const ctx = setup();
    assert.equal(verdict(await allowWithMode(ctx, tool, `toolu_${tool}`, undefined, true)), expected, tool);
    assert.equal(verdict(await allowWithMode(ctx, tool, `toolu_${tool}2`, 'whatever', false)), expected, `${tool}, unknown mode`);
    ctx.session.close();
  }
});

test('after the model enters plan, a later hook that says auto is believed; a call raised before the entry is withheld', async () => {
  for (const [tool, expected] of Object.entries(WITHHELD)) {
    // Raised after the entry with an explicit auto: the CLI's own word, fresher than the entry.
    const after = setup();
    await modelEnters(after);
    assert.equal(verdict(await allowWithMode(after, tool, `toolu_${tool}`, 'auto')), 'allow', `${tool}: raised after`);
    after.session.close();
    // Raised in auto before the entry, answered after it: the entry may have happened since.
    const before = setup();
    const pending = before.hook(
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: 'toolu_b', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'auto' } as never,
      'toolu_b',
      { signal: new AbortController().signal },
    );
    await modelEnters(before);
    const requested = (await before.session.pump()).find((e) => e.type === 'permission_requested');
    assert.ok(requested !== undefined && requested.type === 'permission_requested');
    before.session.resolvePermission(requested.permissionId, { allow: true });
    assert.equal(verdict(await pending), expected, `${tool}: raised before`);
    before.session.close();
  }
});

test('the model\'s entry stays evidence until a hook names a mode, and the notices still say why', async () => {
  const ctx = setup();
  await modelEnters(ctx);
  // A subagent's hook with no mode does not count against the main thread, but the entry still holds.
  const pending = ctx.hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'toolu_s', session_id: 's', transcript_path: '', cwd: '/w', agent_id: 'agent-1' } as never,
    'toolu_s',
    { signal: new AbortController().signal },
  );
  const events = await ctx.session.pump();
  const requested = events.find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested');
  ctx.session.resolvePermission(requested.permissionId, { allow: true });
  assert.deepEqual(await pending, {});
  assert.deepEqual(notices(await ctx.session.pump()).map((e) => e.type === 'provider_notice' && e.subtype), ['plan_allow_deferred']);
  ctx.session.close();
});

test('a session without plan mode is untouched by missing or unknown hook modes and by EnterPlanMode', async () => {
  for (const clientInteractions of [{ questions: false }, { questions: true }]) {
    for (const tool of Object.keys(WITHHELD)) {
      const ctx = setup(clientInteractions);
      // Its gate asks the host about EnterPlanMode like any tool; deny it so nothing waits.
      const enter = ctx.hook(
        { hook_event_name: 'PreToolUse', tool_name: 'EnterPlanMode', tool_input: {}, tool_use_id: 'toolu_enter', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'auto' } as never,
        'toolu_enter',
        { signal: new AbortController().signal },
      );
      const asked = (await ctx.session.pump()).find((e) => e.type === 'permission_requested');
      assert.ok(asked !== undefined && asked.type === 'permission_requested');
      ctx.session.resolvePermission(asked.permissionId, { allow: false });
      await enter;
      assert.equal(verdict(await allowWithMode(ctx, tool, `toolu_${tool}`, undefined, true)), 'allow', `${tool}, missing`);
      assert.equal(verdict(await allowWithMode(ctx, tool, `toolu_${tool}2`, 'planning-v2')), 'allow', `${tool}, unknown`);
      assert.deepEqual(notices(await ctx.session.pump()), []);
      ctx.session.close();
    }
  }
});

test('plan seen while a call waited defers its allow', async () => {
  // A Write raised in auto; while it waits, a hook says plan, then another says auto again. Unsure which
  // mode the CLI acts on the allow in, the allow is not sent.
  const ctx = setup();
  const hookCall = (tool: string, id: string, permissionMode: string) =>
    ctx.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/w', permission_mode: permissionMode } as never, id, {
      signal: new AbortController().signal,
    });
  const write = hookCall('Write', 'toolu_w', 'auto');
  assert.deepEqual(await hookCall('EnterPlanMode', 'toolu_e', 'plan'), {});
  assert.deepEqual(await hookCall('ExitPlanMode', 'toolu_x', 'auto'), {});
  const requested = (await ctx.session.pump()).find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested');
  ctx.session.resolvePermission(requested.permissionId, { allow: true });
  assert.deepEqual(await write, {});
  ctx.session.close();
});

test('changing the caller\'s config after creation does not turn the guard off', async () => {
  const clientInteractions: ClientInteractions = { questions: false, planMode: true };
  const policy: ClaudeHostPolicy = { ...AUTO };
  let options: Options | undefined;
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/w', policy, clientInteractions }, ((params) => {
    options = params.options;
    return query;
  }) as QueryFn, { onDiagnostic: () => {} });
  clientInteractions.planMode = false;
  policy.cliPermissionMode = undefined;
  policy.providerPermissionPrompts = false;
  controller.emit(status('plan'));
  for (let i = 0; i < 3; i += 1) await session.pump();
  const hook = options!.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  const write = hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'toolu_w', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'plan' } as never, 'toolu_w', { signal: new AbortController().signal });
  const requested = (await session.pump()).find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested');
  session.resolvePermission(requested.permissionId, { allow: true });
  assert.deepEqual(await write, {});
  // The plan tools are still left to the plan path: the gate makes no decision at once (were it to ask
  // the host, the abort below would end the call with a denial).
  const abort = new AbortController();
  const exit = hook({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_use_id: 'toolu_x', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'plan' } as never, 'toolu_x', { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.deepEqual(await exit, {});
  session.close();
});

test('in plan by either account: the status frame read, or the call\'s own hook', async () => {
  // Only the status frame says plan (the hook says auto).
  const byStatus = setup();
  await byStatus.feed(status('plan'));
  assert.deepEqual((await allowThrough(byStatus, 'Write', { permissionMode: 'auto' })).output, {});
  byStatus.session.close();
  // Only the hook says plan: the status frame has not been read yet.
  const byHook = setup();
  const { output, events } = await allowThrough(byHook, 'Write', { permissionMode: 'plan' });
  assert.deepEqual(output, {});
  assert.equal(notices(events).length, 1);
  byHook.session.close();
});

test('outside plan the same allow is sent', async () => {
  // A plan session in its creation mode, one that has left plan, and a session without plan mode.
  const fresh = setup();
  const leftPlan = setup();
  await leftPlan.feed(status('plan'), status('auto'));
  const unopted = setup({ questions: false });
  await unopted.feed(status('plan'));
  for (const [name, ctx] of [
    ['fresh', fresh],
    ['left plan', leftPlan],
    ['no plan mode', unopted],
  ] as const) {
    const { output, events } = await allowThrough(ctx, 'Write', { permissionMode: name === 'no plan mode' ? 'plan' : 'auto' });
    assert.equal(decision(output), 'allow', name);
    assert.deepEqual(notices(events), [], name);
    ctx.session.close();
  }
  // A subagent's hook reporting plan holds its own call, but does not speak for the session: the next
  // main-thread call, whose hook says auto, is allowed.
  const sub = setup();
  assert.deepEqual((await allowThrough(sub, 'Write', { permissionMode: 'plan', agentId: 'agent-1' })).output, {});
  assert.equal(decision((await allowThrough(sub, 'Write', { permissionMode: 'auto' })).output), 'allow');
  sub.session.close();
});

test('Read in plan is not touched', async () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    const ctx = setup();
    await ctx.feed(status('plan'));
    const { output, events } = await allowThrough(ctx, tool, { permissionMode: 'plan' });
    assert.equal(decision(output), 'allow', tool);
    assert.deepEqual(notices(events), [], tool);
    ctx.session.close();
  }
});

test('in plan a host deny is sent as a deny', async () => {
  const ctx = setup();
  await ctx.feed(status('plan'));
  const pending = ctx.hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'toolu_w', session_id: 's', transcript_path: '', cwd: '/w', permission_mode: 'plan' } as never,
    'toolu_w',
    { signal: new AbortController().signal },
  );
  const requested = (await ctx.session.pump()).find((e) => e.type === 'permission_requested');
  assert.ok(requested !== undefined && requested.type === 'permission_requested');
  ctx.session.resolvePermission(requested.permissionId, { allow: false, reason: 'no' });
  assert.equal(decision(await pending), 'deny');
  assert.deepEqual(notices(await ctx.session.pump()), []);
  ctx.session.close();
});
