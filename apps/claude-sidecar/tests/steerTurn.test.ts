import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { SteerError, type ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { startSidecar } from '../src/lifecycle.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import { extractTurnId, translateEvent } from '../src/eventTranslation.js';
import { makeFakeSession } from './fakeSession.js';
import {
  ErrorCode,
  ErrorDetail,
  ReplayStart,
  RuntimeServiceClient,
  SessionEvent,
  UserMessageDropReason,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/** SteerTurn and CommandsUpdated, sidecar half: the RPC, its error mapping and idempotency, and the
 * events on the wire. The kernel half (what the CLI is sent, and how its lifecycle frames become
 * events and turns) is packages/claude-runtime/tests/steer.test.ts. */

const created: MinimalKernelSession[] = [];
after(async () => {
  for (const session of created) {
    session.close();
  }
  await new Promise((r) => setTimeout(r, 100));
});

function setup() {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      const m = makeFakeSession();
      made.push(m);
      created.push(m.session);
      return m.session;
    },
    { sdkDeclared: '2.1.252', hostCli: '2.1.293' },
  );
  return { impl, made };
}

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

function detailOf(err: grpc.ServiceError): ErrorDetail | undefined {
  const bytes = err.metadata?.get('grpc-status-details-bin')[0];
  return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer);
}

test('steerTurn hands the request to the kernel and answers with the turn it was steered into', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const res = await callResult<{ turnId: string }>(impl.steerTurn.bind(impl), { sessionId, commandId: 's1', expectedTurnId: 't1', clientMessageId: 'm1', text: 'and the tests' });
  assert.deepEqual(res, { turnId: 't1' });
  assert.deepEqual(made[0].controller.steeredTurns, [{ expectedTurnId: 't1', clientMessageId: 'm1', text: 'and the tests' }]);
});

test('steerTurn error mapping: every kernel refusal kind has its code, and the reason travels', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const cases: Array<[SteerError, ErrorCode, grpc.status, string]> = [
    [new SteerError('no_active_turn', 'idle'), ErrorCode.ERROR_CODE_NO_ACTIVE_TURN, grpc.status.FAILED_PRECONDITION, ''],
    [new SteerError('turn_mismatch', 'stale'), ErrorCode.ERROR_CODE_TURN_MISMATCH, grpc.status.FAILED_PRECONDITION, ''],
    [new SteerError('unavailable', 'no frames', 'cli_lifecycle_not_reported'), ErrorCode.ERROR_CODE_STEER_UNAVAILABLE, grpc.status.FAILED_PRECONDITION, 'cli_lifecycle_not_reported'],
    [new SteerError('unavailable', 'held', 'first_turn_held'), ErrorCode.ERROR_CODE_STEER_UNAVAILABLE, grpc.status.FAILED_PRECONDITION, 'first_turn_held'],
    [new SteerError('invalid', 'empty', 'steer_text_empty'), ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, grpc.status.INVALID_ARGUMENT, 'steer_text_empty'],
    [new SteerError('closed', 'session is closed'), ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, grpc.status.NOT_FOUND, ''],
  ];
  for (const [i, [kernelErr, code, status, reason]] of cases.entries()) {
    made[0].controller.makeNextSteerTurnThrow(kernelErr);
    await assert.rejects(
      callResult(impl.steerTurn.bind(impl), { sessionId, commandId: `c${i}`, expectedTurnId: 't', clientMessageId: `m${i}`, text: 'x' }),
      (err: grpc.ServiceError) => {
        assert.equal(err.code, status, kernelErr.kind);
        assert.equal(detailOf(err)?.code, code, kernelErr.kind);
        assert.equal(detailOf(err)?.reason, reason, kernelErr.kind);
        return true;
      },
    );
  }
  // A refused steer records nothing: the same command_id now reaches the kernel and succeeds.
  await callResult(impl.steerTurn.bind(impl), { sessionId, commandId: 'c0', expectedTurnId: 't', clientMessageId: 'm0', text: 'x' });
  assert.equal(made[0].controller.steeredTurns.length, 1);
});

test('steerTurn on an unknown session is SESSION_NOT_FOUND', async () => {
  const { impl } = setup();
  await assert.rejects(callResult(impl.steerTurn.bind(impl), { sessionId: 'nope', commandId: 'c', expectedTurnId: 't', clientMessageId: 'm', text: 'x' }), (err: grpc.ServiceError) => {
    assert.equal(detailOf(err)?.code, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND);
    return true;
  });
});

