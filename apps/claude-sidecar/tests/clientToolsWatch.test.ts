import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import type { ClientTools } from '@verdandi/claude-runtime';
import { startSidecar } from '../src/lifecycle.js';
import {
  AnswerClientToolCallRequest,
  ClientToolCallOutcome,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  GetClientToolCallStateRequest,
  HandshakeRequest,
  ReplayStart,
  RuntimeServiceClient,
  WatchSessionEventsRequest,
  type GetClientToolCallStateResponse,
  type HandshakeResponse,
  type SessionEvent,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession, type FakeSessionController } from './fakeSession.js';

/**
 * The client-tool events and RPCs over a real gRPC server on a real socket, with a fake session under
 * them: what a watcher sees of a call by how it attached, and what a host that adopts a session can
 * rely on from the snapshot, whatever the ring still holds.
 */

const TOOLS: ClientTools = {
  serverName: 'editor',
  timeoutMs: 60_000,
  tools: [{ name: 'open_file', description: 'Shows a file', inputSchemaJson: '{"type":"object"}', alwaysLoad: false }],
};

function promisify<Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => (err ? reject(err) : resolve(res as Res)));
  });
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Watcher = { events: SessionEvent[]; ended: Promise<void> };

/** `ended` rejects when the stream fails, so a test that awaits it also proves the stream ended cleanly. */
function watch(client: RuntimeServiceClient, sessionId: string, start: ReplayStart): Watcher {
  const call = client.watchSessionEvents(WatchSessionEventsRequest.fromPartial({ sessionId, start }));
  const events: SessionEvent[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    call.on('end', () => resolve());
    call.on('error', reject);
  });
  ended.catch(() => undefined);
  call.on('data', (event: SessionEvent) => events.push(event));
  return { events, ended };
}

/** A FROM_NOW watcher has attached once a live event reaches it. */
async function attached(watcher: Watcher, controller: FakeSessionController): Promise<void> {
  await until(() => {
    controller.emit({ type: 'turn_started', turnId: 'attached' } as never);
    return watcher.events.length > 0;
  }, 'the watcher to attach');
}

