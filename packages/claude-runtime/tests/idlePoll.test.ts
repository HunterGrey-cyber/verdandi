import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeQuery } from './fakeQuery.js';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import type { MinimalQuery } from '../src/queryTypes.js';

const POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'host_cli',
  executable: 'host_cli',
};

/** The fake query with every promise its next() returns counting the reactions attached to it. */
function countingQuery(): { query: MinimalQuery; emit: (message: never) => void; reactions: () => number } {
  const { query, controller } = makeFakeQuery();
  let reactions = 0;
  const next = query.next.bind(query);
  query.next = () => {
    const call = next();
    const then = call.then.bind(call);
    call.then = ((...handlers: Parameters<typeof then>) => {
      reactions += 1;
      return then(...handlers);
    }) as typeof call.then;
    return call;
  };
  return { query, emit: controller.emit as (message: never) => void, reactions: () => reactions };
}

test('pump: polling an idle session attaches no reaction to the outstanding next() call, however often it polls', async () => {
  // A reaction on a promise that stays pending is held until it settles. An idle session polls every 20 ms for
  // as long as it lives, so one reaction per poll was an unbounded growth that no collection could reclaim.
  const { query, reactions } = countingQuery();
  const session = createSession({ cwd: '/tmp/project', policy: POLICY }, () => query);
  await session.accountIdentity();
  await session.pump();
  const afterFirstPoll = reactions();

  for (let i = 0; i < 2000; i++) {
    await session.pump();
  }

  assert.equal(reactions(), afterFirstPoll);
  assert.ok(afterFirstPoll <= 1, `the first poll attached ${afterFirstPoll} reactions`);
});

test('pump: a message that arrives after many idle polls comes back from the next poll, and the call after it starts a fresh next()', async () => {
  const { query, emit, reactions } = countingQuery();
  const session = createSession({ cwd: '/tmp/project', policy: POLICY }, () => query);
  await session.accountIdentity();
  await session.pump();
  for (let i = 0; i < 50; i++) {
    await session.pump();
  }

  emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp/project', permissionMode: 'default' } as never);
  let events: Awaited<ReturnType<typeof session.pump>> = [];
  for (let attempt = 0; attempt < 5 && events.length === 0; attempt++) {
    events = await session.pump();
  }
  assert.deepEqual(events.map((e) => e.type), ['session_ready']);

  const reactionsAfterMessage = reactions();
  for (let i = 0; i < 500; i++) {
    await session.pump();
  }
  assert.equal(reactions(), reactionsAfterMessage, 'the next() call started after the message is polled without new reactions');
  assert.ok(reactionsAfterMessage <= 2, `one reaction per next() call, saw ${reactionsAfterMessage}`);
});
