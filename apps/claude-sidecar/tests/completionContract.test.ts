import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import {
  buildKernelSessionConfig,
  createRuntimeServiceImpl,
  parseOutputSchema,
  validateOutputFormat,
  validateSystemPrompt,
} from '../src/runtimeServiceImpl.js';
import { makeFakeSession } from './fakeSession.js';
import type { ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { translateEvent } from '../src/eventTranslation.js';
import { AccountBinding, SessionCloseReason, SessionEvent, TurnOutcome } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/** Encodes a translated kernel event as the wire SessionEvent and decodes it back -- what a client
 * actually receives. Catches what a deepEqual on translateEvent's output cannot: an encoder crash on
 * a missing repeated field, or a value the wire type cannot carry. */
function overTheWire(event: ClaudeRuntimeEvent): SessionEvent {
  const full = SessionEvent.fromPartial({ sessionId: 's1', sequence: 1n, occurredAt: 0n, ...translateEvent(event) });
  return SessionEvent.decode(SessionEvent.encode(full).finish());
}

/**
 * The sidecar half of the consumer spec §6.3 P2 runtime contract: request validation and mapping for
 * the new CreateSession fields, and the new event fields on the way out. Each later P2 task appends
 * its own tests here; the pinned capability list stays in runtimeServiceImpl.test.ts.
 */

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

test('validateSystemPrompt: absent and non-blank are accepted; blank is refused', () => {
  assert.doesNotThrow(() => validateSystemPrompt({ cwd: '/tmp/p', policy: undefined }));
  assert.doesNotThrow(() => validateSystemPrompt({ cwd: '/tmp/p', policy: undefined, systemPrompt: 'You are the editor.' }));
  for (const blank of ['', '   ', '\n\t']) {
    assert.throws(
      () => validateSystemPrompt({ cwd: '/tmp/p', policy: undefined, systemPrompt: blank }),
      /system_prompt was set but is blank/,
      JSON.stringify(blank),
    );
  }
});

test('createSession refuses a blank system_prompt with invalid_configuration before the session factory runs', async () => {
  let factoryCalls = 0;
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    () => {
      factoryCalls += 1;
      return makeFakeSession().session;
    },
    VERSIONS,
  );
  await assert.rejects(
    () => callResult(impl.createSession.bind(impl), { cwd: '/tmp', policy: undefined, systemPrompt: '' }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      return true;
    },
  );
  assert.equal(factoryCalls, 0, 'no session may exist for a request that cannot be honoured');
});

test('CreateSession system_prompt reaches the kernel config verbatim; absent stays absent', () => {
  const withPrompt = buildKernelSessionConfig({ cwd: '/tmp/p', policy: undefined, systemPrompt: 'You are the editor.' });
  assert.equal(withPrompt.systemPrompt, 'You are the editor.');
  assert.equal('systemPrompt' in buildKernelSessionConfig({ cwd: '/tmp/p', policy: undefined }), false);
});

test('parseOutputSchema: a JSON object is the schema; anything else is invalid_configuration', () => {
  assert.deepEqual(parseOutputSchema({ jsonSchemaJson: '{"type":"object","required":["a"]}' }), { type: 'object', required: ['a'] });
  for (const [text, why] of [
    ['', /not valid JSON/],
    ['{"type":', /not valid JSON/],
    ['[]', /must be a JSON object .* got an array/],
    ['null', /got null/],
    ['"object"', /got string/],
    ['42', /got number/],
  ] as const) {
    assert.throws(() => parseOutputSchema({ jsonSchemaJson: text }), why, JSON.stringify(text));
  }
});

test('validateOutputFormat: absent is accepted; an unusable schema is refused', () => {
  assert.doesNotThrow(() => validateOutputFormat({ cwd: '/tmp/p', policy: undefined }));
  assert.doesNotThrow(() => validateOutputFormat({ cwd: '/tmp/p', policy: undefined, outputFormat: { jsonSchemaJson: '{}' } }));
  assert.throws(() => validateOutputFormat({ cwd: '/tmp/p', policy: undefined, outputFormat: { jsonSchemaJson: '' } }), /not valid JSON/);
});

