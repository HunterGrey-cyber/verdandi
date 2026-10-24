import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { startSidecar } from '../src/lifecycle.js';
import { RuntimeServiceClient, ReplayStart, ErrorCode, ErrorDetail, type SessionEvent } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * A watcher that stops reading the SOCKET: grpc-js queues its messages in the sidecar's heap, and the
 * write-queue bound (PACKAGING.md section 6) ends it with EVENT_GAP when what it holds reaches the
 * replay ring's capacity -- while the session, and a second watcher that keeps reading, carry on.
 *
 * ### Why the stall has to be at the transport
 *
 * A downstream consumer once instrumented a real stall and measured `outstanding=0` across 875 writes,
 * including 30 seconds in which it never called `pump()`. That zero was correct and proved nothing
 * here: **a `pump()` stall is not a socket stall.** That client reads the transport continuously into
 * its own buffer, so the server-side queue cannot grow however long it stalls. Here the subscriber is
 * a grpc-js client in this process, and `call.pause()` stops the transport read itself. (`SIGSTOP` on
 * a separate client would also block the sidecar's stderr pipe, where the stats seam writes.)
 *
 * Real UDS, real grpc-js server, real codec. The only fake is the event PRODUCER: it costs no model
 * turn and lets the test decide what each pump tick carries. The events are `text_delta`s carrying a
 * real payload; the first version emitted a `content_delta`, a type the sidecar does not translate,
 * so every message on the wire was a few bytes of envelope and its 256-byte text never left.
 *
 * ### Why this is deterministic
 *
 * The first version slept -- 150 ms for the stream to establish, 1.5 s each to fill and to drain -- and
 * under heavy machine load it failed on a clean checkout. Nothing here waits for a length of time:
 * each step waits for the condition it needs (an event received, a diagnostic line printed, an error
 * delivered), so a slow machine makes it slower and never makes it fail; the deadline only turns a
 * real hang into a readable failure. And each pump tick carries exactly one event, so what the
 * stalled watcher holds from earlier ticks climbs by at most one per tick and the bound is met at
 * exactly the capacity, however much the transport happened to take before it backed up.
 */

const SOCKET_DIRS: string[] = [];

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wq-'));
  SOCKET_DIRS.push(dir);
  return join(dir, 'sock');
}

const VERSIONS = { sdkDeclared: '2.1.252', hostCli: '2.1.267' } as const;
const CLASSIFY = () => ({ kind: 'tested' }) as never;
const CAPACITY = 64;
/** Large enough that HTTP/2's flow-control window and the socket buffer fill after a few dozen. */
const PAYLOAD = 'x'.repeat(32 * 1024);

async function waitFor(what: string, condition: () => boolean, deadlineMs = 25_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

class Watch {
  readonly events: SessionEvent[] = [];
  error: grpc.ServiceError | undefined;
  constructor(
    readonly call: grpc.ClientReadableStream<SessionEvent>,
    all: Watch[],
  ) {
    all.push(this);
    call.on('data', (event: SessionEvent) => this.events.push(event));
    call.on('error', (error: grpc.ServiceError) => {
      this.error = error;
    });
  }
  sequences(): bigint[] {
    return this.events.map((e) => e.sequence);
  }
  last(): bigint {
    return this.events.at(-1)!.sequence;
  }
  errorCode(): ErrorCode | undefined {
    const bytes = this.error?.metadata?.get('grpc-status-details-bin')[0];
    return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer).code;
  }
}

