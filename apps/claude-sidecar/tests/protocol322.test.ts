import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { buildSessionOptions, TaskNotFoundError, TaskOutputUnavailableError } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { buildKernelSessionConfig, createRuntimeServiceImpl, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { handshakeCapabilities } from '../src/capabilities.js';
import { startSidecar } from '../src/lifecycle.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import {
  BackgroundTasksChanged,
  ClaudeHostPolicy,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  GetInteractionStateRequest,
  GetTaskOutputRequest,
  InteractionKind,
  InteractionOutcome,
  NoticeLevel,
  PeerHoldState,
  QuestionDeclineKind,
  RateLimitStatus,
  ResolveInteractionRequest,
  RuntimeServiceClient,
  SessionEvent,
  SessionNoticeKind,
  StopTaskRequest,
  TaskEdge,
  TaskKind,
  TaskStatus,
  TurnCauseKind,
  TurnOrigin,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { compileProto, modelOf, type FieldModel, type ProtoModel } from './compat/protoModel.js';
import { CURRENT_PROTO } from './compat/paths.js';
import { makeFakeSession } from './fakeSession.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/**
 * Protocol 3.22's wire and its features as they land: every message, field, enum, reservation, error
 * code and RPC at its number, each new SessionEvent arm encoding at its tag, the request fields that ask
 * for a feature this build lacks refused rather than ignored, and a handshake that advertises exactly
 * the minor's capabilities whose behaviour works.
 */

const PKG = 'verdandi.claude.runtime.v1';
const T = `.${PKG}.`;

const live: ProtoModel = modelOf(compileProto(CURRENT_PROTO));

/** A field as the descriptor states it: label, type, name, number, and whether it is a real oneof
 * member or a proto3 optional. */
function describe(field: FieldModel): string {
  return `${field.label} ${field.typeName === '' ? field.type : field.typeName} ${field.name} = ${field.number}${field.oneof !== undefined ? ` (oneof ${field.oneof})` : ''}${field.proto3Optional ? ' (proto3 optional)' : ''}`;
}

function fieldsOf(message: string, numbers?: number[]): string[] {
  const model = live.messages.get(`${PKG}.${message}`);
  assert.ok(model !== undefined, `message ${message}`);
  return [...model.fields.values()].filter((f) => numbers === undefined || numbers.includes(f.number)).map(describe);
}

function valuesOf(enumeration: string): Array<[number, string]> {
  const model = live.enums.get(`${PKG}.${enumeration}`);
  assert.ok(model !== undefined, `enum ${enumeration}`);
  return [...model.values.entries()].map(([number, names]) => [number, names.join('/')]);
}

const opt = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number} (proto3 optional)`;
const one = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number}`;
const many = (type: string, name: string, number: number) => `repeated ${type} ${name} = ${number}`;

// ---- The descriptor ---------------------------------------------------------------------------------------------

test('3.22: the new fields of existing messages are at their numbers, with their types and presence', () => {
  assert.deepEqual(fieldsOf('TurnStarted', [2, 3]), [one(`${T}TurnOrigin`, 'origin', 2), one(`${T}TurnCause`, 'cause', 3)]);
  assert.deepEqual(fieldsOf('TurnCompleted', [12, 13]), [opt('string', 'origin_kind', 12), opt('uint32', 'num_turns', 13)]);
  assert.deepEqual(fieldsOf('SendTurnRequest', [4, 5]), [opt('string', 'client_message_id', 4), one('bool', 'typed_by_person', 5)]);
  assert.deepEqual(fieldsOf('SteerTurnRequest', [6]), [one('bool', 'typed_by_person', 6)]);
  for (const message of ['ToolCallStarted', 'ToolCallCompleted']) {
    assert.deepEqual(fieldsOf(message, [5]), [opt('string', 'parent_tool_use_id', 5)], message);
  }
  for (const message of ['TextDelta', 'ThinkingDelta']) {
    assert.deepEqual(fieldsOf(message, [4]), [opt('string', 'parent_tool_use_id', 4)], message);
  }
  assert.deepEqual(fieldsOf('ClaudeHostPolicy', [12]), [one('bool', 'per_task_stop', 12)]);
  assert.deepEqual(fieldsOf('CreateSessionRequest', [11]), [one(`${T}ClientInteractions`, 'client_interactions', 11)]);
  assert.deepEqual(fieldsOf('ClientInteractions'), [one('bool', 'questions', 1)]);
});

