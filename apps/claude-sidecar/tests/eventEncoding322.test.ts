import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { cut, ID_MAX_CHARS, WORD_MAX_CHARS, DESCRIPTION_MAX_CHARS, TEXT_MAX_CHARS, PATH_MAX_CHARS, WORKFLOW_LABEL_MAX_CHARS, MAX_TASKS_PER_LEVEL, MAX_WORKFLOW_PHASES, MAX_WORKFLOW_AGENTS } from '../src/bounds.js';
import { extractTurnId, translateEvent } from '../src/eventTranslation.js';
import {
  InteractionKind,
  InteractionOutcome,
  NoticeLevel,
  PeerHoldState,
  RateLimitStatus,
  SessionEvent,
  SessionNoticeKind,
  TaskEdge,
  TaskKind,
  TaskStatus,
  TurnCauseKind,
  TurnOrigin,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/** The SessionEvent a client would receive for `event`, and the bytes it travels as. */
function wire(event: ClaudeRuntimeEvent): { bytes: Uint8Array; hex: string; decoded: SessionEvent } {
  const bytes = SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's', sequence: 7n, occurredAt: 9n, ...translateEvent(event) })).finish();
  return { bytes, hex: Buffer.from(bytes).toString('hex'), decoded: SessionEvent.decode(bytes) };
}

function assertGolden(name: string, event: ClaudeRuntimeEvent, golden: string): SessionEvent {
  const { hex, decoded } = wire(event);
  assert.equal(hex, golden, `${name}: encoded bytes changed; now ${hex}`);
  return decoded;
}

const FULL_CAUSE = {
  kind: 'scheduled',
  taskId: 'task-1',
  taskKind: 'monitor',
  taskStatus: 'completed',
  description: 'watch the build',
  summary: 'it finished',
  peerName: 'reviewer',
  text: 'hello from a peer',
  wakeupSource: 'loop_wakeup',
  scheduledForMs: 1_800_000_000_123,
  scheduleReason: 'check again',
  cronId: 'cron-9',
  prompt: 'run the check',
} as const;

const FULL_TASK = {
  taskId: 'task-1',
  runId: 'run-2',
  kind: 'local_agent',
  taskType: 'local_agent',
  description: 'review the diff',
  subagentType: 'reviewer',
  parentTaskId: 'task-0',
  toolUseId: 'toolu_1',
  ambient: true,
  workflowName: 'nightly',
} as const;

const MIN_TASK = { taskId: 't', kind: 'shell', taskType: 'local_bash', description: 'sleep', ambient: false } as const;

// ---- one event of each new arm: every optional value set, and none set ----

test('turn_cause_updated and cli_cycle_started: a full cause, and a bare one', () => {
  const full = assertGolden('turn_cause_updated full', { type: 'turn_cause_updated', turnId: 'T', cause: FULL_CAUSE }, '0a017310071809f20187010a0154128101080212067461736b2d31180220042a0f776174636820746865206275696c64320b69742066696e69736865643a087265766965776572421168656c6c6f2066726f6d206120706565724a0b6c6f6f705f77616b65757050fba0f1c2b1345a0b636865636b20616761696e620663726f6e2d396a0d72756e2074686520636865636b');
  assert.deepEqual(full.turnCauseUpdated?.cause, {
    kind: TurnCauseKind.TURN_CAUSE_KIND_SCHEDULED,
    taskId: 'task-1',
    taskKind: TaskKind.TASK_KIND_MONITOR,
    taskStatus: TaskStatus.TASK_STATUS_COMPLETED,
    description: 'watch the build',
    summary: 'it finished',
    peerName: 'reviewer',
    text: 'hello from a peer',
    wakeupSource: 'loop_wakeup',
    scheduledForMs: 1_800_000_000_123n,
    scheduleReason: 'check again',
    cronId: 'cron-9',
    prompt: 'run the check',
  });
  assert.equal(full.turnCauseUpdated?.turnId, 'T');
  const bare = assertGolden('turn_cause_updated bare', { type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'unknown' } }, '0a017310071809f201070a015412020805');
  assert.deepEqual(bare.turnCauseUpdated?.cause, {
    kind: TurnCauseKind.TURN_CAUSE_KIND_UNKNOWN,
    taskId: undefined,
    taskKind: undefined,
    taskStatus: undefined,
    description: undefined,
    summary: undefined,
    peerName: undefined,
    text: undefined,
    wakeupSource: undefined,
    scheduledForMs: undefined,
    scheduleReason: undefined,
    cronId: undefined,
    prompt: undefined,
  });

  const cycleFull = assertGolden('cli_cycle_started full', { type: 'cli_cycle_started', turnId: 'T', cause: FULL_CAUSE }, '0a017310071809fa0187010a0154128101080212067461736b2d31180220042a0f776174636820746865206275696c64320b69742066696e69736865643a087265766965776572421168656c6c6f2066726f6d206120706565724a0b6c6f6f705f77616b65757050fba0f1c2b1345a0b636865636b20616761696e620663726f6e2d396a0d72756e2074686520636865636b');
  assert.equal(cycleFull.cliCycleStarted?.cause?.cronId, 'cron-9');
  const cycleBare = assertGolden('cli_cycle_started bare', { type: 'cli_cycle_started', turnId: 'T', cause: { kind: 'other' } }, '0a017310071809fa01070a015412020804');
  assert.equal(cycleBare.cliCycleStarted?.cause?.kind, TurnCauseKind.TURN_CAUSE_KIND_OTHER);
  assert.equal(cycleBare.cliCycleStarted?.cause?.taskId, undefined);
});

