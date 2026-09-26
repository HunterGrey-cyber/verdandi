import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { makeFakeSession } from './fakeSession.js';

test('SessionRegistry: create() adds an entry retrievable by get(), starting at sequence 0', () => {
  const registry = new SessionRegistry();
  const { session } = makeFakeSession();

  const entry = registry.create('sess-1', session, 100);
  assert.equal(entry.sequence, 0n);
  assert.equal(registry.get('sess-1'), entry);
});

test('SessionRegistry: get() for an unknown session_id returns undefined', () => {
  const registry = new SessionRegistry();
  assert.equal(registry.get('does-not-exist'), undefined);
});

test('SessionRegistry: remove() deletes the entry; a later get() returns undefined', () => {
  const registry = new SessionRegistry();
  const { session } = makeFakeSession();
  registry.create('sess-1', session, 100);

  registry.remove('sess-1');
  assert.equal(registry.get('sess-1'), undefined);
});

test('SessionRegistry: allSessionIds() lists every currently-registered session_id', () => {
  const registry = new SessionRegistry();
  registry.create('sess-1', makeFakeSession().session, 100);
  registry.create('sess-2', makeFakeSession().session, 100);

  assert.deepEqual(registry.allSessionIds().sort(), ['sess-1', 'sess-2']);

  registry.remove('sess-1');
  assert.deepEqual(registry.allSessionIds(), ['sess-2']);
});
