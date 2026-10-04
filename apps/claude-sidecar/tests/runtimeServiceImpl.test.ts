import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import type { ClaudeHostPolicy } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import {
  createRuntimeServiceImpl,
  mapClaudeHostPolicy,
  validateResumeRequest,
  validateEffort,
  validatePolicy,
  buildKernelSessionConfig,
  DEFAULT_CLAUDE_HOST_POLICY,
  type ClaudeSessionConfigLike,
  type RuntimeServiceOptions,
} from '../src/runtimeServiceImpl.js';
import { makeFakeSession } from './fakeSession.js';
import {
  ErrorCode,
  ReplayStart,
  ConfigurationProfile,
  PermissionMode,
  PersistenceMode,
  ExecutableSource,
  StreamingMode,
  SettingSource as SettingSourceProto,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
  InitCheck,
  CliPermissionMode,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

// Every impl.createSession() call anywhere in this file starts a real PumpDriver 20ms-interval. As of
// this wave's fakeSession.ts fix, the fake session's close() genuinely drives a session_closed event
// through pump() (mirroring the real kernel), which is what let this suite drop --test-force-exit and
// get real leaked-handle detection back -- but that only works if every fake session this file ever
// creates actually gets close()d before the process tries to exit. Individual tests assert on RPC
// responses and call counts, not on driver lifecycle, so track every fake session created anywhere in
// this file and close them all in one place instead of threading cleanup through every single test.
const allCreatedFakeSessions: MinimalKernelSession[] = [];

after(async () => {
  for (const session of allCreatedFakeSessions) {
    session.close();
  }
  // Give every still-running PumpDriver interval (up to one 20ms poll period) a chance to actually
  // drain the now-queued session_closed event and self-stop before this process tries to exit.
  await new Promise((r) => setTimeout(r, 100));
});

function setup(options: RuntimeServiceOptions = {}) {
  const registry = new SessionRegistry();
  // createSession() only assigns the real session_id (randomUUID()) *after* invoking sessionFactory
  // (whose signature -- confirmed in src/runtimeServiceImpl.ts -- takes just a config, no id), so this
  // closure has no way to precompute or guess the id a session will end up registered under. Track
  // every fake session produced, in order, and correlate back to the right controller via the
  // registry's own stored session object identity instead.
  const madeSessions: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      const made = makeFakeSession();
      madeSessions.push(made);
      allCreatedFakeSessions.push(made.session);
      return made.session;
    },
    // Fake-driven tests never spawn the real `claude` binary. createRuntimeServiceImpl no longer
    // takes getClaudeCodeVersion/isTestedCliVersion functions at all (final whole-branch review,
    // Finding 1) -- the CLI-version-tested check moved to startSidecar(), a connection-independent,
    // once-at-startup gate, so these are now just the cached version strings Handshake reports back.
    // Two, not one: the SDK's bundled CLI and the machine's own are different binaries.
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
    options,
  );
  const sessions = {
    get(sessionId: string): ReturnType<typeof makeFakeSession> | undefined {
      const entry = registry.get(sessionId);
      if (entry === undefined) {
        return undefined;
      }
      return madeSessions.find((made) => made.session === entry.session);
    },
  };
  return { registry, impl, sessions, sessionIdFor: (n: number) => `sess-${n}` };
}

/** Wraps req as { request: req } to match the real grpc-js ServerUnaryCall shape every handler
 * destructures via call.request.* -- calling a handler with the raw request object directly (skipping
 * the .request wrapper) makes call.request undefined and every handler throw before its own logic
 * ever runs. */
function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

test('createSession assigns a session_id and registers it in the registry', async () => {
  const { impl, registry } = setup();
  const res = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  assert.notEqual(registry.get(res.sessionId), undefined);
});

test('createSession with policy omitted defaults to native/interactive/ephemeral/host_cli', async () => {
  // CreateSessionRequest.policy is a plain singular message field (no `optional` keyword), so proto3
  // leaves it `undefined` -- not a zero-valued object -- when a well-behaved client omits it entirely
  // to ask for defaults. This sessionFactory calls the exact same exported mapClaudeHostPolicy that
  // src/index.ts's real production wiring calls, so this test exercises the real fix for the previous
  // fix wave's Finding 1 (mapPolicy(undefined) previously threw a raw, unmapped TypeError instead of
  // ever reaching this service's SidecarError/ErrorCode contract) rather than a reimplementation of it.
  const registry = new SessionRegistry();
  let resolvedPolicy: ClaudeHostPolicy | undefined;
  const impl = createRuntimeServiceImpl(
    registry,
    (config: ClaudeSessionConfigLike) => {
      resolvedPolicy = mapClaudeHostPolicy(config.policy as ClaudeHostPolicyProto | undefined);
      const made = makeFakeSession();
      allCreatedFakeSessions.push(made.session);
      return made.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
  );

  await callResult(impl.createSession.bind(impl), { cwd: '/tmp', policy: undefined });

  assert.deepEqual(resolvedPolicy, DEFAULT_CLAUDE_HOST_POLICY);
});

test('sendTurn with a new command_id calls the underlying session.sendTurn and returns its turn_id', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  const res = await callResult<{ turnId: string }>(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'hello' });

  assert.equal(res.turnId, 'fake-turn-1');
  assert.deepEqual(sessions.get(created.sessionId)!.controller.sentTurns, ['hello']);
});

test('sendTurn with the same command_id and same text replays the cached result, does not call sendTurn twice', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'hello' });
  const second = await callResult<{ turnId: string }>(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'hello' });

  assert.equal(second.turnId, 'fake-turn-1');
  assert.equal(sessions.get(created.sessionId)!.controller.sentTurns.length, 1);
});

test('sendTurn with the same command_id but a different text rejects with idempotency_conflict', async () => {
  const { impl } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'hello' });

  await assert.rejects(
    callResult(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'different text' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      return true;
    },
  );
});

test('sendTurn against an unknown session_id rejects with session_not_found', async () => {
  const { impl } = setup();
  await assert.rejects(
    callResult(impl.sendTurn.bind(impl), { sessionId: 'does-not-exist', commandId: 'cmd-1', text: 'hello' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.NOT_FOUND);
      const detail = err.metadata?.get('grpc-status-details-bin')[0];
      assert.notEqual(detail, undefined);
      return true;
    },
  );
});

