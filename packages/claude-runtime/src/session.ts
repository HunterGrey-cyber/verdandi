import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { translateMessage, type TranslationContext } from './eventTranslation.js';
import type { AccountIdentity, ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig, PermissionOutcome, SessionCloseReason, TurnOutcome } from './types.js';
import type { PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { applyAccountEnv, type ClaudeAccount } from './account.js';
import type { MinimalQuery } from './queryTypes.js';
import { PermissionBroker, type GateDecision } from './permissionBroker.js';
import { resultDetail } from './resultDetail.js';
import { DEFAULT_ACCOUNT_INFO_TIMEOUT_MS, probeAccountIdentity, type AccountProbe } from './accountIdentity.js';
import { initToolViolation, permittedInitTools, requiredInitTools } from './toolInvariant.js';
import { webFetchDenyFor } from './webFetchDeny.js';

/**
 * The real SDK's `query()` signature (sdk.d.ts:2839): `(params: { prompt: string |
 * AsyncIterable<SDKUserMessage>; options?: Options }) => Query`. Narrowed to `MinimalQuery`'s
 * return type (Task 1) so this module and its tests can both satisfy the same function type --
 * the real SDK's `Query` is a strict superset of `MinimalQuery`.
 */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => MinimalQuery;

/**
 * What `executable: 'host_cli'` spawns when the caller names nothing more specific. A bare command
 * name, resolved through PATH by the spawn itself -- deliberately the same string the sidecar's own
 * version probe defaults to, so the binary that gets measured and the binary that gets run are
 * never two different things.
 */
export const DEFAULT_HOST_CLI_PATH = 'claude';

/**
 * Applied to a BYPASS session that states no tool restriction at all. Same names and same order as
 * Neovibe's own legacy list (`neovibe/agent/src/process.rs`'s `CONSERVATIVE_DISALLOWED_TOOLS`) so
 * the two paths agree and a reader can grep across both repos.
 *
 * A floor, not a lock: any stated restriction takes it off (see `usesDefaultBypassDeny`), and even
 * when it applies it is a configuration boundary -- see `ClaudeHostPolicy.toolPolicy`'s own comment.
 */
export const CONSERVATIVE_BYPASS_DENY: readonly string[] = Object.freeze([
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
]);
// Frozen, not merely `readonly`. `readonly` is erased at compile time, and this array is exported
// from the package index for other code to read, so an unfrozen one is a shared mutable security
// constant. Emptying it in process produces precisely the apply/announce divergence
// `usesDefaultBypassDeny` exists to make impossible: `policyToBaseOptions` guards on
// `deny.length > 0`, so `disallowedTools` would be left unset while the notice still fired claiming
// `bypass_default_deny_applied` -- a bypass session with no hook, no deny list, and an event
// asserting it was protected.

/**
 * The single source of truth for "this policy states no tool restriction whatsoever, under a
 * permission mode that installs no gate either". Used by `policyToBaseOptions` to decide whether to
 * inject `CONSERVATIVE_BYPASS_DENY`, and by `createSession` to decide whether to announce that it
 * did -- two call sites, one rule, so they cannot disagree about which sessions got the default.
 *
 * `bypass` is the only mode this can be true for on purpose: it is the one mode where no PreToolUse
 * hook is installed at all, so "no tool policy" would otherwise mean "nothing is watching, and
 * nothing said so". Present-but-empty counts as silence deliberately -- `{}` and `{ deny: [] }` are
 * the shapes a caller reaches by forgetting, not by choosing.
 *
 * `unrestricted` is the one shape a caller reaches by CHOOSING it, and it is therefore the one that
 * is not silence. It was added because the carve-out above had only one exit: state some other
 * restriction. A caller that genuinely wanted every tool had to claim it wanted something narrower
 * -- and `deny: ['bash']`, lowercase, is a typo the sidecar cannot tell from a statement, as
 * `ClaudeHostPolicy.tool_policy`'s own comment admits. Now the deliberate case has its own spelling
 * and the typo no longer imitates it.
 *
 * Tested for `true`, never for presence. It arrives from a proto3 scalar, which is `false` for every
 * sender that never heard of the field, so a presence check would read all of them as having
 * declined the floor.
 */
export function usesDefaultBypassDeny(policy: ClaudeHostPolicy): boolean {
  return policy.permissions === 'bypass'
    && policy.toolPolicy?.unrestricted !== true
    && (policy.toolPolicy?.deny ?? []).length === 0
    && policy.toolPolicy?.allow === undefined;
}

/**
 * Maps `ClaudeHostPolicy` (design doc §5.3) to the real SDK's `Options` fields this task's scope
 * covers. `permissions`/hook installation is Task 4's job -- this function must NOT set
 * `options.hooks` or `options.canUseTool`, so a caller who bypasses Task 4's `createSessionWithHook`
 * (Task 4 wraps this) never accidentally gets an unprotected session that looks configured.
 *
 * ### What `configuration: 'isolated'` has to set, and why `settingSources` alone was not it
 *
 * `settingSources: []` disables exactly four things, per the SDK's own doc for that option:
 * `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and CLAUDE.md.
 * Three channels into the host environment run past it entirely, so an `isolated` session that
 * only emptied `settingSources` was isolated in name and not in effect:
 *
 * - **`$CLAUDE_CONFIG_DIR/.claude.json`** -- a different file from any settings.json, holding
 *   per-project state and per-project `mcpServers`. Not a setting source; the only lever on it is
 *   which directory `CLAUDE_CONFIG_DIR` names, which is `account`'s business below.
 * - **Auto-memory** -- reads and writes `~/.claude/projects/<sanitized-cwd>/memory/` by default
 *   (SDK `Settings.autoMemoryDirectory` doc). Closed here from both sides: the `Settings` flag
 *   layer via `options.settings`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` for the code paths that
 *   read the env var directly.
 * - **MCP** -- `strictMcpConfig`'s own doc enumerates what it, and only it, suppresses: project
 *   `.mcp.json`, user settings, plugins, and on-disk agent frontmatter. Beyond those sit the
 *   claude.ai connectors, which are reachable through whichever account is authenticated and
 *   therefore not a filesystem question at all. `mcpServers: {}` is set alongside it so the
 *   allowed set is stated rather than defaulted.
 *
 * `account` is orthogonal to all of that and applies to both profiles: it pins *which* account the
 * subprocess authenticates as. Left undefined (the shipped default) no `env` override is produced,
 * and the SDK's own `env: {...process.env}` default stands.
 *
 * ### `executable`
 *
 * `sdk_bundled` leaves `pathToClaudeCodeExecutable` unset, which is how the SDK is told to use the
 * native CLI binary shipped inside its own npm package -- a version pinned to the SDK dependency
 * and changed only by bumping it. `host_cli` points it at the CLI installed on the machine, which
 * updates on its own schedule: the same binary a human runs, with the same features and fixes, and
 * the same drift. These are genuinely different programs at different versions on the same host, so
 * this field was never cosmetic -- it went unread, which meant every session silently got
 * `sdk_bundled` no matter what the policy said, including the default policy, which says `host_cli`.
 */
export function policyToBaseOptions(
  policy: ClaudeHostPolicy,
  cwd: string,
  overrides: { account?: ClaudeAccount; baseEnv?: NodeJS.ProcessEnv; hostCliPath?: string } = {},
): Options {
  const options: Options = {
    cwd,
    persistSession: policy.persistence === 'host_cli',
    // `??` because the question is PRESENCE, not truthiness: an explicit `[]` is a real request
    // ("load no filesystem settings tiers") and must reach the SDK as `[]`.
    //
    // Note for anyone "simplifying" this: `||` would NOT break it -- `[]` is truthy in JavaScript,
    // so `||` and `??` agree on every inhabitant of this field's type. The mutation that actually
    // collapses presence is a LENGTH check -- `policy.settingSources?.length ? … : preset` -- which
    // silently turns "load nothing, stated" into "defer to the preset", i.e. full inheritance of the
    // operator's `~/.claude` for a caller who asked for the opposite. That is the mutation the test
    // guards, and it is the one to reach for when proving the guard still bites.
    //
    // `policy.settingSources` overrides the settings-tier half of `configuration` and nothing else
    // -- the `isolated` block further down is untouched by it, which is what keeps `isolated` +
    // `['project','local']` meaning "project CLAUDE.md, but MCP and auto-memory still closed"
    // rather than quietly re-opening them.
    settingSources: policy.settingSources ?? (policy.configuration === 'native' ? ['user', 'project', 'local'] : []),
    // When on, the SDK additionally emits `stream_event` messages carrying Anthropic Messages API
    // streaming events while a reply is being produced. Absent it, a consumer sees nothing at all
    // until a whole assistant message lands -- measured at ~12s of silence for a 1500-word reply.
    includePartialMessages: policy.streaming === 'partial',
  };
  if (policy.permissions === 'bypass') {
    options.permissionMode = 'bypassPermissions';
  } else if (policy.permissionModeSwitchable === true) {
    // What makes a GATED session switchable to bypass later (`setPermissionMode`), and only when the
    // caller opted in: as root/sudo without IS_SANDBOX=1 the CLI exits 1 at startup with this flag
    // ("--dangerously-skip-permissions cannot be used with root/sudo privileges"). The CLI refuses
    // `set_permission_mode: bypassPermissions` on a session that was not launched with it -- read
    // out of the 2.1.283 binary: "Cannot set permission mode to bypassPermissions because the
    // session was not launched with --dangerously-skip-permissions" (code `bypass_not_launched`) --
    // and `--allow-dangerously-skip-permissions` is the flag that makes bypass AVAILABLE without
    // starting in it. It changes no mode: the session still starts in `default` and still reports
    // it at system/init, and only this host can switch it (the SDK channel is the only way in; no
    // tool the model can call sets a permission mode).
    options.allowDangerouslySkipPermissions = true;
  }
  if (policy.executable === 'host_cli') {
    options.pathToClaudeCodeExecutable = overrides.hostCliPath ?? DEFAULT_HOST_CLI_PATH;
  }

  // Applied HERE rather than at the sidecar boundary, for the same reason this function's own doc
  // comment gives about hooks: a kernel consumer that does not go through the sidecar must not be
  // able to skip it.
  const deny = [...(policy.toolPolicy?.deny ?? [])];
  if (usesDefaultBypassDeny(policy)) {
    deny.push(...CONSERVATIVE_BYPASS_DENY);
  }
  // Scoped rules, not tool names: WebFetch stays available and only the matching fetches are
  // refused. Applied here for the same reason as the floor above -- a kernel consumer that does not
  // go through the sidecar (the M1 probe) must get exactly what a production session gets.
  deny.push(...webFetchDenyFor(policy));
  if (deny.length > 0) {
    options.disallowedTools = deny;
  }
  if (policy.toolPolicy?.allow !== undefined) {
    // `Options.tools`, NEVER `Options.allowedTools`. The SDK's own doc for allowedTools: "List of
    // tool names that are auto-allowed without prompting for permission. These tools will execute
    // automatically without asking the user for approval. To restrict which tools are available,
    // use the `tools` option instead." Putting an allow list there would WIDEN access -- every
    // named tool would stop prompting -- under a field whose name promises the opposite.
    //
    // `[]` reaches here intact on purpose: `Options.tools` documents "`[]` (empty array) - Disable
    // all built-in tools", so present-but-empty is a stated request and not the same as absent.
    options.tools = [...policy.toolPolicy.allow];
  }

  const envOverlay: Record<string, string> = {};
  if (policy.configuration === 'isolated') {
    options.strictMcpConfig = true;
    options.mcpServers = {};
    options.settings = { autoMemoryEnabled: false };
    envOverlay.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  // Overlay, never replacement: the subprocess still needs PATH, HOME, proxy variables and the rest
  // of the host environment to function. Only the keys above are decided here. Setting `env` at all
  // is itself conditional, so a host that pins nothing and uses `native` keeps the SDK's untouched
  // default rather than an identical-but-explicitly-rebuilt copy of `process.env`.
  //
  // A pinned account always gets an explicit `env`, even when it adds nothing: an account at the
  // CLI's default location is bound by the tuple being ABSENT (see `applyAccountEnv`), and leaving
  // the SDK's `{...process.env}` default in place would let an inherited CLAUDE_CONFIG_DIR decide.
  if (overrides.account !== undefined) {
    options.env = applyAccountEnv({ ...(overrides.baseEnv ?? process.env), ...envOverlay }, overrides.account);
  } else if (Object.keys(envOverlay).length > 0) {
    options.env = { ...(overrides.baseEnv ?? process.env), ...envOverlay };
  }
  return options;
}

type PendingInput = { message: SDKUserMessage } | { end: true };

/**
 * Builds the async-iterable prompt input the real SDK's streaming-input mode needs (`query()`'s
 * `prompt: AsyncIterable<SDKUserMessage>` overload) together with a `push` function the session
 * actor calls once per `sendTurn()`. This is the standard async-generator-plus-queue pattern for
 * a producer that doesn't know its next value ahead of time; Node has no built-in for this.
 */
function makeInputQueue(): { iterable: AsyncIterable<SDKUserMessage>; push: (message: SDKUserMessage) => void; end: () => void } {
  const queue: PendingInput[] = [];
  let waiter: ((value: PendingInput) => void) | undefined;

  function deliver(item: PendingInput): void {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage, void>> {
          const next = queue.shift() ?? (await new Promise<PendingInput>((resolve) => (waiter = resolve)));
          if ('end' in next) {
            return { value: undefined, done: true };
          }
          return { value: next.message, done: false };
        },
      };
    },
  };

  return {
    iterable,
    push: (message) => deliver({ message }),
    end: () => deliver({ end: true }),
  };
}

