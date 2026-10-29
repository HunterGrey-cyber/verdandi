import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';
import { CLI_MESSAGE_LIFECYCLE_CAPABILITY, createSession, SteerError, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };

/** A session on the fake query, plus a reader for what the session pushed into the SDK's input. */
function setup(options: FakeQueryOptions = {}) {
  const { query, controller } = makeFakeQuery(options);
  let input: AsyncIterator<SDKUserMessage> | undefined;
  const queryFn: QueryFn = (params) => {
    input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy: POLICY }, queryFn);
  /** The next message the session handed the SDK. */
  const nextInput = async (): Promise<SDKUserMessage> => {
    const next = await Promise.race([input!.next(), new Promise<'none'>((r) => setTimeout(() => r('none'), 200))]);
    assert.notEqual(next, 'none', 'the session sent nothing to the SDK');
    assert.ok(next !== 'none' && next.done !== true);
    return (next as IteratorResult<SDKUserMessage>).value as SDKUserMessage;
  };
  return { session, controller, nextInput };
}

/** `null`: an init with no `capabilities` field at all, as an older CLI sends. */
function init(capabilities: string[] | null = [CLI_MESSAGE_LIFECYCLE_CAPABILITY]) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'claude-1',
    model: 'claude-test',
    cwd: '/tmp/project',
    permissionMode: 'default',
    ...(capabilities === null ? {} : { capabilities }),
  } as never;
}

function result(extra: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', ...extra } as never;
}

function lifecycle(commandUuid: string, state: string) {
  // The frame as the CLI's print mode writes it: its own random `uuid`, the steered message's in
  // `command_uuid`.
  return { type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: '00000000-0000-4000-8000-000000000000', session_id: 'claude-1' } as never;
}

/** Every event the session produces until the fake has nothing more to give. A message emitted while
 * the session already waits on the fake's `next()` takes a few microtasks to settle, and `pump()`
 * never waits, so a single call can miss it. */
async function drain(session: ReturnType<typeof createSession>): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 1));
  }
  return events;
}

/** A session with a running turn whose CLI reported the lifecycle capability. */
async function running(options: FakeQueryOptions = {}) {
  const fixture = setup(options);
  const { turnId } = fixture.session.sendTurn('first');
  await fixture.nextInput();
  fixture.controller.emit(init());
  await drain(fixture.session);
  return { ...fixture, turnId };
}

const ofType = <T extends ClaudeRuntimeEvent['type']>(events: ClaudeRuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<ClaudeRuntimeEvent, { type: T }> => event.type === type);

// ---- Accepting and refusing ------------------------------------------------------------------------------

test('steerTurn mid-turn: the message goes to the CLI at once with priority next and a session uuid, and the turn stays in progress', async () => {
  const { session, nextInput, turnId } = await running();
  assert.deepEqual(session.steerTurn(turnId, 'client-1', 'also check the tests'), { turnId });
  const sent = await nextInput();
  assert.equal(sent.type, 'user');
  assert.equal(sent.priority, 'next');
  assert.deepEqual(sent.message, { role: 'user', content: 'also check the tests' });
  assert.equal(sent.parent_tool_use_id, null);
  assert.match(String(sent.uuid), /^[0-9a-f-]{36}$/);
  assert.notEqual(sent.uuid, 'client-1', 'the CLI gets the session\'s uuid, not the client\'s id');
  // The steer did not end or replace the turn.
  assert.throws(() => session.sendTurn('another'), /already in progress/);
});

test('steerTurn with no turn running is no_active_turn, and nothing reaches the CLI', async () => {
  const { session, controller } = setup();
  controller.emit(init());
  await drain(session);
  assert.throws(() => session.steerTurn('t', 'client-1', 'hello'), (err: unknown) => err instanceof SteerError && err.kind === 'no_active_turn');
  // After a turn ended, too.
  const { turnId } = session.sendTurn('first');
  controller.emit(result());
  await drain(session);
  assert.throws(() => session.steerTurn(turnId, 'client-2', 'hello'), (err: unknown) => err instanceof SteerError && err.kind === 'no_active_turn');
});

test('steerTurn naming a turn that is not the running one is turn_mismatch', async () => {
  const { session, turnId } = await running();
  assert.throws(
    () => session.steerTurn(`${turnId}-stale`, 'client-1', 'hello'),
    (err: unknown) => err instanceof SteerError && err.kind === 'turn_mismatch',
  );
  // The refused id was not used up.
  assert.doesNotThrow(() => session.steerTurn(turnId, 'client-1', 'hello'));
});

