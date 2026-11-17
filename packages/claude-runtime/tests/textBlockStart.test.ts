import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeQuery } from './fakeQuery.js';
import { createSession } from '../src/session.js';
import { translateMessage } from '../src/eventTranslation.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';

/**
 * The first text_delta of each content block says so (`startsBlock`), so a host can keep two text blocks of
 * one message apart: a paragraph, then a Markdown table, arrive as two blocks with the same message id, and
 * glued together the table is not a table.
 */

const COMPLETE: ClaudeHostPolicy = { configuration: 'native', permissions: 'bypass', persistence: 'ephemeral', executable: 'host_cli', toolPolicy: { unrestricted: true } };
const PARTIAL: ClaudeHostPolicy = { ...COMPLETE, streaming: 'partial' };

type Text = Extract<ClaudeRuntimeEvent, { type: 'text_delta' }>;

function texts(events: ClaudeRuntimeEvent[]): Array<[string, boolean, string | undefined]> {
  return events.filter((e): e is Text => e.type === 'text_delta').map((e) => [e.text, e.startsBlock === true, e.parentToolUseId]);
}

function start(id: string, parent: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id } } } as never;
}
function delta(index: unknown, text: string, parent: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } } as never;
}
function thought(index: number, thinking: string) {
  return { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } } as never;
}

test('complete mode: every text block starts a block, whether one message carries both or each comes alone', () => {
  const both = translateMessage(
    { type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Intro' }, { type: 'text', text: '| a |' }] } } as never,
    { currentTurnId: 't1' },
  );
  assert.deepEqual(texts(both), [['Intro', true, undefined], ['| a |', true, undefined]]);
  const alone = translateMessage({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '| a |' }] } } as never, { currentTurnId: 't1' });
  assert.deepEqual(texts(alone), [['| a |', true, undefined]]);
});

test('partial mode, one frame at a time: a delta starts a block only at an index other than the last text block\'s', () => {
  const ctx = { currentTurnId: 't1', partialStreaming: true, streamMessageId: 'msg_A' };
  assert.deepEqual(texts(translateMessage(delta(0, 'a'), ctx)), [['a', true, undefined]]);
  assert.deepEqual(texts(translateMessage(delta(0, 'b'), { ...ctx, streamTextBlockIndex: 0 })), [['b', false, undefined]]);
  assert.deepEqual(texts(translateMessage(delta(1, 'c'), { ...ctx, streamTextBlockIndex: 0 })), [['c', true, undefined]]);
  // Without a numeric index nothing tells a new block from more of the old one, and it is not claimed.
  for (const index of [undefined, '1', null]) {
    assert.deepEqual(texts(translateMessage(delta(index, 'd'), { ...ctx, streamTextBlockIndex: 0 })), [['d', false, undefined]], String(index));
    assert.deepEqual(texts(translateMessage(delta(index, 'd'), ctx)), [['d', false, undefined]], String(index));
  }
  // A delta that continues a block carries no startsBlock key at all, as before the field.
  assert.equal('startsBlock' in translateMessage(delta(0, 'b'), { ...ctx, streamTextBlockIndex: 0 })[0], false);
});

test('partial mode through a session: block starts follow the index, a thinking block between does not count, and each message starts again', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(start('msg_1'));
  controller.emit(delta(0, 'Intro'));
  controller.emit(delta(0, ' line'));
  controller.emit(delta(1, '| a |'));
  controller.emit(delta(1, '\n|---|'));
  controller.emit(thought(2, 'hm'));
  controller.emit(delta(3, 'After'));
  controller.emit(start('msg_2'));
  // The new message counts from 0 again, the index the last text block of msg_1 did not have; a reused
  // index must start a block all the same.
  controller.emit(delta(3, 'Next'));
  controller.emit(delta(3, ' reply'));
  const events = [...(await session.pump()), ...(await session.pump())];
  assert.deepEqual(texts(events), [
    ['Intro', true, undefined],
    [' line', false, undefined],
    ['| a |', true, undefined],
    ['\n|---|', false, undefined],
    ['After', true, undefined],
    ['Next', true, undefined],
    [' reply', false, undefined],
  ]);
  session.close();
});

test('partial mode through a session: after text with no index, the next indexed delta claims no start, and later blocks do', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(start('msg_1'));
  controller.emit(delta(undefined, 'hel'));
  controller.emit(delta(0, 'lo'));
  controller.emit(delta(0, ' there'));
  controller.emit(delta(1, '| a |'));
  const events = await session.pump();
  assert.deepEqual(texts(events), [
    ['hel', false, undefined],
    ['lo', false, undefined],
    [' there', false, undefined],
    ['| a |', true, undefined],
  ]);
  session.close();
});

test('partial mode, one frame at a time: a delta after unindexed text claims no start', () => {
  const ctx = { currentTurnId: 't1', partialStreaming: true, streamMessageId: 'msg_A', streamTextBlockIndex: null };
  assert.deepEqual(texts(translateMessage(delta(0, 'lo'), ctx)), [['lo', false, undefined]]);
  assert.deepEqual(texts(translateMessage(delta(3, 'x'), ctx)), [['x', false, undefined]]);
});

test('partial mode through a session: a subagent\'s stream keeps its own block index', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit(start('msg_main'));
  controller.emit(delta(0, 'main-1'));
  controller.emit(start('msg_sub', 'toolu_task'));
  controller.emit(delta(0, 'sub-1', 'toolu_task'));
  controller.emit(delta(1, 'sub-2', 'toolu_task'));
  controller.emit(delta(0, 'main-2'));
  controller.emit(delta(1, 'main-3'));
  const events = await session.pump();
  assert.deepEqual(texts(events), [
    ['main-1', true, undefined],
    ['sub-1', true, 'toolu_task'],
    ['sub-2', true, 'toolu_task'],
    ['main-2', false, undefined],
    ['main-3', true, undefined],
  ]);
  session.close();
});

test('partial mode, a reply that streamed nothing: its complete text blocks each start a block', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: PARTIAL }, () => query);
  session.sendTurn('hi');
  controller.emit({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Intro' }, { type: 'text', text: '| a |' }] } } as never);
  const events = await session.pump();
  assert.deepEqual(texts(events), [['Intro', true, undefined], ['| a |', true, undefined]]);
  session.close();
});
