import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BackgroundTasks } from '../src/backgroundTasks.js';
import { translateMessage } from '../src/eventTranslation.js';
import { createSession } from '../src/session.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';
import { makeFakeQuery } from './fakeQuery.js';
import { drive } from './replay/drive.js';
import { loadRecording } from './replay/recording.js';

const frame = (subtype: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'system', subtype, task_id: 'task', ...fields });
const translated = (tasks: BackgroundTasks, raw: Record<string, unknown>) => translateMessage(raw as SDKMessage, { currentTurnId: undefined, backgroundTasks: tasks });
const edge = (tasks: BackgroundTasks, subtype: string, fields: Record<string, unknown> = {}) => {
  const events = translated(tasks, frame(subtype, fields));
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'task_event');
  if (event.type !== 'task_event') throw new Error('expected task event');
  return event;
};

for (const present of [false, true]) {
  test(`all five task frames with optional fields ${present ? 'present' : 'absent'}`, () => {
    const tasks = new BackgroundTasks();
    const common = present ? { run_id: 'run', reason: 'worker_restart' } : {};
    const started = edge(tasks, 'task_started', { ...common, ...(present ? {
      task_type: 'local_agent', description: 'work', subagent_type: 'researcher', parent_task_id: 'parent', tool_use_id: 'tool', is_backgrounded: false, ambient: true,
    } : {}) });
    assert.equal(started.edge, 'started');
    assert.deepEqual(started.task, { taskId: 'task', kind: present ? 'local_agent' : 'other', taskType: present ? 'local_agent' : '', description: present ? 'work' : '', ambient: present,
      ...(present ? { runId: 'run', subagentType: 'researcher', parentTaskId: 'parent', toolUseId: 'tool' } : {}) });
    assert.equal(started.isBackgrounded, present ? false : undefined);
    const usage = { total_tokens: 12, tool_uses: 3, duration_ms: 4 };
    const progress = edge(tasks, 'task_progress', { ...common, ...(present ? { summary: 'working', last_tool_name: 'Read', usage } : {}) });
    assert.equal(progress.edge, 'progress');
    assert.equal(progress.summary, present ? 'working' : undefined);
    assert.equal(progress.lastToolName, present ? 'Read' : undefined);
    assert.deepEqual(progress.usage, present ? { totalTokens: 12, toolUses: 3, durationMs: 4 } : undefined);
    const updated = edge(tasks, 'task_updated', { ...common, ...(present ? { patch: { status: 'paused', end_time: 100, error: 'error', is_backgrounded: true } } : {}) });
    assert.equal(updated.edge, 'updated');
    assert.equal(updated.status, present ? 'paused' : undefined);
    assert.equal(updated.endTimeMs, present ? 100 : undefined);
    assert.equal(updated.error, present ? 'error' : undefined);
    assert.equal(updated.isBackgrounded, present ? true : undefined);
    const notified = edge(tasks, 'task_notification', { ...common, ...(present ? { status: 'running', summary: 'event', usage, output_file: '/tasks/task.output' } : {}) });
    assert.equal(notified.edge, 'notified');
    assert.equal(notified.status, present ? 'running' : undefined);
    assert.equal(notified.summary, present ? 'event' : undefined);
    assert.deepEqual(notified.usage, progress.usage);
    assert.equal(notified.outputFile, present ? '/tasks/task.output' : undefined);
    for (const event of [started, progress, updated, notified]) {
      assert.equal(event.runId, present ? 'run' : undefined);
      assert.equal(event.reason, present ? 'worker_restart' : undefined);
    }
    const level = translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'task', ...(present ? { task_type: 'local_agent', description: 'roster', ambient: true, run_id: 'run' } : {}) }] }));
    assert.deepEqual(level, [{ type: 'background_tasks_changed', tasks: [{ ...started.task, description: present ? 'roster' : '' }] }]);
  });
}

