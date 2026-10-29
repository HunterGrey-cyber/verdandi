import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createInteractionRpc } from '../src/interactionRpc.js';
import { SessionRegistry, type SessionEntry } from '../src/sessionRegistry.js';
import { PumpDriver } from '../src/pumpDriver.js';
import { SidecarError } from '../src/errorMapping.js';
import {
  ErrorCode,
  ErrorDetail,
  InteractionKind,
  InteractionOutcome,
  QuestionDeclineKind,
  ResolveInteractionRequest,
  type GetInteractionStateResponse,
  type InteractionRequested,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * ResolveInteraction and GetInteractionState against a session whose interaction port is the kernel's
 * own: a spent or foreign id is not found, a refused answer changes nothing, a command id replays its
 * first outcome, and the snapshot agrees with the event stream it names.
 */

const QUESTION = {
  questions: [
    { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'p' }, { label: 'SQLite', description: 's' }] },
    { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth', description: 'a' }, { label: 'Search', description: 's' }] },
  ],
};

function setup() {
  const registry = new SessionRegistry();
  const rpc = createInteractionRpc({
    requireEntry: (sessionId) => {
      const entry = registry.get(sessionId);
      if (entry === undefined) {
        throw new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, `no such session: ${sessionId}`);
      }
      return entry;
    },
  });
  const open = (sessionId: string, questions = true) => {
    const fake = makeFakeSession({ questions });
    const entry = registry.create(sessionId, fake.session, 64);
    const driver = new PumpDriver(entry, { onEvent: () => undefined, onTerminal: () => undefined });
    return { fake, entry, driver };
  };
  return { registry, rpc, open };
}

function call<T>(handler: (call: { request: never }, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => void, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => handler({ request: request as never }, (err, res) => (err ? reject(err) : resolve(res as T))));
}

function refusedWith(code: grpc.status, errorCode: ErrorCode, reason: string) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, code);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, errorCode);
    assert.equal(detail.reason, reason);
    return true;
  };
}

function ask(entry: SessionEntry, signal = new AbortController().signal): Promise<PermissionResult> {
  return entry.session.interactions()!.route('AskUserQuestion', QUESTION, { signal, toolUseID: 'toolu_q' })!;
}

async function state(rpc: ReturnType<typeof setup>['rpc'], sessionId: string): Promise<GetInteractionStateResponse> {
  return call<GetInteractionStateResponse>(rpc.getInteractionState, { sessionId });
}

const answer = (sessionId: string, commandId: string, interactionId: string, optionIndexes = [1]) =>
  ResolveInteractionRequest.fromPartial({ sessionId, commandId, interactionId, answers: { answers: [{ questionIndex: 0, optionIndexes }] } });

test('ResolveInteraction answers an open question, and the same id spent is not found', async () => {
  const { rpc, open } = setup();
  const { entry } = open('s1');
  const result = ask(entry);
  const [{ interactionId }] = (await state(rpc, 's1')).pending;
  assert.deepEqual(await call(rpc.resolveInteraction, answer('s1', 'c1', interactionId)), { outcome: InteractionOutcome.INTERACTION_OUTCOME_ANSWERED });
  assert.deepEqual(await result, { behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which database?': 'SQLite' }, annotations: {} } });
  await assert.rejects(call(rpc.resolveInteraction, answer('s1', 'c2', interactionId)), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_INTERACTION_NOT_FOUND, ''));
  await assert.rejects(call(rpc.resolveInteraction, answer('s1', 'c3', 'never-issued')), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_INTERACTION_NOT_FOUND, ''));
});