test('background_tasks_changed: a full task, a bare task, and an empty level', () => {
  const full = assertGolden('background_tasks_changed full', { type: 'background_tasks_changed', tasks: [FULL_TASK] }, '0a0173100718098202570a550a067461736b2d31120572756e2d321803220b6c6f63616c5f6167656e742a0f726576696577207468652064696666320872657669657765723a067461736b2d304207746f6f6c755f31480152076e696768746c79');
  assert.deepEqual(full.backgroundTasksChanged?.tasks, [
    {
      taskId: 'task-1',
      runId: 'run-2',
      kind: TaskKind.TASK_KIND_LOCAL_AGENT,
      taskType: 'local_agent',
      description: 'review the diff',
      subagentType: 'reviewer',
      parentTaskId: 'task-0',
      toolUseId: 'toolu_1',
      ambient: true,
      workflowName: 'nightly',
    },
  ]);
  const bare = assertGolden('background_tasks_changed bare', { type: 'background_tasks_changed', tasks: [MIN_TASK] }, '0a01731007180982021a0a180a01741801220a6c6f63616c5f626173682a05736c656570');
  const task = bare.backgroundTasksChanged?.tasks[0];
  assert.equal(task?.runId, undefined);
  assert.equal(task?.subagentType, undefined);
  assert.equal(task?.parentTaskId, undefined);
  assert.equal(task?.toolUseId, undefined);
  assert.equal(task?.workflowName, undefined);
  assert.equal(task?.ambient, false);
  const empty = assertGolden('background_tasks_changed empty', { type: 'background_tasks_changed', tasks: [] }, '0a017310071809820200');
  assert.deepEqual(empty.backgroundTasksChanged?.tasks, []);
});

test('task_event: every field set, and only the required ones', () => {
  const full = assertGolden(
    'task_event full',
    {
      type: 'task_event',
      edge: 'progress',
      taskId: 'task-1',
      runId: 'run-2',
      task: FULL_TASK,
      status: 'paused',
      summary: 'two files read',
      lastToolName: 'Read',
      usage: { totalTokens: 1234, toolUses: 3, durationMs: 4567 },
      endTimeMs: 1_800_000_000_456,
      error: 'boom',
      isBackgrounded: true,
      reason: 'worker_restart',
      outputFile: '/tmp/out.txt',
      workflowProgress: {
        phases: [{ index: 0, title: 'plan', kind: 'agents' }],
        agents: [{ index: 0, label: 'a', phaseIndex: 0, state: 'running', model: 'sonnet', agentType: 'general', tokens: 10, toolCalls: 2, durationMs: 30, error: 'bad' }],
      },
    },
    '0a0173100718098a02f301080212067461736b2d311a0572756e2d3222550a067461736b2d31120572756e2d321803220b6c6f63616c5f6167656e742a0f726576696577207468652064696666320872657669657765723a067461736b2d304207746f6f6c755f31480152076e696768746c792803320e74776f2066696c657320726561643a0452656164420808d209100318d72348c8a3f1c2b1345204626f6f6d5801620e776f726b65725f726573746172746a0c2f746d702f6f75742e747874723a0a0e1204706c616e1a066167656e74731228120161220772756e6e696e672a06736f6e6e6574320767656e6572616c380a4002481e5203626164',
  );
  const event = full.taskEvent!;
  assert.equal(event.edge, TaskEdge.TASK_EDGE_PROGRESS);
  assert.equal(event.runId, 'run-2');
  assert.equal(event.task?.taskId, 'task-1');
  assert.equal(event.status, TaskStatus.TASK_STATUS_PAUSED);
  assert.equal(event.summary, 'two files read');
  assert.equal(event.lastToolName, 'Read');
  assert.deepEqual(event.usage, { totalTokens: 1234n, toolUses: 3, durationMs: 4567n });
  assert.equal(event.endTimeMs, 1_800_000_000_456n);
  assert.equal(event.error, 'boom');
  assert.equal(event.isBackgrounded, true);
  assert.equal(event.reason, 'worker_restart');
  assert.equal(event.outputFile, '/tmp/out.txt');
  assert.deepEqual(event.workflowProgress, {
    phases: [{ index: 0, title: 'plan', kind: 'agents' }],
    agents: [{ index: 0, label: 'a', phaseIndex: 0, state: 'running', model: 'sonnet', agentType: 'general', tokens: 10n, toolCalls: 2, durationMs: 30n, error: 'bad' }],
  });

  const bare = assertGolden('task_event bare', { type: 'task_event', edge: 'started', taskId: 'task-1' }, '0a0173100718098a020a080112067461736b2d31').taskEvent!;
  assert.equal(bare.edge, TaskEdge.TASK_EDGE_STARTED);
  for (const field of ['runId', 'task', 'status', 'summary', 'lastToolName', 'usage', 'endTimeMs', 'error', 'isBackgrounded', 'reason', 'outputFile', 'workflowProgress'] as const) {
    assert.equal(bare[field], undefined, `${field} stays absent`);
  }
});

