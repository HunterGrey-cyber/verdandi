import type { ClaudeAccount } from './account.js';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';

/**
 * Provider-neutral-shaped (per design doc §9.6/§10.2) but this package is explicitly the
 * Claude-concrete runtime (design doc §5.1) -- Claude-specific fields stay named as such rather
 * than laundered into artificially generic names.
 */

export type ClaudeHostPolicy = {
  configuration: 'native' | 'isolated';
  permissions: 'interactive' | 'verdandi_rules' | 'bypass';
  persistence: 'host_cli' | 'ephemeral' | 'external_store';
  executable: 'host_cli' | 'sdk_bundled';
  /** `'partial'` asks the SDK for `includePartialMessages`, turning assistant text into many small
   * `text_delta` events as it is produced instead of one per completed content block. Optional so
   * every existing caller keeps `'complete'` behavior without being edited. */
  streaming?: 'complete' | 'partial';
  /** Overrides the settings-tier half of `configuration` -- and ONLY that half. `undefined` (the
   * shipped default) means defer to `configuration` entirely: `native` -> user+project+local,
   * `isolated` -> none. `[]` means load no filesystem settings tiers, stated rather than defaulted.
   *
   * The other half of `configuration` (strictMcpConfig, mcpServers, settings.autoMemoryEnabled,
   * CLAUDE_CODE_DISABLE_AUTO_MEMORY) is untouched by this field and has no other expression, which
   * is why this is an override rather than a replacement -- see `policyToBaseOptions`.
   *
   * Typed as the SDK's own `SettingSource` union so `options.settingSources = policy.settingSources`
   * needs nothing in between that could get it wrong.
   *
   * NOT containment: this governs automatic inheritance, not reachability. A session with `Read` or
   * `Bash` can still read `~/.claude/settings.json` whether or not that tier was loaded, and the SDK
   * states that even `[]` still reads the managed-settings policy tier from disk. */
  settingSources?: SettingSource[];
  /** A static, session-lifetime tool prefilter applied at session construction, on top of (not
   * instead of) the per-call PreToolUse gate that `permissions` selects.
   *
   * ### `deny` IS A CONFIGURATION BOUNDARY, NOT A CONTAINMENT BOUNDARY
   *
   * It shrinks the default attack surface. It does not contain a model that wants out. `deny` is
   * the one lever here the model cannot widen -- the SDK's `Options.disallowedTools` doc says those
   * tools "will be removed from the model's context and cannot be used, even if they would otherwise
   * be allowed" -- and that is still only a claim about which tool NAMES exist, not about what the
   * session can reach: a denied `Bash` alongside an allowed `Write` still reaches the filesystem.
   *
   * The real containment boundary is the PreToolUse hook under `interactive`/`verdandi_rules`, whose
   * decisions come from out of process and fail closed. Under `bypass` that hook is not installed at
   * all and no `toolPolicy` makes it exist -- which is exactly why `usesDefaultBypassDeny` and its
   * announced conservative default are here. Read a deny list as "the session was not handed X by
   * default", never as "the session cannot do X".
   *
   * `allow: undefined` vs `allow: []` is load-bearing and must survive every mapping layer:
   * `undefined` means "do not touch the base tool set", `[]` means the SDK's documented
   * "Disable all built-in tools". See `policyToBaseOptions` for where each one lands.
   *
   * `unrestricted` is the STATED form of "no restriction at all", and the only thing that takes the
   * conservative bypass floor off without narrowing something. Before it existed, a caller that
   * wanted every tool had to claim it wanted something narrower -- see `usesDefaultBypassDeny`.
   * `false` and absent mean the same thing (it arrives from a proto3 scalar, which is `false`
   * whenever the sender never heard of the field), so the predicate tests for `true`, never for
   * presence. */
  toolPolicy?: { deny?: string[]; allow?: string[]; unrestricted?: boolean };
  /** Opt-in: a GATED session may later be switched to `bypass` by `setPermissionMode`. Launches the
   * CLI with `allowDangerouslySkipPermissions` (`--allow-dangerously-skip-permissions`), which the
   * CLI refuses to start with as root/sudo unless IS_SANDBOX=1 -- the reason it is not on by
   * default. Ignored for a session created under `bypass`. See the proto field of the same name. */
  permissionModeSwitchable?: boolean;
};

