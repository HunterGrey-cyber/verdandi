import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeQuery } from './fakeQuery.js';
import { createSession } from '../src/session.js';
import { translateMessage } from '../src/eventTranslation.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';

/**
 * text_delta / thinking_delta carry the API message id they belong to, so a consumer can split two
 * consecutive assistant replies that have no tool call between them (neovibe, 2026-09-25).
 */

const COMPLETE: ClaudeHostPolicy = { configuration: 'native', permissions: 'bypass', persistence: 'ephemeral', executable: 'host_cli', toolPolicy: { unrestricted: true } };
const PARTIAL: ClaudeHostPolicy = { ...COMPLETE, streaming: 'partial' };

type Delta = Extract<ClaudeRuntimeEvent, { type: 'text_delta' | 'thinking_delta' }>;

function deltas(events: ClaudeRuntimeEvent[]): Array<Pick<Delta, 'type' | 'text' | 'messageId'>> {
  return events
    .filter((e): e is Delta => e.type === 'text_delta' || e.type === 'thinking_delta')
    .map((e) => ({ type: e.type, text: e.text, ...(e.messageId === undefined ? {} : { messageId: e.messageId }) }));
}

function startEvent(id: unknown, parent: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id } } } as never;
}
function textDelta(text: string, parent: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } } as never;
}

test('complete mode: every block of an assistant message carries that message\'s id', () => {
  const events = translateMessage(
    { type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hello' }] } } as never,
    { currentTurnId: 't1' },
  );
  assert.deepEqual(deltas(events), [
    { type: 'thinking_delta', text: 'hm', messageId: 'msg_A' },
    { type: 'text_delta', text: 'hello', messageId: 'msg_A' },
  ]);
});

test('a message with no usable id yields deltas with no messageId, never an invented one', () => {
  for (const id of [undefined, '', 42]) {
    const events = translateMessage({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }] } } as never, { currentTurnId: 't1' });
    assert.equal('messageId' in events[0], false, JSON.stringify(id));
  }
});

test('complete mode through a session: two consecutive replies with no tool call between them have different ids', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: COMPLETE }, () => query);
  session.sendTurn('hi');
  controller.emit({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'first' }] } } as never);
  controller.emit({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'second' }] } } as never);
  const events = [...(await session.pump()), ...(await session.pump())];
  assert.deepEqual(deltas(events), [
    { type: 'text_delta', text: 'first', messageId: 'msg_1' },
    { type: 'text_delta', text: 'second', messageId: 'msg_2' },
  ]);
  session.close();
});

test('partial mode: deltas take the id of their message_start, and a new message_start moves it on', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(startEvent('msg_1'));
  controller.emit(textDelta('Hel'));
  controller.emit(textDelta('lo'));
  controller.emit({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] } } as never);
  controller.emit(startEvent('msg_2'));
  controller.emit(textDelta('Again'));
  controller.emit({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Again' }] } } as never);
  const events = [...(await session.pump()), ...(await session.pump())];
  assert.deepEqual(deltas(events), [
    { type: 'text_delta', text: 'Hel', messageId: 'msg_1' },
    { type: 'text_delta', text: 'lo', messageId: 'msg_1' },
    { type: 'text_delta', text: 'Again', messageId: 'msg_2' },
  ]);
  session.close();
});

test('partial mode: a message_start with no id clears the previous id rather than gluing two replies together', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(startEvent('msg_1'));
  controller.emit(textDelta('a'));
  controller.emit(startEvent(undefined));
  controller.emit(textDelta('b'));
  const events = await session.pump();
  assert.deepEqual(deltas(events), [
    { type: 'text_delta', text: 'a', messageId: 'msg_1' },
    { type: 'text_delta', text: 'b' },
  ]);
  session.close();
});

test('partial mode: a subagent\'s stream does not relabel the main thread\'s deltas', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(startEvent('msg_main'));
  controller.emit(textDelta('main-1'));
  controller.emit(startEvent('msg_sub', 'toolu_task'));
  controller.emit(textDelta('sub', 'toolu_task'));
  controller.emit(textDelta('main-2'));
  const events = await session.pump();
  assert.deepEqual(deltas(events), [
    { type: 'text_delta', text: 'main-1', messageId: 'msg_main' },
    { type: 'text_delta', text: 'sub', messageId: 'msg_sub' },
    { type: 'text_delta', text: 'main-2', messageId: 'msg_main' },
  ]);
  session.close();
});