/**
 * The part of a session's permission posture that `setPermissionMode` can change while it runs, and
 * that its PreToolUse gate reads on every call. One mutable object shared by the gate (built before
 * the session exists) and the session, so the two cannot disagree about which mode is in force.
 */
export type PermissionGateState = {
  /** The mode now in force on the gate. Starts as the policy's own `permissions`. */
  permissions: ClaudeHostPolicy['permissions'];
  /** True while in `bypass` entered by a switch AND the conservative bypass floor applies to this
   * session's policy (see `usesDefaultBypassDeny`): the gate then denies the floor's tools itself,
   * because `disallowedTools` can only be set when the session is created. */
  bypassFloor: boolean;
};

/**
 * What the PreToolUse gate does with one call under `state`. Pure, exported for testing.
 *
 * - A gated mode asks the host, exactly as before switching existed.
 * - `bypass` ABSTAINS -- returns no decision at all -- so the CLI's own `bypassPermissions` decides,
 *   the same outcome as a session created under bypass, which has no hook. It deliberately does not
 *   return `allow`: an explicit hook allow is a grant of its own, and abstaining leaves every rule
 *   the CLI would apply in bypass (deny rules included) exactly where they were.
 * - ...except the floor's tools while `bypassFloor` holds, which it denies with a reason naming why.
 */
