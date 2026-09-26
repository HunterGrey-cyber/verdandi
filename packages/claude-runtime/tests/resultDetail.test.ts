import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { m1FailureResultKeys, readM1Fixture } from './m1FixtureFiles.js';
import { createSession } from '../src/session.js';
import { MAX_RESULT_ERRORS, MAX_RESULT_ERROR_CHARS, boundErrors, resultDetail } from '../src/resultDetail.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';

type Result = Extract<SDKMessage, { type: 'result' }>;
const asResult = (value: unknown): Result => value as Result;

test('resultDetail: an error result carries its subtype, terminal reason and errors; nothing is invented', () => {
  const detail = resultDetail(asResult({
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    is_error: true,
    terminal_reason: 'structured_output_retry_exhausted',
    errors: ['gave up after 5 attempts'],
  }));
  assert.deepEqual(detail, {
    resultSubtype: 'error_max_structured_output_retries',
    terminalReason: 'structured_output_retry_exhausted',
    errors: ['gave up after 5 attempts'],
  });
});

test('resultDetail: api_error_status is carried when it is an integer; null and absent both leave it absent', () => {
  assert.equal(resultDetail(asResult({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401 })).apiErrorStatus, 401);
  assert.equal('apiErrorStatus' in resultDetail(asResult({ type: 'result', subtype: 'success', api_error_status: null })), false);
  assert.equal('apiErrorStatus' in resultDetail(asResult({ type: 'result', subtype: 'success' })), false);
});

test('resultDetail: structured_output is passed through verbatim when present, and only then', () => {
  const output = { scores: [{ id: 'c001', score: 70 }], picks: [], events: [], weekly: [] };
  assert.deepEqual(resultDetail(asResult({ type: 'result', subtype: 'success', structured_output: output })).structuredOutput, output);
  assert.equal('structuredOutput' in resultDetail(asResult({ type: 'result', subtype: 'success', result: 'plain text' })), false);
});

test('resultDetail: fields of the wrong runtime type are left absent, never coerced', () => {
  assert.deepEqual(resultDetail(asResult({ type: 'result', subtype: 7, terminal_reason: {}, api_error_status: '401', errors: 'x' })), {});
});

test('boundErrors: short lists pass through; long lists and long entries are bounded and say so', () => {
  assert.deepEqual(boundErrors(['a', 'b']), ['a', 'b']);
  const many = boundErrors(Array.from({ length: 20 }, (_, i) => `e${i}`));
  assert.equal(many.length, MAX_RESULT_ERRORS);
  assert.equal(many[MAX_RESULT_ERRORS - 1], `(${20 - (MAX_RESULT_ERRORS - 1)} more errors not shown)`);
  const long = boundErrors(['x'.repeat(MAX_RESULT_ERROR_CHARS + 50)]);
  assert.equal(long[0], `${'x'.repeat(MAX_RESULT_ERROR_CHARS)} [truncated]`);
  assert.deepEqual(boundErrors([{ code: 1 }]), ['{"code":1}']);
});

test('createSession + pump: a structured result reaches turn_completed with its detail', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', policy: { configuration: 'isolated', permissions: 'bypass', persistence: 'host_cli', executable: 'host_cli' } }, () => query);
  const { turnId } = session.sendTurn('go');
  const output = { answer: 'ok' };
  controller.emit({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'tool_use', terminal_reason: 'completed', structured_output: output } as never);
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 20 && !events.some((e) => e.type === 'turn_completed'); i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 1));
  }
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.turnId, turnId);
  assert.deepEqual(completed.structuredOutput, output);
  assert.equal(completed.resultSubtype, 'success');
  assert.equal(completed.terminalReason, 'completed');
  session.close();
});

test('M1 recording: the real success result yields its structured output and subtype', () => {
  const result = readM1Fixture('success_result') as Record<string, unknown>;
  const detail = resultDetail(asResult(result));
  assert.deepEqual(detail.structuredOutput, result.structured_output);
  assert.equal(detail.resultSubtype, 'success');
  assert.equal(detail.terminalReason, typeof result.terminal_reason === 'string' ? result.terminal_reason : undefined);
});

test('M1 recording: every recorded failure result keeps its own words and delivers no structured output', () => {
  for (const key of m1FailureResultKeys()) {
    const result = readM1Fixture(key) as Record<string, unknown>;
    const detail = resultDetail(asResult(result));
    assert.equal(detail.resultSubtype, result.subtype, key);
    assert.equal(detail.terminalReason, typeof result.terminal_reason === 'string' ? result.terminal_reason : undefined, key);
    assert.equal(detail.apiErrorStatus, typeof result.api_error_status === 'number' ? result.api_error_status : undefined, key);
    assert.deepEqual(detail.errors, Array.isArray(result.errors) ? boundErrors(result.errors) : undefined, key);
    assert.equal(detail.structuredOutput, undefined, key);
  }
});
