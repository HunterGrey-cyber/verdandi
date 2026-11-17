import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { CLIENT_TOOL_LIMITS, type ClientToolCallOutcome as KernelClientToolCallOutcome, type ClientToolFailCause, type ClientTools } from '@verdandi/claude-runtime';
import { createClientToolRpc } from '../src/clientToolRpc.js';
import { translateEvent } from '../src/eventTranslation.js';
import { SessionRegistry, type SessionEntry } from '../src/sessionRegistry.js';
import { PumpDriver } from '../src/pumpDriver.js';
import { SidecarError } from '../src/errorMapping.js';
import {
  AnswerClientToolCallRequest,
  ClientToolCallOutcome,
  ErrorCode,
  ErrorDetail,
  GetClientToolCallStateResponse,
  SessionEvent,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * AnswerClientToolCall and GetClientToolCallState against a session whose client tool port is the
 * kernel's own: the first answer to a call wins, a spent or foreign id is refused without touching
 * anything, a refused answer records nothing, a command id replays, and the snapshot agrees with the
 * event stream it names.
 */

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const TOOLS: ClientTools = {
  serverName: 'editor',
  timeoutMs: 60_000,
  tools: [{ name: 'open_file', description: 'Shows a file', inputSchemaJson: '{"type":"object"}', alwaysLoad: false }],
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const registry = new SessionRegistry();
  const rpc = createClientToolRpc({
    requireEntry: (sessionId) => {
      const entry = registry.get(sessionId);
      if (entry === undefined) {
        throw new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, `no such session: ${sessionId}`);
      }
      return entry;
    },
  });
  const open = (sessionId: string, options: { clientTools?: ClientTools; clientToolClock?: () => number } = { clientTools: TOOLS }) => {
    const fake = makeFakeSession(options);
    const entry = registry.create(sessionId, fake.session, 256);
    const driver = new PumpDriver(entry, { onEvent: () => undefined, onTerminal: (id) => registry.remove(id) });
    return { fake, entry, driver };
  };
  return { registry, rpc, open };
}

type Rpc = ReturnType<typeof setup>['rpc'];

function call<T>(handler: (call: { request: never }, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => void, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => handler({ request: request as never }, (err, res) => (err ? reject(err) : resolve(res as T))));
}

function refusedWith(code: grpc.status, errorCode: ErrorCode, reason: string) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, code);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, errorCode);
    assert.equal(detail.reason, reason);
    return true;
  };
}

const notFound = refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_NOT_FOUND, '');
const alreadyAnswered = (reason: string) => refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_ALREADY_ANSWERED, reason);

const answer = (sessionId: string, commandId: string, callId: string, text = 'done', isError = false) =>
  AnswerClientToolCallRequest.fromPartial({ sessionId, commandId, callId, content: [{ text }], isError });

const state = (rpc: Rpc, sessionId: string): Promise<GetClientToolCallStateResponse> => call<GetClientToolCallStateResponse>(rpc.getClientToolCallState, { sessionId });

/** Places one call and returns its id. */
async function place(rpc: Rpc, sessionId: string, fake: ReturnType<typeof makeFakeSession>, id = 1): Promise<string> {
  await fake.controller.callClientTool('open_file', { path: `f${id}` }, { id, toolUseId: `toolu_${id}` });
  const { open } = await state(rpc, sessionId);
  return open[open.length - 1].callId;
}

/** The kernel's client-tool events in the ring, in sequence order. */
function ringEvents(entry: SessionEntry) {
  const replay = entry.ringBuffer.replay({ mode: 'available_history' });
  assert.equal(replay.kind, 'ok');
  return replay.kind === 'ok' ? replay.events.filter((e) => e.event.type === 'client_tool_call' || e.event.type === 'client_tool_call_settled') : [];
}

test('an answer reaches the CLI as one result and the stream as one settled event', async () => {
  const { rpc, open } = setup();
  const { fake, entry, driver } = open('s1');
  const callId = await place(rpc, 's1', fake);
  assert.deepEqual(await call(rpc.answerClientToolCall, answer('s1', 'c1', callId)), {});
  await flush();
  assert.equal(fake.controller.mcpResponses.length, 1);
  const [response] = fake.controller.mcpResponses;
  assert.equal(response.id, 1);
  assert.deepEqual(response.result?.content, [{ type: 'text', text: 'done' }]);
  assert.notEqual(response.result?.isError, true);
  await driver.tick();
  assert.deepEqual(
    ringEvents(entry).map((e) => translateEvent(e.event)),
    [
      { clientToolCall: { callId, toolUseId: 'toolu_1', tool: 'open_file', argumentsJson: '{"path":"f1"}' } },
      { clientToolCallSettled: { callId, outcome: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_ANSWERED } },
    ],
  );
});

test('is_error reaches the CLI as isError true', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  await call(rpc.answerClientToolCall, answer('s1', 'c1', callId, 'no such file', true));
  await flush();
  assert.deepEqual(fake.controller.mcpResponses[0].result, { content: [{ type: 'text', text: 'no such file' }], isError: true });
});