test('task_event: a workflow agent with only its required fields leaves the optional ones absent', () => {
  const event = wire({
    type: 'task_event',
    edge: 'progress',
    taskId: 'w',
    workflowProgress: { phases: [], agents: [{ index: 2, label: 'x', phaseIndex: 1, state: 'queued' }] },
  }).decoded.taskEvent!;
  const agent = event.workflowProgress?.agents[0];
  assert.equal(agent?.index, 2);
  for (const field of ['model', 'agentType', 'tokens', 'toolCalls', 'durationMs', 'error'] as const) {
    assert.equal(agent?.[field], undefined, `${field} stays absent`);
  }
});

test('session_notice: every field set, and only kind and level', () => {
  const full = assertGolden(
    'session_notice full',
    {
      type: 'session_notice',
      kind: 'rate_limit',
      level: 'warning',
      content: 'the CLI says so',
      attempt: 2,
      maxRetries: 10,
      retryDelayMs: 2000,
      errorStatus: 529,
      fromModel: 'opus',
      toModel: 'sonnet',
      preTokens: 180000,
      postTokens: 41000,
      rateStatus: 'allowed_warning',
      resetsAtMs: 1_800_000_000_789,
      utilization: 0.92,
      trigger: 'auto',
      peerName: 'reviewer',
      holdState: 'dropped',
      errorKind: 'overloaded',
      fallbackScope: 'local',
    },
    '0a017310071809920270080210041a0f74686520434c49207361797320736f2002280a30d00f38910442046f7075734a06736f6e6e657450a0fe0a58a8c00260026895a6f1c2b13471713d0ad7a370ed3f7a046175746f820108726576696577657288010392010a6f7665726c6f616465649a01056c6f63616c',
  ).sessionNotice!;
  assert.deepEqual(full, {
    kind: SessionNoticeKind.SESSION_NOTICE_KIND_RATE_LIMIT,
    level: NoticeLevel.NOTICE_LEVEL_WARNING,
    content: 'the CLI says so',
    attempt: 2,
    maxRetries: 10,
    retryDelayMs: 2000n,
    errorStatus: 529,
    fromModel: 'opus',
    toModel: 'sonnet',
    preTokens: 180000n,
    postTokens: 41000n,
    rateStatus: RateLimitStatus.RATE_LIMIT_STATUS_ALLOWED_WARNING,
    resetsAtMs: 1_800_000_000_789n,
    utilization: 0.92,
    trigger: 'auto',
    peerName: 'reviewer',
    holdState: PeerHoldState.PEER_HOLD_STATE_DROPPED,
    errorKind: 'overloaded',
    fallbackScope: 'local',
  });
  const bare = assertGolden('session_notice bare', { type: 'session_notice', kind: 'compacting', level: 'info' }, '0a01731007180992020408051001').sessionNotice!;
  assert.equal(bare.kind, SessionNoticeKind.SESSION_NOTICE_KIND_COMPACTING);
  assert.equal(bare.level, NoticeLevel.NOTICE_LEVEL_INFO);
  for (const field of ['content', 'attempt', 'maxRetries', 'retryDelayMs', 'errorStatus', 'fromModel', 'toModel', 'preTokens', 'postTokens', 'rateStatus', 'resetsAtMs', 'utilization', 'trigger', 'peerName', 'holdState', 'errorKind', 'fallbackScope'] as const) {
    assert.equal(bare[field], undefined, `${field} stays absent`);
  }
});

