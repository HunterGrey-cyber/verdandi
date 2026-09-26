import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translateMessage } from '../src/eventTranslation.js';

test('translateMessage: a system init message becomes session_ready', () => {
  const message = {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
    permissionMode: 'bypassPermissions',
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: undefined });
  assert.deepEqual(events, [
    {
      type: 'session_ready',
      sessionId: 'sess-1',
      providerSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      cwd: '/tmp/project',
      permissionMode: 'bypassPermissions',
    },
  ]);
});

/**
 * The mode is carried because it is the only place the EFFECTIVE one is ever stated -- what the
 * caller asked for lives in ClaudeHostPolicy and cannot contradict itself. Asserted against a value
 * that is NOT what a bypass caller wanted, since the whole point is to be able to tell the
 * difference; a translation that hardcoded or dropped this field would pass a bypassPermissions-only
 * test.
 *
 * Why it matters that this is reported rather than inferred, measured 2026-09-18 on CLI 2.1.272: a
 * session downgraded to `default` still executed routine Bash without complaint, because the host's
 * own auto-mode allowlist approved it. Nothing observable about the session's behaviour said it was
 * running weaker than requested. This string did.
 */
test('translateMessage: session_ready reports a permission mode that is NOT the requested one', () => {
  const message = {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-2',
    model: 'claude-sonnet-5',
    cwd: '/tmp/project',
    permissionMode: 'default',
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: undefined });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session_ready');
  assert.equal((events[0] as { permissionMode: string }).permissionMode, 'default');
});

test('translateMessage: an assistant message with text and tool_use blocks produces both events, in order', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'checking now' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
      ],
    },
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: 'turn-1' });
  assert.deepEqual(events, [
    { type: 'text_delta', turnId: 'turn-1', text: 'checking now' },
    { type: 'tool_call_started', turnId: 'turn-1', toolUseId: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
  ]);
});

test('translateMessage: a thinking block becomes thinking_delta', () => {
  const message = {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'considering options' }] },
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: 'turn-1' });
  assert.deepEqual(events, [{ type: 'thinking_delta', turnId: 'turn-1', text: 'considering options' }]);
});

test('translateMessage: a user tool_result block becomes tool_call_completed, defaulting isError to false', () => {
  const message = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi\n' }] },
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: 'turn-1' });
  assert.deepEqual(events, [{ type: 'tool_call_completed', turnId: 'turn-1', toolUseId: 'toolu_1', content: 'hi\n', isError: false }]);
});

test('translateMessage: a user tool_result block with is_error true is preserved', () => {
  const message = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'denied', is_error: true }] },
  } as unknown as SDKMessage;

  const events = translateMessage(message, { currentTurnId: 'turn-1' });
  assert.deepEqual(events, [{ type: 'tool_call_completed', turnId: 'turn-1', toolUseId: 'toolu_1', content: 'denied', isError: true }]);
});

test('translateMessage: an unrecognized top-level message type produces exactly one provider_notice, never zero, never a throw', () => {
  const message = { type: 'some_future_message_type', foo: 'bar' } as unknown as SDKMessage;
  const events = translateMessage(message, { currentTurnId: undefined });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_notice');
});

test('translateMessage: an assistant message with no turn in progress produces a provider_notice instead of throwing', () => {
  const message = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as unknown as SDKMessage;
  const events = translateMessage(message, { currentTurnId: undefined });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_notice');
});

// --- partial streaming (2026-09-12) --------------------------------------------------------------

// The ordinary partial-streaming case: partials requested AND the deltas actually arrived. Spelled
// out rather than left to a default, because `streamedSinceLastAssistant` absent now MEANS "nothing
// streamed", which is a different case with a different correct answer (see the 2026-09-18 block at
// the bottom of this file).
const PARTIAL_CTX = { currentTurnId: 't1', partialStreaming: true, streamedSinceLastAssistant: true };
const COMPLETE_CTX = { currentTurnId: 't1', partialStreaming: false };

function streamEvent(delta: unknown): SDKMessage {
  return { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta } } as never;
}

test('partial streaming: a text content_block_delta becomes one text_delta', () => {
  assert.deepEqual(translateMessage(streamEvent({ type: 'text_delta', text: 'Hel' }), PARTIAL_CTX), [
    { type: 'text_delta', turnId: 't1', text: 'Hel' },
  ]);
});