test('the launching tool overrides the raw type, and a level before the start is provisionally a shell', () => {
  for (const [tool, type, kind] of [['Monitor', 'local_bash', 'monitor'], ['Bash', 'local_agent', 'shell'], ['PowerShell', 'unknown', 'shell'], ['Agent', 'local_agent', 'local_agent'], ['Other', 'future_task', 'other'], ['Workflow', 'local_workflow', 'workflow']] as const) {
    const tasks = new BackgroundTasks();
    translated(tasks, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'launch', name: tool, input: {} }] } });
    const level = () => translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'task', task_type: type, description: 'work', run_id: 'run' }] }));
    assert.equal((level()[0] as Extract<ClaudeRuntimeEvent, { type: 'background_tasks_changed' }>).tasks[0].kind, 'shell');
    const started = edge(tasks, 'task_started', { task_type: type, tool_use_id: 'launch', run_id: 'run', description: 'work' });
    assert.equal(started.task?.kind, kind);
    assert.equal(started.task?.taskType, type);
    assert.equal((level()[0] as Extract<ClaudeRuntimeEvent, { type: 'background_tasks_changed' }>).tasks[0].kind, kind);
    assert.equal(tasks.cause({ taskId: 'task' }).taskKind, kind);
    const newRun = translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'task', run_id: 'later' }] }));
    assert.equal((newRun[0] as Extract<ClaudeRuntimeEvent, { type: 'background_tasks_changed' }>).tasks[0].kind, 'shell');
  }
});

test('malformed optional scalars and roster entries are dropped with one counted diagnostic per frame', () => {
  const tasks = new BackgroundTasks();
  const log: string[] = [];
  const translate = (raw: Record<string, unknown>) => tasks.translate(raw, line => log.push(line));
  const events = translate(frame('task_progress', { run_id: 1, reason: {}, summary: false, last_tool_name: [], usage: { total_tokens: '12', tool_uses: 1, duration_ms: 2 }, workflow_progress: [{ promptPreview: 'secret' }] }));
  assert.deepEqual(log, ['dropped 5 malformed background task entries']);
  assert.equal(events?.[0].type, 'task_event');
  assert.equal(JSON.stringify(events).includes('secret'), false);
  log.length = 0;
  assert.deepEqual(translate(frame('background_tasks_changed', { tasks: [null, {}, { task_id: 'valid', task_type: 5, description: 6, ambient: 'yes', run_id: [] }] })), [
    { type: 'background_tasks_changed', tasks: [{ taskId: 'valid', kind: 'shell', taskType: '', description: '', ambient: false }] },
  ]);
  assert.deepEqual(log, ['dropped 6 malformed background task entries']);
  log.length = 0;
  const updated = translate(frame('task_updated', { patch: { status: 'future', end_time: NaN, error: [], is_backgrounded: 'yes' } }));
  assert.deepEqual(log, ['dropped 4 malformed background task entries']);
  assert.equal((updated?.[0] as { status?: string }).status, undefined);
  for (const subtype of ['task_started', 'task_progress', 'task_updated', 'task_notification']) {
    assert.deepEqual(translate(frame(subtype, { task_id: null })), []);
  }
});

test('each new query starts with an empty roster, including a resumed query after the previous query ended', async () => {
  for (const resume of [undefined, { providerSessionId: 'previous-provider-session' }]) {
    const { query, controller } = makeFakeQuery();
    const session = createSession({ cwd: tmpdir(), policy: { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'sdk_bundled' }, ...(resume ? { resume } : {}) }, () => query);
    try {
      assert.deepEqual(await session.pump(), [{ type: 'background_tasks_changed', tasks: [] }]);
      assert.deepEqual(await session.pump(), []);
      controller.emit(frame('background_tasks_changed', { tasks: [{ task_id: 'old', task_type: 'local_bash', description: 'work' }] }) as SDKMessage);
      const changed = [...await session.pump(), ...await session.pump()];
      assert.ok(changed.some(e => e.type === 'background_tasks_changed' && e.tasks.length === 1));
      controller.end();
      await session.pump();
    } finally { session.close(); }
  }
});

// Import the built sidecar only at runtime: its build follows the kernel build, and this test
// exercises the real wire boundary without making the kernel depend on the sidecar's source.
async function wireEncoder() {
  const { translateEvent } = await import(new URL('../../../../apps/claude-sidecar/dist/src/eventTranslation.js', import.meta.url).href);
  const { SessionEvent } = await import(new URL('../../../../apps/claude-sidecar/dist/src/generated/verdandi/claude/runtime/v1/runtime.js', import.meta.url).href);
  return (event: ClaudeRuntimeEvent) => {
    const bytes: Uint8Array = SessionEvent.encode(SessionEvent.fromPartial(translateEvent(event))).finish();
    return { bytes, decoded: SessionEvent.decode(bytes) };
  };
}

