import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActualClaudeCodeVersion, resolveClaudeCliPath } from '../src/runtimeServiceImpl.js';

test('resolveClaudeCliPath: defaults to PATH lookup, which is all a plain install needs', () => {
  assert.equal(resolveClaudeCliPath({}), 'claude');
  assert.equal(resolveClaudeCliPath({ VERDANDI_CLAUDE_CLI_PATH: '' }), 'claude');
  assert.equal(resolveClaudeCliPath({ VERDANDI_CLAUDE_CLI_PATH: '   ' }), 'claude');
});

test('resolveClaudeCliPath: an explicit path wins, for hosts whose PATH `claude` is a guarded launcher', () => {
  assert.equal(resolveClaudeCliPath({ VERDANDI_CLAUDE_CLI_PATH: '/home/someone/.local/bin/claude' }), '/home/someone/.local/bin/claude');
});

test('getActualClaudeCodeVersion: reads the leading version token', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdandi-cli-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'claude');
  writeFileSync(fake, '#!/bin/sh\necho "2.1.270 (Claude Code)"\n');
  chmodSync(fake, 0o755);
  assert.equal(getActualClaudeCodeVersion(fake), '2.1.270');
});

/**
 * The shape this actually failed as on a multi-account host: a guarded launcher ahead of the real
 * binary in PATH explains its refusal on stderr and exits non-zero. The old probe discarded both,
 * leaving a startup failure whose only text was "could not determine the installed claude CLI
 * version" -- true, but naming neither the binary it ran nor the reason it was refused.
 */
test('getActualClaudeCodeVersion: a refusing launcher surfaces its own stderr and exit status', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdandi-cli-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'claude');
  writeFileSync(fake, '#!/bin/sh\necho "claude-launcher: refusing to start outside an approved session" >&2\nexit 64\n');
  chmodSync(fake, 0o755);
  assert.throws(
    () => getActualClaudeCodeVersion(fake),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /exit status 64/);
      assert.match(message, /refusing to start outside an approved session/);
      assert.match(message, new RegExp(fake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('getActualClaudeCodeVersion: a missing binary names the path it tried', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdandi-cli-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'not-installed');
  assert.throws(() => getActualClaudeCodeVersion(missing), new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
