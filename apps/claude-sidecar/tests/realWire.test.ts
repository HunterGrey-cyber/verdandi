import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { startSidecar } from '../src/lifecycle.js';
import {
  RuntimeServiceClient,
  ReplayStart,
  ConfigurationProfile,
  PermissionMode,
  PersistenceMode,
  ExecutableSource,
  StreamingMode,
  SettingSource,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { buildKernelSessionConfig, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { CONSERVATIVE_BYPASS_DENY, policyToBaseOptions } from '@verdandi/claude-runtime';
import { makeFakeSession } from './fakeSession.js';

/**
 * Final whole-branch review, Finding 2: Task 7's own brief said lifecycle.ts/index.ts weren't
 * "meaningfully fakeable" and deferred all their coverage to Task 8's real-CLI test -- wrong.
 * startSidecar already takes injectable sessionFactory/getClaudeCodeVersion/classifyCliVersion params,
 * so a REAL gRPC server on a REAL UDS with a REAL generated client, driven entirely by a FAKE Claude
 * session, costs zero API dollars and is straightforward to write. No RUN_REAL_CLAUDE_TESTS gate
 * needed here -- nothing in this file ever touches the real Claude CLI/SDK.
 */

// `fn`'s own parameter type is widened to `any` here (not `Req`) -- same test-glue fix
// tests/runtimeServiceImpl.test.ts's callResult and tests/realSidecar.integration.test.ts's promisify
// both needed for the identical reason: binding a real grpc-js client method against a generic `Req`
// parameter fails strict contravariant parameter checking whenever a call site's `Req` is a looser
// shape than the real generated message type. Runtime behavior and call-site type safety are
// unaffected by this internal widening.
function promisify<Req, Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: Req): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => (err ? reject(err) : resolve(res as Res)));
  });
}

