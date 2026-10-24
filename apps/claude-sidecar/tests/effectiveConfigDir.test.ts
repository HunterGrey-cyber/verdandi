import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { explicitAccount } from '@verdandi/claude-runtime';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { resolveAccount } from '../src/legacyAccountName.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { HandshakeResponse, RuntimeServiceClient } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';
import { spawnSidecar, waitForBind } from './compat/processHarness.js';

/**
 * `HandshakeResponse.effective_claude_config_dir`: where the CLI reads its configuration for this process's
 * sessions, as a path. The pinned account's directory, or for an unpinned process what the sessions inherit.
 * And, because the handshake is the one message every client reads before it has authenticated anything, that
 * nothing a login stores can ever ride in it.
 */

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };

function handshakeOf(options: Parameters<typeof createRuntimeServiceImpl>[3]): Promise<HandshakeResponse> {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, VERSIONS, options);
  return new Promise((resolve, reject) => {
    impl.handshake.bind(impl)({ request: { clientProtocolMajor: 3 } } as never, (err: grpc.ServiceError | null, res?: unknown) =>
      err ? reject(err) : resolve(res as HandshakeResponse),
    );
  });
}

test('the capability is advertised, ahead of the executable pair', async () => {
  const { capabilities } = await handshakeOf({});
  assert.ok(capabilities.includes('effective_claude_config_dir'));
  assert.ok(capabilities.indexOf('effective_claude_config_dir') < capabilities.indexOf('executable_host_cli'));
});

test('pinned: the account\'s own directory, the same string account_config_dir carries', async () => {
  const account = explicitAccount({ label: 'tester', configDir: '/srv/logins/tester', anthropicConfigDir: '/srv/anthropic/tester' }, {});
  const res = await handshakeOf({ account, env: { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: '/ignored/when/pinned' } });
  assert.equal(res.effectiveClaudeConfigDir, '/srv/logins/tester');
  assert.equal(res.accountConfigDir, '/srv/logins/tester');
});

test('pinned at the CLI default location: $HOME/.claude, although no CLAUDE_CONFIG_DIR is set on its sessions', async () => {
  const account = explicitAccount({ label: 'tester', configDir: 'default' }, { HOME: '/home/nobody' });
  const res = await handshakeOf({ account, env: { HOME: '/home/nobody' } });
  assert.equal(res.effectiveClaudeConfigDir, '/home/nobody/.claude');
  assert.equal(res.accountConfigDir, '/home/nobody/.claude');
});

test('unpinned: the inherited absolute CLAUDE_CONFIG_DIR; else $HOME/.claude; else empty', async () => {
  const inherited = await handshakeOf({ env: { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: '/srv/inherited' } });
  assert.equal(inherited.effectiveClaudeConfigDir, '/srv/inherited');
  assert.equal(inherited.accountConfigDir, '', 'account_config_dir keeps its meaning: empty unless pinned');

  assert.equal((await handshakeOf({ env: { HOME: '/home/nobody' } })).effectiveClaudeConfigDir, '/home/nobody/.claude');
  assert.equal((await handshakeOf({ env: { HOME: '/home/nobody', CLAUDE_CONFIG_DIR: 'relative/dir' } })).effectiveClaudeConfigDir, '', 'a relative inherited value is not known, so not reported');
  assert.equal((await handshakeOf({ env: {} })).effectiveClaudeConfigDir, '', 'HOME unset: unknown, said as empty');
});

test('the service reads this process\'s own environment when none is injected', async () => {
  const res = await handshakeOf({});
  const expected = process.env.CLAUDE_CONFIG_DIR?.startsWith('/') ? process.env.CLAUDE_CONFIG_DIR : process.env.HOME?.startsWith('/') ? join(process.env.HOME, '.claude') : '';
  assert.equal(res.effectiveClaudeConfigDir, expected);
});

/** A sentinel no honest field would ever hold. */
const SENTINEL = 'SENTINEL-login-token-that-must-never-reach-the-handshake-0123456789';

function writeLogin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: SENTINEL, refreshToken: `${SENTINEL}-refresh`, expiresAt: 4_102_444_800_000 } }),
  );
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${SENTINEL}@example.invalid`, organizationName: SENTINEL } }));
}

function assertNoSentinel(res: HandshakeResponse): void {
  const bytes = Buffer.from(HandshakeResponse.encode(res).finish());
  assert.ok(bytes.length > 0);
  assert.equal(bytes.includes(Buffer.from(SENTINEL)), false, 'the encoded handshake must not contain anything read from a login');
  assert.equal(bytes.includes(Buffer.from('SENTINEL')), false);
  assert.equal(JSON.stringify(res, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)).includes('SENTINEL'), false);
}

test('the handshake never carries anything read from .credentials.json or .claude.json (in process, pinned and at the default location)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verdandi-handshake-secret-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeLogin(join(home, '.claude-tester'));
  writeLogin(join(home, '.claude'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${SENTINEL}@example.invalid` } }));

  const named = resolveAccount({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'tester' })!;
  const atDefault = resolveAccount({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'default' })!;
  for (const options of [{ account: named, env: { HOME: home } }, { account: atDefault, env: { HOME: home } }, { env: { HOME: home } }]) {
    const res = await handshakeOf(options);
    assert.notEqual(res.effectiveClaudeConfigDir, '');
    assertNoSentinel(res);
  }
});

test('the handshake of the real process carries the pinned directory and nothing from the login in it', async () => {
  const login = mkdtempSync(join(tmpdir(), 'verdandi-handshake-login-'));
  writeLogin(login);
  const sidecar = spawnSidecar({ env: { VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: login } });
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, `did not bind; stderr:\n${sidecar.stderr()}`);
    const client = new RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    try {
      const res = await new Promise<HandshakeResponse>((resolve, reject) =>
        client.handshake({ clientProtocolMajor: 3 }, (err, reply) => (err ? reject(err) : resolve(reply))),
      );
      assert.equal(res.effectiveClaudeConfigDir, login);
      assert.equal(res.accountConfigDir, login);
      assertNoSentinel(res);
    } finally {
      client.close();
    }
  } finally {
    sidecar.stop();
    rmSync(login, { recursive: true, force: true });
  }
});

test('the handshake of the real process without an account reports the HOME-derived directory (HOME is the harness\'s scratch home)', async () => {
  const sidecar = spawnSidecar({ env: { CLAUDE_CONFIG_DIR: undefined } });
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, `did not bind; stderr:\n${sidecar.stderr()}`);
    const client = new RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    try {
      const res = await new Promise<HandshakeResponse>((resolve, reject) =>
        client.handshake({ clientProtocolMajor: 3 }, (err, reply) => (err ? reject(err) : resolve(reply))),
      );
      assert.equal(res.effectiveClaudeConfigDir, join(sidecar.home, '.claude'));
      assert.equal(res.accountConfigDir, '');
    } finally {
      client.close();
    }
  } finally {
    sidecar.stop();
  }
});
