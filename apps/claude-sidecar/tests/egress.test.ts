import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { assertEgressRestricted, egressModeFromEnv, loopbackReachability } from '../src/egress.js';
import { makeFakeSession } from './fakeSession.js';

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

async function capabilities(egressRestricted: boolean | undefined): Promise<string[]> {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, VERSIONS, {
    sdkBundledAvailable: true,
    ...(egressRestricted === undefined ? {} : { egressRestricted }),
  });
  const res = await callResult<{ capabilities: string[] }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  return res.capabilities;
}

test('egressModeFromEnv: unset or blank is open; open and restricted are read; anything else refuses to boot', () => {
  assert.equal(egressModeFromEnv({}), 'open');
  assert.equal(egressModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_EGRESS: '  ' }), 'open');
  assert.equal(egressModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_EGRESS: 'open' }), 'open');
  assert.equal(egressModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_EGRESS: ' restricted ' }), 'restricted');
  assert.throws(() => egressModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_EGRESS: 'restrict' }), /expected "open" or "restricted", got "restrict"/);
});

test('loopbackReachability: an unfiltered process reaches its own 127.0.0.1 listener', async () => {
  assert.equal(await loopbackReachability(), 'reachable');
});

test('assertEgressRestricted: passes when loopback is blocked, refuses when it is reachable', async () => {
  await assertEgressRestricted(async () => 'blocked');
  await assert.rejects(assertEgressRestricted(async () => 'reachable'), /reached a listener on 127\.0\.0\.1/);
});

test('assertEgressRestricted: with the real probe, this unfiltered test process is refused', async () => {
  await assert.rejects(assertEgressRestricted(), /no IP filter applies to it/);
});

test('handshake: tool_allow_list always; egress_restricted only when startup proved it', async () => {
  const plain = await capabilities(undefined);
  assert.ok(plain.includes('tool_allow_list'), JSON.stringify(plain));
  assert.equal(plain.includes('egress_restricted'), false);
  assert.equal((await capabilities(false)).includes('egress_restricted'), false);
  const restricted = await capabilities(true);
  assert.ok(restricted.includes('egress_restricted'), JSON.stringify(restricted));
  assert.equal(restricted.indexOf('egress_restricted'), restricted.indexOf('tool_allow_list') + 1, 'right after tool_allow_list, before the executable sources');
});