test('steerTurn refuses an unusable request with a reason', async () => {
  const { session, turnId } = await running();
  const refusedFor = (expected: string, client: string, text: string) => {
    try {
      session.steerTurn(expected, client, text);
    } catch (err) {
      assert.ok(err instanceof SteerError);
      assert.equal(err.kind, 'invalid');
      return err.reason;
    }
    assert.fail('accepted');
  };
  assert.equal(refusedFor(turnId, '', 'x'), 'steer_client_message_id_missing');
  assert.equal(refusedFor('', 'c', 'x'), 'steer_expected_turn_id_missing');
  assert.equal(refusedFor(turnId, 'c', '  \n'), 'steer_text_empty');
  session.steerTurn(turnId, 'c', 'x');
  assert.equal(refusedFor(turnId, 'c', 'y'), 'steer_client_message_id_reused');
});

test('steerTurn after close is closed', async () => {
  const { session, turnId } = await running();
  session.close();
  assert.throws(() => session.steerTurn(turnId, 'client-1', 'x'), (err: unknown) => err instanceof SteerError && err.kind === 'closed');
});

// ---- The capability gate ---------------------------------------------------------------------------------

test('gate: before any system/init, and after one without msg_lifecycle_v1, a steer is unavailable (cli_lifecycle_not_reported)', async () => {
  const { session, controller } = setup();
  const { turnId } = session.sendTurn('first');
  const unavailable = (err: unknown) => err instanceof SteerError && err.kind === 'unavailable' && err.reason === 'cli_lifecycle_not_reported';
  assert.throws(() => session.steerTurn(turnId, 'c1', 'x'), unavailable, 'no system/init read yet');
  controller.emit(init(['interrupt_receipt_v1']));
  await drain(session);
  assert.throws(() => session.steerTurn(turnId, 'c1', 'x'), unavailable, 'an init without the capability');
  controller.emit(init(null));
  await drain(session);
  assert.throws(() => session.steerTurn(turnId, 'c1', 'x'), unavailable, 'an init with no capabilities list (an older CLI)');
});

test('gate: the latest system/init decides, both ways', async () => {
  const { session, controller, turnId } = await running();
  assert.doesNotThrow(() => session.steerTurn(turnId, 'c1', 'x'));
  controller.emit(init([]));
  await drain(session);
  assert.throws(() => session.steerTurn(turnId, 'c2', 'x'), (err: unknown) => err instanceof SteerError && err.kind === 'unavailable');
  controller.emit(init());
  await drain(session);
  assert.doesNotThrow(() => session.steerTurn(turnId, 'c2', 'x'));
});

test('gate: a first turn held for the account probe cannot be steered (first_turn_held)', async () => {
  const { query } = makeFakeQuery({ accountInfo: () => new Promise(() => {}) });
  // An explicit empty allow list is completion-shaped: its first turn waits for the account.
  const session = createSession({ cwd: '/tmp/project', policy: { ...POLICY, toolPolicy: { allow: [] } }, accountInfoTimeoutMs: 60_000 }, () => query);
  const { turnId } = session.sendTurn('first');
  // No system/init can have come: the CLI has no message yet. The held turn is what refuses.
  assert.throws(
    () => session.steerTurn(turnId, 'c1', 'x'),
    (err: unknown) => err instanceof SteerError && err.kind === 'unavailable' && err.reason === 'first_turn_held',
  );
  session.close();
});

// ---- Fate events -----------------------------------------------------------------------------------------

test('lifecycle started before the result: delivered into the running turn, one result ends it', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'client-1', 'and the docs');
  const uuid = String((await nextInput()).uuid);
  controller.emit(lifecycle(uuid, 'queued'));
  controller.emit(lifecycle(uuid, 'started'));
  controller.emit(lifecycle(uuid, 'completed'));
  controller.emit(result({ queued_turn_count: 0 }));
  const events = await drain(session);
  assert.deepEqual(ofType(events, 'user_message_delivered'), [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId, intoRunningTurn: true }]);
  assert.deepEqual(ofType(events, 'turn_started'), [], 'no new turn');
  assert.deepEqual(ofType(events, 'turn_completed').map((event) => event.turnId), [turnId]);
  // Our frames are not passed on as notices.
  assert.deepEqual(ofType(events, 'provider_notice'), []);
  assert.doesNotThrow(() => session.sendTurn('next'));
});

