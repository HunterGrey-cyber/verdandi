import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, CLI_MESSAGE_LIFECYCLE_CAPABILITY, type QueryFn } from '../src/session.js';
import { makeFakeQuery } from './fakeQuery.js';
import { drive } from './replay/drive.js';
import { loadRecording } from './replay/recording.js';

const goldens = readFileSync(new URL('../../../../apps/claude-sidecar/tests/compat/b3aa188/eitri-0.2.0-requests.txt', import.meta.url), 'utf8');
const golden = Buffer.from(goldens.split('\n').find(line => line.startsWith('send_turn\t'))!.split('\t')[1], 'hex');
// The frozen request contains only session id S, command id c1 and text hello.
assert.equal(golden.toString('hex'), '0a0153120263311a0568656c6c6f');
const oldText = golden.subarray(9).toString('utf8');

for (const method of ['send', 'steer'] as const) {
  for (const typedByPerson of [true, false, undefined]) {
    for (const text of [oldText, '/help']) {
      test(`${method}: typedByPerson=${typedByPerson}, text=${text}: exact SDK message`, async () => {
        const { query, controller } = makeFakeQuery();
        let input!: AsyncIterator<SDKUserMessage>;
        const queryFn: QueryFn = params => {
          input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          return query;
        };
        const session = createSession({ cwd: '/tmp/project', policy: {
          configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli',
        } }, queryFn);
        try {
          const options = typedByPerson === undefined ? undefined : { typedByPerson };
          if (method === 'send') {
            session.sendTurn(text, options);
          } else {
            const { turnId } = session.sendTurn('first');
            await input.next();
            controller.emit({ type: 'system', subtype: 'init', capabilities: [CLI_MESSAGE_LIFECYCLE_CAPABILITY] } as never);
            for (let i = 0; i < 5; i++) {
              await session.pump();
              await new Promise(resolve => setImmediate(resolve));
            }
            session.steerTurn(turnId, 'client-1', text, options);
          }
          const next = await input.next();
          assert.equal(next.done, false);
          const { uuid, ...message } = next.value as SDKUserMessage;
          assert.match(String(uuid), /^[0-9a-f-]{36}$/);
          assert.deepEqual(message, {
            type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null,
            ...(method === 'steer' ? { priority: 'next' } : {}),
            ...(typedByPerson === true ? { origin: { kind: 'human' } } : {}),
          });
        } finally {
          session.close();
        }
      });
    }
  }
}

for (const name of ['c05', 'c17']) {
  test(`${name} plain replay: pushed messages match host lines apart from uuids`, async () => {
    const recording = loadRecording(name);
    try {
      const replay = await drive(recording.messages, recording.directory);
      const hosts = recording.messages.filter(line => line.from === 'host' && line.message.type === 'user');
      assert.equal(replay.pushed.length, hosts.length);
      assert.deepEqual(replay.pushed.map(({ uuid, ...message }) => message),
        hosts.map(({ message: { uuid, ...message } }) => message));
    } finally {
      recording.cleanup();
    }
  });
}
