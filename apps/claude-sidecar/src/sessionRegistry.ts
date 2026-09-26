import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { RingBuffer } from './ringBuffer.js';
import { IdempotencyCache } from './idempotency.js';

/**
 * The subset of the real ClaudeRuntimeSession's public method surface this package's code actually
 * calls. Kept narrow deliberately, mirroring the kernel's own MinimalQuery pattern over the real
 * SDK's Query: widen it only when a later task's code needs a method this type doesn't yet have, at
 * which point also widen tests/fakeSession.ts's fake to match.
 */
export interface MinimalKernelSession {
  pump(): Promise<ClaudeRuntimeEvent[]>;
  sendTurn(text: string): { turnId: string };
  interrupt(): Promise<void>;
  close(): void;
  resolvePermission(permissionId: string, decision: { allow: boolean; reason?: string }): boolean;
  /** SetPermissionMode. Resolves with the provider-level mode the CLI acknowledged; rejects with the
   * kernel's `PermissionModeError` when the switch is refused. */
  setPermissionMode(mode: ClaudeHostPolicy['permissions']): Promise<{ permissionMode: string; bypassDefaultDenyApplied: boolean }>;
}

export type SessionEntry = {
  readonly sessionId: string;
  readonly session: MinimalKernelSession;
  sequence: bigint;
  readonly ringBuffer: RingBuffer;
  readonly sendTurnIdempotency: IdempotencyCache<{ turnId: string }>;
  readonly interruptIdempotency: IdempotencyCache<Record<string, never>>;
  readonly resolvePermissionIdempotency: IdempotencyCache<Record<string, never>>;
  readonly closeIdempotency: IdempotencyCache<Record<string, never>>;
  readonly setPermissionModeIdempotency: IdempotencyCache<{ permissionMode: string }>;
  /** SetPermissionMode calls still waiting on the CLI, by command_id. The only async mutating RPC
   * whose outcome is recorded after an await, so a duplicate arriving in that window must join the
   * call in flight rather than run the switch a second time. */
  readonly setPermissionModeInFlight: Map<string, { payloadHash: string; outcome: Promise<{ permissionMode: string }> }>;
};

/**
 * session_id -> SessionEntry (design spec §3.1). One IdempotencyCache per mutating RPC kind, not one
 * shared cache -- SendTurn/InterruptTurn/ResolvePermission/CloseSession command_ids are independent
 * namespaces even within the same session, since a client could reasonably reuse a UUID generator's
 * output across different RPC kinds without meaning to correlate them.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();

  create(sessionId: string, session: MinimalKernelSession, ringBufferCapacity: number): SessionEntry {
    const entry: SessionEntry = {
      sessionId,
      session,
      sequence: 0n,
      ringBuffer: new RingBuffer(ringBufferCapacity),
      sendTurnIdempotency: new IdempotencyCache(),
      interruptIdempotency: new IdempotencyCache(),
      resolvePermissionIdempotency: new IdempotencyCache(),
      closeIdempotency: new IdempotencyCache(),
      setPermissionModeIdempotency: new IdempotencyCache(),
      setPermissionModeInFlight: new Map(),
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.entries.get(sessionId);
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  allSessionIds(): string[] {
    return Array.from(this.entries.keys());
  }
}