test('the same request under the same command id answers OK again, and the CLI gets one result', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  const request = answer('s1', 'c1', callId);
  assert.deepEqual(await call(rpc.answerClientToolCall, request), {});
  assert.deepEqual((await state(rpc, 's1')).open, [], 'the call is spent');
  assert.deepEqual(await call(rpc.answerClientToolCall, request), {});
  await flush();
  assert.equal(fake.controller.mcpResponses.length, 1);
});

test('a different payload under the same command id is IDEMPOTENCY_CONFLICT', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  await call(rpc.answerClientToolCall, answer('s1', 'c1', callId));
  const conflict = refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, '');
  await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c1', callId, 'something else')), conflict);
  await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c1', callId, 'done', true)), conflict);
});

test('a second answer under another command id is CLIENT_TOOL_CALL_ALREADY_ANSWERED, reason answered', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  await call(rpc.answerClientToolCall, answer('s1', 'c1', callId, 'first'));
  await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c2', callId, 'moved')), alreadyAnswered('answered'));
  await flush();
  assert.equal(fake.controller.mcpResponses.length, 1);
  assert.deepEqual(fake.controller.mcpResponses[0].result?.content, [{ type: 'text', text: 'first' }]);
});

test('an answer to a call interrupted, closed or timed out is ALREADY_ANSWERED with that outcome as its reason', async () => {
  const causes: ClientToolFailCause[] = ['interrupted', 'session_closed', 'provider_failed'];
  for (const cause of causes) {
    const { rpc, open } = setup();
    const { fake } = open('s1');
    const callId = await place(rpc, 's1', fake);
    fake.controller.clientTools!.failAll(cause);
    await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c1', callId)), alreadyAnswered(cause), cause);
  }
  // The CLI letting go: its limit, read from how long the call was open, or earlier for its own reasons.
  for (const [reason, elapsedMs] of [['timed_out', TOOLS.timeoutMs], ['withdrawn', 1]] as const) {
    let now = 0;
    const { rpc, open } = setup();
    const { fake } = open('s1', { clientTools: TOOLS, clientToolClock: () => now });
    const callId = await place(rpc, 's1', fake);
    now = elapsedMs;
    await fake.controller.cancelClientTool(1);
    await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c1', callId)), alreadyAnswered(reason), reason);
  }
});

test('an unknown call id is CLIENT_TOOL_CALL_NOT_FOUND', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  // Each is only a name that was never issued, whatever it looks like.
  for (const unknown of ['never-issued', '', '__proto__', 'constructor', '../../etc/passwd', `${callId} `]) {
    await assert.rejects(call(rpc.answerClientToolCall, answer('s1', `c-${unknown}`, unknown)), notFound, unknown);
  }
  assert.equal((await state(rpc, 's1')).open.length, 1, 'the open call is untouched');
});

test('another session\'s call id on this session is CLIENT_TOOL_CALL_NOT_FOUND, and that session\'s call stays open', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  open('s2');
  const callId = await place(rpc, 's1', fake);
  await assert.rejects(call(rpc.answerClientToolCall, answer('s2', 'c1', callId)), notFound);
  assert.equal((await state(rpc, 's1')).open.length, 1);
  await flush();
  assert.deepEqual(fake.controller.mcpResponses, []);
});

test('a session without client tools answers NOT_FOUND, and its state is empty', async () => {
  const { rpc, open } = setup();
  open('plain', {});
  await assert.rejects(call(rpc.answerClientToolCall, answer('plain', 'c1', 'any')), notFound);
  assert.deepEqual(await state(rpc, 'plain'), { throughSequence: 0n, open: [] });
});

test('a content entry with no kind is INVALID_CONFIGURATION, the call stays open, and a corrected request under the same command id succeeds', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const callId = await place(rpc, 's1', fake);
  const unknownKind = AnswerClientToolCallRequest.fromPartial({ sessionId: 's1', commandId: 'c1', callId, content: [{ text: 'kept' }, {}] });
  await assert.rejects(
    call(rpc.answerClientToolCall, unknownKind),
    refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'client_tool_content_unknown'),
  );
  assert.equal((await state(rpc, 's1')).open.length, 1);
  await flush();
  assert.deepEqual(fake.controller.mcpResponses, []);
  assert.deepEqual(await call(rpc.answerClientToolCall, answer('s1', 'c1', callId)), {});
  await flush();
  assert.equal(fake.controller.mcpResponses.length, 1);
});

test('a closed session\'s id is SESSION_NOT_FOUND', async () => {
  const { rpc, open } = setup();
  const { fake, driver } = open('s1');
  const callId = await place(rpc, 's1', fake);
  fake.session.close();
  await driver.tick();
  const gone = refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, '');
  await assert.rejects(call(rpc.answerClientToolCall, answer('s1', 'c1', callId)), gone);
  await assert.rejects(state(rpc, 's1'), gone);
});

