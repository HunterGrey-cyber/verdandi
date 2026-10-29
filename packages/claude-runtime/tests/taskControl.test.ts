import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, policyToBaseOptions } from '../src/session.js';
import { TaskNotFoundError } from '../src/taskOutput.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { makeFakeQuery, type FakeQueryController, type FakeQueryOptions } from './fakeQuery.js';

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled' };

function start(policy: Partial<ClaudeHostPolicy> = {}, queryOptions: FakeQueryOptions = {}) {
  const { query, controller } = makeFakeQuery(queryOptions);
  let options: Options | undefined;
  const session = createSession({ cwd: tmpdir(), policy: { ...POLICY, ...policy } }, (params) => {
    options = params.options;
    return query;
  }, { onDiagnostic: () => {} });
  return { session, controller, options: options! };
}

/** Emits the frames and pumps until the session has taken them all. */
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

const call = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const started = (taskId: string, toolUseId: string, taskType: string, runId?: string) => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: taskType, description: taskId, ...(runId ? { run_id: runId } : {}) });
const notified = (taskId: string, status: string) => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status });
const updated = (taskId: string, status: string) => ({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } });
const roster = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: task_id })) });

test('stopTask asks the CLI to stop that task, once, by its id', async () => {
  const { session, controller } = start();
  try {
    await feed(session, controller, [call('toolu_b', 'Bash'), started('b1', 'toolu_b', 'local_bash')]);
    await session.stopTask('b1');
    assert.deepEqual(controller.stopTaskCalls, ['b1']);
  } finally {
    session.close();
  }
});

test('stopTask on a workflow stops its whole run; the CLI\'s stopped notification is a NOTIFIED edge with status stopped', async () => {
  const { session, controller } = start();
  try {
    await feed(session, controller, [call('toolu_w', 'Workflow'), started('w1', 'toolu_w', 'local_workflow')]);
    await session.stopTask('w1');
    assert.deepEqual(controller.stopTaskCalls, ['w1']);
    const events = await feed(session, controller, [notified('w1', 'stopped')]);
    const edge = events.find((event) => event.type === 'task_event' && event.taskId === 'w1');
    assert.ok(edge && edge.type === 'task_event');
    assert.equal(edge.edge, 'notified');
    assert.equal(edge.status, 'stopped');
    // It has ended now: another stop answers without the CLI.
    await session.stopTask('w1');
    assert.deepEqual(controller.stopTaskCalls, ['w1']);
  } finally {
    session.close();
  }
});

test('stopTask on a task the session never saw rejects as not found and asks the CLI nothing', async () => {
  const { session, controller } = start();
  try {
    await feed(session, controller, [call('toolu_b', 'Bash'), started('b1', 'toolu_b', 'local_bash')]);
    await assert.rejects(session.stopTask('nope'), (error: unknown) => error instanceof TaskNotFoundError && error.taskId === 'nope');
    assert.deepEqual(controller.stopTaskCalls, []);
  } finally {
    session.close();
  }
});

test('stopTask on an ended task succeeds without the CLI; a new start of the id makes it stoppable again', async () => {
  const { session, controller } = start();
  try {
    await feed(session, controller, [
      call('toolu_a', 'Bash'), started('a1', 'toolu_a', 'local_bash'), notified('a1', 'completed'),
      call('toolu_k', 'Agent'), started('k1', 'toolu_k', 'local_agent'), updated('k1', 'killed'),
      call('toolu_r', 'Bash'), started('r1', 'toolu_r', 'local_bash'), notified('r1', 'running'),
    ]);
    await session.stopTask('a1');
    await session.stopTask('k1');
    assert.deepEqual(controller.stopTaskCalls, [], 'ended by a notification or by an update: nothing to stop');
    await session.stopTask('r1');
    assert.deepEqual(controller.stopTaskCalls, ['r1'], 'a running notification is an event, not an end');
    await feed(session, controller, [started('a1', 'toolu_a2', 'local_bash', 'run-2')]);
    await session.stopTask('a1');
    assert.deepEqual(controller.stopTaskCalls, ['r1', 'a1']);
  } finally {
    session.close();
  }
});

test('stopTask reaches a task the roster lists before its start', async () => {
  const { session, controller } = start();
  try {
    await feed(session, controller, [roster('early')]);
    await session.stopTask('early');
    assert.deepEqual(controller.stopTaskCalls, ['early']);
  } finally {
    session.close();
  }
});

test('stopTask reaches a new run the roster lists after the old run ended, before the new run\'s start', async () => {
  const { session, controller } = start();
  const listed = (runId: string) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'a', run_id: runId }] });
  try {
    await feed(session, controller, [
      call('toolu_a', 'Bash'), started('a', 'toolu_a', 'local_bash', 'run-1'), listed('run-1'),
      { ...notified('a', 'completed'), run_id: 'run-1' },
    ]);
    await session.stopTask('a');
    assert.deepEqual(controller.stopTaskCalls, [], 'a roster still listing the run that ended does not revive it');
    await feed(session, controller, [listed('run-2')]);
    await session.stopTask('a');
    assert.deepEqual(controller.stopTaskCalls, ['a'], 'the live second run is stopped, not reported stopped');
  } finally {
    session.close();
  }
});

test('stopTask: a CLI refusal for a task that ended on the way succeeds; any other refusal is passed on', async () => {
  let answer: (taskId: string) => Promise<void> = async () => { throw new Error('task not running'); };
  const { session, controller } = start({}, { stopTask: (taskId) => answer(taskId) });
  try {
    await feed(session, controller, [call('toolu_b', 'Bash'), started('b1', 'toolu_b', 'local_bash')]);
    await assert.rejects(session.stopTask('b1'), /task not running/, 'refused while the task still runs');
    let refuse!: (error: Error) => void;
    answer = () => new Promise<void>((_, reject) => (refuse = reject));
    const stopping = session.stopTask('b1');
    await feed(session, controller, [notified('b1', 'completed')]);
    refuse(new Error('task not running'));
    await stopping;
    assert.deepEqual(controller.stopTaskCalls, ['b1', 'b1']);
  } finally {
    session.close();
  }
});

test('stopTask after the session ended succeeds for a task it knew, without the CLI', async () => {
  const { session, controller } = start();
  await feed(session, controller, [call('toolu_b', 'Bash'), started('b1', 'toolu_b', 'local_bash')]);
  session.close();
  await session.stopTask('b1');
  assert.deepEqual(controller.stopTaskCalls, []);
  await assert.rejects(session.stopTask('nope'), TaskNotFoundError);
});

test('per_task_stop: true declares the per-task stop to the CLI; false and absent leave the option unset', () => {
  const { options: declared, session: a } = start({ perTaskStop: true });
  const { options: off, session: b } = start({ perTaskStop: false });
  const { options: absent, session: c } = start();
  for (const session of [a, b, c]) session.close();
  assert.equal(declared.perTaskStopAffordance, true);
  assert.equal('perTaskStopAffordance' in off, false);
  assert.equal('perTaskStopAffordance' in absent, false);
  // The base options say the same, so a consumer that builds its own options gets it too.
  assert.equal(policyToBaseOptions({ ...POLICY, perTaskStop: true }, '/p').perTaskStopAffordance, true);
  assert.deepEqual(policyToBaseOptions({ ...POLICY, perTaskStop: false }, '/p', { baseEnv: {} }), policyToBaseOptions(POLICY, '/p', { baseEnv: {} }));
});