test('partial streaming: a thinking delta becomes thinking_delta', () => {
  assert.deepEqual(translateMessage(streamEvent({ type: 'thinking_delta', thinking: 'hmm' }), PARTIAL_CTX), [
    { type: 'thinking_delta', turnId: 't1', text: 'hmm' },
  ]);
});

test('partial streaming: framing and tool-input events produce nothing', () => {
  // message_start / content_block_start / stop / message_delta carry no produced content, and
  // input_json_delta is a tool's arguments being assembled -- the complete, parseable input arrives
  // on the assistant message's tool_use block, so emitting a half-built object here would be worse
  // than emitting nothing.
  for (const framing of ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']) {
    assert.deepEqual(translateMessage({ type: 'stream_event', event: { type: framing } } as never, PARTIAL_CTX), []);
  }
  assert.deepEqual(translateMessage(streamEvent({ type: 'input_json_delta', partial_json: '{"a' }), PARTIAL_CTX), []);
});

test('partial streaming: stream events are ignored entirely when partials were not requested', () => {
  assert.deepEqual(translateMessage(streamEvent({ type: 'text_delta', text: 'x' }), COMPLETE_CTX), []);
});

test('partial streaming: the completed assistant message no longer re-emits text the deltas already carried', () => {
  // THE duplication hazard. With partials on the SDK sends both the deltas and, at the end, the
  // whole assistant message carrying the same characters; translating both doubles every reply.
  const assistant = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello there' },
        { type: 'thinking', thinking: 'pondering' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
      ],
    },
  } as never;
  // Tool calls still come from the assistant message -- their complete input JSON is only reliable
  // there -- so exactly one event survives, and it is the tool call.
  assert.deepEqual(translateMessage(assistant, PARTIAL_CTX), [
    { type: 'tool_call_started', turnId: 't1', toolUseId: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
  ]);
  // Without partials the same message is the ONLY source of that text, so all three survive.
  assert.equal(translateMessage(assistant, COMPLETE_CTX).length, 3);
});

test('partial streaming: a stream event with no turn in flight is dropped, never mis-attributed', () => {
  assert.deepEqual(
    translateMessage(streamEvent({ type: 'text_delta', text: 'x' }), { currentTurnId: undefined, partialStreaming: true }),
    [],
  );
});

// --- partial streaming that never arrived (2026-09-18) -------------------------------------------
//
// The suppression above rests on an assumption nobody checks: that the deltas really came. Under
// `includePartialMessages` the SDK is SUPPOSED to send them, but "supposed to" is a property of a
// CLI version, not of this code. A CLI that accepts the option and emits no `stream_event` -- which
// is exactly the shape of a silent version skew, and what this sidecar's own startup diagnostic
// warns about first -- turns the suppression into total loss: the turn completes successfully, the
// permission round trip works, and the assistant's reply is empty with nothing reporting a problem.
//
// Written on 2026-09-18 against a downstream report of exactly that symptom on CLI 2.1.272 -- an
// attribution its reporter RETRACTED the same day, having dumped the event sequence: the cause was
// their own test answering one permission request while 2.1.272, which defers tools, raised a
// second. These cases therefore pin a hazard, not a reproduction. No CLI is known to accept
// includePartialMessages and emit no stream_event; the guard is kept for the direction it fails in.
//
// So suppression becomes conditional on the replacement having actually arrived. It cannot double,
// because it fires only when zero deltas were seen for this message.

test('partial streaming: an assistant message whose deltas never arrived still yields its text', () => {
  const assistant = {
    type: 'assistant',
    message: { message: { content: [{ type: 'text', text: 'Hello there' }] }, content: [{ type: 'text', text: 'Hello there' }] },
  } as never;
  assert.deepEqual(translateMessage(assistant, { currentTurnId: 't1', partialStreaming: true, streamedSinceLastAssistant: false }), [
    { type: 'text_delta', turnId: 't1', text: 'Hello there' },
  ]);
});

test('partial streaming: thinking is recovered on the same terms as text', () => {
  const assistant = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } } as never;
  assert.deepEqual(translateMessage(assistant, { currentTurnId: 't1', partialStreaming: true, streamedSinceLastAssistant: false }), [
    { type: 'thinking_delta', turnId: 't1', text: 'pondering' },
  ]);
});

/** The half that keeps the fallback from becoming the duplication bug it replaced. */
test('partial streaming: text is still suppressed when the deltas did arrive', () => {
  const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } } as never;
  assert.deepEqual(translateMessage(assistant, { currentTurnId: 't1', partialStreaming: true, streamedSinceLastAssistant: true }), []);
});
