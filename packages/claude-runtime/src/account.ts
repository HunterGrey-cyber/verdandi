import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Optional binding of every spawned Claude subprocess to one named local account.
 *
 * This is a **patch for hosts that run several Claude Code accounts side by side**, not part of
 * the normal contract: with `VERDANDI_CLAUDE_ACCOUNT` unset -- the shipped default -- nothing here
 * engages, `policyToBaseOptions` sets no `options.env` at all, the SDK's own `env: {...process.env}`
 * default stands, and the subprocess resolves its config and credentials exactly the way a plain
 * `claude` install does (`~/.claude`). Nothing in this module writes to disk or mutates the
 * sidecar's own environment; it only computes what to hand the child.
 *
 * Why it exists: the SDK inherits the parent process's environment wholesale, so on a multi-account
 * host "which subscription does verdandi spend, and whose claude.ai connectors can it reach" was
 * decided by whichever shell happened to start the sidecar. That is an accident, not a
 * configuration.
 */
export type ClaudeAccount = {
  /** The account's short name, e.g. `work`. Also what `CLAUDE_PROFILE` is set to. */
  name: string;
  /** `CLAUDE_CONFIG_DIR`: holds `.claude.json`, `.credentials.json`, `settings.json`, projects. */
  configDir: string;
  /** `ANTHROPIC_CONFIG_DIR`. Empty, and unused, for an account at the CLI's default location. */
  anthropicConfigDir: string;
  /**
   * The account lives where a plain `claude` looks by default: `$HOME/.claude`, with its global
   * config in `$HOME/.claude.json`. Such an account is bound by REMOVING the tuple from the child's
   * environment, never by setting it -- see `applyAccountEnv`.
   *
   * Setting `CLAUDE_CONFIG_DIR=$HOME/.claude` explicitly is not the same thing: with the variable set,
   * the CLI reads its global config from `$CLAUDE_CONFIG_DIR/.claude.json` instead of
   * `$HOME/.claude.json`, finds no `oauthAccount` there, and reports the login's email as null -- so
   * an account-email proof downstream fails on an account that is logged in. Found on host-b
   * (2026-09-25), whose only login is work at the default location.
   */
  defaultLocation?: true;
};

/** Reserved account name, and `VERDANDI_CLAUDE_CONFIG_DIR` keyword, for the CLI's own default location. */
export const DEFAULT_ACCOUNT_NAME = 'default';

/**
 * Variables from which the CLI SEEDS a login's identity: with all three set and no `oauthAccount` in
 * its global config, it records this email as the account's own. A pinned account's identity must
 * come from its stored login, never from the environment, so `applyAccountEnv` removes them.
 */
export const IDENTITY_SEED_ENV_VARS = ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_ORGANIZATION_UUID'] as const;

/** The four variables that name an account, in the order `accountEnv` emits them. */
export const ACCOUNT_ENV_VARS = ['CLAUDE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'] as const;

/** Account names are interpolated into a filesystem path by the convention below, so they are
 * restricted to a single harmless path segment rather than sanitized after the fact. */
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The four environment variables that name an account, as one tuple.
 *
 * They must be set together or not at all. A half-set tuple is the worst of the three states: the
 * CLI would read config from one account while resolving credentials from another, which surfaces
 * as an authentication failure far away from its cause. In particular `CLAUDE_SECURESTORAGE_CONFIG_DIR`
 * cannot be left to the SDK -- the SDK only derives it from `CLAUDE_CONFIG_DIR` on win32, so on
 * Linux an unset value silently falls back to the default account's store.
 *
 * `CLAUDE_PROFILE` is not read by Claude Code itself; it is the host launcher's own identity marker.
 * It is included so the tuple a human (or that launcher) sees in `/proc/<pid>/environ` is coherent
 * rather than half-written. The deliberate consequence is that a nested `claude` started from
 * inside a session on such a host routes through the launcher and is refused (outside an approved
 * session) instead of quietly running unguarded against this account.
 */
export function accountEnv(account: ClaudeAccount): Record<string, string> {
  if (account.defaultLocation === true) {
    return {};
  }
  return {
    CLAUDE_PROFILE: account.name,
    CLAUDE_CONFIG_DIR: account.configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: account.configDir,
    ANTHROPIC_CONFIG_DIR: account.anthropicConfigDir,
  };
}

/**
 * Returns a copy of `env` bound to `account`: every variable of the tuple is removed first, then
 * `accountEnv(account)` is written over it. For an account at a convention or explicit directory
 * that is the same overlay `accountEnv` always was -- an inherited tuple from another account is
 * replaced, not merged with. For an account at the CLI's default location it leaves the tuple ABSENT,
 * which is the only way to make the CLI use `$HOME/.claude` and `$HOME/.claude.json` together; an
 * inherited `CLAUDE_CONFIG_DIR` (a multi-account host's shell, say) would otherwise re-route the
 * child to whatever account that names.
 */
export function applyAccountEnv(env: Record<string, string | undefined>, account: ClaudeAccount): Record<string, string | undefined> {
  const bound: Record<string, string | undefined> = { ...env };
  for (const name of [...ACCOUNT_ENV_VARS, ...IDENTITY_SEED_ENV_VARS]) {
    delete bound[name];
  }
  return { ...bound, ...accountEnv(account) };
}

