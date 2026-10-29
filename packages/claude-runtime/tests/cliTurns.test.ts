import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLI_MESSAGE_LIFECYCLE_CAPABILITY, createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { makeFakeQuery } from './fakeQuery.js';
import { loadRecording } from './replay/recording.js';
import { drive } from './replay/drive.js';
import { NO_LIFECYCLE_FOR_SEND } from '../src/turnTracker.js';

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', streaming: 'partial' };

function setup() {
  const { query, controller } = makeFakeQuery();
  let input!: AsyncIterator<SDKUserMessage>;
  const queryFn: QueryFn = (params) => {
    input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query;
  };
  const log: string[] = [];
  const session = createSession({ cwd: '/tmp/project', policy: POLICY }, queryFn, { onDiagnostic: (line) => log.push(line) });
  const nextUuid = async () => {
    const next = await input.next();
    assert.equal(next.done, false);
    return String((next.value as SDKUserMessage).uuid);
  };
  return { session, controller, nextUuid, log };
}

async function drain(session: ReturnType<typeof createSession>): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(...(await session.pump()));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return events;
}

const init = (lifecycle: boolean) =>
  ({ type: 'system', subtype: 'init', session_id: 'cli-1', model: 'm', cwd: '/tmp/project', permissionMode: 'default', capabilities: lifecycle ? [CLI_MESSAGE_LIFECYCLE_CAPABILITY] : [] }) as never;
const state = (value: string) => ({ type: 'system', subtype: 'session_state_changed', state: value }) as never;
const requesting = () => ({ type: 'system', subtype: 'status', status: 'requesting' }) as never;
const text = (id: string, value: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: value }] } }) as never;
const lifecycle = (uuid: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'command_lifecycle', command_uuid: uuid, state: value, uuid: 'frame', session_id: 'cli-1', ...extra }) as never;
const taskStarted = (taskId: string) => ({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_bash', description: 'sleep 2' }) as never;
const notification = (taskId: string) => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary: 'done' }) as never;
const result = (extra: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: 'answer', stop_reason: 'end_turn', num_turns: 1, ...extra }) as never;
const woken = { kind: 'task-notification', producer: 'session-task' };

const ofType = <T extends ClaudeRuntimeEvent['type']>(events: ClaudeRuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<ClaudeRuntimeEvent, { type: T }> => event.type === type);

/** A session whose first client turn has run to its result, so the CLI is idle as far as the session knows. */
async function afterFirstTurn(lifecycleReported: boolean) {
  const fixture = setup();
  const { turnId } = fixture.session.sendTurn('first', { clientMessageId: 'c-first' });
  const uuid = await fixture.nextUuid();
  fixture.controller.emit(state('running'));
  if (lifecycleReported) fixture.controller.emit(lifecycle(uuid, 'started'));
  fixture.controller.emit(init(lifecycleReported));
  fixture.controller.emit(text('m1', 'first answer'));
  fixture.controller.emit(result({ user_message_uuids: [uuid] }));
  fixture.controller.emit(state('idle'));
  const events = await drain(fixture.session);
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => event.turnId), [turnId]);
  return fixture;
}

test('a woken turn: every frame carries the CLI turn\'s id, its cause is the task, and its answer never lands on the client\'s turn', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit(taskStarted('b1'));
  controller.emit(notification('b1'));
  controller.emit(state('running'));
  controller.emit(init(true));
  controller.emit(requesting());
  controller.emit(text('m2', 'the task finished'));
  controller.emit(result({ origin: woken }));
  controller.emit(state('idle'));
  const events = await drain(session);
  const started = ofType(events, 'turn_started');
  assert.equal(started.length, 1);
  const cli = started[0]!;
  assert.equal(cli.origin, 'cli');
  assert.deepEqual(cli.cause, { kind: 'task', taskId: 'b1', taskKind: 'shell', taskStatus: 'completed', description: 'sleep 2', summary: 'done' });
  assert.deepEqual(ofType(events, 'text_delta').map((event) => [event.turnId, event.text]), [[cli.turnId, 'the task finished']]);
  assert.deepEqual(
    ofType(events, 'turn_completed').map((event) => [event.turnId, event.resultText, event.originKind, event.numTurns]),
    [[cli.turnId, 'answer', 'task-notification', 1]],
  );
  // Task frames and status lines are still notices; nothing says a main-thread frame had no turn, and the
  // session-state frames are consumed.
  assert.deepEqual(
    ofType(events, 'provider_notice').filter((event) => event.subtype === 'no_turn_in_progress' || event.subtype === 'session_state_changed'),
    [],
  );
  // While it ran a send would have been refused; now the session is free.
  assert.doesNotThrow(() => session.sendTurn('next'));
});

