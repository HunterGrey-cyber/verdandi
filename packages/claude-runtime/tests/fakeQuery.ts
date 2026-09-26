import type { AccountInfo, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MinimalQuery } from '../src/queryTypes.js';

/** What the fake's accountInfo() answers unless a test supplies its own. */
export const FAKE_ACCOUNT_INFO: AccountInfo = Object.freeze({
  email: 'fake-account@example.invalid',
  organization: 'Fake Organization',
  subscriptionType: 'pro',
  tokenSource: 'fake',
});

export type FakeQueryOptions = {
  /** Replaces the default accountInfo() answer -- e.g. with a promise that never settles, or rejects. */
  accountInfo?: () => Promise<AccountInfo>;
  /** Replaces the default setPermissionMode() (which records the mode and resolves) -- e.g. with one
   * that rejects the way the real CLI does for `bypass_not_launched`, or one that never settles. */
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
};

export type FakeQueryController = {
  /** Makes the fake's async-generator side yield this message on the next pull. */
  emit(message: SDKMessage): void;
  /** Ends the fake generator's stream (as if the real CLI process exited). */
  end(): void;
  /** Makes the fake's next `.next()` call (in-flight or future) reject with `err` instead of
   * resolving -- exercises `pump()`'s fail-closed error path (Task 4 Finding 3) against a fake
   * `rawQuery.next()` rejection, mirroring how a real CLI subprocess dying mid-call would surface
   * to this package's code. */
  rejectNext(err: unknown): void;
  /** True once `close()` was called on the fake query. */
  readonly closed: boolean;
  /** True once `interrupt()` was called on the fake query. */
  readonly interruptCalls: number;
  /** How many times `accountInfo()` was called on the fake query. */
  readonly accountInfoCalls: number;
  /** Every mode passed to setPermissionMode(), in call order. */
  readonly setPermissionModeCalls: PermissionMode[];
};

type PendingCall = {
  resolve: (value: IteratorResult<SDKMessage, void>) => void;
  reject: (err: unknown) => void;
};

/**
 * Builds a fake `Query` plus the controller a test uses to drive it.
 */
export function makeFakeQuery(options: FakeQueryOptions = {}): { query: MinimalQuery; controller: FakeQueryController } {
  const pending: SDKMessage[] = [];
  const waiters: PendingCall[] = [];
  let ended = false;
  let closed = false;
  let interruptCalls = 0;
  let accountInfoCalls = 0;
  const setPermissionModeCalls: PermissionMode[] = [];
  /** Set when `rejectNext()` is called with no `next()` call currently waiting -- consumed by the
   * very next `next()` call instead of queuing a message. */
  let pendingRejection: { err: unknown } | undefined;

  function deliver(message: SDKMessage): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: message, done: false });
    } else {
      pending.push(message);
    }
  }

  function finish(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function rejectNext(err: unknown): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.reject(err);
    } else {
      pendingRejection = { err };
    }
  }

  const query: MinimalQuery = {
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      if (pendingRejection !== undefined) {
        const { err } = pendingRejection;
        pendingRejection = undefined;
        throw err;
      }
      const queued = pending.shift();
      if (queued !== undefined) {
        return { value: queued, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return(): Promise<IteratorResult<SDKMessage, void>> {
      finish();
      return { value: undefined, done: true };
    },
    async throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
      finish();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt(): Promise<unknown> {
      interruptCalls += 1;
      return undefined;
    },
    close(): void {
      closed = true;
      finish();
    },
    accountInfo(): Promise<AccountInfo> {
      accountInfoCalls += 1;
      return options.accountInfo !== undefined ? options.accountInfo() : Promise.resolve({ ...FAKE_ACCOUNT_INFO });
    },
    setPermissionMode(mode: PermissionMode): Promise<void> {
      setPermissionModeCalls.push(mode);
      return options.setPermissionMode !== undefined ? options.setPermissionMode(mode) : Promise.resolve();
    },
  };

  return {
    query,
    controller: {
      emit: deliver,
      end: finish,
      rejectNext,
      get closed() {
        return closed;
      },
      get interruptCalls() {
        return interruptCalls;
      },
      get accountInfoCalls() {
        return accountInfoCalls;
      },
      setPermissionModeCalls,
    },
  };
}
