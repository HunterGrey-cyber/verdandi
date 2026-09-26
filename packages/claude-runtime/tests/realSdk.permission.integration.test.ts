import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

const NATIVE_INTERACTIVE_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
};

test('real SDK: an allowed real tool call runs and its result reaches the final turn text', { skip: !REAL }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-perm-allow-'));
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession(realSessionConfig(dir, NATIVE_INTERACTIVE_POLICY));
    session.sendTurn('run: echo hello, and tell me the output');

    let resultText: string | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && resultText === undefined) {
      for (const event of await session.pump()) {
        if (event.type === 'permission_requested') {
          session.resolvePermission(event.permissionId, { allow: true });
        }
        if (event.type === 'turn_completed') {
          resultText = event.resultText;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(resultText, 'no turn_completed within 60s');
    assert.match(resultText!.toLowerCase(), /hello/);
  } finally {
    if (session) {
      session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real SDK: a denied real tool call is genuinely blocked and the deny reason surfaces in the tool result', { skip: !REAL }, async () => {
  const DENY_REASON = 'verdandi test policy: shell commands are not permitted in this conversation';
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-perm-deny-'));
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession(realSessionConfig(dir, NATIVE_INTERACTIVE_POLICY));
    session.sendTurn('run: echo hello, and tell me the output');

    const toolResults: Array<{ isError: boolean; content: unknown }> = [];
    let done = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !done) {
      for (const event of await session.pump()) {
        if (event.type === 'permission_requested') {
          session.resolvePermission(event.permissionId, { allow: false, reason: DENY_REASON });
        }
        if (event.type === 'tool_call_completed') {
          toolResults.push({ isError: event.isError, content: event.content });
        }
        if (event.type === 'turn_completed') {
          done = true;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(done, 'no turn_completed within 90s');
    assert.ok(toolResults.length > 0, 'expected at least one tool_call_completed');
    assert.ok(
      toolResults.every((r) => r.isError),
      `a tool call succeeded despite every permission request being denied: ${JSON.stringify(toolResults)}`,
    );
    assert.ok(
      toolResults.some((r) => String(r.content).includes(DENY_REASON)),
      `expected the deny reason verbatim in a tool result, got: ${JSON.stringify(toolResults)}`,
    );
  } finally {
    if (session) {
      session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
