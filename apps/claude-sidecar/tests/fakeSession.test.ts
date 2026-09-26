import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeSession } from './fakeSession.js';

test('makeFakeSession: pump() drains emitted events in order, then returns empty', async () => {
  const { session, controller } = makeFakeSession();

  assert.deepEqual(await session.pump(), []);

  controller.emit({ type: 'session_ready', sessionId: 's1', providerSessionId: 's1', model: 'm', cwd: '/tmp' } as never);
  controller.emit({ type: 'turn_started', turnId: 't1' } as never);

  assert.deepEqual(await session.pump(), [
    { type: 'session_ready', sessionId: 's1', providerSessionId: 's1', model: 'm', cwd: '/tmp' },
    { type: 'turn_started', turnId: 't1' },
  ]);
  assert.deepEqual(await session.pump(), []);
});

test('makeFakeSession: sendTurn/interrupt/close/resolvePermission calls are observable on the controller', async () => {
  const { session, controller } = makeFakeSession();

  const { turnId } = session.sendTurn('hello');
  assert.equal(turnId, 'fake-turn-1');
  assert.deepEqual(controller.sentTurns, ['hello']);

  await session.interrupt();
  assert.equal(controller.interruptCalls, 1);

  session.close();
  assert.equal(controller.closeCalls, 1);

  const resolved = session.resolvePermission('p1', { allow: true });
  assert.equal(resolved, true);
  assert.deepEqual(controller.resolvePermissionCalls, [{ permissionId: 'p1', decision: { allow: true } }]);
});