export type ClaudeSessionConfig = {
  cwd: string;
  policy: ClaudeHostPolicy;
  /** Optional, host-level rather than per-request: which local Claude account the subprocess
   * authenticates as. Resolved once at sidecar startup (see `resolveAccount`) and threaded through
   * unchanged, so every session in a process agrees on it. `undefined` -- the shipped default --
   * means nothing is pinned and the subprocess inherits the host environment's own account. */
  account?: ClaudeAccount;
  /** Optional, host-level like `account`: the absolute path (or bare command name) of the machine's
   * own Claude CLI, used only when the policy asks for `executable: 'host_cli'`. Resolved once at
   * sidecar startup so the binary the version gate measured is the binary sessions actually spawn. */
  hostCliPath?: string;
  /** Present when resuming a prior provider session id. Mutually exclusive with starting fresh. */
  resume?: { providerSessionId: string };
  /** When set alongside `resume`, the resumed history is forked to a NEW session id rather than
   * continuing the original (SDK `Options.forkSession`, sdk.d.ts's ForkSession doc comment). */
  fork?: boolean;
  /** SDK `Options.model`: an alias ("sonnet", "opus") or a full model id. `undefined` leaves the
   * CLI default in force. */
  model?: string;
  /** SDK `Options.effort`. `undefined` leaves the CLI default in force. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * How long the CLI waits for this host to answer a PreToolUse permission before it gives up and
   * aborts the hook call, in seconds. Maps to the SDK's `HookCallbackMatcher.timeout`.
   *
   * `undefined` -- the shipped default -- leaves the CLI's own default in force, which is what has
   * always happened and what production should keep.
   *
   * It exists because the abort path it drives (`permissionBroker`'s `onAbort`, which emits
   * `permission_resolved: expired`) was modelled end to end and never once executed BY THE CLI'S
   * TIMEOUT. The abort path itself has fired for real, but via interrupt -- a different producer
   * reaching the same handler. Without a way to shorten the timeout, verifying the timeout producer
   * means waiting out the CLI default, which is measured only as "longer than 60s" and is not a
   * constant this host can read out of the stripped binary. Named for what it is: the seam that
   * makes that one verification affordable.
   */
  permissionHookTimeoutSeconds?: number;
  /**
   * SDK `Options.systemPrompt` as a plain string: a FULL REPLACEMENT of Claude Code's own system
   * prompt, never an append. `undefined` -- the shipped default -- leaves Claude Code's default
   * prompt in force, which is what every session got before this field existed.
   *
   * Presence is the test, not truthiness: the sidecar refuses an empty string before a session
   * exists, and a kernel consumer that passes `''` gets exactly what it asked for.
   */
  systemPrompt?: string;
  /**
   * SDK `Options.outputFormat`, verbatim in the SDK's own shape. When set, the provider validates
   * the turn's answer against `schema` and returns it as the result message's `structured_output`,
   * which this package reports as `turn_completed.structuredOutput`. `undefined` -- the shipped
   * default -- means a plain-text answer, as before this field existed.
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /**
   * How long the session's `Query.accountInfo()` probe may take before it settles as
   * `accountIdentity: { status: 'unavailable' }`. A completion-shaped session (see
   * `holdsFirstTurnForAccount`) holds its first turn's message for at most this long, then delivers
   * it anyway; any other session never waits on it. `undefined` means
   * DEFAULT_ACCOUNT_INFO_TIMEOUT_MS. A test seam first; production keeps the default.
   */
  accountInfoTimeoutMs?: number;
};

