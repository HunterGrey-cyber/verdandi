import type { SessionEntry } from './sessionRegistry.js';
import type { SequencedEvent } from './ringBuffer.js';

export type PumpDriverCallbacks = {
  /** Called once per translated kernel event, in order, after it's already been sequenced and
   * written to the ring buffer. */
  onEvent(sequenced: SequencedEvent): void;
  /** Called exactly once, after the terminal session_closed event has already reached onEvent, when
   * this driver observes the session has ended -- whatever the reason. The callback is responsible
   * for evicting the SessionRegistry entry (design spec §3.1); PumpDriver itself never touches the
   * registry directly, keeping this class's only dependency the SessionEntry it was constructed with. */
  onTerminal(sessionId: string): void;
};

const DEFAULT_POLL_INTERVAL_MS = 20;

/**
 * Drives one session's pump() loop (design spec §3.2). The sole authority for detecting session
 * termination -- whether from an explicit CloseSession RPC (kernel's session.close() was called
 * elsewhere, and pump() eventually surfaces the resulting session_closed) or from the kernel
 * self-terminating on a provider exit/failure (pump() surfaces session_closed on its own, with no
 * close() call ever having happened). Both cases are handled by the exact same code path here.
 */
export class PumpDriver {
  private readonly entry: SessionEntry;
  private readonly callbacks: PumpDriverCallbacks;
  private stopped = false;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(entry: SessionEntry, callbacks: PumpDriverCallbacks) {
    this.entry = entry;
    this.callbacks = callbacks;
  }

  start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.intervalHandle !== undefined) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        // session.pump() itself threw, rather than this tick() draining a normal event array -- the
        // kernel is carefully written not to (there's no hard guarantee against it: translateMessage
        // iterates message content with no guard against malformed input), so this isn't provably
        // unreachable. Under Node's default unhandled-rejection behavior, a rejection escaping this
        // setInterval callback would terminate the ENTIRE sidecar process, including every other
        // unrelated session -- fail closed instead: this one session's driver stops and is reported
        // terminal (even though, unlike the normal path, no session_closed event was ever actually
        // broadcast for it -- there's none to broadcast, since pump() itself failed rather than
        // yielding one), and every other session's driver keeps running untouched.
        console.error(`PumpDriver: session ${this.entry.sessionId}'s pump() threw, terminating this session`, err);
        this.stop();
        this.callbacks.onTerminal(this.entry.sessionId);
      });
    }, pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /** Exposed directly (not just via start()'s interval) so tests can drive exactly one drain cycle
   * deterministically without waiting on a real timer. Deliberately does NOT call translateEvent
   * itself -- onEvent's SequencedEvent carries the raw kernel ClaudeRuntimeEvent, and Task 7's
   * broadcast code calls translateEvent at broadcast time to build the full proto SessionEvent
   * (filling in session_id/occurred_at/turn_id alongside the oneof member, none of which this class
   * has enough context to compute). Re-translating there is intentionally cheap and keeps this
   * class's only dependencies SessionEntry and the kernel event's own `type` field. */
  async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const drained = await this.entry.session.pump();
    let sawTerminal = false;
    for (const event of drained) {
      this.entry.sequence += 1n;
      const sequenced: SequencedEvent = { sequence: this.entry.sequence, occurredAt: BigInt(Date.now()), event };
      this.entry.ringBuffer.push(sequenced);
      this.callbacks.onEvent(sequenced);
      if (event.type === 'session_closed') {
        sawTerminal = true;
      }
    }
    if (sawTerminal) {
      this.stop();
      this.callbacks.onTerminal(this.entry.sessionId);
    }
  }
}
