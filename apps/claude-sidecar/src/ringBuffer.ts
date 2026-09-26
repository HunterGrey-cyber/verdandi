import type { ClaudeRuntimeEvent } from '@verdandi/claude-runtime';

/** occurredAt is captured once, by PumpDriver, at the moment the event is drained from pump() --
 * never recomputed later at broadcast or replay time, so every watcher sees the same historical
 * timestamp for the same event regardless of when it actually observes it. */
export type SequencedEvent = { sequence: bigint; occurredAt: bigint; event: ClaudeRuntimeEvent };

/** What a watcher is asking for before it starts receiving live events. Mirrors the proto's
 * `ReplayStart`; see that enum's comments for the full semantics. */
export type ReplayRequest =
  | { mode: 'from_now' }
  | { mode: 'after_sequence'; afterSequence: bigint }
  | { mode: 'available_history' };

export type ReplayResult =
  | { kind: 'ok'; events: SequencedEvent[] }
  /** The requested cursor is older than anything still retained, so the events between it and the
   * oldest retained one are gone for good. */
  | { kind: 'gap'; requested: bigint; oldestRetained: bigint }
  /** The requested cursor is beyond anything this session has ever assigned. It cannot have come
   * from this stream, so it came from another session, another process, or a persisted value --
   * see the proto's provenance note. Refused rather than tolerated, because tolerating it means
   * either waiting forever for sequences that will never exist or silently dropping live events as
   * already-delivered duplicates. */
  | { kind: 'future_cursor'; requested: bigint; latest: bigint };

/**
 * Bounded, per-session event history (design spec §3.1). Sequence 0 is reserved to mean "nothing
 * emitted yet" (plan Global Constraints); the buffer itself only ever stores sequences >= 1.
 */
export class RingBuffer {
  private readonly capacity: number;
  private readonly items: SequencedEvent[] = [];

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error('RingBuffer capacity must be at least 1');
    }
    this.capacity = capacity;
  }

  push(item: SequencedEvent): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  /** The highest sequence this buffer has ever been handed, retained or not. `0n` when nothing has
   * ever been pushed, matching the protocol's reservation of 0 for "nothing emitted yet".
   *
   * Equal to the newest RETAINED sequence, because eviction only ever drops from the front. */
  latestSequence(): bigint {
    return this.items.length === 0 ? 0n : this.items[this.items.length - 1].sequence;
  }

  /** The lowest sequence still retained, or `undefined` when nothing has ever been pushed. */
  oldestRetainedSequence(): bigint | undefined {
    return this.items.length === 0 ? undefined : this.items[0].sequence;
  }

  /**
   * Resolves a typed replay request against what is retained.
   *
   * Replaces a single `replayAfter(afterSequence: bigint)` in which `0` meant four different things
   * at once. Its gap check was guarded on `afterSequence > 0n`, so a request at 0 against a buffer
   * that had already evicted events returned `ok` with the evicted prefix silently absent -- while
   * the strictly weaker request at 1 returned `gap`. The caller asking for the most data got the
   * least warning. Splitting the intents apart is what makes each one's honest answer expressible.
   */
  replay(request: ReplayRequest): ReplayResult {
    switch (request.mode) {
      // Nothing historical was asked for, so nothing historical can be missing.
      case 'from_now':
        return { kind: 'ok', events: [] };
      // Everything still held. Cannot gap: partial history is precisely what was requested. The
      // caller detects an evicted prefix from the first event's sequence being greater than 1.
      case 'available_history':
        return { kind: 'ok', events: [...this.items] };
      case 'after_sequence':
        return this.replayAfterSequence(request.afterSequence);
    }
  }

  private replayAfterSequence(afterSequence: bigint): ReplayResult {
    const latest = this.latestSequence();
    if (afterSequence > latest) {
      return { kind: 'future_cursor', requested: afterSequence, latest };
    }
    const oldestRetained = this.oldestRetainedSequence();
    if (oldestRetained === undefined) {
      // Nothing ever emitted, and afterSequence <= latest === 0n means it is 0: caught up on a
      // session that has produced nothing. Not a gap, not a future cursor.
      return { kind: 'ok', events: [] };
    }
    // `oldestRetained - 1n` is the last sequence a caller could hold and still be contiguous with
    // what remains. Anything older needs an event that has been evicted.
    if (afterSequence < oldestRetained - 1n) {
      return { kind: 'gap', requested: afterSequence, oldestRetained };
    }
    return { kind: 'ok', events: this.items.filter((item) => item.sequence > afterSequence) };
  }
}