/**
 * Which account the provider authenticated as, from the SDK's `Query.accountInfo()`. Every session
 * asks once, at construction. A completion-shaped session (an explicit empty allow list, or an
 * output format) also holds its first turn's message until the answer is in (bounded by
 * `accountInfoTimeoutMs`), so for it this is settled before the provider sees any input. Any other
 * session never waits, and its session_ready carries the answer if it is in by then.
 *
 * `unavailable` means accountInfo() failed, did not answer in time, or -- for a session that does
 * not hold -- had not answered yet when system/init arrived. The session still runs -- whether an
 * unproven identity is acceptable is the host's decision, made on session_ready.
 */
export type AccountIdentity =
  | { status: 'answered'; email: string | null; organization: string | null; subscriptionType: string | null; tokenSource: string | null }
  | { status: 'unavailable'; error: string };

export type PermissionOutcome =
  | 'allowed'
  | 'denied'
  | 'cancelled_by_interrupt'
  | 'cancelled_by_session_close'
  | 'provider_failed'
  /** Spec §7.2: the CLI's own hook timeout (or any other abort of that specific hook call) gave
   * up waiting on a decision before one was made. Distinct from `denied` so an audit trail never
   * conflates "a human/policy said no" with "nobody ever answered in time." */
  | 'expired';

/**
 * Design doc §9.6 lists `limit_reached` as a fourth TurnOutcome. This package maps it from the
 * real SDK's `TerminalReason` (sdk.d.ts:8318) only for the values Task 3's own real-CLI
 * verification actually observed meaning a limit was hit (`max_turns`, `blocking_limit`,
 * `rapid_refill_breaker`, `budget_exhausted`) -- see Task 3 Step 4's note on this mapping. Every
 * other TerminalReason this package has not empirically observed maps to `failed`, never silently
 * to `completed`.
 */
export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'limit_reached';

/**
 * Token and cost accounting for a turn, summed over the SDK result's `modelUsage` (every model the
 * query pipeline called). Session-CUMULATIVE, as the SDK reports it: in a one-turn session this is
 * that turn's spend. `inputTokens` excludes both cache counters -- "the whole prompt" is
 * `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`.
 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** The `modelUsage` key with the most tokens: the model that did the work. */
  model: string;
};

/**
 * What a turn's SDK result message said about how the turn ended, beyond `outcome`. Built by
 * `resultDetail()` from the raw result message. Each field is present only when that message
 * carried it, and ALL of them are absent on a `turn_completed` the session synthesized because no
 * result message ever arrived (provider death, close mid-turn).
 */
export type TurnResultDetail = {
  /** The result message's `subtype`, verbatim ('success', 'error_max_structured_output_retries', ...). */
  resultSubtype?: string;
  /** `terminal_reason`, verbatim ('completed', 'api_error', 'blocking_limit', ...). */
  terminalReason?: string;
  /** `api_error_status`: the HTTP status of the API call that failed the turn, when reported. */
  apiErrorStatus?: number;
  /** `errors`, bounded by `boundErrors` (MAX_RESULT_ERRORS entries of MAX_RESULT_ERROR_CHARS). */
  errors?: string[];
  /** `structured_output`, verbatim: the schema-validated answer of a session with `outputFormat`. */
  structuredOutput?: unknown;
  /** Summed from `modelUsage` by `usageFromModelUsage`; absent when there was nothing usable. */
  usage?: TurnUsage;
};

/** `tool_policy_violation`: the session closed itself because system/init reported tools beyond
 * what an explicit empty allow list permits -- see `initToolViolation`. */
export type SessionCloseReason = 'closed_by_host' | 'provider_exited' | 'provider_failed' | 'tool_policy_violation';

/**
 * What the provider's system/init message reported about the session it actually built, verbatim.
 * Present on session_ready whenever system/init carried a `tools` array; a CLI that stops sending
 * one produces a session_ready WITHOUT this field, which an explicit empty allow list treats as a
 * violation (it cannot be verified) rather than as a pass.
 */
export type InitFingerprint = {
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  /** `apiKeySource`: 'none' for a claude.ai login, 'ANTHROPIC_API_KEY' when an API key is in use. */
  apiKeySource: string | null;
};

