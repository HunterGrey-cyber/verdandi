import { isAbsolute, join } from 'node:path';
import { assertAccountUsable, DEFAULT_ACCOUNT_NAME, explicitAccount, isDefaultConfigDir, type ClaudeAccount } from '@verdandi/claude-runtime';

/**
 * LEGACY: the host layout, kept for older hosts. It will be deleted when they stop sending names.
 *
 * Some hosts (an Eitri that predates explicit directories, run on a development machine) tell the
 * sidecar which account to spend with `VERDANDI_CLAUDE_ACCOUNT=<name>` and expect the name to expand
 * to a directory pair by the layout of a machine that keeps several accounts side by side:
 *
 *   <name>   ->  config directory      $HOME/.claude-<name>
 *                Anthropic directory   $HOME/.config/anthropic-<name>
 *   default  ->  the CLI's own default location, $HOME/.claude
 *
 * That layout is one host's habit, not part of the runtime's contract, so it lives here, in the
 * sidecar, and not in `@verdandi/claude-runtime`, whose account module knows only explicit
 * directories (`explicitAccount`). This module turns the three environment variables into an explicit
 * spec and hands it to that mechanism; it adds no behaviour of its own, and every error text is the
 * one the sidecar has always printed, because a host and a person read them.
 *
 * - `VERDANDI_CLAUDE_ACCOUNT`: unset, empty or blank pins nothing (and the two directory variables
 *   below are then ignored); otherwise a single path-safe name.
 * - `VERDANDI_CLAUDE_CONFIG_DIR` and `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR`: an absolute directory that
 *   replaces either half of the layout, the name then being only a label. `default` (or the path
 *   `$HOME/.claude`) as the config directory names the CLI's default location for a named account.
 *
 * A host that sends an explicit directory and no name is not served by this module: nothing in the
 * sidecar reads `VERDANDI_CLAUDE_CONFIG_DIR` on its own.
 */

/** A name is interpolated into a filesystem path below, so it is restricted to a single harmless
 * path segment rather than sanitized after the fact. */
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireAbsolute(value: string, variable: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${variable} must be an absolute path, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireHome(env: NodeJS.ProcessEnv, forVariable: string): string {
  const home = env.HOME;
  if (home === undefined || home === '') {
    throw new Error(`VERDANDI_CLAUDE_ACCOUNT is set but HOME is not, so ${forVariable} cannot be derived; set it explicitly`);
  }
  return requireAbsolute(home, 'HOME');
}

/**
 * Pure half: turns the environment into an account, touching no filesystem. Returns `undefined` when
 * no account is named. Throws only on input that is set but unusable -- a malformed name or a
 * relative override -- never on "the account does not exist", which is `assertAccountUsable`'s job.
 *
 * The CLI's own default location (`$HOME/.claude`, identity in `$HOME/.claude.json`) is named either way:
 * - `VERDANDI_CLAUDE_ACCOUNT=default` -- the reserved name means exactly that location, and refuses
 *   any directory override that says otherwise;
 * - `VERDANDI_CLAUDE_CONFIG_DIR=default` (or the literal path `$HOME/.claude`) -- for an account with
 *   its own name, e.g. a host whose only login sits at the default location.
 * Such an account is used exactly as a plain `claude` finds it, default Anthropic config directory
 * included, so combining it with `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` is refused rather than
 * half-honoured.
 */
export function resolveAccountSpec(env: NodeJS.ProcessEnv = process.env): ClaudeAccount | undefined {
  const raw = env.VERDANDI_CLAUDE_ACCOUNT?.trim();
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!ACCOUNT_NAME_PATTERN.test(raw)) {
    throw new Error(
      `VERDANDI_CLAUDE_ACCOUNT must be a single path-safe segment matching ${ACCOUNT_NAME_PATTERN.source}, got ${JSON.stringify(raw)}`,
    );
  }

  const configOverride = env.VERDANDI_CLAUDE_CONFIG_DIR?.trim() || undefined;
  const anthropicOverride = env.VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR?.trim() || undefined;

  const overrideIsDefault = configOverride !== undefined && isDefaultConfigDir(configOverride, env);
  if (raw === DEFAULT_ACCOUNT_NAME || overrideIsDefault) {
    if (configOverride !== undefined && !overrideIsDefault) {
      throw new Error(
        `VERDANDI_CLAUDE_ACCOUNT=${DEFAULT_ACCOUNT_NAME} names the CLI's default location, but VERDANDI_CLAUDE_CONFIG_DIR=${JSON.stringify(configOverride)} names another; give the account its own name to use that directory`,
      );
    }
    if (anthropicOverride !== undefined) {
      throw new Error(
        `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location: such an account is used exactly as a plain \`claude\` finds it`,
      );
    }
    // The same HOME rule the layout below applies, checked here so its error text stays this module's.
    requireHome(env, 'the default location');
    return explicitAccount({ label: raw, configDir: DEFAULT_ACCOUNT_NAME }, env);
  }

  const configDir =
    configOverride !== undefined
      ? requireAbsolute(configOverride, 'VERDANDI_CLAUDE_CONFIG_DIR')
      : join(requireHome(env, 'VERDANDI_CLAUDE_CONFIG_DIR'), `.claude-${raw}`);
  const anthropicConfigDir =
    anthropicOverride !== undefined
      ? requireAbsolute(anthropicOverride, 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR')
      : join(requireHome(env, 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR'), '.config', `anthropic-${raw}`);

  return explicitAccount({ label: raw, configDir, anthropicConfigDir }, env);
}

/** Both halves, in order. `undefined` means nothing is pinned -- and in that case no filesystem
 * check runs at all, so an unconfigured host never pays for a feature it did not turn on. */
export function resolveAccount(env: NodeJS.ProcessEnv = process.env): ClaudeAccount | undefined {
  const spec = resolveAccountSpec(env);
  if (spec === undefined) {
    return undefined;
  }
  assertAccountUsable(spec, env);
  return spec;
}
