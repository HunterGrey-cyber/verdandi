import * as grpc from '@grpc/grpc-js';
import * as net from 'node:net';
import { mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { SessionRegistry } from './sessionRegistry.js';
import { createRuntimeServiceImpl, sdkBundledAvailable, type ClaudeCodeVersions, type ClaudeSessionConfigLike, type RuntimeServiceOptions } from './runtimeServiceImpl.js';
import type { MinimalKernelSession } from './sessionRegistry.js';
import { SidecarError } from './errorMapping.js';
import { RuntimeServiceService, ErrorCode } from './generated/verdandi/claude/runtime/v1/runtime.js';
import type { CliVersionVerdict } from './cliCompatibility.js';
import type { ParentWatch } from './parentWatch.js';
import { DEFAULT_CHILD_SHUTDOWN_TIMINGS, endChildProcesses, type ChildShutdownDeps, type ChildShutdownTimings } from './childReaper.js';

export type StartSidecarOptions = {
  socketPath: string;
  sessionFactory: (config: ClaudeSessionConfigLike) => MinimalKernelSession;
  /** BOTH binaries `ClaudeHostPolicy.executable` can pick, because both are reachable from a single
   * client request. See `ClaudeCodeVersions`. */
  getClaudeCodeVersions: () => ClaudeCodeVersions;
  /**
   * Classifies ONE observed CLI version against this sidecar's compatibility policy. Applied
   * separately to each of the two binaries above. Replaces the earlier
   * `isTestedCliVersion: (version) => boolean`, which could only express "start" or "refuse" --
   * there was no way to say "inside the supported range but not yet tested: start, and say so",
   * which is exactly what a routine Claude Code patch update produces. See `cliCompatibility.ts`
   * for the policy and for why an exact-match gate was too tight.
   */
  classifyCliVersion: (version: string) => CliVersionVerdict;
  /**
   * Whether this build can serve `executable: 'sdk_bundled'`. Defaults to the real runtime answer
   * (`sdkBundledAvailable()`), and index.ts passes it explicitly so the gate below and
   * `validatePolicy` cannot disagree about it.
   *
   * It gates the CLASSIFICATION, not just the policy. The sdk-bundled CLI version is baked in at
   * build time, so a build whose SDK happens to ship a CLI outside the supported range would
   * otherwise refuse to boot over a binary it could never have spawned -- taking `host_cli`, the
   * only path it can serve, down with it.
   */
  sdkBundledAvailable?: boolean;
  /**
   * Where a non-fatal compatibility diagnostic goes. Defaults to `console.warn` (stderr), which is
   * what a host process spawning this sidecar drains and can surface to a user. Injectable so the
   * untested-but-supported path can be tested for what it actually emits, rather than only for the
   * fact that it did not throw.
   */
  onDiagnostic?: (message: string) => void;
  /**
   * Per-deployment runtime configuration: event-buffer capacity, and the watch fault seam.
   *
   * Injected rather than read from `process.env` down inside the service, for the same reason
   * `classifyCliVersion` is: a value parsed at the composition root fails the whole boot when it is
   * malformed, instead of failing the first session that happens to need it.
   */
  runtime?: RuntimeServiceOptions;
  /**
   * `stdin` (default): stdin EOF means the spawning host is gone, so shut down. `none`: stdin is not
   * read at all and only SIGTERM/SIGINT stop the process -- for a service manager, which starts it
   * with stdin on /dev/null. See parentWatch.ts.
   */
  parentWatch?: ParentWatch;
  /**
   * How shutdown ends this process's `claude` children before it lets the process go (see
   * childReaper.ts). Defaults to DEFAULT_CHILD_SHUTDOWN_TIMINGS and the real process table;
   * injectable so a test can shorten the waits or observe the signals.
   */
  childShutdown?: Partial<ChildShutdownTimings> & ChildShutdownDeps;
};

/**
 * The most bytes `sockaddr_un.sun_path` can hold for a path, excluding its NUL terminator -- 108 on
 * Linux, 104 on macOS/BSD, per `<sys/un.h>`. It is a fixed-size byte buffer, not a string, so this
 * is a byte budget: a path of 60 CJK characters overflows it while looking short.
 *
 * Written as a constant rather than probed, deliberately. A probe would have to bind, which is
 * exactly the operation that misreports here -- an attempt to measure it in a sandbox returned "ok"
 * for every length up to 114, which is how a check derived from a probe would end up permitting the
 * bug it exists to catch. `chmodBoundSocket` below is the backstop that does not depend on this
 * number being right.
 */
export const SUN_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;

/**
 * Refuses a socket path that cannot fit in the address structure, before anything tries to bind it.
 *
 * Found by the consumer running the packaged artifact for the first time (2026-09-18) with a
 * 114-byte path: the bind produced no socket, and this process then died at `chmodSync` with
 * `ENOENT: no such file or directory, chmod '<path>'` and a raw Node stack. The path in that message
 * is correct and the file really is absent, so the message is true and sends the reader at the
 * filesystem -- while the actual cause, path length, appears nowhere. A packaged product handed a
 * long TMPDIR reaches this on a user's machine, where nobody can add a console.log.
 */
export function assertBindableSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > SUN_PATH_LIMIT) {
    throw new Error(
      `refusing to bind ${socketPath}: the path is ${bytes} bytes and a unix socket address holds at most ${SUN_PATH_LIMIT} on this platform. Binding it produces no socket and no error -- choose a shorter directory (VERDANDI_CLAUDE_SIDECAR_SOCKET, or a shorter TMPDIR).`,
    );
  }
}