export function gateDecision(state: PermissionGateState, toolName: string): GateDecision {
  if (state.permissions !== 'bypass') {
    return { kind: 'ask' };
  }
  if (state.bypassFloor && CONSERVATIVE_BYPASS_DENY.includes(toolName)) {
    return {
      kind: 'deny',
      reason: `${toolName} is denied by the conservative bypass floor (CONSERVATIVE_BYPASS_DENY): this session entered bypass by a permission-mode switch and its tool policy stated no restriction. Create the session with tool_policy.unrestricted to decline the floor.`,
    };
  }
  return { kind: 'abstain' };
}

/** The provider-level mode each host-level mode runs as -- the same mapping `policyToBaseOptions`
 * applies at creation (bypass sets `bypassPermissions`; the gated modes set nothing, i.e. `default`). */
export function providerPermissionMode(permissions: ClaudeHostPolicy['permissions']): SdkPermissionMode {
  return permissions === 'bypass' ? 'bypassPermissions' : 'default';
}

/** Why `setPermissionMode` refused, for a host that maps failures to its own error codes. */
export class PermissionModeError extends Error {
  constructor(
    /** `refused`: this session cannot make that switch (see `setPermissionMode`). `provider_refused`:
     * the CLI rejected the control request -- its own words are the message. `closed`: the session
     * ended before or while switching. */
    readonly kind: 'refused' | 'provider_refused' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'PermissionModeError';
  }
}

/**
 * Per-session behaviour `createSession` switches on, grouped so the constructor does not grow a
 * positional parameter per feature.
 */
export type SessionGuards = {
  /** Which account the provider authenticated as, being asked. When present, every session_ready
   * carries the answer (or says it is not in yet), and termination cancels the probe. */
  accountProbe?: AccountProbe;
  /** With `accountProbe`: hold the FIRST turn's message until `identity` settles, so the provider
   * sees no input -- and spends nothing -- before the account is known. `createSession` sets it
   * from `holdsFirstTurnForAccount`; without it the probe runs alongside the turn and nothing waits. */
  holdFirstTurnForAccount?: boolean;
  /** When set, the exact tool names every system/init may report (see `permittedInitTools`). Any
   * other tool, or no tools list at all, closes the session with `tool_policy_violation`. */
  permittedInitTools?: readonly string[];
  /** With `permittedInitTools`: the tool names every system/init MUST report (see
   * `requiredInitTools`). Any one missing closes the session with `tool_policy_violation` too. */
  requiredInitTools?: readonly string[];
  /** Enables `setPermissionMode`: the gate's shared state and the policy the session was created
   * with. Absent (a session built directly in a test), `setPermissionMode` refuses. */
  permissionSwitch?: { state: PermissionGateState; policy: ClaudeHostPolicy };
};

/**
 * Whether a session holds its first turn until the account probe answers: only a completion-shaped
 * one -- an explicit EMPTY allow list, or an output format. Those are the sessions that must not
 * spend before the account is known (muninn spec §6.3 P2), and a bounded wait on a slow CLI is
 * theirs to pay. Every other session -- the investigator chain's `unrestricted`, Neovibe's
 * interactive ones -- asks alongside its first turn and never waits, so a CLI whose accountInfo()
 * is slow or hangs cannot delay them (spec §6.3: that chain's behaviour stays unchanged).
 */
export function holdsFirstTurnForAccount(config: Pick<ClaudeSessionConfig, 'policy' | 'outputFormat'>): boolean {
  const allow = config.policy.toolPolicy?.allow;
  return (allow !== undefined && allow.length === 0) || config.outputFormat !== undefined;
}

export class ClaudeRuntimeSession {
  private turnInProgress = false;
  private currentTurnId: string | undefined;
  private readonly events: ClaudeRuntimeEvent[];
  private readonly inputQueue: ReturnType<typeof makeInputQueue>;
  private readonly permissionBroker: PermissionBroker;
  /** Events produced OUT OF BAND -- that is, by anything other than translating a message the
   * provider just sent us. `pump()` is the only channel this poll-only actor gives a caller to
   * learn about anything new, so an event that never passes through here is invisible to every
   * consumer. `pump()` drains this buffer into its own return value on every call; entries land in
   * `this.events` only once `pump()` does that draining, same as every other event this class
   * produces.
   *
   * Three producers: `PermissionBroker`'s `emit` callback (wired in `createSession`), `close()`'s
   * own terminal events, and -- since 2026-09-11 -- `sendTurn()`'s `turn_started`.
   *
   * That last one used to push straight into `this.events`, justified as "a synchronous call's own
   * caller already knows about its own event". True when this class had exactly one caller. It
   * stopped being true the moment the gRPC sidecar added `WatchSessionEvents`: a broadcast
   * subscriber is not the caller of `sendTurn` and has no other way to learn a turn began. Measured
   * against a real sidecar and a real CLI: two real turns produced zero `turn_started` events on
   * the wire, while `turn_completed` (which travels the normal translation path) arrived for both.
   * Downstream that means a client can never light a "turn in progress" indicator, gate a Stop
   * button, or reject a concurrent turn from authoritative state.
   *
   * The name is now a misnomer -- it is not permission-specific and has not been since `close()`
   * started using it. Left alone deliberately to keep this fix a small, obvious diff; whoever
   * renames it should call it something like `pendingOutOfBandEvents`. Do NOT "restore" any
   * producer to `this.events`: that is precisely the bug. */
  private readonly pendingPermissionEvents: ClaudeRuntimeEvent[];
  /** True once `close()` has been explicitly called -- used ONLY to pick the right
   * `SessionCloseReason` label (`closed_by_host` vs `provider_exited`) once the underlying
   * generator reports `done`; the actual termination bookkeeping is `terminal` below. */
  private closed = false;
  /** True once `terminate()` has actually run to completion, via ANY of its three call sites
   * (`close()`, a clean provider exit, or a provider failure). Latches so termination can only
   * ever happen once: `terminate()` itself checks this first and no-ops on a repeat call, and
   * `pump()`/`sendTurn()` check it to refuse further work on an already-dead session instead of
   * re-running cleanup, re-emitting `session_closed`, or accepting a turn that will never run. */
  private terminal = false;
  /** Reentrancy guard -- `pump()` is documented as a poll-only actor with no internal concurrency
   * of its own; nothing stops a careless caller (e.g. a gRPC sidecar with concurrent request
   * handlers, the actual named next consumer of this package) from calling `pump()` twice before
   * the first call resolves. Without this guard, two overlapping calls would both drain the SAME
   * `pendingNext`/query messages and both append them to `this.events`, duplicating every event.
   * Set/cleared synchronously around `pump()`'s own body -- a second call made while the first is
   * still in flight returns `[]` immediately rather than touching any shared state. */
  private pumping = false;
  /** Whether this session asked the SDK for partial messages. Decides which of the two copies of
   * assistant text -- the stream events or the completed message -- is translated. */
  private partialStreaming = false;
  /** Whether a stream_event has produced a text/thinking delta since the last assistant message.
   *  See TranslationContext.streamedSinceLastAssistant for why the suppression needs it. */
  private streamedSinceLastAssistant = false;
  /** The one `rawQuery.next()` call currently in flight, if any -- reused across `pump()` calls
   * rather than issuing a fresh `.next()` call every time one is outstanding. Empirically required
   * against the real SDK (Task 3 Step 4/6's real-CLI run): the real `Query`'s `next()` does not
   * queue concurrent calls the way this package's own fake (`tests/fakeQuery.ts`) or a native
   * `async function*` generator would -- a second `.next()` call issued before the first settles
   * silently orphans the first call's promise, so no message the CLI already produced is ever
   * delivered to a caller that keeps calling `.next()` again on every non-blocking poll. Holding at
   * most one in-flight call here, and only starting a new one once the previous settles, keeps
   * `pump()` itself non-blocking (a call with nothing ready still returns immediately) while never
   * having more than one outstanding call against `rawQuery` at a time. */
  private pendingNext: ReturnType<MinimalQuery['next']> | undefined;