test('3.22: the new messages carry exactly their fields', () => {
  const expected: Record<string, string[]> = {
    TurnCause: [
      one(`${T}TurnCauseKind`, 'kind', 1), opt('string', 'task_id', 2), opt(`${T}TaskKind`, 'task_kind', 3), opt(`${T}TaskStatus`, 'task_status', 4),
      opt('string', 'description', 5), opt('string', 'summary', 6), opt('string', 'peer_name', 7), opt('string', 'text', 8),
      opt('string', 'wakeup_source', 9), opt('int64', 'scheduled_for_ms', 10), opt('string', 'schedule_reason', 11), opt('string', 'cron_id', 12),
      opt('string', 'prompt', 13),
    ],
    TurnCauseUpdated: [one('string', 'turn_id', 1), one(`${T}TurnCause`, 'cause', 2)],
    CliCycleStarted: [one('string', 'turn_id', 1), one(`${T}TurnCause`, 'cause', 2)],
    BackgroundTask: [
      one('string', 'task_id', 1), opt('string', 'run_id', 2), one(`${T}TaskKind`, 'kind', 3), one('string', 'task_type', 4), one('string', 'description', 5),
      opt('string', 'subagent_type', 6), opt('string', 'parent_task_id', 7), opt('string', 'tool_use_id', 8), one('bool', 'ambient', 9),
      opt('string', 'workflow_name', 10),
    ],
    BackgroundTasksChanged: [many(`${T}BackgroundTask`, 'tasks', 1)],
    TaskEvent: [
      one(`${T}TaskEdge`, 'edge', 1), one('string', 'task_id', 2), opt('string', 'run_id', 3), one(`${T}BackgroundTask`, 'task', 4),
      opt(`${T}TaskStatus`, 'status', 5), opt('string', 'summary', 6), opt('string', 'last_tool_name', 7), one(`${T}TaskUsage`, 'usage', 8),
      opt('int64', 'end_time_ms', 9), opt('string', 'error', 10), opt('bool', 'is_backgrounded', 11), opt('string', 'reason', 12),
      opt('string', 'output_file', 13), one(`${T}WorkflowProgress`, 'workflow_progress', 14),
    ],
    TaskUsage: [one('uint64', 'total_tokens', 1), one('uint32', 'tool_uses', 2), one('uint64', 'duration_ms', 3)],
    WorkflowProgress: [many(`${T}WorkflowPhase`, 'phases', 1), many(`${T}WorkflowAgent`, 'agents', 2)],
    WorkflowPhase: [one('uint32', 'index', 1), one('string', 'title', 2), one('string', 'kind', 3)],
    WorkflowAgent: [
      one('uint32', 'index', 1), one('string', 'label', 2), one('uint32', 'phase_index', 3), one('string', 'state', 4), opt('string', 'model', 5),
      opt('string', 'agent_type', 6), opt('uint64', 'tokens', 7), opt('uint32', 'tool_calls', 8), opt('uint64', 'duration_ms', 9), opt('string', 'error', 10),
    ],
    SessionNotice: [
      one(`${T}SessionNoticeKind`, 'kind', 1), one(`${T}NoticeLevel`, 'level', 2), opt('string', 'content', 3), opt('uint32', 'attempt', 4),
      opt('uint32', 'max_retries', 5), opt('uint64', 'retry_delay_ms', 6), opt('int32', 'error_status', 7), opt('string', 'from_model', 8),
      opt('string', 'to_model', 9), opt('uint64', 'pre_tokens', 10), opt('uint64', 'post_tokens', 11), opt(`${T}RateLimitStatus`, 'rate_status', 12),
      opt('int64', 'resets_at_ms', 13), opt('double', 'utilization', 14), opt('string', 'trigger', 15), opt('string', 'peer_name', 16),
      opt(`${T}PeerHoldState`, 'hold_state', 17), opt('string', 'error_kind', 18), opt('string', 'fallback_scope', 19),
    ],
    ConversationReset: [one('string', 'new_conversation_id', 1), opt('string', 'trigger', 2)],
    StopTaskRequest: [one('string', 'session_id', 1), one('string', 'command_id', 2), one('string', 'task_id', 3)],
    StopTaskResponse: [],
    GetTaskOutputRequest: [one('string', 'session_id', 1), one('string', 'task_id', 2)],
    GetTaskOutputResponse: [one('bytes', 'output', 1), one('uint64', 'total_bytes', 2), one('bool', 'truncated', 3)],
    InteractionRequested: [
      one('string', 'interaction_id', 1), one('string', 'tool_use_id', 2), one(`${T}InteractionKind`, 'kind', 3), opt('string', 'unsupported_reason', 4),
      `optional ${T}QuestionSet questions = 10 (oneof payload)`,
    ],
    QuestionSet: [many(`${T}Question`, 'questions', 1)],
    Question: [one('string', 'question', 1), one('string', 'header', 2), one('bool', 'multi_select', 3), many(`${T}QuestionOption`, 'options', 4)],
    QuestionOption: [one('string', 'label', 1), one('string', 'description', 2), opt('string', 'preview', 3)],
    InteractionResolved: [one('string', 'interaction_id', 1), one(`${T}InteractionOutcome`, 'outcome', 2), many(`${T}ShownAnswer`, 'answers', 3), opt('string', 'reason', 4)],
    ShownAnswer: [one('uint32', 'question_index', 1), one('string', 'answer', 2), opt('string', 'notes', 3)],
    ResolveInteractionRequest: [
      one('string', 'session_id', 1), one('string', 'command_id', 2), one('string', 'interaction_id', 3),
      `optional ${T}QuestionAnswers answers = 10 (oneof result)`, `optional ${T}QuestionDecline decline = 11 (oneof result)`,
    ],
    QuestionAnswers: [many(`${T}QuestionAnswer`, 'answers', 1)],
    QuestionAnswer: [one('uint32', 'question_index', 1), many('uint32', 'option_indexes', 2), opt('string', 'other_text', 3), opt('string', 'notes', 4)],
    QuestionDecline: [one(`${T}QuestionDeclineKind`, 'kind', 1), one(`${T}QuestionAnswers`, 'so_far', 2)],
    ResolveInteractionResponse: [one(`${T}InteractionOutcome`, 'outcome', 1)],
    GetInteractionStateRequest: [one('string', 'session_id', 1)],
    GetInteractionStateResponse: [one('uint64', 'through_sequence', 1), many(`${T}InteractionRequested`, 'pending', 2)],
  };
  for (const [message, fields] of Object.entries(expected)) {
    assert.deepEqual(fieldsOf(message).sort(), [...fields].sort(), message);
  }
});