test('a lifecycle frame for a message the session did not steer stays the notice it always was', async () => {
  const { session, controller } = await running();
  controller.emit(lifecycle('11111111-1111-4111-8111-111111111111', 'started'));
  const events = await drain(session);
  assert.deepEqual(
    events.map((event) => [event.type, event.type === 'provider_notice' ? event.kind : '']),
    [['provider_notice', 'command_lifecycle']],
  );
});

for (const state of ['discarded', 'refused', 'cancelled'] as const) {
  test(`lifecycle ${state}: dropped with that reason, exactly once, and later frames change nothing`, async () => {
    const { session, controller, nextInput, turnId } = await running();
    session.steerTurn(turnId, 'client-1', 'x');
    const uuid = String((await nextInput()).uuid);
    controller.emit(lifecycle(uuid, 'queued'));
    controller.emit(lifecycle(uuid, state));
    controller.emit(lifecycle(uuid, 'started'));
    const events = await drain(session);
    assert.deepEqual(ofType(events, 'user_message_dropped'), [{ type: 'user_message_dropped', clientMessageId: 'client-1', reason: state }]);
    assert.deepEqual(ofType(events, 'user_message_delivered'), []);
  });
}

test('a delivered message stays delivered when its turn is later cancelled', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'client-1', 'x');
  const uuid = String((await nextInput()).uuid);
  controller.emit(lifecycle(uuid, 'started'));
  controller.emit(lifecycle(uuid, 'cancelled'));
  const events = await drain(session);
  assert.equal(ofType(events, 'user_message_delivered').length, 1);
  assert.deepEqual(ofType(events, 'user_message_dropped'), []);
});

test('a result with queued_turn_count opens the follow-up turn; the steered message is delivered into it, and its result ends it', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'client-1', 'one more thing');
  const uuid = String((await nextInput()).uuid);
  controller.emit(lifecycle(uuid, 'queued'));
  controller.emit(result({ queued_turn_count: 1 }));
  const first = await drain(session);
  assert.deepEqual(first.map((event) => event.type), ['turn_completed', 'turn_started']);
  const followUp = ofType(first, 'turn_started')[0]!.turnId;
  assert.notEqual(followUp, turnId);
  assert.equal(ofType(first, 'turn_completed')[0]!.turnId, turnId);
  // The follow-up is the running turn: a SendTurn waits, a steer names it.
  assert.throws(() => session.sendTurn('x'), /already in progress/);
  assert.throws(() => session.steerTurn(turnId, 'client-2', 'x'), (err: unknown) => err instanceof SteerError && err.kind === 'turn_mismatch');

  controller.emit(init());
  controller.emit(lifecycle(uuid, 'started'));
  controller.emit({ type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null } as never);
  controller.emit(lifecycle(uuid, 'completed'));
  controller.emit(result({ queued_turn_count: 0 }));
  const second = await drain(session);
  assert.deepEqual(ofType(second, 'user_message_delivered'), [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId: followUp, intoRunningTurn: false }]);
  const text = ofType(second, 'text_delta');
  assert.ok(text.length === 0 || text.every((event) => event.turnId === followUp), 'the follow-up turn\'s output lands on it');
  assert.deepEqual(ofType(second, 'turn_completed').map((event) => event.turnId), [followUp]);
  assert.deepEqual(ofType(second, 'turn_started'), []);
  assert.doesNotThrow(() => session.sendTurn('free again'));
});

test('two steered messages coalesced into one follow-up turn are both delivered into it', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'a', 'x');
  const a = String((await nextInput()).uuid);
  session.steerTurn(turnId, 'b', 'y');
  const b = String((await nextInput()).uuid);
  controller.emit(result({ queued_turn_count: 2 }));
  controller.emit(lifecycle(a, 'started'));
  controller.emit(lifecycle(b, 'started'));
  const events = await drain(session);
  const followUp = ofType(events, 'turn_started')[0]!.turnId;
  assert.deepEqual(
    ofType(events, 'user_message_delivered').map((event) => [event.clientMessageId, event.turnId, event.intoRunningTurn]),
    [
      ['a', followUp, false],
      ['b', followUp, false],
    ],
  );
});