  constructor(
    private readonly rawQuery: MinimalQuery,
    inputQueue: ReturnType<typeof makeInputQueue>,
    permissionBroker: PermissionBroker,
    initialEvents: ClaudeRuntimeEvent[],
    pendingPermissionEvents: ClaudeRuntimeEvent[],
    partialStreaming = false,
    /** What this session asked to resume, if anything. Carried so the session can say whether the
     * resume actually took hold: before this, `createSession` read `config.resume`, handed it to
     * the SDK, and then forgot it -- nothing downstream held the requested id, so nothing could
     * compare an observed session id against it or attribute a provider failure to the resume. */
    resumeIntent?: ResumeIntent,
    guards: SessionGuards = {},
  ) {
    this.inputQueue = inputQueue;
    this.permissionBroker = permissionBroker;
    this.events = initialEvents;
    this.pendingPermissionEvents = pendingPermissionEvents;
    // Must match the `includePartialMessages` this session's own options carry. Passed rather than
    // re-derived so the two cannot disagree: a session that asked for partials but translates as if
    // it did not would drop every assistant character, and the reverse would double them.
    this.partialStreaming = partialStreaming;
    this.resumeIntent = resumeIntent;
    this.accountProbe = guards.accountProbe;
    this.permittedInitTools = guards.permittedInitTools;
    this.requiredInitTools = guards.requiredInitTools ?? [];
    // Registered here, before any sendTurn can register its own continuation on the same promise,
    // so by the time a held turn is released the settled identity is already recorded.
    void this.accountProbe?.identity.then((identity) => {
      this.settledAccountIdentity = identity;
    });
    this.holdFirstTurnForAccount = guards.holdFirstTurnForAccount === true;
    this.permissionSwitch = guards.permissionSwitch;
  }

  private readonly permissionSwitch: SessionGuards['permissionSwitch'];
  /** Serialises `setPermissionMode` calls, so two overlapping switches apply in call order and the
   * gate never ends up describing the one the CLI did not end up in. */
  private permissionModeChain: Promise<unknown> = Promise.resolve();
  /** The API message id of the partial-streaming message in flight, per `parent_tool_use_id` (''
   * for the main thread), from each stream's `message_start`. See TranslationContext.streamMessageId. */
  private readonly streamMessageIds = new Map<string, string>();

  private readonly accountProbe: AccountProbe | undefined;
  private readonly permittedInitTools: readonly string[] | undefined;
  private readonly requiredInitTools: readonly string[];
  /** Set by translateOne when a system/init breaks `permittedInitTools`; pump() then terminates the
   * session before translating anything else. */
  private toolPolicyViolation: string | undefined;
  private settledAccountIdentity: AccountIdentity | undefined;
  /** The first turn, while its message waits for the account probe. Cleared when the message is
   * delivered, and by interrupt()/terminate() -- either of which means it is never delivered. */
  private heldFirstTurn: { turnId: string } | undefined;
  /** SessionGuards.holdFirstTurnForAccount, fixed at construction. False for every session that is
   * not completion-shaped: its first turn is never held. */
  private readonly holdFirstTurnForAccount: boolean;

  /** The provider's account identity once known; `undefined` for a session built without an
   * account probe. Settles no later than the probe's own timeout. */
  accountIdentity(): Promise<AccountIdentity | undefined> {
    return this.accountProbe?.identity ?? Promise.resolve(undefined);
  }

  private readonly resumeIntent: ResumeIntent | undefined;
  /** At most one `resume_outcome` per session. A rejection is followed by a provider failure, and
   * both paths want to report -- without this latch the caller would see the same verdict twice,
   * or worse, a REJECTED followed by an INITIALIZATION_FAILED contradicting it. */
  private resumeOutcomeEmitted = false;

  /** Emits the resume verdict, once, into the sink the current `pump()` is about to return.
   *
   * A no-op for a session that never asked to resume, and for a second call. Pushed into `sink`
   * rather than `this.events` for the same reason every other terminal event is: an event that
   * only reaches `this.events` is invisible to a `pump()`-only consumer, which is every consumer. */
  private emitResumeOutcome(
    sink: ClaudeRuntimeEvent[],
    status: 'attached' | 'rejected' | 'initialization_failed',
    extra: { attachedProviderSessionId?: string; detail?: string } = {},
  ): void {
    if (this.resumeIntent === undefined || this.resumeOutcomeEmitted) {
      return;
    }
    this.resumeOutcomeEmitted = true;
    sink.push({
      type: 'resume_outcome',
      requestedProviderSessionId: this.resumeIntent.providerSessionId,
      status,
      forked: this.resumeIntent.fork,
      ...extra,
    });
  }

  /** Non-blocking drain, mirroring the neovibe Rust sibling's own `AgentSession::pump()` shape --
   * pulls every message currently available from the real SDK's async generator, translates it,
   * and returns the resulting events. Also drains `pendingPermissionEvents` -- confirmed via a
   * disposable real-CLI probe (see task report) that `PreToolUse`'s hook callback fires over the
   * SDK's own control channel, entirely independent of the `rawQuery.next()` message stream this
   * loop otherwise drains; a `permission_requested` that only ever reached `this.events` (visible
   * via `eventLog()`) but never `pump()`'s own return left a real caller with no way to ever learn
   * a tool call was blocked awaiting a decision, since this poll-only actor has no internal timer
   * or callback of its own to push that information out any other way. A caller (Task 4's
   * HTTP/gRPC-facing host, not built in this plan) polls this on its own schedule. */
  async pump(): Promise<ClaudeRuntimeEvent[]> {
    // Reentrancy guard first, unconditionally -- a second concurrent call arriving while another
    // is already in flight touches NO shared state at all, terminal or not (see the `pumping`
    // field's own doc comment for why this must stay a hard precondition rather than being
    // combined with the terminal check below).
    if (this.pumping) {
      return [];
    }
    this.pumping = true;
    const drained: ClaudeRuntimeEvent[] = [];
    try {
      // Drain anything buffered out-of-band BEFORE deciding whether to continue -- this must
      // happen even when already terminal. `close()` (unlike the `done`/catch branches below,
      // which run from inside this very call's own loop) is called out of band and funnels its
      // own `session_closed` (and any synthesized `turn_completed`) into this SAME
      // `pendingPermissionEvents` buffer rather than pushing directly into `this.events` -- see
      // `close()`'s own comment for why. Without this unconditional pre-check, a terminal
      // short-circuit here would strand that event forever: verified head-to-head by a
      // whole-branch re-review that a host calling `close()` then polling `pump()` for
      // confirmation got the terminal event back within 5 polls before this fix's predecessor,
      // and never within 184 polls after it (the previous round's unconditional `if (this.terminal)
      // return [];` guard). A second poll after the buffer is drained still correctly returns
      // `[]` -- once emptied, this line is a no-op, same as it always was mid-loop below.
      this.drainPendingPermissionEvents(drained);
      if (this.terminal) {
        this.events.push(...drained);
        return drained;
      }
      while (true) {
        this.drainPendingPermissionEvents(drained);
        if (this.pendingNext === undefined) {
          this.pendingNext = this.rawQuery.next();
        }
        let next: IteratorResult<SDKMessage, void> | typeof TIMEOUT;
        try {
          next = await raceWithImmediateTimeout(this.pendingNext);
        } catch (err) {
          // The provider's own words about WHY, recovered rather than discarded. This catch used to
          // bind nothing at all (`} catch {`), which threw away the single string that
          // distinguishes a refused resume from any other provider death: the SDK rejects with
          // `Claude Code returned an error result: No conversation found with session ID: <id>`.
          // Everything needed to tell a user "that conversation is gone" from "the provider broke"
          // was present and dropped on the floor.
          this.emitResumeOutcome(drained, classifyResumeFailure(err), { detail: describeError(err) });
          // Global Constraint: fail closed even when the raw provider itself is what failed, and
          // the event loop must not end the session with an unhandled error. `pump()` itself must
          // not throw here -- this package's whole design tells callers about problems via
          // events, not exceptions. `terminate()` handles clearing `pendingNext`, fail-closing
          // permissions, releasing the raw query, and (if a turn was in flight) synthesizing its
          // terminal event -- see that method's own doc comment.
          this.terminate('provider_failed', 'provider_failed', drained);
          break;
        }
        if (next === TIMEOUT) {
          break;
        }
        // This call settled -- clear it so the next loop iteration (or the next pump() call, if
        // this iteration's drain ends here) starts a fresh one instead of re-awaiting a done promise.
        this.pendingNext = undefined;
        if (next.done) {
          // Spec §7.3 lists a clean child exit as a fail-closed trigger alongside an SDK query
          // throw -- this must terminate exactly the same way the catch branch above does, not
          // just report a `session_closed` event and leave everything else (pending permissions,
          // the input queue, an in-flight turn) untouched. The reason label still distinguishes a
          // host-initiated close from the provider ending on its own (see `terminate()`'s own
          // comment on why this branch is, in practice, the only one that ever passes
          // `provider_exited` -- `close()` already latches `terminal` before this code can run).
          // A resume whose provider exited before ever reporting a session id never attached. Not
          // a rejection: the provider said nothing about the id, so claiming it does not exist
          // would be inventing a reason.
          if (!this.closed) {
            this.emitResumeOutcome(drained, 'initialization_failed', {
              detail: 'the provider exited before reporting a session id',
            });
          }
          this.terminate(this.closed ? 'closed_by_host' : 'provider_exited', this.closed ? 'cancelled_by_session_close' : 'provider_failed', drained);
          break;
        }
        drained.push(...this.translateOne(next.value));
        if (this.toolPolicyViolation !== undefined) {
          // Right after the offending session_ready (already in `drained`, so the caller sees the
          // tools that were reported) and before any further message of the turn is read. Closing
          // the query ends the CLI process, so nothing the model does next can run.
          this.terminate('tool_policy_violation', 'cancelled_by_session_close', drained);
          break;
        }
      }
      // Catches a permission event emitted during the loop's final (TIMEOUT-triggering) await,
      // which the top-of-iteration drain above cannot have seen since it runs before that await
      // starts. A no-op after `terminate()` already ran in this same call, since that already
      // drained everything into `drained` directly.
      this.drainPendingPermissionEvents(drained);
      this.events.push(...drained);
      return drained;
    } finally {
      this.pumping = false;
    }
  }