test('3.22: the new enums have exactly their values, each prefixed with its enum\'s name', () => {
  const expected: Record<string, string[]> = {
    TurnOrigin: ['UNSPECIFIED', 'CLIENT', 'FOLLOW_UP', 'CLI'],
    TurnCauseKind: ['UNSPECIFIED', 'TASK', 'SCHEDULED', 'PEER', 'OTHER', 'UNKNOWN'],
    TaskKind: ['UNSPECIFIED', 'SHELL', 'MONITOR', 'LOCAL_AGENT', 'WORKFLOW', 'OTHER'],
    TaskStatus: ['UNSPECIFIED', 'PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'STOPPED', 'KILLED'],
    TaskEdge: ['UNSPECIFIED', 'STARTED', 'PROGRESS', 'UPDATED', 'NOTIFIED'],
    SessionNoticeKind: ['UNSPECIFIED', 'API_RETRY', 'RATE_LIMIT', 'MODEL_FALLBACK', 'MODEL_REFUSAL', 'COMPACTING', 'COMPACT_BOUNDARY', 'INFORMATIONAL', 'NOTIFICATION', 'PEER_HOLD'],
    NoticeLevel: ['UNSPECIFIED', 'INFO', 'NOTICE', 'SUGGESTION', 'WARNING'],
    RateLimitStatus: ['UNSPECIFIED', 'ALLOWED', 'ALLOWED_WARNING', 'REJECTED'],
    PeerHoldState: ['UNSPECIFIED', 'HELD', 'RELEASED', 'DROPPED'],
    InteractionKind: ['UNSPECIFIED', 'QUESTION'],
    InteractionOutcome: ['UNSPECIFIED', 'ANSWERED', 'DECLINED', 'CHAT_REQUESTED', 'INTERRUPTED', 'EXPIRED', 'SESSION_CLOSED', 'PROVIDER_FAILED', 'HOST_REFUSED'],
    QuestionDeclineKind: ['UNSPECIFIED', 'CANCEL', 'CHAT'],
  };
  for (const [enumeration, names] of Object.entries(expected)) {
    const prefix = enumeration.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    assert.deepEqual(valuesOf(enumeration), names.map((name, number) => [number, `${prefix}_${name}`]), enumeration);
  }
  assert.deepEqual(live.enums.get(`${PKG}.InteractionKind`)?.reservedRanges, [[2, 2]], 'InteractionKind holds 2');
});

test('3.22: the new error codes are 16, 17, 30 and 31', () => {
  const codes = new Map(valuesOf('ErrorCode'));
  assert.equal(codes.get(16), 'ERROR_CODE_TASK_NOT_FOUND');
  assert.equal(codes.get(17), 'ERROR_CODE_TASK_OUTPUT_UNAVAILABLE');
  assert.equal(codes.get(30), 'ERROR_CODE_INTERACTION_NOT_FOUND');
  assert.equal(codes.get(31), 'ERROR_CODE_INTERACTION_ANSWER_REFUSED');
  assert.deepEqual([...codes.keys()].filter((n) => n > 15).sort((a, b) => a - b), [16, 17, 30, 31], 'no other code past 15');
});

test('3.22: the new SessionEvent arms are at 30-35, 40 and 41, and 27-29 are reserved', () => {
  assert.deepEqual(fieldsOf('SessionEvent', [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]), [
    `optional ${T}TurnCauseUpdated turn_cause_updated = 30 (oneof event)`,
    `optional ${T}CliCycleStarted cli_cycle_started = 31 (oneof event)`,
    `optional ${T}BackgroundTasksChanged background_tasks_changed = 32 (oneof event)`,
    `optional ${T}TaskEvent task_event = 33 (oneof event)`,
    `optional ${T}SessionNotice session_notice = 34 (oneof event)`,
    `optional ${T}ConversationReset conversation_reset = 35 (oneof event)`,
    `optional ${T}InteractionRequested interaction_requested = 40 (oneof event)`,
    `optional ${T}InteractionResolved interaction_resolved = 41 (oneof event)`,
  ]);
  assert.deepEqual(live.messages.get(`${PKG}.SessionEvent`)?.reservedRanges, [[27, 29]]);
});

test('3.22: the numbers held for later work are reserved where the minor says', () => {
  assert.deepEqual(live.messages.get(`${PKG}.CreateSessionRequest`)?.reservedRanges, [[12, 12]]);
  assert.deepEqual(live.messages.get(`${PKG}.HandshakeResponse`)?.reservedRanges, [[20, 20]]);
  assert.deepEqual(live.messages.get(`${PKG}.ClientInteractions`)?.reservedRanges, [[2, 2]]);
  assert.deepEqual(live.messages.get(`${PKG}.ResolveInteractionRequest`)?.reservedRanges, [[12, 19]]);
});

test('3.22: the four new RPCs are in the service with their request and response types', () => {
  const service = live.services.get(`${PKG}.RuntimeService`);
  assert.ok(service !== undefined);
  for (const [name, input, output] of [
    ['StopTask', 'StopTaskRequest', 'StopTaskResponse'],
    ['GetTaskOutput', 'GetTaskOutputRequest', 'GetTaskOutputResponse'],
    ['ResolveInteraction', 'ResolveInteractionRequest', 'ResolveInteractionResponse'],
    ['GetInteractionState', 'GetInteractionStateRequest', 'GetInteractionStateResponse'],
  ] as const) {
    assert.deepEqual(service.get(name), { name, input: `${T}${input}`, output: `${T}${output}`, clientStreaming: false, serverStreaming: false }, name);
  }
});

// ---- Each new arm on the wire -------------------------------------------------------------------------------------

/** The field number of the first key in `bytes`. */
function firstTag(bytes: Uint8Array): number {
  let key = 0;
  let shift = 0;
  for (const byte of bytes) {
    key |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return key >>> 3;
    }
    shift += 7;
  }
  throw new Error('no complete key');
}