test('a result opens the follow-up turn whenever a steer is still pending, whatever queued_turn_count says', async () => {
  for (const extra of [{}, { queued_turn_count: 0 }]) {
    const { session, controller, nextInput, turnId } = await running();
    session.steerTurn(turnId, 'client-1', 'x');
    const uuid = String((await nextInput()).uuid);
    controller.emit(result(extra));
    const first = await drain(session);
    assert.deepEqual(first.map((event) => event.type), ['turn_completed', 'turn_started'], JSON.stringify(extra));
    const opened = ofType(first, 'turn_started')[0]!.turnId;
    controller.emit(lifecycle(uuid, 'started'));
    const second = await drain(session);
    assert.deepEqual(second, [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId: opened, intoRunningTurn: false }]);
  }
});

test('a started frame with no turn open still opens one (defensive: the CLI began a turn nothing announced)', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'client-1', 'x');
  const uuid = String((await nextInput()).uuid);
  controller.emit(result());
  controller.emit(lifecycle(uuid, 'cancelled'));
  await drain(session);
  // The message is settled; a stray started frame for it changes nothing.
  controller.emit(lifecycle(uuid, 'started'));
  assert.deepEqual(await drain(session), []);
});

// The race both reviews found: the steer reaches the CLI just after it built the turn's result, so the
// result does not count it. Before, nothing opened, a SendTurn was accepted, the CLI ran the steered
// message first, and the SendTurn's turn completed with the steered message's answer.
test('race: a steer the result did not count blocks SendTurn until it has run, and each answer lands on its own turn', async () => {
  const { session, controller, nextInput, turnId: t1 } = await running();
  session.steerTurn(t1, 's1', 'steer');
  const u = String((await nextInput()).uuid);
  controller.emit(result({ queued_turn_count: 0 }));
  const a = await drain(session);
  const followUp = ofType(a, 'turn_started')[0]!.turnId;
  assert.throws(() => session.sendTurn('second'), /already in progress/, 'SendTurn waits for the steered message');
  controller.emit(init());
  controller.emit(lifecycle(u, 'started'));
  controller.emit(result({ result: 'steer answer', queued_turn_count: 0 }));
  controller.emit(lifecycle(u, 'completed'));
  const b = await drain(session);
  assert.deepEqual(ofType(b, 'turn_completed').map((event) => [event.turnId, event.resultText]), [[followUp, 'steer answer']]);
  const { turnId: t2 } = session.sendTurn('second');
  await nextInput();
  controller.emit(result({ result: 'second answer' }));
  const c = await drain(session);
  assert.deepEqual(ofType(c, 'turn_completed').map((event) => [event.turnId, event.resultText]), [[t2, 'second answer']]);
});

test('race: an interrupted result that arrives before the receipt still opens the follow-up, so a SendTurn cannot take the survivor', async () => {
  let release!: (receipt: unknown) => void;
  const { session, controller, nextInput, turnId: t1 } = await running({ interrupt: () => new Promise((resolve) => (release = resolve)) });
  session.steerTurn(t1, 's1', 'x');
  const u = String((await nextInput()).uuid);
  const interrupted = session.interrupt();
  controller.emit(result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
  const a = await drain(session);
  assert.deepEqual(a.map((event) => event.type), ['turn_completed', 'turn_started']);
  const followUp = ofType(a, 'turn_started')[0]!.turnId;
  assert.throws(() => session.sendTurn('second'), /already in progress/);
  release({ still_queued: [u] });
  await interrupted;
  controller.emit(lifecycle(u, 'started'));
  const b = await drain(session);
  assert.deepEqual(b, [{ type: 'user_message_delivered', clientMessageId: 's1', turnId: followUp, intoRunningTurn: false }]);
});

test('a steer into a follow-up turn the CLI had not started yet is reported as a turn of its own', async () => {
  const { session, controller, nextInput, turnId: t1 } = await running();
  session.steerTurn(t1, 's1', 'x');
  const u1 = String((await nextInput()).uuid);
  controller.emit(result({ queued_turn_count: 1 }));
  const a = await drain(session);
  const followUp = ofType(a, 'turn_started')[0]!.turnId;
  session.steerTurn(followUp, 's2', 'y');
  const u2 = String((await nextInput()).uuid);
  controller.emit(lifecycle(u1, 'cancelled'));
  controller.emit(lifecycle(u2, 'started'));
  const b = await drain(session);
  assert.deepEqual(b, [
    { type: 'user_message_dropped', clientMessageId: 's1', reason: 'cancelled' },
    { type: 'user_message_delivered', clientMessageId: 's2', turnId: followUp, intoRunningTurn: false },
  ]);
  // Once something started it, a later steer into it is folded into a running turn.
  session.steerTurn(followUp, 's3', 'z');
  const u3 = String((await nextInput()).uuid);
  controller.emit(lifecycle(u3, 'started'));
  assert.deepEqual(await drain(session), [{ type: 'user_message_delivered', clientMessageId: 's3', turnId: followUp, intoRunningTurn: true }]);
});

test('a follow-up turn whose every message is dropped before it began ends as interrupted, and the session is free', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'client-1', 'x');
  const uuid = String((await nextInput()).uuid);
  controller.emit(result({ queued_turn_count: 1 }));
  controller.emit(lifecycle(uuid, 'cancelled'));
  const events = await drain(session);
  const followUp = ofType(events, 'turn_started')[0]!.turnId;
  assert.deepEqual(events.slice(-2), [
    { type: 'user_message_dropped', clientMessageId: 'client-1', reason: 'cancelled' },
    { type: 'turn_completed', turnId: followUp, outcome: 'interrupted', resultText: '', isError: false, stopReason: null },
  ]);
  assert.doesNotThrow(() => session.sendTurn('free again'));
});