  /**
   * The single place every path that ends this session funnels through: an explicit `close()`, a
   * clean provider exit (`rawQuery.next()` resolving `{ done: true }`), and a provider failure
   * (`rawQuery.next()` rejecting) all need to behave identically otherwise, and previously didn't
   * (a whole-branch review caught the clean-exit path skipping fail-close/cleanup entirely, and
   * the provider-failure path flushing its permission-resolution event somewhere a pump()-only
   * consumer could never see it).
   *
   * - Fails closed: denies every still-pending permission request (`failAllPending`).
   * - Flushes `pendingPermissionEvents` into `sink`, then pushes its own `turn_completed`
   *   (if applicable) and `session_closed` onto that SAME `sink` too. For the two `pump()` call
   *   sites, `sink` is `drained` -- the array that very call is about to return -- so a
   *   `permission_resolved` this call's own `failAllPending` just produced is visible to a
   *   pump()-only consumer in the SAME call, not stranded in `this.events` where it would be
   *   invisible to anyone who only ever reads `pump()`'s return value (the bug a prior review
   *   round fixed for these two paths). For `close()`, `sink` is `pendingPermissionEvents`
   *   itself, NOT `this.events` -- `close()` runs out of band (not from inside a `pump()` call's
   *   own loop), so there is no `drained` array it could push into; routing its own terminal
   *   events into the SAME buffer the permission broker already uses means the very next
   *   `pump()` call's own top-of-call drain (see `pump()`'s own comment) picks them up and
   *   returns them, rather than leaving them sitting only in `this.events` where a host polling
   *   `pump()` for close() confirmation would never see them (the bug THIS round's fix
   *   addresses). Either way, exactly one write into `this.events` ever happens for any of these
   *   events -- whichever `pump()` call's own top-of-call or end-of-loop
   *   `this.events.push(...drained)` eventually drains them, once.
   * - Ends the input queue and best-effort closes the raw query (swallowing a throw -- a
   *   provider that already failed once might throw again on `close()`, or might not; this is a
   *   reclaim attempt, not a functioning assumption to build on, matching the asymmetric
   *   caution `close()` itself already applies in the other direction by never assuming
   *   `Query.close()` is repeat-safe).
   * - If a turn was in flight when termination happens, synthesizes `turn_completed` with
   *   outcome `'failed'` -- otherwise a host polling until `turn_completed` (exactly what this
   *   package's own real-CLI tests do) spins to its deadline, since nothing else will ever
   *   produce that event for a turn the provider never got to finish.
   * - Latches `this.terminal` FIRST, so this can only ever run to completion once, regardless of
   *   which call site reaches it or how many times `pump()` is polled afterward.
   */
  private terminate(
    reason: SessionCloseReason,
    permissionOutcome: Extract<PermissionOutcome, 'cancelled_by_interrupt' | 'cancelled_by_session_close' | 'provider_failed'>,
    sink: ClaudeRuntimeEvent[],
  ): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.pendingNext = undefined;
    this.permissionBroker.failAllPending(permissionOutcome);
    this.drainPendingPermissionEvents(sink);
    // A first turn still held for the account probe is never delivered now; the turnInProgress
    // branch below reports it failed like any other turn this termination cut short. The probe
    // itself is released, so a dead session's deadline timer cannot keep the process alive.
    this.heldFirstTurn = undefined;
    this.accountProbe?.cancel('the session ended before accountInfo() answered');
    this.inputQueue.end();
    try {
      this.rawQuery.close();
    } catch {
      // Best-effort; see this method's own doc comment.
    }
    if (this.turnInProgress) {
      const turnId = this.currentTurnId ?? 'unknown-turn';
      this.turnInProgress = false;
      this.currentTurnId = undefined;
      sink.push({ type: 'turn_completed', turnId, outcome: 'failed', resultText: '', isError: true, stopReason: null });
    }
    sink.push({ type: 'session_closed', reason });
  }

  private drainPendingPermissionEvents(sink: ClaudeRuntimeEvent[]): void {
    if (this.pendingPermissionEvents.length > 0) {
      sink.push(...this.pendingPermissionEvents.splice(0));
    }
  }

  private translateOne(message: SDKMessage): ClaudeRuntimeEvent[] {
    if (message.type === 'result') {
      this.turnInProgress = false;
      const turnId = this.currentTurnId ?? 'unknown-turn';
      this.currentTurnId = undefined;
      const outcome = mapTerminalReason(message);
      // `result` (the final assistant text) only exists on the SDK's `SDKResultSuccess` variant --
      // `SDKResultError` has no such field, so an error-subtype result surfaces as empty text
      // rather than widening this field's type or guessing at error-string content.
      const resultText = message.subtype === 'success' ? message.result : '';
      // Everything else the result message says about how the turn ended (subtype, terminal reason,
      // API error status, errors, structured output) rides along unmapped -- see resultDetail().
      return [{ type: 'turn_completed', turnId, outcome, resultText, isError: message.is_error, stopReason: message.stop_reason, ...resultDetail(message) }];
    }
    let streamKey: string | undefined;
    if (message.type === 'stream_event') {
      const raw = message as { parent_tool_use_id?: unknown; event?: { type?: unknown; message?: { id?: unknown } } };
      streamKey = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : '';
      if (raw.event?.type === 'message_start') {
        const id = raw.event.message?.id;
        if (typeof id === 'string' && id !== '') {
          this.streamMessageIds.set(streamKey, id);
        } else {
          // A message_start without a usable id must not leave the PREVIOUS message's id on this
          // one's deltas -- that would glue two replies together, the very thing the id prevents.
          this.streamMessageIds.delete(streamKey);
        }
      }
    }
    const ctx: TranslationContext = {
      currentTurnId: this.currentTurnId,
      partialStreaming: this.partialStreaming,
      streamedSinceLastAssistant: this.streamedSinceLastAssistant,
      streamMessageId: streamKey === undefined ? undefined : this.streamMessageIds.get(streamKey),
    };
    const events = translateMessage(message, ctx);
    // Maintained here rather than inside translateMessage, which stays a pure function of one
    // message: this loop already sees every event it returns. A stream_event that produced a
    // text/thinking delta ARMS the suppression; the assistant message that follows consumes it and
    // resets, so the next message in the same turn is judged on its own deltas rather than on an
    // earlier message's.
    if (message.type === 'stream_event') {
      if (events.some((event) => event.type === 'text_delta' || event.type === 'thinking_delta')) {
        this.streamedSinceLastAssistant = true;
      }
    } else if (message.type === 'assistant') {
      this.streamedSinceLastAssistant = false;
    }
    // `session_ready` is the ONLY place a provider session id ever enters this stream, so it is the
    // only place an attachment can be confirmed. It arrives at the start of a turn rather than at
    // session construction, which is why a successful resume cannot be reported any sooner than
    // this -- see the ResumeStatus doc comment.
    const ready = events.find((event) => event.type === 'session_ready');
    if (ready !== undefined && ready.type === 'session_ready') {
      if (this.accountProbe !== undefined) {
        // A session that holds its first turn has the answer by now: the provider only sends
        // system/init once it has a turn's message. A session that does not hold reports the
        // answer if it is in (later turns' inits will carry it if not); the fallback covers an
        // init that arrives without one, and says so rather than leaving the field out.
        ready.accountIdentity = this.settledAccountIdentity ?? { status: 'unavailable', error: 'accountInfo() had not answered when system/init arrived' };
      }
      if (this.permittedInitTools !== undefined) {
        // Every session_ready, not only the first: the CLI re-sends system/init at each turn.
        this.toolPolicyViolation ??= initToolViolation(ready.initFingerprint, this.permittedInitTools, this.requiredInitTools) ?? undefined;
      }
      const attached: ClaudeRuntimeEvent[] = [];
      this.emitResumeOutcome(attached, 'attached', { attachedProviderSessionId: ready.providerSessionId });
      // Ahead of session_ready, so a consumer folding these in order knows what it is looking at
      // before it is handed the id.
      return [...attached, ...events];
    }
    return events;
  }

  /** Global Constraint: one active turn per session -- rejects rather than queuing or silently
   * dropping a second concurrent send. Also rejects on an already-terminated session with a
   * distinct error, rather than letting the call silently succeed into a dead input queue that
   * nothing will ever read: without this check, `turnInProgress` would latch `true` forever
   * (nothing terminated will ever produce the `result` message that normally clears it), so a
   * *second* `sendTurn()` call would then throw the "already in progress" error -- true, but
   * misleading about why. */
  sendTurn(text: string): { turnId: string } {
    if (this.terminal) {
      throw new Error('session is closed');
    }
    if (this.turnInProgress) {
      throw new Error('a turn is already in progress on this session');
    }
    const turnId = randomUUID();
    this.turnInProgress = true;
    this.currentTurnId = turnId;
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    if (this.holdFirstTurnForAccount && this.accountProbe !== undefined && this.settledAccountIdentity === undefined) {
      // Held, not sent: the provider sees no input -- and so spends nothing -- until the session
      // knows which account it is running as (muninn spec §6.3 P2). Only a completion-shaped
      // session gets here (see holdsFirstTurnForAccount), and only ever for its first turn: once
      // the probe has settled, this branch is never taken again. sendTurn itself stays synchronous.
      this.heldFirstTurn = { turnId };
      void this.accountProbe.identity.then(() => {
        if (this.heldFirstTurn?.turnId !== turnId || this.terminal) {
          return;
        }
        this.heldFirstTurn = undefined;
        this.inputQueue.push(userMessage);
      });
    } else {
      this.inputQueue.push(userMessage);
    }
    // Into the out-of-band buffer, NOT straight into `this.events` -- see that field's own doc for
    // why the original reasoning ("a synchronous call's own caller already knows about its own
    // event") stopped being true. `pump()` drains this buffer into its own return value, and into
    // `this.events` from there, so `turn_started` now reaches every consumer rather than only
    // whoever called `sendTurn`.
    this.pendingPermissionEvents.push({ type: 'turn_started', turnId });
    return { turnId };
  }

  resolvePermission(permissionId: string, decision: { allow: boolean; reason?: string }): boolean {
    return this.permissionBroker.resolve(permissionId, decision);
  }

  /**
   * Changes this live session's permission mode: the CLI's own mode (`Query.setPermissionMode`, a
   * `set_permission_mode` control request) and this session's PreToolUse gate together. Resolves once
   * the CLI acknowledged, with the provider-level mode now in force; a `permission_mode_changed`
   * event (and, entering a floored bypass, the same `bypass_default_deny_applied` notice creation
   * emits) goes out through `pump()` for every other watcher.
   *
   * What a switch can and cannot change:
   * - Into `bypass` from a gated mode: the CLI goes to `bypassPermissions` (possible because a gated
   *   session is launched with `allowDangerouslySkipPermissions`), and the gate abstains. The tool
   *   policy is static and stays; the conservative floor is applied by the gate when the policy stated
   *   no restriction -- see `gateDecision`.
   * - Out of `bypass` into a gated mode: only for a session CREATED gated. A session created under
   *   `bypass` has no PreToolUse hook -- hooks go to the CLI once, at `initialize` -- so there is
   *   nothing that could ask anyone, and the CLI in `default` would silently refuse whatever it
   *   classifies as needing a grant. Refused (`PermissionModeError` kind `refused`) rather than
   *   produced.
   * - Ordering, towards the safe side in both directions: leaving bypass, the gate starts asking
   *   BEFORE the CLI is told; entering it, the gate stops asking only AFTER the CLI acknowledged. A
   *   CLI refusal restores the gate as it was.
   * - Pending permission requests are left pending.
   */
  setPermissionMode(mode: ClaudeHostPolicy['permissions']): Promise<{ permissionMode: string; bypassDefaultDenyApplied: boolean }> {
    const run = () => this.applyPermissionMode(mode);
    const result = this.permissionModeChain.then(run, run);
    this.permissionModeChain = result.catch(() => undefined);
    return result;
  }

  private async applyPermissionMode(mode: ClaudeHostPolicy['permissions']): Promise<{ permissionMode: string; bypassDefaultDenyApplied: boolean }> {
    if (this.terminal) {
      throw new PermissionModeError('closed', 'session is closed');
    }
    const sw = this.permissionSwitch;
    if (sw === undefined) {
      throw new PermissionModeError('refused', 'this session was built without a switchable permission gate');
    }
    const createdUnderBypass = sw.policy.permissions === 'bypass';
    if (!createdUnderBypass && mode === 'bypass' && sw.policy.permissionModeSwitchable !== true) {
      throw new PermissionModeError(
        'refused',
        'this session was not created with permission_mode_switchable, so its CLI was not launched with --allow-dangerously-skip-permissions and would refuse bypass. Create the session with ClaudeHostPolicy.permission_mode_switchable = true to switch it to bypass (as root that also needs IS_SANDBOX=1).',
      );
    }
    if (createdUnderBypass && mode !== 'bypass') {
      throw new PermissionModeError(
        'refused',
        `this session was created under bypass, which installs no PreToolUse gate, so it cannot be switched to ${mode}: nothing could answer its permission requests. Create the session under a gated mode (interactive) and switch it to bypass instead.`,
      );
    }
    const providerMode = providerPermissionMode(mode);
    // The floor, by the one rule creation uses. For a session created under bypass it is already on
    // `disallowedTools` (and was announced at creation), so it is only REPORTED here, never re-announced.
    const floor = mode === 'bypass' && usesDefaultBypassDeny({ ...sw.policy, permissions: 'bypass' });
    const previous = { ...sw.state };
    if (mode !== 'bypass') {
      sw.state.permissions = mode;
      sw.state.bypassFloor = false;
    }
    try {
      await this.rawQuery.setPermissionMode(providerMode);
    } catch (err) {
      Object.assign(sw.state, previous);
      if (this.terminal) {
        throw new PermissionModeError('closed', 'session is closed');
      }
      throw new PermissionModeError('provider_refused', describeError(err));
    }
    if (this.terminal) {
      Object.assign(sw.state, previous);
      throw new PermissionModeError('closed', 'session is closed');
    }
    sw.state.permissions = mode;
    sw.state.bypassFloor = floor && !createdUnderBypass;
    if (sw.state.bypassFloor) {
      this.pendingPermissionEvents.push({
        type: 'provider_notice',
        kind: 'verdandi_policy',
        subtype: 'bypass_default_deny_applied',
        raw: { disallowedTools: [...CONSERVATIVE_BYPASS_DENY], appliedBy: 'permission_mode_switch' },
      });
    }
    this.pendingPermissionEvents.push({ type: 'permission_mode_changed', permissions: mode, permissionMode: providerMode, bypassDefaultDenyApplied: floor });
    return { permissionMode: providerMode, bypassDefaultDenyApplied: floor };
  }

  /**
   * NOT the production install point. `createSession` builds the matcher directly from the broker,
   * because `options.hooks` must be set before `queryFn` is called and therefore before this object
   * exists. Nothing in this repository calls this method.
   *
   * It takes `timeoutSeconds` explicitly rather than reading a field so that it CANNOT silently
   * build a different matcher than the one production installs: a caller must state the same thing
   * `ClaudeSessionConfig.permissionHookTimeoutSeconds` states. A no-argument version of this method
   * would quietly produce the CLI-default timeout while the real session ran with a configured one,
   * which is the same shape as every advertised-but-unimplemented defect this protocol has already
   * shipped once.
   */
  hookMatcher(timeoutSeconds?: number): HookCallbackMatcher {
    return this.permissionBroker.buildHookMatcher(timeoutSeconds);
  }

  /** Global Constraint: fail closed -- an interrupted turn must never leave a pending permission
   * request unresolved, matching the neovibe Rust sibling's own identical
   * `AgentSession::interrupt()` behavior. `finally` (rather than a plain sequential `await` then
   * call) guarantees `failAllPending` runs even if `rawQuery.interrupt()` itself rejects --
   * otherwise a rejection there would skip the fail-close entirely, leaving pending permissions
   * unresolved forever. The rejection (if any) still propagates to this method's own caller after
   * that cleanup runs -- it is not swallowed, only guaranteed not to skip the fail-close side
   * effect. The session stays usable afterward (interrupt does not close it), so any surviving
   * `permission_resolved` events reach `eventLog()` normally via a later `pump()` call, the same
   * as any other out-of-band event this class produces. */
  async interrupt(): Promise<void> {
    const held = this.heldFirstTurn;
    if (held !== undefined) {
      // The turn never reached the provider -- its message is still held for the account probe --
      // so there is nothing there to interrupt. Drop the message and end the turn here, in the
      // shape a real interrupted turn ends in, so a caller waiting for turn_completed gets one.
      this.heldFirstTurn = undefined;
      this.turnInProgress = false;
      this.currentTurnId = undefined;
      this.pendingPermissionEvents.push({ type: 'turn_completed', turnId: held.turnId, outcome: 'interrupted', resultText: '', isError: false, stopReason: null });
      return;
    }
    try {
      await this.rawQuery.interrupt();
    } finally {
      this.permissionBroker.failAllPending('cancelled_by_interrupt');
    }
  }

  /** Design doc §5.2: "清理可重复调用" (cleanup must be repeat-call-safe). Delegates entirely to
   * `terminate()`, whose own `this.terminal` latch is what actually makes a repeat call a safe
   * no-op now (rather than a dedicated guard here) -- unverified whether the real SDK's
   * `Query.close()` itself tolerates a repeat call, so this class still enforces idempotency
   * itself rather than assuming the SDK does, just via the one shared mechanism every termination
   * path now uses.
   *
   * `sink` is `pendingPermissionEvents` here, NOT `this.events` -- a whole-branch re-review
   * caught that pushing directly into `this.events` (this method's own previous behavior) left
   * `close()`'s own `session_closed` (and any synthesized `turn_completed`) reachable only via
   * `eventLog()`, never via a subsequent `pump()` call's return value, since `pump()`'s terminal
   * short-circuit returned `[]` unconditionally once `this.terminal` was set. A host that calls
   * `close()` and then polls `pump()` waiting for confirmation -- exactly the intended, expected
   * usage of this poll-only actor -- would spin to its own deadline. Routing through
   * `pendingPermissionEvents` instead means the very next `pump()` call's own top-of-call drain
   * (see that method's own comment) picks these events up and returns them, the same way it
   * already does for the permission broker's own out-of-band events. The tradeoff this accepts,
   * deliberately: `eventLog()` itself is not updated by `close()` synchronously anymore -- only
   * once some future `pump()` call drains the buffer. This mirrors how the `done`/catch
   * termination paths already behave (their terminal events were never visible in `eventLog()`
   * before the very `pump()` call that produced them either), and does not weaken the actual
   * safety property: `failAllPending()` above has already resolved every pending permission's
   * real promise by the time `close()` returns, regardless of when (or whether) that resolution
   * is ever separately observed through `eventLog()`. */
  close(): void {
    this.closed = true;
    this.terminate('closed_by_host', 'cancelled_by_session_close', this.pendingPermissionEvents);
  }

  eventLog(): readonly ClaudeRuntimeEvent[] {
    return this.events;
  }
}