const ARMS: Array<[tag: number, event: Partial<SessionEvent>]> = [
  [30, { turnCauseUpdated: { turnId: 't1', cause: { kind: TurnCauseKind.TURN_CAUSE_KIND_TASK, taskId: 'b1', taskKind: TaskKind.TASK_KIND_SHELL, taskStatus: TaskStatus.TASK_STATUS_COMPLETED } } }],
  [31, { cliCycleStarted: { turnId: 't1', cause: { kind: TurnCauseKind.TURN_CAUSE_KIND_SCHEDULED, scheduledForMs: 1_700_000_000_000n, cronId: 'c1' } } }],
  [32, { backgroundTasksChanged: { tasks: [{ taskId: 'b1', kind: TaskKind.TASK_KIND_WORKFLOW, taskType: 'local_workflow', description: 'review', ambient: false, workflowName: 'wf' }] } }],
  [
    33,
    {
      taskEvent: {
        edge: TaskEdge.TASK_EDGE_PROGRESS,
        taskId: 'b1',
        status: TaskStatus.TASK_STATUS_PAUSED,
        usage: { totalTokens: 10n, toolUses: 2, durationMs: 300n },
        workflowProgress: { phases: [{ index: 0, title: 'Phase', kind: 'parallel' }], agents: [{ index: 0, label: 'a', phaseIndex: 0, state: 'running', tokens: 5n }] },
        task: undefined,
      },
    },
  ],
  [34, { sessionNotice: { kind: SessionNoticeKind.SESSION_NOTICE_KIND_RATE_LIMIT, level: NoticeLevel.NOTICE_LEVEL_WARNING, rateStatus: RateLimitStatus.RATE_LIMIT_STATUS_ALLOWED_WARNING, holdState: PeerHoldState.PEER_HOLD_STATE_HELD, errorKind: 'overloaded', fallbackScope: 'local' } }],
  [35, { conversationReset: { newConversationId: 'conv-2' } }],
  [40, { interactionRequested: { interactionId: 'i1', toolUseId: 'tu1', kind: InteractionKind.INTERACTION_KIND_QUESTION, questions: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } } }],
  [41, { interactionResolved: { interactionId: 'i1', outcome: InteractionOutcome.INTERACTION_OUTCOME_ANSWERED, answers: [{ questionIndex: 0, answer: 'A' }] } }],
];

