import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CASES,
  DEFAULT_CASES,
  MUNINN_SHAPED_SCHEMA,
  WEB_CASES,
  buildCase,
  candidatesMessage,
  estimateTokens,
  syntheticCandidates,
} from '../probes/m1/cases.js';

test('syntheticCandidates: deterministic, unique ids, all three lanes', () => {
  const a = syntheticCandidates(100);
  assert.deepEqual(a, syntheticCandidates(100));
  assert.equal(new Set(a.map((c) => c.id)).size, 100);
  assert.deepEqual(
    [...new Set(a.map((c) => c.lane))].sort(),
    ['daily', 'event', 'weekly'],
  );
  assert.equal(a.filter((c) => c.lane === 'event').length, 6);
  assert.ok(a.every((c) => c.snippet.length <= 300));
});

test('the success payload is large enough to show the cached/uncached usage split', () => {
  const message = candidatesMessage(syntheticCandidates(100));
  // Well above the prompt-cache minimum (1024 tokens) and well below muninn's 60k budget.
  assert.ok(estimateTokens(message) > 8_000, `estimate ${estimateTokens(message)}`);
  assert.ok(estimateTokens(message) < 60_000);
});

test('MUNINN_SHAPED_SCHEMA requires the four arrays of spec §6.2 and has no length limits', () => {
  assert.deepEqual(MUNINN_SHAPED_SCHEMA.required, ['scores', 'picks', 'events', 'weekly']);
  assert.equal(JSON.stringify(MUNINN_SHAPED_SCHEMA).includes('Length'), false);
});

test('every case uses an explicit empty allow list and never unrestricted', () => {
  for (const name of ALL_CASES.filter((n) => !WEB_CASES.includes(n))) {
    const def = buildCase(name);
    assert.equal(def.name, name);
    assert.deepEqual(def.policy.toolPolicy, { allow: [] }, name);
    assert.equal(def.policy.configuration, 'isolated', name);
  }
});

test('only auth-invalid uses a throwaway account or extra env; default cases exclude the optional modes', () => {
  for (const name of ALL_CASES) {
    const def = buildCase(name);
    const special = name === 'auth-invalid';
    assert.equal(def.account === 'throwaway', special, name);
    assert.equal(Object.keys(def.extraEnv).length > 0, special, name);
  }
  assert.deepEqual([...DEFAULT_CASES], ['success', 'control-claudemd', 'auth-invalid', 'schema-unsatisfiable']);
});