const TIMEOUT = Symbol('pump-timeout');
/** `pump()` must be non-blocking (mirrors the Rust sibling's own documented deadlock history --
 * see neovibe's agent/MANUAL_VERIFICATION.md -- where a blocking read hung for hours): races the
 * real generator's `next()` against an already-resolved promise so a call with nothing queued
 * returns immediately instead of waiting for the next real message. */
async function raceWithImmediateTimeout<T>(promise: Promise<T>): Promise<T | typeof TIMEOUT> {
  return Promise.race([promise, Promise.resolve(TIMEOUT)]);
}

/**
 * Maps the real SDK's `SDKResultMessage` (sdk.d.ts:4770-4844) to this package's `TurnOutcome`.
 * Only `terminal_reason` values Task 3's own real-CLI verification (Step 4 below) actually
 * observed as limit-related map to `limit_reached`; every other non-`completed` reason this
 * package has not empirically confirmed maps conservatively to `failed`, never to `completed`,
 * even if its name suggests a benign stop -- see this function's own inline citations of what was
 * actually observed vs. inferred from the type's name alone.
 */
function mapTerminalReason(message: Extract<SDKMessage, { type: 'result' }>): TurnOutcome {
  const reason = (message as { terminal_reason?: string }).terminal_reason;
  if (reason === 'max_turns' || reason === 'blocking_limit' || reason === 'rapid_refill_breaker' || reason === 'budget_exhausted') {
    return 'limit_reached';
  }
  // 'aborted_streaming' / 'aborted_tools' are this SDK version's real terminal_reason for a turn
  // that was itself the target of Query.interrupt() -- confirmed empirically in Step 4's real
  // integration test below, not assumed from the name alone.
  if (reason === 'aborted_streaming' || reason === 'aborted_tools') {
    return 'interrupted';
  }
  if (reason === 'completed' || (reason === undefined && !message.is_error)) {
    return 'completed';
  }
  return 'failed';
}