test('session_notice: a zero is stated, not dropped', () => {
  const notice = wire({ type: 'session_notice', kind: 'api_retry', level: 'notice', attempt: 0, retryDelayMs: 0, errorStatus: 0, utilization: 0 }).decoded.sessionNotice!;
  assert.equal(notice.attempt, 0);
  assert.equal(notice.retryDelayMs, 0n);
  assert.equal(notice.errorStatus, 0);
  assert.equal(notice.utilization, 0);
});

test('conversation_reset: with and without a trigger', () => {
  const full = assertGolden('conversation_reset full', { type: 'conversation_reset', newConversationId: 'conv-2', trigger: 'clear' }, '0a0173100718099a020f0a06636f6e762d321205636c656172');
  assert.deepEqual(full.conversationReset, { newConversationId: 'conv-2', trigger: 'clear' });
  const bare = assertGolden('conversation_reset bare', { type: 'conversation_reset', newConversationId: 'conv-2' }, '0a0173100718099a02080a06636f6e762d32');
  assert.equal(bare.conversationReset?.trigger, undefined);
});

test('interaction_requested: a question set, and a refusal without one', () => {
  const full = assertGolden(
    'interaction_requested full',
    {
      type: 'interaction_requested',
      interactionId: 'i1',
      toolUseId: 'toolu_q',
      questions: [
        { question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'Redis', description: 'in memory', preview: 'redis://' }, { label: 'Memcached', description: 'simple' }] },
      ],
    },
    '0a017310071809c2025b0a0269311207746f6f6c755f711801524a0a480a0c57686963682073746f72653f120553746f7265221c0a0552656469731209696e206d656d6f72791a0872656469733a2f2f22130a094d656d636163686564120673696d706c65',
  ).interactionRequested!;
  assert.equal(full.interactionId, 'i1');
  assert.equal(full.toolUseId, 'toolu_q');
  assert.equal(full.kind, InteractionKind.INTERACTION_KIND_QUESTION);
  assert.equal(full.unsupportedReason, undefined);
  assert.deepEqual(full.questions?.questions, [
    {
      question: 'Which store?',
      header: 'Store',
      multiSelect: false,
      options: [
        { label: 'Redis', description: 'in memory', preview: 'redis://' },
        { label: 'Memcached', description: 'simple', preview: undefined },
      ],
    },
  ]);
  const refused = assertGolden(
    'interaction_requested refused',
    { type: 'interaction_requested', interactionId: 'i2', toolUseId: '', unsupportedReason: 'too_many_options' },
    '0a017310071809c202180a02693218012210746f6f5f6d616e795f6f7074696f6e73',
  ).interactionRequested!;
  assert.equal(refused.questions, undefined);
  assert.equal(refused.unsupportedReason, 'too_many_options');
});

test('interaction_resolved: with answers and a reason, and bare', () => {
  const full = assertGolden(
    'interaction_resolved full',
    { type: 'interaction_resolved', interactionId: 'i1', outcome: 'answered', answers: [{ questionIndex: 0, answer: 'Redis', notes: 'fast' }, { questionIndex: 1, answer: 'yes' }], reason: 'because' },
    '0a017310071809ca02270a02693110011a0d120552656469731a04666173741a0708011203796573220762656361757365',
  ).interactionResolved!;
  assert.equal(full.outcome, InteractionOutcome.INTERACTION_OUTCOME_ANSWERED);
  assert.deepEqual(full.answers, [
    { questionIndex: 0, answer: 'Redis', notes: 'fast' },
    { questionIndex: 1, answer: 'yes', notes: undefined },
  ]);
  assert.equal(full.reason, 'because');
  const bare = assertGolden('interaction_resolved bare', { type: 'interaction_resolved', interactionId: 'i1', outcome: 'session_closed' }, '0a017310071809ca02060a0269311006').interactionResolved!;
  assert.deepEqual(bare.answers, []);
  assert.equal(bare.reason, undefined);
});

// ---- the five new optional fields on existing events ----

test('turn_started: origin and cause when stated, UNSPECIFIED and no cause when not', () => {
  const stated = assertGolden('turn_started cli', { type: 'turn_started', turnId: 'T', origin: 'cli', cause: { kind: 'task', taskId: 'b1', taskStatus: 'failed' } }, '0a0173100718095a0f0a015410031a080801120262312005').turnStarted!;
  assert.equal(stated.origin, TurnOrigin.TURN_ORIGIN_CLI);
  assert.equal(stated.cause?.kind, TurnCauseKind.TURN_CAUSE_KIND_TASK);
  assert.equal(stated.cause?.taskStatus, TaskStatus.TASK_STATUS_FAILED);
  const plain = assertGolden('turn_started plain', { type: 'turn_started', turnId: 'T' }, '0a0173100718095a030a0154').turnStarted!;
  assert.equal(plain.origin, TurnOrigin.TURN_ORIGIN_UNSPECIFIED);
  assert.equal(plain.cause, undefined);
  assert.equal(wire({ type: 'turn_started', turnId: 'T', origin: 'client' }).decoded.turnStarted?.origin, TurnOrigin.TURN_ORIGIN_CLIENT);
  assert.equal(wire({ type: 'turn_started', turnId: 'T', origin: 'follow_up' }).decoded.turnStarted?.origin, TurnOrigin.TURN_ORIGIN_FOLLOW_UP);
});