test('sendTurn while a turn is already in progress rejects with turn_already_active, wrapping the kernel\'s plain Error', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  // makeFakeSession's sendTurn never throws on its own (Task 1) -- script it to throw exactly once,
  // mirroring the real kernel's own plain-Error throw for this exact condition, so this test actually
  // exercises the handler's error-wrapping path rather than a fake that always succeeds.
  sessions.get(created.sessionId)!.controller.makeNextSendTurnThrow('a turn is already in progress on this session');

  await assert.rejects(
    callResult(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'second' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      const detail = err.metadata?.get('grpc-status-details-bin')[0];
      assert.notEqual(detail, undefined);
      return true;
    },
  );
});

test('sendTurn against a session the kernel reports as closed rejects with session_not_found, not turn_already_active', async () => {
  // Final whole-branch review, Finding 5: the kernel's sendTurn() (packages/claude-runtime/src/
  // session.ts:320-325) throws one of exactly two distinct plain-Error messages -- "a turn is already
  // in progress on this session" (the previous test) and "session is closed". The second is genuinely
  // reachable (CloseSession makes the kernel terminal immediately, before the registry entry is
  // evicted), so it must map to SESSION_NOT_FOUND, not the previous blanket TURN_ALREADY_ACTIVE --
  // otherwise a client's retry logic would wait forever for a turn_completed that can never arrive.
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  sessions.get(created.sessionId)!.controller.makeNextSendTurnThrow('session is closed');

  await assert.rejects(
    callResult(impl.sendTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', text: 'hello' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.NOT_FOUND);
      const detail = err.metadata?.get('grpc-status-details-bin')[0];
      assert.notEqual(detail, undefined);
      return true;
    },
  );
});

test('interruptTurn calls the underlying session.interrupt()', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.interruptTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1' });

  assert.equal(sessions.get(created.sessionId)!.controller.interruptCalls, 1);
});

test('interruptTurn wraps a non-SidecarError throw from the kernel as provider_protocol_error, not an unmapped UNKNOWN', async () => {
  // Final whole-branch review, Finding 6: every handler's generic catch previously cast any
  // non-SidecarError throw straight to grpc.ServiceError -- a lie for a plain Error, which has no
  // .code/.metadata, so grpc-js emitted UNKNOWN with empty trailers. interruptTurn has no kernel throw
  // condition of its own to mirror (unlike sendTurn's two), so this uses makeNextInterruptThrow purely
  // to exercise the generic catch-all wrapping path itself, via toServiceError.
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  sessions.get(created.sessionId)!.controller.makeNextInterruptThrow('boom');

  await assert.rejects(
    callResult(impl.interruptTurn.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INTERNAL); // ERROR_CODE_PROVIDER_PROTOCOL_ERROR
      const detail = err.metadata?.get('grpc-status-details-bin')[0];
      assert.notEqual(detail, undefined, 'a wrapped error must still carry a real ErrorDetail, not empty trailers');
      return true;
    },
  );
});

test('createSession wraps a non-SidecarError throw from sessionFactory as provider_protocol_error, not an unmapped UNKNOWN', async () => {
  const registry = new SessionRegistry();
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      throw new Error('sessionFactory boom');
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
  );

  await assert.rejects(
    callResult(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INTERNAL);
      const detail = err.metadata?.get('grpc-status-details-bin')[0];
      assert.notEqual(detail, undefined);
      return true;
    },
  );
});

test('resolvePermission calls the underlying session.resolvePermission with the given allow/reason', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.resolvePermission.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', permissionId: 'perm1', allow: false, reason: 'no' });

  assert.deepEqual(sessions.get(created.sessionId)!.controller.resolvePermissionCalls, [{ permissionId: 'perm1', decision: { allow: false, reason: 'no' } }]);
});

test('resolvePermission with the same command_id but a different payload rejects with idempotency_conflict', async () => {
  const { impl } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.resolvePermission.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', permissionId: 'perm1', allow: true });

  await assert.rejects(
    callResult(impl.resolvePermission.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', permissionId: 'perm1', allow: false }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      return true;
    },
  );
});

test('resolvePermission against a permission the fake session reports unknown rejects with permission_not_found', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  // makeFakeSession's resolvePermission always returns true (Task 1) -- override it here to exercise
  // the false-return path this test needs, the same way a real PermissionBroker would for an unknown id.
  sessions.get(created.sessionId)!.session.resolvePermission = () => false;

  await assert.rejects(
    callResult(impl.resolvePermission.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1', permissionId: 'does-not-exist', allow: true }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.NOT_FOUND);
      return true;
    },
  );
});

test('closeSession calls the underlying session.close()', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  await callResult(impl.closeSession.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-1' });

  assert.equal(sessions.get(created.sessionId)!.controller.closeCalls, 1);
});

test('handshake returns protocol version fields (including the cached CLI version) without touching the registry', async () => {
  const { impl } = setup();
  const res = await callResult<{ protocolMajor: number; capabilities: string[]; actualClaudeCodeVersion: string; sdkDeclaredClaudeCodeVersion: string }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.equal(res.protocolMajor, 3);
  assert.ok(res.capabilities.length > 0);
  // Final whole-branch review, Finding 1: Handshake now reports the version cached once by
  // startSidecar() (here, setup()'s third createRuntimeServiceImpl argument) rather than calling a
  // getClaudeCodeVersion() function on every request -- confirm it's actually plumbed through.
  assert.equal(res.actualClaudeCodeVersion, 'fake-cli-version');
  // The two version fields are separately sourced: `sdk_declared` is the CLI the SDK package ships,
  // `actual` the one installed on the machine. Both used to be filled from the same host probe.
  assert.equal(res.sdkDeclaredClaudeCodeVersion, 'fake-sdk-cli-version');
});

test('handshake rejects a mismatched client protocol_major with incompatible_protocol', async () => {
  const { impl } = setup();
  await assert.rejects(
    callResult(impl.handshake.bind(impl), { clientProtocolMajor: 99 }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      return true;
    },
  );
});