/** What a session asked to resume. `fork` matters because forking legitimately yields a DIFFERENT
 * provider session id, so an equality check against the requested one is the wrong test for it. */
export type ResumeIntent = { providerSessionId: string; fork: boolean };

/** The exact phrase the Claude CLI uses when the requested session does not exist.
 *
 * A string match, and deliberately quarantined to this one constant rather than spread through the
 * classification logic. There is no typed signal: the SDK rejects with a plain `Error` whose message
 * is `Claude Code returned an error result: No conversation found with session ID: <id>`. If the CLI
 * ever rewords it, this stops matching and every rejection degrades to INITIALIZATION_FAILED --
 * which is the safe direction to fail (a vaguer true statement), not a wrong one. */
const RESUME_REJECTED_PHRASE = 'No conversation found with session ID';

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : 'the provider failed without a message';
}

/** Distinguishes "that conversation is gone" from "the provider broke". Only ever consulted for a
 * session that asked to resume, so a non-resume provider failure never reaches it. */
function classifyResumeFailure(err: unknown): 'rejected' | 'initialization_failed' {
  return describeError(err).includes(RESUME_REJECTED_PHRASE) ? 'rejected' : 'initialization_failed';
}

/**
 * Every SDK `Options` field a session gets from its config, except `hooks` (which need the
 * session's own PermissionBroker and are installed by `createSession`).
 *
 * A separate, pure function so the sidecar's CreateSessionRequest totality test can run a request
 * through the production mapping (`buildKernelSessionConfig`) AND this one and observe what the SDK
 * would be told -- without a fake query, and without a second copy of these lines that could drift
 * from the real ones. `createSession` calls this and nothing else to build its options.
 */
