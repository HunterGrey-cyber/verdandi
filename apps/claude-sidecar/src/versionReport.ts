import { PROTOCOL_MAJOR } from './runtimeServiceImpl.js';
import { PROTOCOL_MINOR } from './generated/protocolConstants.js';
import { handshakeCapabilities } from './capabilities.js';
import { MIN_SUPPORTED_CLI_VERSION, MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE, TESTED_CLI_VERSIONS, compareVersions, parseVersion } from './cliCompatibility.js';
import { SIDECAR_VERSION, CLAUDE_AGENT_SDK_VERSION, SDK_DECLARED_CLAUDE_CODE_VERSION } from './generated/sdkVersions.js';
import { BUILD_STAMP } from './buildStamp.js';

/**
 * What `--version` prints: everything a packaged artifact has to be able to say about itself without
 * being started, unpacked, or connected to.
 *
 * The load-bearing line is the Node runtime. Shipping as a single executable means this artifact
 * carries its own Node: when Node has a CVE, the artifact carries it until it is rebuilt, which is
 * the cost of not letting a distro choose the runtime (and the distro's Node cannot even serve as
 * the base -- Arch's segfaults when injected, measured 2026-09-18). That trade is only acceptable if
 * "which Node is in the artifact I shipped?" is answerable for a binary already sitting in a mirror.
 * `process.version` is the honest answer because it is the runtime executing this line, so it cannot
 * drift from a value stamped beside it at build time.
 *
 * Spawns nothing, deliberately. A `--version` that probed the host CLI would fail on exactly the
 * hosts this line of work exists for: one whose PATH `claude` is a guarded launcher that refuses.
 * The *installed* CLI's version is a runtime property of a host, not of this artifact, and
 * `getActualClaudeCodeVersion` reports it at startup where it belongs.
 */
export function versionReport(options: { sdkBundledAvailable: boolean }): string {
  const facts = versionFacts(options);
  return [
    `verdandi-claude-sidecar ${facts.sidecar_version} (protocol ${facts.protocol.major}, node ${facts.node}, build ${facts.build_stamp})`,
    `claude-agent-sdk ${facts.sdk_version} (bundled claude code ${facts.sdk_bundled_cli})`,
    `supported claude code CLI: >=${facts.supported_cli_range.min} <${facts.supported_cli_range.max_exclusive}`,
    `executable sources served: ${facts.executables.join(', ')}`,
  ].join('\n');
}

/**
 * What `--version --json` prints: the same facts as the text, as one JSON line, plus the ones the text
 * never carried (the protocol minor, the CLI versions a real run has exercised, the capability list).
 * Additive -- the text above is what an installer compares, and stays as it is.
 *
 * `capabilities` is the handshake's list for what can be known without a process: the build decides
 * `executable_sdk_bundled`, but `egress_restricted` is proven by a running process at startup, so a
 * report that has not started anything never claims it; nor `steer_turn`, which needs the host CLI's
 * version that only a started process probes. The list comes from the same table the
 * handshake filters (capabilities.json via the generated constants), not a second copy.
 */
export function versionReportJson(options: { sdkBundledAvailable: boolean }): string {
  return JSON.stringify({ v: 1, ...versionFacts(options) });
}

function versionFacts(options: { sdkBundledAvailable: boolean }) {
  return {
    sidecar_version: SIDECAR_VERSION,
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    node: process.version,
    build_stamp: BUILD_STAMP,
    sdk_version: CLAUDE_AGENT_SDK_VERSION,
    sdk_bundled_cli: SDK_DECLARED_CLAUDE_CODE_VERSION,
    supported_cli_range: { min: MIN_SUPPORTED_CLI_VERSION, max_exclusive: MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE },
    tested_cli_versions: sortedByVersion(TESTED_CLI_VERSIONS),
    executables: options.sdkBundledAvailable ? ['host_cli', 'sdk_bundled'] : ['host_cli'],
    capabilities: handshakeCapabilities({ egressRestricted: false, sdkBundledAvailable: options.sdkBundledAvailable, cliMessageLifecycle: false }),
  };
}

/** Numerically by segment, so 2.1.9 comes before 2.1.10; an unreadable entry sorts last, as text. */
export function sortedByVersion(versions: Iterable<string>): string[] {
  return [...versions].sort((a, b) => {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (left === undefined || right === undefined) {
      return left === right ? a.localeCompare(b) : left === undefined ? 1 : -1;
    }
    return compareVersions(left, right) || a.localeCompare(b);
  });
}
