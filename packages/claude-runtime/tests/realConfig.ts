import { assertAccountUsable, explicitAccount, type ClaudeAccount } from '../src/account.js';
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
 * The account a real run spends, from explicit directories in the environment -- never from a name,
 * which this package does not know how to expand (the sidecar does, for hosts that still send one).
 *
 *   VERDANDI_CLAUDE_CONFIG_DIR            the login's directory, absolute; or `default` for the CLI's own
 *                                         location (`$HOME/.claude`)
 *   VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR  its Anthropic config directory, absolute; not allowed with
 *                                         `default`
 *   VERDANDI_CLAUDE_ACCOUNT               optional: only the label the account is reported under
 *
 * Nothing set means nothing pinned, as before. A name WITHOUT a directory is refused rather than
 * ignored: that combination is what a host's launcher that still speaks names produces, and falling
 * back to whatever the shell carries would bill whichever subscription that is, with every test
 * passing.
 */
export function realAccount(env: NodeJS.ProcessEnv = process.env): ClaudeAccount | undefined {
  const configDir = env.VERDANDI_CLAUDE_CONFIG_DIR?.trim() || undefined;
  const label = env.VERDANDI_CLAUDE_ACCOUNT?.trim() || undefined;
  // The name is what says "pin": directories without one are ignored, exactly as the sidecar ignores
  // them, so an ambient directory left in the shell never picks the account a real test spends.
  if (label === undefined) {
    return undefined;
  }
  if (configDir === undefined) {
    throw new Error(
      `VERDANDI_CLAUDE_ACCOUNT=${JSON.stringify(label)} is set without VERDANDI_CLAUDE_CONFIG_DIR: real tests take explicit directories, not names. Set VERDANDI_CLAUDE_CONFIG_DIR (and VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR) to the account's directories, or unset the name to run unpinned.`,
    );
  }
  const account = explicitAccount(
    { label, configDir, anthropicConfigDir: env.VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR?.trim() || undefined },
    env,
  );
  assertAccountUsable(account, env);
  return account;
}

/**
 * Builds the session config a real test should use: the caller's policy, with `executable` forced
 * to whichever binary this run is certifying, plus the account pinning and host-CLI path a
 * production sidecar would hand it. Without the account, a real run spends whichever subscription
 * the invoking shell happened to carry.
 *
 * **Nothing here picks an account, on purpose -- `realAccount()` reads the environment, so the
 * invoking shell decides who pays.** That is the right design and it is also a silent hazard: an
 * ambient `VERDANDI_CLAUDE_CONFIG_DIR` left over from an interactive session bills that account, and
 * the run succeeds, so nothing reports it. Pin the account explicitly for real runs, e.g.
 *
 *   VERDANDI_CLAUDE_ACCOUNT=test VERDANDI_CLAUDE_CONFIG_DIR=/path/to/test-login \
 *     VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR=/path/to/test-anthropic npm run test:real -w @verdandi/claude-runtime
 *
 * Set `VERDANDI_CLAUDE_CLI_PATH` too if the CLI you mean is not the one resolveClaudeCliPath in the
 * sidecar would pick: PATH is consulted by the default only, so a PATH shim alone does not reach this
 * code.
 */
export function realSessionConfig(cwd: string, policy: ClaudeHostPolicy): ClaudeSessionConfig {
  return {
    cwd,
    policy: { ...policy, executable: REAL_EXECUTABLE },
    account: realAccount(),
    hostCliPath: process.env.VERDANDI_CLAUDE_CLI_PATH?.trim() || undefined,
  };
}
