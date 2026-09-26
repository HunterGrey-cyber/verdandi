/**
 * Claude Code CLI compatibility policy.
 *
 * Replaces the previous exact-match gate (`TESTED_CLI_VERSIONS.has(version)`), which refused to
 * start the whole sidecar on any CLI the sidecar had not been literally tested against. That gate
 * was verifiably too tight in practice: the sidecar was pinned to 2.1.267 while the installed CLI
 * had already moved to 2.1.269, so a routine Claude Code patch update took the entire Agent pane
 * of a downstream consumer (neovibe) offline until someone edited this file.
 *
 * The policy here is the four-tier model that replaced it:
 *
 *     known incompatible                    -> refuse
 *     outside the supported range           -> refuse
 *     inside the range, exactly tested      -> start
 *     inside the range, not yet tested      -> start, with a diagnostic
 *     strict mode (CI / release validation) -> require an exactly tested version
 *
 * **Why the range is `>= MIN_SUPPORTED_CLI_VERSION` and `< next major`**: this sidecar does not
 * parse the CLI's own output or drive its terminal surface -- it talks to the Claude Agent SDK,
 * which is the layer that actually declares a CLI contract. Within one major version that contract
 * is the stability boundary, so a patch or minor bump is a reasonable "probably fine, say so out
 * loud" case; a major bump is the documented break point and stays a refusal. This is the same
 * caret-semver reasoning this repository's own package.json dependencies already express.
 *
 * **Widening the range is a deliberate, evidence-backed edit**, not a formality: add a version to
 * `TESTED_CLI_VERSIONS` only once a real-CLI test run has actually exercised it, and raise
 * `MIN_SUPPORTED_CLI_VERSION` only when an older CLI is genuinely known to break.
 *
 * Pure and dependency-free on purpose -- every branch below is covered by
 * `tests/cliCompatibility.test.ts` with no real `claude` binary involved.
 */

/**
 * CLI versions a real-CLI test run has actually exercised against this sidecar. A version in this
 * set produces no diagnostic; anything else inside the supported range starts with one.
 */
export const TESTED_CLI_VERSIONS: ReadonlySet<string> = new Set<string>([
  // The original round's host CLI.
  '2.1.267',
  // The CLI inside `@anthropic-ai/claude-agent-sdk` 0.3.252, i.e. what `executable: 'sdk_bundled'`
  // runs. Certified 2026-09-14 on main: `realSdk.*.integration.test.ts` 4/4 with
  // `VERDANDI_REAL_TEST_EXECUTABLE=sdk_bundled`.
  '2.1.252',
  // The installed host CLI, i.e. what `executable: 'host_cli'` runs. Certified 2026-09-14 on main:
  // the same suite 4/4 with `VERDANDI_REAL_TEST_EXECUTABLE=host_cli`.
  '2.1.270',
]);

/**
 * Inclusive lower bound of the supported range.
 *
 * 2.1.252, NOT 2.1.267. The floor has to admit the lowest binary this sidecar can actually be asked
 * to spawn, and `executable: 'sdk_bundled'` spawns the CLI inside the SDK npm package, which on the
 * pinned SDK is 2.1.252. A floor of 2.1.267 classifies that certified binary as out-of-range and
 * refuses the whole process at startup -- loudly, but on a binary main had already tested 4/4.
 *
 * **Deliberately a literal, not read from the SDK manifest at runtime.** Deriving it from whatever
 * the installed SDK happens to declare would make the sdk-bundled binary impossible to classify as
 * out-of-range by construction -- the gate would go vacuously true for exactly the binary the floor
 * was lowered to admit. The check that this literal still matches reality is a test, not a runtime
 * lookup: see `tests/sdkBundledCliFloor.test.ts`, which reads the installed manifest and fails if
 * the bundled CLI has drifted below this line.
 */
export const MIN_SUPPORTED_CLI_VERSION = '2.1.252';

/**
 * Exclusive upper bound: the next major after `MIN_SUPPORTED_CLI_VERSION`'s. Derived rather than
 * hand-written so raising the floor across a major boundary cannot silently leave this stale.
 */
export const MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE = `${parseVersionOrThrow(MIN_SUPPORTED_CLI_VERSION)[0] + 1}.0.0`;

/**
 * Versions known to be broken against this sidecar. Checked BEFORE the tested set and before the
 * range, so a version discovered bad after it was once tested still refuses -- fail closed wins
 * over any other signal. Empty today; every entry added here should cite what broke.
 *
 * **Matched by exact string, deliberately, while the range gate is matched on the parsed tuple.**
 * An entry is an evidence-backed statement about one specific published build, and under semver
 * `2.2.0-rc.1` is a different -- and earlier -- release than `2.2.0`, so silently extending a denial
 * from one to the other would be wrong about as often as it would be right. Four separate reviewers
 * read this asymmetry as a bug, so stating it plainly: it is a decision, not an oversight. Note also
 * that the only production feed, `getActualClaudeCodeVersion()`, already normalizes
 * `claude --version`'s output to a bare `X.Y.Z` before it ever reaches here.
 */