test('real gRPC server over a real UDS, driven entirely by a fake Claude session: all 7 RPCs work end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-'));
  const socketPath = join(dir, 'sidecar.sock');
  let lastMade: ReturnType<typeof makeFakeSession> | undefined;
  let sidecar: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => {
        lastMade = makeFakeSession();
        return lastMade.session;
      },
      getClaudeCodeVersions: () => ({ sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }),
      classifyCliVersion: () => ({ kind: 'supported' }),
    });

    client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());

    // 1. Handshake
    const handshakeRes = await promisify<{ clientProtocolMajor: number }, { protocolMajor: number; actualClaudeCodeVersion: string; maxMessageBytes: bigint }>(
      client.handshake.bind(client),
      { clientProtocolMajor: 3 },
    );
    assert.equal(handshakeRes.protocolMajor, 3);
    // Confirms the cached-at-startup version (Finding 1) actually reaches a real client over the real
    // wire, and that a real bigint-typed field round-trips through real proto encode/decode.
    assert.equal(handshakeRes.actualClaudeCodeVersion, 'fake-cli-version');
    assert.ok(handshakeRes.maxMessageBytes > 0n);

    // 2. CreateSession
    const { sessionId } = await promisify<{ cwd: string; policy: unknown }, { sessionId: string }>(client.createSession.bind(client), { cwd: '/tmp', policy: undefined });
    assert.ok(sessionId.length > 0);
    assert.ok(lastMade, 'expected sessionFactory to have been called');
    const { controller } = lastMade!;

    // 3. SendTurn
    const sendTurnRes = await promisify<{ sessionId: string; commandId: string; text: string }, { turnId: string }>(client.sendTurn.bind(client), {
      sessionId,
      commandId: 'cmd-1',
      text: 'hello',
    });
    assert.equal(sendTurnRes.turnId, 'fake-turn-1');
    assert.deepEqual(controller.sentTurns, ['hello']);

    // 4. InterruptTurn
    await promisify(client.interruptTurn.bind(client), { sessionId, commandId: 'cmd-interrupt' });
    assert.equal(controller.interruptCalls, 1);

    // 5. WatchSessionEvents -- subscribe now, before CloseSession, so this one subscription observes
    // both a live-broadcast event (turn_started, driven by controller.emit below) and, later, the
    // terminal sessionClosed event plus the stream's own natural end (Finding 4).
    const watchCall = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
    const seen: Array<{ turnStarted?: { turnId: string }; sessionClosed?: unknown }> = [];
    let resolveSawTurnStarted: () => void;
    const sawTurnStarted = new Promise<void>((resolve) => {
      resolveSawTurnStarted = resolve;
    });
    let resolveSawSessionClosed: () => void;
    const sawSessionClosed = new Promise<void>((resolve) => {
      resolveSawSessionClosed = resolve;
    });
    const streamEnded = new Promise<void>((resolve) => {
      watchCall.on('end', () => resolve());
    });
    watchCall.on('data', (event: { turnStarted?: { turnId: string }; sessionClosed?: unknown }) => {
      seen.push(event);
      if (event.turnStarted !== undefined) {
        resolveSawTurnStarted();
      }
      if (event.sessionClosed !== undefined) {
        resolveSawSessionClosed();
      }
    });
    watchCall.on('error', (err: grpc.ServiceError) => {
      throw err;
    });

    controller.emit({ type: 'turn_started', turnId: 'watch-t1' } as never);
    await sawTurnStarted!;
    assert.ok(seen.some((e) => e.turnStarted?.turnId === 'watch-t1'));

    // 6. ResolvePermission -- the fake session's resolvePermission() always returns true regardless of
    // permissionId (Task 1), so this doesn't need a real permission_requested event first.
    await promisify(client.resolvePermission.bind(client), { sessionId, commandId: 'cmd-resolve', permissionId: 'perm-1', allow: true, reason: '' });
    assert.deepEqual(controller.resolvePermissionCalls, [{ permissionId: 'perm-1', decision: { allow: true, reason: '' } }]);

    // 7. CloseSession -- confirms session_closed arrives via the still-open WatchSessionEvents
    // subscription (fakeSession.ts's close() fix, this same wave), AND that the stream is then
    // actually gRPC-completed (call.end(), Finding 4) rather than left open forever.
    await promisify(client.closeSession.bind(client), { sessionId, commandId: 'cmd-close' });
    assert.equal(controller.closeCalls, 1);

    await Promise.all([sawSessionClosed!, streamEnded]);
    assert.ok(seen.some((e) => e.sessionClosed !== undefined));
  } finally {
    client?.close();
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSidecar refuses to boot on a REFUSED CLI version, before binding the socket at all', async () => {
  // Final whole-branch review, Finding 1: the CLI-version check is a one-time, connection-independent
  // startup gate rather than a per-Handshake-call check -- confirm the documented "fail before
  // binding" behavior actually holds: no socket file should ever appear.
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-reject-'));
  const socketPath = join(dir, 'sidecar.sock');
  try {
    await assert.rejects(
      startSidecar({
        socketPath,
        sessionFactory: () => makeFakeSession().session,
        getClaudeCodeVersions: () => ({ sdkDeclared: 'refused-sdk-version', hostCli: 'refused-version' }),
        classifyCliVersion: (version: string) => ({ kind: 'refused' as const, diagnostic: `${version} is outside the supported range` }),
      }),
      // The thrown message must carry the policy's own diagnostic verbatim, not a generic
      // "untested" string: a host process that drains this sidecar's stderr has no other way to
      // tell a user WHY startup failed, and the previous generic message is exactly what made a
      // real CLI-version refusal surface downstream as an unexplained connect timeout.
      /refused-version is outside the supported range/,
    );
    assert.equal(existsSync(socketPath), false, 'expected startSidecar to reject before ever binding the socket');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSidecar STARTS on an in-range-but-untested CLI version, and emits the diagnostic', async () => {
  // The case the old exact-match gate got wrong: a routine Claude Code patch bump is inside the
  // supported range but not in the tested set. It must bind and serve -- and it must say so, since
  // that diagnostic is the only signal a downstream host has that a version skew exists at all.
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-untested-'));
  const socketPath = join(dir, 'sidecar.sock');
  const diagnostics: string[] = [];
  // Also pins that startSidecar hands the OBSERVED version to the classifier. Without this, a stub
  // that ignores its parameter lets `classifyCliVersion(cachedActualClaudeCodeVersion)` be mutated
  // to `classifyCliVersion('')` with the suite still green -- the version the policy judges would
  // then have nothing to do with the version actually installed.
  // Distinct per binary, which also pins that BOTH are classified -- the two-binary gate main added
  // and the range classifier this branch added are now the same gate, and a regression that dropped
  // either binary would show up here as a missing diagnostic rather than as a silently ungated CLI.
  const classifiedVersions: string[] = [];
  let sidecar: { close(): Promise<void> } | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => makeFakeSession().session,
      getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.268', hostCli: '2.1.269' }),
      classifyCliVersion: (version) => {
        classifiedVersions.push(version);
        return { kind: 'untested', diagnostic: `${version} has not been tested` };
      },
      onDiagnostic: (message) => diagnostics.push(message),
    });
    assert.deepEqual(
      classifiedVersions,
      ['2.1.268', '2.1.269'],
      'startSidecar must classify BOTH versions getClaudeCodeVersions reported, sdk-bundled first',
    );
    assert.equal(existsSync(socketPath), true, 'expected startSidecar to bind its socket despite the untested version');
    assert.equal(diagnostics.length, 2, `expected one diagnostic per untested binary, got ${JSON.stringify(diagnostics)}`);
    assert.match(diagnostics[0]!, /sdk-bundled CLI version diagnostic: 2\.1\.268 has not been tested/);
    assert.match(diagnostics[1]!, /host CLI version diagnostic: 2\.1\.269 has not been tested/);
  } finally {
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSidecar defaults its diagnostic sink to console.warn -- the only sink production uses', async () => {
  // src/index.ts never passes `onDiagnostic`, so lifecycle.ts's `?? console.warn` fallback is the
  // ONLY sink that ever runs for real. The test above always injects one, which leaves that fallback
  // unexecuted by the whole suite: replacing it with a no-op keeps every test green while a routine
  // Claude Code patch bump starts the sidecar completely silently -- losing the single signal a
  // downstream host has that a version skew exists at all.
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-defaultsink-'));
  const socketPath = join(dir, 'sidecar.sock');
  const warned: unknown[][] = [];
  const realWarn = console.warn;
  let sidecar: { close(): Promise<void> } | undefined;
  try {
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => makeFakeSession().session,
      // Only the host binary is untested here, so this asserts a count of exactly one and stays a
      // test about the default SINK rather than about how many binaries are gated.
      getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.267', hostCli: '2.1.269' }),
      classifyCliVersion: (version) => (version === '2.1.269' ? { kind: 'untested', diagnostic: 'sink-probe-marker' } : { kind: 'supported' }),
      // onDiagnostic deliberately omitted -- that omission is the whole point of this test.
    });
    assert.equal(warned.length, 1, `expected exactly one console.warn call, got ${JSON.stringify(warned)}`);
    assert.match(String(warned[0]![0]), /sink-probe-marker/);
  } finally {
    console.warn = realWarn;
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSidecar stays silent on a supported version -- no diagnostic noise when there is nothing to say', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-silent-'));
  const socketPath = join(dir, 'sidecar.sock');
  const diagnostics: string[] = [];
  let sidecar: { close(): Promise<void> } | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => makeFakeSession().session,
      getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.267', hostCli: '2.1.267' }),
      classifyCliVersion: () => ({ kind: 'supported' }),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    assert.deepEqual(diagnostics, [], 'a supported version must produce no diagnostic');
    assert.equal(existsSync(socketPath), true);
  } finally {
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Recoverable watch-stream interruption, over the real wire.
 *
 * The existing coverage for a broken stream kills the whole sidecar, which proves the client
 * reports an unrecoverable loss but says nothing about recovery: there is nothing left to
 * reconnect to. This is the other case, and the one replay exists for -- the TRANSPORT fails while
 * the provider keeps running.
 *
 * Deterministic by construction. The fault seam breaks the first watch after a set number of
 * events; a real transient network failure would have to be hoped for, and a test that depends on
 * hope passes for the wrong reasons.
 */
test('a watch stream broken mid-session recovers by replaying exactly what it missed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-recover-'));
  const socketPath = join(dir, 'sidecar.sock');
  let lastMade: ReturnType<typeof makeFakeSession> | undefined;
  let sidecar: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => {
        lastMade = makeFakeSession();
        return lastMade.session;
      },
      getClaudeCodeVersions: () => ({ sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }),
      classifyCliVersion: () => ({ kind: 'supported' }),
      runtime: { watchFault: { afterEvents: 2 } },
    });
    client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());

    const { sessionId } = await promisify<unknown, { sessionId: string }>(
      client.createSession.bind(client),
      { cwd: '/tmp', policy: undefined },
    );
    const controller = lastMade!.controller;

    // --- first watch: receives two LIVE events, then the transport dies under it ---
    //
    // The events are emitted only once the watch is actually registered server-side. Replayed
    // events reach the client through the handler's own write loop rather than through the
    // subscriber, so they deliberately do not count toward the fault -- the seam breaks a LIVE
    // stream, which is the situation replay has to recover from. Emitting before the watch is up
    // would put both events in the ring buffer, deliver them as replay, and never fire the fault.
    const beforeBreak: Array<{ sequence: bigint; turnStarted?: { turnId: string } }> = [];
    const breakError = await new Promise<grpc.ServiceError>((resolve, reject) => {
      const call = client!.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
      call.on('data', (event: { sequence: bigint; turnStarted?: { turnId: string } }) => beforeBreak.push(event));
      call.on('error', (err: grpc.ServiceError) => resolve(err));
      call.on('end', () => reject(new Error('the stream ended cleanly; the fault seam did not fire')));
      setTimeout(() => {
        controller.emit({ type: 'turn_started', turnId: 't1' } as never);
        controller.emit({ type: 'turn_started', turnId: 't2' } as never);
      }, 80);
      // Without this the whole suite HANGS rather than failing when the seam does not fire -- which
      // is exactly what happened the first time this test was run, and a hang is a worse failure
      // report than an assertion.
      setTimeout(
        () => reject(new Error(`the watch was never broken; received ${beforeBreak.length} event(s)`)),
        4000,
      );
    });

    assert.equal(breakError.code, grpc.status.UNAVAILABLE);
    assert.deepEqual(beforeBreak.map((e) => e.turnStarted?.turnId), ['t1', 't2']);
    const lastDelivered = beforeBreak[beforeBreak.length - 1]!.sequence;

    // --- events produced while nobody is watching still reach the ring buffer ---
    controller.emit({ type: 'turn_started', turnId: 't3' } as never);
    controller.emit({ type: 'turn_started', turnId: 't4' } as never);
    await new Promise((r) => setTimeout(r, 80));

    // --- reconnect from the last sequence actually delivered ---
    const afterRecovery: Array<{ sequence: bigint; turnStarted?: { turnId: string } }> = [];
    await new Promise<void>((resolve, reject) => {
      const call = client!.watchSessionEvents({
        sessionId,
        start: ReplayStart.REPLAY_START_AFTER_SEQUENCE,
        afterSequence: lastDelivered,
      });
      call.on('data', (event: { sequence: bigint; turnStarted?: { turnId: string } }) => {
        afterRecovery.push(event);
        if (afterRecovery.length === 3) {
          call.cancel();
          resolve();
        }
      });
      call.on('error', (err: grpc.ServiceError) => {
        if (err.code !== grpc.status.CANCELLED) reject(err);
      });
      setTimeout(() => {
        // A live event AFTER the replay, proving the stream did not merely dump history and stall.
        controller.emit({ type: 'turn_started', turnId: 't5' } as never);
      }, 60);
      setTimeout(() => reject(new Error(`only recovered ${afterRecovery.length} event(s)`)), 3000);
    });

    // No loss: the two events produced while nothing was watching were replayed.
    // No duplication: t1 and t2, already delivered, were not sent again.
    // And live delivery resumed: t5 arrived after the replay.
    assert.deepEqual(afterRecovery.map((e) => e.turnStarted?.turnId), ['t3', 't4', 't5']);

    // Sequences are contiguous across the break -- which is what makes the client's own continuity
    // check able to tell a repaired stream from a lossy one.
    const allSequences = [...beforeBreak, ...afterRecovery].map((e) => e.sequence);
    for (let i = 1; i < allSequences.length; i += 1) {
      assert.equal(allSequences[i], allSequences[i - 1]! + 1n, `sequence gap at index ${i}: ${allSequences.join(',')}`);
    }
  } finally {
    client?.close();
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Replay modes over a REAL codec.
//
// Prompted by a sibling runtime track, which shipped its own three modes and then found that
// every real-transport watch call in its repo still used the old field -- two of the three had never
// once crossed a socket. Checked here and the same was true: only AFTER_SEQUENCE and
// AVAILABLE_HISTORY had. FROM_NOW, the two refusals, and (most importantly) explicit presence on
// `optional uint64 after_sequence` were exercised only against a fake call object built as a plain
// JS value, which never touches a codec at all -- structurally blind, the same shape as asserting on
// a fake's recorded `destroy` argument and calling the refusal delivered.
// ---------------------------------------------------------------------------------------------

/** Opens a watch and resolves with however the stream ends: data, a typed error, or a clean end. */
function watchOutcome(
  client: RuntimeServiceClient,
  request: { sessionId: string; start: ReplayStart; afterSequence?: bigint },
  opts: { settleAfterMs?: number } = {},
): Promise<{ events: Array<{ sequence: bigint; turnStarted?: { turnId: string } }>; error?: grpc.ServiceError }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ sequence: bigint; turnStarted?: { turnId: string } }> = [];
    const call = client.watchSessionEvents(request);
    const settle = setTimeout(() => {
      call.cancel();
      resolve({ events });
    }, opts.settleAfterMs ?? 300);
    call.on('data', (e: { sequence: bigint; turnStarted?: { turnId: string } }) => events.push(e));
    call.on('error', (error: grpc.ServiceError) => {
      if (error.code === grpc.status.CANCELLED) return;
      clearTimeout(settle);
      resolve({ events, error });
    });
    call.on('end', () => {
      clearTimeout(settle);
      resolve({ events });
    });
    setTimeout(() => reject(new Error('the watch neither delivered, failed, nor ended')), 5000);
  });
}