function fakeStreamingCall(sessionId: string, start: ReplayStart, afterSequence?: bigint) {
  const written: unknown[] = [];
  const listeners = new Map<string, () => void>();
  let destroyedWith: grpc.ServiceError | undefined;
  // How a real client learns a stream failed. `destroy` does NOT reach one -- measured over a real
  // UDS: it delivers no data, no error and no end, and the client hangs. Tracking both separately
  // keeps that distinction visible instead of letting the fake accept either as equivalent.
  let emittedError: grpc.ServiceError | undefined;
  let ended = false;
  const call = {
    request: { sessionId, start, afterSequence },
    // Returns `true` -- "grpc-js took it straight to the socket" -- rather than `written.push`'s
    // array length. The length happened to type-check while the handler declared `write` as
    // returning `void`; it does not now that the declaration matches grpc-js's real `boolean`, and
    // a fake that returns a truthy length for every write could never represent the buffered case
    // this fake would be used to test.
    write: (chunk: unknown): boolean => {
      written.push(chunk);
      return true;
    },
    // Final whole-branch review, Finding 4: onTerminal must gRPC-complete every open watcher's
    // stream, not just stop writing to it -- track whether that actually happened.
    end: () => {
      ended = true;
    },
    destroy: (err?: grpc.ServiceError) => {
      destroyedWith = err;
    },
    emit: (_event: 'error', err: grpc.ServiceError) => {
      emittedError = err;
    },
    on: (event: string, listener: () => void): void => {
      listeners.set(event, listener);
    },
  };
  return {
    call,
    written,
    /** How the stream failed, as a real client would see it. Named for what it asserts rather than
     * for the mechanism, so a future change of mechanism does not need every call site edited. */
    getDestroyedWith: () => emittedError,
    getRawDestroyArg: () => destroyedWith,
    wasEnded: () => ended,
    fireEvent: (event: string) => listeners.get(event)?.(),
    hasListener: (event: string) => listeners.has(event),
  };
}

/**
 * The write-queue diagnostic: the seam is wired, and wiring it costs nothing when it is off.
 *
 * `broadcastFor` discarded `call.write()`'s return value, and the local `call` type declared that
 * return as `void` -- so the only congestion signal this server gets was not merely ignored, it was
 * UNREACHABLE without editing the type first. That matters because the queue lives on the server:
 * from a client, a stalled subscriber and a healthy one look identical until the sidecar dies of it.
 *
 * What this test can honestly assert is the structural half -- that the handler subscribes to
 * 'drain' exactly when the seam is on. 'drain' is what makes the counter able to go DOWN; without
 * it the number could only climb, and a counter that reports a healthy stream as a growing queue is
 * worse than no counter, because it would be believed.
 *
 * The behavioural half -- that `outstanding` actually tracks a real backlog under a real stall --
 * is deliberately NOT asserted here. Driving genuine grpc-js buffering needs a real socket and a
 * real stalled consumer, which this fake cannot be; a fake that returns `false` on demand would
 * only re-assert the arithmetic this file already wrote. That measurement belongs to the consumer's
 * own stalled-subscriber harness, and its absence here is a scope statement, not an oversight.
 */
test("the write-queue diagnostic subscribes to 'drain' when on, and touches nothing when off", async () => {
  function watchWith(options: RuntimeServiceOptions) {
    const registry = new SessionRegistry();
    const impl = createRuntimeServiceImpl(
      registry,
      () => {
        const made = makeFakeSession();
        allCreatedFakeSessions.push(made.session);
        return made.session;
      },
      { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
      options,
    );
    return { impl, registry };
  }

  const on = watchWith({ writeQueueStats: { intervalMs: 10 }, onDiagnostic: () => {} });
  const created = await callResult<{ sessionId: string }>(on.impl.createSession.bind(on.impl), { cwd: '/tmp', policy: {} });
  const onCall = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  on.impl.watchSessionEvents(onCall.call);
  assert.ok(
    onCall.hasListener('drain'),
    "with the seam on, the handler must subscribe to 'drain' -- without it the outstanding count can only ever climb",
  );

  const off = watchWith({});
  const created2 = await callResult<{ sessionId: string }>(off.impl.createSession.bind(off.impl), { cwd: '/tmp', policy: {} });
  const offCall = fakeStreamingCall(created2.sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  off.impl.watchSessionEvents(offCall.call);
  assert.equal(
    offCall.hasListener('drain'),
    false,
    'with the seam off there must be no drain listener at all: off means no timer, no listeners, and no reading of the write result',
  );
});

test('watchSessionEvents against an unknown session_id destroys the stream with session_not_found', () => {
  const { impl } = setup();
  const { call, getDestroyedWith } = fakeStreamingCall('does-not-exist', ReplayStart.REPLAY_START_AVAILABLE_HISTORY);

  impl.watchSessionEvents(call);

  assert.equal(getDestroyedWith()?.code, grpc.status.NOT_FOUND);
});

test('watchSessionEvents replays ring-buffer contents already present at connect time', () => {
  // Uses registry.create() directly (bypassing impl.createSession) so this test exercises
  // watchSessionEvents' own replay logic in isolation, with no PumpDriver/timer involved -- Task 8's
  // real-CLI test is what exercises the full pump-to-watch pipeline end to end for real.
  const { impl, registry } = setup();
  const { session } = makeFakeSession();
  const entry = registry.create('sess-replay', session, 100);
  entry.ringBuffer.push({ sequence: 1n, occurredAt: 0n, event: { type: 'turn_started', turnId: 't1' } as never });

  const { call, written } = fakeStreamingCall('sess-replay', ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(call);

  assert.equal(written.length, 1);
  assert.deepEqual((written[0] as { turnStarted?: { turnId: string } }).turnStarted, { turnId: 't1' });
});

test('watchSessionEvents destroys the stream with event_gap when after_sequence is older than the retained buffer', () => {
  const { impl, registry } = setup();
  const { session } = makeFakeSession();
  // Small capacity so eviction is trivial to force without pushing thousands of events.
  const entry = registry.create('sess-gap', session, 2);
  entry.ringBuffer.push({ sequence: 1n, occurredAt: 0n, event: {} as never });
  entry.ringBuffer.push({ sequence: 2n, occurredAt: 0n, event: {} as never });
  entry.ringBuffer.push({ sequence: 3n, occurredAt: 0n, event: {} as never }); // evicts sequence 1

  const { call, getDestroyedWith } = fakeStreamingCall('sess-gap', ReplayStart.REPLAY_START_AFTER_SEQUENCE, 1n); // needs sequence 2, which is present -- NOT a gap
  impl.watchSessionEvents(call);
  assert.equal(getDestroyedWith(), undefined);

  entry.ringBuffer.push({ sequence: 4n, occurredAt: 0n, event: {} as never }); // evicts sequence 2 too
  const { call: call2, getDestroyedWith: getDestroyedWith2 } = fakeStreamingCall('sess-gap', ReplayStart.REPLAY_START_AFTER_SEQUENCE, 1n); // needs sequence 2, now gone
  impl.watchSessionEvents(call2);
  assert.equal(getDestroyedWith2()?.code, grpc.status.OUT_OF_RANGE);
});

test('watchSessionEvents delivers a live event broadcast by PumpDriver to an active subscriber', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const { controller } = sessions.get(created.sessionId)!;

  const { call, written } = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(call);

  controller.emit({ type: 'turn_started', turnId: 't1' } as never);
  // PumpDriver's real interval (default 20ms) needs at least one tick to drain and broadcast this --
  // wait past that rather than reaching for a private tick() this test has no access to. Still no
  // real API cost: nothing here touches the real Claude CLI/SDK.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(written.length, 1);
  assert.deepEqual((written[0] as { turnStarted?: { turnId: string } }).turnStarted, { turnId: 't1' });
});

test('watchSessionEvents stops delivering to a subscriber once its stream fires cancelled', async () => {
  const { impl, sessions } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const { controller } = sessions.get(created.sessionId)!;

  const { call, written, fireEvent } = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(call);
  fireEvent('cancelled');

  controller.emit({ type: 'turn_started', turnId: 't1' } as never);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(written.length, 0);
});

test('watchSessionEvents receives the terminal event and then has its stream ended, not left open forever', async () => {
  // Final whole-branch review, Finding 4: onTerminal previously cleared the subscriber Set and evicted
  // the registry/watchers entries, but never called call.end() on the underlying gRPC call -- so every
  // watcher's stream stayed open forever after the terminal event instead of gRPC-completing normally.
  const { impl } = setup();
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });

  const { call, written, wasEnded } = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(call);

  await callResult(impl.closeSession.bind(impl), { sessionId: created.sessionId, commandId: 'cmd-close' });
  // PumpDriver's real interval (default 20ms) needs at least one tick to drain the fake session's now-
  // queued session_closed event (fakeSession.ts's close() fix, this same wave) and call onTerminal.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(written.some((e) => (e as { sessionClosed?: unknown }).sessionClosed !== undefined), 'expected a sessionClosed event to have been broadcast');
  assert.equal(wasEnded(), true);
});

