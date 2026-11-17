import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as old from './b3aa188/generated/runtime.js';
import { alive, spawnSidecar, startCliSession, waitForBind, type Spawned } from './processHarness.js';

/**
 * What a host relies on past the wire, process half: when the sidecar exits and when it does not, and the
 * environment a host sets and removes on it. The in-process half is `hostReliance.conformance.test.ts`;
 * `crates/claude-runtime-protocol/COMPATIBILITY.md`, "What a host relies on past the wire", lists both.
 *
 * Nothing here runs a model or the real `claude`: the entry point is the real one, and the CLI is a stub.
 */

/** A host's exit grace (Eitri's `SIDECAR_EXIT_GRACE`). */
const HOST_EXIT_GRACE_MS = 6_000;
/** How long to watch a process that must NOT exit. A negative can only be shown for a while. */
const STILL_RUNNING_MS = 1_500;

async function handshakeAnswers(sidecar: Spawned): Promise<old.HandshakeResponse> {
  const client = new old.RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
  try {
    return await new Promise<old.HandshakeResponse>((resolve, reject) => {
      client.handshake(old.HandshakeRequest.fromPartial({ clientProtocolMajor: 3 }), (error, reply) => (error ? reject(error) : resolve(reply)));
    });
  } finally {
    client.close();
  }
}

// ---- Exit only on stdin EOF, SIGTERM or SIGINT -------------------------------------------------------

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`exit on ${signal}: a sidecar whose stdin is still open stops with exit 0 inside the host's grace and says which signal it was`, async () => {
    const sidecar = spawnSidecar();
    try {
      assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
      assert.equal(sidecar.child.kill(signal), true);
      assert.equal(await sidecar.exited(HOST_EXIT_GRACE_MS), 0, `still running after ${signal}; stderr:\n${sidecar.stderr()}`);
      assert.match(sidecar.stderr(), new RegExp(`received ${signal}, shutting down`));
    } finally {
      sidecar.stop();
    }
  });
}

test('exit only on those: a client connecting and leaving, and a session\'s CLI dying, leave a sidecar with an open stdin running and answering', async () => {
  const session = await startCliSession();
  try {
    await handshakeAnswers(session.sidecar);
    assert.ok(alive(session.cliPid));
    // The provider dies: the session ends, the sidecar does not.
    process.kill(session.cliPid, 'SIGKILL');
    assert.equal(await session.sidecar.exited(STILL_RUNNING_MS), 'running', `the sidecar exited when a session's CLI died; stderr:\n${session.sidecar.stderr()}`);
    const reply = await handshakeAnswers(session.sidecar);
    assert.equal(reply.protocolMajor, 3, 'and it still serves new connections');
  } finally {
    session.close();
  }
});

test('stdin EOF means every holder of the write end let go: a duplicate held by another process keeps the sidecar alive, the last close stops it', async () => {
  // A FIFO gives the sidecar one read end and the test two write ends, which is what a window that handed its
  // chat to another window looks like from the sidecar's side: its stdin pipe has two writers.
  const dir = mkdtempSync(join(tmpdir(), 'v1p-fifo-'));
  const fifo = join(dir, 'stdin');
  let sidecar: Spawned | undefined;
  const open: number[] = [];
  const release = (fd: number): void => {
    const at = open.indexOf(fd);
    if (at >= 0) {
      open.splice(at, 1);
      closeSync(fd);
    }
  };
  try {
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    // Read-write opens without blocking and counts as a writer until closed; the read end can then open too.
    const firstWriter = openSync(fifo, constants.O_RDWR);
    open.push(firstWriter);
    const readEnd = openSync(fifo, constants.O_RDONLY);
    open.push(readEnd);
    const secondWriter = openSync(fifo, constants.O_WRONLY);
    open.push(secondWriter);
    sidecar = spawnSidecar({ stdin: readEnd });
    release(readEnd);
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());

    release(firstWriter);
    assert.equal(await sidecar.exited(STILL_RUNNING_MS), 'running', `the sidecar exited while a second writer still held its stdin; stderr:\n${sidecar.stderr()}`);
    assert.equal((await handshakeAnswers(sidecar)).protocolMajor, 3);

    release(secondWriter);
    assert.equal(await sidecar.exited(HOST_EXIT_GRACE_MS), 0, `still running after the last writer closed; stderr:\n${sidecar.stderr()}`);
    assert.match(sidecar.stderr(), /stdin reached EOF/);
  } finally {
    for (const fd of [...open]) {
      release(fd);
    }
    sidecar?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The variables a host sets and removes --------------------------------------------------------

test('variables a host sets: BASH_MAX_TIMEOUT_MS and CLAUDE_CODE_AUTO_CONNECT_IDE reach the CLI the sidecar starts, as set', async () => {
  const session = await startCliSession({ env: { BASH_MAX_TIMEOUT_MS: '2147483647', CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' } });
  try {
    assert.equal(session.cliEnv.BASH_MAX_TIMEOUT_MS, '2147483647');
    assert.equal(session.cliEnv.CLAUDE_CODE_AUTO_CONNECT_IDE, 'false');
  } finally {
    session.close();
  }
});

test('variables a host removes: with VERDANDI_CLAUDE_EXTRA_MCP_SERVERS unset no MCP server is added to a session; set, it is', async () => {
  const marker = 'hostreliance_server';
  /** The server names across the configs: each is the JSON object the SDK passes, with its servers under `mcpServers`. */
  const serverNames = (configs: string[]): string[] =>
    configs.flatMap((config) => {
      const parsed = JSON.parse(config) as { mcpServers?: Record<string, unknown> };
      return Object.keys(parsed.mcpServers ?? {});
    });
  const mcpConfigs = (argv: string[]): string[] => argv.flatMap((arg, at) => (arg === '--mcp-config' ? [argv[at + 1] ?? ''] : arg.startsWith('--mcp-config=') ? [arg.slice('--mcp-config='.length)] : []));

  const unset = await startCliSession();
  try {
    // Every server of every config the CLI was started with, under any name: none may be there.
    assert.deepEqual(serverNames(mcpConfigs(unset.argv)), [], `argv: ${unset.argv.join(' ')}`);
  } finally {
    unset.close();
  }

  // The control: the same session with the variable set does carry the server, so the check above is not blind.
  const set = await startCliSession({ env: { VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: JSON.stringify({ [marker]: { command: '/bin/true' } }) } });
  try {
    assert.deepEqual(serverNames(mcpConfigs(set.argv)), [marker], `the variable did not reach the session's options; argv: ${set.argv.join(' ')}`);
  } finally {
    set.close();
  }
});

test('variables a host removes: with the sizing and fault seams unset the ring is the default, of at least 1,000 events, and event_buffer_policy says so', async () => {
  const sidecar = spawnSidecar();
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const policy = (await handshakeAnswers(sidecar)).eventBufferPolicy;
    const reported = /^bounded-(\d+)$/.exec(policy);
    assert.ok(reported !== null, `event_buffer_policy: ${JSON.stringify(policy)}`);
    assert.ok(Number(reported[1]) >= 1000, `a ring of ${reported[1]} events is too small for a handed-over chat`);
  } finally {
    sidecar.stop();
  }
});
