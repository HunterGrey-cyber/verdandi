import { createSession, resolveAccount, type ClaudeAccount } from '@verdandi/claude-runtime';
import { startSidecar } from './lifecycle.js';
import {
  getActualClaudeCodeVersion,
  getSdkDeclaredClaudeCodeVersion,
  resolveClaudeCliPath,
  sdkBundledAvailable,
  buildKernelSessionConfig,
  type ClaudeSessionConfigLike,
} from './runtimeServiceImpl.js';
import { classifyCliVersion, strictModeFromEnv } from './cliCompatibility.js';
import { versionReport } from './versionReport.js';
import { ringCapacityFromEnv, watchFaultInjectionFromEnv, writeQueueStatsFromEnv } from './replayConfig.js';
import { parentWatchFromEnv } from './parentWatch.js';
import { assertEgressRestricted, egressModeFromEnv, type EgressMode } from './egress.js';

// Before the socket check, so `--version` works on an artifact nobody has configured yet -- which is
// the case it exists for: answering "which Node, which SDK, which CLI range is in this binary?" for
// one already sitting in a mirror. See versionReport.ts.
if (process.argv.includes('--version')) {
  console.log(versionReport({ sdkBundledAvailable: sdkBundledAvailable() }));
  process.exit(0);
}

/** Read through a function so the narrowing survives into `main()` below -- a bare module-level
 * `const` plus an `if (... === undefined)` guard does not narrow inside a later function body. */
function requireSocketPath(): string {
  const value = process.env.VERDANDI_CLAUDE_SIDECAR_SOCKET;
  if (value === undefined) {
    console.error('VERDANDI_CLAUDE_SIDECAR_SOCKET must be set');
    process.exit(1);
  }
  return value;
}

const socketPath = requireSocketPath();

/**
 * Resolved once, here, rather than per session: which local Claude account every spawned subprocess
 * authenticates as is a property of this process, and resolving it per session would let two
 * sessions in one sidecar disagree. Unset (`VERDANDI_CLAUDE_ACCOUNT` absent) is the shipped default
 * and means nothing is pinned -- no `env` override reaches the SDK and the subprocess behaves like
 * a plain `claude` install.
 *
 * Failing here, before the socket is even bound, is deliberate: a pinned-but-unusable account
 * (directory missing, or present but not logged in) otherwise surfaces as an authentication error
 * inside the first real job, long after the cause.
 */
let account: ClaudeAccount | undefined;
try {
  account = resolveAccount();
} catch (error) {
  console.error(`claude account configuration is unusable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.error(
  account === undefined
    ? 'claude account: not pinned (inheriting the host environment)'
    : `claude account: ${account.name} (${account.configDir}${account.defaultLocation === true ? ', the CLI default location' : ''})`,
);

/** Read before anything is bound, like the account: a misspelt value refuses to boot. */
let egressMode: EgressMode;
try {
  egressMode = egressModeFromEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

/** Resolved once, and used for both the version gate below and every `executable: 'host_cli'`
 * session -- so the binary this process certified is the binary it goes on to run. */
const hostCliPath = resolveClaudeCliPath();

/** Whether this build can spawn the CLI inside the agent SDK's npm package at all -- false in a
 * packaged single-file build, which has no node_modules for the SDK to resolve through. */
const canRunSdkBundled = sdkBundledAvailable();

// Wrapped in a function rather than left as a top-level `await` so this entry can be bundled to
// CommonJS, which is what Node's single-executable-application format takes (esbuild refuses
// top-level await under `--format=cjs` outright). The catch is not decoration: an unhandled
// top-level rejection is what previously turned a startup refusal into a nonzero exit with the
// reason on stderr, and a host waiting on the socket has nothing else to read.
async function main(): Promise<void> {
  // Proven before the socket is bound, so a sidecar that would advertise egress_restricted without
  // being restricted never accepts a connection at all.
  if (egressMode === 'restricted') {
    await assertEgressRestricted();
    console.error('egress: restricted (verified at startup: 127.0.0.1 is unreachable from this process)');
  }
  await startSidecar({
    socketPath,
    // The whole request -> kernel-config mapping is `buildKernelSessionConfig`, in
    // src/runtimeServiceImpl.ts, not an inline object literal here. It used to be one, and a field
    // dropped in it (resume, until 2026-09-11) was invisible to every test in the repository, because
    // this module's own top-level `await startSidecar(...)` makes it unimportable from a test. Keeping
    // the body over there is what lets tests/policyTotality.test.ts assert that no policy field is
    // accepted on the wire and then dropped on the floor -- through the PRODUCTION factory rather
    // than a test-local copy of it. Do not inline this again.
    sessionFactory: (config: ClaudeSessionConfigLike) =>
      createSession(buildKernelSessionConfig(config, { account, hostCliPath })),
    // The host CLI is probed through the SAME resolved path every `host_cli` session is pointed at,
    // so the binary this process classifies is the binary it goes on to run.
    getClaudeCodeVersions: () => ({ sdkDeclared: getSdkDeclaredClaudeCodeVersion(), hostCli: getActualClaudeCodeVersion(hostCliPath) }),
    // Strict mode (VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION=1) restores the old exact-match
    // behavior, for CI and release validation where "it started, but on an untested CLI" should be a
    // hard failure rather than a warning. Off by default: a developer's or user's routine Claude Code
    // patch update must not take the Agent pane offline.
    classifyCliVersion: (version) => classifyCliVersion(version, { strict: strictModeFromEnv() }),
    // Read here, at the composition root, so a malformed value refuses to boot rather than failing
    // the first session that needs it. `watchFault` is a test seam and is absent unless its variable
    // is set -- see replayConfig.ts for what it does and why it deliberately leaves the session alive.
    // Resolved once, here, and handed to both the startup gate and the service -- so the binaries this
    // process classifies at boot are exactly the binaries it will accept a request for. A build that
    // advertised one set and gated another is the same "measure one thing, run another" defect
    // resolveClaudeCliPath exists to close one layer down.
    sdkBundledAvailable: canRunSdkBundled,
    // VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: `none` under a service manager, whose /dev/null stdin
    // would otherwise read as "the host is gone" the instant the process starts. See parentWatch.ts.
    parentWatch: parentWatchFromEnv(),
    runtime: {
      ringBufferCapacity: ringCapacityFromEnv(),
      watchFault: watchFaultInjectionFromEnv(),
      writeQueueStats: writeQueueStatsFromEnv(),
      sdkBundledAvailable: canRunSdkBundled,
      // The same `account` sessionFactory pins every session to, so Handshake reports the binding
      // the sessions really have. Undefined (VERDANDI_CLAUDE_ACCOUNT unset) reports UNPINNED.
      account,
      egressRestricted: egressMode === 'restricted',
    },
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
