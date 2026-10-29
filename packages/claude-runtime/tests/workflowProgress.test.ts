import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTasks } from '../src/backgroundTasks.js';
import { parseWorkflowProgress } from '../src/workflowProgress.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';
import { drive } from './replay/drive.js';
import { fixtureRoot, loadRecording } from './replay/recording.js';

const phase = { type: 'workflow_phase', index: 0, title: 'Plan', kind: 'sequential' };
const agent = { type: 'workflow_agent', index: 0, label: 'worker', phaseIndex: 0, state: 'running', model: 'model', agentType: 'researcher', tokens: 0, toolCalls: 0, durationMs: 0, error: '' };
const frame = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, task_id: 'workflow', ...fields });
const start = (tasks: BackgroundTasks, fields: Record<string, unknown> = {}) => tasks.translate(frame('task_started', { task_type: 'local_workflow', ...fields }))!;
const progress = (tasks: BackgroundTasks, fields: Record<string, unknown> = {}, log: string[] = []) => {
  const events = tasks.translate(frame('task_progress', fields), line => log.push(line))!;
  assert.equal(events.length, 1);
  const event = events[0];
  if (event.type !== 'task_event') throw new Error('expected task event');
  return event;
};

for (const [sample, fields, collection] of [
  [phase, ['index', 'title', 'kind'], 'phases'],
  [agent, ['index', 'label', 'phaseIndex', 'state', 'model', 'agentType', 'tokens', 'toolCalls', 'durationMs', 'error'], 'agents'],
] as const) {
  for (const field of fields) {
    for (const variant of ['valid', 'wrong type', 'absent'] as const) {
      test(`${collection}.${field}: ${variant}`, () => {
        const entry: Record<string, unknown> = { ...sample };
        if (variant === 'wrong type') entry[field] = typeof entry[field] === 'number' ? '0' : 0;
        if (variant === 'absent') delete entry[field];
        const required = collection === 'phases' ? ['index', 'title'] : ['index', 'label', 'phaseIndex', 'state'];
        const dropped = variant === 'wrong type' || variant === 'absent' && required.includes(field);
        const parsed = parseWorkflowProgress([entry]);
        assert.equal(parsed.dropped, dropped ? 1 : 0);
        const entries = parsed.progress![collection];
        assert.equal(entries.length, dropped ? 0 : 1);
        if (!dropped) {
          const output = entries[0] as unknown as Record<string, unknown>;
          if (variant === 'absent') {
            if (field === 'kind') assert.equal(output[field], '');
            else assert.equal(Object.hasOwn(output, field), false);
          } else assert.equal(output[field], entry[field]);
        }
      });
    }
  }
}

test('recorded camelCase entries preserve all declared scalars and omit optional fields', () => {
  const parsed = parseWorkflowProgress([
    { type: 'workflow_phase', index: 1, title: 'one' },
    { type: 'workflow_agent', index: 1, label: 'worker', phaseIndex: 1, state: 'done', agentType: 'worker', model: 'model', tokens: 4, toolCalls: 2, durationMs: 12, error: 'failure' },
    { type: 'workflow_agent', index: 2, label: 'next', phaseIndex: 1, state: 'start' },
  ]);
  assert.deepEqual(parsed, { dropped: 0, progress: {
    phases: [{ index: 1, title: 'one', kind: '' }],
    agents: [
      { index: 1, label: 'worker', phaseIndex: 1, state: 'done', agentType: 'worker', model: 'model', tokens: 4, toolCalls: 2, durationMs: 12, error: 'failure' },
      { index: 2, label: 'next', phaseIndex: 1, state: 'start' },
    ],
  } });
  for (const field of ['index', 'label', 'phaseIndex', 'state', 'agentType', 'model', 'tokens', 'toolCalls', 'durationMs', 'error']) {
    const entry = { ...agent, type: 'workflow_agent', phaseIndex: 0, agentType: 'worker', toolCalls: 0, durationMs: 0, [field]: null };
    assert.equal(parseWorkflowProgress([entry]).dropped, 1, field);
  }
});

test('entry shapes other than the CLI\'s own are dropped', () => {
  const parsed = parseWorkflowProgress([{ type: 'phase', index: 0, title: 'Plan' }, { type: 'agent', index: 0, label: 'worker', phase_index: 0, state: 'running' }]);
  assert.deepEqual(parsed, { dropped: 2, progress: { phases: [], agents: [] } });
});

test('indices and counters reject negative, fractional, nonfinite and out-of-range numbers', () => {
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseWorkflowProgress([{ ...phase, index: value }]).dropped, 1);
    for (const field of ['index', 'phaseIndex', 'tokens', 'toolCalls', 'durationMs']) {
      assert.equal(parseWorkflowProgress([{ ...agent, [field]: value }]).dropped, 1);
    }
  }
  assert.equal(parseWorkflowProgress([{ ...phase, index: 2 ** 32 }]).dropped, 1);
  assert.equal(parseWorkflowProgress([{ ...agent, toolCalls: 2 ** 32 }]).dropped, 1);
});

