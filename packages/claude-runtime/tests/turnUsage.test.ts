import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { m1Manifest, readM1Fixture } from './m1FixtureFiles.js';
import { resultDetail, usageFromModelUsage } from '../src/resultDetail.js';
import { createSession } from '../src/session.js';

type Result = Extract<SDKMessage, { type: 'result' }>;

test('usageFromModelUsage: sums every model, and names the one that did the most work', () => {
  const usage = usageFromModelUsage({
    'claude-sonnet-5': { inputTokens: 2, outputTokens: 900, cacheCreationInputTokens: 11000, cacheReadInputTokens: 0, costUSD: 0.5 },
    'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0.25 },
  });
  assert.deepEqual(usage, {
    inputTokens: 302,
    outputTokens: 920,
    cacheCreationInputTokens: 11000,
    cacheReadInputTokens: 0,
    totalCostUsd: 0.75,
    model: 'claude-sonnet-5',
  });
});

test('usageFromModelUsage: nothing to sum is absent, never a zero-filled "free" turn', () => {
  for (const value of [undefined, null, {}, [], 'x', { 'claude-sonnet-5': null }]) {
    assert.equal(usageFromModelUsage(value), undefined, JSON.stringify(value));
  }
});

test('usageFromModelUsage: a malformed counter counts as 0 inside an entry that exists; ties go to the first key', () => {
  const usage = usageFromModelUsage({
    b: { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0 },
    a: { inputTokens: '5', outputTokens: 5, cacheCreationInputTokens: -3, cacheReadInputTokens: Number.NaN, costUSD: Infinity },
  });
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0, model: 'a' });
});

test('resultDetail: usage comes from modelUsage, not from the main-loop-only result.usage', () => {
  const detail = resultDetail({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    modelUsage: { m: { inputTokens: 2, outputTokens: 900, cacheCreationInputTokens: 11000, cacheReadInputTokens: 23000, costUSD: 0.07 } },
  } as unknown as Result);
  assert.equal(detail.usage?.cacheCreationInputTokens, 11000);
  assert.equal(detail.usage?.cacheReadInputTokens, 23000);
  assert.equal(detail.usage?.outputTokens, 900);
});

test('M1 recording: the real success result sums to its own modelUsage, in the recorded cache shape', () => {
  const result = readM1Fixture('success_result') as { modelUsage: Record<string, Record<string, number>> };
  const usage = resultDetail(result as unknown as Result).usage;
  assert.ok(usage, 'the recorded success result must yield usage');
  const models = Object.values(result.modelUsage);
  const sum = (key: string) => models.reduce((total, m) => total + (m[key] ?? 0), 0);
  assert.equal(usage.inputTokens, sum('inputTokens'));
  assert.equal(usage.outputTokens, sum('outputTokens'));
  assert.equal(usage.cacheCreationInputTokens, sum('cacheCreationInputTokens'));
  assert.equal(usage.cacheReadInputTokens, sum('cacheReadInputTokens'));
  assert.ok(Math.abs(usage.totalCostUsd - sum('costUSD')) < 1e-9);
  assert.ok(Object.keys(result.modelUsage).includes(usage.model), usage.model);
  // The whole prompt is the sum of all three input counters -- the number muninn's arrival check
  // (spec §6.2) compares against its own estimate. The success prompt is ~10k tokens.
  assert.ok(usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens > 5_000);
  const cacheDominant = usage.inputTokens < usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  assert.equal(cacheDominant, m1Manifest().usage_shape === 'cache_dominant');
});

test('usageFromModelUsage: a zeroed entry (a crash or startup-error result) is present zeros, not absent', () => {
  assert.deepEqual(usageFromModelUsage({ m: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0 } }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    model: 'm',
  });
});

test('two turns in one session: each turn_completed carries the SDK running total unchanged, never a per-turn delta', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/p', policy: { configuration: 'native', permissions: 'bypass', persistence: 'host_cli', executable: 'host_cli', toolPolicy: { unrestricted: true } } }, () => query);
  const totals = [
    { inputTokens: 3, outputTokens: 100, cacheCreationInputTokens: 5000, cacheReadInputTokens: 0, costUSD: 0.5 },
    { inputTokens: 6, outputTokens: 180, cacheCreationInputTokens: 5200, cacheReadInputTokens: 5000, costUSD: 0.75 },
  ];
  const seen: number[] = [];
  for (const total of totals) {
    session.sendTurn('turn');
    controller.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', modelUsage: { m: total } } as never);
    for (let i = 0; i < 50; i += 1) {
      const done = (await session.pump()).find((e) => e.type === 'turn_completed');
      if (done?.type === 'turn_completed') {
        seen.push(done.usage?.cacheReadInputTokens ?? -1, done.usage?.outputTokens ?? -1);
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  assert.deepEqual(seen, [0, 100, 5000, 180]);
  session.close();
});
