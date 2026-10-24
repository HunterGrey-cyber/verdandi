import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitAccount } from '@verdandi/claude-runtime';
import { resolveAccount, resolveAccountSpec } from '../src/legacyAccountName.js';

/**
 * The name convention (`VERDANDI_CLAUDE_ACCOUNT=<name>` -> `$HOME/.claude-<name>` and
 * `$HOME/.config/anthropic-<name>`, the reserved name `default`, the two directory overrides) as the
 * sidecar's legacy module resolves it. These cases lived in the runtime package's account tests while
 * the convention did; they moved here unchanged, with the module they test. The mechanism cases
 * (usability, the environment tuple, the default location by explicit directory) stay with the
 * package, in packages/claude-runtime/tests/account.test.ts.
 */

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


test('resolveAccountSpec: an explicit directory without a name pins nothing (VERDANDI_CLAUDE_CONFIG_DIR alone is ignored, as it always was)', () => {
  assert.equal(resolveAccountSpec({ HOME: '/home/nobody', VERDANDI_CLAUDE_CONFIG_DIR: '/srv/claude/cfg', VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/srv/claude/anthropic' }), undefined);
  assert.equal(resolveAccount({ HOME: '/nonexistent-home-should-never-be-touched', VERDANDI_CLAUDE_CONFIG_DIR: 'default' }), undefined);
});

test('resolveAccountSpec: what the layout resolves to is what the mechanism is given, so the two cannot drift', () => {
  const env = { HOME: '/home/nobody', VERDANDI_CLAUDE_ACCOUNT: 'tester' };
  assert.deepEqual(
    resolveAccountSpec(env),
    explicitAccount({ label: 'tester', configDir: '/home/nobody/.claude-tester', anthropicConfigDir: '/home/nobody/.config/anthropic-tester' }, env),
  );
  assert.deepEqual(resolveAccountSpec({ ...env, VERDANDI_CLAUDE_ACCOUNT: 'default' }), explicitAccount({ label: 'default', configDir: 'default' }, env));
});
