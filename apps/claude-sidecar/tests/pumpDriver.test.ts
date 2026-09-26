import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PumpDriver } from '../src/pumpDriver.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { makeFakeSession } from './fakeSession.js';

function setup() {
  const registry = new SessionRegistry();
  const { session, controller } = makeFakeSession();
  const entry = registry.create('sess-1', session, 100);
  const broadcasted: unknown[] = [];
  let terminated: string | undefined;
  const driver = new PumpDriver(entry, {
    onEvent: (sequenced) => broadcasted.push(sequenced),
    onTerminal: (sessionId) => {
      terminated = sessionId;
      registry.remove(sessionId);
    },
  });
  return { registry, session, controller, entry, driver, broadcasted, getTerminated: () => terminated };
}

test('PumpDriver: tick() with nothing queued does nothing, entry stays in the registry', async () => {
  const { driver, broadcasted, registry } = setup();
  await driver.tick();
  assert.deepEqual(broadcasted, []);
  assert.notEqual(registry.get('sess-1'), undefined);
});

test('PumpDriver: tick() translates a queued kernel event, assigns sequence 1, writes it to the ring buffer, and broadcasts it', async () => {
  const { driver, controller, broadcasted, entry } = setup();
  controller.emit({ type: 'turn_started', turnId: 't1' } as never);

  await driver.tick();

  assert.equal(broadcasted.length, 1);
  const sequenced = broadcasted[0] as { sequence: bigint; event: unknown };
  assert.equal(sequenced.sequence, 1n);
  assert.deepEqual(entry.ringBuffer.replay({ mode: 'available_history' }), { kind: 'ok', events: [sequenced] });
});

test('PumpDriver: multiple events in one drain get consecutive sequence numbers, in order', async () => {
  const { driver, controller, broadcasted } = setup();
  controller.emit({ type: 'turn_started', turnId: 't1' } as never);
  controller.emit({ type: 'text_delta', turnId: 't1', text: 'hi' } as never);

  await driver.tick();

  assert.deepEqual(broadcasted.map((b) => (b as { sequence: bigint }).sequence), [1n, 2n]);
});

test('PumpDriver: observing a session_closed event evicts the registry entry via onTerminal, after broadcasting it', async () => {
  const { driver, controller, broadcasted, registry, getTerminated } = setup();
  controller.emit({ type: 'session_closed', reason: 'closed_by_host' } as never);

  await driver.tick();

  assert.equal(broadcasted.length, 1);
  assert.equal(getTerminated(), 'sess-1');
  assert.equal(registry.get('sess-1'), undefined);
});

test('PumpDriver: session_closed with reason provider_failed (self-terminated, no explicit close() call) is handled identically', async () => {
  const { driver, controller, registry, getTerminated } = setup();
  controller.emit({ type: 'session_closed', reason: 'provider_failed' } as never);

  await driver.tick();

  assert.equal(getTerminated(), 'sess-1');
  assert.equal(registry.get('sess-1'), undefined);
});

test('PumpDriver: stop() prevents further tick()s from doing anything, even if called directly', async () => {
  const { driver, controller, broadcasted } = setup();
  driver.stop();
  controller.emit({ type: 'turn_started', turnId: 't1' } as never);

  await driver.tick();

  assert.deepEqual(broadcasted, []);
});