export const KNOWN_INCOMPATIBLE_CLI_VERSIONS: ReadonlySet<string> = new Set<string>([]);

export type CliVersionVerdict =
  /** Exactly tested, inside the range. Start silently. */
  | { kind: 'supported' }
  /** Inside the range but not tested. Start, but say so -- `diagnostic` is written to stderr. */
  | { kind: 'untested'; diagnostic: string }
  /** Fail closed. `diagnostic` becomes the thrown error's message. */
  | { kind: 'refused'; diagnostic: string };

export type CliCompatibilityPolicy = {
  tested?: ReadonlySet<string>;
  minVersion?: string;
  maxVersionExclusive?: string;
  knownIncompatible?: ReadonlySet<string>;
  /** Require an exactly tested version (CI / release validation). Default false. */
  strict?: boolean;
};

/**
 * Parses `major.minor.patch`, ignoring any trailing pre-release/build suffix (`2.1.269-beta.1`) and
 * any trailing descriptive text the caller failed to strip. Returns `undefined` -- never a partial
 * or guessed tuple -- for anything it cannot read, because an unreadable version must fail closed
 * rather than compare as zero.
 */
export function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseVersionOrThrow(version: string): [number, number, number] {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    throw new Error(`cliCompatibility: ${version} is not a parseable version -- this is a policy constant, fix it at the source`);
  }
  return parsed;
}

/** Standard lexicographic tuple compare. Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Classifies one observed CLI version against this sidecar's policy.
 *
 * Check order is load-bearing and deliberately fail-closed:
 *   1. unparseable            -> refuse (never guess at a version we cannot read)
 *   2. known incompatible     -> refuse (a denylist entry beats even a tested-set entry)
 *   3. strict && not tested   -> refuse
 *   4. outside the range      -> refuse
 *   5. tested                 -> supported
 *   6. otherwise              -> untested (start with a diagnostic)
 */
export function classifyCliVersion(version: string, policy: CliCompatibilityPolicy = {}): CliVersionVerdict {
  const tested = policy.tested ?? TESTED_CLI_VERSIONS;
  const minVersion = policy.minVersion ?? MIN_SUPPORTED_CLI_VERSION;
  const maxVersionExclusive = policy.maxVersionExclusive ?? MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE;
  const knownIncompatible = policy.knownIncompatible ?? KNOWN_INCOMPATIBLE_CLI_VERSIONS;
  const strict = policy.strict ?? false;

  const range = `>=${minVersion} <${maxVersionExclusive}`;

  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return {
      kind: 'refused',
      diagnostic:
        `could not parse the installed claude CLI version ${JSON.stringify(version)}. ` +
        `This sidecar supports ${range}; refusing to start rather than guessing at compatibility.`,
    };
  }

  if (knownIncompatible.has(version)) {
    return {
      kind: 'refused',
      diagnostic:
        `claude CLI version ${version} is on this sidecar's known-incompatible list. ` +
        `Install a different version inside ${range}.`,
    };
  }

  if (strict && !tested.has(version)) {
    return {
      kind: 'refused',
      diagnostic:
        `strict CLI version checking is enabled and claude CLI version ${version} is not in this ` +
        `sidecar's tested set (${describeSet(tested)}). Unset ` +
        `VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION to accept any version inside ${range}.`,
    };
  }

  const min = parseVersionOrThrow(minVersion);
  const max = parseVersionOrThrow(maxVersionExclusive);
  if (compareVersions(parsed, min) < 0 || compareVersions(parsed, max) >= 0) {
    return {
      kind: 'refused',
      diagnostic:
        `claude CLI version ${version} is outside this sidecar's supported range (${range}). ` +
        `Install a claude CLI inside that range, or widen the range in ` +
        `apps/claude-sidecar/src/cliCompatibility.ts once a real-CLI test run has confirmed it works.`,
    };
  }

  if (tested.has(version)) {
    return { kind: 'supported' };
  }

  return {
    kind: 'untested',
    diagnostic:
      `claude CLI version ${version} is inside this sidecar's supported range (${range}) but has ` +
      `not been tested against it (tested: ${describeSet(tested)}). Starting anyway. If you hit ` +
      `protocol, permission, or event-translation failures, this version skew is the first thing ` +
      `to check.`,
  };
}

function describeSet(versions: ReadonlySet<string>): string {
  return versions.size === 0 ? 'none' : [...versions].join(', ');
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