test('createSession refuses an unusable output_format with invalid_configuration before the session factory runs', async () => {
  let factoryCalls = 0;
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    () => {
      factoryCalls += 1;
      return makeFakeSession().session;
    },
    VERSIONS,
  );
  await assert.rejects(
    () => callResult(impl.createSession.bind(impl), { cwd: '/tmp', policy: undefined, outputFormat: { jsonSchemaJson: '[1,2]' } }),
    (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      return true;
    },
  );
  assert.equal(factoryCalls, 0);
});

test('CreateSession output_format reaches the kernel config as the SDK json_schema shape; absent stays absent', () => {
  const config = buildKernelSessionConfig({
    cwd: '/tmp/p',
    policy: undefined,
    outputFormat: { jsonSchemaJson: '{"type":"object","properties":{"answer":{"type":"string"}}}' },
  });
  assert.deepEqual(config.outputFormat, { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } });
  assert.equal('outputFormat' in buildKernelSessionConfig({ cwd: '/tmp/p', policy: undefined }), false);
});

test('turn_completed: structured output and result detail survive the wire', () => {
  const wire = overTheWire({
    type: 'turn_completed',
    turnId: 't1',
    outcome: 'completed',
    resultText: '',
    isError: false,
    stopReason: 'tool_use',
    resultSubtype: 'success',
    terminalReason: 'completed',
    structuredOutput: { scores: [{ id: 'c001', score: 70 }], picks: [], events: [], weekly: [] },
  });
  const completed = wire.turnCompleted;
  assert.ok(completed);
  assert.equal(completed.outcome, TurnOutcome.TURN_OUTCOME_COMPLETED);
  assert.deepEqual(JSON.parse(completed.structuredOutputJson ?? 'undefined'), { scores: [{ id: 'c001', score: 70 }], picks: [], events: [], weekly: [] });
  assert.equal(completed.resultSubtype, 'success');
  assert.equal(completed.terminalReason, 'completed');
  assert.equal(completed.apiErrorStatus, undefined);
  assert.deepEqual(completed.errors, []);
});

test('turn_completed: a failed turn carries its subtype, API status and errors, and no structured output', () => {
  const completed = overTheWire({
    type: 'turn_completed',
    turnId: 't1',
    outcome: 'failed',
    resultText: '',
    isError: true,
    stopReason: null,
    resultSubtype: 'error_max_structured_output_retries',
    terminalReason: 'structured_output_retry_exhausted',
    apiErrorStatus: 429,
    errors: ['gave up'],
  }).turnCompleted;
  assert.ok(completed);
  assert.equal(completed.structuredOutputJson, undefined);
  assert.equal(completed.resultSubtype, 'error_max_structured_output_retries');
  assert.equal(completed.terminalReason, 'structured_output_retry_exhausted');
  assert.equal(completed.apiErrorStatus, 429);
  assert.deepEqual(completed.errors, ['gave up']);
});

test('turn_completed: a synthesized turn (no result message) encodes with every detail field absent', () => {
  const completed = overTheWire({ type: 'turn_completed', turnId: 't1', outcome: 'failed', resultText: '', isError: true, stopReason: null }).turnCompleted;
  assert.ok(completed);
  assert.equal(completed.structuredOutputJson, undefined);
  assert.equal(completed.resultSubtype, undefined);
  assert.equal(completed.terminalReason, undefined);
  assert.equal(completed.apiErrorStatus, undefined);
  assert.deepEqual(completed.errors, []);
});

test('turn_completed: a present null structured output is data, not absence', () => {
  const completed = overTheWire({ type: 'turn_completed', turnId: 't1', outcome: 'completed', resultText: '', isError: false, stopReason: null, structuredOutput: null }).turnCompleted;
  assert.equal(completed?.structuredOutputJson, 'null');
});

test('turn_completed: usage survives the wire as uint64 token counts, with the cost and the model', () => {
  const completed = overTheWire({
    type: 'turn_completed',
    turnId: 't1',
    outcome: 'completed',
    resultText: '',
    isError: false,
    stopReason: null,
    usage: { inputTokens: 2, outputTokens: 900, cacheCreationInputTokens: 11_000, cacheReadInputTokens: 23_128, totalCostUsd: 0.0612, model: 'claude-sonnet-5' },
  }).turnCompleted;
  assert.deepEqual(completed?.usage, {
    inputTokens: 2n,
    outputTokens: 900n,
    cacheCreationInputTokens: 11_000n,
    cacheReadInputTokens: 23_128n,
    totalCostUsd: 0.0612,
    model: 'claude-sonnet-5',
  });
});

