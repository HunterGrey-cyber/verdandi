import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as old from './b3aa188/generated/runtime.js';
import { SteerTurnRequest, SteerTurnResponse } from '../../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { withHarness, type Harness, type Watcher } from './harness.js';

/**
 * What a host relies on past the wire, in-process half. These are behaviours of the sidecar that no
 * message in `runtime.proto` states and that a host nevertheless builds on: a window that hands a chat to
 * another window, for one, watches from two connections, resolves a request on the second, and replays
 * from a cursor out of the sidecar's ring. The proto checks cannot see any of them move, so each one has
 * a test here that fails when it breaks. `crates/claude-runtime-protocol/COMPATIBILITY.md`, "What a host
 * relies on past the wire", lists them with the test names; the process-level ones (exit conditions, the
 * variables a host sets and removes) are `hostReliance.process.test.ts`.
 *
 * Same set-up as the old-client suite: the real sidecar and kernel on a unix socket, the SDK scripted.
 */

function watchRequest(sessionId: string, cursor: bigint): old.WatchSessionEventsRequest {
  return old.WatchSessionEventsRequest.fromPartial({ sessionId, start: old.ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: cursor });
}

/** A session, a watch from cursor 0, and a turn the CLI is now in (the old-client suite's `startTurn`). */
async function startTurn(h: Harness): Promise<{ sid: string; watch: Watcher; turnId: string }> {
  const sid = await h.createGolden('create_session_fresh_partial');
  const watch = h.watch(watchRequest(sid, 0n));
  const { turnId } = await h.sendTurn(sid, 'hello');
  assert.equal(await h.sdk.last.nextUserMessage(), 'hello');
  h.sdk.last.init();
  return { sid, watch, turnId };
}

const textOf = (watch: Watcher): string => watch.of('textDelta').map((delta) => delta.text).join('');

// ---- Several watchers per session --------------------------------------------------------------

test('several watchers per session: every one is sent every event, and ending one touches neither the session nor the others', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch: first } = await startTurn(h);
    const second = h.watch(watchRequest(sid, 0n));
    const third = h.watch(old.WatchSessionEventsRequest.fromPartial({ sessionId: sid, start: old.ReplayStart.REPLAY_START_AVAILABLE_HISTORY }));
    const provider = h.sdk.last;

    provider.streamStart('msg_A');
    provider.streamText('one ');
    for (const each of [first, second, third]) {
      assert.ok(await each.until(() => textOf(each) === 'one '), `a watcher missed the first delta; it saw ${textOf(each)}`);
    }

    // One watch ends the way a window's does when it hands the chat over: the others and the session go on.
    first.cancel();
    provider.streamText('two ');
    provider.assistant('msg_A', [{ type: 'text', text: 'one two ' }]);
    provider.result({ text: 'one two ' });
    for (const each of [second, third]) {
      assert.ok(await each.until(() => each.of('turnCompleted').length === 1), 'a watcher that was never cancelled stopped receiving events when another was');
      assert.equal(textOf(each), 'one two ');
    }
    assert.equal(first.error, undefined, 'ending a watch is not an error on that watch');

    // The same events, to the byte, in the same order.
    assert.deepEqual(
      second.encoded.map((bytes) => bytes.toString('hex')),
      third.encoded.map((bytes) => bytes.toString('hex')),
    );
    assert.deepEqual(
      second.events.map((event) => event.sequence),
      second.events.map((_, index) => BigInt(index + 1)),
    );

    // The session still takes a turn, and a watcher that comes later is sent the next one live.
    const late = h.watch(watchRequest(sid, second.events.at(-1)!.sequence));
    const next = await h.sendTurn(sid, 'and then');
    assert.ok(next.turnId.length > 0);
    for (const each of [second, third, late]) {
      assert.ok(await each.until(() => each.of('turnStarted').some((started) => started.turnId === next.turnId)), 'a watcher did not see the next turn start');
    }
    for (const each of [second, third, late]) {
      each.cancel();
    }
  });
});

// ---- ResolvePermission from any connection ----------------------------------------------------

test('ResolvePermission from any connection: a request shown to one connection is answered by another, after the first has let go, and a repeat is idempotent', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    const ask = provider.ask('Bash', { command: 'ls' }, 'toolu_1');
    assert.ok(await watch.until(() => watch.of('permissionRequested').length === 1));
    const requested = watch.of('permissionRequested')[0];

    // The watching connection lets go entirely: the request belongs to the session, not to it.
    watch.cancel();
    h.client.close();

    const other = h.connect();
    const resolve = (commandId: string): Promise<old.ResolvePermissionResponse> =>
      new Promise((ok, fail) => {
        other.resolvePermission(
          old.ResolvePermissionRequest.fromPartial({ sessionId: sid, commandId, permissionId: requested.permissionId, allow: true }),
          (error, response) => (error ? fail(error) : ok(response)),
        );
      });
    await resolve('from-another-connection');
    const answer = await ask.result;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'allow', 'the CLI was told what the second connection decided');

    // The same command id again, from a third connection: the first answer is replayed, nothing new happens.
    const third = h.connect();
    await new Promise<void>((ok, fail) => {
      third.resolvePermission(
        old.ResolvePermissionRequest.fromPartial({ sessionId: sid, commandId: 'from-another-connection', permissionId: requested.permissionId, allow: true }),
        (error) => (error ? fail(error) : ok()),
      );
    });

    // The turn ends after the repeat, so a replay that reaches the end marker has read past everything the
    // repeat could have put in the ring: a second PermissionResolved would sit before it and be counted.
    provider.result({ text: 'done' });

    // And a watcher on yet another connection reads the outcome from the replay.
    const reader = new Promise<old.SessionEvent[]>((ok, fail) => {
      const events: old.SessionEvent[] = [];
      const call = other.watchSessionEvents(watchRequest(sid, 0n));
      call.on('data', (event: old.SessionEvent) => {
        events.push(event);
        if (event.turnCompleted !== undefined) {
          call.cancel();
          ok(events);
        }
      });
      call.on('error', (error: { code?: number }) => {
        if (error.code !== 1) {
          fail(error);
        }
      });
    });
    const events = await reader;
    assert.equal(events.filter((event) => event.permissionResolved !== undefined).length, 1, 'the request was resolved once, however often the answer was sent');
    assert.equal(events.find((event) => event.permissionResolved !== undefined)!.permissionResolved!.outcome, old.PermissionOutcome.PERMISSION_OUTCOME_ALLOWED);
  });
});

