import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realAccount } from './realConfig.js';

/** What a real-SDK test run takes its account from: a name with explicit directories, never a bare name. */

test('realAccount: nothing set pins nothing; a name without a directory is refused instead of falling back to the shell', () => {
  assert.equal(realAccount({ HOME: '/nonexistent-home-should-never-be-touched' }), undefined);
  assert.throws(() => realAccount({ VERDANDI_CLAUDE_ACCOUNT: 'test' }), /set without VERDANDI_CLAUDE_CONFIG_DIR/);
});

test('realAccount: a name with explicit directories pins that account; directories without a name are ignored, as the sidecar ignores them', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdandi-real-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.credentials.json'), '{}');
  const dirs = { VERDANDI_CLAUDE_CONFIG_DIR: dir, VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/srv/anthropic-test' };
  assert.equal(realAccount(dirs), undefined, 'an ambient directory alone never pins');
  assert.equal(realAccount({ VERDANDI_CLAUDE_CONFIG_DIR: dir }), undefined);
  const env = { ...dirs, VERDANDI_CLAUDE_ACCOUNT: 'test' };
  assert.deepEqual(realAccount(env), { name: 'test', configDir: dir, anthropicConfigDir: '/srv/anthropic-test' });
  assert.throws(() => realAccount({ VERDANDI_CLAUDE_ACCOUNT: 'test', VERDANDI_CLAUDE_CONFIG_DIR: dir }), /needs its Anthropic config directory/);
  assert.throws(() => realAccount({ ...env, VERDANDI_CLAUDE_CONFIG_DIR: '/nonexistent/login' }), /does not exist/);
});