// --- resume / fork passthrough (2026-09-11) -----------------------------------------------------

test('validateResumeRequest: a fresh session (neither field set) is accepted', () => {
  assert.doesNotThrow(() => validateResumeRequest({ cwd: '/tmp', policy: undefined }));
});

test('validateResumeRequest: a real resume id is accepted', () => {
  assert.doesNotThrow(() =>
    validateResumeRequest({ cwd: '/tmp', policy: undefined, resumeProviderSessionId: 'abc-123' }),
  );
});

test('validateResumeRequest: resume + fork together is accepted', () => {
  assert.doesNotThrow(() =>
    validateResumeRequest({ cwd: '/tmp', policy: undefined, resumeProviderSessionId: 'abc-123', fork: true }),
  );
});

test('validateResumeRequest: an empty resume id is rejected, not silently treated as fresh', () => {
  // proto3 field presence says "resume"; the value says nothing. Starting fresh here would lose a
  // conversation the caller believed was continuing -- the single most damaging way this could fail.
  for (const empty of ['', '   ']) {
    assert.throws(
      () => validateResumeRequest({ cwd: '/tmp', policy: undefined, resumeProviderSessionId: empty }),
      /resume_provider_session_id was set but is empty/,
    );
  }
});

test('validateResumeRequest: fork without resume is rejected rather than silently ignored', () => {
  assert.throws(
    () => validateResumeRequest({ cwd: '/tmp', policy: undefined, fork: true }),
    /no session to fork from/,
  );
});

test('validateResumeRequest: fork:false without resume is fine -- that is just a fresh session', () => {
  assert.doesNotThrow(() => validateResumeRequest({ cwd: '/tmp', policy: undefined, fork: false }));
});

test('createSession rejects an empty resume id with invalid_configuration, before building a session', async () => {
  const registry = new SessionRegistry();
  let factoryCalls = 0;
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      factoryCalls += 1;
      return makeFakeSession().session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
  );
  await assert.rejects(
    () => callResult(impl.createSession.bind(impl), { cwd: '/tmp', policy: undefined, resumeProviderSessionId: '' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      return true;
    },
  );
  assert.equal(factoryCalls, 0, 'no session object may be built for a request that cannot be honored');
  assert.equal(registry.allSessionIds().length, 0);
});

test('handshake advertises resume_session and fork_session only now that they are implemented', async () => {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' });
  const res = await callResult<{ capabilities: string[] }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.ok(res.capabilities.includes('resume_session'), `got: ${JSON.stringify(res.capabilities)}`);
  assert.ok(res.capabilities.includes('fork_session'), `got: ${JSON.stringify(res.capabilities)}`);
  // The other seven remain RPC names; a client that maps capabilities to RPCs must still find them.
  for (const rpc of ['handshake', 'create_session', 'send_turn', 'watch_session_events', 'interrupt_turn', 'resolve_permission', 'close_session']) {
    assert.ok(res.capabilities.includes(rpc), `missing RPC capability ${rpc}`);
  }
});

/**
 * The whole list, pinned by value AND by order -- not another membership check.
 *
 * Every other assertion in this file asks "is X present", which cannot notice an ADDITION or a
 * REORDER. That matters because the known downstream client pins this list by length and by value
 * against a hand-written fixture, so drift on this side is silent on that side until a human edits
 * the fixture: the capability reads as absent, the feature is hidden, and nothing reports a problem.
 * This is the counterpart guard that makes the wire-visible list impossible to change by accident.
 *
 * If you are here because this test went red after adding a capability: that is the test working.
 * Update this array, and tell the downstream client's owner the new string and the new length in
 * the same change window -- they cannot discover it themselves.
 */