for (const [tag, arm] of ARMS) {
  const name = Object.keys(arm)[0];
  test(`3.22: ${name} encodes at tag ${tag} and decodes to itself`, () => {
    // Only the arm is set, so it is the first key on the wire.
    const event = SessionEvent.fromPartial(arm);
    const bytes = SessionEvent.encode(event).finish();
    assert.equal(firstTag(bytes), tag);
    assert.deepEqual(SessionEvent.decode(bytes), event);
  });
}

test('3.22: an old client decodes an event with a new arm as an event with no arm, keeping the envelope', () => {
  for (const [, arm] of ARMS) {
    const bytes = SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's1', sequence: 7n, ...arm })).finish();
    const decoded = old.SessionEvent.decode(bytes);
    assert.equal(decoded.sessionId, 's1');
    assert.equal(decoded.sequence, 7n);
    assert.equal(decoded.turnStarted, undefined);
  }
});

// ---- Request fields before their features ---------------------------------------------------------------------------

const createdSessions: MinimalKernelSession[] = [];
after(async () => {
  for (const session of createdSessions) {
    session.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
});

function setup() {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const configs: ClaudeSessionConfigLike[] = [];
  const impl = createRuntimeServiceImpl(
    registry,
    (config) => {
      configs.push(config);
      const fake = makeFakeSession();
      made.push(fake);
      createdSessions.push(fake.session);
      return fake.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: '2.1.293' },
    { sdkBundledAvailable: true },
  );
  return { impl, made, configs };
}

type Handler = (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void;

function rpc<T>(fn: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => fn({ request }, (err, res) => (err ? reject(err) : resolve(res as T))));
}

function detailOf(err: grpc.ServiceError): ErrorDetail {
  return ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
}

function refusedWith(code: grpc.status, errorCode: ErrorCode, reason: string) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, code);
    const detail = detailOf(err);
    assert.equal(detail.code, errorCode);
    assert.equal(detail.reason, reason);
    return true;
  };
}

async function sessionOn(impl: ReturnType<typeof setup>['impl']): Promise<string> {
  const { sessionId } = await rpc<{ sessionId: string }>(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  return sessionId;
}

test('3.22: SendTurn passes client_message_id to the kernel, and passes no id when the request has none', async () => {
  const { impl, made } = setup();
  const sessionId = await sessionOn(impl);
  await rpc(impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'one', clientMessageId: 'm1', typedByPerson: false });
  await rpc(impl.sendTurn as Handler, { sessionId, commandId: 'c2', text: 'two', typedByPerson: false });
  assert.deepEqual(made[0].controller.sentTurns, ['one', 'two']);
  assert.deepEqual(made[0].controller.sentTurnOptions, [{ clientMessageId: 'm1' }, {}]);
});

test('3.22: SendTurn under one command_id replays with the same client_message_id and conflicts with another', async () => {
  const { impl, made } = setup();
  const sessionId = await sessionOn(impl);
  const first = await rpc<{ turnId: string }>(impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'one', clientMessageId: 'm1', typedByPerson: false });
  const again = await rpc<{ turnId: string }>(impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'one', clientMessageId: 'm1', typedByPerson: false });
  assert.deepEqual(again, first);
  await assert.rejects(
    rpc(impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'one', clientMessageId: 'm2', typedByPerson: false }),
    refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''),
  );
  await assert.rejects(
    rpc(impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'one', typedByPerson: false }),
    refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''),
  );
  assert.deepEqual(made[0].controller.sentTurns, ['one']);
});