/**
 * Tightens the bound socket to 0600, and turns "bind reported success and there is no socket" into a
 * statement of that rather than a bare `ENOENT` about a chmod.
 *
 * This is the half that cannot be wrong: it makes no assumption about WHY the socket is missing, so
 * it also covers a directory that vanished between prepare and bind, a limit this platform measures
 * differently than `SUN_PATH_LIMIT` says, and a sandbox that intercepts bind. grpc-js's `bindAsync`
 * can call back with no error for a bind that produced nothing, which is the only reason this
 * situation is reachable at all.
 */
export function chmodBoundSocket(socketPath: string): void {
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `bind reported success but no socket exists at ${socketPath} (${Buffer.byteLength(socketPath)} bytes). Nothing is listening and no client can connect. Most often the path exceeds this platform's unix socket address limit of ${SUN_PATH_LIMIT} bytes; it can also mean the directory was removed after it was prepared.`,
      );
    }
    throw error;
  }
}

/**
 * The three ways this process is asked to stop, each announcing which one it was before it acts.
 *
 * All three used to exit 0 in silence. That is correct behaviour and unreadable output: a host that
 * does NOT hold stdin open gets a clean exit 0 the instant it stops writing, which is
 * indistinguishable from a successful start that then vanished. The consumer lost an hour to this
 * with "packaging regression" as its leading hypothesis, and only a control killed it.
 *
 * Extracted and injected rather than closed over `process` so the announcement is testable without a
 * test that would have to exit its own runner.
 */
export function makeShutdownTriggers(deps: {
  shutdown: () => Promise<void>;
  emitDiagnostic: (message: string) => void;
  exit: (code: number) => void;
}): { onSigterm: () => Promise<void>; onSigint: () => Promise<void>; onStdinEnd: () => Promise<void> } {
  // Emitted BEFORE the shutdown, not after: a shutdown that hangs (a session that will not close, a
  // watcher mid-broadcast) is exactly when a reader most needs to know what asked for it.
  const stopFor = async (reason: string): Promise<void> => {
    deps.emitDiagnostic(`claude-sidecar: ${reason}, shutting down`);
    await deps.shutdown();
    deps.exit(0);
  };
  return {
    onSigterm: () => stopFor('received SIGTERM'),
    onSigint: () => stopFor('received SIGINT'),
    onStdinEnd: () => stopFor('stdin reached EOF (the host that spawned this process closed it, or never held it open)'),
  };
}

/**
 * Probes whether an existing socket file still has a live listener behind it, by attempting a real
 * connection -- ECONNREFUSED (or ENOENT, if it vanished between the existsSync check and now) means
 * stale and safe to remove; a successful connect means something is actually listening, which this
 * function must never delete out from under. Never used on any path other than the one exact
 * socketPath this process is about to bind -- this is verification, not permission to delete broadly.
 */
function isStaleSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => resolve(true));
  });
}

/**
 * Creates the UDS directory (0700) and removes a stale socket file if present (design spec §6 --
 * this is a deliberate stand-in for the Rust host's own §12.1 responsibility, taken over only
 * because there's no real host to spawn this process yet). Verifies staleness via a real connect
 * attempt (design spec §6's "校验其 owner/lock 状态后再决定是否清理") rather than deleting on sight,
 * and refuses to proceed if something is genuinely still listening.
 */
async function prepareSocketPath(socketPath: string): Promise<void> {
  // First, before mkdir and before the staleness probe: a path that cannot be bound at all should
  // say so, not proceed to create a directory for a socket that will never exist.
  assertBindableSocketPath(socketPath);
  const dir = dirname(socketPath);
  // mkdirSync's return value is the first path segment it actually created, or `undefined` if `dir`
  // already existed in full -- only forcibly chmod the directory when we know we're the one who just
  // created it. Final whole-branch review, Finding 7: an unconditional chmodSync here would
  // forcibly re-permission a directory this sidecar didn't create (e.g. a shared `/tmp`), which as
  // root could break the rest of the system relying on it, or as a normal user could crash on EPERM.
  // A pre-existing directory's permissions are left exactly as they were.
  const firstCreatedDir = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (firstCreatedDir !== undefined) {
    chmodSync(dir, 0o700);
  }
  if (existsSync(socketPath)) {
    if (!(await isStaleSocket(socketPath))) {
      throw new Error(`refusing to bind ${socketPath}: another process is already listening on it`);
    }
    unlinkSync(socketPath);
  }
}

