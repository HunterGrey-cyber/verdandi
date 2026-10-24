import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountEnv,
  accountGlobalConfigPath,
  applyAccountEnv,
  assertAccountUsable,
  effectiveClaudeConfigDir,
  explicitAccount,
  isDefaultConfigDir,
} from '../src/account.js';

/**
 * The account mechanism: explicit directories in, an account out, then the usability checks and the
 * environment tuple. How a host arrives at its directories (a name that expands to a pair, say) is not
 * this package's business and is tested where it lives, in the sidecar's legacyAccountName tests.
 */

/** A throwaway HOME with one account directory under it. Returned paths are absolute so the specs
 * built from them are indistinguishable from a real host's. */
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

/** The account the old tests got from `VERDANDI_CLAUDE_ACCOUNT=<name>`, stated as directories. */
function accountAt(home: string, name: string) {
  return explicitAccount({ label: name, configDir: join(home, `.claude-${name}`), anthropicConfigDir: join(home, '.config', `anthropic-${name}`) }, { HOME: home });
}

test('explicitAccount: absolute directories and a label, with no name needed to derive anything', () => {
  assert.deepEqual(
    explicitAccount({ label: 'work', configDir: '/srv/claude/cfg', anthropicConfigDir: '/srv/claude/anthropic' }, {}),
    { name: 'work', configDir: '/srv/claude/cfg', anthropicConfigDir: '/srv/claude/anthropic' },
  );
  // The directories are taken as given, never normalised and never derived from the label.
  assert.equal(explicitAccount({ label: 'x', configDir: '/srv/a/../b', anthropicConfigDir: '/srv/c' }, {}).configDir, '/srv/a/../b');
});

test('explicitAccount: a relative directory is refused, and an explicit directory needs its Anthropic directory', () => {
  assert.throws(() => explicitAccount({ label: 'work', configDir: 'relative/path', anthropicConfigDir: '/srv/a' }, {}), /VERDANDI_CLAUDE_CONFIG_DIR must be an absolute path/);
  assert.throws(() => explicitAccount({ label: 'work', configDir: '/srv/cfg', anthropicConfigDir: 'relative' }, {}), /VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR must be an absolute path/);
  assert.throws(() => explicitAccount({ label: 'work', configDir: '/srv/cfg' }, {}), /needs its Anthropic config directory too/);
});

test('explicitAccount: a label is a non-empty single line', () => {
  for (const label of ['', '   ', 'two\nlines', 'tab\there']) {
    assert.throws(() => explicitAccount({ label, configDir: '/srv/cfg', anthropicConfigDir: '/srv/a' }, {}), /label/, JSON.stringify(label));
  }
  assert.equal(explicitAccount({ label: 'has space.ok', configDir: '/srv/cfg', anthropicConfigDir: '/srv/a' }, {}).name, 'has space.ok');
});

test('explicitAccount: the keyword `default`, and the literal path $HOME/.claude, mean the CLI default location', () => {
  const expected = { name: 'work', configDir: '/home/nobody/.claude', anthropicConfigDir: '', defaultLocation: true };
  assert.deepEqual(explicitAccount({ label: 'work', configDir: 'default' }, { HOME: '/home/nobody' }), expected);
  assert.deepEqual(explicitAccount({ label: 'work', configDir: '/home/nobody/.claude' }, { HOME: '/home/nobody' }), expected);
  assert.deepEqual(explicitAccount({ label: 'work', configDir: '/home/nobody/.claude/' }, { HOME: '/home/nobody/' }), expected);
  // Only the exact default directory is special; a neighbour is an ordinary explicit directory.
  assert.equal(explicitAccount({ label: 'work', configDir: '/home/nobody/.claude-x', anthropicConfigDir: '/srv/a' }, { HOME: '/home/nobody' }).defaultLocation, undefined);
  assert.equal(isDefaultConfigDir('default', {}), true);
  assert.equal(isDefaultConfigDir('/home/nobody/.claude', { HOME: '/home/nobody' }), true);
  assert.equal(isDefaultConfigDir('/home/nobody/.claude', {}), false, 'with no HOME only the keyword names the default location');
  assert.equal(isDefaultConfigDir('relative/.claude', { HOME: 'relative' }), false);
});