test('turn_completed: origin_kind and num_turns when stated (zero included), absent otherwise', () => {
  const base = { type: 'turn_completed', turnId: 'T', outcome: 'completed', resultText: 'r', isError: false, stopReason: null } as const;
  const stated = assertGolden('turn_completed stated', { ...base, originKind: 'task-notification', numTurns: 0 }, '0a01731007180992011d0a015410011a017262117461736b2d6e6f74696669636174696f6e6800').turnCompleted!;
  assert.equal(stated.originKind, 'task-notification');
  assert.equal(stated.numTurns, 0);
  const plain = assertGolden('turn_completed plain', base, '0a0173100718099201080a015410011a0172').turnCompleted!;
  assert.equal(plain.originKind, undefined);
  assert.equal(plain.numTurns, undefined);
});

test('parent_tool_use_id: stated on text, thinking and both tool-call events, absent otherwise', () => {
  const parent = 'toolu_agent';
  const stated = [
    wire({ type: 'text_delta', turnId: 'T', text: 'x', parentToolUseId: parent }).decoded.textDelta?.parentToolUseId,
    wire({ type: 'thinking_delta', turnId: 'T', text: 'x', parentToolUseId: parent }).decoded.thinkingDelta?.parentToolUseId,
    wire({ type: 'tool_call_started', turnId: 'T', toolUseId: 'u', name: 'Bash', input: {}, parentToolUseId: parent }).decoded.toolCallStarted?.parentToolUseId,
    wire({ type: 'tool_call_completed', turnId: 'T', toolUseId: 'u', content: 'ok', isError: false, parentToolUseId: parent }).decoded.toolCallCompleted?.parentToolUseId,
  ];
  assert.deepEqual(stated, [parent, parent, parent, parent]);
  const absent = [
    wire({ type: 'text_delta', turnId: 'T', text: 'x' }).decoded.textDelta?.parentToolUseId,
    wire({ type: 'thinking_delta', turnId: 'T', text: 'x' }).decoded.thinkingDelta?.parentToolUseId,
    wire({ type: 'tool_call_started', turnId: 'T', toolUseId: 'u', name: 'Bash', input: {} }).decoded.toolCallStarted?.parentToolUseId,
    wire({ type: 'tool_call_completed', turnId: 'T', toolUseId: 'u', content: 'ok', isError: false }).decoded.toolCallCompleted?.parentToolUseId,
  ];
  assert.deepEqual(absent, [undefined, undefined, undefined, undefined]);
  // An event that never mentions the field encodes as it did before the field existed.
  assert.equal(wire({ type: 'text_delta', turnId: 'T', text: 'x' }).hex, wire({ type: 'text_delta', turnId: 'T', text: 'x', parentToolUseId: undefined }).hex);
});

test('every enum value the kernel names reaches the wire as a value of its own', () => {
  const nonzero = (value: number, what: string) => assert.notEqual(value, 0, `${what} must not read as UNSPECIFIED`);
  for (const kind of ['shell', 'monitor', 'local_agent', 'workflow', 'other'] as const) {
    nonzero(wire({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, kind }] }).decoded.backgroundTasksChanged!.tasks[0]!.kind, `task kind ${kind}`);
  }
  for (const status of ['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'killed'] as const) {
    nonzero(wire({ type: 'task_event', edge: 'updated', taskId: 't', status }).decoded.taskEvent!.status!, `task status ${status}`);
  }
  for (const edge of ['started', 'progress', 'updated', 'notified'] as const) {
    nonzero(wire({ type: 'task_event', edge, taskId: 't' }).decoded.taskEvent!.edge, `task edge ${edge}`);
  }
  for (const kind of ['api_retry', 'rate_limit', 'model_fallback', 'model_refusal', 'compacting', 'compact_boundary', 'informational', 'notification', 'peer_hold'] as const) {
    nonzero(wire({ type: 'session_notice', kind, level: 'info' }).decoded.sessionNotice!.kind, `notice kind ${kind}`);
  }
  for (const level of ['info', 'notice', 'suggestion', 'warning'] as const) {
    nonzero(wire({ type: 'session_notice', kind: 'informational', level }).decoded.sessionNotice!.level, `notice level ${level}`);
  }
  for (const rateStatus of ['allowed', 'allowed_warning', 'rejected'] as const) {
    nonzero(wire({ type: 'session_notice', kind: 'rate_limit', level: 'info', rateStatus }).decoded.sessionNotice!.rateStatus!, `rate status ${rateStatus}`);
  }
  for (const holdState of ['held', 'released', 'dropped'] as const) {
    nonzero(wire({ type: 'session_notice', kind: 'peer_hold', level: 'info', holdState }).decoded.sessionNotice!.holdState!, `hold state ${holdState}`);
  }
  for (const kind of ['task', 'scheduled', 'peer', 'other', 'unknown'] as const) {
    nonzero(wire({ type: 'turn_cause_updated', turnId: 'T', cause: { kind } }).decoded.turnCauseUpdated!.cause!.kind, `cause kind ${kind}`);
  }
  for (const outcome of ['answered', 'declined', 'chat_requested', 'interrupted', 'expired', 'session_closed', 'provider_failed', 'host_refused'] as const) {
    nonzero(wire({ type: 'interaction_resolved', interactionId: 'i', outcome }).decoded.interactionResolved!.outcome, `interaction outcome ${outcome}`);
  }
});

