import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeQuery } from './fakeQuery.js';

test('makeFakeQuery: emitted messages are observed in order, then the stream ends', async () => {
  const { query, controller } = makeFakeQuery();
  const seen: string[] = [];

  const drainPromise = (async () => {
    for await (const message of query) {
      seen.push(message.type);
    }
  })();

  controller.emit({ type: 'system', subtype: 'status', status: null } as never);
  controller.emit({ type: 'system', subtype: 'status', status: 'running' } as never);
  controller.end();
  await drainPromise;

  assert.deepEqual(seen, ['system', 'system']);
});

test('makeFakeQuery: interrupt() and close() are observable on the controller', async () => {
  const { query, controller } = makeFakeQuery();
  assert.equal(controller.interruptCalls, 0);
  assert.equal(controller.closed, false);

  await query.interrupt();
  query.close();

  assert.equal(controller.interruptCalls, 1);
  assert.equal(controller.closed, true);
});
