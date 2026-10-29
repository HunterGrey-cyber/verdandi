import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { ClaudeRuntimeEvent } from '../src/types.js';
import { buildSessionOptions } from '../src/session.js';
import { turnFrameOf } from '../src/eventTranslation.js';
import { TurnTracker } from '../src/turnTracker.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { drive } from './replay/drive.js';
import type { Line, Wire } from './replay/recording.js';

const host = (uuid: string): Line => ({ from: 'host', message: { type: 'user', uuid, message: { content: 'work' } } });
const cli = (message: Wire): Line => ({ from: 'cli', message });
const call = (id: string, name = 'Agent') => ({ type: 'tool_use', id, name, input: {} });
const assistant = (content: Wire[], parent: string | null = null): Line => cli({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'message', content } });
const completed = (id: string, parent: string | null): Line => cli({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } });
const result = (uuid: string): Line => cli({ type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', user_message_uuid: uuid });
const isChildContent = (event: ClaudeRuntimeEvent) => 'parentToolUseId' in event;
const starts = (events: ClaudeRuntimeEvent[]) => events.filter(event => event.type === 'turn_started');

test('background child output keeps its parent turn after that turn ended and while another turn runs', async () => {
  const replay = await drive([
    host('root'), assistant([call('agent')]), result('root'),
    assistant([call('read', 'Read'), { type: 'text', text: 'child text' }, { type: 'thinking', thinking: 'child thought' }], 'agent'),
    completed('read', 'agent'),
    cli({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'message_start', message: { id: 'background-stream' } } }),
    cli({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late text' } } }),
    cli({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'late thought' } } }),
    host('next'), assistant([call('bash', 'Bash')], 'agent'), completed('bash', 'agent'), result('next'),
  ], tmpdir());
  const turns = starts(replay.events);
  assert.equal(turns.length, 2);
  const children = replay.events.filter(isChildContent);
  assert.equal(children.length, 8);
  for (const event of children) {
    assert.ok('turnId' in event && 'parentToolUseId' in event);
    assert.equal(event.turnId, turns[0].turnId);
    assert.equal(event.parentToolUseId, 'agent');
  }
  assert.deepEqual(replay.steps[3].events.map(e => e.type), ['tool_call_started', 'text_delta', 'thinking_delta']);
  assert.deepEqual(replay.events.filter(e => e.type === 'provider_notice'), []);
});

test('foreground Read and Bash, nested agents and interleaved main output keep their own parent and turn', async () => {
  const replay = await drive([
    host('root'), assistant([call('agent', 'Task')]),
    assistant([call('read', 'Read')], 'agent'), completed('read', 'agent'),
    assistant([{ type: 'text', text: 'main before' }]),
    assistant([call('foreground-bash', 'Bash')], 'agent'), completed('foreground-bash', 'agent'),
    assistant([call('nested')], 'agent'), result('root'),
    host('next'), assistant([call('bash', 'Bash')], 'nested'), completed('bash', 'nested'),
    assistant([{ type: 'text', text: 'main after' }, call('main-read', 'Read')]), result('next'),
  ], tmpdir());
  const [root, next] = starts(replay.events);
  assert.deepEqual(replay.events.flatMap(e => e.type === 'tool_call_started' || e.type === 'tool_call_completed' ? [[e.toolUseId, e.parentToolUseId, e.turnId]] : []), [
    ['agent', undefined, root.turnId], ['read', 'agent', root.turnId], ['read', 'agent', root.turnId],
    ['foreground-bash', 'agent', root.turnId], ['foreground-bash', 'agent', root.turnId],
    ['nested', 'agent', root.turnId], ['bash', 'nested', root.turnId], ['bash', 'nested', root.turnId],
    ['main-read', undefined, next.turnId],
  ]);
  assert.deepEqual(replay.events.flatMap(e => e.type === 'text_delta' ? [[e.text, e.parentToolUseId, e.turnId]] : []), [
    ['main before', undefined, root.turnId], ['main after', undefined, next.turnId],
  ]);
});

for (const open of [false, true]) {
  test(`unknown parent with ${open ? 'an open turn' : 'no open turn'} preserves content with the fallback turn`, async () => {
    const stream = (delta: Wire) => cli({ type: 'stream_event', parent_tool_use_id: 'workflow-agent', event: { type: 'content_block_delta', delta } });
    const replay = await drive([
      ...(open ? [host('root')] : []),
      assistant([call('read', 'Read'), { type: 'text', text: 'complete' }, { type: 'thinking', thinking: 'thought' }], 'workflow-agent'),
      cli({ type: 'stream_event', parent_tool_use_id: 'workflow-agent', event: { type: 'message_start', message: { id: 'child-stream' } } }),
      stream({ type: 'text_delta', text: 'streamed text' }), stream({ type: 'thinking_delta', thinking: 'streamed thought' }),
      completed('read', 'workflow-agent'),
      ...(open ? [result('root')] : []),
    ], tmpdir());
    const turns = starts(replay.events);
    assert.equal(turns.length, open ? 1 : 0);
    const content = replay.events.filter(isChildContent);
    assert.equal(content.length, 6);
    for (const event of content) {
      assert.ok('turnId' in event && 'parentToolUseId' in event);
      assert.equal(event.parentToolUseId, 'workflow-agent');
      assert.equal(event.turnId, open ? turns[0].turnId : '');
    }
    assert.deepEqual(content.flatMap(e => (e.type === 'text_delta' || e.type === 'thinking_delta') && e.messageId === 'child-stream' ? [e.text] : []), ['streamed text', 'streamed thought']);
    assert.deepEqual(replay.events.filter(e => e.type === 'provider_notice'), []);
  });
}

test('a child reply streamed in full is not repeated by its complete message, and another stream\'s id never suppresses it', async () => {
  const stream = (parent: string | null, event: Wire) => cli({ type: 'stream_event', parent_tool_use_id: parent, event });
  const delta = (parent: string | null, delta: Wire) => stream(parent, { type: 'content_block_delta', delta });
  const complete = (parent: string | null, id: string, text: string, thinking: string) =>
    cli({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'thinking', thinking }, { type: 'text', text }] } });
  const replay = await drive([
    host('root'), assistant([call('agent'), call('other')]),
    // The child streams M in full, then sends M complete: its text and thinking arrive once.
    stream('agent', { type: 'message_start', message: { id: 'M' } }),
    delta('agent', { type: 'thinking_delta', thinking: 'hm' }), delta('agent', { type: 'text_delta', text: 'hello' }),
    complete('agent', 'M', 'hello', 'hm'),
    // The main thread streams N; a different child's complete message with that same id was never
    // streamed on its own stream, so it is delivered whole.
    stream(null, { type: 'message_start', message: { id: 'N' } }), delta(null, { type: 'text_delta', text: 'main' }),
    complete('other', 'N', 'other text', 'other thought'),
    // A later reply of the first child that was not streamed is delivered whole too.
    complete('agent', 'M2', 'second', 'again'),
    result('root'),
  ], tmpdir());
  const texts = (parent: string) => replay.events.flatMap(e => (e.type === 'text_delta' || e.type === 'thinking_delta') && e.parentToolUseId === parent ? [`${e.type}:${e.text}`] : []);
  assert.deepEqual(texts('agent'), ['thinking_delta:hm', 'text_delta:hello', 'thinking_delta:again', 'text_delta:second']);
  assert.deepEqual(texts('other'), ['thinking_delta:other thought', 'text_delta:other text']);
});

