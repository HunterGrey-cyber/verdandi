import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyCache } from '../src/idempotency.js';

test('IdempotencyCache: first check for a command_id is first_call', () => {
  const cache = new IdempotencyCache<{ turnId: string }>();
  assert.deepEqual(cache.check('cmd-1', 'hash-a'), { kind: 'first_call' });
});

test('IdempotencyCache: same command_id, same payload hash, after recording -> replay with the recorded outcome', () => {
  const cache = new IdempotencyCache<{ turnId: string }>();
  cache.record('cmd-1', 'hash-a', { turnId: 't1' });
  assert.deepEqual(cache.check('cmd-1', 'hash-a'), { kind: 'replay', outcome: { turnId: 't1' } });
});

test('IdempotencyCache: same command_id, different payload hash -> conflict', () => {
  const cache = new IdempotencyCache<{ turnId: string }>();
  cache.record('cmd-1', 'hash-a', { turnId: 't1' });
  assert.deepEqual(cache.check('cmd-1', 'hash-b'), { kind: 'conflict' });
});

test('IdempotencyCache: different command_ids never interfere with each other', () => {
  const cache = new IdempotencyCache<{ turnId: string }>();
  cache.record('cmd-1', 'hash-a', { turnId: 't1' });
  assert.deepEqual(cache.check('cmd-2', 'hash-a'), { kind: 'first_call' });
});
