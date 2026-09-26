import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountEnv, accountGlobalConfigPath, applyAccountEnv, assertAccountUsable, resolveAccount, resolveAccountSpec } from '../src/account.js';

/** A throwaway HOME whose layout mirrors the host's multi-account convention. Returned paths are
 * absolute so the specs built from them are indistinguishable from a real host's. */
function makeFakeHome(options: { name: string; withCredentials: boolean; withConfigDir?: boolean }): string {
  const home = mkdtempSync(join(tmpdir(), 'verdandi-account-test-'));
  if (options.withConfigDir !== false) {
    const configDir = join(home, `.claude-${options.name}`);
    mkdirSync(configDir, { recursive: true });
    if (options.withCredentials) {
      writeFileSync(join(configDir, '.credentials.json'), '{}');
    }
  }
  return home;
}

test('resolveAccountSpec: unset VERDANDI_CLAUDE_ACCOUNT pins nothing (the shipped default)', () => {
  assert.equal(resolveAccountSpec({ HOME: '/home/nobody' }), undefined);
  assert.equal(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: '' }), undefined);
  assert.equal(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: '   ' }), undefined);
});

test('resolveAccountSpec: a bare name expands via the host multi-account convention', () => {
  const spec = resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work' });
  assert.deepEqual(spec, {
    name: 'work',
    configDir: '/home/nobody/.claude-work',
    anthropicConfigDir: '/home/nobody/.config/anthropic-work',
  });
});

test('resolveAccountSpec: explicit directory overrides win over the convention', () => {
  const spec = resolveAccountSpec({
    HOME: '/home/nobody',
    VERDANDI_CLAUDE_ACCOUNT: 'work',
    VERDANDI_CLAUDE_CONFIG_DIR: '/srv/claude/cfg',
    VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/srv/claude/anthropic',
  });
  assert.deepEqual(spec, {
    name: 'work',
    configDir: '/srv/claude/cfg',
    anthropicConfigDir: '/srv/claude/anthropic',
  });
});

test('resolveAccountSpec: a name that could escape the convention path is rejected', () => {
  for (const name of ['../evil', 'a/b', '.', '..', 'has space', '']) {
    const env = { HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: name };
    if (name === '') {
      assert.equal(resolveAccountSpec(env), undefined);
      continue;
    }
    assert.throws(() => resolveAccountSpec(env), /VERDANDI_CLAUDE_ACCOUNT/);
  }
});

test('resolveAccountSpec: the convention needs HOME, and explicit overrides must be absolute', () => {
  assert.throws(() => resolveAccountSpec({ VERDANDI_CLAUDE_ACCOUNT: 'work' }), /HOME/);
  assert.throws(
    () => resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'relative/path' }),
    /absolute/,
  );
  // An explicit config dir alone still satisfies the spec; only the *other* path falls back to the
  // convention, which is what still needs HOME.
  assert.throws(
    () => resolveAccountSpec({ VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: '/srv/cfg' }),
    /HOME/,
  );
});

test('accountEnv: emits the whole four-variable tuple, with secure storage following the config dir', () => {
  assert.deepEqual(
    accountEnv({ name: 'work', configDir: '/home/nobody/.claude-work', anthropicConfigDir: '/home/nobody/.config/anthropic-work' }),
    {
      CLAUDE_PROFILE: 'work',
      CLAUDE_CONFIG_DIR: '/home/nobody/.claude-work',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/nobody/.claude-work',
      ANTHROPIC_CONFIG_DIR: '/home/nobody/.config/anthropic-work',
    },
  );
});

test('assertAccountUsable: a logged-in account directory passes', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work' })!;
  assert.doesNotThrow(() => assertAccountUsable(spec, {}));
});

test('assertAccountUsable: a missing account directory fails loudly rather than silently falling back', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false, withConfigDir: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work' })!;
  assert.throws(() => assertAccountUsable(spec, {}), /does not exist/);
});

test('assertAccountUsable: an account directory with no credentials is a not-logged-in failure', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work' })!;
  assert.throws(() => assertAccountUsable(spec, {}), /not logged in/);
});

test('assertAccountUsable: ANTHROPIC_API_KEY is an accepted substitute for stored credentials', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work' })!;
  assert.doesNotThrow(() => assertAccountUsable(spec, { ANTHROPIC_API_KEY: 'sk-test' }));
});

test('resolveAccount: unset means undefined and performs no filesystem checks at all', () => {
  assert.equal(resolveAccount({ HOME: '/nonexistent-home-should-never-be-touched' }), undefined);
});

test('resolveAccount: set means spec plus usability, in that order', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const account = resolveAccount({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work' });
  assert.equal(account?.name, 'work');
  assert.equal(account?.configDir, join(home, '.claude-work'));
});

/**
 * The CLI's own default location as an account location (host-b, 2026-09-25: its only login,
 * work, sits at ~/.claude). Setting CLAUDE_CONFIG_DIR=$HOME/.claude explicitly makes the CLI read
 * $HOME/.claude/.claude.json and report a null email, so this location is bound by the tuple being
 * ABSENT from the child's environment.
 */
test('resolveAccountSpec: VERDANDI_CLAUDE_ACCOUNT=default is the CLI default location', () => {
  assert.deepEqual(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'default' }), {
    name: 'default',
    configDir: '/home/nobody/.claude',
    anthropicConfigDir: '',
    defaultLocation: true,
  });
});