test('extractTurnId: the two turn-scoped additions name their turn, the rest belong to the session', () => {
  assert.equal(extractTurnId({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'unknown' } }), 'T');
  assert.equal(extractTurnId({ type: 'cli_cycle_started', turnId: 'T', cause: { kind: 'unknown' } }), 'T');
  const sessionScoped: ClaudeRuntimeEvent[] = [
    { type: 'background_tasks_changed', tasks: [] },
    { type: 'task_event', edge: 'started', taskId: 't' },
    { type: 'session_notice', kind: 'informational', level: 'info' },
    { type: 'conversation_reset', newConversationId: 'c' },
    { type: 'interaction_requested', interactionId: 'i', toolUseId: '' },
    { type: 'interaction_resolved', interactionId: 'i', outcome: 'expired' },
  ];
  for (const event of sessionScoped) {
    assert.equal(extractTurnId(event), undefined, event.type);
  }
});

// ---- bounds ----

test('cut: a value within its limit is returned as it is', () => {
  assert.equal(cut('abc', 3), 'abc');
  assert.equal(cut('', 3), '');
  assert.equal(cut('x'.repeat(128), 128), 'x'.repeat(128));
});

test('cut: a value one character over becomes the limit, ending in an ellipsis', () => {
  const out = cut('x'.repeat(129), 128);
  assert.equal([...out].length, 128);
  assert.equal(out, `${'x'.repeat(127)}…`);
  assert.equal(cut(out, 128), out, 'cutting the result again changes nothing');
});

