import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Optional binding of every spawned Claude subprocess to one local account, named by explicit
 * directories.
 *
 * This is a **patch for hosts that run several Claude Code accounts side by side**, not part of
 * the normal contract: with no account pinned -- the shipped default -- nothing here engages,
 * `policyToBaseOptions` sets no `options.env` at all, the SDK's own `env: {...process.env}`
 * default stands, and the subprocess resolves its config and credentials exactly the way a plain
 * `claude` install does (`~/.claude`). Nothing in this module writes to disk or mutates the
 * sidecar's own environment; it only computes what to hand the child.
 *
 * What lives here is the mechanism and nothing about how a host lays its accounts out: an account is
 * an explicit configuration directory (or the CLI's own default location, by keyword), plus the
 * Anthropic configuration directory that goes with it. How a host arrives at those directories -- a
 * name that expands to a directory pair, say -- is the host's business; the sidecar's
 * `legacyAccountName` module does it for the hosts that still send a name.
 *
 * Why it exists: the SDK inherits the parent process's environment wholesale, so on a multi-account
 * host "which subscription does verdandi spend, and whose claude.ai connectors can it reach" was
 * decided by whichever shell happened to start the sidecar. That is an accident, not a
 * configuration.
 */
export type ClaudeAccount = {
  /** The account's label, e.g. `work`: what the handshake reports and what `CLAUDE_PROFILE` is set to. */
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
 * `accountEnv(account)` is written over it. For an account at an explicit directory
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

/** The user's home as an absolute path, or `undefined` when HOME is unset, empty or relative. Untrimmed:
 * the directory detected from it must be the directory used. */
function absoluteHome(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME;
  return home !== undefined && home !== '' && isAbsolute(home) ? home : undefined;
}

/**
 * Whether `configDir` names the CLI's own default location: the keyword `default`, or the literal path
 * `$HOME/.claude` (which means the same thing and would otherwise hit the null-identity trap described
 * on `ClaudeAccount.defaultLocation`). Only the exact directory counts; a neighbour such as
 * `$HOME/.claude-x` is an ordinary explicit directory. A relative path is never the default location
 * (it is refused later, as relative), and with no usable HOME only the keyword can be.
 */
export function isDefaultConfigDir(configDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (configDir === DEFAULT_ACCOUNT_NAME) {
    return true;
  }
  const home = absoluteHome(env);
  return home !== undefined && isAbsolute(configDir) && resolve(configDir) === resolve(home, '.claude');
}

/**
 * An account as a caller states it: directories, not a name.
 * - `label` is what the handshake reports as the account's name and what `CLAUDE_PROFILE` is set to.
 *   It is a label only; nothing is derived from it.
 * - `configDir` is an absolute directory, or `DEFAULT_ACCOUNT_NAME` (`default`) for the CLI's own
 *   default location (`$HOME/.claude`, identity in `$HOME/.claude.json`). The literal path
 *   `$HOME/.claude` is treated as that location too.
 * - `anthropicConfigDir` is the absolute `ANTHROPIC_CONFIG_DIR` that goes with the directory. It is
 *   required for an account at an explicit directory (the tuple is set whole or not at all, so there
 *   is no "leave it to the default"), and refused for the default location, where the account is used
 *   exactly as a plain `claude` finds it, default Anthropic config directory included.
 */
export type ExplicitAccountSpec = {
  label: string;
  configDir: string;
  anthropicConfigDir?: string;
};

/**
 * Pure half: turns explicit directories into an account, touching no filesystem. Throws on a spec
 * that is unusable as written -- a blank or multi-line label, a relative directory, a missing or
 * contradictory Anthropic directory, the default location without a HOME -- never on "the account
 * does not exist", which is `assertAccountUsable`'s job.
 */
export function explicitAccount(spec: ExplicitAccountSpec, env: NodeJS.ProcessEnv = process.env): ClaudeAccount {
  if (spec.label.trim() === '' || /[\u0000-\u001f\u007f]/.test(spec.label)) {
    throw new Error(`an account label must be a non-empty single line, got ${JSON.stringify(spec.label)}`);
  }
  if (isDefaultConfigDir(spec.configDir, env)) {
    if (spec.anthropicConfigDir !== undefined) {
      throw new Error(
        `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location: such an account is used exactly as a plain \`claude\` finds it`,
      );
    }
    const home = absoluteHome(env);
    if (home === undefined) {
      throw new Error('HOME is not set to an absolute path, so the CLI default location cannot be derived');
    }
    return { name: spec.label, configDir: resolve(home, '.claude'), anthropicConfigDir: '', defaultLocation: true };
  }
  const configDir = requireAbsolute(spec.configDir, 'VERDANDI_CLAUDE_CONFIG_DIR');
  if (spec.anthropicConfigDir === undefined) {
    throw new Error(`an account at an explicit directory needs its Anthropic config directory too (${JSON.stringify(configDir)} given alone)`);
  }
  return { name: spec.label, configDir, anthropicConfigDir: requireAbsolute(spec.anthropicConfigDir, 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR') };
}

/**
 * The configuration directory the CLI will really use for sessions this process creates, as the
 * handshake reports it. A pinned account's directory (at the default location, `$HOME/.claude`, with
 * no variable set on the child). Unpinned: the inherited `CLAUDE_CONFIG_DIR` when absolute, else
 * `$HOME/.claude`, else empty -- an unknown, which a host must not read as "nowhere". Only paths are
 * computed here; nothing under the directory is read.
 */
export function effectiveClaudeConfigDir(account: Pick<ClaudeAccount, 'configDir'> | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (account !== undefined) {
    return account.configDir;
  }
  const inherited = env.CLAUDE_CONFIG_DIR;
  if (inherited !== undefined && inherited !== '') {
    // A relative value is resolved by the CLI against a directory this process does not know, so
    // it is reported as unknown rather than as a directory the CLI may not be using.
    return isAbsolute(inherited) ? inherited : '';
  }
  const home = absoluteHome(env);
  return home === undefined ? '' : resolve(home, '.claude');
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
 * Under an explicit config directory both files sit in one place and move together. So here all three paths
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
    // The parser's error rides along as the cause, so a caller that must not repeat the file's contents
    // (JSON.parse quotes the text around the fault) can tell its words from this sentence.
    throw new Error(`claude account ${JSON.stringify(account.name)}: ${identityPath} is not readable JSON (${error instanceof Error ? error.message : String(error)})`, {
      cause: error,
    });
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error(
      `claude account ${JSON.stringify(account.name)} is at the CLI default location but ${identityPath} records no oauthAccount.emailAddress, so the login has no recorded identity`,
    );
  }
}