test('steerTurn is idempotent per command_id: a retry replays, a different payload conflicts', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const request = { sessionId, commandId: 'same', expectedTurnId: 't1', clientMessageId: 'm1', text: 'x' };
  await callResult(impl.steerTurn.bind(impl), request);
  assert.deepEqual(await callResult(impl.steerTurn.bind(impl), request), { turnId: 't1' });
  assert.equal(made[0].controller.steeredTurns.length, 1, 'the retry did not steer twice');
  await assert.rejects(callResult(impl.steerTurn.bind(impl), { ...request, text: 'y' }), (err: grpc.ServiceError) => {
    assert.equal(detailOf(err)?.code, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
    return true;
  });
});

test('translateEvent: the steer fate events and the command list, and the envelope turn id of a delivery', () => {
  const delivered = { type: 'user_message_delivered', clientMessageId: 'm1', turnId: 't2', intoRunningTurn: false } as const;
  assert.deepEqual(translateEvent(delivered), { userMessageDelivered: { clientMessageId: 'm1', turnId: 't2', intoRunningTurn: false } });
  assert.equal(extractTurnId(delivered), 't2');
  for (const [reason, wire] of [
    ['cancelled', UserMessageDropReason.USER_MESSAGE_DROP_REASON_CANCELLED],
    ['discarded', UserMessageDropReason.USER_MESSAGE_DROP_REASON_DISCARDED],
    ['refused', UserMessageDropReason.USER_MESSAGE_DROP_REASON_REFUSED],
    ['session_closed', UserMessageDropReason.USER_MESSAGE_DROP_REASON_SESSION_CLOSED],
  ] as const) {
    const dropped = { type: 'user_message_dropped', clientMessageId: 'm1', reason } as const;
    assert.deepEqual(translateEvent(dropped), { userMessageDropped: { clientMessageId: 'm1', reason: wire } });
    assert.equal(extractTurnId(dropped), undefined);
  }
  const commands: ClaudeRuntimeEvent = {
    type: 'commands_updated',
    source: 'initialize',
    commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>', aliases: ['r'] }],
  };
  const wire = translateEvent(commands);
  assert.deepEqual(wire, { commandsUpdated: { commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>', aliases: ['r'] }] } });
  // Encodable, so no watcher dies on it.
  const bytes = SessionEvent.encode({ sessionId: 's', sequence: 1n, occurredAt: 0n, ...wire } as SessionEvent).finish();
  assert.equal(SessionEvent.decode(bytes).commandsUpdated?.commands[0]?.argumentHint, '<pr>');
});

function promisify<Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<Res> {
  return new Promise((resolve, reject) => fn(req, (err, res) => (err ? reject(err) : resolve(res as Res))));
}

test('over a real UDS with the generated client: the handshake lists steer_turn and list_commands, SteerTurn answers, and a watcher sees the fate and command events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-steer-'));
  const socketPath = join(dir, 'sidecar.sock');
  let fake: ReturnType<typeof makeFakeSession> | undefined;
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: () => {
      fake = makeFakeSession();
      return fake.session;
    },
    getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.252', hostCli: '2.1.293' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    const handshake = await promisify<{ capabilities: string[]; protocolMinor: number }>(client.handshake.bind(client), { clientProtocolMajor: 3 });
    assert.ok(handshake.capabilities.includes('steer_turn'));
    assert.ok(handshake.capabilities.includes('list_commands'));
    assert.equal(handshake.protocolMinor, PROTOCOL_MINOR);

    const { sessionId } = await promisify<{ sessionId: string }>(client.createSession.bind(client), { cwd: '/tmp', policy: undefined });
    const watch = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
    const seen: SessionEvent[] = [];
    const sawAll = new Promise<void>((resolve) => {
      watch.on('data', (event: SessionEvent) => {
        seen.push(event);
        if (seen.some((e) => e.userMessageDelivered) && seen.some((e) => e.userMessageDropped) && seen.some((e) => e.commandsUpdated)) {
          resolve();
        }
      });
    });
    watch.on('error', () => undefined);

    const res = await promisify<{ turnId: string }>(client.steerTurn.bind(client), { sessionId, commandId: 'st-1', expectedTurnId: 't1', clientMessageId: 'm1', text: 'x' });
    assert.equal(res.turnId, 't1');
    fake!.controller.emit({ type: 'commands_updated', source: 'initialize', commands: [{ name: 'review', description: 'd', argumentHint: '', aliases: [] }] });
    fake!.controller.emit({ type: 'user_message_delivered', clientMessageId: 'm1', turnId: 't1', intoRunningTurn: true });
    fake!.controller.emit({ type: 'user_message_dropped', clientMessageId: 'm2', reason: 'refused' });
    await sawAll;

    const delivered = seen.find((e) => e.userMessageDelivered)!;
    assert.equal(delivered.turnId, 't1', 'the envelope carries the turn');
    assert.deepEqual(delivered.userMessageDelivered, { clientMessageId: 'm1', turnId: 't1', intoRunningTurn: true });
    assert.equal(seen.find((e) => e.userMessageDropped)!.userMessageDropped!.reason, UserMessageDropReason.USER_MESSAGE_DROP_REASON_REFUSED);
    assert.equal(seen.find((e) => e.commandsUpdated)!.commandsUpdated!.commands[0]!.name, 'review');

    // A kernel refusal reaches the generated client with its code in the trailing ErrorDetail.
    fake!.controller.makeNextSteerTurnThrow(new SteerError('turn_mismatch', 'stale'));
    await assert.rejects(promisify(client.steerTurn.bind(client), { sessionId, commandId: 'st-3', expectedTurnId: 'old', clientMessageId: 'm4', text: 'x' }), (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      assert.equal(detailOf(err)?.code, ErrorCode.ERROR_CODE_TURN_MISMATCH);
      return true;
    });
    watch.cancel();
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CommandsUpdated for a watcher that would not otherwise see it --------------------------------------

function watchCall(sessionId: string, start: ReplayStart, afterSequence?: bigint) {
  const written: SessionEvent[] = [];
  const call = {
    request: { sessionId, start, afterSequence },
    write: (chunk: unknown): boolean => {
      written.push(chunk as SessionEvent);
      return true;
    },
    writableLength: 0,
    end: () => undefined,
    destroy: () => undefined,
    emit: () => undefined,
    on: () => undefined,
  };
  return { call, written };
}

async function sessionWithCommands(ringBufferCapacity = 100) {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      const m = makeFakeSession();
      made.push(m);
      created.push(m.session);
      return m.session;
    },
    { sdkDeclared: '2.1.252', hostCli: '2.1.293' },
    { ringBufferCapacity },
  );
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const commands: ClaudeRuntimeEvent = { type: 'commands_updated', source: 'initialize', commands: [{ name: 'review', description: 'd', argumentHint: '', aliases: [] }] };
  made[0].controller.emit(commands);
  await new Promise((r) => setTimeout(r, 60)); // the driver's 20 ms tick
  return { impl, registry, sessionId, controller: made[0].controller };
}

