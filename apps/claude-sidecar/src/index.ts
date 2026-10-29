import { createSession, describeExtraMcpServers, EXTRA_MCP_SERVERS_VARIABLE, resolveExtraMcpServers, taskOutputReadable, type ClaudeAccount } from '@verdandi/claude-runtime';
import { resolveAccount } from './legacyAccountName.js';
import { startSidecar } from './lifecycle.js';
import {
  CliProbeError,
  getActualClaudeCodeVersion,
  getSdkDeclaredClaudeCodeVersion,
  resolveClaudeCliPath,
  sdkBundledAvailable,
  buildKernelSessionConfig,
  type ClaudeSessionConfigLike,
} from './runtimeServiceImpl.js';
import { classifyCliVersion, cliGateModeFromEnv, strictModeFromEnv, type CliGateMode } from './cliCompatibility.js';
import { versionReport, versionReportJson } from './versionReport.js';
import { ringCapacityFromEnv, watchFaultInjectionFromEnv, writeQueueStatsFromEnv } from './replayConfig.js';
import { parentWatchFromEnv } from './parentWatch.js';
import { assertEgressRestricted, egressModeFromEnv, type EgressMode } from './egress.js';
import { accountRefusal } from './accountRefusal.js';
import { exitRefused, parseEnvVariable, StartupRefusal, startupReporterFromEnv } from './startupReport.js';

// Before the socket check, so `--version` works on an artifact nobody has configured yet -- which is
// the case it exists for: answering "which Node, which SDK, which CLI range is in this binary?" for
// one already sitting in a mirror. See versionReport.ts.
if (process.argv.includes('--version')) {
  const options = { sdkBundledAvailable: sdkBundledAvailable() };
  console.log(process.argv.includes('--json') ? versionReportJson(options) : versionReport(options));
  process.exit(0);
}

/**
 * Every refusal below is thrown as a value and ends in `exitRefused`, which prints the text a host has
 * always seen on stderr, writes the same refusal to the report file when `VERDANDI_CLAUDE_SIDECAR_REPORT_FILE`
 * names one, and exits 1. Nothing before the socket is bound calls `process.exit` on its own: a second way
 * out is a refusal a host reading the file would never see (tests/startupReport.test.ts fails on one).
 */
const report = startupReporterFromEnv();

function requireSocketPath(): string {
  const value = process.env.VERDANDI_CLAUDE_SIDECAR_SOCKET;
  if (value === undefined) {
    throw new StartupRefusal('SOCKET_ENV_MISSING', 'VERDANDI_CLAUDE_SIDECAR_SOCKET must be set', { variable: 'VERDANDI_CLAUDE_SIDECAR_SOCKET' });
  }
  return value;
}

/** The host CLI's version, the way a refusal to start reports it: "no such program" and "the program refused" are different codes. */
function probeHostCli(cliPath: string): string {
  try {
    return getActualClaudeCodeVersion(cliPath);
  } catch (error) {
    if (error instanceof CliProbeError) {
      const { cliPath: path, spawnErrorCode, exitStatus, signal } = error.probe;
      throw new StartupRefusal(
        spawnErrorCode === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_PROBE_FAILED',
        error.message,
        {
          cli_path: path,
          ...(spawnErrorCode !== undefined ? { spawn_error_code: spawnErrorCode } : {}),
          ...(exitStatus !== undefined ? { exit_status: exitStatus } : {}),
          ...(signal !== undefined ? { signal } : {}),
        },
        error.sentenceWithoutOutput,
      );
    }
    throw error;
  }
}

