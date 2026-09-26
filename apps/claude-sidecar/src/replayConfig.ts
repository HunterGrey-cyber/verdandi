/**
 * Runtime configuration for the event replay buffer, and the one deliberately-quarantined fault
 * seam that makes a recoverable stream interruption testable.
 *
 * Both are read from the environment through pure, injectable helpers rather than inline at the
 * call site, matching `cliCompatibility.ts`'s `strictModeFromEnv`: the accepted values get stated
 * once, in one place, and become testable without a process.
 */

/** What ships. One session's worth of history at partial-streaming volumes is roughly two and a
 * half turns, which is the real boundary past which a reconnect can no longer be repaired by
 * replay. Configurable because a test that wants to force eviction should not have to produce a
 * thousand real events to do it. */
export const DEFAULT_RING_BUFFER_CAPACITY = 1000;

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    // Thrown rather than defaulted. A capacity of "0" or "abc" is a configuration mistake, and
    // silently running at 1000 instead would hide it behind behaviour that looks correct -- a test
    // that meant to force eviction would simply never evict, and would pass by never gapping.
    throw new Error(`expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Per-session event history size. `VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY`, default 1000.
 *
 * Validated here, at startup, rather than where the buffer is built: `new RingBuffer(0)` throws
 * from inside `createSession`'s try, which would surface as a per-session PROVIDER_PROTOCOL_ERROR
 * at the first session rather than as a refusal to boot with a bad configuration.
 */
export function ringCapacityFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  try {
    return parsePositiveInteger(env.VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY) ?? DEFAULT_RING_BUFFER_CAPACITY;
  } catch (err) {
    throw new Error(`VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY: ${(err as Error).message}`);
  }
}

/**
 * How the sidecar should break a watch stream on purpose.
 *
 * **A test seam, and nothing else.** It exists because the alternative for testing recovery is
 * hoping a real network produces a transient failure, and a test that depends on hope is a test
 * that passes for the wrong reason. Off unless the variable is set, so production behaviour is
 * unchanged by its existence.
 *
 * What it must NOT do, and does not: end the session. The whole point is the case where the
 * TRANSPORT fails and the provider keeps running -- if the session died too, the client's reconnect
 * would get SESSION_NOT_FOUND and the test would silently become a duplicate of the existing
 * killed-sidecar test, proving nothing about replay.
 */
export type WatchFaultInjection = {
  /** Destroy the watch stream after it has delivered this many live events. */
  afterEvents: number;
};

/**
 * `VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER=<n>`: break each session's FIRST watch stream
 * after it has delivered n live events, then never again for that session.
 *
 * "First only" is load-bearing. A fault that fires on every watch would break the reconnect too,
 * and the client would burn its bounded retry budget and report the session unavailable -- which is
 * already covered by another test and says nothing about whether replay works. Firing once means
 * the reconnect succeeds, which is the behaviour under test.
 */
export function watchFaultInjectionFromEnv(env: NodeJS.ProcessEnv = process.env): WatchFaultInjection | undefined {
  let afterEvents: number | undefined;
  try {
    afterEvents = parsePositiveInteger(env.VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER);
  } catch (err) {
    throw new Error(`VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER: ${(err as Error).message}`);
  }
  return afterEvents === undefined ? undefined : { afterEvents };
}

/**
 * `VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS=<n>`: every n milliseconds, print one line to
 * stderr describing how many events the TRANSPORT is holding for each live watch subscriber.
 *
 * ### Why this exists, and why it is a measurement rather than a proxy
 *
 * `broadcastFor` calls `call.write(event)` and discards the return value. grpc-js returns `false`
 * from that call when the message went into its own internal buffer rather than out to the socket,
 * and emits `'drain'` when that buffer clears. Discarding the return value means the server has no
 * congestion signal at all: a subscriber that stops reading does not slow the producer down, it
 * just makes grpc-js accumulate, without bound, in the sidecar's own heap.
 *
 * A consumer CANNOT see this. The queue is on the server, so from the client's side a stalled
 * stream and a healthy one look the same until the sidecar dies. The only observable either end
 * has today is the sidecar's RSS, which is consistent with a growing write queue but does not
 * prove it is that queue -- RSS climbs for other reasons too. This seam turns that inference into
 * a count: `outstanding` is exactly the number of messages grpc-js has taken and not yet flushed.
 *
 * OFF unless the variable is set, and off is not "zero interval" -- no timer is created, no
 * listener is attached, and `broadcastFor` does not even read the write result. A diagnostic that
 * costs something when disabled is a diagnostic people disable for the wrong reasons.
 */
export type WriteQueueStats = {
  /** How often to print. */
  intervalMs: number;
};

export function writeQueueStatsFromEnv(env: NodeJS.ProcessEnv = process.env): WriteQueueStats | undefined {
  let intervalMs: number | undefined;
  try {
    intervalMs = parsePositiveInteger(env.VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS);
  } catch (err) {
    throw new Error(`VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS: ${(err as Error).message}`);
  }
  return intervalMs === undefined ? undefined : { intervalMs };
}