test('turn_completed: no usage stays absent on the wire, never a zero-filled message', () => {
  const completed = overTheWire({ type: 'turn_completed', turnId: 't1', outcome: 'failed', resultText: '', isError: true, stopReason: null }).turnCompleted;
  assert.equal(completed?.usage, undefined);
});

type HandshakeAccount = { accountBinding: AccountBinding; accountName: string; accountConfigDir: string };

test('handshake reports the pinned account name and config dir', async () => {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, VERSIONS, {
    account: { name: 'work', configDir: '/home/probe/.claude-work' },
  });
  const res = await callResult<HandshakeAccount>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.equal(res.accountBinding, AccountBinding.ACCOUNT_BINDING_PINNED);
  assert.equal(res.accountName, 'work');
  assert.equal(res.accountConfigDir, '/home/probe/.claude-work');
});

test('handshake says UNPINNED -- explicitly, not by omission -- when no account is pinned', async () => {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, VERSIONS);
  const res = await callResult<HandshakeAccount>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.equal(res.accountBinding, AccountBinding.ACCOUNT_BINDING_UNPINNED);
  assert.equal(res.accountName, '');
  assert.equal(res.accountConfigDir, '');
});

const READY = { type: 'session_ready', sessionId: 's1', providerSessionId: 'p1', model: 'claude-sonnet-5', cwd: '/tmp', permissionMode: 'bypassPermissions' } as const;

test('session_ready: an answered account identity survives the wire, with null fields left absent', () => {
  const ready = overTheWire({
    ...READY,
    accountIdentity: { status: 'answered', email: 'work@example.invalid', organization: null, subscriptionType: 'pro', tokenSource: 'claude.ai' },
  }).sessionReady;
  const identity = ready?.accountIdentity;
  assert.ok(identity);
  assert.equal(identity.email, 'work@example.invalid');
  assert.equal(identity.subscriptionType, 'pro');
  assert.equal(identity.tokenSource, 'claude.ai');
  assert.equal(identity.organization, undefined);
  assert.equal(identity.error, undefined);
});

test('session_ready: an unavailable identity carries only its error', () => {
  const ready = overTheWire({ ...READY, accountIdentity: { status: 'unavailable', error: 'accountInfo() did not answer within 20000ms' } }).sessionReady;
  const identity = ready?.accountIdentity;
  assert.ok(identity);
  assert.equal(identity.error, 'accountInfo() did not answer within 20000ms');
  assert.equal(identity.email, undefined);
});

test('session_ready: no probe means no account_identity on the wire -- absent, never an empty "all clear"', () => {
  assert.equal(overTheWire({ ...READY }).sessionReady?.accountIdentity, undefined);
});

test('session_ready: the init fingerprint survives the wire verbatim', () => {
  const ready = overTheWire({
    ...READY,
    initFingerprint: { tools: ['StructuredOutput'], mcpServers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }], apiKeySource: 'none' },
  }).sessionReady;
  assert.deepEqual(ready?.initFingerprint, { tools: ['StructuredOutput'], mcpServers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }], apiKeySource: 'none' });
});

test('session_ready: an init with an EMPTY tools list is still a present fingerprint, distinct from none', () => {
  const empty = overTheWire({ ...READY, initFingerprint: { tools: [], mcpServers: [], apiKeySource: null } }).sessionReady;
  assert.deepEqual(empty?.initFingerprint, { tools: [], mcpServers: [], apiKeySource: '' });
  assert.equal(overTheWire({ ...READY }).sessionReady?.initFingerprint, undefined);
});

test('session_closed: tool_policy_violation has its own wire reason', () => {
  assert.equal(
    overTheWire({ type: 'session_closed', reason: 'tool_policy_violation' }).sessionClosed?.reason,
    SessionCloseReason.SESSION_CLOSE_REASON_TOOL_POLICY_VIOLATION,
  );
});