test('the 1025th parent call evicts only the oldest entry; completed parents remain and ordinary tools are not parents', async () => {
  const replay = await drive([
    host('root'), assistant(Array.from({ length: 1024 }, (_, i) => call(`agent-${i}`, i % 2 ? 'Task' : 'Agent'))),
    completed('agent-1', null), assistant([call('ordinary', 'Bash'), call('agent-1024')]), result('root'),
    assistant([call('oldest', 'Read')], 'agent-0'),
    assistant([call('retained', 'Read')], 'agent-1'),
    assistant([call('newest', 'Read')], 'agent-1024'),
    host('next'), assistant([call('evicted-open', 'Read')], 'agent-0'),
    assistant([call('retained-open', 'Read')], 'agent-1'),
    assistant([call('ordinary-child', 'Read')], 'ordinary'), result('next'),
  ], tmpdir());
  const [root, next] = starts(replay.events);
  assert.deepEqual(replay.events.flatMap(e => e.type === 'tool_call_started' && e.parentToolUseId !== undefined ? [[e.toolUseId, e.turnId]] : []), [
    ['oldest', ''], ['retained', root.turnId], ['newest', root.turnId],
    ['evicted-open', next.turnId], ['retained-open', root.turnId], ['ordinary-child', next.turnId],
  ]);
});

test('child control frames cannot open, close or settle the main turn', async () => {
  const controls = [
    { type: 'result', subtype: 'success', result: 'child result', is_error: false, user_message_uuid: 'root' },
    { type: 'command_lifecycle', command_uuid: 'root', state: 'discarded' },
    { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    { type: 'system', subtype: 'status', status: 'requesting' },
    { type: 'user', uuid: 'root', message: { content: 'echo' } },
  ].map(message => ({ ...message, parent_tool_use_id: 'agent' }));
  const tracker = new TurnTracker(() => 'unexpected');
  for (const message of controls) {
    const frame = turnFrameOf(message as SDKMessage);
    assert.deepEqual(frame, { kind: 'other' });
    assert.deepEqual(tracker.frame(frame, { lifecycleReported: true }).before, []);
    assert.equal(tracker.open, undefined);
  }
  const replay = await drive([
    host('root'), cli({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] }),
    ...controls.map(cli), assistant([{ type: 'text', text: 'still open' }]), result('root'),
    ...controls.map(cli),
  ], tmpdir());
  assert.equal(starts(replay.events).length, 1);
  assert.equal(replay.events.filter(e => e.type === 'turn_completed').length, 1);
  assert.ok(replay.steps.at(-controls.length - 1)!.events.some(e => e.type === 'turn_completed'));
  for (const step of replay.steps.filter(s => s.line.message.parent_tool_use_id)) assert.deepEqual(step.events, []);
});

test('subagent text forwarding stays at the SDK default', () => {
  const options = buildSessionOptions({ cwd: tmpdir(), policy: {
    configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled', streaming: 'partial',
  } });
  assert.equal(Object.hasOwn(options, 'forwardSubagentText'), false);
});