test('every replay mode and refusal survives a real codec, over a real socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-modes-'));
  const socketPath = join(dir, 'sidecar.sock');
  let lastMade: ReturnType<typeof makeFakeSession> | undefined;
  let sidecar: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => {
        lastMade = makeFakeSession();
        return lastMade.session;
      },
      getClaudeCodeVersions: () => ({ sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }),
      classifyCliVersion: () => ({ kind: 'supported' }),
    });
    client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
    const { sessionId } = await promisify<unknown, { sessionId: string }>(
      client.createSession.bind(client),
      { cwd: '/tmp', policy: undefined },
    );
    const controller = lastMade!.controller;

    // Some history to distinguish the modes by.
    controller.emit({ type: 'turn_started', turnId: 'history-1' } as never);
    controller.emit({ type: 'turn_started', turnId: 'history-2' } as never);
    await new Promise((r) => setTimeout(r, 80));

    // --- AVAILABLE_HISTORY: everything retained ---
    const history = await watchOutcome(client, { sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
    assert.equal(history.error, undefined);
    assert.deepEqual(history.events.map((e) => e.turnStarted?.turnId), ['history-1', 'history-2']);

    // --- AFTER_SEQUENCE with an EXPLICIT ZERO cursor ---
    //
    // The load-bearing one, and the reason this whole test exists. proto3 `optional` gives the field
    // explicit presence, so `after_sequence: 0` must arrive as present-with-zero rather than as
    // absent. If presence did not survive, the handler would see AFTER_SEQUENCE with no cursor and
    // refuse it -- and since this client opens EVERY first watch exactly this way, every session in
    // the product would fail to start watching. It works; it had simply never been named.
    const fromZero = await watchOutcome(client, {
      sessionId,
      start: ReplayStart.REPLAY_START_AFTER_SEQUENCE,
      afterSequence: 0n,
    });
    assert.equal(fromZero.error, undefined, 'an explicit zero cursor must not read as an absent one');
    assert.deepEqual(fromZero.events.map((e) => e.turnStarted?.turnId), ['history-1', 'history-2']);

    // --- FROM_NOW: no backlog, but live delivery still works ---
    //
    // Asserted by pumping until something lands AFTER the watch is attached, rather than by emitting
    // once and waiting -- a pre-attach emit would be replayed on attach by the other modes, so that
    // shape races and can hang against a perfectly correct server. (Trap flagged by a sibling
    // runtime track, which paid for it with a red run.) Asserting the sequence is past the
    // retained ones is what would still fail loudly if history were replayed here.
    const fromNow = await new Promise<Array<{ sequence: bigint; turnStarted?: { turnId: string } }>>(
      (resolve, reject) => {
        const seen: Array<{ sequence: bigint; turnStarted?: { turnId: string } }> = [];
        const call = client!.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_FROM_NOW });
        call.on('data', (e: { sequence: bigint; turnStarted?: { turnId: string } }) => {
          seen.push(e);
          call.cancel();
          resolve(seen);
        });
        call.on('error', (err: grpc.ServiceError) => {
          if (err.code !== grpc.status.CANCELLED) reject(err);
        });
        const pump = setInterval(() => controller.emit({ type: 'turn_started', turnId: 'live' } as never), 40);
        setTimeout(() => {
          clearInterval(pump);
          reject(new Error(`FROM_NOW delivered nothing; saw ${seen.length}`));
        }, 4000);
        setTimeout(() => clearInterval(pump), 3500);
      },
    );
    assert.equal(fromNow[0]!.turnStarted?.turnId, 'live', 'FROM_NOW replayed history it was asked to skip');
    assert.ok(fromNow[0]!.sequence > 2n, `FROM_NOW started at ${fromNow[0]!.sequence}, inside the retained history`);

    // --- UNSPECIFIED: refused, not defaulted ---
    const unset = await watchOutcome(client, { sessionId, start: ReplayStart.REPLAY_START_UNSPECIFIED });
    assert.equal(unset.error?.code, grpc.status.INVALID_ARGUMENT, 'an unset start must be refused over the wire');
    assert.equal(unset.events.length, 0);

    // --- an impossible cursor: refused, and NOT as a gap ---
    const future = await watchOutcome(client, {
      sessionId,
      start: ReplayStart.REPLAY_START_AFTER_SEQUENCE,
      afterSequence: 9_999n,
    });
    assert.equal(future.error?.code, grpc.status.INVALID_ARGUMENT);
    assert.notEqual(future.error?.code, grpc.status.OUT_OF_RANGE, 'nothing was evicted, so this is not a gap');

    // --- a cursor handed to a mode that takes none: refused, not ignored ---
    const strayCursor = await watchOutcome(client, {
      sessionId,
      start: ReplayStart.REPLAY_START_FROM_NOW,
      afterSequence: 1n,
    });
    assert.equal(strayCursor.error?.code, grpc.status.INVALID_ARGUMENT);
  } finally {
    client?.close();
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * T22 -- a CreateSession carrying setting_sources and tool_policy arrives at the kernel with both
 * intact, over the real encode -> UDS -> decode -> handler -> factory chain.
 *
 * Everything else in the suite tests one link. This tests the chain, which is where the cheap
 * failures live: a nested message encoded with the wrong wire type, a tag that disagrees between the
 * two generated halves, a field dropped in the production session factory. Any of those decodes to
 * `undefined` at the far end and is invisible to a unit test that never serialised anything.
 *
 * Zero API cost, same as the rest of this file: a real gRPC server on a real UDS with a real
 * generated client, driven entirely by a fake Claude session.
 */
test('a CreateSession carrying setting_sources and tool_policy reaches the kernel config with both intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-wire-policy-'));
  const socketPath = join(dir, 'sidecar.sock');
  let received: ClaudeSessionConfigLike | undefined;
  let sidecar: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  const made: ReturnType<typeof makeFakeSession>[] = [];
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: (config: ClaudeSessionConfigLike) => {
        received = config;
        const session = makeFakeSession();
        made.push(session);
        return session.session;
      },
      getClaudeCodeVersions: () => ({ sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }),
      classifyCliVersion: () => ({ kind: 'supported' }),
    });
    client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());

    await promisify(client.createSession.bind(client), {
      cwd: '/tmp/project',
      policy: {
        configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
        permissions: PermissionMode.PERMISSION_MODE_BYPASS,
        persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
        executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
        streaming: StreamingMode.STREAMING_MODE_COMPLETE,
        toolPolicy: { deny: [...CONSERVATIVE_BYPASS_DENY], allow: { tools: ['Read'] } },
        settingSources: {
          sources: [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL],
        },
      },
    });

    assert.ok(received, 'expected sessionFactory to have been called');
    // Run the PRODUCTION mapping on what actually came off the wire, rather than asserting on the
    // raw decoded proto: this is the same function index.ts hands to createSession, so a field lost
    // between here and the kernel has nowhere left to hide.
    const kernelConfig = buildKernelSessionConfig(received!);
    assert.deepEqual(kernelConfig.policy.settingSources, ['project', 'local']);
    assert.deepEqual(kernelConfig.policy.toolPolicy?.deny, ['Bash', 'Write', 'Edit', 'NotebookEdit']);
    assert.deepEqual(kernelConfig.policy.toolPolicy?.allow, ['Read']);

    // And on through to the Options the SDK would actually receive.
    const options = policyToBaseOptions(kernelConfig.policy, kernelConfig.cwd);
    assert.deepEqual(options.settingSources, ['project', 'local']);
    assert.deepEqual(options.disallowedTools, ['Bash', 'Write', 'Edit', 'NotebookEdit']);
    assert.deepEqual(options.tools, ['Read']);
  } finally {
    for (const session of made) {
      session.session.close();
    }
    await new Promise((r) => setTimeout(r, 100));
    client?.close();
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