test('the advertised capability list is exactly this, in this order', async () => {
  // Pinned for a build that can run BOTH executable sources -- i.e. a checkout -- and pinned
  // explicitly rather than by letting the default answer the question, so this fixture does not
  // quietly become a different list when run from a packaged artifact. The packaged build's list is
  // the same minus its last entry; tests/packagedRuntime.test.ts owns that half.
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    () => makeFakeSession().session,
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
    { sdkBundledAvailable: true },
  );
  const res = await callResult<{ capabilities: string[] }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.deepEqual(res.capabilities, [
    'handshake',
    'create_session',
    'send_turn',
    'watch_session_events',
    'interrupt_turn',
    'resolve_permission',
    'close_session',
    'resume_session',
    'fork_session',
    'setting_sources',
    'tool_policy',
    // Added 2026-09-23: CreateSession.model / .effort, wired through to the kernel in that commit.
    'session_model',
    'session_effort',
    // Added by the consumer completion contract (spec §6.3 P2), each in the commit that wired it.
    'system_prompt',
    'output_format',
    'structured_output',
    'turn_usage',
    'account_identity',
    'init_fingerprint',
    // Added by the consumer client spec §9.1 (web-tool completions), in the commit that wired it.
    'tool_allow_list',
    // Added 2026-09-18 with the packaging work: which of ClaudeHostPolicy.executable's values this
    // BUILD can spawn. 11 -> 13 entries in a checkout, 11 -> 12 in a packaged artifact (which omits
    // 'executable_sdk_bundled'). Neovibe was told the new strings and both lengths in the same
    // change window, per this test's own instruction above.
    // Added 2026-09-26 for neovibe's requests: the SetPermissionMode RPC (+ PermissionModeChanged),
    // and TextDelta/ThinkingDelta.message_id. 13 -> 15 in a checkout, 12 -> 14 packaged; placed
    // ahead of the executable pair so that pair stays last.
    'set_permission_mode',
    'text_delta_message_id',
    // Added 2026-09-27 for neovibe (the CLI's own permission prompts routed to the host): 24 -> 25
    // entries in a checkout, 23 -> 24 packaged; ahead of the executable pair, which stays last.
    'provider_permission_prompts',
    // Added at protocol 3.13: explicit fields for what the sidecar infers from a request's shape
    // (ToolAllowList.init_check, CreateSession.await_account_identity, the handshake's egress_probe and
    // structured_output_tools, SessionReady's effective tool lists). 25 -> 30 in a checkout, 24 -> 29
    // packaged; ahead of the executable pair, which stays last.
    'init_check',
    'await_account_identity',
    'egress_probe',
    'structured_output_tools',
    'effective_tool_report',
    // Added at protocol 3.14: the CLI's own auto mode under the gate, a deferring answer, and the CLI's
    // own refusals as events. 30 -> 33 in a checkout, 29 -> 32 packaged; ahead of the executable pair.
    'cli_auto_mode',
    'permission_defer',
    'permission_denied_events',
    'executable_host_cli',
    'executable_sdk_bundled',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Replay start semantics (2026-09-12 protocol hardening). The rules themselves live on the proto's
// ReplayStart enum; these pin them at the handler, where a client actually meets them.
// ---------------------------------------------------------------------------------------------

/** A session with a capacity-2 buffer holding [4, 5]; sequences 1-3 are irretrievably gone. */
function sessionWithEvictedHistory(impl: ReturnType<typeof setup>['impl'], registry: SessionRegistry) {
  const { session } = makeFakeSession();
  const entry = registry.create('sess-evicted', session, 2);
  for (const n of [1, 2, 3, 4, 5]) {
    entry.ringBuffer.push({ sequence: BigInt(n), occurredAt: 0n, event: {} as never });
  }
  return entry;
}

/**
 * THE regression test for the silent-loss bug, at the wire handler.
 *
 * A client that had seen nothing used to send `after_sequence = 0`, and the handler replayed
 * whatever was retained while saying nothing about the evicted prefix. Now that 0 is an ordinary
 * cursor rather than a sentinel, it gaps like any other cursor that has fallen off the back.
 *
 * Fails against the old implementation, which returned a normal stream here.
 */
test('watchSessionEvents: after_sequence=0 against an evicted buffer is an explicit gap, not a silent partial', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry);

  const { call, getDestroyedWith, written } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_AFTER_SEQUENCE, 0n);
  impl.watchSessionEvents(call);

  assert.equal(getDestroyedWith()?.code, grpc.status.OUT_OF_RANGE);
  assert.equal(written.length, 0, 'a gapped watch must deliver nothing at all, not a partial prefix');
});

test('watchSessionEvents: available_history still serves what remains, and the caller can see a prefix is missing', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry);

  const { call, getDestroyedWith, written } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(call);

  // Not a gap: partial history is exactly what this mode asks for. The honesty is that the first
  // sequence delivered is 4, not 1 -- the caller opted in by name and can see what it got.
  assert.equal(getDestroyedWith(), undefined);
  assert.deepEqual(written.map((e) => (e as { sequence: bigint }).sequence), [4n, 5n]);
});

test('watchSessionEvents: from_now replays nothing even when history is retained', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry);

  const { call, getDestroyedWith, written } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_FROM_NOW);
  impl.watchSessionEvents(call);

  assert.equal(getDestroyedWith(), undefined);
  assert.equal(written.length, 0);
});

test('watchSessionEvents: a cursor beyond anything ever emitted is refused as invalid configuration', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry); // latest is 5

  const { call, getDestroyedWith } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_AFTER_SEQUENCE, 99n);
  impl.watchSessionEvents(call);

  // Not NOT_FOUND and not OUT_OF_RANGE: the session exists and nothing was evicted. The cursor
  // simply cannot have come from this stream, so it came from somewhere it must not have.
  assert.equal(getDestroyedWith()?.code, grpc.status.INVALID_ARGUMENT);
});

test('watchSessionEvents: an unset start is refused rather than defaulted', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry);

  const { call, getDestroyedWith } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_UNSPECIFIED);
  impl.watchSessionEvents(call);

  assert.equal(getDestroyedWith()?.code, grpc.status.INVALID_ARGUMENT);
});

