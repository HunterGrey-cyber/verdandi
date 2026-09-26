import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentWatchFromEnv } from '../src/parentWatch.js';

test('parentWatchFromEnv: unset or blank is the stdin watch that ships', () => {
  assert.equal(parentWatchFromEnv({}), 'stdin');
  assert.equal(parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: '' }), 'stdin');
  assert.equal(parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: '   ' }), 'stdin');
});

test('parentWatchFromEnv: accepts exactly stdin and none', () => {
  assert.equal(parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: 'stdin' }), 'stdin');
  assert.equal(parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: 'none' }), 'none');
  assert.equal(parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: ' none ' }), 'none');
});

test('parentWatchFromEnv: anything else refuses, naming the variable, instead of falling back to stdin', () => {
  for (const raw of ['off', 'None', '0', 'false', 'systemd']) {
    assert.throws(() => parentWatchFromEnv({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: raw }), /VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: expected "stdin" or "none"/);
  }
});

/**
 * The real entry point, started the way a service manager starts it: stdin on /dev/null. A stub CLI
 * answers the startup version gate, and every account variable is cleared so nothing is pinned --
 * the process never spawns a session, so no real Claude is involved.
 */
function startLikeAServiceManager(extraEnv: Record<string, string>): { child: ChildProcess; socketPath: string; stderr: () => string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-pw-'));
  const socketPath = join(dir, 'sidecar.sock');
  const stubCli = join(dir, 'claude');
  writeFileSync(stubCli, '#!/bin/sh\necho "2.1.263 (Claude Code)"\n');
  chmodSync(stubCli, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('VERDANDI_CLAUDE_') || ['CLAUDE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'].includes(name)) {
      delete env[name];
    }
  }
  Object.assign(env, { VERDANDI_CLAUDE_SIDECAR_SOCKET: socketPath, VERDANDI_CLAUDE_CLI_PATH: stubCli }, extraEnv);
  // Resolved from this file (dist/tests/) rather than the cwd: the root `npm test` runs from the repo root.
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, socketPath, stderr: () => stderr, dir };
}

function exited(child: ChildProcess, withinMs: number): Promise<number | null | 'still running'> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), withinMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(condition: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return condition();
}

test('control: with the default stdin watch, a /dev/null stdin stops the sidecar at once with exit 0', async () => {
  const { child, stderr, dir } = startLikeAServiceManager({});
  try {
    assert.equal(await exited(child, 15_000), 0);
    assert.match(stderr(), /stdin reached EOF/);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH=none: a /dev/null stdin keeps serving, and SIGTERM still stops it cleanly', async () => {
  const { child, socketPath, stderr, dir } = startLikeAServiceManager({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: 'none' });
  try {
    assert.ok(await waitFor(() => existsSync(socketPath) || child.exitCode !== null, 15_000), `no socket within 15s; stderr: ${stderr()}`);
    assert.ok(existsSync(socketPath), `exited before binding; stderr: ${stderr()}`);
    // The failure being fixed is an exit within milliseconds of start; a second past the bind is
    // well beyond it.
    assert.equal(await exited(child, 1_000), 'still running', `stderr: ${stderr()}`);
    assert.match(stderr(), /parent watch is off/);
    assert.doesNotMatch(stderr(), /stdin reached EOF/);
    child.kill('SIGTERM');
    assert.equal(await exited(child, 15_000), 0);
    assert.match(stderr(), /received SIGTERM, shutting down/);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH refuses to boot with exit 1 and names the variable', async () => {
  const { child, socketPath, stderr, dir } = startLikeAServiceManager({ VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: 'off' });
  try {
    assert.equal(await exited(child, 15_000), 1);
    assert.match(stderr(), /VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: expected "stdin" or "none", got "off"/);
    assert.ok(!existsSync(socketPath));
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
