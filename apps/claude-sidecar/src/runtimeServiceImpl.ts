import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isSea } from 'node:sea';
import * as grpc from '@grpc/grpc-js';
import { PermissionModeError, PROVIDER_PROMPT_TOOL_DENY, usesProviderPermissionPrompts, type ClaudeHostPolicy, type ClaudeAccount, type ClaudeSessionConfig } from '@verdandi/claude-runtime';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { MinimalKernelSession } from './sessionRegistry.js';
import { SessionRegistry, type SessionEntry } from './sessionRegistry.js';
import { DEFAULT_RING_BUFFER_CAPACITY, type WatchFaultInjection, type WriteQueueStats } from './replayConfig.js';
import { replayRequestFromProto } from './replayRequest.js';
// Generated at build time by scripts/generateSdkVersions.mjs. These used to be read here at
// module load, through `require.resolve` of the SDK plus `readFileSync` of its package.json and
// manifest.json -- which a packaged build cannot do: a single-file executable has no node_modules,
// so that bundle builds clean and dies on its first run, before binding anything. The runtime read
// moved to tests/sdkVersions.test.ts, where node_modules is guaranteed to exist and drift is a
// test failure rather than a handshake reporting a version this process is not running.
import {
  CLAUDE_AGENT_SDK_VERSION,
  SDK_DECLARED_CLAUDE_CODE_VERSION,
  SIDECAR_VERSION,
} from './generated/sdkVersions.js';
import { PumpDriver } from './pumpDriver.js';
import type { SequencedEvent } from './ringBuffer.js';
import { translateEvent, extractTurnId } from './eventTranslation.js';
import { SidecarError, toGrpcStatusCode, toGrpcMetadata } from './errorMapping.js';
import {
  ErrorCode,
  ConfigurationProfile,
  PermissionMode,
  PersistenceMode,
  ExecutableSource,
  StreamingMode,
  ReplayStart,
  AccountBinding,
  SettingSource as SettingSourceProto,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
} from './generated/verdandi/claude/runtime/v1/runtime.js';

/** Default only. The effective capacity is a constructor option -- see `RuntimeServiceOptions`. */
const RING_BUFFER_CAPACITY = DEFAULT_RING_BUFFER_CAPACITY;
/**
 * Bumped 1 -> 2 on 2026-09-12 for the replay-start change.
 *
 * A real incompatibility in both directions, which is what this field is for. An OLD client reaching
 * a new server sends its cursor in a field number this server has reserved, so `start` reads as
 * unspecified and is refused -- loud and correct. A NEW client reaching an old server is the
 * dangerous direction: the old server would read no `after_sequence` at all, i.e. 0, and replay the
 * whole retained history to a client that asked for FROM_NOW. Refusing the handshake is what keeps
 * that from surfacing as duplicated conversation content instead of as a version error.
 *
 * Bumped 2 -> 3 on 2026-09-15 for ClaudeHostPolicy.setting_sources (tag 7) and .tool_policy (tag 6).
 *
 * This one is a FORWARD-compatibility bump and nothing else. The wire change is purely additive --
 * no tag reused, no tag removed, no enum member's value changed -- so an OLD client's bytes still
 * decode to `tool_policy = nil` / `setting_sources = nil` and still produce a byte-identical
 * `Options`. Under the literal rule ("bump only when an existing CORRECT client becomes incorrect")
 * no bump was required. It is taken anyway, for the same reason 1 -> 2 was, in the same direction:
 * a NEW client sending `setting_sources: [project, local]` to a 2.x sidecar has field 7 ignored by
 * proto3's unknown-field rule and silently gets `['user','project','local']` -- re-inheriting the
 * operator's own ~/.claude hooks, plugins and permissions.allow, which is the precise failure the
 * field exists to prevent, and strictly worse than the duplicated-content case that justified 1 -> 2.
 * A loud handshake refusal is the only thing that turns that into a version error.
 *
 * The handshake RESPONSE must report this same constant, not a literal. tests/runtimeServiceImpl.test.ts
 * asserts the two cannot disagree: a bumped constant with a stale response would reject every client
 * and then tell the survivors the wrong number.
 */
export const PROTOCOL_MAJOR = 3;

/**
 * The two Claude Code binaries a session can run, per `ClaudeHostPolicy.executable`. Both are
 * resolved once at startup and both are classified, because either is reachable: `sdk_bundled` by
 * asking for it, and `host_cli` by asking for it *or* by saying nothing at all (it is the default
 * policy's value, and the value an unset proto enum maps to).
 */
export type ClaudeCodeVersions = {
  /** What `executable: 'sdk_bundled'` runs: the CLI inside the SDK npm package. */
  sdkDeclared: string;
  /** What `executable: 'host_cli'` runs: the CLI installed on this machine. */
  hostCli: string;
};

export function getSdkDeclaredClaudeCodeVersion(): string {
  return SDK_DECLARED_CLAUDE_CODE_VERSION;
}

// The CLI version policy that used to live here (`TESTED_CLI_VERSIONS`, an exact-match set) moved to
// `cliCompatibility.ts` on 2026-09-11 and became a four-tier verdict. Design spec §4/§5.4's
// fail-closed requirement is unchanged -- an out-of-range or known-incompatible CLI still refuses to
// boot; what changed is that an in-range, not-yet-tested patch version now starts with a diagnostic
// instead of taking the whole sidecar (and every downstream Agent pane) offline. The certification
// record for BOTH binaries (2.1.252 sdk-bundled, 2.1.267/2.1.270 host) lives there now too.

/**
 * Whether this build can serve `executable: 'sdk_bundled'` at all.
 *
 * `sdk_bundled` leaves `pathToClaudeCodeExecutable` unset, which is how the SDK is told to spawn the
 * CLI inside its own npm package -- and it locates that CLI through
 * `createRequire(import.meta.url).resolve(...)` of its platform-specific optional dependency.
 * (Verified in the installed `sdk.mjs`: that resolution sits inside
 * `if (!options.pathToClaudeCodeExecutable)`, which is why `host_cli` never reaches it and is
 * bundle-safe by construction.) A single-file executable has no node_modules for that to resolve
 * against, and the package it wants -- `@anthropic-ai/claude-agent-sdk-linux-x64` -- measures 205 MB,
 * roughly tripling a 105 MiB artifact to serve a mode a packaged install has no use for.
 *
 * So a packaged build serves `host_cli` only, and says so rather than discovering it inside a turn.
 * `isSea()` is the honest signal: it is true exactly when this process is a single executable
 * application, which is exactly when there is no node_modules.
 */
export function sdkBundledAvailable(): boolean {
  return !isSea();
}

/**
 * Where the machine's own Claude CLI is. One answer, used for two things that must never disagree:
 * the startup version probe, and what an `executable: 'host_cli'` session is actually pointed at.
 * Measuring one binary and running another is the exact defect this consolidates away.
 *
 * `claude` (resolved through PATH) is the default and the only thing a plain install needs.
 * `VERDANDI_CLAUDE_CLI_PATH` exists because PATH is not always the real CLI: a host that runs
 * several accounts side by side may put a guarded launcher earlier in PATH, one that refuses to
 * exec unless it is satisfied with the caller's account/terminal context. Such a launcher exits
 * non-zero for the probe -- correctly, from its own point of view -- and the sidecar then cannot
 * start at all.
 *
 * **This variable is the ONLY way a host pins which CLI this sidecar spawns.** Prepending a
 * directory to PATH does not do it: the default resolves `claude` through the PATH this PROCESS
 * inherited, which is not necessarily the one a test harness or wrapper arranged for itself.
 * Measured downstream 2026-09-18, same harness, same run, A/B: with the variable unset the sidecar
 * reported CLI 2.1.276 while that harness's own PATH shim resolved 2.1.272; with it set, 2.1.272.
 * Nothing failed in either run -- the skew is silent, and every result measured through such a
 * harness without the variable was measured on a build nobody chose. A host that cares which CLI it
 * is testing against must set it explicitly.
 */