test('GetClientToolCallState lists the open calls and the sequence, and a call settled and sequenced is gone', async () => {
  const { rpc, open } = setup();
  const { fake, entry, driver } = open('s1');
  assert.deepEqual(await state(rpc, 's1'), { throughSequence: 0n, open: [] });
  const first = await place(rpc, 's1', fake, 1);
  const second = await place(rpc, 's1', fake, 2);
  await driver.tick();
  assert.deepEqual(await state(rpc, 's1'), {
    throughSequence: entry.sequence,
    open: [
      { callId: first, toolUseId: 'toolu_1', tool: 'open_file' },
      { callId: second, toolUseId: 'toolu_2', tool: 'open_file' },
    ],
  });
  await call(rpc.answerClientToolCall, answer('s1', 'c1', first));
  await driver.tick();
  assert.deepEqual(await state(rpc, 's1'), { throughSequence: entry.sequence, open: [{ callId: second, toolUseId: 'toolu_2', tool: 'open_file' }] });
});

test('64 open calls with 1 MiB of arguments and the longest tool_use_id each give a state response well under max_message_bytes', async () => {
  const { rpc, open } = setup();
  const { fake } = open('s1');
  const blob = 'x'.repeat(CLIENT_TOOL_LIMITS.argumentsBytes - '{"blob":""}'.length);
  for (let id = 1; id <= CLIENT_TOOL_LIMITS.liveCalls; id += 1) {
    await fake.controller.callClientTool('open_file', { blob }, { id, toolUseId: `${id}`.padStart(CLIENT_TOOL_LIMITS.toolUseIdBytes, 'x') });
  }
  const response = await state(rpc, 's1');
  assert.equal(response.open.length, CLIENT_TOOL_LIMITS.liveCalls);
  const size = GetClientToolCallStateResponse.encode(response).finish().length;
  assert.ok(size < MAX_MESSAGE_BYTES / 100, `a snapshot of ${size} bytes`);
});

test('the state and the events agree: applying the snapshot, then the events after through_sequence, gives the open set', async () => {
  const { rpc, open } = setup();
  const { fake, entry, driver } = open('s1');
  const settledEarlier = await place(rpc, 's1', fake, 1);
  const settlesUnpumped = await place(rpc, 's1', fake, 2);
  const staysOpen = await place(rpc, 's1', fake, 3);
  const settlesAfter = await place(rpc, 's1', fake, 4);
  await call(rpc.answerClientToolCall, answer('s1', 'c1', settledEarlier));
  await driver.tick();
  // Emitted but not yet sequenced at the moment of the snapshot: one new call, and one settled event.
  const unpumped = await place(rpc, 's1', fake, 5);
  await call(rpc.answerClientToolCall, answer('s1', 'c2', settlesUnpumped));

  const snapshot = await state(rpc, 's1');
  assert.deepEqual(new Set(snapshot.open.map((c) => c.callId)), new Set([staysOpen, settlesAfter, unpumped]));

  // After the snapshot: one settles and one arrives.
  await call(rpc.answerClientToolCall, answer('s1', 'c3', settlesAfter));
  const arrivedAfter = await place(rpc, 's1', fake, 6);
  await driver.tick();

  const applied = new Set(snapshot.open.map((c) => c.callId));
  const after = entry.ringBuffer.replay({ mode: 'after_sequence', afterSequence: snapshot.throughSequence });
  assert.equal(after.kind, 'ok');
  for (const { event } of after.kind === 'ok' ? after.events : []) {
    if (event.type === 'client_tool_call') {
      applied.add(event.callId);
    } else if (event.type === 'client_tool_call_settled') {
      applied.delete(event.callId);
    }
  }
  assert.deepEqual(applied, new Set(fake.controller.clientTools!.pending().map((c) => c.callId)));
  assert.deepEqual(applied, new Set([staysOpen, unpumped, arrivedAfter]));
});

test('every kernel outcome has a wire outcome', () => {
  // `satisfies` keeps the list total over the kernel's union: a word added there fails to compile here.
  const expected = {
    answered: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_ANSWERED,
    interrupted: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_INTERRUPTED,
    session_closed: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_SESSION_CLOSED,
    timed_out: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_TIMED_OUT,
    withdrawn: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_WITHDRAWN,
    provider_failed: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_PROVIDER_FAILED,
  } satisfies Record<KernelClientToolCallOutcome, ClientToolCallOutcome>;
  const outcomes = Object.entries(expected) as [KernelClientToolCallOutcome, ClientToolCallOutcome][];
  assert.deepEqual(outcomes.map(([kernel]) => kernel).sort(), ['answered', 'interrupted', 'provider_failed', 'session_closed', 'timed_out', 'withdrawn']);
  for (const [kernel, wire] of outcomes) {
    assert.ok(wire !== undefined && wire !== ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_UNSPECIFIED, kernel);
    const event = translateEvent({ type: 'client_tool_call_settled', callId: 'c', outcome: kernel });
    assert.equal(SessionEvent.decode(SessionEvent.encode(SessionEvent.fromPartial(event)).finish()).clientToolCallSettled?.outcome, wire, kernel);
  }
  assert.equal(new Set(outcomes.map(([, wire]) => wire)).size, outcomes.length, 'each outcome keeps its own name on the wire');
});