// Wrapped in a function rather than left as a top-level `await` so this entry can be bundled to
// CommonJS, which is what Node's single-executable-application format takes (esbuild refuses
// top-level await under `--format=cjs` outright). The catch is not decoration: an unhandled
// top-level rejection is what previously turned a startup refusal into a nonzero exit with the
// reason on stderr, and a host waiting on the socket has nothing else to read.
async function main(): Promise<void> {
  const socketPath = requireSocketPath();

  /**
   * Resolved once, here, rather than per session: which local Claude account every spawned subprocess
   * authenticates as is a property of this process, and resolving it per session would let two
   * sessions in one sidecar disagree. The name-to-directory layout is `legacyAccountName`'s; the runtime
   * package only knows directories. Unset (`VERDANDI_CLAUDE_ACCOUNT` absent) is the shipped default
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
    throw accountRefusal(error);
  }
  console.error(
    account === undefined
      ? 'claude account: not pinned (inheriting the host environment)'
      : `claude account: ${account.name} (${account.configDir}${account.defaultLocation === true ? ', the CLI default location' : ''})`,
  );

  /**
   * The MCP servers every session of this process gets (the extra-MCP-servers
   * design note, with an http extension). Read once,
   * here, like the account and for the same reason: a malformed value -- or an http server whose
   * header variable is missing -- refuses to boot, naming the variable, instead of surfacing as a
   * failed tool inside the first real job. The line below names servers and types only: a command,
   * URL or header never reaches the log.
   */
  const extraMcpServers = parseEnvVariable(EXTRA_MCP_SERVERS_VARIABLE, () => resolveExtraMcpServers());
  if (extraMcpServers !== undefined) {
    console.error(`extra MCP servers: ${describeExtraMcpServers(extraMcpServers)}`);
  }

  /** Read before anything is bound, like the account: a misspelt value refuses to boot. */
  const egressMode: EgressMode = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_EGRESS', egressModeFromEnv, 'EGRESS_MODE_INVALID');

  /** Read before anything is bound, like the egress mode: a misspelt value refuses to boot. `report` is
   * the only value that lets a refused CLI through to a bound socket, so it must never be reached by a
   * typo. */
  const cliGate: CliGateMode = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_CLI_GATE', cliGateModeFromEnv);

  /** Resolved once, and used for both the version gate below and every `executable: 'host_cli'`
   * session -- so the binary this process certified is the binary it goes on to run. */
  const hostCliPath = resolveClaudeCliPath();

  /** Whether this build can spawn the CLI inside the agent SDK's npm package at all -- false in a
   * packaged single-file build, which has no node_modules for the SDK to resolve through. */
  const canRunSdkBundled = sdkBundledAvailable();

  // Proven before the socket is bound, so a sidecar that would advertise egress_restricted without
  // being restricted never accepts a connection at all.
  if (egressMode === 'restricted') {
    try {
      await assertEgressRestricted();
    } catch (error) {
      throw new StartupRefusal('EGRESS_PROOF_FAILED', error instanceof Error ? error.message : String(error), {
        variable: 'VERDANDI_CLAUDE_SIDECAR_EGRESS',
      });
    }
    console.error('egress: restricted (verified at startup: 127.0.0.1 is unreachable from this process)');
  }

  // Read here, at the composition root, so a malformed value refuses to boot rather than failing
  // the first session that needs it, and in the order the options below have always been built.
  // `watchFault` is a test seam and is absent unless its variable is set -- see replayConfig.ts for what
  // it does and why it deliberately leaves the session alive. `parentWatch`: `none` under a service
  // manager, whose /dev/null stdin would otherwise read as "the host is gone" the instant the process
  // starts -- see parentWatch.ts.
  const parentWatch = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH', parentWatchFromEnv);
  const ringBufferCapacity = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY', ringCapacityFromEnv);
  const watchFault = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER', watchFaultInjectionFromEnv);
  const writeQueueStats = parseEnvVariable('VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS', writeQueueStatsFromEnv);

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
      createSession(buildKernelSessionConfig(config, { account, hostCliPath, extraMcpServers })),
    // The host CLI is probed through the SAME resolved path every `host_cli` session is pointed at,
    // so the binary this process classifies is the binary it goes on to run.
    //
    // In the default mode a CLI that cannot be probed throws here, before anything is bound: the
    // refusal a host has always seen. Only `report` turns the failure into a verdict (UNKNOWN) so the
    // process can bind and let the host decide.
    getClaudeCodeVersions: () => {
      const sdkDeclared = getSdkDeclaredClaudeCodeVersion();
      if (cliGate !== 'report') {
        return { sdkDeclared, hostCli: probeHostCli(hostCliPath) };
      }
      try {
        return { sdkDeclared, hostCli: getActualClaudeCodeVersion(hostCliPath) };
      } catch (error) {
        if (error instanceof CliProbeError) {
          // The wire gets the sentence without the CLI's output; stderr keeps the whole one.
          return { sdkDeclared, hostCli: '', hostCliProbeError: error.sentenceWithoutOutput, hostCliProbeErrorPrinted: error.message };
        }
        return { sdkDeclared, hostCli: '', hostCliProbeError: error instanceof Error ? error.message : String(error) };
      }
    },
    cliGate,
    // Strict mode (VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION=1) restores the old exact-match
    // behavior, for CI and release validation where "it started, but on an untested CLI" should be a
    // hard failure rather than a warning. Off by default: a developer's or user's routine Claude Code
    // patch update must not take the Agent pane offline.
    classifyCliVersion: (version) => classifyCliVersion(version, { strict: strictModeFromEnv() }),
    // Resolved once, here, and handed to both the startup gate and the service -- so the binaries this
    // process classifies at boot are exactly the binaries it will accept a request for. A build that
    // advertised one set and gated another is the same "measure one thing, run another" defect
    // resolveClaudeCliPath exists to close one layer down.
    sdkBundledAvailable: canRunSdkBundled,
    parentWatch,
    report,
    runtime: {
      ringBufferCapacity,
      watchFault,
      writeQueueStats,
      sdkBundledAvailable: canRunSdkBundled,
      // The same `account` sessionFactory pins every session to, so Handshake reports the binding
      // the sessions really have. Undefined (VERDANDI_CLAUDE_ACCOUNT unset) reports UNPINNED.
      account,
      egressRestricted: egressMode === 'restricted',
      // Asked of this runtime once, the same way --version --json asks it.
      taskOutputRead: taskOutputReadable(),
    },
  });
}

main().catch((error: unknown) => exitRefused(report, error));
