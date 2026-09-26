import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

const NATIVE_BYPASS_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'bypass',
  persistence: 'ephemeral',
  executable: 'host_cli',
};

test('real SDK: a plain-text turn completes with outcome completed', { skip: !REAL }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-'));
  // Declared above the try, and closed unconditionally in the finally below, so an assertion
  // failure (or any other throw) between session creation and the end of the try block never
  // leaks the real CLI child process -- `close()` is idempotent (Task 3's own guard), so a
  // defensive call here is harmless even on the success path where the try block already reaches
  // the bottom.
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession(realSessionConfig(dir, NATIVE_BYPASS_POLICY));
    session.sendTurn('reply with exactly the word: pong');

    const deadline = Date.now() + 60_000;
    let completed: unknown;
    while (Date.now() < deadline && completed === undefined) {
      for (const event of await session.pump()) {
        if (event.type === 'turn_completed') {
          completed = event;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(completed, 'no turn_completed within 60s');
    assert.equal((completed as { outcome: string }).outcome, 'completed');
  } finally {
    if (session) {
      session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real SDK: interrupting a real turn produces outcome interrupted, and the session accepts a further turn', { skip: !REAL }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-interrupt-'));
  // See the previous test's comment: declared above the try and closed unconditionally in
  // finally, so a thrown assertion never leaks the real CLI child process. This exact gap (close()
  // as the last statement inside try, never reached on assertion failure) is what actually leaked
  // a real CLI child process during this task's own development -- see the task report.
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession(realSessionConfig(dir, NATIVE_BYPASS_POLICY));
    session.sendTurn('write a very long story, at least 2000 words, about a journey');

    // Give the real process a moment to actually start streaming before interrupting it --
    // interrupting before the query has done anything real would not exercise the same path a
    // genuinely in-flight turn does. Empirically (this task's own real-CLI verification), 1000ms
    // was NOT reliably enough in this environment: session startup (SessionStart hooks, tool
    // listing, thinking-token estimation) can still be in progress at T+1000ms, so
    // `rawQuery.interrupt()` resolves as a no-op (there is nothing in-flight yet) and the turn
    // then runs to normal completion -- observed directly as outcome 'completed' with a full
    // ~2000-word result and terminal_reason 'completed', not an abort. 3000ms was confirmed
    // (repeatedly) to land after generation has genuinely started, producing terminal_reason
    // 'aborted_streaming' as intended below.
    await new Promise((r) => setTimeout(r, 3000));
    await session.interrupt();

    const deadline = Date.now() + 30_000;
    let completed: unknown;
    while (Date.now() < deadline && completed === undefined) {
      for (const event of await session.pump()) {
        if (event.type === 'turn_completed') {
          completed = event;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(completed, 'no turn_completed within 30s of interrupting');
    assert.equal((completed as { outcome: string }).outcome, 'interrupted');

    // Session must still be usable -- this is the whole point of distinguishing interrupt from
    // close (design doc §5.2, mirrored from the neovibe Rust sibling's own equivalent guarantee).
    session.sendTurn('reply with exactly the word: pong');
  } finally {
    if (session) {
      session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