export async function startSidecar(options: StartSidecarOptions): Promise<{ close(): Promise<void> }> {
  // Final whole-branch review, Finding 1: the CLI-version-tested check is a fixed property of this
  // process's environment for its entire lifetime, unlike client_protocol_major (a genuinely
  // per-connection concern, checked in Handshake below where it belongs). Checking it only inside
  // Handshake() left any client that skips Handshake and goes straight to CreateSession getting full
  // service on an untested CLI, contradicting the design's own "fail closed" framing. Resolve it
  // exactly once, here, before the server ever binds -- an untested CLI keeps the whole process from
  // booting at all, rather than silently serving requests on it. This also means Handshake never
  // needs to spawn `claude --version` again on every call (see createRuntimeServiceImpl's own doc
  // comment for the related event-loop-stall Minor this also fixes for free).
  //
  // TWO things merged here; dropping either one is a regression.
  //
  // (1) Both binaries are gated, not just one. `ClaudeHostPolicy.executable` picks between the CLI
  // the SDK ships and the CLI installed on the machine, and on a real host those are different
  // programs at different versions -- so checking only one leaves the other free to run untested.
  // Either is reachable from a single client request (`host_cli` is what the default policy and an
  // unset proto enum both mean), which is why this is a startup gate on both rather than a
  // per-session check.
  //
  // (2) The check is no longer "is this version in a hardcoded tested set". That gate refused to
  // boot on any CLI patch bump, and -- because a refusal happens before the socket is ever bound --
  // a host process waiting for that socket saw only a connect timeout, with the real cause visible
  // nowhere but this process's stderr. The verdict keeps the fail-closed principle for genuinely
  // out-of-range versions while letting an in-range, untested patch start with a diagnostic instead
  // of a wall. See cliCompatibility.ts.
  //
  // A refusal on EITHER binary still refuses the whole process: there is no per-session fallback,
  // so a sidecar that booted with one usable binary would fail the first request that asked for the
  // other, at a point where the cause is no longer visible.
  const cachedClaudeCodeVersions = options.getClaudeCodeVersions();
  const emitDiagnostic = options.onDiagnostic ?? ((message: string) => console.warn(message));
  const watchStdin = (options.parentWatch ?? 'stdin') === 'stdin';
  const canRunSdkBundled = options.sdkBundledAvailable ?? sdkBundledAvailable();
  const classified = (
    [
      // (3) Only the binaries this build can actually spawn. In a packaged build `sdk_bundled` is
      // unreachable -- validatePolicy refuses it at CreateSession -- so classifying its CLI version
      // could only ever produce a refusal for a program that was never going to run.
      ...(canRunSdkBundled ? ([['sdk-bundled', cachedClaudeCodeVersions.sdkDeclared]] as const) : []),
      ['host', cachedClaudeCodeVersions.hostCli],
    ] as const
  ).map(([which, version]) => ({ which, version, verdict: options.classifyCliVersion(version) }));
  const refused = classified.filter((entry) => entry.verdict.kind === 'refused');
  if (refused.length > 0) {
    throw new Error(
      `refusing to start: ${refused
        .map((entry) => `${entry.which} claude CLI version ${entry.version}: ${(entry.verdict as { diagnostic: string }).diagnostic}`)
        .join(' and ')}`,
    );
  }
  for (const entry of classified) {
    if (entry.verdict.kind === 'untested') {
      emitDiagnostic(`claude-sidecar: ${entry.which} CLI version diagnostic: ${entry.verdict.diagnostic}`);
    }
  }

  await prepareSocketPath(options.socketPath);

  const registry = new SessionRegistry();
  let shuttingDown = false;
  const impl = createRuntimeServiceImpl(
    registry,
    (config) => {
      if (shuttingDown) {
        // Routed through SidecarError (final whole-branch review, Finding 6), not a bare Error, so it
        // flows through createSession's own catch -- and from there toServiceError -- like every other
        // domain error, rather than reaching the client as an unmapped UNKNOWN with no ErrorDetail.
        throw new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE, 'sidecar is shutting down, not accepting new sessions');
      }
      return options.sessionFactory(config);
    },
    cachedClaudeCodeVersions,
    options.runtime ?? {},
  );

  const server = new grpc.Server();
  server.addService(RuntimeServiceService, impl as grpc.UntypedServiceImplementation);
  // Cheap, codegen-derived compile-time check for a handler-name/shape mismatch (final whole-branch
  // review, Finding 10) that the addService cast above can't catch on its own: assigning `impl` to a
  // type whose keys are exactly RuntimeServiceService's own handler names fails to compile if `impl`
  // is missing (or has renamed) any handler -- without requiring createRuntimeServiceImpl's return
  // type to satisfy RuntimeServiceServer's much more concrete request/response types (confirmed: it
  // doesn't -- 7 real type errors result from attempting that directly). Unused beyond the
  // assignability check itself.
  const _allHandlersPresent: Record<keyof typeof RuntimeServiceService, unknown> = impl;

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`unix://${options.socketPath}`, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        // grpc-js can call back with no error for a bind that produced nothing, so this is where a
        // missing socket is actually discovered. See chmodBoundSocket.
        chmodBoundSocket(options.socketPath);
      } catch (chmodError) {
        reject(chmodError);
        return;
      }
      resolve();
    });
  });

  // The one shutdown in progress, if any. A second trigger (SIGTERM arriving while stdin EOF's shutdown
  // is still waiting for the CLIs, say -- a host closing a window can easily do both) must wait for the
  // SAME shutdown to finish: returning early let its caller reach process.exit() while the first was
  // still ending the children, which is precisely the order this shutdown exists to guarantee.
  let shutdownInProgress: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shutdownInProgress ??= runShutdown();
    return shutdownInProgress;
  }

  async function runShutdown(): Promise<void> {
    shuttingDown = true;
    for (const sessionId of registry.allSessionIds()) {
      registry.get(sessionId)?.session.close();
    }
    // Wait for every session's PumpDriver to actually observe and broadcast the resulting
    // session_closed event and evict its registry entry (design spec §3.1/§3.2's unified termination
    // path) before shutting the server down -- otherwise a watcher never receives the terminal event
    // it was promised, and the process could exit mid-broadcast.
    const deadline = Date.now() + 5000;
    while (registry.allSessionIds().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Then the CLIs themselves, before anything lets this process exit. Closing a session only ends
    // its CLI's stdin: the SDK's own SIGTERM/SIGKILL follow-up runs on unref'd timers, which die with
    // this process, so a sidecar that exited here left a running CLI reparented to init (measured
    // downstream: ~2.4 s, mid-turn). Waiting for them keeps the order the host can see: every child
    // gone, then the sidecar. See childReaper.ts.
    const { listChildren, kill, onDiagnostic, ...timings } = options.childShutdown ?? {};
    await endChildProcesses(
      { ...DEFAULT_CHILD_SHUTDOWN_TIMINGS, ...timings },
      { listChildren, kill, onDiagnostic: onDiagnostic ?? emitDiagnostic },
    );
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    // Undo the process-level state registered below -- without this, a caller that invokes close()
    // directly (rather than following it with process.exit(), as this file's own real signal handlers
    // below always do) would find the process/worker can never become idle on its own afterward: a
    // resumed stdin and un-removed signal listeners both keep Node's event loop alive indefinitely.
    // Harmless for the real production path (index.ts), which always calls process.exit() right after
    // shutdown() resolves regardless of this -- this only matters for a caller that expects the
    // process to actually return to a clean, exit-able state after close(), like a fake-driven
    // in-process test (final whole-branch review, Finding 2's realWire.test.ts, which discovered this
    // gap directly: without it, that test's own process hung forever after both its tests passed).
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    if (watchStdin) {
      process.stdin.off('end', onStdinEnd);
      process.stdin.pause();
    }
  }

  // Each announces which of the three it was before acting -- all three used to exit 0 in silence,
  // which reads exactly like a process that started successfully and then vanished.
  const triggers = makeShutdownTriggers({ shutdown, emitDiagnostic, exit: (code) => process.exit(code) });
  const onSigterm = (): void => void triggers.onSigterm();
  const onSigint = (): void => void triggers.onSigint();
  const onStdinEnd = (): void => void triggers.onStdinEnd();

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  if (watchStdin) {
    process.stdin.on('end', onStdinEnd); // simplified stand-in for the Rust host's future
    // parent-death/watchdog-pipe protocol (design spec §6) -- there is no real Rust host to define that
    // protocol with yet; remove this handler once Phase 6 introduces one.
    process.stdin.resume();
  } else {
    // Said once at startup, so a journal that later shows no "stdin reached EOF" line is read as
    // "not watched", not as "never happened".
    emitDiagnostic('claude-sidecar: parent watch is off (VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH=none): stdin is not read; stop this process with SIGTERM');
  }

  return { close: shutdown };
}
