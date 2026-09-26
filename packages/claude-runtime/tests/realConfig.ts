import { resolveAccount } from '../src/account.js';
import type { ClaudeHostPolicy, ClaudeSessionConfig } from '../src/types.js';

/** Real tests spend real money against a real subscription, so they stay off unless asked for. */
export const REAL = process.env.RUN_REAL_CLAUDE_TESTS === '1';

/**
 * Which binary this real run exercises. `ClaudeHostPolicy.executable` chooses between two genuinely
 * different programs -- the CLI inside the SDK npm package and the CLI installed on the machine --
 * which on a real host sit at different versions. `TESTED_CLI_VERSIONS` is a claim about binaries
 * that were actually run, so certifying both means running this suite twice, once per value, rather
 * than running it once and asserting the claim for both.
 *
 * Defaults to `host_cli`, which is what these tests exercised before `executable` was honoured at
 * all (the policies below already declared it; nothing read it).
 */
export const REAL_EXECUTABLE: ClaudeHostPolicy['executable'] =
  process.env.VERDANDI_REAL_TEST_EXECUTABLE === 'sdk_bundled' ? 'sdk_bundled' : 'host_cli';

/**
 * Builds the session config a real test should use: the caller's policy, with `executable` forced
 * to whichever binary this run is certifying, plus the same account pinning and host-CLI path the
 * production sidecar resolves. Without the account, a real run spends whichever subscription the
 * invoking shell happened to carry.
 *
 * **Nothing here picks an account, on purpose -- `resolveAccount()` reads the environment, so the
 * invoking shell decides who pays.** That is the right design and it is also a silent hazard: an
 * ambient `VERDANDI_CLAUDE_ACCOUNT` left over from an interactive session bills that account, and
 * the run succeeds, so nothing reports it.
 *
 * Pin the account explicitly for real runs rather than relying on whatever the shell carries, e.g.
 *
 *   VERDANDI_CLAUDE_ACCOUNT=test npm run test:real -w @verdandi/claude-runtime
 *
 * which by this package's own convention (see account.ts) expands to `$HOME/.claude-test` +
 * `$HOME/.config/anthropic-test`. Set `VERDANDI_CLAUDE_CLI_PATH` too if the CLI you mean is not the
 * one resolveClaudeCliPath in the sidecar would pick (PATH is consulted by the default only).
 */
export function realSessionConfig(cwd: string, policy: ClaudeHostPolicy): ClaudeSessionConfig {
  return {
    cwd,
    policy: { ...policy, executable: REAL_EXECUTABLE },
    account: resolveAccount(),
    hostCliPath: process.env.VERDANDI_CLAUDE_CLI_PATH?.trim() || undefined,
  };
}
