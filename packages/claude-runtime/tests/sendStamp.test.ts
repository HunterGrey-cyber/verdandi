import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { FAKE_ACCOUNT_INFO, makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup(options: FakeQueryOptions = {}, policy = POLICY) {
  const { query, controller } = makeFakeQuery(options);
  let input!: AsyncIterator<SDKUserMessage>;
  const queryFn: QueryFn = (params) => {
    input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy }, queryFn);
  const nextInput = async () => {
    const next = await input.next();
    assert.equal(next.done, false);
    return next.value as SDKUserMessage;
  };
  return { session, controller, nextInput };
}

async function drain(session: ReturnType<typeof createSession>): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(...await session.pump());
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return events;
}

function lifecycle(uuid: string, state: string) {
  return { type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'frame-uuid', session_id: 'cli-session' } as never;
}

function result(uuid: string) {
  return { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', user_message_uuid: uuid } as never;
}

function assertMessage(sent: SDKUserMessage, text: string): string {
  assert.equal(typeof sent.uuid, 'string');
  assert.match(sent.uuid!, UUID);
  assert.deepEqual(sent, { type: 'user', uuid: sent.uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
  return sent.uuid!;
}

test('first and later sends have distinct UUIDs and echoed results still complete their turns', async (t) => {
  const { session, controller, nextInput } = setup();
  t.after(() => session.close());
  const uuids: string[] = [];
  for (const text of ['first', 'later']) {
    const { turnId } = session.sendTurn(text);
    const uuid = assertMessage(await nextInput(), text);
    uuids.push(uuid);
    await drain(session);
    for (const state of ['queued', 'started', 'completed']) {
      controller.emit(lifecycle(uuid, state));
      assert.deepEqual(await drain(session), []);
    }
    controller.emit(result(uuid));
    assert.deepEqual(await drain(session), [{ type: 'turn_completed', turnId, outcome: 'completed', resultText: 'done', isError: false, stopReason: 'end_turn', resultSubtype: 'success' }]);
  }
  assert.equal(new Set(uuids).size, 2);
});

test('a held completion first turn keeps its UUID when released to the SDK', async (t) => {
  let release!: (info: typeof FAKE_ACCOUNT_INFO) => void;
  const { session, controller, nextInput } = setup(
    { accountInfo: () => new Promise((resolve) => { release = resolve; }) },
    { ...POLICY, toolPolicy: { allow: [] } },
  );
  t.after(() => session.close());
  session.sendTurn('held');
  let arrived = false;
  const pending = nextInput().then((message) => { arrived = true; return message; });
  await drain(session);
  assert.equal(arrived, false);
  release(FAKE_ACCOUNT_INFO);
  const uuid = assertMessage(await pending, 'held');
  await drain(session);
  for (const state of ['queued', 'started', 'completed']) controller.emit(lifecycle(uuid, state));
  assert.deepEqual(await drain(session), []);
});

test('unknown lifecycle UUIDs remain notices and the 257th send evicts only the oldest UUID', async (t) => {
  const { session, controller, nextInput } = setup();
  t.after(() => session.close());
  // `queued`, not `started`: a `started` for a message nobody here sent is the CLI starting a turn of its
  // own (a scheduled prompt), which opens one ahead of the notice (cliTurns.test.ts).
  assert.deepEqual(await drain(session), [{ type: 'background_tasks_changed', tasks: [] }]);
  const unknown = lifecycle('unknown', 'queued');
  controller.emit(unknown);
  const notices = await drain(session);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.type, 'provider_notice');
  assert.equal(notices[0]!.type === 'provider_notice' && notices[0]!.kind, 'command_lifecycle');
  const uuids: string[] = [];
  for (let i = 0; i < 257; i += 1) {
    session.sendTurn(`send ${i}`);
    const uuid = assertMessage(await nextInput(), `send ${i}`);
    uuids.push(uuid);
    controller.emit(result(uuid));
    await drain(session);
    if (i === 255) {
      controller.emit(lifecycle(uuids[0]!, 'started'));
      assert.deepEqual(await drain(session), []);
    }
  }
  assert.equal(new Set(uuids).size, 257);
  controller.emit(lifecycle(uuids[0]!, 'queued'));
  controller.emit(lifecycle(uuids[1]!, 'started'));
  controller.emit(lifecycle(uuids[256]!, 'started'));
  const events = await drain(session);
  assert.deepEqual(events, notices.map((notice) => ({ ...notice, raw: lifecycle(uuids[0]!, 'queued') })));
});