test('a watcher that stops reading the socket is ended with EVENT_GAP at the ring capacity; the session and its other watcher carry on', async (t) => {
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
      ringBufferCapacity: CAPACITY,
      // Shorter than the PumpDriver's 20 ms tick, so the seam prints between any two ticks.
      writeQueueStats: { intervalMs: 5 },
      onDiagnostic: (line) => lines.push(line),
    },
  });

  const client = new RuntimeServiceClient(`unix://${path}`, grpc.credentials.createInsecure());
  const watches: Watch[] = [];
  t.after(async () => {
    // Cancelled first: a graceful shutdown waits for every open call, and a call whose reader is
    // still paused after a failed assertion would hold it -- and the failure -- forever.
    for (const watch of watches) {
      watch.call.cancel();
    }
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

  // AVAILABLE_HISTORY rather than FROM_NOW: a watch is registered on the server some time after the
  // client opens it, and an event emitted in between would be missed by FROM_NOW -- the race the
  // first version covered with a 150 ms sleep. From history, an event emitted before the server
  // registered the watcher is replayed to it, so there is nothing to race.
  const stalled = new Watch(client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY } as never), watches);
  const healthy = new Watch(client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY } as never), watches);
  let produced = 0;
  /** One event in its own pump tick: back once the healthy watcher has it. */
  const produce = async (event: unknown = { type: 'text_delta', turnId: 'wq', text: `chunk-${produced}-${PAYLOAD}` }) => {
    controller!.emit(event as never);
    produced += 1;
    await waitFor(`the healthy watcher to receive event ${produced}`, () => healthy.events.length === produced);
  };

  // Both streams are live: each has received an event. Only then does anything stall.
  await produce();
  await waitFor('the stalled watcher to receive the first event', () => stalled.events.length === 1);

  // THE STALL: stop reading the transport. Not "stop processing" -- stop reading.
  stalled.call.pause();

  const endedLine = () => lines.find((l) => l.includes('ended a watcher'));
  while (endedLine() === undefined) {
    assert.ok(produced < 20 * CAPACITY, `produced ${produced} events into a stalled watcher and the bound never fired`);
    await produce();
  }

  // The bound fired at exactly the capacity, for the stalled watcher only.
  assert.match(endedLine()!, new RegExp(`ended a watcher of session ${sessionId} with EVENT_GAP: outstanding=${CAPACITY} reached the replay ring capacity ${CAPACITY}`));
  assert.equal(lines.filter((l) => l.includes('ended a watcher')).length, 1);

  // The stats seam saw the queue grow, and never past the bound.
  const stats = lines.filter((l) => l.includes('peak_outstanding='));
  const peaks = stats.map((l) => Number(/peak_outstanding=(\d+)/.exec(l)![1]));
  const buffered = Math.max(0, ...stats.map((l) => Number(/buffered_writes=(\d+)/.exec(l)![1])));
  // Past what the healthy watcher can show (one event per tick, so at most a message or two in
  // flight): the stalled watcher's queue is held for dozens of 20 ms ticks, and the seam prints every
  // 5 ms.
  assert.ok(Math.max(0, ...peaks) >= CAPACITY / 2, `the stats seam never saw the stalled watcher's queue. Last lines: ${JSON.stringify(stats.slice(-3))}`);
  // The seam reports raw writableLength, which the bound does not cap in general (it leaves out the
  // replay and the current tick). Here there is no unread replay and each tick carries one event, so
  // raw and bounded agree, and nothing may pass the capacity.
  assert.ok(Math.max(...peaks) <= CAPACITY, `a watcher held ${Math.max(...peaks)} messages, past the bound of ${CAPACITY}`);
  assert.ok(buffered > 0, 'write() never answered false while the reader was paused: the congestion signal was never raised');

  // A few more ticks: the healthy watcher keeps receiving, in order, with nothing missing.
  for (let i = 0; i < 3; i += 1) {
    await produce();
  }

  // The stalled client reads again: it gets everything that was queued for it, then EVENT_GAP.
  stalled.call.resume();
  await waitFor('the stalled watcher to receive its error', () => stalled.error !== undefined);
  assert.equal(stalled.error!.code, grpc.status.OUT_OF_RANGE);
  assert.equal(stalled.errorCode(), ErrorCode.ERROR_CODE_EVENT_GAP);
  assert.match(stalled.error!.details, /reconnect with after_sequence/i);
  assert.deepEqual(stalled.sequences(), healthy.sequences().slice(0, stalled.events.length), 'what was queued arrives whole and in order');

  // It reconnects with its cursor and loses nothing: the ring still holds what it missed.
  const cursor = stalled.last();
  const again = new Watch(
    client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: cursor } as never),
    watches,
  );
  await waitFor('the reconnect to catch up', () => again.events.length > 0 && again.last() === healthy.last());
  assert.equal(again.error, undefined);
  assert.deepEqual([...stalled.sequences(), ...again.sequences()], healthy.sequences(), 'the two streams together are the whole history: no gap, no repeat');

  // The session was never touched: a turn still runs to completion, and both readers see it.
  const turnId = await new Promise<string>((resolve, reject) => {
    client.sendTurn({ sessionId, commandId: 'wq-turn', text: 'go on' } as never, (err, res) =>
      err ? reject(err) : resolve((res as { turnId: string }).turnId),
    );
  });
  await produce({ type: 'turn_completed', turnId, outcome: 'completed', resultText: 'done', isError: false, stopReason: 'end_turn' });
  await waitFor('the reconnected watcher to see the turn complete', () => again.events.some((e) => e.turnCompleted !== undefined));
  assert.ok(healthy.events.some((e) => e.turnCompleted !== undefined));
  assert.equal(healthy.error, undefined);

  // Reported, not asserted: the numbers are the point of the exercise and belong in the log even
  // when the test passes.
  console.log(
    `[write-queue] capacity=${CAPACITY} peak_outstanding=${Math.max(...peaks)} buffered_writes=${buffered} produced=${produced} delivered_before_gap=${stalled.events.length}`,
  );
});