test('explicitAccount: the default location refuses an Anthropic directory and needs a HOME', () => {
  assert.throws(
    () => explicitAccount({ label: 'work', configDir: 'default', anthropicConfigDir: '/srv/anthropic' }, { HOME: '/home/nobody' }),
    /VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location/,
  );
  assert.throws(() => explicitAccount({ label: 'work', configDir: 'default' }, {}), /HOME is not set to an absolute path/);
  assert.throws(() => explicitAccount({ label: 'work', configDir: 'default' }, { HOME: 'relative' }), /HOME is not set to an absolute path/);
});

test('effectiveClaudeConfigDir: a pinned account\'s directory; unpinned, the inherited CLAUDE_CONFIG_DIR (empty when relative), else $HOME/.claude, else empty', () => {
  const pinned = explicitAccount({ label: 'work', configDir: '/srv/claude/cfg', anthropicConfigDir: '/srv/a' }, {});
  assert.equal(effectiveClaudeConfigDir(pinned, { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: '/other' }), '/srv/claude/cfg', 'the account wins over an inherited variable');
  const atDefault = explicitAccount({ label: 'work', configDir: 'default' }, { HOME: '/home/nobody' });
  assert.equal(effectiveClaudeConfigDir(atDefault, { HOME: '/home/nobody' }), '/home/nobody/.claude');

  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: '/srv/inherited' }), '/srv/inherited');
  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: '/home/nobody' }), '/home/nobody/.claude');
  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: '' }), '/home/nobody/.claude');
  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: 'relative/dir' }), '');
  assert.equal(effectiveClaudeConfigDir(undefined, { CLAUDE_CONFIG_DIR: '/srv/inherited' }), '/srv/inherited', 'no HOME is not needed when the variable is absolute');
  assert.equal(effectiveClaudeConfigDir(undefined, {}), '');
  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: '' }), '');
  assert.equal(effectiveClaudeConfigDir(undefined, { HOME: 'relative' }), '');
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
  const spec = accountAt(home, 'work');
  assert.doesNotThrow(() => assertAccountUsable(spec, {}));
});

test('assertAccountUsable: a missing account directory fails loudly rather than silently falling back', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false, withConfigDir: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = accountAt(home, 'work');
  assert.throws(() => assertAccountUsable(spec, {}), /does not exist/);
});

test('assertAccountUsable: an account directory with no credentials is a not-logged-in failure', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = accountAt(home, 'work');
  assert.throws(() => assertAccountUsable(spec, {}), /not logged in/);
});

test('assertAccountUsable: ANTHROPIC_API_KEY is an accepted substitute for stored credentials', (t) => {
  const home = makeFakeHome({ name: 'work', withCredentials: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = accountAt(home, 'work');
  assert.doesNotThrow(() => assertAccountUsable(spec, { ANTHROPIC_API_KEY: 'sk-test' }));
});

test('accountEnv / applyAccountEnv: the default location removes the whole tuple, other accounts replace it', () => {
  const inherited = { PATH: '/usr/bin', HOME: '/home/nobody', CLAUDE_PROFILE: 'personal', CLAUDE_CONFIG_DIR: '/home/nobody/.claude-personal', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/nobody/.claude-personal', ANTHROPIC_CONFIG_DIR: '/home/nobody/.config/anthropic-personal' };
  const atDefault = explicitAccount({ label: 'work', configDir: 'default' }, { HOME: '/home/nobody' });
  assert.deepEqual(accountEnv(atDefault), {});
  assert.deepEqual(applyAccountEnv(inherited, atDefault), { PATH: '/usr/bin', HOME: '/home/nobody' });

  const explicit = accountAt('/home/nobody', 'work');
  assert.deepEqual(applyAccountEnv(inherited, explicit), {
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
  assert.equal(accountGlobalConfigPath(explicitAccount({ label: 'default', configDir: 'default' }, { HOME: '/home/nobody' })), '/home/nobody/.claude.json');
  assert.equal(accountGlobalConfigPath(accountAt('/home/nobody', 'work')), '/home/nobody/.claude-work/.claude.json');
});

test('assertAccountUsable: the default location needs both the credentials and $HOME/.claude.json', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verdandi-account-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  const spec = explicitAccount({ label: 'work', configDir: 'default' }, { HOME: home });
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
  const spec = explicitAccount({ label: 'work', configDir: 'default' }, { HOME: home });
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
  for (const account of [accountAt('/home/nobody', 'work'), explicitAccount({ label: 'work', configDir: 'default' }, { HOME: '/home/nobody' })]) {
    const bound = applyAccountEnv(seeded, account);
    for (const name of ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_ORGANIZATION_UUID']) {
      assert.equal(name in bound, false, `${name} must be removed`);
    }
    assert.equal(bound.PATH, '/usr/bin');
  }
});
