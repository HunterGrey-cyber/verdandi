import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { HookCallback, Options, SDKMessage, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { HOST_SETTLEMENT_MESSAGES } from '../src/permissionBroker.js';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { makeFakeQuery, type FakeQueryController } from './fakeQuery.js';

/**
 * With `per_task_stop` the CLI's interrupt ends only the turn and leaves background agents and
 * workflows running, so what one of them is waiting on stays open for the host. Everything the main
 * thread (or an agent the session cannot place in a running background task) is waiting on is
 * settled as before, and without `per_task_stop` everything is.
 */

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true };
const QUESTION = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };

function start(perTaskStop: boolean) {
  const { query, controller } = makeFakeQuery();
  let options: Options | undefined;
  const session = createSession(
    { cwd: tmpdir(), policy: { ...POLICY, ...(perTaskStop ? { perTaskStop: true } : {}) }, clientInteractions: { questions: true } },
    (params) => {
      options = params.options;
      return query;
    },
    { onDiagnostic: () => {} },
  );
  return { session, controller, options: options! };
}

async function feed(session: ReturnType<typeof createSession>, controller: FakeQueryController, frames: Array<Record<string, unknown>>): Promise<ClaudeRuntimeEvent[]> {
  for (const frame of frames) controller.emit(frame as unknown as SDKMessage);
  const events: ClaudeRuntimeEvent[] = [];
  for (let quiet = 0; quiet < 3; ) {
    const got = await session.pump();
    events.push(...got);
    quiet = got.length === 0 ? quiet + 1 : 0;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return events;
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true), () => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

const BACKGROUND_AGENT = [
  { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'bg', run_id: 'r1' }] },
  { type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', description: 'bg', run_id: 'r1', tool_use_id: 'toolu_agent' },
];

function bash(options: Options, toolUseId: string, agentId?: string): Promise<unknown> {
  const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: toolUseId, session_id: 's', transcript_path: '', cwd: '/p', ...(agentId === undefined ? {} : { agent_id: agentId }) };
  return hook(input as never, toolUseId, { signal: new AbortController().signal });
}

function ask(options: Options, toolUseId: string, agentId?: string) {
  return options.canUseTool!('AskUserQuestion', QUESTION, { signal: new AbortController().signal, toolUseID: toolUseId, suggestions: [], ...(agentId === undefined ? {} : { agentID: agentId }) } as never);
}

const decision = (output: unknown) => (output as SyncHookJSONOutput & { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;

test('per_task_stop: an interrupt leaves a running background agent\'s permission and question open, and settles the rest', async () => {
  const { session, controller, options } = start(true);
  try {
    await feed(session, controller, BACKGROUND_AGENT);
    const agentCall = bash(options, 'toolu_a', 'a1');
    const mainCall = bash(options, 'toolu_m');
    const foregroundCall = bash(options, 'toolu_f', 'a_foreground');
    const agentQuestion = ask(options, 'toolu_qa', 'a1');
    const mainQuestion = ask(options, 'toolu_qm');
    const requested = await feed(session, controller, []);
    await session.interrupt();

    for (const call of [mainCall, foregroundCall]) {
      assert.deepEqual(decision(await call), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
    }
    assert.deepEqual(await mainQuestion, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
    assert.equal(await settled(agentCall), false, 'the background agent\'s call still waits for the host');
    assert.equal(await settled(agentQuestion), false, 'and so does its question');

    // The host can still answer both.
    const permission = requested.find((e) => e.type === 'permission_requested' && e.toolUseId === 'toolu_a');
    assert.ok(permission && permission.type === 'permission_requested');
    assert.equal(session.resolvePermission(permission.permissionId, { allow: true }), true);
    assert.equal(decision(await agentCall)?.permissionDecision, 'allow');
    const [open] = session.interactions()!.pending();
    assert.equal(open.toolUseId, 'toolu_qa');
    session.interactions()!.resolve(open.interactionId, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [1] }] });
    assert.equal((await agentQuestion)?.behavior, 'allow');
  } finally {
    session.close();
  }
});

test('per_task_stop: what an interrupt spared is still settled when the session closes', async () => {
  const { session, controller, options } = start(true);
  await feed(session, controller, BACKGROUND_AGENT);
  const agentCall = bash(options, 'toolu_a', 'a1');
  const agentQuestion = ask(options, 'toolu_qa', 'a1');
  await feed(session, controller, []);
  await session.interrupt();
  assert.equal(await settled(agentCall), false);
  session.close();
  assert.equal(decision(await agentCall)?.permissionDecision, 'deny');
  assert.equal((await agentQuestion)?.behavior, 'deny');
});

test('without per_task_stop an interrupt settles a background agent\'s permission and question too', async () => {
  const { session, controller, options } = start(false);
  try {
    await feed(session, controller, BACKGROUND_AGENT);
    const agentCall = bash(options, 'toolu_a', 'a1');
    const agentQuestion = ask(options, 'toolu_qa', 'a1');
    await feed(session, controller, []);
    await session.interrupt();
    assert.deepEqual(decision(await agentCall), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
    assert.deepEqual(await agentQuestion, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
  } finally {
    session.close();
  }
});

test('per_task_stop: an agent whose task has ended is not spared', async () => {
  const { session, controller, options } = start(true);
  try {
    await feed(session, controller, [...BACKGROUND_AGENT, { type: 'system', subtype: 'task_notification', task_id: 'a1', run_id: 'r1', status: 'completed' }]);
    const agentCall = bash(options, 'toolu_a', 'a1');
    await feed(session, controller, []);
    await session.interrupt();
    assert.equal(decision(await agentCall)?.permissionDecision, 'deny');
  } finally {
    session.close();
  }
});