for (const typedByPerson of [true, false, undefined]) {
  test(`3.22: both turn RPCs pass human origin when typed_by_person is ${typedByPerson}`, async () => {
    const { impl, made } = setup();
    const sessionId = await sessionOn(impl);
    const flag = typedByPerson === undefined ? {} : { typedByPerson };
    const send = { sessionId, commandId: 'c1', text: 'typed', ...flag };
    const { turnId } = await rpc<{ turnId: string }>(impl.sendTurn as Handler, send);
    await rpc(impl.sendTurn as Handler, send);
    assert.deepEqual(made[0].controller.sentTurns, ['typed']);
    const expected = typedByPerson === true ? { typedByPerson: true } : {};
    assert.deepEqual(made[0].controller.sentTurnOptions, [expected]);
    const steer = { sessionId, commandId: 's1', expectedTurnId: turnId, clientMessageId: 'm1', text: 'more', ...flag };
    await rpc(impl.steerTurn as Handler, steer);
    await rpc(impl.steerTurn as Handler, steer);
    assert.deepEqual(made[0].controller.steeredTurns, [{ expectedTurnId: turnId, clientMessageId: 'm1', text: 'more' }]);
    assert.deepEqual(made[0].controller.steeredTurnOptions, [expected]);
    for (const [handler, request] of [[impl.sendTurn, send], [impl.steerTurn, steer]] as const) {
      await assert.rejects(rpc(handler as Handler, { ...request, typedByPerson: typedByPerson !== true }),
        (err: grpc.ServiceError) => detailOf(err).code === ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
    }
  });
}

test('3.22: CreateSession takes per_task_stop and declares the per-task stop to the CLI only when it is true', async () => {
  const { impl, made, configs } = setup();
  for (const perTaskStop of [true, false]) {
    await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', policy: ClaudeHostPolicy.fromPartial({ perTaskStop }) }));
  }
  await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  assert.equal(made.length, 3);
  const options = configs.map((config) => buildSessionOptions(buildKernelSessionConfig(config)));
  assert.equal(options[0].perTaskStopAffordance, true);
  assert.equal('perTaskStopAffordance' in options[1], false, 'false leaves the option unset');
  assert.equal('perTaskStopAffordance' in options[2], false, 'absent leaves the option unset');
});

test('3.22: CreateSession takes client_interactions.questions on a session with provider prompts, and refuses it on any other', async () => {
  const { impl, made, configs } = setup();
  await assert.rejects(
    rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', clientInteractions: { questions: true } })),
    refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'client_interactions_needs_provider_prompts'),
  );
  assert.equal(made.length, 0);
  // Asked for on a session that can carry it, absent, or present asking for nothing: each a session, with
  // the opt-in carried to the kernel as it was sent.
  await rpc(
    impl.createSession as Handler,
    CreateSessionRequest.fromPartial({ cwd: '/tmp', policy: ClaudeHostPolicy.fromPartial({ providerPermissionPrompts: true }), clientInteractions: { questions: true } }),
  );
  await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', clientInteractions: { questions: false } }));
  assert.equal(made.length, 3);
  assert.deepEqual(buildKernelSessionConfig(configs[0]).clientInteractions, { questions: true });
  assert.equal('clientInteractions' in buildKernelSessionConfig(configs[1]), false);
  assert.deepEqual(buildKernelSessionConfig(configs[2]).clientInteractions, { questions: false });
});

const NEW_RPCS: Array<[name: string, request: unknown]> = [
  ['stopTask', StopTaskRequest.fromPartial({ sessionId: 's', commandId: 'c', taskId: 'b1' })],
  ['getTaskOutput', GetTaskOutputRequest.fromPartial({ sessionId: 's', taskId: 'b1' })],
];

test('3.22: the task RPCs reach the session: StopTask stops the named task, GetTaskOutput reads it', async () => {
  const { impl, made } = setup();
  const sessionId = await sessionOn(impl);
  made[0].controller.answerTaskOutput(async () => ({ output: new Uint8Array([104, 105]), totalBytes: 2, truncated: false }));
  for (const [name, request] of NEW_RPCS) {
    const handler = (impl as unknown as Record<string, Handler>)[name];
    assert.equal(typeof handler, 'function', name);
    await rpc(handler, { ...(request as object), sessionId });
  }
  assert.deepEqual(made[0].controller.stopTaskCalls, ['b1']);
  assert.deepEqual(made[0].controller.taskOutputCalls, ['b1']);
});