test('watchSessionEvents: the boundary cursor just below the oldest retained event replays cleanly', () => {
  const { impl, registry } = setup();
  sessionWithEvictedHistory(impl, registry); // holds [4, 5]

  const { call, getDestroyedWith, written } = fakeStreamingCall('sess-evicted', ReplayStart.REPLAY_START_AFTER_SEQUENCE, 3n);
  impl.watchSessionEvents(call);

  assert.equal(getDestroyedWith(), undefined, 'off by one here turns every good reconnect into a false loss report');
  assert.deepEqual(written.map((e) => (e as { sequence: bigint }).sequence), [4n, 5n]);
});

test('handshake advertises the capacity the sessions actually get, not the default constant', async () => {
  const { impl, registry } = setup({ ringBufferCapacity: 7 });

  const res = await callResult<{ eventBufferPolicy: string }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.equal(res.eventBufferPolicy, 'bounded-7');

  // And it is the capacity really handed to a session, not just a string. A handshake that
  // advertised a capacity the sessions did not have would let a client assert on the wrong number
  // and pass -- worse than not advertising it.
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const entry = registry.get(created.sessionId)!;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    entry.ringBuffer.push({ sequence: BigInt(n), occurredAt: 0n, event: {} as never });
  }
  assert.equal(entry.ringBuffer.oldestRetainedSequence(), 2n, 'capacity 7 should have evicted exactly sequence 1');
});

test('the watch fault seam breaks one stream and leaves the session running', async () => {
  const { impl, registry, sessions } = setup({ watchFault: { afterEvents: 1 } });
  const created = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const { controller } = sessions.get(created.sessionId)!;

  const first = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(first.call);

  controller.emit({ type: 'turn_started', turnId: 't1' } as never);
  await new Promise((r) => setTimeout(r, 50));

  // The watch died...
  assert.equal(first.getDestroyedWith()?.code, grpc.status.UNAVAILABLE);
  // ...but the session did not. This is the entire point of the seam: if the session died too, a
  // client's reconnect would get NOT_FOUND and the test would silently become a duplicate of the
  // existing killed-sidecar case, proving nothing about replay.
  assert.notEqual(registry.get(created.sessionId), undefined);

  // Events produced while nobody is watching still reach the ring buffer, which is what makes them
  // replayable to a reconnecting client.
  controller.emit({ type: 'turn_started', turnId: 't2' } as never);
  await new Promise((r) => setTimeout(r, 50));

  const second = fakeStreamingCall(created.sessionId, ReplayStart.REPLAY_START_AFTER_SEQUENCE, 1n);
  impl.watchSessionEvents(second.call);

  assert.equal(second.getDestroyedWith(), undefined, 'the reconnect must not be faulted too, or nothing recovers');
  assert.deepEqual(
    second.written.map((e) => (e as { turnStarted?: { turnId: string } }).turnStarted?.turnId),
    ['t2'],
    'the reconnect replays exactly what the broken stream missed -- no duplicate of t1, no loss of t2',
  );
});

// ---------------------------------------------------------------------------------------------
// setting_sources + tool_policy (ClaudeHostPolicy tags 7 and 6)
// ---------------------------------------------------------------------------------------------

/** A proto policy with every pre-existing field at a real value, so a test can add just the one new
 * field it is about. Deliberately built as a plain literal rather than via ClaudeHostPolicy.create,
 * to keep these tests readable; policyTotality.test.ts is the one that derives its field list from
 * the generated message itself. */
function protoPolicy(extra: Partial<ClaudeHostPolicyProto> = {}): ClaudeHostPolicyProto {
  return {
    configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
    permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
    persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
    executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
    streaming: StreamingMode.STREAMING_MODE_COMPLETE,
    toolPolicy: undefined,
    settingSources: undefined,
    permissionModeSwitchable: false,
    providerPermissionPrompts: false,
    cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_UNSPECIFIED,
    ...extra,
  };
}

/**
 * T13 -- the default policy must stay exactly what it was before these two fields existed.
 *
 * `DEFAULT_CLAUDE_HOST_POLICY` is what a client that omits `policy` entirely gets, which per that
 * constant's own comment is a real client-triggerable case and not a defensive fallback. Someone
 * "helpfully" putting a deny list or a source list on it would change behaviour for every such
 * client at once, with no wire change to attribute it to.
 */
test('DEFAULT_CLAUDE_HOST_POLICY carries neither settingSources nor toolPolicy', () => {
  assert.deepEqual(DEFAULT_CLAUDE_HOST_POLICY, {
    configuration: 'native',
    permissions: 'interactive',
    persistence: 'ephemeral',
    executable: 'host_cli',
    streaming: 'complete',
  });
  assert.equal(DEFAULT_CLAUDE_HOST_POLICY.settingSources, undefined);
  assert.equal(DEFAULT_CLAUDE_HOST_POLICY.toolPolicy, undefined);
  // And the mapper agrees for an absent policy, which is the path a client actually takes.
  assert.deepEqual(mapClaudeHostPolicy(undefined), DEFAULT_CLAUDE_HOST_POLICY);
});

/**
 * T14 -- `allow` absent vs present-but-empty, kept apart in the mapper.
 *
 * This is the place the distinction is easiest to lose, because `?? undefined` and `?? []` both look
 * harmless. Losing it turns the SDK's documented "`[]` (empty array) - Disable all built-in tools"
 * into "unrestricted", under a field the caller wrote specifically to restrict.
 */
