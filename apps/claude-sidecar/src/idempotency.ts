export type IdempotencyResult<T> =
  | { kind: 'first_call' }
  | { kind: 'replay'; outcome: T }
  | { kind: 'conflict' };

/**
 * Per-session command idempotency (design spec §3.1/§4). Scope is a single session's lifetime -- the
 * whole cache is discarded when the session's SessionEntry is removed, never persisted or shared
 * across sessions.
 */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, { payloadHash: string; outcome: T }>();

  check(commandId: string, payloadHash: string): IdempotencyResult<T> {
    const existing = this.entries.get(commandId);
    if (existing === undefined) {
      return { kind: 'first_call' };
    }
    if (existing.payloadHash !== payloadHash) {
      return { kind: 'conflict' };
    }
    return { kind: 'replay', outcome: existing.outcome };
  }

  record(commandId: string, payloadHash: string, outcome: T): void {
    this.entries.set(commandId, { payloadHash, outcome });
  }
}
