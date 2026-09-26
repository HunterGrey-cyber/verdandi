import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, type ReplayResult } from '../src/ringBuffer.js';

function sequences(result: ReplayResult): bigint[] {
  assert.equal(result.kind, 'ok');
  return (result as { kind: 'ok'; events: Array<{ sequence: bigint }> }).events.map((e) => e.sequence);
}

function push(buffer: RingBuffer, ...seqs: number[]): void {
  for (const n of seqs) {
    buffer.push({ sequence: BigInt(n), occurredAt: 0n, event: {} as never });
  }
}

/** A buffer of capacity 2 that has been handed 1..5, so it holds [4, 5] and 1-3 are irretrievably
 * gone. Small on purpose: forcing eviction should not require producing a thousand events. */
function evicted(): RingBuffer {
  const buffer = new RingBuffer(2);
  push(buffer, 1, 2, 3, 4, 5);
  return buffer;
}

test('RingBuffer: an empty buffer reports no latest and no oldest', () => {
  const buffer = new RingBuffer(3);
  assert.equal(buffer.latestSequence(), 0n);
  assert.equal(buffer.oldestRetainedSequence(), undefined);
  assert.deepEqual(buffer.replay({ mode: 'available_history' }), { kind: 'ok', events: [] });
  assert.deepEqual(buffer.replay({ mode: 'from_now' }), { kind: 'ok', events: [] });
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 0n }), { kind: 'ok', events: [] });
});

test('RingBuffer: available_history returns everything still retained, in order', () => {
  const buffer = new RingBuffer(3);
  push(buffer, 1, 2);
  assert.deepEqual(sequences(buffer.replay({ mode: 'available_history' })), [1n, 2n]);
});

test('RingBuffer: from_now returns nothing, however much history is retained', () => {
  const buffer = new RingBuffer(5);
  push(buffer, 1, 2, 3);
  assert.deepEqual(sequences(buffer.replay({ mode: 'from_now' })), []);
});

test('RingBuffer: after_sequence(N) returns only events newer than N', () => {
  const buffer = new RingBuffer(5);
  push(buffer, 1, 2, 3);
  assert.deepEqual(sequences(buffer.replay({ mode: 'after_sequence', afterSequence: 1n })), [2n, 3n]);
});

test('RingBuffer: after_sequence at the latest sequence replays nothing and is not a gap', () => {
  const buffer = new RingBuffer(3);
  push(buffer, 1);
  // Fully caught up. The distinction that matters is "no duplicates" -- a caller at the live edge
  // must not be handed the event it already has.
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 1n }), { kind: 'ok', events: [] });
});

test('RingBuffer: after_sequence whose successor was evicted is a gap, and says what is missing', () => {
  const buffer = evicted();
  // Last saw 1, needs 2 -- evicted.
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 1n }), {
    kind: 'gap',
    requested: 1n,
    oldestRetained: 4n,
  });
  // Last saw 2, needs 3 -- evicted.
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 2n }), {
    kind: 'gap',
    requested: 2n,
    oldestRetained: 4n,
  });
});

test('RingBuffer: the boundary below the oldest retained event is contiguous, not a gap', () => {
  const buffer = evicted(); // holds [4, 5]
  // Last saw 3 -- the event immediately before the oldest retained one. What remains is contiguous
  // with what the caller holds, so this is the newest cursor that is still repairable and it must
  // NOT report a gap. Off by one here turns every successful reconnect into a false loss report.
  assert.deepEqual(sequences(buffer.replay({ mode: 'after_sequence', afterSequence: 3n })), [4n, 5n]);
});

/**
 * THE REGRESSION TEST for the silent-loss bug this protocol round exists to close.
 *
 * The old implementation had a single `replayAfter(afterSequence)` whose gap check was guarded on
 * `afterSequence > 0n`. A cursor of 0 therefore returned `{kind:'ok'}` with the evicted prefix
 * simply absent -- while the strictly weaker request (`1n`) returned a gap. The caller asking for
 * the most data got the least warning, and the previous version of THIS FILE asserted that
 * behaviour as intended, calling 0 a "just give me whatever you currently have" sentinel.
 *
 * Both halves of the fix are pinned here: a cursor of 0 is now an ordinary cursor and gaps like any
 * other, and "whatever you currently have" is a separate mode that cannot pretend to be complete.
 */
test('RingBuffer: a cursor of 0 against an evicted buffer is a gap, not a silent partial replay', () => {
  const buffer = evicted(); // holds [4, 5]; 1, 2, 3 gone

  // Fails against the old implementation, which returned { kind: 'ok', events: [4, 5] } here.
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 0n }), {
    kind: 'gap',
    requested: 0n,
    oldestRetained: 4n,
  });

  // The intent 0 used to smuggle is now its own mode -- and it is honest about being partial: the
  // caller opted into "whatever you still have", and can see the prefix is missing because the
  // first sequence it receives is not 1.
  const available = buffer.replay({ mode: 'available_history' });
  assert.deepEqual(sequences(available), [4n, 5n]);
  assert.notEqual(sequences(available)[0], 1n, 'an evicted prefix must remain visible to the caller');
});

test('RingBuffer: a cursor beyond anything ever assigned is refused, not silently accepted', () => {
  const buffer = new RingBuffer(3);
  push(buffer, 1);

  // Fails against the old implementation, which returned { kind: 'ok', events: [] } -- a client
  // holding a cursor from another session or a persisted value would have waited forever for
  // sequences that will never be assigned, or dropped live events as already-seen duplicates.
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 99n }), {
    kind: 'future_cursor',
    requested: 99n,
    latest: 1n,
  });
});

test('RingBuffer: a cursor beyond the latest is refused even on a session that has emitted nothing', () => {
  const buffer = new RingBuffer(3);
  assert.deepEqual(buffer.replay({ mode: 'after_sequence', afterSequence: 1n }), {
    kind: 'future_cursor',
    requested: 1n,
    latest: 0n,
  });
});

test('RingBuffer: capacity below 1 is refused at construction', () => {
  assert.throws(() => new RingBuffer(0), /at least 1/);
});
