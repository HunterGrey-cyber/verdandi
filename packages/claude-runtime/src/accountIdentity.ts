import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AccountIdentity } from './types.js';
import type { MinimalQuery } from './queryTypes.js';

/**
 * How long the account probe may take, and so how long a completion-shaped session (see
 * `holdsFirstTurnForAccount` in session.ts) holds its first turn at most -- and how long a sidecar
 * CreateSession that asked to await the identity waits before answering. Generous on purpose: the
 * CLI answers once its process is up and initialized, which the first turn has to wait for anyway,
 * so a healthy session pays nothing extra. Only a CLI that never answers pays the full wait -- and
 * then the turn is delivered regardless, with the identity reported as unavailable. A session that
 * does not hold, and nobody awaiting it, never waits on this at all.
 */
export const DEFAULT_ACCOUNT_INFO_TIMEOUT_MS = 20_000;

/** `AccountInfo` as the kernel reports it: each field verbatim when it is a non-empty string,
 * `null` otherwise. Never guesses a value the CLI did not give. */
export function accountIdentityFromInfo(info: AccountInfo | null | undefined): AccountIdentity {
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    status: 'answered',
    email: text(info?.email),
    organization: text(info?.organization),
    subscriptionType: text(info?.subscriptionType),
    tokenSource: text(info?.tokenSource),
  };
}

/** One in-flight `accountInfo()` question. */
export type AccountProbe = {
  /** Settles -- never rejects -- with the answer, or `unavailable` on failure, timeout or cancel. */
  readonly identity: Promise<AccountIdentity>;
  /** Settles `identity` as unavailable with `reason` now, if nothing settled it yet, and releases
   * the timer. A session calls this when it terminates, so a probe of a dead session neither
   * lingers nor keeps the process alive. */
  cancel(reason: string): void;
};

/**
 * Asks the provider, once, which account it authenticated as.
 *
 * `identity` never rejects: a failure, a missing method, a missed deadline or a cancel all become
 * `{ status: 'unavailable', error }`, because what may wait on it is a held first turn's delivery,
 * and a rejection there would strand the turn with nothing to report it. The deadline timer is a normal
 * (ref'd) timer on purpose -- it decides a result someone may be awaiting -- and every path that
 * settles the probe clears it.
 */
export function probeAccountIdentity(query: MinimalQuery, timeoutMs: number): AccountProbe {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveIdentity!: (identity: AccountIdentity) => void;
  const identity = new Promise<AccountIdentity>((resolve) => {
    resolveIdentity = resolve;
  });
  const settle = (value: AccountIdentity): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolveIdentity(value);
  };
  timer = setTimeout(() => settle({ status: 'unavailable', error: `accountInfo() did not answer within ${timeoutMs}ms` }), timeoutMs);
  Promise.resolve()
    .then(() => {
      if (typeof query.accountInfo !== 'function') {
        throw new Error('this provider query has no accountInfo()');
      }
      return query.accountInfo();
    })
    .then(
      (info) => settle(accountIdentityFromInfo(info)),
      (err: unknown) => settle({ status: 'unavailable', error: `accountInfo() failed: ${err instanceof Error ? err.message : String(err)}` }),
    );
  return { identity, cancel: (reason) => settle({ status: 'unavailable', error: reason }) };
}
