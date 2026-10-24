import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl, type RuntimeServiceOptions } from '../src/runtimeServiceImpl.js';
import { makeFakeSession } from './fakeSession.js';
import { ErrorCode, ErrorDetail, ReplayStart } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/**
 * The write-queue bound (PACKAGING.md section 6), against a fake call that holds messages the way
 * grpc-js does.
 *
 * grpc-js's server-streaming call is an objectMode Node `Writable`: `writableLength` is how many
 * messages were handed to `write()` and not yet taken by HTTP/2, `write()` answers
 * `writableLength < 16`, and nothing leaves the queue unless the transport takes it. The fake below
 * models exactly that, with the transport under the test's control: `stall()` stops it taking
 * anything, `flush(n)` lets n messages through. That makes "exactly at the bound" a statement about
 * a number this test sets, not about how fast a socket happens to drain on a loaded machine.
 * `writeQueueGrowth.test.ts` is the same policy over a real socket.
 */

const created: MinimalKernelSession[] = [];
after(async () => {
  for (const session of created) {
    session.close();
  }
  await new Promise((r) => setTimeout(r, 100));
});

function setup(options: RuntimeServiceOptions = {}) {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const diagnostics: string[] = [];
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      const m = makeFakeSession();
      made.push(m);
      created.push(m.session);
      return m.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
    { onDiagnostic: (line) => diagnostics.push(line), ...options },
  );
  return { registry, impl, made, diagnostics };
}

function call<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

/** Waits for a condition rather than for a length of time, so a slow machine makes the test slower
 * and never makes it fail. The deadline only turns a real hang into a readable failure. */
async function waitFor(what: string, condition: () => boolean, deadlineMs = 20_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OBJECT_MODE_HIGH_WATER_MARK = 16;

function watchCall(sessionId: string, start: ReplayStart, afterSequence?: bigint) {
  const written: Array<{ sequence: bigint; [key: string]: unknown }> = [];
  const listeners = new Map<string, Array<() => void>>();
  // The callbacks of the messages the transport has not taken, oldest first: `writableLength` is
  // their count.
  const heldCallbacks: Array<() => void> = [];
  let stalled = false;
  let finishedBy: 'end' | 'error' | undefined;
  let error: grpc.ServiceError | undefined;
  let endCalls = 0;
  let errorCalls = 0;
  let writesAfterFinish = 0;
  const fire = (event: string) => {
    for (const listener of listeners.get(event) ?? []) {
      listener();
    }
  };
  const c = {
    request: { sessionId, start, afterSequence },
    write: (chunk: unknown, callback: () => void = () => {}): boolean => {
      if (finishedBy !== undefined) {
        writesAfterFinish += 1;
      }
      written.push(chunk as (typeof written)[number]);
      if (stalled) {
        heldCallbacks.push(callback);
      } else {
        // Node defers a callback whose write completed synchronously to the next tick.
        process.nextTick(callback);
      }
      return heldCallbacks.length < OBJECT_MODE_HIGH_WATER_MARK;
    },
    get writableLength(): number {
      return heldCallbacks.length;
    },
    end: () => {
      endCalls += 1;
      finishedBy ??= 'end';
    },
    destroy: () => {
      throw new Error('destroy() delivers nothing to a real client; the handler must not use it');
    },
    // A real stream runs its own 'error' listeners when an error is emitted, and the handler relies
    // on that for cleanup, so the fake does too.
    emit: (_event: 'error', err: grpc.ServiceError) => {
      errorCalls += 1;
      error = err;
      finishedBy ??= 'error';
      fire('error');
    },
    on: (event: string, listener: () => void): void => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };
  return {
    call: c,
    written,
    sequences: () => written.map((e) => e.sequence),
    stall: () => {
      stalled = true;
    },
    /** Lets the transport take n held messages (all of them by default), as a reader catching up does. */
    flush: (n = heldCallbacks.length) => {
      for (const callback of heldCallbacks.splice(0, n)) {
        callback();
      }
    },
    /** Lets the transport take messages again as they come, like a reader that resumed. */
    resume: () => {
      stalled = false;
    },
    held: () => heldCallbacks.length,
    error: () => error,
    errorCode: () => {
      const bytes = error?.metadata?.get('grpc-status-details-bin')[0];
      return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer).code;
    },
    endCalls: () => endCalls,
    errorCalls: () => errorCalls,
    writesAfterFinish: () => writesAfterFinish,
  };
}