export function resolveClaudeCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VERDANDI_CLAUDE_CLI_PATH?.trim();
  return override !== undefined && override !== '' ? override : 'claude';
}

/** The *installed* CLI's version -- what an `executable: 'host_cli'` session runs. Real
 * implementation, used only by src/index.ts's production wiring -- never called by
 * runtimeServiceImpl.test.ts, which injects a fake instead so the fake-driven suite never depends on
 * a real `claude` binary being installed with a specific version (this plan's own real API cost
 * discipline extends to "don't make free tests depend on the real CLI's presence/version either"). */
export function getActualClaudeCodeVersion(cliPath: string = resolveClaudeCliPath()): string {
  const result = spawnSync(cliPath, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout === undefined) {
    // Carry the reason, not just the verdict. The failure this most often is -- a guarded launcher
    // sitting ahead of the real binary in PATH and refusing this caller -- explains itself on
    // stderr, and dropping that left a startup failure whose only clue was "could not determine".
    const detail = [
      result.error !== undefined ? `spawn error: ${result.error.message}` : undefined,
      result.status !== null && result.status !== 0 ? `exit status ${result.status}` : undefined,
      result.signal !== null && result.signal !== undefined ? `signal ${result.signal}` : undefined,
      result.stderr !== undefined && result.stderr.trim() !== '' ? `stderr: ${result.stderr.trim()}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');
    throw new SidecarError(
      ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE,
      `could not determine the installed claude CLI version via ${JSON.stringify(cliPath)}${detail === '' ? '' : ` (${detail})`}`,
    );
  }
  // `claude --version` prints something like "2.0.0 (Claude Code)" -- take the leading token.
  return result.stdout.trim().split(/\s+/)[0] ?? 'unknown';
}

export type ClaudeSessionConfigLike = {
  cwd: string;
  policy: unknown;
  /** Present (proto3 field presence) when the client is resuming an existing provider session. */
  resumeProviderSessionId?: string;
  /** Only meaningful alongside resumeProviderSessionId. */
  fork?: boolean;
  /** SDK Options.model. Empty string (proto3 default) means "not set". */
  model?: string;
  /** SDK Options.effort. Empty string means "not set"; anything else must be a known level. */
  effort?: string;
  /** SDK Options.systemPrompt as a full replacement. Absent keeps Claude Code's default prompt;
   *  present-but-blank is refused by `validateSystemPrompt`. */
  systemPrompt?: string;
  /** SDK Options.outputFormat, with the schema as JSON text. Absent means a plain-text answer. */
  outputFormat?: { jsonSchemaJson: string };
};

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Refuses an effort level the SDK does not define, before any session exists. Passing an unknown
 * string through would leave the SDK's reaction to it -- ignore, clamp, or fail mid-turn -- to be
 * discovered in production. Exported for direct unit testing.
 */
export function validateEffort(config: ClaudeSessionConfigLike): void {
  const effort = config.effort ?? '';
  if (effort !== '' && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `effort must be one of ${EFFORT_LEVELS.join(', ')} (or empty for the CLI default), got ${JSON.stringify(effort)}`,
    );
  }
}

/**
 * Refuses a present-but-blank system prompt, before any session exists. Presence says "replace
 * Claude Code's prompt", the value says "with nothing" -- no caller means that, and the likeliest
 * way to send it is a partial message literal. Same stance as an empty
 * `resume_provider_session_id`. Exported for direct unit testing.
 */
export function validateSystemPrompt(config: ClaudeSessionConfigLike): void {
  if (config.systemPrompt !== undefined && config.systemPrompt.trim() === '') {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      'system_prompt was set but is blank -- omit the field to keep Claude Code\'s default system prompt',
    );
  }
}

/**
 * Parses `output_format.json_schema_json` into the schema object the SDK takes, or refuses it.
 *
 * Refused rather than passed through because every other reading is silently wrong: an unparsable
 * or non-object schema handed to the SDK fails inside the first turn (or is ignored and the caller
 * gets plain text it did not ask for), long after anything points at this field. An empty string
 * is refused by the same rule -- it is not JSON. Exported so the mapping and the validation use
 * one parser.
 */
export function parseOutputSchema(spec: { jsonSchemaJson: string }): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec.jsonSchemaJson);
  } catch (err) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `output_format.json_schema_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed;
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `output_format.json_schema_json must be a JSON object (a JSON Schema), got ${kind}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Refuses an output format whose schema cannot be used, before any session exists. */
export function validateOutputFormat(config: ClaudeSessionConfigLike): void {
  if (config.outputFormat !== undefined) {
    parseOutputSchema(config.outputFormat);
  }
}

/**
 * Rejects a CreateSession request whose resume/fork combination cannot be honored, BEFORE any
 * session object is built -- a bad request must fail as a typed client error, not as a session that
 * silently started fresh when the caller asked to resume. Exported for direct unit testing.
 *
 * Two cases, both of which a naive passthrough would get wrong in the dangerous direction:
 *   - `resumeProviderSessionId` present but empty/whitespace: proto3 presence says "resume", the
 *     value says nothing. Starting fresh here loses a conversation the caller believed continued.
 *   - `fork` without `resumeProviderSessionId`: there is nothing to fork from. The SDK's
 *     forkSession is meaningless without resume, so the flag would be silently ignored.
 */
export function validateResumeRequest(config: ClaudeSessionConfigLike): void {
  const { resumeProviderSessionId, fork } = config;
  if (resumeProviderSessionId !== undefined && resumeProviderSessionId.trim() === '') {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      'resume_provider_session_id was set but is empty -- omit the field to start a fresh session',
    );
  }
  if (fork === true && resumeProviderSessionId === undefined) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      'fork was requested without resume_provider_session_id -- there is no session to fork from',
    );
  }
}

/**
 * Least-surprising defaults for a `CreateSessionRequest` whose `policy` is entirely absent.
 * `CreateSessionRequest.policy` is a plain singular message field (no `optional` keyword in the
 * .proto), so proto3 leaves it `undefined` -- not a zero-valued object -- when a well-behaved client
 * omits it to ask for defaults (confirmed via the generated createBaseCreateSessionRequest(): `{ cwd:
 * "", policy: undefined }`). Exported and used by both mapClaudeHostPolicy below (index.ts's
 * production sessionFactory wiring) and this file's own tests, so the two never drift apart.
 */
export const DEFAULT_CLAUDE_HOST_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
  // Unchanged behavior for every existing caller: partial streaming is opt-in.
  streaming: 'complete',
  // NEITHER `settingSources` NOR `toolPolicy` BELONGS HERE, and that absence is the whole point of
  // the additive design: a client that omits `policy` entirely must keep getting exactly what it got
  // before those fields existed. Putting a source list or a deny list here would silently change
  // behaviour for every such client at once -- which, per this constant's own comment above, is a
  // real client-triggerable case and not a hypothetical. Pinned by a test in this file's suite.
};

// ts-proto's default output keeps a proto enum's declared member names unchanged (unlike message
// fields, which get camelCased) -- these *_MAP lookups mirror eventTranslation.ts's existing pattern
// (Task 4) rather than inventing a new mapping style. Each generated enum also carries ts-proto's
// synthetic UNRECOGNIZED = -1 member (an unknown value seen on the wire) -- Record<Enum, X> is total
// over every declared member including that one, so it must be mapped too. Mirrors this file's own
// STATUS_CODE_MAP-style pattern in errorMapping.ts (Task 6), which maps ErrorCode.UNRECOGNIZED
// explicitly rather than leaving it out; here it gets the same safe default as the corresponding
// *_UNSPECIFIED member.
const CONFIGURATION_MAP: Record<ConfigurationProfile, ClaudeHostPolicy['configuration']> = {
  [ConfigurationProfile.CONFIGURATION_PROFILE_UNSPECIFIED]: 'native',
  [ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE]: 'native',
  [ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED]: 'isolated',
  [ConfigurationProfile.UNRECOGNIZED]: 'native',
};

const PERMISSIONS_MAP: Record<PermissionMode, ClaudeHostPolicy['permissions']> = {
  [PermissionMode.PERMISSION_MODE_UNSPECIFIED]: 'interactive',
  [PermissionMode.PERMISSION_MODE_INTERACTIVE]: 'interactive',
  [PermissionMode.PERMISSION_MODE_VERDANDI_RULES]: 'verdandi_rules',
  [PermissionMode.PERMISSION_MODE_BYPASS]: 'bypass',
  [PermissionMode.UNRECOGNIZED]: 'interactive',
};

const PERSISTENCE_MAP: Record<PersistenceMode, ClaudeHostPolicy['persistence']> = {
  [PersistenceMode.PERSISTENCE_MODE_UNSPECIFIED]: 'ephemeral',
  [PersistenceMode.PERSISTENCE_MODE_HOST_CLI]: 'host_cli',
  [PersistenceMode.PERSISTENCE_MODE_EPHEMERAL]: 'ephemeral',
  [PersistenceMode.PERSISTENCE_MODE_EXTERNAL_STORE]: 'external_store',
  [PersistenceMode.UNRECOGNIZED]: 'ephemeral',
};

const STREAMING_MAP: Record<StreamingMode, NonNullable<ClaudeHostPolicy['streaming']>> = {
  [StreamingMode.STREAMING_MODE_UNSPECIFIED]: 'complete',
  [StreamingMode.STREAMING_MODE_COMPLETE]: 'complete',
  [StreamingMode.STREAMING_MODE_PARTIAL]: 'partial',
  [StreamingMode.UNRECOGNIZED]: 'complete',
};

const EXECUTABLE_MAP: Record<ExecutableSource, ClaudeHostPolicy['executable']> = {
  [ExecutableSource.EXECUTABLE_SOURCE_UNSPECIFIED]: 'host_cli',
  [ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI]: 'host_cli',
  [ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED]: 'sdk_bundled',
  [ExecutableSource.UNRECOGNIZED]: 'host_cli',
};

/**
 * Deliberately NOT a total `Record<SettingSourceProto, SettingSource>` like the five maps above --
 * two of its four inputs must THROW rather than map. A settings tier this sidecar cannot load is not
 * a value to be defaulted: the caller asked for a specific set of tiers, and any silent handling of
 * an unmappable member is a silent NARROWING of that set which the caller has no way to observe.
 * `[UNSPECIFIED]` dropped becomes `[]`, i.e. "the tiers I named" turning into "none at all"; and
 * `[UNSPECIFIED, PROJECT]` dropped becomes something strictly narrower than what was written.
 * Refusing is the only reading that cannot be wrong in the dangerous direction.
 */
export function mapSettingSource(value: SettingSourceProto): SettingSource {
  switch (value) {
    case SettingSourceProto.SETTING_SOURCE_USER:
      return 'user';
    case SettingSourceProto.SETTING_SOURCE_PROJECT:
      return 'project';
    case SettingSourceProto.SETTING_SOURCE_LOCAL:
      return 'local';
    default:
      throw new SidecarError(
        ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
        `setting_sources contains ${value}, which is not a settings tier this sidecar can load`,
      );
  }
}

/** The SDK's own declared order for SettingSource. Canonicalising to it (and de-duplicating on the
 * way) means one set has exactly one spelling, so two requests that mean the same thing cannot
 * produce two different `Options.settingSources` arrays that later drift apart in a diff or a test. */
const CANONICAL_SETTING_SOURCE_ORDER: SettingSource[] = ['user', 'project', 'local'];

/**
 * `allow` present-but-empty vs absent, kept apart as a NAMED function rather than inlined, because
 * inlined it reads like a candidate for `?? undefined` or `?? []` and either "simplification" is a
 * silent behaviour change: the SDK documents `Options.tools: []` as "Disable all built-in tools",
 * so collapsing present-and-empty into absent turns "no built-in tools at all" into "unrestricted".
 */
function mapToolAllowList(allow: { tools: string[] } | undefined): string[] | undefined {
  if (allow === undefined) {
    return undefined;
  }
  return [...allow.tools];
}

/**
 * Maps a proto ClaudeHostPolicy to the kernel's string-union ClaudeHostPolicy, defaulting to
 * DEFAULT_CLAUDE_HOST_POLICY when `policy` itself is absent (see that const's own doc comment for
 * why that's a real, client-triggerable case, not just a defensive fallback). Lives here (rather than
 * in src/index.ts, where the review that requested this originally sketched it) specifically so it's
 * unit-testable via this file's own fake-driven test suite without needing to import src/index.ts --
 * that module's top-level `await startSidecar(...)` bootstrap runs immediately on any import, which
 * would make it unsafe to pull a pure helper out of it in a test.
 */
export function mapClaudeHostPolicy(policy: ClaudeHostPolicyProto | undefined): ClaudeHostPolicy {
  if (policy === undefined) {
    return DEFAULT_CLAUDE_HOST_POLICY;
  }
  const requestedSources = policy.settingSources;
  return {
    configuration: CONFIGURATION_MAP[policy.configuration],
    permissions: PERMISSIONS_MAP[policy.permissions],
    persistence: PERSISTENCE_MAP[policy.persistence],
    executable: EXECUTABLE_MAP[policy.executable],
    streaming: STREAMING_MAP[policy.streaming],
    // Presence, not emptiness: `undefined` here means "defer to `configuration`", `[]` means "load
    // no filesystem settings tiers". A `?? []` anywhere on this line would erase the difference and
    // flip every existing caller from user+project+local to full isolation.
    settingSources: requestedSources === undefined
      ? undefined
      : CANONICAL_SETTING_SOURCE_ORDER.filter((tier) => requestedSources.sources.map(mapSettingSource).includes(tier)),
    toolPolicy: policy.toolPolicy === undefined
      ? undefined
      : {
          deny: [...policy.toolPolicy.deny],
          allow: mapToolAllowList(policy.toolPolicy.allow),
          // Forwarded as the plain proto3 boolean rather than normalised to `true | undefined`.
          // The kernel's own predicate tests `!== true`, so `false` and absent already mean the
          // same thing there; normalising here would add a second place for the two layers to
          // disagree about what "the caller said nothing" looks like.
          unrestricted: policy.toolPolicy.unrestricted,
        },
    // Only `true` is forwarded: proto3 `false` is also what every sender that predates the field
    // sends, and the kernel tests for `true`.
    ...(policy.permissionModeSwitchable ? { permissionModeSwitchable: true } : {}),
    // The same rule, for the same reason. The kernel decides where it applies (interactive only).
    ...(policy.providerPermissionPrompts ? { providerPermissionPrompts: true } : {}),
  };
}

/**
 * Rejects a policy whose tool/settings restrictions cannot be honoured as written, BEFORE any
 * session object exists -- same placement and same reason as `validateResumeRequest`, which it is
 * called beside. Every rule here exists because the alternative reading is silently WEAKER or
 * silently NARROWER than what the caller wrote, with nothing on the wire to say so.
 *
 *   1/2. `SETTING_SOURCE_UNSPECIFIED`, or a tier value this sidecar does not know -- via
 *        `mapSettingSource`. Dropping either one narrows the requested set invisibly.
 *   3. An empty-or-whitespace tool name in `deny` or `allow.tools`: presence says "restrict", the
 *      value says nothing, and a deny entry matching no tool is silently weaker than written. Exactly
 *      the reasoning behind the empty-`resume_provider_session_id` refusal above.
 *   4. A name in both `deny` and `allow.tools`: adds no expressiveness (the SDK says disallowedTools
 *      wins "even if they would otherwise be allowed") and can only mislead whoever reads the allow
 *      list later into thinking that tool is available.
 *   5. `unrestricted` alongside any stated restriction. Both readings are wrong -- honouring
 *      `unrestricted` discards a restriction the caller wrote down, and honouring the restriction
 *      re-applies a floor the caller explicitly declined -- and neither would leave anything on the
 *      wire to say which one happened. Refused, not resolved.
 *   6. `provider_permission_prompts` in force together with an `allow.tools` naming one of the three
 *      tools that flag disallows (PROVIDER_PROMPT_TOOL_DENY). Rule 4 again, with the flag as the
 *      deny: the disallow wins, so the allow entry can only mislead, and the kernel's allow-list
 *      invariant would then close the session over the missing tool at its first turn.
 */
export type PolicyValidationOptions = {
  /** Whether this build can serve `executable: 'sdk_bundled'`. Defaults to the real runtime answer;
   *  injectable so both directions are testable from one process. */
  sdkBundledAvailable?: boolean;
};

export function validatePolicy(policy: ClaudeHostPolicyProto | undefined, options: PolicyValidationOptions = {}): void {
  if (policy === undefined) {
    return;
  }
  // Before anything else, and for the same reason the settings-tier check below throws rather than
  // dropping: a policy this build cannot honour as written must fail as a typed client error at the
  // field that caused it. Left alone, `sdk_bundled` in a packaged build is accepted here, creates a
  // session, and surfaces as the SDK's own `Native CLI binary for <platform> not found` from inside
  // the first turn -- by which point nothing points at `policy.executable`.
  if (policy.executable === ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED && !(options.sdkBundledAvailable ?? sdkBundledAvailable())) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      "executable: sdk_bundled is not available in this build -- it spawns the CLI inside the agent SDK's npm package, which a packaged single-file build has no node_modules to resolve. Use executable: host_cli, which this build serves.",
    );
  }
  if (policy.settingSources !== undefined) {
    // Called for its throw, not its value: this is where rules 1 and 2 fire, before anything has
    // been built from the request.
    for (const source of policy.settingSources.sources) {
      mapSettingSource(source);
    }
  }
  const toolPolicy = policy.toolPolicy;
  if (toolPolicy === undefined) {
    return;
  }
  // Rule 5, checked before the per-name rules below: a policy that contradicts itself is not worth
  // reporting a second, narrower complaint about.
  if (toolPolicy.unrestricted && (toolPolicy.deny.length > 0 || toolPolicy.allow !== undefined)) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      'tool_policy sets unrestricted together with deny/allow -- "no tool restriction at all" and a stated restriction cannot both be honoured, and picking either one would silently discard the other',
    );
  }
  const allow = toolPolicy.allow?.tools ?? [];
  for (const [fieldName, names] of [['deny', toolPolicy.deny], ['allow.tools', allow]] as const) {
    for (const name of names) {
      if (name.trim() === '') {
        throw new SidecarError(
          ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
          `tool_policy.${fieldName} contains an empty tool name -- it would restrict nothing while looking like it restricts something`,
        );
      }
    }
  }
  const denied = new Set(toolPolicy.deny);
  for (const name of allow) {
    if (denied.has(name)) {
      throw new SidecarError(
        ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
        `tool_policy names ${name} in both deny and allow -- deny wins, so the allow entry can only mislead a reader`,
      );
    }
  }
  // Rule 6, by the kernel's own predicate on the mapped policy, so "where the flag is in force" has one
  // definition (UNSPECIFIED and UNRECOGNIZED map to interactive and count).
  if (usesProviderPermissionPrompts(mapClaudeHostPolicy(policy))) {
    for (const name of allow) {
      if (PROVIDER_PROMPT_TOOL_DENY.includes(name)) {
        throw new SidecarError(
          ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
          `tool_policy.allow names ${name}, which provider_permission_prompts removes from the session (the CLI only offers it because of the prompt channel that flag opens) -- drop it from allow, or do not set the flag`,
        );
      }
    }
  }
}

/**
 * The production CreateSession -> kernel session config mapping, in one exported function.
 *
 * Lives here rather than as a lambda inside `index.ts` for the same reason `mapClaudeHostPolicy`
 * does (see its comment): `index.ts`'s top-level `await startSidecar(...)` runs on any import, so
 * nothing in there can be exercised by a test. That is not a cosmetic concern for this particular
 * lambda -- it is the exact place the `resume` passthrough was once dropped, so a client asking to
 * resume silently got a brand-new session. A field accepted on the wire and dropped at the factory
 * looks identical, from every test that does not run the factory itself, to a field that works.
 */
export function buildKernelSessionConfig(
  config: ClaudeSessionConfigLike,
  hostDefaults: { account?: ClaudeAccount; hostCliPath?: string } = {},
): ClaudeSessionConfig {
  return {
    cwd: config.cwd,
    policy: mapClaudeHostPolicy(config.policy as ClaudeHostPolicyProto | undefined),
    account: hostDefaults.account,
    hostCliPath: hostDefaults.hostCliPath,
    ...(config.resumeProviderSessionId !== undefined
      ? { resume: { providerSessionId: config.resumeProviderSessionId }, fork: config.fork === true }
      : {}),
    // Empty means unset: proto3 has no presence for these, and unset must keep the CLI default.
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort as EffortLevel } : {}),
    // Presence, not emptiness: proto3 `optional` gives this field real presence, and
    // validateSystemPrompt has already refused a blank one.
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.outputFormat !== undefined
      ? { outputFormat: { type: 'json_schema' as const, schema: parseOutputSchema(config.outputFormat) } }
      : {}),
  };
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sidecarErrorToServiceError(error: SidecarError): grpc.ServiceError {
  const serviceError = Object.assign(new Error(error.message), {
    code: toGrpcStatusCode(error),
    metadata: toGrpcMetadata(error),
  }) as grpc.ServiceError;
  return serviceError;
}

/**
 * Every handler's catch funnels through this. A `SidecarError` already carries a real `ErrorCode` and
 * is passed through as-is; anything else (a plain `Error`, or any other thrown value) previously
 * reached the client via a bare `as grpc.ServiceError` cast that was a lie -- a plain `Error` has no
 * `.code`/`.metadata`, so grpc-js emitted `UNKNOWN` with empty trailers, defeating the "every failure
 * carries an ErrorDetail" contract (design spec §5.3). Wrapping it in a real SidecarError here (final
 * whole-branch review, Finding 6) is the exact same fix this file's own mapClaudeHostPolicy/
 * DEFAULT_CLAUDE_HOST_POLICY already applied once for one specific unmapped-throw path
 * (mapPolicy(undefined)) -- this generalizes it to every handler's generic catch instead of leaving
 * its twin defect in every OTHER code path that can still throw a plain Error.
 */
function toServiceError(err: unknown): grpc.ServiceError {
  if (err instanceof SidecarError) {
    return sidecarErrorToServiceError(err);
  }
  return sidecarErrorToServiceError(new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR, err instanceof Error ? err.message : String(err)));
}

/**
 * Builds the RuntimeService handler set (design spec §3.3/§4). sessionFactory is injected so tests
 * can supply a fake ClaudeRuntimeSession without touching the real kernel or spending real API cost;
 * production wiring (src/index.ts) passes a factory that calls the real @verdandi/claude-runtime
 * createSession(). `cachedActualClaudeCodeVersion` is resolved exactly once, by `startSidecar()`
 * before this function is ever called (final whole-branch review, Finding 1) -- the CLI-version
 * check itself has already happened by then too, so Handshake here only ever needs to report the
 * cached value, never recompute or re-validate it.
 *
 * That check is no longer all-or-nothing (2026-09-11): `cliCompatibility.ts` returns a four-tier
 * verdict, and `startSidecar` refuses to boot only on a *refused* version -- an in-range but
 * not-yet-tested one boots with a stderr diagnostic. So a version Handshake reports here CAN be one
 * this sidecar has never been tested against, and nothing on the wire says so; the diagnostic exists
 * only on the sidecar's stderr, which the spawning host drains. Whoever is next asked to surface
 * version skew to a client that ATTACHES to an already-running sidecar (rather than spawning it, and
 * so never sees that stderr) needs a real protocol field -- this comment previously claimed the case
 * could not arise.
 *
 * Resolving the version once also means Handshake no longer spawns a `claude --version` subprocess on every
 * single call (a related Minor the same review found: doing so blocks the single-threaded event loop
 * and stalls every live session's polling for the duration).
 */
/** Configuration that is per-deployment rather than per-session. Optional and defaulted, so every
 * existing three-argument call site keeps working unchanged. */
export type RuntimeServiceOptions = {
  ringBufferCapacity?: number;
  /** A test seam; see `replayConfig.ts`. Absent in production. */
  watchFault?: WatchFaultInjection;
  /** A diagnostic seam; see `replayConfig.ts`. Absent in production, and absent means no timer,
   *  no listeners, and no reading of `call.write`'s result. */
  writeQueueStats?: WriteQueueStats;
  /** Where the stats line goes. Injectable so a test can capture it; defaults to stderr, which is
   *  what a spawning host actually drains. */
  onDiagnostic?: (line: string) => void;
  /** Whether this build can serve `executable: 'sdk_bundled'`. Defaults to the real runtime answer.
   *  Governs BOTH what the handshake advertises and what `validatePolicy` accepts, from one value,
   *  so an advertised source and a served source cannot disagree. */
  sdkBundledAvailable?: boolean;
  /** The account every session of this process is pinned to -- the SAME value index.ts hands to
   *  `buildKernelSessionConfig` -- reported by Handshake. Absent means nothing is pinned, and
   *  Handshake says ACCOUNT_BINDING_UNPINNED. */
  account?: { name: string; configDir: string };
  /** True only when index.ts proved at startup that this process cannot reach loopback
   *  (VERDANDI_CLAUDE_SIDECAR_EGRESS=restricted, egress.ts). Governs the `egress_restricted`
   *  capability and nothing else; absent is false. */
  egressRestricted?: boolean;
};

/**
 * Counts what grpc-js is holding per watch subscriber, for the write-queue diagnostic.
 *
 * `outstanding` is the honest number: writes grpc-js accepted into its own buffer (`write()`
 * returned false) minus the drains that cleared it. It is not an estimate and it is not RSS -- it
 * is the count of messages sitting in the sidecar's heap because a subscriber is not reading them.
 */
function makeWriteQueueDepth(intervalMs: number, emit: (line: string) => void) {
  type Entry = { sessionId: string; outstanding: number; maxOutstanding: number; writes: number; backpressured: number };
  const entries = new Map<object, Entry>();

  const timer = setInterval(() => {
    if (entries.size === 0) {
      return;
    }
    let outstanding = 0;
    let maxOutstanding = 0;
    let writes = 0;
    let backpressured = 0;
    for (const e of entries.values()) {
      outstanding += e.outstanding;
      maxOutstanding = Math.max(maxOutstanding, e.maxOutstanding);
      writes += e.writes;
      backpressured += e.backpressured;
    }
    emit(
      `claude-sidecar: write-queue: subscribers=${entries.size} outstanding=${outstanding} peak_outstanding=${maxOutstanding} writes=${writes} buffered_writes=${backpressured}`,
    );
  }, intervalMs);
  // The sidecar must still exit on stdin EOF; a bare interval would hold the loop open forever.
  timer.unref?.();

  return {
    onSubscribe(sub: object, sessionId: string): void {
      entries.set(sub, { sessionId, outstanding: 0, maxOutstanding: 0, writes: 0, backpressured: 0 });
    },
    onUnsubscribe(sub: object): void {
      entries.delete(sub);
    },
    onWrite(sub: object, accepted: boolean): void {
      const e = entries.get(sub);
      if (e === undefined) {
        return;
      }
      e.writes += 1;
      if (!accepted) {
        e.backpressured += 1;
        e.outstanding += 1;
        e.maxOutstanding = Math.max(e.maxOutstanding, e.outstanding);
      }
    },
    onDrain(sub: object): void {
      const e = entries.get(sub);
      if (e !== undefined) {
        e.outstanding = 0;
      }
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

export function createRuntimeServiceImpl(
  registry: SessionRegistry,
  sessionFactory: (config: ClaudeSessionConfigLike) => MinimalKernelSession,
  cachedClaudeCodeVersions: ClaudeCodeVersions,
  options: RuntimeServiceOptions = {},
) {
  const canRunSdkBundled = options.sdkBundledAvailable ?? sdkBundledAvailable();
  const boundAccount = options.account;
  const egressRestricted = options.egressRestricted === true;
  const ringBufferCapacity = options.ringBufferCapacity ?? RING_BUFFER_CAPACITY;
  const watchFault = options.watchFault;
  const writeQueueDepth =
    options.writeQueueStats === undefined
      ? undefined
      : makeWriteQueueDepth(options.writeQueueStats.intervalMs, options.onDiagnostic ?? ((line) => console.warn(line)));
  // Which sessions have already had a watch stream broken on purpose. Per session and once only --
  // see `watchFaultInjectionFromEnv` for why firing on the reconnect too would defeat the very test
  // it exists to enable.
  const faultedSessions = new Set<string>();
  /** Live-event counts per subscriber, for the fault seam only. A WeakMap so a dropped subscriber's
   * entry goes with it rather than accumulating for the process's life. */
  const faultCounters = new WeakMap<object, number>();
  // session_id -> live subscribers for WatchSessionEvents, populated per active watch call. Each
  // subscriber carries both its write callback and its call's own `end` -- Finding 4 (final
  // whole-branch review): onTerminal below needs to gRPC-complete every open watcher's stream once the
  // session ends, not just stop writing to it and leave it open forever.
  const watchers = new Map<string, Set<{ send: (event: unknown) => void; end: () => void }>>();
  const drivers = new Map<string, PumpDriver>();

  function broadcastFor(sessionId: string) {
    return (sequenced: SequencedEvent) => {
      const subs = watchers.get(sessionId);
      if (subs === undefined) {
        return;
      }
      const partial = translateEvent(sequenced.event);
      const full = {
        sessionId,
        sequence: sequenced.sequence,
        occurredAt: sequenced.occurredAt,
        turnId: extractTurnId(sequenced.event),
        ...partial,
      };
      for (const sub of subs) {
        sub.send(full);
      }
    };
  }

  /**
   * Breaks ONE watch stream on purpose, leaving the session running.
   *
   * A test seam (see `replayConfig.ts`), inert unless configured. Everything it deliberately does
   * NOT touch is the point: the SessionEntry, the PumpDriver, and the registry all survive, so the
   * client's reconnect finds a live session with its history intact and the test observes replay
   * rather than a dead session. Removing the subscriber before destroying the call also matters --
   * a destroyed call still sitting in the watchers Set would be written to on the next pump tick.
   */
  function maybeBreakThisWatch(
    sessionId: string,
    subscribers: Set<{ send: (event: unknown) => void; end: () => void }>,
    sub: { send: (event: unknown) => void; end: () => void },
    call: { destroy: (err?: grpc.ServiceError) => void; emit: (event: 'error', err: grpc.ServiceError) => void },
  ): void {
    if (watchFault === undefined || faultedSessions.has(sessionId)) {
      return;
    }
    const delivered = (faultCounters.get(sub) ?? 0) + 1;
    faultCounters.set(sub, delivered);
    if (delivered < watchFault.afterEvents) {
      return;
    }
    faultedSessions.add(sessionId);
    subscribers.delete(sub);
    failStream(
      call,
      sidecarErrorToServiceError(
        new SidecarError(
          ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE,
          `fault injection: dropping this watch stream after ${delivered} event(s). The session is still running.`,
        ),
      ),
    );
  }

  /**
   * Ends a server-streaming call with a typed error the client actually receives.
   *
   * `call.destroy(err)` does NOT do this. Measured against a real grpc-js client over a real UDS:
   * a watch refused with `destroy` delivers no data, no error and no end -- the client simply hangs
   * forever. Every refusal this handler can produce (unknown session, EVENT_GAP, an invalid replay
   * request) used to go out that way, so none of them were reachable end to end: a client asking to
   * replay from an evicted cursor waited indefinitely instead of being told its history was gone.
   *
   * The mechanism, so nobody has to rediscover it empirically (established independently by a sibling
   * runtime track, which hit the same bug on 2026-09-10): grpc-js's
   * `ServerWritableStreamImpl` registers an `'error'` listener in its constructor which sets
   * `pendingStatus` and calls `end()`, and the status is actually written in `_final`. `destroy()`
   * marks the stream destroyed BEFORE emitting, so the `end()` can never reach `_final` --
   * `needFinish` is false. Nothing goes on the wire and the client hangs to its deadline.
   *
   * It stayed invisible because the tests for those paths assert on a FAKE call object's recorded
   * `destroy` argument. That proves the handler decided to refuse; it proves nothing about whether
   * the refusal leaves the process. `realWire.test.ts` is where that difference is now pinned.
   *
   * `emit('error', ...)` is grpc-js's own mechanism for failing a stream, and it carries the status
   * code and the `grpc-status-details-bin` trailer the client's typed error mapping reads.
   */
  function failStream(
    call: { emit: (event: 'error', err: grpc.ServiceError) => void },
    error: grpc.ServiceError,
  ): void {
    call.emit('error', error);
  }

  function requireEntry(sessionId: string): SessionEntry {
    const entry = registry.get(sessionId);
    if (entry === undefined) {
      throw new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, `no such session: ${sessionId}`);
    }
    return entry;
  }

  return {
    handshake(call: { request: { clientProtocolMajor: number } }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        if (call.request.clientProtocolMajor !== PROTOCOL_MAJOR) {
          throw new SidecarError(ErrorCode.ERROR_CODE_INCOMPATIBLE_PROTOCOL, `client protocol_major ${call.request.clientProtocolMajor} is incompatible with this sidecar's ${PROTOCOL_MAJOR}`);
        }
        callback(null, {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: 0,
          sidecarVersion: SIDECAR_VERSION,
          claudeAgentSdkVersion: CLAUDE_AGENT_SDK_VERSION,
          // These two were both filled from the same host-CLI probe, which made
          // `sdk_declared_...` report a version the SDK had never declared and hid the fact that
          // the two binaries differ at all. They are now the two things their names say.
          sdkDeclaredClaudeCodeVersion: cachedClaudeCodeVersions.sdkDeclared,
          actualClaudeCodeVersion: cachedClaudeCodeVersions.hostCli,
          // RPC names, plus the two feature capabilities that are NOT RPCs of their own: resume and
          // fork are parameters of CreateSession (see the proto), so a client cannot discover them
          // by looking at the service definition. Added only now that the sidecar genuinely passes
          // them through to the kernel -- advertising before implementing is the failure mode this
          // list exists to prevent.
          capabilities: [
            'handshake',
            'create_session',
            'send_turn',
            'watch_session_events',
            'interrupt_turn',
            'resolve_permission',
            'close_session',
            'resume_session',
            'fork_session',
            // Like resume/fork: parameters of CreateSession rather than RPCs, so a client cannot
            // discover them from the service definition. Added in the SAME commit that wires them
            // through to the kernel, per this list's own rule above.
            'setting_sources',
            'tool_policy',
            // CreateSession.model / .effort, wired through to the kernel in the same commit.
            'session_model',
            'session_effort',
            // CreateSession.system_prompt (a full replacement), wired through to the kernel in the
            // same commit.
            'system_prompt',
            // CreateSession.output_format, wired through to the kernel in the same commit.
            'output_format',
            // TurnCompleted.structured_output_json, plus result_subtype / terminal_reason /
            // api_error_status / errors, all wired in the same commit.
            'structured_output',
            // TurnCompleted.usage, summed from the SDK's modelUsage, wired in the same commit.
            'turn_usage',
            // HandshakeResponse.account_binding/_name/_config_dir and SessionReady.account_identity
            // (the kernel's accountInfo() probe; only a completion-shaped session -- an explicit
            // empty allow list, or output_format -- holds its first turn until it answers). The
            // handshake half landed one commit earlier; advertised once both halves are wired.
            'account_identity',
            // SessionReady.init_fingerprint AND the kernel's zero-tools invariant behind it (an
            // explicit empty allow list closes the session with TOOL_POLICY_VIOLATION on any other
            // reported tool). One capability for both, so a client that relies on the close can
            // require exactly this string.
            'init_fingerprint',
            // The kernel checks a NON-empty explicit allow list too -- system/init must report
            // exactly the carrier plus the requested tools -- and applies WEBFETCH_PRIVATE_DENY when
            // the list names WebFetch (muninn client spec §9.1). Advertised in the commit that wired
            // both; the controlplane requires it before a run with tools may come here.
            'tool_allow_list',
            // Only when startup PROVED this process cannot reach loopback (egress.ts). A claim
            // without that proof is exactly what a systemd --user unit with IPAddressDeny= makes.
            ...(egressRestricted ? ['egress_restricted'] : []),
            // Which of ClaudeHostPolicy.executable's values this BUILD can actually spawn. A
            // packaged single-file build serves host_cli only (see sdkBundledAvailable), and a
            // client that cannot tell the two builds apart would discover the difference as a
            // refused CreateSession instead of as a capability it never asked for.
            // The SetPermissionMode RPC and the PermissionModeChanged event, wired in the same
            // commit. An RPC name like the seven above, and advertised for the same reason they are.
            // Ahead of the executable pair on purpose: that pair stays LAST, so a packaged build's
            // list is still a checkout's minus its final entry (tests/packagedRuntime.test.ts).
            'set_permission_mode',
            // TextDelta.message_id / ThinkingDelta.message_id, wired in the same commit.
            'text_delta_message_id',
            // ClaudeHostPolicy.provider_permission_prompts (the kernel's canUseTool beside the gate,
            // and the three prompt tools removed) and PermissionRequested.origin / provider_reason /
            // provider_description, wired in the same commit.
            'provider_permission_prompts',
            'executable_host_cli',
            ...(canRunSdkBundled ? ['executable_sdk_bundled'] : []),
          ],
          configurationProfiles: ['native', 'isolated'],
          permissionModes: ['interactive', 'verdandi_rules', 'bypass'],
          maxMessageBytes: BigInt(4 * 1024 * 1024),
          // Built from the RESOLVED capacity, never the default constant: a handshake advertising a
          // capacity the sessions do not actually have lets a client assert on the wrong number and
          // pass, which is worse than not advertising it at all.
          eventBufferPolicy: `bounded-${ringBufferCapacity}`,
          // Reported from the value the sessions are actually built with (index.ts passes one
          // `account` to both), so a client can refuse the wrong sidecar before spending anything.
          accountBinding: boundAccount === undefined ? AccountBinding.ACCOUNT_BINDING_UNPINNED : AccountBinding.ACCOUNT_BINDING_PINNED,
          accountName: boundAccount?.name ?? '',
          accountConfigDir: boundAccount?.configDir ?? '',
        });
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    createSession(call: { request: ClaudeSessionConfigLike }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        validateResumeRequest(call.request);
        validateEffort(call.request);
        validateSystemPrompt(call.request);
        validateOutputFormat(call.request);
        // Beside validateResumeRequest, and for the identical reason: a policy that cannot be
        // honoured as written must fail as a typed client error BEFORE sessionFactory runs, so no
        // session object -- and, in production, no Claude subprocess -- ever exists for a request
        // that was never going to be served correctly.
        validatePolicy(call.request.policy as ClaudeHostPolicyProto | undefined, { sdkBundledAvailable: canRunSdkBundled });
        const sessionId = randomUUID();
        const session = sessionFactory(call.request);
        const entry = registry.create(sessionId, session, ringBufferCapacity);
        const driver = new PumpDriver(entry, {
          onEvent: broadcastFor(sessionId),
          onTerminal: (id) => {
            registry.remove(id);
            drivers.delete(id);
            const subs = watchers.get(id);
            if (subs !== undefined) {
              // Finding 4 (final whole-branch review): the terminal event has already reached every
              // subscriber via onEvent (PumpDriver broadcasts it before calling onTerminal), but the
              // gRPC call itself was never actually completed -- without this, a well-behaved client
              // has to invent its own "I saw session_closed, cancel now" convention instead of the
              // stream naturally ending. call.end() gRPC-completes it properly.
              for (const sub of subs) {
                sub.end();
              }
              subs.clear();
              watchers.delete(id);
            }
          },
        });
        drivers.set(sessionId, driver);
        driver.start();
        callback(null, { sessionId });
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    sendTurn(call: { request: { sessionId: string; commandId: string; text: string } }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        const entry = requireEntry(call.request.sessionId);
        const payloadHash = hashPayload({ text: call.request.text });
        const cached = entry.sendTurnIdempotency.check(call.request.commandId, payloadHash);
        if (cached.kind === 'conflict') {
          throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${call.request.commandId} reused with a different payload`);
        }
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        // The kernel's sendTurn() throws a plain Error (not a SidecarError) with one of exactly two
        // fixed messages (packages/claude-runtime/src/session.ts:320-325): "a turn is already in
        // progress on this session" (TURN_ALREADY_ACTIVE, the common case) or "session is closed"
        // (SESSION_NOT_FOUND -- the more accurate signal for a client than "busy"). The second is
        // genuinely reachable through this sidecar, not just a defensive branch: CloseSession calls
        // session.close() synchronously, making the kernel terminal immediately, while the registry
        // entry survives until PumpDriver's next tick evicts it -- up to the 20ms poll interval, and
        // for the entire up-to-5s graceful-shutdown drain window in lifecycle.ts, during which the
        // server is still accepting RPCs. Without this distinction, a SendTurn in that window would
        // return TURN_ALREADY_ACTIVE for a session that's actually dead, and a client's retry logic
        // would then wait forever for a turn_completed that can never arrive.
        let turnId: string;
        try {
          ({ turnId } = entry.session.sendTurn(call.request.text));
        } catch (kernelErr) {
          const message = kernelErr instanceof Error ? kernelErr.message : String(kernelErr);
          throw new SidecarError(message === 'session is closed' ? ErrorCode.ERROR_CODE_SESSION_NOT_FOUND : ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE, message);
        }
        entry.sendTurnIdempotency.record(call.request.commandId, payloadHash, { turnId });
        callback(null, { turnId });
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    // Note: ERROR_CODE_NO_ACTIVE_TURN is defined in the proto (design spec §5.3) but is never
    // produced by this handler this round -- the kernel's own interrupt() unconditionally forwards
    // to the underlying provider regardless of whether a turn is in flight, with no "no active turn"
    // signal exposed for the sidecar to surface. Tracking turn-in-progress state independently in
    // the sidecar to manufacture this check would duplicate state the kernel already owns privately
    // (exactly the kind of duplicated-bookkeeping bug this plan's own review caught once already with
    // sequence numbering) -- left as a known, documented gap rather than reintroducing that pattern.
    async interruptTurn(call: { request: { sessionId: string; commandId: string } }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        const entry = requireEntry(call.request.sessionId);
        const payloadHash = hashPayload({});
        const cached = entry.interruptIdempotency.check(call.request.commandId, payloadHash);
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        await entry.session.interrupt();
        entry.interruptIdempotency.record(call.request.commandId, payloadHash, {});
        callback(null, {});
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    resolvePermission(call: { request: { sessionId: string; commandId: string; permissionId: string; allow: boolean; reason?: string } }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        const entry = requireEntry(call.request.sessionId);
        const payloadHash = hashPayload({ permissionId: call.request.permissionId, allow: call.request.allow, reason: call.request.reason });
        const cached = entry.resolvePermissionIdempotency.check(call.request.commandId, payloadHash);
        if (cached.kind === 'conflict') {
          throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${call.request.commandId} reused with a different payload`);
        }
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        // resolvePermission() returns false for both "unknown id" and "already resolved" -- the
        // kernel's own PermissionBroker.resolve() cannot distinguish these two cases (design spec's
        // known-limitations note applies here too: this round can only ever report
        // ERROR_CODE_PERMISSION_NOT_FOUND for both, never ERROR_CODE_PERMISSION_ALREADY_RESOLVED,
        // since the kernel's contract genuinely doesn't expose which one happened).
        const resolved = entry.session.resolvePermission(call.request.permissionId, { allow: call.request.allow, reason: call.request.reason });
        if (!resolved) {
          throw new SidecarError(ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND, `no pending permission: ${call.request.permissionId}`);
        }
        entry.resolvePermissionIdempotency.record(call.request.commandId, payloadHash, {});
        callback(null, {});
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    closeSession(call: { request: { sessionId: string; commandId: string } }, callback: (err: grpc.ServiceError | null, res?: unknown) => void) {
      try {
        const entry = requireEntry(call.request.sessionId);
        const payloadHash = hashPayload({});
        const cached = entry.closeIdempotency.check(call.request.commandId, payloadHash);
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        entry.session.close();
        entry.closeIdempotency.record(call.request.commandId, payloadHash, {});
        callback(null, {});
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    /**
     * SetPermissionMode (capability 'set_permission_mode'). Idempotent per command_id like the other
     * mutating RPCs, and recorded only once the CLI acknowledged: a refused switch leaves nothing a
     * retry could replay as success.
     */
    async setPermissionMode(
      call: { request: { sessionId: string; commandId: string; mode: PermissionMode } },
      callback: (err: grpc.ServiceError | null, res?: unknown) => void,
    ) {
      try {
        const entry = requireEntry(call.request.sessionId);
        const mode = call.request.mode;
        if (mode !== PermissionMode.PERMISSION_MODE_INTERACTIVE && mode !== PermissionMode.PERMISSION_MODE_VERDANDI_RULES && mode !== PermissionMode.PERMISSION_MODE_BYPASS) {
          // Never defaulted: PERMISSIONS_MAP sends UNSPECIFIED to 'interactive' for CreateSession's
          // backwards compatibility, but a switch whose target nobody stated is not a request to be
          // gated -- it is a client that did not say.
          throw new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, `set_permission_mode needs a mode (INTERACTIVE, VERDANDI_RULES or BYPASS), got ${mode}`);
        }
        const payloadHash = hashPayload({ mode });
        const cached = entry.setPermissionModeIdempotency.check(call.request.commandId, payloadHash);
        if (cached.kind === 'conflict') {
          throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${call.request.commandId} reused with a different payload`);
        }
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        // A duplicate of a call still waiting on the CLI joins it -- same outcome, success or
        // failure -- instead of running the switch twice. A different payload under the same id is
        // the conflict it would be once recorded.
        const commandId = call.request.commandId;
        const inFlight = entry.setPermissionModeInFlight.get(commandId);
        if (inFlight !== undefined) {
          if (inFlight.payloadHash !== payloadHash) {
            throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${commandId} reused with a different payload`);
          }
          callback(null, await inFlight.outcome);
          return;
        }
        const outcome = (async () => {
          try {
            const result = await entry.session.setPermissionMode(PERMISSIONS_MAP[mode]);
            const done = { permissionMode: result.permissionMode };
            entry.setPermissionModeIdempotency.record(commandId, payloadHash, done);
            return done;
          } catch (kernelErr) {
            if (kernelErr instanceof PermissionModeError) {
              throw new SidecarError(
                kernelErr.kind === 'closed' ? ErrorCode.ERROR_CODE_SESSION_NOT_FOUND : ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
                kernelErr.kind === 'provider_refused' ? `the provider refused the permission mode: ${kernelErr.message}` : kernelErr.message,
              );
            }
            throw new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE, kernelErr instanceof Error ? kernelErr.message : String(kernelErr));
          } finally {
            // Settled: a later retry of a FAILED call really runs again (nothing was recorded), and
            // one of a successful call replays from the cache above.
            entry.setPermissionModeInFlight.delete(commandId);
          }
        })();
        entry.setPermissionModeInFlight.set(commandId, { payloadHash, outcome });
        callback(null, await outcome);
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    watchSessionEvents(call: {
      request: { sessionId: string; start: ReplayStart; afterSequence?: bigint | undefined };
      // `boolean`, not `void`, and that is a correction rather than a widening: grpc-js's
      // ServerWritableStream.write DOES return one, and it is the only congestion signal this
      // server ever gets -- false means the message went into grpc-js's own buffer in this
      // process rather than out to the socket. Typed as `void` here, the value was not merely
      // ignored, it was unreachable: nobody could have consulted it without changing this line
      // first. A local structural type that is narrower than the real thing hides the API.
      write: (chunk: unknown) => boolean;
      end: () => void;
      destroy: (err?: grpc.ServiceError) => void;
      emit: (event: 'error', err: grpc.ServiceError) => void;
      // 'drain' is the other half of that signal: grpc-js emits it when the buffer above clears.
      on: (event: 'cancelled' | 'close' | 'error' | 'drain', listener: () => void) => void;
    }) {
      // This handler had no try/catch at all, which was survivable only while nothing in it could
      // throw. Parsing a typed replay request can, and an unmapped throw out of a grpc-js streaming
      // handler reaches the client as UNKNOWN with no ErrorDetail -- indistinguishable from the
      // transport failing, which is the one thing a replay refusal must never look like.
      try {
        const sessionId = call.request.sessionId;
        const entry = requireEntry(sessionId);
        const replay = entry.ringBuffer.replay(replayRequestFromProto(call.request));

        if (replay.kind === 'gap') {
          throw new SidecarError(
            ErrorCode.ERROR_CODE_EVENT_GAP,
            `after_sequence ${replay.requested} is older than the replay buffer still holds (oldest retained: ` +
              `${replay.oldestRetained}); the events between them have been evicted and cannot be replayed`,
          );
        }
        if (replay.kind === 'future_cursor') {
          throw new SidecarError(
            ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
            `after_sequence ${replay.requested} is beyond anything this session has ever emitted (latest: ` +
              `${replay.latest}), so it cannot have come from this stream. A sequence cursor is ephemeral ` +
              `state belonging to one session on one sidecar process -- it is not durable and not portable.`,
          );
        }

        for (const sequenced of replay.events) {
          const partial = translateEvent(sequenced.event);
          call.write({
            sessionId,
            sequence: sequenced.sequence,
            occurredAt: sequenced.occurredAt,
            turnId: extractTurnId(sequenced.event),
            ...partial,
          });
        }

        let subs = watchers.get(sessionId);
        if (subs === undefined) {
          subs = new Set();
          watchers.set(sessionId, subs);
        }
        // Cleanup is registered directly on the call here, not via a returned function -- grpc-js never
        // reads a server-streaming handler's return value, so a caller-invoked cleanup closure would
        // never actually run. Design spec §3.1: disconnecting a watcher never affects session lifecycle,
        // so this only removes the subscription, never touches the registry.
        const subscribers = subs;
        const sub = {
          send: (event: unknown) => {
            const accepted = call.write(event);
            // Only consulted when the stats seam is on. `accepted === false` means grpc-js buffered
            // this message in the sidecar's own heap instead of writing it to the socket, which is
            // the growth this counts. Behaviour is unchanged either way: nothing here slows the
            // producer down, because doing so would be a real backpressure policy rather than a
            // measurement, and that is a separate decision with a client-visible consequence.
            if (writeQueueDepth !== undefined) {
              writeQueueDepth.onWrite(sub, accepted);
            }
            maybeBreakThisWatch(sessionId, subscribers, sub, call);
          },
          end: () => call.end(),
        };
        if (writeQueueDepth !== undefined) {
          // 'drain' is grpc-js telling us its buffer for this call has emptied. Without it the
          // counter would only ever climb, which would look like an unbounded queue even on a
          // healthy stream -- a measurement that cannot show the good case is not a measurement.
          call.on('drain', () => writeQueueDepth!.onDrain(sub));
          writeQueueDepth.onSubscribe(sub, sessionId);
          call.on('cancelled', () => writeQueueDepth!.onUnsubscribe(sub));
          call.on('close', () => writeQueueDepth!.onUnsubscribe(sub));
          call.on('error', () => writeQueueDepth!.onUnsubscribe(sub));
        }
        subscribers.add(sub);
        const cleanup = () => subscribers.delete(sub);
        call.on('cancelled', cleanup);
        call.on('close', cleanup);
        call.on('error', cleanup);
      } catch (err) {
        failStream(call, toServiceError(err));
      }
    },
  };
}