test('an id of another session is not found there, and a session without questions has none', async () => {
  const { rpc, open } = setup();
  const { entry } = open('s1');
  open('s2');
  open('plain', false);
  const result = ask(entry);
  const [{ interactionId }] = (await state(rpc, 's1')).pending;
  for (const other of ['s2', 'plain']) {
    await assert.rejects(call(rpc.resolveInteraction, answer(other, 'c1', interactionId)), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_INTERACTION_NOT_FOUND, ''), other);
  }
  assert.deepEqual((await state(rpc, 'plain')).pending, []);
  await assert.rejects(call(rpc.resolveInteraction, answer('gone', 'c1', interactionId)), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, ''));
  assert.equal((await state(rpc, 's1')).pending.length, 1, 'the question is untouched');
  entry.session.interactions()!.failAll('session_closed');
  await result;
});

test('a refused answer leaves the question waiting and records nothing under its command id', async () => {
  const { rpc, open } = setup();
  const { entry } = open('s1');
  const result = ask(entry);
  const [{ interactionId }] = (await state(rpc, 's1')).pending;
  const refusals: Array<[reason: string, request: ResolveInteractionRequest]> = [
    ['unknown_option_index', answer('s1', 'c1', interactionId, [7])],
    ['single_select_takes_one', answer('s1', 'c1', interactionId, [0, 1])],
    ['unknown_question_index', ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, answers: { answers: [{ questionIndex: 9, optionIndexes: [0] }] } })],
    ['notes_not_allowed', ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, answers: { answers: [{ questionIndex: 0, optionIndexes: [0], notes: 'n' }] } })],
    ['kind_mismatch', ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId })],
    ['kind_mismatch', ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, decline: { kind: QuestionDeclineKind.QUESTION_DECLINE_KIND_UNSPECIFIED } })],
    [
      'kind_mismatch',
      ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, decline: { kind: QuestionDeclineKind.QUESTION_DECLINE_KIND_CANCEL, soFar: { answers: [{ questionIndex: 0, optionIndexes: [0] }] } } }),
    ],
  ];
  for (const [reason, request] of refusals) {
    await assert.rejects(call(rpc.resolveInteraction, request), refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, reason), reason);
    assert.equal((await state(rpc, 's1')).pending.length, 1, `${reason}: still waiting`);
  }
  // Nothing was recorded under c1: a corrected answer with the same command id is a first call.
  assert.deepEqual(await call(rpc.resolveInteraction, answer('s1', 'c1', interactionId, [0])), { outcome: InteractionOutcome.INTERACTION_OUTCOME_ANSWERED });
  assert.equal(((await result) as { behavior: string }).behavior, 'allow');
});

test('ResolveInteraction replays its outcome under the same command id, even once spent, and a different payload conflicts', async () => {
  const { rpc, open } = setup();
  const { entry } = open('s1');
  const result = ask(entry);
  const [{ interactionId }] = (await state(rpc, 's1')).pending;
  const cancel = ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, decline: { kind: QuestionDeclineKind.QUESTION_DECLINE_KIND_CANCEL } });
  assert.deepEqual(await call(rpc.resolveInteraction, cancel), { outcome: InteractionOutcome.INTERACTION_OUTCOME_DECLINED });
  assert.deepEqual(await call(rpc.resolveInteraction, cancel), { outcome: InteractionOutcome.INTERACTION_OUTCOME_DECLINED });
  await assert.rejects(call(rpc.resolveInteraction, answer('s1', 'c1', interactionId)), refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''));
  assert.equal(((await result) as { interrupt?: boolean }).interrupt, true);
});

test('a chat request reports CHAT_REQUESTED and carries the answers so far to the model', async () => {
  const { rpc, open } = setup();
  const { entry } = open('s1');
  const result = ask(entry);
  const [{ interactionId }] = (await state(rpc, 's1')).pending;
  const chat = ResolveInteractionRequest.fromPartial({
    sessionId: 's1',
    commandId: 'c1',
    interactionId,
    decline: { kind: QuestionDeclineKind.QUESTION_DECLINE_KIND_CHAT, soFar: { answers: [{ questionIndex: 1, optionIndexes: [1, 0] }] } },
  });
  assert.deepEqual(await call(rpc.resolveInteraction, chat), { outcome: InteractionOutcome.INTERACTION_OUTCOME_CHAT_REQUESTED });
  const message = ((await result) as { message: string }).message;
  assert.ok(message.endsWith('- "Which database?"\n  (No answer provided)\n- "Which features?"\n  Answer: Auth, Search'), message);
});