test('a SendTurn while the CLI runs a turn of its own is refused, as for any open turn', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit(requesting());
  await drain(session);
  assert.throws(() => session.sendTurn('too early'), /already in progress/);
});

test('a cycle ahead of the message, with lifecycle: a cycle the CLI runs first is announced inside the turn, the message\'s take-in is delivered, the turn closes at the result naming it', async () => {
  const { session, controller, nextUuid } = await afterFirstTurn(true);
  controller.emit(taskStarted('b1'));
  controller.emit(notification('b1'));
  await drain(session);
  const { turnId } = session.sendTurn('my question', { clientMessageId: 'c-2' });
  const uuid = await nextUuid();
  controller.emit(lifecycle(uuid, 'queued'));
  controller.emit(state('running'));
  controller.emit(init(true));
  controller.emit(requesting());
  controller.emit(text('m2', 'the task finished'));
  controller.emit(result({ origin: woken }));
  controller.emit(lifecycle(uuid, 'started'));
  controller.emit(init(true));
  controller.emit(text('m3', 'your answer'));
  controller.emit(result({ user_message_uuids: [uuid], result: 'your answer' }));
  controller.emit(lifecycle(uuid, 'completed'));
  controller.emit(state('idle'));
  const events = await drain(session);
  assert.deepEqual(
    events.filter((event) => event.type !== 'session_ready' && event.type !== 'provider_notice').map((event) => event.type),
    ['turn_started', 'cli_cycle_started', 'text_delta', 'user_message_delivered', 'text_delta', 'turn_completed'],
  );
  assert.deepEqual(ofType(events, 'turn_started'), [{ type: 'turn_started', turnId, origin: 'client' }]);
  assert.deepEqual(ofType(events, 'cli_cycle_started'), [
    { type: 'cli_cycle_started', turnId, cause: { kind: 'task', taskId: 'b1', taskKind: 'shell', taskStatus: 'completed', description: 'sleep 2', summary: 'done' } },
  ]);
  assert.ok(ofType(events, 'text_delta').every((event) => event.turnId === turnId));
  assert.deepEqual(ofType(events, 'user_message_delivered'), [{ type: 'user_message_delivered', clientMessageId: 'c-2', turnId, intoRunningTurn: true }]);
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => [event.turnId, event.resultText]), [[turnId, 'your answer']]);
});

test('a cycle ahead of the message, with a drop: the dropped message is reported, and the turn ends at the cycle\'s result', async () => {
  const { session, controller, nextUuid } = await afterFirstTurn(true);
  const { turnId } = session.sendTurn('my question', { clientMessageId: 'c-2' });
  const uuid = await nextUuid();
  controller.emit(lifecycle(uuid, 'queued'));
  controller.emit(requesting());
  controller.emit(text('m2', 'woken work'));
  controller.emit(lifecycle(uuid, 'discarded'));
  const during = await drain(session);
  assert.deepEqual(ofType(during, 'user_message_dropped'), [{ type: 'user_message_dropped', clientMessageId: 'c-2', reason: 'discarded' }]);
  assert.deepEqual(ofType(during, 'turn_completed'), [], 'the cycle is still running');
  controller.emit(result({ origin: woken }));
  const after = await drain(session);
  assert.deepEqual(ofType(after, 'turn_completed').map((event) => event.turnId), [turnId]);
  assert.doesNotThrow(() => session.sendTurn('again'));
});

