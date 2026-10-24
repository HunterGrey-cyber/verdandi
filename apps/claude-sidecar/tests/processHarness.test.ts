import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSidecar } from './compat/processHarness.js';

/**
 * The frozen suites compare a refused process's stderr byte for byte, so the harness's exited() must not
 * resolve before that stderr has been read to its end: the process exiting is not the same moment as its
 * stderr being drained. Here the two are pulled apart on purpose. A preload makes the sidecar start a
 * process that shares its stderr and writes to it only once the sidecar is gone; exited() must wait for
 * that text and the end of the stream, not for the exit.
 */
test('processHarness: exited() resolves only once the process\'s stderr has been read to its end', { timeout: 60_000 }, async () => {
  const marker = 'WRITTEN-AFTER-THE-SIDECAR-EXITED';
  const dir = mkdtempSync(join(tmpdir(), 'harness-close-'));
  const preload = join(dir, 'straggler.cjs');
  writeFileSync(
    preload,
    [
      "const { spawn } = require('node:child_process');",
      `spawn('sh', ['-c', 'while kill -0 ${'$'}PPID 2>/dev/null; do sleep 0.05; done; echo ${marker} >&2'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref();`,
      '',
    ].join('\n'),
  );
  // The probed CLI refuses, so the sidecar exits 1 right after starting.
  const sidecar = spawnSidecar({ stub: '#!/bin/sh\nexit 64\n', env: { NODE_OPTIONS: `--require ${preload}` } });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    assert.ok(sidecar.stderr().includes(marker), `exited() resolved before stderr ended:\n${sidecar.stderr()}`);
  } finally {
    sidecar.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
