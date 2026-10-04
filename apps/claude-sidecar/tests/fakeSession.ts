import type { AccountIdentity, ClaudeRuntimeEvent, PermissionAnswer, SessionCloseReason } from '@verdandi/claude-runtime';
import type { MinimalKernelSession } from '../src/sessionRegistry.js';

export type FakeSessionController = {
  /** Makes the fake's pump() return this event on the next call (queued, drained in order). */
  emit(event: ClaudeRuntimeEvent): void;
  /** Every text passed to sendTurn(), in call order. */
  readonly sentTurns: string[];
  /** Every (permissionId, decision) pair passed to resolvePermission(), in call order. */
  readonly resolvePermissionCalls: Array<{ permissionId: string; decision: PermissionAnswer }>;
  readonly interruptCalls: number;
  readonly closeCalls: number;
  /** Every mode passed to setPermissionMode(), in call order. */
  readonly setPermissionModeCalls: string[];
  /** Makes the NEXT setPermissionMode() reject with this error (e.g. the kernel's PermissionModeError). */
  makeNextSetPermissionModeReject(err: unknown): void;
  /** Makes the NEXT setPermissionMode() wait until the returned function is called. */
  holdNextSetPermissionMode(): () => void;
  /** Makes the NEXT call to sendTurn() throw an Error with this message instead of succeeding, then
   * reverts to normal behavior for any call after that -- mirrors the real kernel's own plain-Error
   * throw for "a turn is already in progress on this session" for exactly one call, so a test can
   * exercise a caller's error-wrapping logic around sendTurn() without this fake needing to implement
   * full turn-in-progress tracking of its own. */
  makeNextSendTurnThrow(message: string): void;
  /** Makes the NEXT call to interrupt() reject with an Error carrying this message instead of
   * succeeding, then reverts to normal behavior after that -- unlike makeNextSendTurnThrow, this has
   * no real-kernel throw condition to mirror (the kernel's own interrupt() doesn't throw plain Errors
   * for any documented condition); it exists purely so a test can exercise a handler's generic
   * catch-all error-wrapping path (final whole-branch review, Finding 6: a non-SidecarError throw
   * must still reach the client as a real SidecarError/ErrorCode, never an unmapped UNKNOWN) against
   * some concrete throw, without inventing a fake failure mode the real kernel doesn't have. */
  makeNextInterruptThrow(message: string): void;
  /** How many times accountIdentity() was called: zero proves a CreateSession did not wait on it. */
  readonly accountIdentityCalls: number;
  /** Settles the promise accountIdentity() returns. Until then it is pending, like a probe the CLI has
   * not answered yet. */
  settleAccountIdentity(identity: AccountIdentity | undefined): void;
  /** Ends the session the way the kernel does when its provider goes away: closeReason() reports
   * `reason` from now on and pump() delivers the session_closed. */
  endSession(reason: SessionCloseReason): void;
  /** Makes the NEXT accountIdentity() call return a rejected promise (the kernel's never rejects). */
  makeNextAccountIdentityReject(err: unknown): void;
};

/**
 * Builds a fake MinimalKernelSession plus the controller a test uses to drive it. Unlike the kernel's
 * own fakeQuery.ts (which models a real async generator's queueing semantics because MinimalQuery is
 * one), pump() here is deliberately simple: it drains and returns whatever's been queued via emit()
 * since the last call, synchronously available, no waiting-for-more-input behavior — PumpDriver
 * (Task 5) is the one polling in a loop, so the fake doesn't need to simulate blocking.
 */