test('3.22: over a real socket the task RPCs answer, and their refusals reach the client with their codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol322-'));
  const socketPath = join(dir, 's.sock');
  const fakes: Array<ReturnType<typeof makeFakeSession>> = [];
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: () => {
      const fake = makeFakeSession();
      fakes.push(fake);
      return fake.session;
    },
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: 'fake' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  const call = <T>(name: string, request: unknown) =>
    new Promise<{ error: grpc.ServiceError | null; response?: T }>((resolve) =>
      (client as unknown as Record<string, (r: unknown, cb: (e: grpc.ServiceError | null, res?: T) => void) => void>)[name](request, (error, response) =>
        resolve({ error, response }),
      ),
    );
  try {
    const created = await call<{ sessionId: string }>('createSession', CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
    assert.equal(created.error, null);
    const sessionId = created.response!.sessionId;
    const controller = fakes[0].controller;
    // Unknown task: TASK_NOT_FOUND on both.
    controller.answerStopTask(async (taskId) => Promise.reject(new TaskNotFoundError(taskId)));
    for (const [name, request] of NEW_RPCS) {
      const { error } = await call(name, { ...(request as object), sessionId });
      assert.ok(error !== null, name);
      refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_TASK_NOT_FOUND, '')(error);
    }
    controller.answerTaskOutput(async (taskId) => Promise.reject(new TaskOutputUnavailableError(taskId, 'task_kind_has_no_output')));
    const unavailable = await call('getTaskOutput', GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'w1' }));
    assert.ok(unavailable.error !== null);
    refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_TASK_OUTPUT_UNAVAILABLE, '')(unavailable.error);
    // A refused stop recorded nothing: the same command id stops the task once the session can.
    controller.answerStopTask(async () => {});
    const stopped = await call('stopTask', StopTaskRequest.fromPartial({ sessionId, commandId: 'c', taskId: 'b1' }));
    assert.equal(stopped.error, null);
    // The tail's bytes go out as bytes, the total as a 64-bit count, the cut as its own flag.
    const tail = new Uint8Array([0xe2, 0x82, 0xac, 0x0a]).subarray(1);
    controller.answerTaskOutput(async () => ({ output: tail, totalBytes: 20000, truncated: true }));
    const read = await call<{ output: Buffer; totalBytes: bigint; truncated: boolean }>('getTaskOutput', GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1' }));
    assert.equal(read.error, null);
    assert.deepEqual([...read.response!.output], [0x82, 0xac, 0x0a]);
    assert.equal(read.response!.totalBytes, 20000n);
    assert.equal(read.response!.truncated, true);
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3.22: over a real socket a question is listed by GetInteractionState, answered by ResolveInteraction once, and then not found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol322-'));
  const socketPath = join(dir, 's.sock');
  const fakes: Array<ReturnType<typeof makeFakeSession>> = [];
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: (config) => {
      const fake = makeFakeSession({ questions: config.clientInteractions?.questions === true });
      fakes.push(fake);
      return fake.session;
    },
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: 'fake' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  const call = <T>(name: string, request: unknown) =>
    new Promise<T>((resolve, reject) =>
      (client as unknown as Record<string, (r: unknown, cb: (e: grpc.ServiceError | null, res: T) => void) => void>)[name](request, (error, res) =>
        error === null ? resolve(res) : reject(error),
      ),
    );
  try {
    const { sessionId } = await call<{ sessionId: string }>(
      'createSession',
      CreateSessionRequest.fromPartial({ cwd: '/tmp', policy: ClaudeHostPolicy.fromPartial({ providerPermissionPrompts: true }), clientInteractions: { questions: true } }),
    );
    const port = fakes[0].controller.interactions!;
    const answered = port.route(
      'AskUserQuestion',
      { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] },
      { signal: new AbortController().signal, toolUseID: 'toolu_1' },
    )!;
    const state = await call<{ throughSequence: bigint; pending: Array<{ interactionId: string; toolUseId: string; kind: InteractionKind }> }>(
      'getInteractionState',
      GetInteractionStateRequest.fromPartial({ sessionId }),
    );
    assert.equal(state.pending.length, 1);
    assert.equal(state.pending[0].toolUseId, 'toolu_1');
    assert.equal(state.pending[0].kind, InteractionKind.INTERACTION_KIND_QUESTION);
    const interactionId = state.pending[0].interactionId;
    const answer = ResolveInteractionRequest.fromPartial({ sessionId, commandId: 'c1', interactionId, answers: { answers: [{ questionIndex: 0, optionIndexes: [1] }] } });
    assert.deepEqual(await call('resolveInteraction', answer), { outcome: InteractionOutcome.INTERACTION_OUTCOME_ANSWERED });
    assert.deepEqual(await answered, { behavior: 'allow', updatedInput: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }], answers: { 'Which?': 'B' }, annotations: {} } });
    await assert.rejects(
      call('resolveInteraction', ResolveInteractionRequest.fromPartial({ sessionId, commandId: 'c2', interactionId, decline: { kind: QuestionDeclineKind.QUESTION_DECLINE_KIND_CANCEL } })),
      refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_INTERACTION_NOT_FOUND, ''),
    );
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The handshake ---------------------------------------------------------------------------------------------------

