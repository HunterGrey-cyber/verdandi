import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

/**
 * `PERMISSION_OUTCOME_EXPIRED`, produced by the CLI'S OWN HOOK TIMEOUT, against a real CLI.
 *
 * ### Why this file exists, stated precisely, because two design documents got it wrong
 *
 * Both recorded that `expired` "was modelled end to end but never verified against a real CLI".
 * That is not quite true and the difference is the whole test. The abort path in
 * `permissionBroker` HAS fired for real -- via interrupt. The neovibe sibling records it: a race
 * between the kernel's own `failAllPending('cancelled_by_interrupt')` and the SDK's hook-abort
 * listener, which independently resolves the same pending permission as `expired` and usually wins.
 *
 * So the HANDLER is exercised. What has never executed is the PRODUCER this outcome is named for:
 * the CLI deciding on its own that the host took too long. Those are two different things reaching
 * one `onAbort`, and a test that cannot tell them apart would report the already-known one as proof
 * of the unknown one. This test therefore never interrupts and never closes the session while the
 * request is pending -- the only thing that can resolve it is the CLI's timer.
 *
 * ### Why `interactive` and not `bypass`
 *
 * Under `bypass` the kernel installs no PreToolUse hook at all, so there is no hook for the CLI to
 * time out and a bypass session produces zero permission events by construction. Running this on
 * bypass would pass vacuously.
 *
 * ### Why the seam exists
 *
 * `ClaudeSessionConfig.permissionHookTimeoutSeconds` maps to the SDK's
 * `HookCallbackMatcher.timeout`. Without it this test would have to wait out the CLI's default,
 * which is measured only as "longer than 60 seconds" and is not a constant readable from the
 * stripped binary. Production leaves it unset and keeps the CLI default.
 */

const NATIVE_INTERACTIVE_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
};

const HOOK_TIMEOUT_SECONDS = 10;

test(
  "real SDK: the CLI's own hook timeout resolves an unanswered permission as expired",
  { skip: !REAL },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-hook-timeout-'));
    let session: ReturnType<typeof createSession> | undefined;
    try {
      session = createSession({
        ...realSessionConfig(dir, NATIVE_INTERACTIVE_POLICY),
        permissionHookTimeoutSeconds: HOOK_TIMEOUT_SECONDS,
      });
      session.sendTurn('run: echo hello, and tell me the output');

      const seen: ClaudeRuntimeEvent[] = [];
      let requestedAt: number | undefined;
      let resolvedOutcome: string | undefined;
      let resolvedAfterMs: number | undefined;

      // Generous relative to the 10s hook timeout, so a failure here means "no timeout fired",
      // not "the deadline was tight".
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && resolvedOutcome === undefined) {
        for (const event of await session.pump()) {
          seen.push(event);
          if (event.type === 'permission_requested') {
            // DELIBERATELY NOT ANSWERED. Answering, interrupting or closing here would resolve the
            // request through a different producer and the test would prove nothing about the CLI.
            requestedAt = Date.now();
          }
          if (event.type === 'permission_resolved') {
            resolvedOutcome = event.outcome;
            resolvedAfterMs = requestedAt === undefined ? undefined : Date.now() - requestedAt;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(
        requestedAt !== undefined,
        `no permission_requested arrived, so the hook never ran and this test proves nothing about the timeout. Saw: ${JSON.stringify(seen.map((e) => e.type))}`,
      );
      assert.equal(
        resolvedOutcome,
        'expired',
        `expected the CLI's hook timeout to produce 'expired'; got ${String(resolvedOutcome)}. Saw: ${JSON.stringify(seen.map((e) => e.type))}`,
      );

      // The outcome alone does not prove WHICH producer fired -- `expired` is also what an
      // interrupt-driven abort emits. Nothing here interrupts, and the elapsed time pins it to the
      // configured timeout rather than to some other abort: comfortably after it, and nowhere near
      // the CLI default, which is known only to exceed 60s.
      assert.ok(
        resolvedAfterMs !== undefined && resolvedAfterMs >= HOOK_TIMEOUT_SECONDS * 1000 * 0.5,
        `resolved after ${String(resolvedAfterMs)}ms, too fast to be the ${HOOK_TIMEOUT_SECONDS}s hook timeout -- something else aborted this request`,
      );
      assert.ok(
        resolvedAfterMs !== undefined && resolvedAfterMs < 60_000,
        `resolved after ${String(resolvedAfterMs)}ms, which is past the floor of the CLI's own default -- the configured timeout may not have been honoured at all`,
      );

      console.log(
        `[Q3] permission_resolved outcome=${String(resolvedOutcome)} after ${String(resolvedAfterMs)}ms with a ${HOOK_TIMEOUT_SECONDS}s configured hook timeout`,
      );
    } finally {
      if (session) {
        session.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