const commandEvents = (events: SessionEvent[]) => events.filter((event) => event.commandsUpdated !== undefined);

test('a FROM_NOW watcher gets the newest command list as a new event with the next sequence, and so does every other watcher', async () => {
  const { impl, registry, sessionId } = await sessionWithCommands();
  const early = watchCall(sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(early.call);
  assert.equal(commandEvents(early.written).length, 1, 'the replay holds it: nothing is re-sent');
  const before = registry.get(sessionId)!.sequence;
  const late = watchCall(sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  impl.watchSessionEvents(late.call);
  assert.equal(commandEvents(late.written).length, 1);
  assert.equal(late.written[0]!.sequence, before + 1n, 'a fresh sequence, gapless for everyone');
  assert.equal(late.written[0]!.commandsUpdated!.commands[0]!.name, 'review');
  assert.equal(commandEvents(early.written).length, 2, 'the other watcher gets the copy too');
  assert.equal(early.written.at(-1)!.sequence, before + 1n);
});

test('a watcher whose cursor is past the newest list gets nothing again; one whose replay lost it does', async () => {
  const { impl, registry, sessionId, controller } = await sessionWithCommands(2);
  const listSequence = registry.get(sessionId)!.latestCommands!.sequence;
  const past = watchCall(sessionId, ReplayStart.REPLAY_START_AFTER_SEQUENCE, listSequence);
  impl.watchSessionEvents(past.call);
  assert.equal(commandEvents(past.written).length, 0);
  // Evict it: the ring holds two events.
  controller.emit({ type: 'text_delta', turnId: 't', text: 'a' });
  controller.emit({ type: 'text_delta', turnId: 't', text: 'b' });
  await new Promise((r) => setTimeout(r, 60));
  const fresh = watchCall(sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
  impl.watchSessionEvents(fresh.call);
  const lists = commandEvents(fresh.written);
  assert.equal(lists.length, 1);
  assert.ok(lists[0]!.sequence > fresh.written[0]!.sequence || fresh.written.length === 1, 'after the replay, at the end');
  assert.equal(fresh.written.at(-1)!.commandsUpdated?.commands[0]?.name, 'review');
});

test('a session that never sent a list re-sends nothing', async () => {
  const { impl } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const w = watchCall(sessionId, ReplayStart.REPLAY_START_FROM_NOW);
  impl.watchSessionEvents(w.call);
  assert.deepEqual(w.written, []);
});