test('resolveAccountSpec: a named account can live at the default location, by keyword or by its literal path', () => {
  const expected = { name: 'work', configDir: '/home/nobody/.claude', anthropicConfigDir: '', defaultLocation: true };
  assert.deepEqual(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default' }), expected);
  assert.deepEqual(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: '/home/nobody/.claude' }), expected);
  assert.deepEqual(resolveAccountSpec({ HOME: '/home/nobody/', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: '/home/nobody/.claude/' }), expected);
  // Only the exact default directory is special; a neighbour is an ordinary explicit directory.
  assert.equal(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: '/home/nobody/.claude-x' })?.defaultLocation, undefined);
});

test('resolveAccountSpec: the default location refuses contradictions instead of half-honouring them', () => {
  assert.throws(
    () => resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'default', VERDANDI_CLAUDE_CONFIG_DIR: '/srv/claude/elsewhere' }),
    /names the CLI's default location, but VERDANDI_CLAUDE_CONFIG_DIR="\/srv\/claude\/elsewhere" names another/,
  );
  assert.throws(
    () => resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'default', VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/srv/anthropic' }),
    /VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location/,
  );
  assert.throws(
    () => resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default', VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/srv/anthropic' }),
    /cannot be combined/,
  );
  assert.throws(() => resolveAccountSpec({ VERDANDI_CLAUDE_ACCOUNT: 'default' }), /HOME is not/);
});

test('accountEnv / applyAccountEnv: the default location removes the whole tuple, other accounts replace it', () => {
  const inherited = { PATH: '/usr/bin', HOME: '/home/nobody', CLAUDE_PROFILE: 'personal', CLAUDE_CONFIG_DIR: '/home/nobody/.claude-personal', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/nobody/.claude-personal', ANTHROPIC_CONFIG_DIR: '/home/nobody/.config/anthropic-personal' };
  const atDefault = resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default' })!;
  assert.deepEqual(accountEnv(atDefault), {});
  assert.deepEqual(applyAccountEnv(inherited, atDefault), { PATH: '/usr/bin', HOME: '/home/nobody' });

  const convention = resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work' })!;
  assert.deepEqual(applyAccountEnv(inherited, convention), {
    PATH: '/usr/bin',
    HOME: '/home/nobody',
    CLAUDE_PROFILE: 'work',
    CLAUDE_CONFIG_DIR: '/home/nobody/.claude-work',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/nobody/.claude-work',
    ANTHROPIC_CONFIG_DIR: '/home/nobody/.config/anthropic-work',
  });
  // Never mutates what it was given.
  assert.equal(inherited.CLAUDE_CONFIG_DIR, '/home/nobody/.claude-personal');
});

test('accountGlobalConfigPath: $HOME/.claude.json at the default location, <configDir>/.claude.json elsewhere', () => {
  assert.equal(accountGlobalConfigPath(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'default' })!), '/home/nobody/.claude.json');
  assert.equal(accountGlobalConfigPath(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work' })!), '/home/nobody/.claude-work/.claude.json');
});

test('assertAccountUsable: the default location needs both the credentials and $HOME/.claude.json', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verdandi-account-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default' })!;
  assert.throws(() => assertAccountUsable(spec, {}), /not logged in/);
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  assert.throws(() => assertAccountUsable(spec, {}), /\.claude\.json is missing, so the login has no recorded identity/);
  // Present is not enough: the identity has to be recorded in it.
  writeFileSync(join(home, '.claude.json'), '{}');
  assert.throws(() => assertAccountUsable(spec, {}), /records no oauthAccount\.emailAddress/);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  assert.doesNotThrow(() => assertAccountUsable(spec, {}));
});

/**
 * `ln -sfn ~/.claude-personal ~/.claude` moves the credentials but not $HOME/.claude.json, so the
 * session would bill personal while reporting work's email -- and the email proof would pass.
 */
test('assertAccountUsable: at the default location a symlinked ~/.claude, credentials file or ~/.claude.json is refused', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verdandi-account-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude-personal'));
  writeFileSync(join(home, '.claude-personal', '.credentials.json'), '{}');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  symlinkSync(join(home, '.claude-personal'), join(home, '.claude'));
  const spec = resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default' })!;
  assert.throws(() => assertAccountUsable(spec, {}), /\/\.claude is a symlink/);

  rmSync(join(home, '.claude'));
  mkdirSync(join(home, '.claude'));
  symlinkSync(join(home, '.claude-personal', '.credentials.json'), join(home, '.claude', '.credentials.json'));
  assert.throws(() => assertAccountUsable(spec, {}), /\.credentials\.json is a symlink/);

  rmSync(join(home, '.claude', '.credentials.json'));
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  writeFileSync(join(home, 'other.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  rmSync(join(home, '.claude.json'));
  symlinkSync(join(home, 'other.json'), join(home, '.claude.json'));
  assert.throws(() => assertAccountUsable(spec, {}), /\.claude\.json is a symlink/);
});

test('applyAccountEnv: identity-seeding variables never reach a pinned account\'s child, in either layout', () => {
  const seeded = { PATH: '/usr/bin', CLAUDE_CODE_ACCOUNT_UUID: 'u', CLAUDE_CODE_USER_EMAIL: 'someone@example.invalid', CLAUDE_CODE_ORGANIZATION_UUID: 'o' };
  for (const env of [
    { HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work' },
    { HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'work', VERDANDI_CLAUDE_CONFIG_DIR: 'default' },
  ]) {
    const bound = applyAccountEnv(seeded, resolveAccountSpec(env)!);
    for (const name of ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_ORGANIZATION_UUID']) {
      assert.equal(name in bound, false, `${name} must be removed`);
    }
    assert.equal(bound.PATH, '/usr/bin');
  }
});