test('65 phases and 257 agents are capped independently at 64 and 256', () => {
  const parsed = parseWorkflowProgress([
    ...Array.from({ length: 65 }, (_, index) => ({ ...phase, index })),
    ...Array.from({ length: 257 }, (_, index) => ({ ...agent, index })),
  ]);
  assert.equal(parsed.progress?.phases.length, 64);
  assert.equal(parsed.progress?.agents.length, 256);
  assert.equal(parsed.progress?.phases.at(-1)?.index, 63);
  assert.equal(parsed.progress?.agents.at(-1)?.index, 255);
  assert.equal(parsed.dropped, 0);
});

test('malformed entries are dropped together in one counted frame diagnostic; other fields survive', () => {
  const tasks = new BackgroundTasks();
  start(tasks);
  const log: string[] = [];
  const event = progress(tasks, { summary: 'working', reason: false, workflow_progress: [null, {}, { ...phase, title: false }, { ...agent, model: [] }, phase, agent] }, log);
  assert.deepEqual(log, ['dropped 5 malformed background task entries']);
  assert.equal(event.summary, 'working');
  assert.equal(event.workflowProgress?.phases.length, 1);
  assert.equal(event.workflowProgress?.agents.length, 1);
  for (const value of [null, {}, 'progress', 1]) {
    const log: string[] = [];
    const event = progress(tasks, { summary: 'kept', workflow_progress: value }, log);
    assert.equal(event.summary, 'kept');
    assert.equal(event.workflowProgress, undefined);
    assert.deepEqual(log, ['dropped 1 malformed background task entries']);
  }
});

test('only workflow progress edges carry progress; an absent field leaves the event unchanged', () => {
  for (const taskType of ['local_workflow', 'local_agent', 'local_bash', 'future']) {
    const tasks = new BackgroundTasks();
    start(tasks, { task_type: taskType, run_id: 'run' });
    const baseline = progress(tasks, { run_id: 'run', summary: 'kept' });
    assert.equal(Object.hasOwn(baseline, 'workflowProgress'), false);
    assert.deepEqual(progress(tasks, { run_id: 'run', summary: 'kept', workflow_progress: undefined }), baseline);
    const event = progress(tasks, { run_id: 'run', workflow_progress: [phase, agent] });
    assert.equal(event.workflowProgress !== undefined, taskType === 'local_workflow');
    assert.equal(progress(tasks, { run_id: 'new-run', workflow_progress: [phase] }).workflowProgress, undefined);
    for (const subtype of ['task_started', 'task_updated', 'task_notification', 'background_tasks_changed']) {
      const events = tasks.translate(frame(subtype, { task_type: taskType, workflow_progress: [phase, agent], tasks: [] }))!;
      assert.ok(events.every(e => !Object.hasOwn(e, 'workflowProgress')));
    }
  }
  assert.equal(progress(new BackgroundTasks(), { workflow_progress: [phase, agent] }).workflowProgress, undefined);
});

// Loading the built sidecar keeps the source dependency directed from sidecar to kernel.
async function wireEncoder() {
  const { translateEvent } = await import(new URL('../../../../apps/claude-sidecar/dist/src/eventTranslation.js', import.meta.url).href);
  const wire = await import(new URL('../../../../apps/claude-sidecar/dist/src/generated/verdandi/claude/runtime/v1/runtime.js', import.meta.url).href);
  return { ...wire, encode(event: ClaudeRuntimeEvent) {
    const bytes: Uint8Array = wire.SessionEvent.encode(wire.SessionEvent.fromPartial(translateEvent(event))).finish();
    return { bytes: Buffer.from(bytes), decoded: wire.SessionEvent.decode(bytes) };
  } };
}