export function buildSessionOptions(config: ClaudeSessionConfig): Options {
  const options = policyToBaseOptions(config.policy, config.cwd, { account: config.account, hostCliPath: config.hostCliPath });
  if (config.resume) {
    options.resume = config.resume.providerSessionId;
    if (config.fork) {
      options.forkSession = true;
    }
  }
  // Only set when asked for: leaving them unset is what keeps the CLI default in force, and is
  // exactly what every session did before these existed.
  if (config.model) {
    options.model = config.model;
  }
  if (config.effort) {
    options.effort = config.effort;
  }
  // Presence, not truthiness, for the same reason as `settingSources`: the question is whether the
  // caller stated a prompt. A plain string is the SDK's "use a custom system prompt" form, i.e. a
  // full replacement of Claude Code's default; the preset/append form is deliberately not reachable.
  if (config.systemPrompt !== undefined) {
    options.systemPrompt = config.systemPrompt;
  }
  if (config.outputFormat !== undefined) {
    // A copy, so a caller mutating its config after createSession cannot change what the SDK holds.
    options.outputFormat = { type: 'json_schema', schema: config.outputFormat.schema };
  }
  return options;
}

export function createSession(config: ClaudeSessionConfig, queryFn: QueryFn = realQuery as unknown as QueryFn): ClaudeRuntimeSession {
  const options = buildSessionOptions(config);
  const inputQueue = makeInputQueue();
  // A placeholder session instance whose only job is to hold the PermissionBroker that
  // `hookMatcher()` needs before the real query() call can happen -- options.hooks must be set
  // BEFORE queryFn(...) is called, but the broker's `emit` closure needs somewhere to push into
  // that only exists once the real ClaudeRuntimeSession is constructed. Building the broker
  // directly (not via a session instance) breaks this chicken-and-egg problem cleanly: `emit`
  // pushes into `pendingPermissionEvents`, a plain array handed to the constructor below the same
  // way `events` is, and `pump()` (not this closure) is what later drains it into `this.events`
  // and its own return value -- see `pump()`'s own comment for why that indirection through a
  // dedicated buffer, rather than pushing straight into `events`/`initialEvents`, is required.
  const events: ClaudeRuntimeEvent[] = [];
  const pendingPermissionEvents: ClaudeRuntimeEvent[] = [];
  const gateState: PermissionGateState = { permissions: config.policy.permissions, bypassFloor: false };
  const broker = new PermissionBroker(
    (event) => pendingPermissionEvents.push(event),
    (toolName) => gateDecision(gateState, toolName),
  );
  // Announced, never silent. `policyToBaseOptions` above has just narrowed this session's tools in a
  // way the caller did not ask for, and under `bypass` there is no PreToolUse hook to surface it
  // later either -- so a caller that never learns about it would see tool calls simply not happen.
  //
  // It goes into `pendingPermissionEvents` and NOT `this.events`/`events`: that array is the only
  // out-of-band channel `pump()` drains into its own return value, and therefore the only one a
  // WatchSessionEvents subscriber can ever observe. See `pendingPermissionEvents`' own doc comment
  // for the `turn_started` bug this is avoiding by construction. Pushed before `queryFn` is called,
  // so it lands at sequence 1, ahead of session_ready and in the ring buffer for any replaying
  // watcher.
  //
  // The list itself is not in the payload: ProviderNotice is kind + optional subtype only, by the
  // proto's own rule. `CONSERVATIVE_BYPASS_DENY` is the exported place to read it.
  if (usesDefaultBypassDeny(config.policy)) {
    pendingPermissionEvents.push({
      type: 'provider_notice',
      kind: 'verdandi_policy',
      subtype: 'bypass_default_deny_applied',
      raw: { disallowedTools: [...CONSERVATIVE_BYPASS_DENY] },
    });
  }
  if (config.policy.permissions !== 'bypass') {
    options.hooks = { PreToolUse: [broker.buildHookMatcher(config.permissionHookTimeoutSeconds)] };
  }
  const rawQuery = queryFn({ prompt: inputQueue.iterable, options });
  // Asked now, before this function returns and so before any sendTurn can exist, for every
  // session. Only a completion-shaped one holds its first turn until the answer is in; see
  // SessionGuards and holdsFirstTurnForAccount.
  const accountProbe = probeAccountIdentity(rawQuery, config.accountInfoTimeoutMs ?? DEFAULT_ACCOUNT_INFO_TIMEOUT_MS);
  return new ClaudeRuntimeSession(
    rawQuery,
    inputQueue,
    broker,
    events,
    pendingPermissionEvents,
    options.includePartialMessages === true,
    config.resume === undefined
      ? undefined
      : { providerSessionId: config.resume.providerSessionId, fork: config.fork === true },
    {
      accountProbe,
      holdFirstTurnForAccount: holdsFirstTurnForAccount(config),
      permittedInitTools: permittedInitTools(config),
      requiredInitTools: requiredInitTools(config),
      permissionSwitch: { state: gateState, policy: config.policy },
    },
  );
}