// ---- Interrupts ------------------------------------------------------------------------------------------

test('interrupt: a steered message the CLI still holds runs as a follow-up turn opened at the interrupted result (the receipt is not needed)', async () => {
  for (const receipt of [undefined, { still_queued: [] as string[] }]) {
    const { session, controller, nextInput, turnId } = await running({ interrupt: async () => receipt });
    session.steerTurn(turnId, 'client-1', 'x');
    const uuid = String((await nextInput()).uuid);
    await session.interrupt();
    controller.emit(result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    controller.emit(lifecycle(uuid, 'started'));
    const events = await drain(session);
    assert.deepEqual(events.map((event) => event.type), ['turn_completed', 'turn_started', 'user_message_delivered']);
    assert.equal(ofType(events, 'turn_completed')[0]!.outcome, 'interrupted');
    const followUp = ofType(events, 'turn_started')[0]!.turnId;
    assert.deepEqual(ofType(events, 'user_message_delivered')[0], { type: 'user_message_delivered', clientMessageId: 'client-1', turnId: followUp, intoRunningTurn: false });
  }
});

test('interrupt: a follow-up the CLI has not started stays open (the held message still runs); its drop frees the session', async () => {
  const { session, controller, nextInput, turnId } = await running({ interrupt: async () => ({ still_queued: [] }) });
  session.steerTurn(turnId, 'client-1', 'x');
  const uuid = String((await nextInput()).uuid);
  controller.emit(result());
  await drain(session);
  await session.interrupt();
  assert.deepEqual(await drain(session), []);
  assert.throws(() => session.sendTurn('y'), /already in progress/);
  controller.emit(lifecycle(uuid, 'cancelled'));
  const events = await drain(session);
  assert.deepEqual(events.map((event) => event.type), ['user_message_dropped', 'turn_completed']);
  assert.doesNotThrow(() => session.sendTurn('y'));
});

// ---- Ordering of out-of-band events against what a waiting read returns ---------------------------------

/** A session whose pump() is already waiting on the fake's next(): the state in which an event made
 * outside pump() and a message read by that wait can come out in the wrong order. */
async function waitingRead(options: FakeQueryOptions = {}) {
  const fixture = setup(options);
  fixture.controller.emit(init());
  await drain(fixture.session); // leaves a next() in flight with nothing to return
  return fixture;
}

test('ordering: a sendTurn made while a pump() call is suspended comes out ahead of the turn\'s first message', async () => {
  const { session, controller } = await waitingRead();
  // The read settles first; pump() then runs synchronously up to its first await, and the sendTurn
  // happens while it is suspended there, before it resumes with what the read returned.
  controller.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } as never);
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  const inFlight = session.pump();
  const { turnId } = session.sendTurn('hi');
  const events = [...(await inFlight), ...(await drain(session))];
  // The CLI produced this output before it took the send in (no lifecycle frame says it started), so on a
  // CLI that reports lifecycles it is a cycle of the CLI's own inside the new turn, announced first.
  assert.deepEqual(events.map((event) => event.type).slice(0, 3), ['turn_started', 'cli_cycle_started', 'text_delta']);
  assert.equal(ofType(events, 'text_delta')[0]!.turnId, turnId);
});