test('workflow kind, name, PAUSED and all progress strings are bounded on the wire; private fields never appear', async () => {
  const { encode, TaskKind, TaskStatus } = await wireEncoder();
  const tasks = new BackgroundTasks();
  const markers = ['PRIVATE_SCRIPT_MARKER', 'PRIVATE_PROMPT_PREVIEW', 'PRIVATE_RESULT_PREVIEW', 'PRIVATE_WORKFLOW_LOG'];
  const long = '😀'.repeat(600);
  const started = start(tasks, { workflow_name: long, prompt: markers[0] })[0];
  assert.equal(encode(started).decoded.taskEvent.task.kind, TaskKind.TASK_KIND_WORKFLOW);
  const bounded = (value: string, max: number) => assert.equal(value, '😀'.repeat(max - 1) + '…');
  bounded(encode(started).decoded.taskEvent.task.workflowName, 128);
  const changed = tasks.translate(frame('background_tasks_changed', { tasks: [{ task_id: 'workflow', task_type: 'local_workflow' }] }))![0];
  bounded(encode(changed).decoded.backgroundTasksChanged.tasks[0].workflowName, 128);
  const malformedLog: string[] = [];
  tasks.translate(frame('task_started', { task_id: 'bad-name', task_type: 'local_workflow', workflow_name: false }), line => malformedLog.push(line));
  assert.deepEqual(malformedLog, ['dropped 1 malformed background task entries']);
  const entry = { ...agent, label: long, state: long, model: long, agentType: long, error: long, prompt: markers[0], promptPreview: markers[1], resultPreview: markers[2], workflow_log: markers[3] };
  const event = progress(tasks, { workflow_progress: [
    ...Array.from({ length: 65 }, () => ({ ...phase, title: long, kind: long, ...entry, type: 'workflow_phase' })),
    ...Array.from({ length: 257 }, () => entry),
  ], workflow_log: markers[3] });
  const decoded = encode(event).decoded.taskEvent.workflowProgress;
  assert.equal(decoded.phases.length, 64);
  assert.equal(decoded.agents.length, 256);
  for (const field of ['title', 'kind']) bounded(decoded.phases[0][field], 128);
  for (const field of ['label', 'state', 'model', 'agentType']) bounded(decoded.agents[0][field], 128);
  bounded(decoded.agents[0].error, 500);
  const paused = tasks.translate(frame('task_updated', { patch: { status: 'paused' } }))![0];
  assert.equal(encode(paused).decoded.taskEvent.status, TaskStatus.TASK_STATUS_PAUSED);
  for (const output of [started, changed, event, paused]) {
    for (const marker of markers) {
      assert.equal(JSON.stringify(output).includes(marker), false);
      assert.equal(encode(output).bytes.includes(Buffer.from(marker)), false);
    }
    for (const forbidden of ['promptPreview', 'resultPreview', 'workflow_log', '"prompt"']) assert.equal(JSON.stringify(output).includes(forbidden), false);
  }
});

for (const name of ['c16w', 'c16w_stop.run2', 'h-wf1']) {
  test(`workflow replay ${name}: kind, name and complete progress sequence survive without private task content`, async () => {
    const recording = loadRecording(name, name === 'h-wf1' ? new URL('handbuilt/', fixtureRoot) : fixtureRoot);
    const { encode, TaskKind } = await wireEncoder();
    try {
      assert.equal(recording.manifest.handbuilt === true, name === 'h-wf1');
      const marker = 'PRIVATE_WORKFLOW_REPLAY_SENTINEL';
      for (const { message } of recording.messages) {
        if (message.type !== 'system') continue;
        if (message.subtype === 'task_started') message.prompt = marker;
        if (Array.isArray(message.workflow_progress)) for (const entry of message.workflow_progress) {
          entry.promptPreview = marker;
          entry.resultPreview = marker;
        }
        message.workflow_log = marker;
      }
      const replay = await drive(recording.messages, recording.directory);
      assert.deepEqual(replay.log, name === 'h-wf1' ? ['no session state frames from this CLI', 'no lifecycle frames for a stamped send'] : []);
      const started = replay.events.find(e => e.type === 'task_event' && e.edge === 'started');
      assert.ok(started);
      const task = encode(started).decoded.taskEvent.task;
      assert.equal(task.kind, TaskKind.TASK_KIND_WORKFLOW);
      assert.equal(task.workflowName, name === 'h-wf1' ? 'example' : 'c16w');
      const rawSteps = replay.steps.filter(s => s.line.message.workflow_progress);
      assert.ok(rawSteps.length > 0);
      for (const step of rawSteps) {
        assert.equal(step.events.length, 1);
        const event = step.events[0];
        if (event.type !== 'task_event') throw new Error('expected task event');
        assert.equal(event.edge, 'progress');
        const expected = parseWorkflowProgress(step.line.message.workflow_progress).progress!;
        assert.deepEqual(event.workflowProgress, expected);
        const decoded = encode(event).decoded.taskEvent.workflowProgress;
        assert.equal(decoded.phases.length, expected.phases.length);
        assert.equal(decoded.agents.length, expected.agents.length);
        assert.ok(decoded.phases.length > 0 && decoded.agents.length > 0);
        assert.deepEqual(decoded.agents.map((a: { state: string }) => a.state), expected.agents.map(a => a.state));
      }
      const states = rawSteps.map(s => (s.events[0] as Extract<ClaudeRuntimeEvent, { type: 'task_event' }>).workflowProgress!.agents.map(a => a.state));
      assert.deepEqual(states, name === 'h-wf1' ? [['running']] : name === 'c16w' ? [['start'], ['done'], ['done', 'progress'], ['done', 'done']] : [['start'], ['done'], ['done', 'progress']]);
      for (const event of replay.events) assert.equal(encode(event).bytes.includes(Buffer.from(marker)), false);
    } finally { recording.cleanup(); }
  });
}