test('mapClaudeHostPolicy: an absent allow stays undefined; a present-but-empty allow becomes []', () => {
  const absent = mapClaudeHostPolicy(protoPolicy({ toolPolicy: { unrestricted: false, deny: ['Bash'], allow: undefined } }));
  assert.equal(absent.toolPolicy?.allow, undefined);
  assert.deepEqual(absent.toolPolicy?.deny, ['Bash']);

  const empty = mapClaudeHostPolicy(protoPolicy({ toolPolicy: { unrestricted: false, deny: [], allow: { tools: [], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }));
  assert.deepEqual(empty.toolPolicy?.allow, []);

  const stated = mapClaudeHostPolicy(protoPolicy({ toolPolicy: { unrestricted: false, deny: [], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }));
  assert.deepEqual(stated.toolPolicy?.allow, ['Read']);
});

/**
 * T14b -- `unrestricted` survives the mapping.
 *
 * It is the one field in this message whose whole value is being distinguishable from silence, so a
 * mapper that dropped it would turn every deliberate "I want every tool" back into the typo-shaped
 * silence it was added to replace -- and the session would quietly get the conservative deny list
 * with no PreToolUse hook behind it to notice.
 */
test('mapClaudeHostPolicy: unrestricted reaches the kernel policy in both states', () => {
  const stated = mapClaudeHostPolicy(protoPolicy({ toolPolicy: { unrestricted: true, deny: [], allow: undefined } }));
  assert.equal(stated.toolPolicy?.unrestricted, true);

  const silent = mapClaudeHostPolicy(protoPolicy({ toolPolicy: { unrestricted: false, deny: ['Bash'], allow: undefined } }));
  assert.equal(silent.toolPolicy?.unrestricted, false);
});

/**
 * T18b -- the contradiction, refused rather than resolved.
 *
 * Both ways of resolving it are silent data loss: honour `unrestricted` and a stated deny vanishes;
 * honour the deny and the caller gets back a floor it explicitly declined. Neither leaves anything
 * on the wire saying which happened, which is the same reasoning as T17 and T18.
 */
test('validatePolicy: unrestricted together with deny or allow is invalid_configuration', () => {
  for (const policy of [
    protoPolicy({ toolPolicy: { unrestricted: true, deny: ['Bash'], allow: undefined } }),
    protoPolicy({ toolPolicy: { unrestricted: true, deny: [], allow: { tools: [], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
    protoPolicy({ toolPolicy: { unrestricted: true, deny: [], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
    protoPolicy({ toolPolicy: { unrestricted: true, deny: ['Bash'], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
  ]) {
    assert.throws(
      () => validatePolicy(policy),
      (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `expected invalid_configuration for ${JSON.stringify(policy.toolPolicy)}`,
    );
  }
});

/** The other direction, so the rule above cannot be "refuse everything with unrestricted set":
 * stated on its own it is exactly what a bypass caller is meant to send. */
test('validatePolicy: unrestricted on its own is accepted', () => {
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ toolPolicy: { unrestricted: true, deny: [], allow: undefined } })));
});

test('mapClaudeHostPolicy: an absent toolPolicy and an absent settingSources both stay undefined', () => {
  const mapped = mapClaudeHostPolicy(protoPolicy());
  assert.equal(mapped.toolPolicy, undefined);
  assert.equal(mapped.settingSources, undefined);
});

test('mapClaudeHostPolicy: setting_sources canonicalises to the SDK order and de-duplicates', () => {
  const mapped = mapClaudeHostPolicy(protoPolicy({
    settingSources: {
      sources: [
        SettingSourceProto.SETTING_SOURCE_LOCAL,
        SettingSourceProto.SETTING_SOURCE_PROJECT,
        SettingSourceProto.SETTING_SOURCE_LOCAL,
      ],
    },
  }));
  assert.deepEqual(mapped.settingSources, ['project', 'local']);
});

/** Presence, not emptiness: a present-but-empty selection means "load no filesystem settings tiers",
 * which is the opposite end of the range from absent ("defer to `configuration`"). */
test('mapClaudeHostPolicy: a present-but-empty setting_sources maps to [], not to undefined', () => {
  assert.deepEqual(mapClaudeHostPolicy(protoPolicy({ settingSources: { sources: [] } })).settingSources, []);
});

/**
 * T15 -- SETTING_SOURCE_UNSPECIFIED is refused, not dropped.
 *
 * Dropping it turns `[UNSPECIFIED]` into `[]` -- "the tiers I named" silently becoming "none at all",
 * i.e. full isolation -- and turns `[UNSPECIFIED, PROJECT]` into something strictly narrower than
 * what was written. A caller has no way to observe either.
 */
test('validatePolicy: SETTING_SOURCE_UNSPECIFIED is invalid_configuration, never silently dropped', () => {
  for (const sources of [
    [SettingSourceProto.SETTING_SOURCE_UNSPECIFIED],
    [SettingSourceProto.SETTING_SOURCE_UNSPECIFIED, SettingSourceProto.SETTING_SOURCE_PROJECT],
  ]) {
    assert.throws(
      () => validatePolicy(protoPolicy({ settingSources: { sources } })),
      (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `expected invalid_configuration for ${JSON.stringify(sources)}`,
    );
  }
});

/** T16 -- a tier value this sidecar has never heard of (one a newer proto added) is refused for the
 * same reason: a caller that asked for a tier this sidecar cannot load and got silence has no other
 * way to learn that its request was not honoured. */
test('validatePolicy: an unrecognised SettingSource value is invalid_configuration', () => {
  assert.throws(
    () => validatePolicy(protoPolicy({ settingSources: { sources: [99 as SettingSourceProto] } })),
    (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
  );
  assert.throws(
    () => validatePolicy(protoPolicy({ settingSources: { sources: [SettingSourceProto.UNRECOGNIZED] } })),
    (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
  );
});

/** T17 -- an empty or whitespace tool name: presence says "restrict", the value says nothing. Exactly
 * the reasoning behind the empty-`resume_provider_session_id` refusal above, and the same failure
 * shape: a deny entry that matches no tool is silently weaker than what was written. */
test('validatePolicy: an empty or whitespace tool name in deny or allow is invalid_configuration', () => {
  for (const policy of [
    protoPolicy({ toolPolicy: { unrestricted: false, deny: [''], allow: undefined } }),
    protoPolicy({ toolPolicy: { unrestricted: false, deny: ['   '], allow: undefined } }),
    protoPolicy({ toolPolicy: { unrestricted: false, deny: ['Bash', ''], allow: undefined } }),
    protoPolicy({ toolPolicy: { unrestricted: false, deny: [], allow: { tools: [''], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
    protoPolicy({ toolPolicy: { unrestricted: false, deny: [], allow: { tools: ['Read', '\t'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
  ]) {
    assert.throws(
      () => validatePolicy(policy),
      (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `expected invalid_configuration for ${JSON.stringify(policy.toolPolicy)}`,
    );
  }
});

/** T18 -- a name in both lists. Deny wins ("even if they would otherwise be allowed"), so the allow
 * entry adds no expressiveness and can only mislead whoever reads the allow list later into thinking
 * that tool is available. */
test('validatePolicy: a tool named in both deny and allow is invalid_configuration', () => {
  assert.throws(
    () => validatePolicy(protoPolicy({ toolPolicy: { unrestricted: false, deny: ['Bash'], allow: { tools: ['Read', 'Bash'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } })),
    (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
  );
});

test('validatePolicy: a well-formed policy, and an absent one, are both accepted', () => {
  assert.doesNotThrow(() => validatePolicy(undefined));
  assert.doesNotThrow(() => validatePolicy(protoPolicy()));
  assert.doesNotThrow(() => validatePolicy(protoPolicy({
    toolPolicy: { unrestricted: false, deny: ['Bash', 'Write'], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } },
    settingSources: { sources: [SettingSourceProto.SETTING_SOURCE_PROJECT, SettingSourceProto.SETTING_SOURCE_LOCAL] },
  })));
});

/**
 * T19 -- validation runs BEFORE sessionFactory, not inside the mapping.
 *
 * Same placement and same rationale as validateResumeRequest: a request that was never going to be
 * served correctly must fail as a typed client error while no session object -- and in production no
 * Claude subprocess -- exists yet. Asserting the factory's call count is 0 is the only way to state
 * that; a test that only asserted the error code would pass with the validation moved inside
 * mapClaudeHostPolicy, where the factory has already run.
 */
test('createSession rejects an invalid setting_sources BEFORE the session factory is ever called', async () => {
  const registry = new SessionRegistry();
  let factoryCalls = 0;
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      factoryCalls += 1;
      const made = makeFakeSession();
      allCreatedFakeSessions.push(made.session);
      return made.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
  );

  await assert.rejects(
    callResult(impl.createSession.bind(impl), {
      cwd: '/tmp',
      policy: protoPolicy({ settingSources: { sources: [SettingSourceProto.SETTING_SOURCE_UNSPECIFIED] } }),
    }),
    (err: grpc.ServiceError) => err.code === grpc.status.INVALID_ARGUMENT,
  );
  assert.equal(factoryCalls, 0, 'the session factory must not run for a policy that was already refused');

  // Same for a malformed tool policy, so the two rules share the placement rather than only one of
  // them being called from the right place.
  await assert.rejects(
    callResult(impl.createSession.bind(impl), {
      cwd: '/tmp',
      policy: protoPolicy({ toolPolicy: { unrestricted: false, deny: [''], allow: undefined } }),
    }),
    (err: grpc.ServiceError) => err.code === grpc.status.INVALID_ARGUMENT,
  );
  assert.equal(factoryCalls, 0);
});

/**
 * T20 -- the advertisement, the implementation and the enforced protocol major, asserted together.
 *
 * Three halves, all in one test on purpose:
 *   1. the two capability strings are advertised;
 *   2. a CreateSession carrying both fields actually reaches the factory with both intact, so the
 *      advertisement cannot outlive the feature (this list's own comment: "advertising before
 *      implementing is the failure mode this list exists to prevent");
 *   3. the `protocolMajor` in the RESPONSE is the same number the handshake REJECTS mismatches
 *      against. Bumping the constant without updating the response would reject every client and
 *      then report the wrong number to whoever got through.
 */
test('handshake advertises setting_sources and tool_policy, both reach the kernel, and the advertised major is the enforced one', async () => {
  const registry = new SessionRegistry();
  let received: ClaudeSessionConfigLike | undefined;
  const impl = createRuntimeServiceImpl(
    registry,
    (config) => {
      received = config;
      const made = makeFakeSession();
      allCreatedFakeSessions.push(made.session);
      return made.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
  );

  const res = await callResult<{ protocolMajor: number; capabilities: string[] }>(
    impl.handshake.bind(impl),
    { clientProtocolMajor: 3 },
  );
  assert.ok(res.capabilities.includes('setting_sources'), `got: ${JSON.stringify(res.capabilities)}`);
  assert.ok(res.capabilities.includes('tool_policy'), `got: ${JSON.stringify(res.capabilities)}`);

  await callResult(impl.createSession.bind(impl), {
    cwd: '/tmp',
    policy: protoPolicy({
      toolPolicy: { unrestricted: false, deny: ['Bash'], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } },
      settingSources: { sources: [SettingSourceProto.SETTING_SOURCE_PROJECT, SettingSourceProto.SETTING_SOURCE_LOCAL] },
    }),
  });
  const kernelConfig = buildKernelSessionConfig(received!);
  assert.deepEqual(kernelConfig.policy.settingSources, ['project', 'local']);
  assert.deepEqual(kernelConfig.policy.toolPolicy, { deny: ['Bash'], allow: ['Read'], unrestricted: false });

  // The advertised major IS the enforced major: the same number the handshake just reported is the
  // only one it accepts, and one either side of it is refused.
  for (const wrong of [res.protocolMajor - 1, res.protocolMajor + 1]) {
    await assert.rejects(
      callResult(impl.handshake.bind(impl), { clientProtocolMajor: wrong }),
      (err: grpc.ServiceError) => err.code === grpc.status.FAILED_PRECONDITION,
      `handshake accepted protocol major ${wrong} while advertising ${res.protocolMajor}`,
    );
  }
});

test('CreateSession model and effort reach the kernel config; absent ones stay absent', () => {
  const withBoth = buildKernelSessionConfig({ cwd: '/tmp/p', policy: undefined, model: 'sonnet', effort: 'medium' });
  assert.equal(withBoth.model, 'sonnet');
  assert.equal(withBoth.effort, 'medium');
  // Absent must stay absent: setting either to anything is what overrides the CLI default.
  const neither = buildKernelSessionConfig({ cwd: '/tmp/p', policy: undefined });
  assert.equal('model' in neither, false);
  assert.equal('effort' in neither, false);
});

test('an effort level the SDK does not define is refused before a session exists', () => {
  assert.throws(() => validateEffort({ cwd: '/tmp/p', policy: undefined, effort: 'extreme' }), /effort must be one of/);
  // The literal text a partial ts-proto literal used to produce on a plain string field.
  assert.throws(() => validateEffort({ cwd: '/tmp/p', policy: undefined, effort: 'undefined' }), /effort must be one of/);
  for (const ok of [undefined, '', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.doesNotThrow(() => validateEffort({ cwd: '/tmp/p', policy: undefined, effort: ok }));
  }
});