for (const ticks of [0, 1, 2, 4, 8]) {
  for (const order of ['receipt-first', 'frame-first'] as const) {
    test(`ordering: an interrupt receipt landing while pump() waits on the steer's frame never puts turn_started after its fate (${order}, ${ticks} ticks)`, async () => {
      for (const state of ['started', 'cancelled'] as const) {
        let release!: (receipt: unknown) => void;
        const { session, controller, nextInput, turnId } = await running({ interrupt: () => new Promise((resolve) => (release = resolve)) });
        session.steerTurn(turnId, 's1', 'y');
        const u = String((await nextInput()).uuid);
        const interrupted = session.interrupt();
        controller.emit(result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
        const events = await drain(session);
        if (order === 'receipt-first') {
          release({ still_queued: [u] });
          for (let i = 0; i < ticks; i += 1) await Promise.resolve();
          controller.emit(lifecycle(u, state));
        } else {
          controller.emit(lifecycle(u, state));
          for (let i = 0; i < ticks; i += 1) await Promise.resolve();
          release({ still_queued: [u] });
        }
        events.push(...(await session.pump()));
        await interrupted;
        events.push(...(await drain(session)));
        const types = events.map((event) => event.type);
        const fate = state === 'started' ? 'user_message_delivered' : 'user_message_dropped';
        assert.ok(types.indexOf('turn_started') >= 0 && types.indexOf('turn_started') < types.indexOf(fate), `${state}: ${types.join(',')}`);
        assert.equal(types.filter((type) => type === 'turn_started').length, 1, `${state}: ${types.join(',')}`);
        assert.equal(types.filter((type) => type === 'turn_completed').length, state === 'started' ? 1 : 2, `${state}: ${types.join(',')}`);
      }
    });
  }
}

// ---- Session close ---------------------------------------------------------------------------------------

test('close: every steered message whose fate is unknown is dropped (session_closed) before the turn and the session end', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'delivered', 'x');
  const delivered = String((await nextInput()).uuid);
  session.steerTurn(turnId, 'pending', 'y');
  await nextInput();
  controller.emit(lifecycle(delivered, 'started'));
  await drain(session);
  session.close();
  const events = await drain(session);
  assert.deepEqual(events, [
    { type: 'user_message_dropped', clientMessageId: 'pending', reason: 'session_closed' },
    { type: 'turn_completed', turnId, outcome: 'failed', resultText: '', isError: true, stopReason: null },
    { type: 'session_closed', reason: 'closed_by_host' },
  ]);
});

test('the provider exiting drops undelivered steered messages the same way', async () => {
  const { session, controller, nextInput, turnId } = await running();
  session.steerTurn(turnId, 'pending', 'y');
  await nextInput();
  controller.end();
  const events = await drain(session);
  assert.deepEqual(ofType(events, 'user_message_dropped'), [{ type: 'user_message_dropped', clientMessageId: 'pending', reason: 'session_closed' }]);
  assert.equal(events.at(-1)?.type, 'session_closed');
});

// ---- The slash-command list ------------------------------------------------------------------------------

const COMMANDS: SlashCommand[] = [
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
];

async function pumpUntil(session: ReturnType<typeof createSession>, done: (events: ClaudeRuntimeEvent[]) => boolean): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 100 && !done(events); i += 1) {
    events.push(...(await drain(session)));
    await new Promise((r) => setTimeout(r, 1));
  }
  return events;
}

test('commands: the initialize answer becomes one commands_updated before any turn', async () => {
  const { session } = setup({ supportedCommands: async () => COMMANDS });
  const events = await pumpUntil(session, (seen) => seen.some(event => event.type !== 'background_tasks_changed'));
  assert.deepEqual(events, [
    { type: 'background_tasks_changed', tasks: [] },
    {
      type: 'commands_updated',
      source: 'initialize',
      commands: [
        { name: 'review', description: 'Review a pull request', argumentHint: '<pr>', aliases: [] },
        { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
      ],
    },
  ]);
});

test('commands: system/commands_changed replaces the list, and a later initialize answer is not sent over it', async () => {
  let answer!: (commands: SlashCommand[]) => void;
  const { session, controller } = setup({ supportedCommands: () => new Promise((resolve) => (answer = resolve)) });
  controller.emit({ type: 'system', subtype: 'commands_changed', commands: [COMMANDS[0]], uuid: 'u', session_id: 's' } as never);
  const changed = await drain(session);
  assert.deepEqual(changed, [{ type: 'background_tasks_changed', tasks: [] }, { type: 'commands_updated', source: 'changed', commands: [{ name: 'review', description: 'Review a pull request', argumentHint: '<pr>', aliases: [] }] }]);
  answer(COMMANDS);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await drain(session), []);
});