export type ClaudeRuntimeEvent =
  /** `permissionMode` is the mode the PROVIDER actually took, verbatim from the SDK's system/init
   * message, and it is the only place the effective mode is ever stated -- `ClaudeHostPolicy`
   * records what was requested and cannot contradict itself. A consumer that asked for `bypass` and
   * reads anything but `bypassPermissions` here is running weaker than it believes. */
  | {
      type: 'session_ready';
      sessionId: string;
      providerSessionId: string;
      model: string;
      cwd: string;
      permissionMode: string;
      /** Set by the session (not by `translateMessage`) on every session_ready of a session that
       * probed its account -- which is every session `createSession` builds. */
      accountIdentity?: AccountIdentity;
      /** From system/init by `translateMessage`; see InitFingerprint for when it is absent. */
      initFingerprint?: InitFingerprint;
    }
  | { type: 'turn_started'; turnId: string }
  /** `messageId` is the Claude API message id the text belongs to (see TextDelta.message_id in the
   * proto): a change of id between two deltas is a new assistant message. Absent when the provider
   * reported none. */
  | { type: 'text_delta'; turnId: string; text: string; messageId?: string }
  | { type: 'thinking_delta'; turnId: string; text: string; messageId?: string }
  | { type: 'tool_call_started'; turnId: string; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_call_completed'; turnId: string; toolUseId: string; content: unknown; isError: boolean }
  | { type: 'usage_updated'; totalCostUsd: number; numTurns: number }
  | { type: 'permission_requested'; permissionId: string; toolUseId: string; toolName: string; input: unknown }
  | { type: 'permission_resolved'; permissionId: string; outcome: PermissionOutcome }
  | ({ type: 'turn_completed'; turnId: string; outcome: TurnOutcome; resultText: string; isError: boolean; stopReason: string | null } & TurnResultDetail)
  | { type: 'session_closed'; reason: SessionCloseReason }
  /** A `setPermissionMode` the CLI acknowledged. `permissions` is the host-level mode now on the
   * gate, `permissionMode` the provider-level one the CLI accepted (SessionReady's vocabulary), and
   * `bypassDefaultDenyApplied` whether entering bypass applied the conservative floor. */
  | { type: 'permission_mode_changed'; permissions: ClaudeHostPolicy['permissions']; permissionMode: string; bypassDefaultDenyApplied: boolean }
  /** Whether a session created with `resume` actually attached to the id it asked for. Emitted at
   * most once, and only for a session that asked to resume.
   *
   * Exists because the two outcomes are observable at very different times and the caller cannot
   * tell them apart from silence. A REJECTED resume announces itself within ~2s and with no turn
   * sent -- the CLI emits a result carrying `No conversation found with session ID: <id>` and the
   * SDK generator then throws. An ATTACHED one is not observable until the first turn, because the
   * provider reports its session id in a `system`/`init` message that arrives at the start of a
   * TURN (measured: a valid resume with no turn sent produced zero events over 24 seconds). Before
   * this event existed, every one of those signals was discarded -- `pump()`'s catch bound nothing
   * at all -- and a failed resume was shape-identical to any other provider crash. */
  | {
      type: 'resume_outcome';
      requestedProviderSessionId: string;
      status: 'attached' | 'rejected' | 'initialization_failed';
      /** Set only when status === 'attached'. Compare it to the requested id -- unless `forked`. */
      attachedProviderSessionId?: string;
      /** True when this session asked to fork, in which case the provider legitimately returns a
       * DIFFERENT id and an equality check on the two ids above is the wrong test. */
      forked: boolean;
      detail?: string;
    }
  /** Design doc §9.3/§10.2: any real SDK message this package does not specifically translate
   * lands here -- diagnostic only, never thrown, never silently dropped. `kind`/`subtype` mirror
   * the raw message's own `type`/`subtype` fields (when present) so a human can correlate this
   * against `sdk.d.ts` without this package needing to re-export the raw payload verbatim. */
  | { type: 'provider_notice'; kind: string; subtype: string | null; raw: unknown };