test('GetInteractionState lists the open question while it waits and nothing once it is settled, each at a through_sequence the stream agrees with', async () => {
  const { rpc, open } = setup();
  const { entry, driver } = open('s1');
  assert.deepEqual(await state(rpc, 's1'), { throughSequence: 0n, pending: [] });
  const result = ask(entry);

  // Asked but not yet sequenced: listed, at a sequence below the event that announces it.
  const early = await state(rpc, 's1');
  assert.equal(early.throughSequence, 0n);
  assert.equal(early.pending.length, 1);
  await driver.tick();
  const live = await state(rpc, 's1');
  assert.equal(live.throughSequence, entry.sequence);
  const replay = entry.ringBuffer.replay({ mode: 'available_history' });
  assert.equal(replay.kind, 'ok');
  const requested = replay.kind === 'ok' ? replay.events.find((e) => e.event.type === 'interaction_requested') : undefined;
  assert.ok(requested !== undefined && requested.sequence <= live.throughSequence, 'the announcing event is within the snapshot');
  const listed: InteractionRequested = live.pending[0];
  assert.equal(listed.kind, InteractionKind.INTERACTION_KIND_QUESTION);
  assert.equal(listed.toolUseId, 'toolu_q');
  assert.deepEqual(
    listed.questions!.questions.map((question) => [question.question, question.multiSelect, question.options.map((option) => option.label)]),
    [['Which database?', false, ['Postgres', 'SQLite']], ['Which features?', true, ['Auth', 'Search']]],
  );
  assert.equal(listed.interactionId, (requested!.event as { interactionId: string }).interactionId);

  await call(rpc.resolveInteraction, answer('s1', 'c1', listed.interactionId));
  await result;
  // Settled but not yet sequenced: no longer listed, and the settlement comes after through_sequence.
  const settledEarly = await state(rpc, 's1');
  assert.deepEqual(settledEarly.pending, []);
  await driver.tick();
  const after = await state(rpc, 's1');
  assert.deepEqual(after.pending, []);
  const events = entry.ringBuffer.replay({ mode: 'after_sequence', afterSequence: settledEarly.throughSequence });
  assert.equal(events.kind, 'ok');
  const resolvedEvents = events.kind === 'ok' ? events.events.filter((e) => e.event.type === 'interaction_resolved') : [];
  assert.equal(resolvedEvents.length, 1, 'the settlement is in the ring after the snapshot it was missing from');
  assert.equal(after.throughSequence, entry.sequence);
});

test('both interaction events are in the replay ring, in order, for a question refused at once as for one answered', async () => {
  const { open } = setup();
  const { entry, driver } = open('s1');
  const refused = await entry.session.interactions()!.route('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal })!;
  assert.equal((refused as { behavior: string }).behavior, 'deny');
  const answered = ask(entry);
  const id = entry.session.interactions()!.pending()[0].interactionId;
  entry.session.interactions()!.resolve(id, { kind: 'answers', answers: [] });
  await answered;
  await driver.tick();
  const replay = entry.ringBuffer.replay({ mode: 'available_history' });
  assert.equal(replay.kind, 'ok');
  const kinds = replay.kind === 'ok' ? replay.events.map((e) => [e.sequence, e.event.type, (e.event as { outcome?: string }).outcome]) : [];
  assert.deepEqual(kinds, [
    [1n, 'interaction_requested', undefined],
    [2n, 'interaction_resolved', 'host_refused'],
    [3n, 'interaction_requested', undefined],
    [4n, 'interaction_resolved', 'answered'],
  ]);
});