export function makeFakeSession(): { session: MinimalKernelSession; controller: FakeSessionController } {
  const pending: ClaudeRuntimeEvent[] = [];
  const sentTurns: string[] = [];
  const resolvePermissionCalls: FakeSessionController['resolvePermissionCalls'] = [];
  let interruptCalls = 0;
  let closeCalls = 0;
  let nextSendTurnError: string | undefined;
  let nextInterruptError: string | undefined;
  const setPermissionModeCalls: string[] = [];
  let nextSetPermissionModeError: { err: unknown } | undefined;
  let nextSetPermissionModeHold: Promise<void> | undefined;
  let accountIdentityCalls = 0;
  let closeReason: SessionCloseReason | undefined;
  let nextAccountIdentityError: { err: unknown } | undefined;
  let settleIdentity!: (identity: AccountIdentity | undefined) => void;
  const identity = new Promise<AccountIdentity | undefined>((resolve) => (settleIdentity = resolve));

  const session: MinimalKernelSession = {
    async pump() {
      return pending.splice(0);
    },
    sendTurn(text: string) {
      if (nextSendTurnError !== undefined) {
        const message = nextSendTurnError;
        nextSendTurnError = undefined;
        throw new Error(message);
      }
      sentTurns.push(text);
      return { turnId: `fake-turn-${sentTurns.length}` };
    },
    async interrupt() {
      if (nextInterruptError !== undefined) {
        const message = nextInterruptError;
        nextInterruptError = undefined;
        throw new Error(message);
      }
      interruptCalls += 1;
    },
    close() {
      closeCalls += 1;
      closeReason ??= 'closed_by_host';
      // Mirrors the real kernel's own close(), which provably drives a `session_closed` event
      // through a subsequent pump() call -- without this, PumpDriver's interval for any session this
      // fake backs would never observe a terminal event and would never self-stop (final whole-branch
      // review, "make the fake session's close() emit session_closed").
      pending.push({ type: 'session_closed', reason: 'closed_by_host' });
    },
    resolvePermission(permissionId: string, decision: PermissionAnswer) {
      resolvePermissionCalls.push({ permissionId, decision });
      return true;
    },
    async setPermissionMode(mode) {
      setPermissionModeCalls.push(mode);
      if (nextSetPermissionModeHold !== undefined) {
        const hold = nextSetPermissionModeHold;
        nextSetPermissionModeHold = undefined;
        await hold;
      }
      if (nextSetPermissionModeError !== undefined) {
        const { err } = nextSetPermissionModeError;
        nextSetPermissionModeError = undefined;
        throw err;
      }
      const permissionMode = mode === 'bypass' ? 'bypassPermissions' : 'default';
      // As the real kernel: the change is announced through pump() for every watcher.
      pending.push({ type: 'permission_mode_changed', permissions: mode, permissionMode, bypassDefaultDenyApplied: false });
      return { permissionMode, bypassDefaultDenyApplied: false };
    },
    accountIdentity() {
      accountIdentityCalls += 1;
      if (nextAccountIdentityError !== undefined) {
        const { err } = nextAccountIdentityError;
        nextAccountIdentityError = undefined;
        return Promise.reject(err);
      }
      return identity;
    },
    closeReason() {
      return closeReason;
    },
  };

  return {
    session,
    controller: {
      emit: (event) => pending.push(event),
      sentTurns,
      resolvePermissionCalls,
      get interruptCalls() {
        return interruptCalls;
      },
      get closeCalls() {
        return closeCalls;
      },
      makeNextSendTurnThrow: (message: string) => {
        nextSendTurnError = message;
      },
      makeNextInterruptThrow: (message: string) => {
        nextInterruptError = message;
      },
      setPermissionModeCalls,
      makeNextSetPermissionModeReject: (err: unknown) => {
        nextSetPermissionModeError = { err };
      },
      get accountIdentityCalls() {
        return accountIdentityCalls;
      },
      settleAccountIdentity: (value) => settleIdentity(value),
      endSession: (reason) => {
        closeReason ??= reason;
        pending.push({ type: 'session_closed', reason });
      },
      makeNextAccountIdentityReject: (err) => {
        nextAccountIdentityError = { err };
      },
      holdNextSetPermissionMode: () => {
        let release!: () => void;
        nextSetPermissionModeHold = new Promise<void>((r) => (release = r));
        return release;
      },
    },
  };
}
