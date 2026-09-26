import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { startSidecar } from '../src/lifecycle.js';
import { RuntimeServiceClient, ReplayStart } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * Does grpc-js's per-subscriber write queue actually grow without bound when a watcher stops
 * reading the SOCKET?
 *
 * ### Why this test had to exist on this side, and why a consumer could not produce it
 *
 * The downstream consumer instrumented a real stall and measured `outstanding=0` across 875 writes
 * and two real partial-streaming turns, including a 30-second window in which it never called
 * `pump()`. That zero is correct and proves nothing about this question, for a reason worth writing
 * down: **a `pump()` stall is not a socket stall.** That client's watch task reads the transport
 * continuously into its own buffer and `pump()` only drains that buffer, so a consumer that has
 * stopped pumping is still, at the transport layer, a perfectly attentive reader. The server-side
 * queue cannot grow no matter how long it stalls.
 *
 * Reproducing it needs a subscriber that stops reading the socket itself. `SIGSTOP` on that client
 * would do it and would also block the sidecar's stderr pipe -- which is where the stats seam
 * writes -- so the instrument would jam the thing it measures. Here the subscriber is a grpc-js
 * client in this process, and `call.pause()` stops the transport read directly, with nothing in the
 * way of the diagnostic.
 *
 * Real UDS, real grpc-js server, real codec. The only fake is the event PRODUCER, which is the one
 * part that must not be real: it makes this cost no model turn and lets the rate be whatever the
 * loop can manage.
 */

const SOCKET_DIRS: string[] = [];

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wq-'));
  SOCKET_DIRS.push(dir);
  return join(dir, 'sock');
}

const VERSIONS = { sdkDeclared: '2.1.252', hostCli: '2.1.267' } as const;
const CLASSIFY = () => ({ kind: 'tested' }) as never;

test('a subscriber that stops reading the socket makes grpc-js queue without bound, and the seam sees it', async (t) => {
  const path = socketPath();
  let controller: ReturnType<typeof makeFakeSession>['controller'] | undefined;
  const lines: string[] = [];

  const sidecar = await startSidecar({
    socketPath: path,
    sessionFactory: () => {
      const made = makeFakeSession();
      controller = made.controller;
      return made.session;
    },
    getClaudeCodeVersions: () => VERSIONS,
    classifyCliVersion: CLASSIFY,
    runtime: {
      writeQueueStats: { intervalMs: 20 },
      onDiagnostic: (line) => lines.push(line),
    },
  });

  const client = new RuntimeServiceClient(`unix://${path}`, grpc.credentials.createInsecure());
  t.after(async () => {
    client.close();
    await sidecar.close();
    for (const dir of SOCKET_DIRS) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const sessionId = await new Promise<string>((resolve, reject) => {
    client.createSession({ cwd: '/tmp/project' } as never, (err, res) =>
      err ? reject(err) : resolve((res as { sessionId: string }).sessionId),
    );
  });

  const call = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_FROM_NOW } as never);
  let received = 0;
  call.on('data', () => {
    received += 1;
  });
  call.on('error', () => {});
  // Let the stream establish before anything is produced, so the pause below is the only reason
  // anything queues.
  await new Promise((r) => setTimeout(r, 150));

  // THE STALL: stop reading the transport. Not "stop processing" -- stop reading.
  call.pause();

  // Produce hard. Each pump tick broadcasts everything queued since the last one.
  const TOTAL = 20_000;
  for (let i = 0; i < TOTAL; i += 1) {
    controller!.emit({ type: 'content_delta', turnId: 'wq', text: `chunk-${i}-${'x'.repeat(256)}` } as never);
  }
  await new Promise((r) => setTimeout(r, 1500));

  const peak = lines
    .map((l) => Number(/peak_outstanding=(\d+)/.exec(l)?.[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const buffered = lines
    .map((l) => Number(/buffered_writes=(\d+)/.exec(l)?.[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);

  assert.ok(lines.length > 0, 'the stats seam printed nothing at all, so this test measured nothing');
  assert.ok(
    peak > 0,
    `a subscriber that stopped reading the socket produced peak_outstanding=${peak}. Either grpc-js is applying backpressure somewhere this server cannot see, or the seam is not observing the right thing. Lines: ${JSON.stringify(lines.slice(-3))}`,
  );
  assert.ok(
    buffered > 0,
    `write() never returned false while the reader was paused (buffered_writes=${buffered}) -- the congestion signal this seam exists to read was never raised`,
  );

  // The other half: resuming must drain it, or "unbounded" would be the wrong diagnosis and the
  // real finding would be a leak rather than a queue.
  call.resume();
  await new Promise((r) => setTimeout(r, 1500));
  const last = lines.at(-1) ?? '';
  const finalOutstanding = Number(/ outstanding=(\d+)/.exec(last)?.[1] ?? -1);
  assert.equal(
    finalOutstanding,
    0,
    `after the subscriber resumed, the queue did not drain (${last}). A queue that never empties is a leak, which is a different defect from the one under test`,
  );
  assert.ok(received > 0, 'the resumed subscriber received nothing, so the queued events were lost rather than delivered');

  // Reported, not asserted: the number is the point of the exercise and belongs in the log even
  // when the test passes.
  console.log(`[write-queue] peak_outstanding=${peak} buffered_writes=${buffered} delivered_after_resume=${received} of ${TOTAL}`);
});