/** The capability rows as they were at protocol 3.21, the minor before this one, in order. */
const CAPABILITIES_AT_3_21: Array<[name: string, when?: 'egress_restricted' | 'sdk_bundled' | 'cli_message_lifecycle']> = [
  ['handshake'], ['create_session'], ['send_turn'], ['watch_session_events'], ['interrupt_turn'], ['resolve_permission'], ['close_session'],
  ['resume_session'], ['fork_session'], ['setting_sources'], ['tool_policy'], ['session_model'], ['session_effort'], ['system_prompt'],
  ['output_format'], ['structured_output'], ['turn_usage'], ['account_identity'], ['init_fingerprint'], ['tool_allow_list'],
  ['egress_restricted', 'egress_restricted'], ['set_permission_mode'], ['text_delta_message_id'], ['provider_permission_prompts'], ['init_check'],
  ['await_account_identity'], ['egress_probe'], ['structured_output_tools'], ['effective_tool_report'], ['cli_auto_mode'], ['permission_defer'],
  ['permission_denied_events'], ['cli_compatibility_report'], ['gated_cli_mode_default'], ['effective_claude_config_dir'], ['startup_report_file'],
  ['effective_session_report'], ['extra_mcp_servers'], ['extra_mcp_servers_http'], ['steer_turn', 'cli_message_lifecycle'], ['list_commands'],
  ['system_prompt_preset'], ['executable_host_cli'], ['executable_sdk_bundled', 'sdk_bundled'],
];

/** The capabilities protocol 3.22 introduces. Each is advertised only by the change that makes it work. */
const CAPABILITIES_OF_3_22 = [
  'cli_turns', 'human_origin', 'subagent_frames', 'background_tasks', 'workflow_progress', 'task_control', 'task_output', 'session_notices',
  'conversation_reset', 'structured_questions_v1',
];

test('3.22: the handshake reports minor 22, and apart from 3.22\'s own capabilities it lists exactly what 3.21 listed', () => {
  assert.equal(PROTOCOL_MINOR, 22);
  for (const egressRestricted of [false, true]) {
    for (const sdkBundledAvailable of [false, true]) {
      for (const cliMessageLifecycle of [false, true]) {
        const facts = { egressRestricted, sdkBundledAvailable, cliMessageLifecycle, taskOutputRead: true };
        const held = { egress_restricted: egressRestricted, sdk_bundled: sdkBundledAvailable, cli_message_lifecycle: cliMessageLifecycle };
        const before = CAPABILITIES_AT_3_21.filter(([, when]) => when === undefined || held[when]).map(([name]) => name);
        const advertised = handshakeCapabilities(facts);
        assert.deepEqual(advertised.filter((name) => !CAPABILITIES_OF_3_22.includes(name)), before, JSON.stringify(facts));
      }
    }
  }
});

test('3.22: of the minor\'s capabilities, only those whose behaviour works are advertised', () => {
  const advertised = handshakeCapabilities({ egressRestricted: true, sdkBundledAvailable: true, cliMessageLifecycle: true, taskOutputRead: true });
  assert.deepEqual(advertised.filter((name) => CAPABILITIES_OF_3_22.includes(name)), [
    'cli_turns', 'human_origin', 'subagent_frames', 'background_tasks', 'workflow_progress', 'task_control', 'task_output', 'session_notices',
    'conversation_reset', 'structured_questions_v1',
  ]);
  // A process that cannot read an output file safely does not claim to.
  const withoutRead = handshakeCapabilities({ egressRestricted: true, sdkBundledAvailable: true, cliMessageLifecycle: true, taskOutputRead: false });
  assert.deepEqual(advertised.filter((name) => name !== 'task_output'), withoutRead);
});

test('3.22: BackgroundTasksChanged with no tasks is an empty roster, not an absent one', () => {
  const bytes = SessionEvent.encode(SessionEvent.fromPartial({ backgroundTasksChanged: BackgroundTasksChanged.fromPartial({}) })).finish();
  assert.equal(firstTag(bytes), 32);
  assert.deepEqual(SessionEvent.decode(bytes).backgroundTasksChanged, { tasks: [] });
  assert.equal(TurnOrigin.TURN_ORIGIN_CLI, 3);
});