test('a message dropped while nothing runs ends its turn at once, completed with no reply', async () => {
  const { session, controller, nextUuid } = await afterFirstTurn(true);
  const { turnId } = session.sendTurn('/unknown-command', { clientMessageId: 'c-2' });
  const uuid = await nextUuid();
  controller.emit(lifecycle(uuid, 'refused'));
  const events = await drain(session);
  assert.deepEqual(events.slice(-2), [
    { type: 'user_message_dropped', clientMessageId: 'c-2', reason: 'refused' },
    { type: 'turn_completed', turnId, outcome: 'completed', resultText: '', isError: false, stopReason: null },
  ]);
});

test('a cycle ahead of the message, without lifecycle: no cycle is announced, the autonomous result does not close the turn, the next result does', async () => {
  const { session, controller, nextUuid } = await afterFirstTurn(false);
  const { turnId } = session.sendTurn('my question', { clientMessageId: 'c-2' });
  await nextUuid();
  controller.emit(init(false));
  controller.emit(requesting());
  controller.emit(text('m2', 'woken work'));
  controller.emit(result({ origin: woken }));
  const first = await drain(session);
  assert.deepEqual(ofType(first, 'cli_cycle_started'), []);
  assert.deepEqual(ofType(first, 'turn_completed'), []);
  assert.ok(ofType(first, 'text_delta').every((event) => event.turnId === turnId), 'labelled with the turn, as before');
  controller.emit(text('m3', 'your answer'));
  controller.emit(result({ result: 'your answer' }));
  const second = await drain(session);
  assert.deepEqual(ofType(second, 'turn_completed').map((event) => [event.turnId, event.resultText]), [[turnId, 'your answer']]);
});

test('a scheduled fire (a lifecycle started for a message nobody here sent) opens a CLI turn', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit(state('running'));
  controller.emit(lifecycle('fire-1', 'started', { wakeup_source: 'loop_wakeup' }));
  controller.emit(init(true));
  controller.emit(text('m2', 'scheduled work'));
  controller.emit(result());
  controller.emit(lifecycle('fire-1', 'completed'));
  controller.emit(state('idle'));
  const events = await drain(session);
  const started = ofType(events, 'turn_started');
  assert.deepEqual(started.map((event) => event.origin), ['cli']);
  assert.equal(events[0]!.type, 'turn_started', 'ahead of the frame that opened it');
  assert.deepEqual(ofType(events, 'text_delta').map((event) => event.turnId), [started[0]!.turnId]);
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => event.turnId), [started[0]!.turnId]);
});

/** A client turn whose own message the CLI took in, with one more message steered into it and still held. */
async function turnWithHeldSteer() {
  const fixture = await afterFirstTurn(true);
  const { turnId } = fixture.session.sendTurn('do it', { clientMessageId: 'c-2' });
  const uuid = await fixture.nextUuid();
  fixture.controller.emit(state('running'));
  fixture.controller.emit(lifecycle(uuid, 'started'));
  fixture.controller.emit(text('m2', 'working'));
  await drain(fixture.session);
  fixture.session.steerTurn(turnId, 's-1', 'and this');
  const steered = await fixture.nextUuid();
  fixture.controller.emit(lifecycle(steered, 'queued'));
  await drain(fixture.session);
  return { ...fixture, turnId, uuid, steered };
}

/** The held steered message runs: its answer lands on the reserved follow-up turn, which its result ends. */
async function heldSteerRuns(fixture: Awaited<ReturnType<typeof turnWithHeldSteer>>, followUp: string) {
  const { session, controller, steered } = fixture;
  controller.emit(lifecycle(steered, 'started'));
  controller.emit(text('m3', 'steered answer'));
  controller.emit(result({ user_message_uuids: [steered], result: 'steered answer' }));
  const events = await drain(session);
  assert.deepEqual(ofType(events, 'user_message_delivered'), [{ type: 'user_message_delivered', clientMessageId: 's-1', turnId: followUp, intoRunningTurn: false }]);
  assert.deepEqual(ofType(events, 'text_delta').map((event) => event.turnId), [followUp]);
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => [event.turnId, event.resultText]), [[followUp, 'steered answer']]);
  assert.doesNotThrow(() => session.sendTurn('free again'));
}