test('encoded task frames exclude prompts and previews, and bound every task string on a character boundary', async () => {
  const encode = await wireEncoder();
  const tasks = new BackgroundTasks();
  const marker = 'PRIVATE_WORKFLOW_SCRIPT_NEVER_ON_WIRE';
  const long = '😀'.repeat(2100);
  const started = edge(tasks, 'task_started', { task_id: long, run_id: long, reason: long, task_type: long, description: long, tool_use_id: long, subagent_type: long, parent_task_id: long, prompt: marker });
  const decoded = encode(started).decoded.taskEvent;
  const bounded = (value: string, max: number) => assert.equal(value, '😀'.repeat(max - 1) + '…');
  bounded(decoded.taskId, 128);
  bounded(decoded.runId, 128);
  bounded(decoded.reason, 2000);
  for (const key of ['taskId', 'runId', 'subagentType', 'parentTaskId', 'toolUseId']) bounded(decoded.task[key], 128);
  bounded(decoded.task.description, 500);
  bounded(decoded.task.taskType, 64);
  const progress = edge(tasks, 'task_progress', { summary: long, last_tool_name: long, workflow_progress: [{ promptPreview: marker, resultPreview: marker }], workflow_log: marker });
  bounded(encode(progress).decoded.taskEvent.summary, 2000);
  bounded(encode(progress).decoded.taskEvent.lastToolName, 64);
  const updated = edge(tasks, 'task_updated', { patch: { error: long } });
  bounded(encode(updated).decoded.taskEvent.error, 2000);
  const notified = edge(tasks, 'task_notification', { summary: long, output_file: long });
  bounded(encode(notified).decoded.taskEvent.outputFile, 1024);
  const level = translated(tasks, frame('background_tasks_changed', { tasks: Array.from({ length: 257 }, () => ({ task_id: long, task_type: long, description: long, run_id: long, prompt: marker })) }))[0];
  assert.equal(encode(level).decoded.backgroundTasksChanged.tasks.length, 256);
  for (const event of [started, progress, updated, notified, level]) {
    assert.equal(Buffer.from(encode(event).bytes).includes(Buffer.from(marker)), false);
    assert.equal(JSON.stringify(event).includes(marker), false);
  }
});

for (const [name, kind] of [['c01', 'shell'], ['c01c', 'shell'], ['c02b', 'monitor'], ['c03_bg', 'local_agent']] as const) {
  test(`background replay ${name}: roster, edges and TASK causes use the joined ${kind} kind`, async () => {
    const recording = loadRecording(name);
    try {
      const replay = await drive(recording.messages, recording.directory);
      const starts = replay.events.filter(e => e.type === 'task_event' && e.edge === 'started');
      assert.ok(starts.length > 0);
      assert.ok(starts.every(e => e.type === 'task_event' && e.task?.kind === kind));
      const taskSteps = replay.steps.filter(s => s.line.message.type === 'system' && ['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(s.line.message.subtype));
      assert.ok(taskSteps.every(s => s.events.length === 1 && ['task_event', 'background_tasks_changed'].includes(s.events[0].type)));
      assert.ok(replay.events.some(e => e.type === 'background_tasks_changed' && e.tasks.length > 0));
      const joined = new Map<string, string>();
      for (const event of replay.events) {
        if (event.type === 'task_event' && event.edge === 'started') joined.set(event.taskId, kind);
        if (event.type === 'background_tasks_changed') {
          for (const task of event.tasks) assert.equal(task.kind, joined.get(task.taskId) ?? 'shell');
        }
      }
      const causes = replay.events.flatMap(e => e.type === 'turn_started' && e.cause?.kind === 'task' ? [e.cause] : []);
      // Coalesced notifications in this recording produce only an empty placeholder result.
      if (name === 'c01c') assert.deepEqual(causes, []);
      else assert.ok(causes.length > 0);
      assert.ok(causes.every(c => c.taskKind === kind));
    } finally { recording.cleanup(); }
  });
}

test('a task seen again is the newest in the identity cache, so a long-lived one outlasts older ones', () => {
  const tasks = new BackgroundTasks();
  tasks.tool('tool-old', 'Monitor');
  const start = (taskId: string, extra: Record<string, unknown> = {}) => translated(tasks, { type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_bash', ...extra });
  start('old', { tool_use_id: 'tool-old' });
  for (let i = 0; i < 255; i += 1) start(`filler-${i}`, { task_type: 'local_agent' });
  start('old', { tool_use_id: 'tool-old' });
  start('one-more');
  const level = translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'old' }, { task_id: 'filler-0' }] }))[0];
  assert.equal(level.type, 'background_tasks_changed');
  if (level.type !== 'background_tasks_changed') return;
  assert.equal(level.tasks[0].kind, 'monitor', 'the refreshed task kept its launching call');
  assert.equal(level.tasks[1].kind, 'shell', 'the entry seen longest ago was the one evicted, so nothing is joined for it');
});