// Scans the microtask interleavings in which the initialize answer and the commands_changed frame can
// both become ready while one pump() call is already running.
for (const ticks of [0, 1, 2, 3, 4, 6, 8]) {
  for (const answerFirst of [true, false]) {
    test(`commands: an initialize answer settling inside the pump() that reads a commands_changed never comes out after it (${answerFirst ? 'answer' : 'frame'} first, ${ticks} ticks)`, async () => {
      let answer!: (commands: SlashCommand[]) => void;
      const { session, controller } = setup({ supportedCommands: () => new Promise((resolve) => (answer = resolve)) });
      await drain(session); // a next() in flight
      const changed = { type: 'system', subtype: 'commands_changed', commands: [COMMANDS[0]], uuid: 'u', session_id: 's' } as never;
      const first = answerFirst ? () => answer(COMMANDS) : () => controller.emit(changed);
      const second = answerFirst ? () => controller.emit(changed) : () => answer(COMMANDS);
      first();
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      second();
      const events = [...(await session.pump())];
      events.push(...(await drain(session)));
      const lists = ofType(events, 'commands_updated').map((list) => list.source);
      assert.equal(lists.at(-1), 'changed', `the newest list is the last one: ${lists.join(',')}`);
    });
  }
}

test('commands: entries without a usable name are skipped and missing fields default to empty', async () => {
  const { session } = setup({ supportedCommands: async () => [{ name: '' }, { description: 'nameless' }, null, { name: 'ok' }] as never });
  const events = await pumpUntil(session, (seen) => seen.some(event => event.type !== 'background_tasks_changed'));
  assert.deepEqual(events, [{ type: 'background_tasks_changed', tasks: [] }, { type: 'commands_updated', source: 'initialize', commands: [{ name: 'ok', description: '', argumentHint: '', aliases: [] }] }]);
});

test('commands: a failed or unreadable answer says so with a notice, and no list', async () => {
  const failed = setup({ supportedCommands: async () => Promise.reject(new Error('initialize failed')) });
  const a = await pumpUntil(failed.session, (seen) => seen.some(event => event.type !== 'background_tasks_changed'));
  assert.deepEqual(a.map((event) => [event.type, event.type === 'provider_notice' ? `${event.kind}/${event.subtype}` : '']), [['background_tasks_changed', ''], ['provider_notice', 'verdandi_commands/unavailable']]);
  const unreadable = setup({ supportedCommands: async () => 'not a list' as never });
  const b = await pumpUntil(unreadable.session, (seen) => seen.some(event => event.type !== 'background_tasks_changed'));
  assert.deepEqual(b.map((event) => [event.type, event.type === 'provider_notice' ? `${event.kind}/${event.subtype}` : '']), [['background_tasks_changed', ''], ['provider_notice', 'verdandi_commands/unreadable']]);
});

test('commands: an answer that arrives after the session ended is not sent', async () => {
  let answer!: (commands: SlashCommand[]) => void;
  const { session } = setup({ supportedCommands: () => new Promise((resolve) => (answer = resolve)) });
  session.close();
  await drain(session);
  answer(COMMANDS);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await drain(session), []);
});

test('commands: a query object without supportedCommands still makes a working session', async () => {
  const { query, controller } = makeFakeQuery();
  const bare = { ...query, supportedCommands: undefined } as never;
  // Rebuilt by hand: spreading loses the generator's own methods' `this`, so keep them bound.
  Object.assign(bare, { next: query.next.bind(query), return: query.return.bind(query), throw: query.throw.bind(query), [Symbol.asyncIterator]: () => bare });
  const session = createSession({ cwd: '/tmp/project', policy: POLICY }, () => bare);
  session.sendTurn('hi');
  controller.emit(result());
  const events = await drain(session);
  assert.deepEqual(events.map((event) => event.type), ['background_tasks_changed', 'turn_started', 'turn_completed']);
});