async function withSidecar(options: { ringBufferCapacity?: number }, body: (rig: ReturnType<typeof rigOf>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'client-tools-watch-'));
  const socketPath = join(dir, 'sidecar.sock');
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: (config) => {
      const fake = makeFakeSession(config.clientTools === undefined ? {} : { clientTools: config.clientTools });
      made.push(fake);
      return fake.session;
    },
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
    ...(options.ringBufferCapacity === undefined ? {} : { runtime: { sdkBundledAvailable: true, ringBufferCapacity: options.ringBufferCapacity } }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    await body(rigOf(client, made));
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function rigOf(client: RuntimeServiceClient, made: Array<ReturnType<typeof makeFakeSession>>) {
  const stateOf = (sessionId: string) =>
    promisify<GetClientToolCallStateResponse>(client.getClientToolCallState.bind(client), GetClientToolCallStateRequest.fromPartial({ sessionId }));
  return {
    client,
    made,
    stateOf,
    async open(): Promise<{ sessionId: string; controller: FakeSessionController }> {
      const { sessionId } = await promisify<{ sessionId: string }>(client.createSession.bind(client), CreateSessionRequest.fromPartial({ cwd: '/tmp', clientTools: TOOLS }));
      return { sessionId, controller: made[made.length - 1].controller };
    },
    /** Places a call and returns its id. */
    async place(sessionId: string, controller: FakeSessionController, id: number): Promise<string> {
      await controller.callClientTool('open_file', { path: `f${id}` }, { id, toolUseId: `toolu_${id}` });
      return (await stateOf(sessionId)).open.find((c) => c.toolUseId === `toolu_${id}`)!.callId;
    },
    /** Waits for the pump to have sequenced at least `atLeast` events. */
    async sequenced(sessionId: string, atLeast: bigint): Promise<void> {
      let seen = 0n;
      await until(async () => {
        seen = (await stateOf(sessionId)).throughSequence;
        return seen >= atLeast;
      }, `sequence ${atLeast}`);
    },
    answer(sessionId: string, commandId: string, callId: string) {
      return promisify<unknown>(client.answerClientToolCall.bind(client), AnswerClientToolCallRequest.fromPartial({ sessionId, commandId, callId, content: [{ text: 'done' }] }));
    },
    close(sessionId: string) {
      return promisify<unknown>(client.closeSession.bind(client), { sessionId, commandId: `close-${sessionId}` });
    },
  };
}

const callEvents = (events: SessionEvent[]) => events.filter((e) => e.clientToolCall !== undefined);
const settledEvents = (events: SessionEvent[]) => events.filter((e) => e.clientToolCallSettled !== undefined);

test('a new watcher from AVAILABLE_HISTORY gets the call and its settled event in order; the settled event comes exactly once to each of two watchers', async () => {
  await withSidecar({}, async (rig) => {
    const { sessionId, controller } = await rig.open();
    const callId = await rig.place(sessionId, controller, 1);
    await rig.sequenced(sessionId, 1n);
    // One watcher reads the call from the ring and the settled event live, the other both from the ring.
    const live = watch(rig.client, sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
    await until(() => live.events.length === 1, 'the replayed call');
    await rig.answer(sessionId, 'c1', callId);
    await rig.sequenced(sessionId, 2n);
    const replayed = watch(rig.client, sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
    await until(() => replayed.events.length === 2 && live.events.length === 2, 'both watchers to hold both events');
    await rig.close(sessionId);
    await Promise.all([live.ended, replayed.ended]);
    for (const { events } of [live, replayed]) {
      assert.deepEqual(events.map((e) => e.sequence), [1n, 2n, 3n]);
      assert.deepEqual(events[0].clientToolCall, { callId, toolUseId: 'toolu_1', tool: 'open_file', argumentsJson: '{"path":"f1"}' });
      assert.deepEqual(events[1].clientToolCallSettled, { callId, outcome: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_ANSWERED });
      assert.equal(events[0].turnId, undefined, 'neither event carries a turn');
      assert.equal(events[1].turnId, undefined, 'neither event carries a turn');
      assert.equal(settledEvents(events).length, 1);
      assert.ok(events[2].sessionClosed !== undefined);
    }
  });
});

test('a watcher FROM_NOW gets neither, and GetClientToolCallState lists the call with a sequence at or above it', async () => {
  await withSidecar({}, async (rig) => {
    const { sessionId, controller } = await rig.open();
    const spent = await rig.place(sessionId, controller, 1);
    await rig.answer(sessionId, 'c1', spent);
    const callId = await rig.place(sessionId, controller, 2);
    await rig.sequenced(sessionId, 3n);

    const adopter = watch(rig.client, sessionId, ReplayStart.REPLAY_START_FROM_NOW);
    await attached(adopter, controller);
    const history = watch(rig.client, sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
    await until(() => callEvents(history.events).length === 2, 'the replayed calls');
    const { throughSequence, open } = await rig.stateOf(sessionId);
    assert.deepEqual(open, [{ callId, toolUseId: 'toolu_2', tool: 'open_file' }]);
    const announced = callEvents(history.events).find((e) => e.clientToolCall!.callId === callId)!;
    assert.ok(throughSequence >= announced.sequence, `snapshot at ${throughSequence}, the call at ${announced.sequence}`);

    await rig.close(sessionId);
    await Promise.all([adopter.ended, history.ended]);
    assert.deepEqual(callEvents(adopter.events), []);
    assert.deepEqual(settledEvents(adopter.events), []);
  });
});

test('after a ring small enough to evict the call, the state RPC still lists it', async () => {
  await withSidecar({ ringBufferCapacity: 4 }, async (rig) => {
    const { sessionId, controller } = await rig.open();
    const callId = await rig.place(sessionId, controller, 1);
    for (let turn = 0; turn < 8; turn += 1) {
      controller.emit({ type: 'turn_started', turnId: `t${turn}` } as never);
    }
    await rig.sequenced(sessionId, 9n);
    const history = watch(rig.client, sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
    await until(() => history.events.length === 4, 'what the ring holds');
    assert.deepEqual(callEvents(history.events), [], 'the ring no longer holds the call');
    assert.deepEqual((await rig.stateOf(sessionId)).open, [{ callId, toolUseId: 'toolu_1', tool: 'open_file' }]);
    await rig.close(sessionId);
    await history.ended;
  });
});

test('an adopting host\'s rule holds: replayed calls at or below through_sequence that are not in open have settled', async () => {
  await withSidecar({}, async (rig) => {
    const { sessionId, controller } = await rig.open();
    const answered = await rig.place(sessionId, controller, 1);
    const open = await rig.place(sessionId, controller, 2);
    const withdrawn = await rig.place(sessionId, controller, 3);
    await rig.answer(sessionId, 'c1', answered);
    await controller.cancelClientTool(3);
    await rig.sequenced(sessionId, 5n);

    const snapshot = await rig.stateOf(sessionId);
    assert.deepEqual(snapshot.open.map((c) => c.callId), [open]);
    const history = watch(rig.client, sessionId, ReplayStart.REPLAY_START_AVAILABLE_HISTORY);
    await until(() => history.events.length === 5, 'the replay');
    const settled = new Set(settledEvents(history.events).map((e) => e.clientToolCallSettled!.callId));
    const held = new Set(snapshot.open.map((c) => c.callId));
    const replayed = callEvents(history.events).filter((e) => e.sequence <= snapshot.throughSequence);
    assert.deepEqual(new Set(replayed.map((e) => e.clientToolCall!.callId)), new Set([answered, open, withdrawn]));
    for (const event of replayed) {
      const id = event.clientToolCall!.callId;
      assert.equal(settled.has(id), !held.has(id), id);
    }
    await rig.close(sessionId);
    await history.ended;
  });
});

test('the handshake lists client_tools ahead of the executable pair', async () => {
  await withSidecar({}, async (rig) => {
    const { capabilities } = await promisify<HandshakeResponse>(rig.client.handshake.bind(rig.client), HandshakeRequest.fromPartial({ clientProtocolMajor: 3 }));
    const at = capabilities.indexOf('client_tools');
    assert.ok(at >= 0, 'client_tools is advertised');
    assert.equal(capabilities[at - 1], 'structured_questions_v1');
    assert.ok(at < capabilities.indexOf('executable_host_cli'));
  });
});

test('a CreateSession with a bad client_tools answers INVALID_CONFIGURATION with its reason, with no session created', async () => {
  await withSidecar({}, async (rig) => {
    const refused = promisify(rig.client.createSession.bind(rig.client), CreateSessionRequest.fromPartial({ cwd: '/tmp', clientTools: { ...TOOLS, tools: [] } }));
    await assert.rejects(refused, (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
      assert.equal(detail.code, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
      assert.equal(detail.reason, 'client_tools_no_tools');
      return true;
    });
    assert.equal(rig.made.length, 0);
  });
});
