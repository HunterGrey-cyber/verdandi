/**
 * Claude Code CLI compatibility policy.
 *
 * The compatibility data and verdict ladder live in
 * `packages/claude-runtime/src/cliCompatibility/cli-compatibility.json`. This sidecar keeps
 * its environment switches and handshake-report helpers here, while using the
 * shared SDK surface unchanged.
 *
 * Pure and dependency-free on purpose -- every branch below is covered by
 * `tests/cliCompatibility.test.ts` with no real `claude` binary involved.
 */
import {
  classifyCliVersion as classifySharedCliVersion,
  rangeFor,
  testedVersionsFor,
  type CliCompatibilityPolicy,
  type CliRefusalReason,
  type CliVersionVerdict,
} from '@verdandi/claude-runtime/cli-compatibility';

export { compareVersions, KNOWN_INCOMPATIBLE_CLI_VERSIONS, parseVersion } from '@verdandi/claude-runtime/cli-compatibility';
export type { CliCompatibilityPolicy, CliRefusalReason, CliVersionVerdict } from '@verdandi/claude-runtime/cli-compatibility';

export const TESTED_CLI_VERSIONS: ReadonlySet<string> = new Set(testedVersionsFor('sdk'));
export const MIN_SUPPORTED_CLI_VERSION = rangeFor('sdk').min;
export const MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE = rangeFor('sdk').maxExclusive;

export function classifyCliVersion(version: string, policy: CliCompatibilityPolicy = {}): CliVersionVerdict {
  return classifySharedCliVersion(version, {
    surface: 'sdk',
    wording: { strictSwitch: 'VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION', dataFile: 'apps/claude-sidecar/src/cliCompatibility.ts' },
    policy,
  });
}

/**
 * Reads the strict-mode switch from the process environment. Lives here (rather than inline at the
 * one call site) so the exact accepted values are stated once and testable: `1` or `true`,
 * case-insensitive. Anything else -- including an empty string -- is off, so
 * `VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION=` does not silently enable it.
 */
export function strictModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION;
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * How the process answers a CLI this policy refuses (or could not read).
 *
 *   `refuse` (the default): the process does not start. Nothing is bound, the reason goes to stderr,
 *   exit 1 -- exactly what it has always done, because a host that matches those texts keeps working.
 *   `report`: opt-in, for a host that wants to decide itself. The process starts, the handshake reports
 *   the verdict, and CreateSession is refused on a refused or unreadable CLI unless the request carries
 *   `ClaudeHostPolicy.accept_unsupported_cli`.
 *
 * Read at the composition root, like the other switches, so a misspelt value refuses to boot instead of
 * quietly picking a mode: a typo for `refuse` that fell back to `report` would be a gate that is open
 * without anyone having asked.
 */
export type CliGateMode = 'refuse' | 'report';

export function cliGateModeFromEnv(env: NodeJS.ProcessEnv = process.env): CliGateMode {
  const raw = env.VERDANDI_CLAUDE_SIDECAR_CLI_GATE;
  if (raw === undefined || raw.trim() === '') {
    return 'refuse';
  }
  const value = raw.trim();
  if (value === 'refuse' || value === 'report') {
    return value;
  }
  throw new Error(`VERDANDI_CLAUDE_SIDECAR_CLI_GATE: expected "refuse" or "report", got ${JSON.stringify(raw)}`);
}

/** The four answers the handshake can give about one CLI binary. `unknown` is the one `classifyCliVersion`
 * cannot produce: it needs a version, and this is the case where there is none. */
export type CliReportVerdict = 'supported' | 'untested' | 'refused' | 'unknown';

export type CliCompatibilityReport = {
  verdict: CliReportVerdict;
  /** Empty for `unknown`. */
  version: string;
  supportedRange: string;
  testedVersions: string[];
  /** Empty for `supported`. */
  diagnostic: string;
};

/** What a verdict allows in `report` mode without the host's explicit say-so. */
export function cliVerdictNeedsAcceptance(verdict: CliReportVerdict): boolean {
  return verdict === 'refused' || verdict === 'unknown';
}

function describeRange(): string {
  return `>=${MIN_SUPPORTED_CLI_VERSION} <${MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE}`;
}

/** The handshake's account of one binary whose version was read and classified. */
export function reportForVerdict(version: string, verdict: CliVersionVerdict): CliCompatibilityReport {
  return {
    verdict: verdict.kind,
    version,
    supportedRange: describeRange(),
    testedVersions: [...TESTED_CLI_VERSIONS],
    diagnostic: verdict.kind === 'supported' ? '' : verdict.diagnostic,
  };
}

/** The handshake's account of a binary whose version could not be read. `why` is the probe's own message. */
export function reportForUnreadableCli(why: string): CliCompatibilityReport {
  return { verdict: 'unknown', version: '', supportedRange: describeRange(), testedVersions: [...TESTED_CLI_VERSIONS], diagnostic: why };
}
