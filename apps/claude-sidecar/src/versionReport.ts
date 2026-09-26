import { PROTOCOL_MAJOR } from './runtimeServiceImpl.js';
import { MIN_SUPPORTED_CLI_VERSION, MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE } from './cliCompatibility.js';
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
  const executables = options.sdkBundledAvailable ? 'host_cli, sdk_bundled' : 'host_cli';
  return [
    `verdandi-claude-sidecar ${SIDECAR_VERSION} (protocol ${PROTOCOL_MAJOR}, node ${process.version}, build ${BUILD_STAMP})`,
    `claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION} (bundled claude code ${SDK_DECLARED_CLAUDE_CODE_VERSION})`,
    `supported claude code CLI: >=${MIN_SUPPORTED_CLI_VERSION} <${MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE}`,
    `executable sources served: ${executables}`,
  ].join('\n');
}
