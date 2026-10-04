import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountBinding,
  EgressProbe,
  HandshakeResponse,
  SessionEvent,
  ErrorCode,
  PermissionOutcome,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

test('generated types: HandshakeResponse can be constructed and encoded/decoded round-trip', () => {
  const original: HandshakeResponse = {
    protocolMajor: 1,
    protocolMinor: 0,
    sidecarVersion: '0.1.0',
    claudeAgentSdkVersion: '0.3.0',
    sdkDeclaredClaudeCodeVersion: 'unknown',
    actualClaudeCodeVersion: 'unknown',
    capabilities: ['send_turn'],
    configurationProfiles: ['native'],
    permissionModes: ['interactive'],
    maxMessageBytes: BigInt(4 * 1024 * 1024),
    eventBufferPolicy: 'bounded-1000',
    accountBinding: AccountBinding.ACCOUNT_BINDING_PINNED,
    accountName: 'work',
    accountConfigDir: '/home/probe/.claude-work',
    egressProbe: EgressProbe.EGRESS_PROBE_LOOPBACK_BLOCKED,
    structuredOutputTools: ['StructuredOutput'],
  };

  const bytes = HandshakeResponse.encode(original).finish();
  const decoded = HandshakeResponse.decode(bytes);

  assert.equal(decoded.sidecarVersion, '0.1.0');
  assert.deepEqual(decoded.capabilities, ['send_turn']);
  assert.equal(decoded.accountBinding, AccountBinding.ACCOUNT_BINDING_PINNED);
  assert.equal(decoded.accountName, 'work');
  assert.equal(decoded.accountConfigDir, '/home/probe/.claude-work');
  assert.equal(decoded.egressProbe, EgressProbe.EGRESS_PROBE_LOOPBACK_BLOCKED);
  assert.deepEqual(decoded.structuredOutputTools, ['StructuredOutput']);
});

test('generated types: ErrorCode and PermissionOutcome enums have UNSPECIFIED as their zero value', () => {
  assert.equal(ErrorCode.ERROR_CODE_UNSPECIFIED, 0);
  assert.equal(PermissionOutcome.PERMISSION_OUTCOME_UNSPECIFIED, 0);
});

test('generated types: SessionEvent can carry a TurnStarted oneof member and encode/decode round-trip', () => {
  const original: SessionEvent = {
    sessionId: 's1',
    sequence: BigInt(1),
    occurredAt: BigInt(0),
    turnId: 't1',
    turnStarted: { turnId: 't1' },
  };

  const bytes = SessionEvent.encode(original).finish();
  const decoded = SessionEvent.decode(bytes);

  assert.equal(decoded.sessionId, 's1');
  assert.deepEqual(decoded.turnStarted, { turnId: 't1' });
  assert.equal(decoded.textDelta, undefined);
});