/** Where the CLI keeps `oauthAccount` and the rest of its global config for this account. */
export function accountGlobalConfigPath(account: ClaudeAccount): string {
  return account.defaultLocation === true ? join(dirname(account.configDir), '.claude.json') : join(account.configDir, '.claude.json');
}

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
 * Pure half: turns the environment into an account spec, touching no filesystem. Returns
 * `undefined` when no account is pinned. Throws only on input that is set but unusable -- a
 * malformed name or a relative override -- never on "the account does not exist", which is
 * `assertAccountUsable`'s job.
 *
 * `VERDANDI_CLAUDE_ACCOUNT=<name>` expands by the host's multi-account convention
 * (`$HOME/.claude-<name>` and `$HOME/.config/anthropic-<name>`). `VERDANDI_CLAUDE_CONFIG_DIR` and
 * `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` override either half for a host that lays its accounts
 * out differently; the name is then only a label.
 *
 * The CLI's own default location (`$HOME/.claude`, identity in `$HOME/.claude.json`) is an account
 * location in its own right (`defaultLocation`), named either way:
 * - `VERDANDI_CLAUDE_ACCOUNT=default` -- the reserved name `default` means exactly that location, and
 *   refuses any directory override that says otherwise;
 * - `VERDANDI_CLAUDE_CONFIG_DIR=default` (or the literal path `$HOME/.claude`, which means the same
 *   thing and would otherwise hit the null-identity trap described on `defaultLocation`) -- for an
 *   account with its own name, e.g. a host whose only login, `work`, sits at the default location.
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

  // Untrimmed, like requireHome below: the directory detected here must be the directory used.
  const home = env.HOME;
  const defaultDir = home !== undefined && home !== '' && isAbsolute(home) ? resolve(home, '.claude') : undefined;
  const overrideIsDefault =
    configOverride === DEFAULT_ACCOUNT_NAME ||
    (configOverride !== undefined && defaultDir !== undefined && isAbsolute(configOverride) && resolve(configOverride) === defaultDir);
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
    return { name: raw, configDir: resolve(requireHome(env, 'the default location'), '.claude'), anthropicConfigDir: '', defaultLocation: true };
  }

  const configDir =
    configOverride !== undefined
      ? requireAbsolute(configOverride, 'VERDANDI_CLAUDE_CONFIG_DIR')
      : join(requireHome(env, 'VERDANDI_CLAUDE_CONFIG_DIR'), `.claude-${raw}`);
  const anthropicConfigDir =
    anthropicOverride !== undefined
      ? requireAbsolute(anthropicOverride, 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR')
      : join(requireHome(env, 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR'), '.config', `anthropic-${raw}`);

  return { name: raw, configDir, anthropicConfigDir };
}

/**
 * Impure half: refuses a pinned account that cannot actually authenticate, at startup, rather than
 * letting the first real job discover it. Both failures below are otherwise silent-ish -- an
 * unset/absent config dir makes the CLI fall back to a default account, and a config dir with no
 * stored credentials makes it behave as logged out -- and both surface far from their cause.
 *
 * `anthropicConfigDir` is deliberately not checked: the CLI creates it on demand, and an empty one
 * is the normal state on this host.
 */
export function assertAccountUsable(account: ClaudeAccount, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(account.configDir) || !statSync(account.configDir).isDirectory()) {
    throw new Error(
      `claude account ${JSON.stringify(account.name)} is pinned but its config directory ${account.configDir} does not exist (or is not a directory)`,
    );
  }
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== '') {
    return;
  }
  if (!existsSync(join(account.configDir, '.credentials.json'))) {
    throw new Error(
      `claude account ${JSON.stringify(account.name)} is not logged in: ${join(account.configDir, '.credentials.json')} is missing and ANTHROPIC_API_KEY is unset`,
    );
  }
  if (account.defaultLocation === true) {
    assertDefaultLocationIntact(account);
  }
}

/**
 * At the default location the credentials ($HOME/.claude/.credentials.json) and the identity
 * ($HOME/.claude.json's `oauthAccount`) live in two different places, so something that moves one
 * without the other -- `ln -sfn ~/.claude-personal ~/.claude`, the usual way to switch accounts --
 * leaves a session billing one login while reporting another's email, and the email proof passes.
 * Under the convention both files sit in one directory and move together. So here all three paths
 * must be real (no symlinks), and the identity must actually be recorded.
 */
function assertDefaultLocationIntact(account: ClaudeAccount): void {
  const identityPath = accountGlobalConfigPath(account);
  for (const path of [account.configDir, join(account.configDir, '.credentials.json'), identityPath]) {
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      if (path === identityPath) {
        throw new Error(
          `claude account ${JSON.stringify(account.name)} is at the CLI default location but ${identityPath} is missing, so the login has no recorded identity`,
        );
      }
      continue; // the directory and the credentials were already checked for existence above
    }
    if (isLink) {
      throw new Error(
        `claude account ${JSON.stringify(account.name)} is at the CLI default location but ${path} is a symlink; credentials and identity could then belong to different logins`,
      );
    }
  }
  let email: unknown;
  try {
    email = (JSON.parse(readFileSync(identityPath, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
  } catch (error) {
    throw new Error(`claude account ${JSON.stringify(account.name)}: ${identityPath} is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error(
      `claude account ${JSON.stringify(account.name)} is at the CLI default location but ${identityPath} records no oauthAccount.emailAddress, so the login has no recorded identity`,
    );
  }
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
