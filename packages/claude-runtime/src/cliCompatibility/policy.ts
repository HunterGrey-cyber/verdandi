import compatibility from './cli-compatibility.json' with { type: 'json' };

export type CliSurface = 'sdk' | 'interactive' | 'screen' | 'transcript';
type CompatibilityData = {
  schema: number;
  surfaces: CliSurface[];
  ranges: Record<CliSurface, { min: string; max_exclusive: string }>;
  known_incompatible: string[];
  tested: { version: string; surfaces: CliSurface[]; evidence: string }[];
};

// JSON is the sole data source; this type describes its public API.
export const CLI_COMPATIBILITY = compatibility as CompatibilityData;
export const CLI_SURFACES: readonly CliSurface[] = CLI_COMPATIBILITY.surfaces;

export function testedVersionsFor(surface: CliSurface): string[] {
  return CLI_COMPATIBILITY.tested.filter((entry) => entry.surfaces.includes(surface)).map((entry) => entry.version);
}

export function rangeFor(surface: CliSurface): { min: string; maxExclusive: string } {
  const range = CLI_COMPATIBILITY.ranges[surface];
  return { min: range.min, maxExclusive: range.max_exclusive };
}

export type CliRefusalReason = 'unparseable' | 'known_incompatible' | 'strict_untested' | 'out_of_range';

export type CliVersionVerdict =
  | { kind: 'supported' }
  | { kind: 'untested'; diagnostic: string }
  | { kind: 'refused'; diagnostic: string; reason?: CliRefusalReason };

export type CliCompatibilityPolicy = {
  tested?: ReadonlySet<string>;
  minVersion?: string;
  maxVersionExclusive?: string;
  knownIncompatible?: ReadonlySet<string>;
  strict?: boolean;
};

export type CliWording = { strictSwitch: string; dataFile: string };

export const CLI_DATA_FILE = 'packages/claude-runtime/src/cliCompatibility/cli-compatibility.json';
export const KNOWN_INCOMPATIBLE_CLI_VERSIONS: ReadonlySet<string> = new Set(CLI_COMPATIBILITY.known_incompatible);

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

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Check order is load-bearing and deliberately fail-closed:
 *   1. unparseable            -> refuse (never guess at a version we cannot read)
 *   2. known incompatible     -> refuse (a denylist entry beats even a tested-set entry)
 *   3. strict && not tested   -> refuse
 *   4. outside the range      -> refuse
 *   5. tested                 -> supported
 *   6. otherwise              -> untested (start with a diagnostic)
 */
export function classifyCliVersion(
  version: string,
  opts: { surface: CliSurface; wording: CliWording; policy?: CliCompatibilityPolicy },
): CliVersionVerdict {
  const policy = opts.policy ?? {};
  const tested = policy.tested ?? new Set(testedVersionsFor(opts.surface));
  const defaultRange = rangeFor(opts.surface);
  const minVersion = policy.minVersion ?? defaultRange.min;
  const maxVersionExclusive = policy.maxVersionExclusive ?? defaultRange.maxExclusive;
  const knownIncompatible = policy.knownIncompatible ?? KNOWN_INCOMPATIBLE_CLI_VERSIONS;
  const strict = policy.strict ?? false;
  const range = `>=${minVersion} <${maxVersionExclusive}`;

  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return {
      kind: 'refused',
      reason: 'unparseable',
      diagnostic:
        `could not parse the installed claude CLI version ${JSON.stringify(version)}. ` +
        `This sidecar supports ${range}; refusing to start rather than guessing at compatibility.`,
    };
  }
  if (knownIncompatible.has(version)) {
    return {
      kind: 'refused',
      reason: 'known_incompatible',
      diagnostic:
        `claude CLI version ${version} is on this sidecar's known-incompatible list. ` +
        `Install a different version inside ${range}.`,
    };
  }
  if (strict && !tested.has(version)) {
    return {
      kind: 'refused',
      reason: 'strict_untested',
      diagnostic:
        `strict CLI version checking is enabled and claude CLI version ${version} is not in this ` +
        `sidecar's tested set (${describeSet(tested)}). Unset ${opts.wording.strictSwitch} to accept any version inside ${range}.`,
    };
  }
  const min = parseVersionOrThrow(minVersion);
  const max = parseVersionOrThrow(maxVersionExclusive);
  if (compareVersions(parsed, min) < 0 || compareVersions(parsed, max) >= 0) {
    return {
      kind: 'refused',
      reason: 'out_of_range',
      diagnostic:
        `claude CLI version ${version} is outside this sidecar's supported range (${range}). ` +
        `Install a claude CLI inside that range, or widen the range in ${opts.wording.dataFile} once a real-CLI test run has confirmed it works.`,
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
