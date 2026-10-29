import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildSessionOptions } from '../src/session.js';
import type { ClaudeSessionConfig } from '../src/types.js';

const recorder = fileURLToPath(new URL('../../tests/fixtures/initializeRecorder.mjs', import.meta.url));

async function captureInitialize(config: ClaudeSessionConfig): Promise<Record<string, unknown>> {
  const scratch = await mkdtemp(join(tmpdir(), 'verdandi-initialize-'));
  const capturePath = join(scratch, 'initialize.json');
  let child: ChildProcess | undefined;
  let childClosed = Promise.resolve();
  let diagnostics = '';
  let captured = false;
  let sdkQuery: ReturnType<typeof query> | undefined;
  let finishInput!: () => void;
  const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
  try {
    sdkQuery = query({
      // Keep stdin open for initialize without sending a user/model request.
      prompt: (async function* () { await inputFinished; })(),
      options: {
        ...buildSessionOptions(config),
        pathToClaudeCodeExecutable: recorder,
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          CLAUDE_CONFIG_DIR: scratch,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: scratch,
          ANTHROPIC_CONFIG_DIR: scratch,
          VERDANDI_TEST_INITIALIZE_CAPTURE: capturePath,
        },
        // Observe the real child lifecycle; serialization still belongs to the locked SDK.
        spawnClaudeCodeProcess: ({ command, args, ...options }) => {
          const spawned = spawn(command, args, { ...options, stdio: 'pipe' });
          child = spawned;
          childClosed = new Promise<void>((resolve) => spawned.once('close', () => resolve()));
          spawned.on('error', (error) => { diagnostics += error.message; });
          spawned.stderr.on('data', (chunk) => { diagnostics += String(chunk); });
          return spawned;
        },
      },
    });
    void sdkQuery.supportedCommands().catch((error: unknown) => { diagnostics += String(error); });
    // Do not depend on iterator success: EOF may reject it after initialize was captured.
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const request = JSON.parse(await readFile(capturePath, 'utf8')) as Record<string, unknown>;
        captured = true;
        return request;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert.ok(Date.now() < deadline, `initialize capture unavailable: ${diagnostics || 'no capture file'}`);
        await delay(10);
      }
    }
  } finally {
    sdkQuery?.close();
    finishInput();
    const killTimer = setTimeout(() => child?.kill('SIGKILL'), 3_000);
    try {
      await childClosed;
      if (captured) assert.equal(child?.exitCode, 0, diagnostics);
    } finally {
      clearTimeout(killTimer);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

test('sdk initialize distinguishes preset from minimal', { timeout: 30_000 }, async (t) => {
  let networkAttempts = 0;
  const denyNetwork = () => {
    networkAttempts += 1;
    throw new Error('initialize test must not connect to a model endpoint');
  };
  t.mock.method(Socket.prototype, 'connect', denyNetwork);
  t.mock.method(globalThis, 'fetch', denyNetwork);
  const base: ClaudeSessionConfig = {
    cwd: tmpdir(),
    policy: {
      configuration: 'isolated',
      permissions: 'bypass',
      persistence: 'ephemeral',
      executable: 'host_cli',
      settingSources: [],
      toolPolicy: { allow: [] },
    },
  };
  const preset = await captureInitialize({ ...base, systemPromptPreset: { append: 'panel note' } });
  assert.equal(preset.subtype, 'initialize');
  assert.equal(preset.appendSystemPrompt, 'panel note');
  assert.equal('systemPrompt' in preset, false);

  const minimal = await captureInitialize(base);
  assert.deepEqual(minimal.systemPrompt, ['']);
  assert.equal('appendSystemPrompt' in minimal, false);

  const emptyPreset = await captureInitialize({ ...base, systemPromptPreset: {} });
  assert.equal('systemPrompt' in emptyPreset, false);
  assert.equal('appendSystemPrompt' in emptyPreset, false);

  const replacement = await captureInitialize({ ...base, systemPrompt: 'replacement' });
  assert.deepEqual(replacement.systemPrompt, ['replacement']);
  assert.equal('appendSystemPrompt' in replacement, false);
  for (const request of [preset, minimal, emptyPreset, replacement]) {
    assert.equal('systemPromptSnapshot' in request, false);
    assert.equal('excludeDynamicSections' in request, false);
  }
  assert.equal(networkAttempts, 0);
});