// ---- Replay out of the ring ---------------------------------------------------------------------

test('replay from after_sequence comes out of a ring of at least the size event_buffer_policy reports, and that is at least 1,000 events', async () => {
  await withHarness({}, async (h) => {
    const policy = (await h.handshake()).eventBufferPolicy;
    const reported = /^bounded-(\d+)$/.exec(policy);
    assert.ok(reported !== null, `event_buffer_policy is "bounded-<events>", saw ${JSON.stringify(policy)}`);
    const capacity = Number(reported[1]);
    assert.ok(capacity >= 1000, `a host that moves a chat replays up to 500 events past its fold and needs the rest of the ring to cover the move itself; ${capacity} is too few`);

    // Fill the ring: at least `capacity` events, produced in steps the live watch can keep up with.
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    provider.streamStart('msg_A');
    const last = (): number => Number(watch.events.at(-1)?.sequence ?? 0n);
    while (last() < capacity) {
      const before = last();
      const step = Math.min(50, capacity - before);
      for (let i = 0; i < step; i += 1) {
        provider.streamText('x');
      }
      assert.ok(await watch.until(() => last() >= before + step, 30_000), `the stream stopped at sequence ${last()} of ${capacity}`);
    }
    // Events still in flight when the loop stopped have landed once the newest sequence holds still.
    for (let steady = 0, seen = -1; steady < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      steady = last() === seen ? steady + 1 : 0;
      seen = last();
    }
    const newest = last();
    assert.ok(newest >= capacity);

    // The ring holds `capacity` events: everything from `newest - capacity` on is still there, dense, with no EVENT_GAP.
    const whole = h.watch(watchRequest(sid, BigInt(newest - capacity)));
    assert.ok(await whole.until(() => whole.events.length >= capacity, 30_000), `replay gave ${whole.events.length} of ${capacity} events (${whole.error?.message ?? 'no error'})`);
    assert.equal(whole.error, undefined);
    assert.deepEqual(
      whole.events.slice(0, capacity).map((event) => event.sequence),
      Array.from({ length: capacity }, (_, index) => BigInt(newest - capacity + 1 + index)),
    );
    // And from 500 events back, as a handed-over chat asks.
    const tail = h.watch(watchRequest(sid, BigInt(newest - 500)));
    assert.ok(await tail.until(() => tail.events.length >= 500, 30_000));
    assert.equal(tail.events[0].sequence, BigInt(newest - 499));
    for (const each of [watch, whole, tail]) {
      each.cancel();
    }
  });
});

// ---- Steered messages ----------------------------------------------------------------------------

test('steered messages are queued for the CLI in the order they are answered: a message is in the CLI\'s input before its SteerTurn is answered', async () => {
  await withHarness({}, async (h) => {
    assert.ok((await h.handshake()).capabilities.includes('steer_turn'), 'this sidecar advertises steer_turn for a CLI that reports message lifecycles');
    const sid = await h.createGolden('create_session_fresh_partial');
    const watch = h.watch(watchRequest(sid, 0n));
    const { turnId } = await h.sendTurn(sid, 'hello');
    const provider = h.sdk.last;
    assert.equal(await provider.nextUserMessage(), 'hello');
    // The CLI says it reports message lifecycles in its system/init; a session steers only after that.
    provider.init({ capabilities: ['msg_lifecycle_v1'] });
    provider.streamStart('msg_A');
    assert.ok(await watch.until(() => watch.of('sessionReady').length >= 1));

    // Each request goes out as soon as the previous one is answered, and the check at that moment has no wait
    // in it: a sidecar that answers first and queues a moment later fails it.
    const steered = ['first', 'second', 'third', 'fourth'];
    for (const [index, text] of steered.entries()) {
      const request = SteerTurnRequest.fromPartial({ sessionId: sid, commandId: `steer-${index}`, expectedTurnId: turnId, clientMessageId: `m${index}`, text });
      const response = SteerTurnResponse.decode(await h.raw('SteerTurn', Buffer.from(SteerTurnRequest.encode(request).finish())));
      assert.equal(response.turnId, turnId, 'a steered message goes into the running turn');
      // Answered means queued: the CLI's input already holds this message, and every earlier one before it.
      assert.deepEqual(provider.userMessages, ['hello', ...steered.slice(0, index + 1)], `message ${index} was answered but is not in the CLI's input`);
    }
    watch.cancel();
  });
});