test('an idle that ends a turn without a result reserves the follow-up turn for a steered message still held, so a SendTurn cannot take its answer', async () => {
  const fixture = await turnWithHeldSteer();
  fixture.controller.emit(state('idle'));
  const events = await drain(fixture.session);
  assert.deepEqual(events.filter((event) => event.type === 'turn_completed' || event.type === 'turn_started').map((event) => [event.type, event.turnId]), [
    ['turn_completed', fixture.turnId],
    ['turn_started', ofType(events, 'turn_started')[0]?.turnId],
  ]);
  assert.equal(ofType(events, 'turn_completed')[0]?.terminalReason, 'no_result');
  const followUp = ofType(events, 'turn_started')[0]!;
  assert.equal(followUp.origin, 'follow_up');
  assert.throws(() => fixture.session.sendTurn('too early'), /already in progress/);
  await heldSteerRuns(fixture, followUp.turnId);
});

test('a client turn ended by its own message\'s drop reserves the follow-up turn for a steered message still held', async () => {
  const fixture = await afterFirstTurn(true);
  const { turnId } = fixture.session.sendTurn('do it', { clientMessageId: 'c-2' });
  const uuid = await fixture.nextUuid();
  fixture.controller.emit(lifecycle(uuid, 'queued'));
  await drain(fixture.session);
  fixture.session.steerTurn(turnId, 's-1', 'and this');
  const steered = await fixture.nextUuid();
  fixture.controller.emit(lifecycle(steered, 'queued'));
  fixture.controller.emit(lifecycle(uuid, 'discarded'));
  const events = await drain(fixture.session);
  assert.deepEqual(ofType(events, 'user_message_dropped'), [{ type: 'user_message_dropped', clientMessageId: 'c-2', reason: 'discarded' }]);
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => event.turnId), [turnId]);
  const followUp = ofType(events, 'turn_started')[0]!;
  assert.equal(followUp.origin, 'follow_up');
  assert.throws(() => fixture.session.sendTurn('too early'), /already in progress/);
  await heldSteerRuns({ ...fixture, turnId, uuid, steered }, followUp.turnId);
});

test('a never-reported send after an announced cycle: the result that closes its turn reports the message taken in', async () => {
  for (const closing of ['names it', 'user lane'] as const) {
    const { session, controller, nextUuid } = await afterFirstTurn(true);
    const { turnId } = session.sendTurn('my question', { clientMessageId: 'c-2' });
    const uuid = await nextUuid();
    controller.emit(text('m2', 'output ahead of any report on the message'));
    controller.emit(result(closing === 'names it' ? { user_message_uuids: [uuid] } : {}));
    const events = await drain(session);
    assert.deepEqual(
      events.filter((event) => ['cli_cycle_started', 'user_message_delivered', 'turn_completed'].includes(event.type)).map((event) => event.type),
      ['cli_cycle_started', 'user_message_delivered', 'turn_completed'],
      closing,
    );
    assert.deepEqual(ofType(events, 'user_message_delivered'), [{ type: 'user_message_delivered', clientMessageId: 'c-2', turnId, intoRunningTurn: true }], closing);
    assert.deepEqual(ofType(events, 'turn_completed').map((event) => event.turnId), [turnId], closing);
  }
});

test('an idle the CLI owes nothing ends a turn that never got a result', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit(state('running'));
  controller.emit(requesting());
  controller.emit(state('idle'));
  const events = await drain(session);
  const opened = ofType(events, 'turn_started')[0]!;
  assert.deepEqual(ofType(events, 'turn_completed'), [
    { type: 'turn_completed', turnId: opened.turnId, outcome: 'failed', resultText: '', isError: true, stopReason: null, terminalReason: 'no_result' },
  ]);
});