function delta(i: number) {
  return { type: 'text_delta', turnId: 't1', text: `chunk-${i}` } as never;
}

async function sessionWithTwoWatchers(capacity: number) {
  const env = setup({ ringBufferCapacity: capacity });
  const { sessionId } = await call<{ sessionId: string }>(env.impl.createSession.bind(env.impl), { cwd: '/tmp', policy: {} });
  const { controller } = env.made[0]!;
  const stalled = watchCall(sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  const healthy = watchCall(sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  env.impl.watchSessionEvents(stalled.call);
  env.impl.watchSessionEvents(healthy.call);
  stalled.stall();
  let emitted = 0;
  /** One pump tick's worth of events: all queued before the PumpDriver next drains, so they reach
   * the watchers in one burst, and back only once the healthy watcher has them all. */
  const tick = async (events: unknown[]) => {
    for (const event of events) {
      controller.emit(event as never);
    }
    emitted += events.length;
    await waitFor(`the healthy watcher to receive ${emitted} events`, () => healthy.written.length === emitted);
  };
  const deltas = (n: number) => Array.from({ length: n }, (_, i) => delta(emitted + i));
  return { ...env, sessionId, controller, stalled, healthy, tick, deltas };
}

test('a stalled watcher is ended with EVENT_GAP exactly when the messages it holds from earlier ticks reach the ring capacity', async () => {
  const CAPACITY = 8;
  const { stalled, healthy, diagnostics, registry, sessionId, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);

  await tick(deltas(CAPACITY - 1));
  await tick(deltas(1));
  assert.equal(stalled.held(), CAPACITY);
  assert.equal(stalled.error(), undefined, 'it held one below the bound when that event came, so it was written');

  await tick(deltas(1));
  assert.equal(stalled.error()?.code, grpc.status.OUT_OF_RANGE);
  assert.equal(stalled.errorCode(), ErrorCode.ERROR_CODE_EVENT_GAP);
  assert.match(stalled.error()!.message, /reconnect with after_sequence/i);
  assert.equal(stalled.written.length, CAPACITY, 'the event that met a full queue is not queued behind it');
  assert.equal(stalled.held(), CAPACITY);
  const ended = diagnostics.filter((l) => l.includes('ended a watcher'));
  assert.equal(ended.length, 1);
  assert.match(ended[0]!, new RegExp(`outstanding=${CAPACITY} reached the replay ring capacity ${CAPACITY}`));

  // Nothing more is written to it, and the session and its other watcher are untouched.
  await tick(deltas(CAPACITY * 2));
  assert.equal(stalled.written.length, CAPACITY);
  assert.equal(stalled.writesAfterFinish(), 0);
  assert.equal(stalled.errorCalls(), 1);
  assert.notEqual(registry.get(sessionId), undefined, 'ending a watcher must never end the session');
  assert.equal(healthy.error(), undefined);
  const first = healthy.sequences()[0]!;
  assert.deepEqual(
    healthy.sequences(),
    healthy.sequences().map((_, i) => first + BigInt(i)),
    'the healthy watcher of the same session receives every event, in order, with no gap',
  );
});

test('a burst larger than the capacity in one tick does not end a watcher that is reading', async () => {
  const CAPACITY = 4;
  const { healthy, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);

  // The healthy fake takes each message as it is written, but a real transport takes none of a
  // tick's burst until the tick is over: model that by holding the burst, then letting it go.
  healthy.stall();
  await tick(deltas(CAPACITY * 4));
  assert.equal(healthy.held(), CAPACITY * 4);
  healthy.flush();
  healthy.resume();
  await tick(deltas(CAPACITY * 4));
  assert.equal(healthy.error(), undefined);
});

test("the session's turn completes after one of its watchers was ended, and the session's end does not end that watcher twice", async () => {
  const CAPACITY = 4;
  const { stalled, healthy, impl, sessionId, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);

  const turn = await call<{ turnId: string }>(impl.sendTurn.bind(impl), { sessionId, commandId: 'cmd-1', text: 'hello' });
  await tick([{ type: 'turn_started', turnId: turn.turnId }, ...deltas(CAPACITY)]);
  await tick(deltas(1));
  assert.equal(stalled.errorCode(), ErrorCode.ERROR_CODE_EVENT_GAP);

  await tick([{ type: 'turn_completed', turnId: turn.turnId, outcome: 'completed', resultText: 'done', isError: false, stopReason: 'end_turn' }]);
  assert.ok(healthy.written.some((e) => e.turnCompleted !== undefined), 'the turn completes for the watcher that kept reading');

  await call(impl.closeSession.bind(impl), { sessionId, commandId: 'cmd-close' });
  await waitFor('the healthy watcher to be ended by the session closing', () => healthy.endCalls() === 1);

  assert.equal(stalled.endCalls(), 0, 'the session ending must not end a stream the bound already failed');
  assert.equal(stalled.errorCalls(), 1);
  assert.equal(stalled.writesAfterFinish(), 0);
  assert.equal(healthy.endCalls(), 1);
  assert.equal(healthy.writesAfterFinish(), 0);
});

test('a reconnect with the last delivered sequence replays from the ring with no gap', async () => {
  const CAPACITY = 8;
  const { stalled, healthy, impl, sessionId, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);

  await tick(deltas(CAPACITY));
  await tick(deltas(1));
  assert.equal(stalled.errorCode(), ErrorCode.ERROR_CODE_EVENT_GAP);
  const cursor = stalled.sequences().at(-1)!;

  // The session keeps going while that client reconnects, but not so far that the ring has evicted
  // the event after its cursor.
  await tick(deltas(3));

  const again = watchCall(sessionId, ReplayStart.REPLAY_START_AFTER_SEQUENCE, cursor);
  impl.watchSessionEvents(again.call);
  assert.equal(again.error(), undefined, 'the cursor the bound left the client with must still be replayable');
  assert.deepEqual(again.sequences(), [cursor + 1n, cursor + 2n, cursor + 3n, cursor + 4n]);

  await tick(deltas(1));
  assert.deepEqual([...stalled.sequences(), ...again.sequences()], healthy.sequences(), 'together, the two streams lose nothing and repeat nothing');
});

test('a watcher that drains in time is never ended, even when write() keeps answering false', async () => {
  const CAPACITY = 32;
  const { stalled: slow, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);

  // A slow reader that never empties its queue: each tick 16 more events arrive, and by the next it
  // has caught up to one below the bound. write() answers false for most of the run and 'drain' never
  // fires; counting false answers between drains would have ended it within a few ticks.
  for (let round = 0; round < 20; round += 1) {
    await tick(deltas(16));
    slow.flush(Math.max(0, slow.held() - (CAPACITY - 1)));
  }

  assert.equal(slow.error(), undefined);
  assert.equal(slow.written.length, 20 * 16);
  assert.equal(slow.held(), CAPACITY - 1);
});

test('a reconnect that replays a full ring is not ended by the live events that follow before it has read the replay', async () => {
  const CAPACITY = 8;
  const { healthy, impl, sessionId, tick, deltas } = await sessionWithTwoWatchers(CAPACITY);
  await tick(deltas(CAPACITY * 2));

  // The replay is written in one go, before the reader can have read any of it: the transport holds
  // all of it, which is exactly the capacity.
  const late = watchCall(sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  late.stall();
  impl.watchSessionEvents(late.call);
  assert.equal(late.held(), CAPACITY);

  // Live events arrive over two ticks while the replay is still queued. Counting the replay, it held
  // 2 * CAPACITY - 1 when the second tick came; only the live ones count, and they are below the bound.
  await tick(deltas(CAPACITY - 1));
  await tick(deltas(1));
  assert.equal(late.error(), undefined, 'a replay burst is not a stalled reader');
  assert.equal(late.held(), CAPACITY * 2);

  // The reader catches up and keeps going.
  late.resume();
  late.flush();
  await tick(deltas(1));
  assert.equal(late.error(), undefined);
  assert.deepEqual(late.sequences(), healthy.sequences().slice(CAPACITY));
});
