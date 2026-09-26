import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { endChildProcesses, listChildPids, listChildPidsFromProc, parseProcStat, parsePsOutput } from '../src/childReaper.js';
import { RuntimeServiceClient } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/**
 * The sidecar ends its `claude` children before it exits (neovibe, 2026-09-25: a CLI outlived the
 * sidecar by ~2.4 s, reparented to init). Pure parsing first, then real child processes, then the real
 * entry point with a stub CLI that -- like a CLI mid-turn -- does not stop when its stdin closes.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('parseProcStat reads state and ppid after the LAST parenthesis, so a comm with spaces and parens cannot shift them', () => {
  assert.deepEqual(parseProcStat('4242 (claude) S 100 4242 4242 0 -1'), { state: 'S', ppid: 100 });
  assert.deepEqual(parseProcStat('4243 (we ird) (name)) Z 7 1 1'), { state: 'Z', ppid: 7 });
  assert.equal(parseProcStat('garbage'), undefined);
});

test('listChildPidsFromProc: only live children of the given parent -- zombies are not live', () => {
  const root = mkdtempSync(join(tmpdir(), 'reaper-proc-'));
  try {
    const put = (pid: number, stat: string) => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), 'stat'), stat);
    };
    put(11, '11 (claude) S 10 11 11');
    put(12, '12 (claude) Z 10 11 11');
    put(13, '13 (other) R 99 13 13');
    put(14, '14 (x y) S 10 1 1');
    mkdirSync(join(root, 'self'));
    assert.deepEqual(listChildPidsFromProc(10, root), [11, 14]);
    assert.deepEqual(listChildPidsFromProc(10, join(root, 'missing')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parsePsOutput (the non-Linux path) applies the same rule', () => {
  const out = '   11    10 S\n   12    10 Z+\n   13    99 R\n   14    10 Ss\n';
  assert.deepEqual(parsePsOutput(out, 10), [11, 14]);
  // The `ps` that produced the listing is this process's child too, and must not be waited on.
  assert.deepEqual(parsePsOutput(out + '   15    10 R+\n', 10, 15), [11, 14]);
});

function nodeChild(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'ignore'] });
}

/** Resolves once `child` is running its script (it has installed its handlers). */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

const SHORT = { naturalExitMs: 100, termGraceMs: 800, killGraceMs: 800, pollMs: 10 };

test('endChildProcesses: nothing to do with no children, and says nothing', async () => {
  const lines: string[] = [];
  const report = await endChildProcesses(SHORT, { listChildren: () => [], onDiagnostic: (l) => lines.push(l) });
  assert.deepEqual(report, { found: [], terminated: [], killed: [], survivors: [] });
  assert.deepEqual(lines, []);
});

test('endChildProcesses: a child that stops on SIGTERM gets SIGTERM, and is gone -- reaped -- before it resolves', async () => {
  // Ignores stdin EOF like a CLI mid-turn; takes 200 ms to stop after SIGTERM.
  const child = nodeChild("process.stdin.resume(); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); setInterval(() => {}, 1000);");
  child.stdin!.end();
  await started(child);
  assert.ok(listChildPids(process.pid).includes(child.pid!), 'the real process table sees the child');
  const report = await endChildProcesses(SHORT);
  assert.deepEqual(report.found, [child.pid]);
  assert.deepEqual(report.terminated, [child.pid]);
  assert.deepEqual(report.killed, []);
  assert.ok(!listChildPids(process.pid).includes(child.pid!), 'no longer a live child when the promise resolves');
});

test('endChildProcesses: a child that ignores SIGTERM is SIGKILLed after the grace, never waited on forever', async () => {
  const child = nodeChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  await started(child);
  const lines: string[] = [];
  const t0 = Date.now();
  const report = await endChildProcesses(SHORT, { onDiagnostic: (l) => lines.push(l) });
  assert.deepEqual(report.killed, [child.pid]);
  assert.deepEqual(report.survivors, []);
  assert.ok(Date.now() - t0 < SHORT.naturalExitMs + SHORT.termGraceMs + SHORT.killGraceMs + 500);
  assert.ok(lines.some((l) => /SIGKILL/.test(l)), JSON.stringify(lines));
  // Dead, possibly not yet reaped (a zombie still answers kill(pid, 0) until Node's SIGCHLD handling
  // runs): the process table no longer lists it as live, and its exit is delivered.
  assert.ok(!listChildPids(process.pid).includes(child.pid!));
  const signal = await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(child.signalCode) : child.once('exit', (_c, sig) => resolve(sig))));
  assert.equal(signal, 'SIGKILL');
});