/** A UTF-16 unit that is half of a pair with no partner. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test('cut: a character outside the Basic Multilingual Plane counts once and is never split', () => {
  const smiley = '😀';
  // 128 of them are 256 UTF-16 units but 128 characters: within the limit.
  assert.equal(cut(smiley.repeat(128), 128), smiley.repeat(128));
  // The 128th character sits at the cut: it is dropped whole, with no lone surrogate left behind.
  const atCut = `${'a'.repeat(127)}${smiley}b`;
  assert.equal(cut(atCut, 128), `${'a'.repeat(127)}…`);
  // The 127th is kept whole when the cut falls after it.
  const beforeCut = `${'a'.repeat(126)}${smiley}bb`;
  const out = cut(beforeCut, 128);
  assert.equal(out, `${'a'.repeat(126)}${smiley}…`);
  assert.equal(LONE_SURROGATE.test(out), false);
  assert.equal(LONE_SURROGATE.test(cut(smiley.repeat(200), 128)), false);
});

type BoundCase = { field: string; max: number; make: (value: string) => ClaudeRuntimeEvent; read: (event: SessionEvent) => string | undefined };

const BOUND_CASES: BoundCase[] = [
  // ids and names: 128
  { field: 'cause.task_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'task', taskId: v } }), read: (e) => e.turnCauseUpdated?.cause?.taskId },
  { field: 'cause.peer_name', max: ID_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'peer', peerName: v } }), read: (e) => e.turnCauseUpdated?.cause?.peerName },
  { field: 'cause.cron_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'scheduled', cronId: v } }), read: (e) => e.turnCauseUpdated?.cause?.cronId },
  { field: 'task.task_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, taskId: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.taskId },
  { field: 'task.run_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, runId: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.runId },
  { field: 'task.subagent_type', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, subagentType: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.subagentType },
  { field: 'task.parent_task_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, parentTaskId: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.parentTaskId },
  { field: 'task.tool_use_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, toolUseId: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.toolUseId },
  { field: 'task.workflow_name', max: ID_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, workflowName: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.workflowName },
  { field: 'task_event.task_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'started', taskId: v }), read: (e) => e.taskEvent?.taskId },
  { field: 'task_event.run_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'started', taskId: 't', runId: v }), read: (e) => e.taskEvent?.runId },
  { field: 'notice.from_model', max: ID_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'model_fallback', level: 'info', fromModel: v }), read: (e) => e.sessionNotice?.fromModel },
  { field: 'notice.to_model', max: ID_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'model_fallback', level: 'info', toModel: v }), read: (e) => e.sessionNotice?.toModel },
  { field: 'notice.peer_name', max: ID_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'peer_hold', level: 'info', peerName: v }), read: (e) => e.sessionNotice?.peerName },
  { field: 'conversation_reset.new_conversation_id', max: ID_MAX_CHARS, make: (v) => ({ type: 'conversation_reset', newConversationId: v }), read: (e) => e.conversationReset?.newConversationId },
  // type words: 64
  { field: 'task.task_type', max: WORD_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, taskType: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.taskType },
  { field: 'task_event.last_tool_name', max: WORD_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', lastToolName: v }), read: (e) => e.taskEvent?.lastToolName },
  { field: 'cause.wakeup_source', max: WORD_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'scheduled', wakeupSource: v } }), read: (e) => e.turnCauseUpdated?.cause?.wakeupSource },
  { field: 'turn_completed.origin_kind', max: WORD_MAX_CHARS, make: (v) => ({ type: 'turn_completed', turnId: 'T', outcome: 'completed', resultText: '', isError: false, stopReason: null, originKind: v }), read: (e) => e.turnCompleted?.originKind },
  { field: 'notice.trigger', max: WORD_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'compact_boundary', level: 'info', trigger: v }), read: (e) => e.sessionNotice?.trigger },
  { field: 'notice.error_kind', max: WORD_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'api_retry', level: 'info', errorKind: v }), read: (e) => e.sessionNotice?.errorKind },
  { field: 'notice.fallback_scope', max: WORD_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'model_fallback', level: 'info', fallbackScope: v }), read: (e) => e.sessionNotice?.fallbackScope },
  { field: 'conversation_reset.trigger', max: WORD_MAX_CHARS, make: (v) => ({ type: 'conversation_reset', newConversationId: 'c', trigger: v }), read: (e) => e.conversationReset?.trigger },
  // descriptions: 500
  { field: 'task.description', max: DESCRIPTION_MAX_CHARS, make: (v) => ({ type: 'background_tasks_changed', tasks: [{ ...MIN_TASK, description: v }] }), read: (e) => e.backgroundTasksChanged?.tasks[0]?.description },
  { field: 'cause.description', max: DESCRIPTION_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'task', description: v } }), read: (e) => e.turnCauseUpdated?.cause?.description },
  { field: 'cause.schedule_reason', max: DESCRIPTION_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'scheduled', scheduleReason: v } }), read: (e) => e.turnCauseUpdated?.cause?.scheduleReason },
  // text: 2000
  { field: 'cause.summary', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'task', summary: v } }), read: (e) => e.turnCauseUpdated?.cause?.summary },
  { field: 'cause.text', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'turn_cause_updated', turnId: 'T', cause: { kind: 'peer', text: v } }), read: (e) => e.turnCauseUpdated?.cause?.text },
  { field: 'cause.prompt', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'cli_cycle_started', turnId: 'T', cause: { kind: 'scheduled', prompt: v } }), read: (e) => e.cliCycleStarted?.cause?.prompt },
  { field: 'task_event.summary', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'notified', taskId: 't', summary: v }), read: (e) => e.taskEvent?.summary },
  { field: 'task_event.error', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'updated', taskId: 't', error: v }), read: (e) => e.taskEvent?.error },
  { field: 'task_event.reason', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'updated', taskId: 't', reason: v }), read: (e) => e.taskEvent?.reason },
  { field: 'notice.content', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'session_notice', kind: 'informational', level: 'info', content: v }), read: (e) => e.sessionNotice?.content },
  { field: 'interaction_requested.unsupported_reason', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'interaction_requested', interactionId: 'i', toolUseId: '', unsupportedReason: v }), read: (e) => e.interactionRequested?.unsupportedReason },
  { field: 'interaction_resolved.reason', max: TEXT_MAX_CHARS, make: (v) => ({ type: 'interaction_resolved', interactionId: 'i', outcome: 'host_refused', reason: v }), read: (e) => e.interactionResolved?.reason },
  // the output file's path: 1024
  { field: 'task_event.output_file', max: PATH_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'notified', taskId: 't', outputFile: v }), read: (e) => e.taskEvent?.outputFile },
  // workflow strings: 128, and a workflow agent's error: 500
  { field: 'workflow phase.title', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [{ index: 0, title: v, kind: 'k' }], agents: [] } }), read: (e) => e.taskEvent?.workflowProgress?.phases[0]?.title },
  { field: 'workflow phase.kind', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [{ index: 0, title: 't', kind: v }], agents: [] } }), read: (e) => e.taskEvent?.workflowProgress?.phases[0]?.kind },
  { field: 'workflow agent.label', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [], agents: [{ index: 0, label: v, phaseIndex: 0, state: 's' }] } }), read: (e) => e.taskEvent?.workflowProgress?.agents[0]?.label },
  { field: 'workflow agent.state', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [], agents: [{ index: 0, label: 'l', phaseIndex: 0, state: v }] } }), read: (e) => e.taskEvent?.workflowProgress?.agents[0]?.state },
  { field: 'workflow agent.model', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [], agents: [{ index: 0, label: 'l', phaseIndex: 0, state: 's', model: v }] } }), read: (e) => e.taskEvent?.workflowProgress?.agents[0]?.model },
  { field: 'workflow agent.agent_type', max: WORKFLOW_LABEL_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [], agents: [{ index: 0, label: 'l', phaseIndex: 0, state: 's', agentType: v }] } }), read: (e) => e.taskEvent?.workflowProgress?.agents[0]?.agentType },
  { field: 'workflow agent.error', max: DESCRIPTION_MAX_CHARS, make: (v) => ({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases: [], agents: [{ index: 0, label: 'l', phaseIndex: 0, state: 's', error: v }] } }), read: (e) => e.taskEvent?.workflowProgress?.agents[0]?.error },
];

for (const { field, max, make, read } of BOUND_CASES) {
  test(`bound: ${field} is cut at ${max} characters with an ellipsis, and left alone at the limit`, () => {
    const atLimit = 'é'.repeat(max);
    assert.equal(read(wire(make(atLimit)).decoded), atLimit, 'a value of exactly the limit is untouched');
    const over = read(wire(make(`${atLimit}z`)).decoded);
    assert.equal(over, `${'é'.repeat(max - 1)}…`);
    assert.equal([...over!].length, max);
  });
}

test('bound: a background-task level holds at most 256 tasks, the first ones', () => {
  const tasks = Array.from({ length: MAX_TASKS_PER_LEVEL + 1 }, (_, i) => ({ ...MIN_TASK, taskId: `t${i}` }));
  const decoded = wire({ type: 'background_tasks_changed', tasks }).decoded.backgroundTasksChanged!.tasks;
  assert.equal(decoded.length, MAX_TASKS_PER_LEVEL);
  assert.equal(decoded[0]?.taskId, 't0');
  assert.equal(decoded[MAX_TASKS_PER_LEVEL - 1]?.taskId, `t${MAX_TASKS_PER_LEVEL - 1}`);
  const exactly = wire({ type: 'background_tasks_changed', tasks: tasks.slice(0, MAX_TASKS_PER_LEVEL) }).decoded.backgroundTasksChanged!.tasks;
  assert.equal(exactly.length, MAX_TASKS_PER_LEVEL);
});

test('bound: workflow progress holds at most 64 phases and 256 agents', () => {
  const phases = Array.from({ length: MAX_WORKFLOW_PHASES + 1 }, (_, i) => ({ index: i, title: `p${i}`, kind: 'k' }));
  const agents = Array.from({ length: MAX_WORKFLOW_AGENTS + 1 }, (_, i) => ({ index: i, label: `a${i}`, phaseIndex: 0, state: 's' }));
  const progress = wire({ type: 'task_event', edge: 'progress', taskId: 't', workflowProgress: { phases, agents } }).decoded.taskEvent!.workflowProgress!;
  assert.equal(progress.phases.length, MAX_WORKFLOW_PHASES);
  assert.equal(progress.agents.length, MAX_WORKFLOW_AGENTS);
  assert.equal(progress.phases[MAX_WORKFLOW_PHASES - 1]?.title, `p${MAX_WORKFLOW_PHASES - 1}`);
  assert.equal(progress.agents[MAX_WORKFLOW_AGENTS - 1]?.label, `a${MAX_WORKFLOW_AGENTS - 1}`);
});

test('bound: a question set is passed whole, never cut', () => {
  const long = 'q'.repeat(5000);
  const questions = wire({
    type: 'interaction_requested',
    interactionId: 'i',
    toolUseId: 't',
    questions: [{ question: long, header: long, multiSelect: true, options: [{ label: long, description: long, preview: long }] }],
  }).decoded.interactionRequested!.questions!.questions;
  assert.equal(questions[0]?.question, long);
  assert.equal(questions[0]?.options[0]?.preview, long);
});
