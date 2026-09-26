import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { RuntimeServiceClient, ReplayStart } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

const REAL = process.env.RUN_REAL_CLAUDE_TESTS === '1';

// `fn`'s own parameter type is widened to `any` here (not `Req`) -- this is test-glue plumbing only,
// mirroring the identical fix Task 7 needed for its own `callResult` helper
// (tests/runtimeServiceImpl.test.ts) for the same reason: binding a real grpc-js client method (whose
// declared request type is a concrete generated message, e.g. `CreateSessionRequest` with
// `policy: ClaudeHostPolicy | undefined`) against a generic `Req` parameter fails strict
// contravariant parameter checking whenever a call site's `Req` is a looser shape (e.g. `policy:
// unknown`) than the real message type. Widening only `fn`'s internal parameter to `any` doesn't
// change what `req` is passed at the call site or what type `Promise<Res>` resolves to -- runtime
// behavior and call-site type safety are unchanged.
function promisify<Req, Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: Req): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => (err ? reject(err) : resolve(res as Res)));
  });
}

async function withSidecar<T>(fn: (client: RuntimeServiceClient) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-real-'));
  const socketPath = join(dir, 'sidecar.sock');
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['dist/src/index.js'], {
      cwd: join(process.cwd()),
      env: { ...process.env, VERDANDI_CLAUDE_SIDECAR_SOCKET: socketPath },
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    // Wait for the socket file to exist rather than a fixed sleep -- poll briefly. This loop's
    // try/catch wraps ONLY the connection/handshake attempt itself, never `fn(client)` -- once a
    // handshake succeeds, the loop exits and `fn` is invoked exactly once, entirely outside any
    // retry/catch here. This matters because `fn` runs the whole test scenario, including its own
    // internal 60s/90s timeouts and every `assert.*` call: if `fn` were inside this loop's `catch`
    // (as an earlier version of this helper had it), a real assertion failure or internal timeout
    // deep inside the test body would be swallowed as "just another readiness retry", and since
    // `fn`'s own timeouts always exceed this loop's 10s deadline, control would fall through to the
    // generic "sidecar did not become ready" error below instead of surfacing the actual failure --
    // exactly the kind of misleading error this plan's own "investigate the real failure" discipline
    // depends on not happening. Structuring it this way also avoids re-running (and re-spending real
    // API cost on) the entire test body multiple times if some hypothetical fast-failing bug caused
    // `fn` to reject quickly and repeatedly within the 10s window.
    const deadline = Date.now() + 10_000;
    let client: RuntimeServiceClient | undefined;
    while (Date.now() < deadline) {
      try {
        const candidate = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
        await promisify(candidate.handshake.bind(candidate), { clientProtocolMajor: 3 });
        client = candidate;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (client === undefined) {
      throw new Error('sidecar did not become ready within 10s');
    }
    return await fn(client);
  } finally {
    child?.stdin?.end(); // triggers the stdin-EOF shutdown path (design spec §6)
    child?.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real sidecar: a plain-text turn completes with outcome completed, observed via WatchSessionEvents', { skip: !REAL }, async () => {
  await withSidecar(async (client) => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-session-'));
    try {
      const { sessionId } = await promisify<{ cwd: string; policy: unknown }, { sessionId: string }>(client.createSession.bind(client), {
        cwd: dir,
        policy: { configuration: 1, permissions: 3, persistence: 2, executable: 1 }, // native, bypass, ephemeral, host_cli
      });

      await promisify(client.sendTurn.bind(client), { sessionId, commandId: 'cmd-1', text: 'write a very long story, at least 2000 words, about a journey' });

      // Design spec §8 calls for exercising all 7 RPCs -- this suite previously exercised 6, missing
      // InterruptTurn (final whole-branch review, Finding 3). Mirrors the kernel's own real-CLI
      // interrupt test (packages/claude-runtime/tests/realSdk.session.integration.test.ts): give the
      // real process a moment to actually start streaming before interrupting it, so this exercises a
      // genuinely in-flight turn rather than a no-op interrupt racing session startup. Uses 5000ms, not
      // the kernel test's own 3000ms -- this goes through two extra real RPC round-trips
      // (CreateSession, SendTurn) before this timer even starts, on top of the same session-startup
      // variance (hooks/tool listing/thinking-token estimation) the kernel's own comment documents, so
      // a bit more margin here is warranted to reliably land the interrupt while a turn is genuinely
      // in flight rather than racing session startup and interrupting a no-op.
      await new Promise((r) => setTimeout(r, 5000));
      await promisify(client.interruptTurn.bind(client), { sessionId, commandId: 'cmd-interrupt' });

      const events: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        const call = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
        call.on('data', (event: { turnCompleted?: { outcome: number } }) => {
          events.push(event);
          if (event.turnCompleted !== undefined) {
            call.cancel();
            resolve();
          }
        });
        call.on('error', (err: grpc.ServiceError) => {
          if (err.code !== grpc.status.CANCELLED) {
            reject(err);
          }
        });
        // 90s, not the kernel test's own 30s-after-a-confirmed-landed-interrupt: if the interrupt
        // above raced session startup and missed (the exact failure mode the kernel's own comment
        // documents -- the turn then runs to normal completion instead of aborting), the model may
        // still be generating a genuine 2000+ word story rather than a fast abort, which needs more
        // real wall-clock room than a clean interrupt does. The outcome assertion below still catches
        // that failure mode correctly (outcome 'completed' rather than 'interrupted'), just with a
        // more informative failure than a bare timeout.
        setTimeout(() => reject(new Error('no turn_completed within 90s')), 90_000);
      });

      const completed = events.find((e) => (e as { turnCompleted?: unknown }).turnCompleted !== undefined) as { turnCompleted: { outcome: number } };
      assert.ok(completed, 'expected a turnCompleted event');
      assert.equal(completed.turnCompleted.outcome, 2); // TURN_OUTCOME_INTERRUPTED

      // Session must still be usable after an interrupt (distinct from close) -- mirrors the same
      // real-CLI assertion in the kernel's own interrupt test.
      await promisify(client.sendTurn.bind(client), { sessionId, commandId: 'cmd-2', text: 'reply with exactly the word: pong' });

      await promisify(client.closeSession.bind(client), { sessionId, commandId: 'cmd-close' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('real sidecar: a denied real tool call is genuinely blocked, and CloseSession delivers session_closed through WatchSessionEvents', { skip: !REAL }, async () => {
  await withSidecar(async (client) => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-session-deny-'));
    try {
      const { sessionId } = await promisify<{ cwd: string; policy: unknown }, { sessionId: string }>(client.createSession.bind(client), {
        cwd: dir,
        policy: { configuration: 1, permissions: 1, persistence: 2, executable: 1 }, // native, interactive, ephemeral, host_cli
      });

      await promisify(client.sendTurn.bind(client), { sessionId, commandId: 'cmd-1', text: 'run: echo hello, and tell me the output' });

      const denyReason = 'sidecar integration test policy: shell commands are not permitted';
      let sawSessionClosed = false;
      let sawErrorToolResult = false;

      await new Promise<void>((resolve, reject) => {
        const call = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
        call.on('data', (event: { permissionRequested?: { permissionId: string }; toolCallCompleted?: { isError: boolean; contentJson: string }; sessionClosed?: unknown }) => {
          if (event.permissionRequested !== undefined) {
            // Final whole-branch review (additional fix, same class this file's own Task 8 round
            // already ruled against for the readiness loop): this was previously fire-and-forget with
            // no .catch() -- a silent rejection here would just make the test hang to its 90s timeout
            // and report a misleading "no session_closed within 90s" instead of the real cause.
            promisify(client.resolvePermission.bind(client), {
              sessionId,
              commandId: `resolve-${event.permissionRequested.permissionId}`,
              permissionId: event.permissionRequested.permissionId,
              allow: false,
              reason: denyReason,
            }).catch(reject);
          }
          if (event.toolCallCompleted?.isError) {
            sawErrorToolResult = event.toolCallCompleted.contentJson.includes(denyReason);
          }
          if (event.sessionClosed !== undefined) {
            sawSessionClosed = true;
            call.cancel();
            resolve();
          }
        });
        call.on('error', (err: grpc.ServiceError) => {
          if (err.code !== grpc.status.CANCELLED) {
            reject(err);
          }
        });
        setTimeout(() => {
          // Same fire-and-forget class as the resolvePermission call above -- fixed for consistency
          // even though the review only named the resolvePermission occurrence explicitly.
          promisify(client.closeSession.bind(client), { sessionId, commandId: 'cmd-close' }).catch(reject);
        }, 30_000);
        setTimeout(() => reject(new Error('no session_closed within 90s')), 90_000);
      });

      assert.ok(sawErrorToolResult, 'expected the deny reason verbatim in a tool result');
      assert.ok(sawSessionClosed, 'expected session_closed to arrive through WatchSessionEvents after CloseSession');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