test('endChildProcesses: a child that exits on its own inside the natural grace is never signalled', async () => {
  const child = nodeChild('setTimeout(() => process.exit(0), 50);');
  const signals: string[] = [];
  const report = await endChildProcesses({ ...SHORT, naturalExitMs: 2000 }, { kill: (_pid, sig) => signals.push(sig) });
  assert.deepEqual(report.found, [child.pid]);
  assert.deepEqual(report.terminated, []);
  assert.deepEqual(signals, []);
});

/**
 * The whole path, as a host drives it: the real entry point, a real session created over gRPC, and a
 * stub standing in for the CLI the SDK spawns. The stub ignores stdin EOF (a CLI in the middle of a
 * turn does not stop when its stdin closes) and takes 300 ms to stop after SIGTERM. Then the host
 * closes the sidecar's stdin.
 *
 * Before the fix this failed: the sidecar exited within ~100 ms and the stub was left running under
 * init with nothing ever going to signal it (its SIGTERM was on an unref'd SDK timer that died with
 * the sidecar).
 */
test('the real sidecar, stdin closed while a session\'s CLI is running: the CLI is gone BEFORE the sidecar exits', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reaper-e2e-'));
  const socketPath = join(dir, 's.sock');
  const pidFile = join(dir, 'stub.pid');
  const exitFile = join(dir, 'stub.exit');
  const stubCli = join(dir, 'claude');
  writeFileSync(
    stubCli,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi',
      `echo $$ > '${pidFile}'`,
      `trap 'sleep 0.3; date +%s%N > "${exitFile}"; exit 0' TERM`,
      // Keeps running after stdin EOF; `cat` is not used so EOF cannot end it.
      'while true; do sleep 0.05; done',
      '',
    ].join('\n'),
  );
  chmodSync(stubCli, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('VERDANDI_CLAUDE_') || ['CLAUDE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'].includes(name)) {
      delete env[name];
    }
  }
  Object.assign(env, { VERDANDI_CLAUDE_SIDECAR_SOCKET: socketPath, VERDANDI_CLAUDE_CLI_PATH: stubCli });
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const sidecar = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  sidecar.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  let stubPid: number | undefined;
  const client = () => new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  let c: RuntimeServiceClient | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(socketPath), `sidecar never bound its socket; stderr:\n${stderr}`);
    c = client();
    await new Promise<void>((resolve, reject) =>
      c!.createSession({ cwd: dir, policy: undefined } as never, (err) => (err ? reject(err) : resolve())),
    );
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stubPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(stubPid), 'the stub CLI is running');

    const exited = new Promise<bigint>((resolve) => sidecar.once('exit', () => resolve(process.hrtime.bigint())));
    const wallAtClose = Date.now();
    sidecar.stdin!.end();
    await exited;
    const sidecarExitWallNs = BigInt(Date.now()) * 1_000_000n;

    assert.equal(alive(stubPid), false, `the CLI outlived the sidecar; stderr:\n${stderr}`);
    assert.ok(existsSync(exitFile), 'the stub ran its SIGTERM handler, i.e. it was ended gracefully, not killed');
    const stubExitNs = BigInt(readFileSync(exitFile, 'utf8').trim());
    assert.ok(stubExitNs <= sidecarExitWallNs, 'the stub finished before the sidecar exited');
    assert.ok(Date.now() - wallAtClose < 5000, 'bounded');
    assert.match(stderr, /sending SIGTERM to 1 child process/);
  } finally {
    c?.close();
    if (sidecar.exitCode === null) {
      sidecar.kill('SIGKILL');
    }
    if (stubPid !== undefined && alive(stubPid)) {
      process.kill(stubPid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
