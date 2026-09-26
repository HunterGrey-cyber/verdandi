import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { translateEvent, extractTurnId } from '../src/eventTranslation.js';
import { PermissionOutcome, TurnOutcome, SessionCloseReason } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

test('translateEvent: session_ready maps to a sessionReady oneof member', () => {
  const event: ClaudeRuntimeEvent = { type: 'session_ready', sessionId: 's1', providerSessionId: 'p1', model: 'claude-sonnet-5', cwd: '/tmp', permissionMode: 'bypassPermissions' };
  assert.deepEqual(translateEvent(event), {
    sessionReady: { sessionId: 's1', providerSessionId: 'p1', model: 'claude-sonnet-5', cwd: '/tmp', permissionMode: 'bypassPermissions', accountIdentity: undefined, initFingerprint: undefined },
  });
});

/** Asserted on a mode that is NOT the one a bypass caller wanted, because the field's entire job is
 * to be able to say so. A translation that hardcoded "bypassPermissions", or dropped the field and
 * let proto3 default it to "", would pass the happy-path test above and fail this one. */
test('translateEvent: session_ready carries a DOWNGRADED permission mode through unchanged', () => {
  const event: ClaudeRuntimeEvent = { type: 'session_ready', sessionId: 's1', providerSessionId: 'p1', model: 'claude-sonnet-5', cwd: '/tmp', permissionMode: 'default' };
  const out = translateEvent(event) as { sessionReady: { permissionMode: string } };
  assert.equal(out.sessionReady.permissionMode, 'default');
});

test('translateEvent: text_delta maps to a textDelta oneof member', () => {
  const event: ClaudeRuntimeEvent = { type: 'text_delta', turnId: 't1', text: 'hi' };
  assert.deepEqual(translateEvent(event), { textDelta: { turnId: 't1', text: 'hi' } });
});

test('translateEvent: tool_call_started serializes input as JSON', () => {
  const event: ClaudeRuntimeEvent = { type: 'tool_call_started', turnId: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'echo hi' } };
  const result = translateEvent(event) as { toolCallStarted: { inputJson: string } };
  assert.deepEqual(JSON.parse(result.toolCallStarted.inputJson), { command: 'echo hi' });
});

test('translateEvent: tool_call_completed serializes content as JSON and preserves isError', () => {
  const event: ClaudeRuntimeEvent = { type: 'tool_call_completed', turnId: 't1', toolUseId: 'tu1', content: 'denied', isError: true };
  const result = translateEvent(event) as { toolCallCompleted: { contentJson: string; isError: boolean } };
  assert.equal(JSON.parse(result.toolCallCompleted.contentJson), 'denied');
  assert.equal(result.toolCallCompleted.isError, true);
});

test('translateEvent: permission_resolved maps PermissionOutcome variants correctly, including expired', () => {
  const event: ClaudeRuntimeEvent = { type: 'permission_resolved', permissionId: 'perm1', outcome: 'expired' };
  assert.deepEqual(translateEvent(event), {
    permissionResolved: { permissionId: 'perm1', outcome: PermissionOutcome.PERMISSION_OUTCOME_EXPIRED },
  });
});

test('translateEvent: turn_completed maps TurnOutcome variants correctly, including limit_reached', () => {
  const event: ClaudeRuntimeEvent = { type: 'turn_completed', turnId: 't1', outcome: 'limit_reached', resultText: '', isError: false, stopReason: null };
  assert.deepEqual(translateEvent(event), {
    turnCompleted: {
      turnId: 't1',
      outcome: TurnOutcome.TURN_OUTCOME_LIMIT_REACHED,
      resultText: '',
      isError: false,
      stopReason: undefined,
      structuredOutputJson: undefined,
      resultSubtype: undefined,
      terminalReason: undefined,
      apiErrorStatus: undefined,
      errors: [],
      usage: undefined,
    },
  });
});

test('translateEvent: session_closed maps SessionCloseReason variants correctly, including provider_failed', () => {
  const event: ClaudeRuntimeEvent = { type: 'session_closed', reason: 'provider_failed' };
  assert.deepEqual(translateEvent(event), {
    sessionClosed: { reason: SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_FAILED },
  });
});

test('translateEvent: provider_notice from the kernel maps to a providerNotice oneof member with kind/subtype only, no raw payload', () => {
  const event: ClaudeRuntimeEvent = { type: 'provider_notice', kind: 'assistant', subtype: 'no_turn_in_progress', raw: { anything: 'sensitive-looking' } };
  const result = translateEvent(event) as { providerNotice: { kind: string; subtype?: string } };
  assert.deepEqual(result.providerNotice, { kind: 'assistant', subtype: 'no_turn_in_progress' });
  assert.equal('raw' in result.providerNotice, false);
});

test('translateEvent: an event type this function does not recognize produces a providerNotice fallback, never throws', () => {
  const event = { type: 'some_future_kernel_event_type', foo: 'bar' } as unknown as ClaudeRuntimeEvent;
  const result = translateEvent(event) as { providerNotice: { kind: string; subtype?: string } };
  assert.equal(result.providerNotice.kind, 'some_future_kernel_event_type');
});

test('extractTurnId: returns the turnId for every kernel event variant that carries one', () => {
  assert.equal(extractTurnId({ type: 'turn_started', turnId: 't1' } as never), 't1');
  assert.equal(extractTurnId({ type: 'text_delta', turnId: 't1', text: 'x' } as never), 't1');
  assert.equal(extractTurnId({ type: 'turn_completed', turnId: 't1', outcome: 'completed', resultText: '', isError: false, stopReason: null } as never), 't1');
});

test('extractTurnId: returns undefined for kernel event variants that do not carry a turnId', () => {
  assert.equal(extractTurnId({ type: 'session_ready', sessionId: 's1', providerSessionId: 's1', model: 'm', cwd: '/tmp' } as never), undefined);
  assert.equal(extractTurnId({ type: 'session_closed', reason: 'closed_by_host' } as never), undefined);
  assert.equal(extractTurnId({ type: 'permission_requested', permissionId: 'p1', toolUseId: 'tu1', toolName: 'Bash', input: {} } as never), undefined);
});