test('the hand-built never-reported send closes its turn at its result: without the capability, and with it listed but silent (logged once)', async () => {
  const recording = loadRecording('h-no-lifecycle', new URL('../../tests/fixtures/cli-turns/handbuilt/', import.meta.url));
  try {
    for (const listed of [false, true]) {
      const messages = structuredClone(recording.messages);
      if (listed) {
        for (const line of messages) {
          if (line.message.type === 'system' && line.message.subtype === 'init') line.message.capabilities = [CLI_MESSAGE_LIFECYCLE_CAPABILITY];
        }
      }
      const replay = await drive(messages, tmpdir());
      const started = ofType(replay.events, 'turn_started');
      assert.deepEqual(started.map((event) => event.origin), ['client'], String(listed));
      assert.deepEqual(ofType(replay.events, 'turn_completed').map((event) => event.turnId), [started[0]!.turnId], String(listed));
      assert.equal(replay.log.filter((line) => line === NO_LIFECYCLE_FOR_SEND).length, listed ? 1 : 0, String(listed));
    }
  } finally {
    recording.cleanup();
  }
});

test('a subagent\'s frame with no turn open opens nothing and keeps its parent and text', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'sub', content: [{ type: 'text', text: 'sub' }] } } as never);
  const events = await drain(session);
  assert.deepEqual(events, [{ type: 'text_delta', turnId: '', text: 'sub', messageId: 'sub', parentToolUseId: 'toolu_agent' }]);
  assert.doesNotThrow(() => session.sendTurn('free'));
});

test('scheduled fires keep their cause through a peer closing result; a source-less fire is unknown', async () => {
  for (const fire of [
    { type: 'command_lifecycle', command_uuid: 'wake', state: 'started', wakeup_source: 'loop_wakeup', scheduled_for: 123 },
    { type: 'system', subtype: 'scheduled_task_fire', wakeup_source: 'loop_wakeup', scheduled_for: 123 },
    { type: 'scheduled_task_fire', wakeup_source: 'schedule_wakeup' },
    { type: 'system', subtype: 'scheduled_task_fire' },
  ]) {
    const { session, controller } = await afterFirstTurn(true);
    controller.emit(fire as never);
    controller.emit(text('wake-answer', 'tick'));
    controller.emit(result({ origin: { kind: 'peer', name: 'peer', body: 'body' } }));
    const events = await drain(session);
    assert.equal(ofType(events, 'turn_started')[0]?.cause?.kind, 'wakeup_source' in fire ? 'scheduled' : 'unknown');
    assert.equal(ofType(events, 'turn_completed').length, 1);
    assert.equal(ofType(events, 'turn_cause_updated').length, 'wakeup_source' in fire ? 0 : 1);
  }
});

test('a peer cause is reported only at closing, with a character-safe bounded body', async () => {
  const { session, controller } = await afterFirstTurn(true);
  controller.emit(text('peer-answer', 'reply'));
  const opening = await drain(session);
  assert.equal(ofType(opening, 'turn_started')[0]?.cause?.kind, 'unknown');
  assert.deepEqual(ofType(opening, 'turn_cause_updated'), []);
  controller.emit(result({ origin: { kind: 'peer', name: 'sender', body: '😀'.repeat(2001) } }));
  const closing = await drain(session);
  assert.deepEqual(ofType(closing, 'turn_cause_updated')[0]?.cause, { kind: 'peer', peerName: 'sender', text: '😀'.repeat(2000) + '…' });
});

test('a scheduled cycle without result origin keeps the pending client turn open until its own message runs', async () => {
  const { session, controller, nextUuid } = await afterFirstTurn(true);
  const { turnId } = session.sendTurn('next', { clientMessageId: 'next' });
  const uuid = await nextUuid();
  controller.emit(lifecycle(uuid, 'queued'));
  controller.emit(lifecycle('wake', 'started', { wakeup_source: 'loop_wakeup', scheduled_for: 123 }));
  controller.emit(text('tick', 'tick'));
  controller.emit(result());
  controller.emit(state('idle'));
  const cycle = await drain(session);
  assert.deepEqual(ofType(cycle, 'cli_cycle_started'), [{ type: 'cli_cycle_started', turnId, cause: { kind: 'scheduled', wakeupSource: 'loop_wakeup', scheduledForMs: 123 } }]);
  assert.deepEqual(ofType(cycle, 'turn_completed'), []);
  controller.emit(lifecycle(uuid, 'started'));
  controller.emit(text('own', 'answer'));
  controller.emit(result({ user_message_uuids: [uuid] }));
  assert.deepEqual(ofType(await drain(session), 'turn_completed').map(e => e.turnId), [turnId]);
});