test('a running workflow keeps its identity while 256 shorter tasks start and end around it', () => {
  const tasks = new BackgroundTasks();
  const roster = (...ids: string[]) => translated(tasks, frame('background_tasks_changed', { tasks: ids.map(task_id => ({ task_id })) }))[0];
  translated(tasks, { type: 'system', subtype: 'task_started', task_id: 'wf', task_type: 'local_workflow', run_id: 'run' });
  roster('wf');
  for (let i = 0; i < 256; i += 1) {
    const id = `shell-${i}`;
    translated(tasks, { type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash' });
    roster('wf', id);
    translated(tasks, { type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
    roster('wf');
  }
  const level = roster('wf');
  assert.equal(level.type, 'background_tasks_changed');
  if (level.type !== 'background_tasks_changed') return;
  assert.equal(level.tasks[0].kind, 'workflow', 'the live workflow outlasts the ended shells');
  const progress = edge(tasks, 'task_progress', { task_id: 'wf', run_id: 'run', workflow_progress: [{ type: 'workflow_phase', index: 0, title: 'one' }] });
  assert.ok(progress.workflowProgress !== undefined, 'its progress is still read as a workflow\'s');
  assert.deepEqual(tasks.control('shell-0'), { kind: 'other', ended: true }, 'the ended shell seen longest ago was dropped instead, so only its ending is remembered');
  assert.deepEqual(tasks.control('shell-255'), { kind: 'shell', ended: true });
});

test('a roster listing a newer run of a task drops the earlier run\'s output file; one listing the same run keeps it', () => {
  const tasks = new BackgroundTasks();
  tasks.tool('launch', 'Bash');
  edge(tasks, 'task_started', { task_type: 'local_bash', tool_use_id: 'launch', run_id: 'r1', description: 'work' });
  edge(tasks, 'task_notification', { run_id: 'r1', status: 'completed', output_file: '/t/tasks/task.output' });
  assert.equal(tasks.outputPath('task'), '/t/tasks/task.output');
  translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'task', task_type: 'local_bash', run_id: 'r1' }] }));
  assert.equal(tasks.outputPath('task'), '/t/tasks/task.output', 'the same run: its file is still its output');
  translated(tasks, frame('background_tasks_changed', { tasks: [{ task_id: 'task', task_type: 'local_bash', run_id: 'r2' }] }));
  assert.deepEqual(tasks.control('task'), { kind: 'shell', ended: false });
  assert.equal(tasks.outputPath('task'), undefined, 'r1\'s file is not r2\'s output');
});

test('runsInBackground: a listed, running agent; an agent a running workflow named; nothing else', () => {
  const tasks = new BackgroundTasks();
  const roster = (...entries: Array<Record<string, unknown>>) => translated(tasks, frame('background_tasks_changed', { tasks: entries }));
  roster({ task_id: 'a1', task_type: 'local_agent', run_id: 'ra' }, { task_id: 'wf', task_type: 'local_workflow', run_id: 'rw' });
  translated(tasks, frame('task_started', { task_id: 'a1', task_type: 'local_agent', run_id: 'ra' }));
  translated(tasks, frame('task_started', { task_id: 'wf', task_type: 'local_workflow', run_id: 'rw' }));
  assert.equal(tasks.runsInBackground('a1'), true);
  assert.equal(tasks.runsInBackground('aw'), false, 'not yet named by the workflow');
  translated(tasks, frame('task_progress', {
    task_id: 'wf', run_id: 'rw',
    workflow_progress: [{ type: 'workflow_agent', agentId: 'aw', index: 1, label: 'x', phaseIndex: 1, state: 'progress' }],
  }));
  assert.equal(tasks.runsInBackground('aw'), true);
  assert.equal(tasks.runsInBackground('foreground'), false, 'an agent the roster never listed');
  translated(tasks, frame('task_notification', { task_id: 'a1', run_id: 'ra', status: 'completed' }));
  assert.equal(tasks.runsInBackground('a1'), false, 'ended, even while still listed');
  roster();
  assert.equal(tasks.runsInBackground('aw'), false, 'its workflow is no longer listed');
});
