import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountIdentity as KernelAccountIdentity,
  ClaudeRuntimeEvent,
  PermissionOrigin as KernelPermissionOrigin,
  SteerDropReason as KernelSteerDropReason,
  TurnUsage as KernelTurnUsage,
} from '@verdandi/claude-runtime';
import {
  CliPermissionModeKind,
  ConfigurationProfile,
  PermissionMode,
  PermissionOrigin,
  PermissionOutcome,
  TurnOutcome,
  SessionCloseReason,
  ResumeStatus,
  SettingSource as SettingSourceProto,
  UserMessageDropReason,
  type AccountIdentity,
  type SessionEvent,
  type TurnUsage,
} from './generated/verdandi/claude/runtime/v1/runtime.js';

/** A field the kernel reports as `null` ("accountInfo() gave nothing for it") is left out on the
 * wire, where absence is what says the same thing. Shared by SessionReady and by a CreateSession that
 * awaited the identity, so the two cannot describe one probe differently. */
export function accountIdentityToProto(identity: KernelAccountIdentity): AccountIdentity {
  if (identity.status === 'unavailable') {
    return { error: identity.error };
  }
  const out: AccountIdentity = {};
  if (identity.email !== null) {
    out.email = identity.email;
  }
  if (identity.organization !== null) {
    out.organization = identity.organization;
  }
  if (identity.subscriptionType !== null) {
    out.subscriptionType = identity.subscriptionType;
  }
  if (identity.tokenSource !== null) {
    out.tokenSource = identity.tokenSource;
  }
  return out;
}

/** The kernel counts tokens as JS numbers; the wire carries uint64 (a bigint under forceLong=bigint).
 * Truncated and floored at 0 because BigInt() throws on a fraction and uint64 cannot hold a negative. */
function toUint64(value: number): bigint {
  return BigInt(Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));
}

function turnUsageToProto(usage: KernelTurnUsage): TurnUsage {
  return {
    inputTokens: toUint64(usage.inputTokens),
    outputTokens: toUint64(usage.outputTokens),
    cacheCreationInputTokens: toUint64(usage.cacheCreationInputTokens),
    cacheReadInputTokens: toUint64(usage.cacheReadInputTokens),
    totalCostUsd: usage.totalCostUsd,
    model: usage.model,
  };
}

const PERMISSION_OUTCOME_MAP: Record<string, PermissionOutcome> = {
  allowed: PermissionOutcome.PERMISSION_OUTCOME_ALLOWED,
  denied: PermissionOutcome.PERMISSION_OUTCOME_DENIED,
  cancelled_by_interrupt: PermissionOutcome.PERMISSION_OUTCOME_CANCELLED_BY_INTERRUPT,
  cancelled_by_session_close: PermissionOutcome.PERMISSION_OUTCOME_CANCELLED_BY_SESSION_CLOSE,
  provider_failed: PermissionOutcome.PERMISSION_OUTCOME_PROVIDER_FAILED,
  expired: PermissionOutcome.PERMISSION_OUTCOME_EXPIRED,
  deferred: PermissionOutcome.PERMISSION_OUTCOME_DEFERRED,
};

// Keyed by the kernel's own union, so a new kernel origin fails to compile here instead of falling
// back to UNSPECIFIED -- which a client reads as HOOK, the origin a host's ordinary policy may answer
// by itself.
const PERMISSION_ORIGIN_MAP: Record<KernelPermissionOrigin, PermissionOrigin> = {
  hook: PermissionOrigin.PERMISSION_ORIGIN_HOOK,
  provider_prompt: PermissionOrigin.PERMISSION_ORIGIN_PROVIDER_PROMPT,
};

const RESUME_STATUS_MAP: Record<string, ResumeStatus> = {
  attached: ResumeStatus.RESUME_STATUS_ATTACHED,
  rejected: ResumeStatus.RESUME_STATUS_REJECTED,
  initialization_failed: ResumeStatus.RESUME_STATUS_INITIALIZATION_FAILED,
};

const PERMISSION_MODE_MAP: Record<string, PermissionMode> = {
  interactive: PermissionMode.PERMISSION_MODE_INTERACTIVE,
  verdandi_rules: PermissionMode.PERMISSION_MODE_VERDANDI_RULES,
  bypass: PermissionMode.PERMISSION_MODE_BYPASS,
};

const TURN_OUTCOME_MAP: Record<string, TurnOutcome> = {
  completed: TurnOutcome.TURN_OUTCOME_COMPLETED,
  interrupted: TurnOutcome.TURN_OUTCOME_INTERRUPTED,
  failed: TurnOutcome.TURN_OUTCOME_FAILED,
  limit_reached: TurnOutcome.TURN_OUTCOME_LIMIT_REACHED,
};

const SESSION_CLOSE_REASON_MAP: Record<string, SessionCloseReason> = {
  closed_by_host: SessionCloseReason.SESSION_CLOSE_REASON_CLOSED_BY_HOST,
  provider_exited: SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_EXITED,
  provider_failed: SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_FAILED,
  tool_policy_violation: SessionCloseReason.SESSION_CLOSE_REASON_TOOL_POLICY_VIOLATION,
};

/** Total over the kernel's reasons, so a new one fails to compile here rather than reach the wire as
 * UNSPECIFIED. */
const USER_MESSAGE_DROP_REASON_MAP: Record<KernelSteerDropReason, UserMessageDropReason> = {
  cancelled: UserMessageDropReason.USER_MESSAGE_DROP_REASON_CANCELLED,
  discarded: UserMessageDropReason.USER_MESSAGE_DROP_REASON_DISCARDED,
  refused: UserMessageDropReason.USER_MESSAGE_DROP_REASON_REFUSED,
  session_closed: UserMessageDropReason.USER_MESSAGE_DROP_REASON_SESSION_CLOSED,
};

/** The tiers the kernel recorded, as the wire's enum. Total over the SDK's own `SettingSource` union. */
const SETTING_SOURCE_TO_PROTO: Record<SettingSource, SettingSourceProto> = {
  user: SettingSourceProto.SETTING_SOURCE_USER,
  project: SettingSourceProto.SETTING_SOURCE_PROJECT,
  local: SettingSourceProto.SETTING_SOURCE_LOCAL,
};

const CONFIGURATION_TO_PROTO = {
  native: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
  isolated: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED,
} as const;

/** The SDK's `PermissionMode` spellings, keyed by the CLI's own string (a test reads them out of the
 * SDK's type declaration, so a mode it gains cannot go unmapped unnoticed). */
const CLI_MODE_KINDS: Record<string, CliPermissionModeKind> = {
  default: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DEFAULT,
  acceptEdits: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_ACCEPT_EDITS,
  plan: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_PLAN,
  bypassPermissions: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_BYPASS_PERMISSIONS,
  dontAsk: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DONT_ASK,
  auto: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_AUTO,
};

/**
 * `SessionReady.permission_mode` normalised. Empty means system/init carried no mode, which is not a
 * mode and is not called UNKNOWN; any other string this sidecar has no entry for is UNKNOWN. The
 * lookup is an own-property one, so a mode string spelled like an Object.prototype member
 * (`constructor`) is UNKNOWN too rather than a function.
 */
export function cliPermissionModeKind(mode: string | undefined): CliPermissionModeKind {
  // `undefined` too: the kernel types the field as a string, but it copies whatever system/init carried,
  // and an init without a mode leaves it undefined (the wire's own default turns that into the empty string).
  if (mode === undefined || mode === '') {
    return CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNSPECIFIED;
  }
  return Object.hasOwn(CLI_MODE_KINDS, mode) ? CLI_MODE_KINDS[mode]! : CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNKNOWN;
}

/**
 * Translates one kernel ClaudeRuntimeEvent into the oneof-member fields of a proto SessionEvent
 * (design spec §3.2/§5.2). Does NOT fill in session_id/sequence/occurred_at/turn_id -- PumpDriver
 * (Task 5) owns those, since they depend on registry state and timing this pure function doesn't have
 * access to. An event type this function doesn't recognize -- including any future kernel event
 * variant added after this file was written -- always produces a providerNotice, mirroring the
 * kernel's own identical "never pass unrecognized data through raw" rule; this is the required
 * fallback per design spec §3.2, not an error case.
 */
export function translateEvent(event: ClaudeRuntimeEvent): Partial<SessionEvent> {
  switch (event.type) {
    case 'session_ready':
      return {
        sessionReady: {
          sessionId: event.sessionId,
          providerSessionId: event.providerSessionId,
          model: event.model,
          cwd: event.cwd,
          // The mode the provider actually took, not the one the policy asked for. A client that
          // requested BYPASS and reads anything but "bypassPermissions" here is running weaker
          // than it believes, and this is the only place it can find that out -- see the proto
          // field's own comment for why a behavioural check does not substitute.
          permissionMode: event.permissionMode,
          // Absent only for a kernel session built without an account probe; createSession always
          // builds one.
          accountIdentity: event.accountIdentity === undefined ? undefined : accountIdentityToProto(event.accountIdentity),
          initFingerprint:
            event.initFingerprint === undefined
              ? undefined
              : {
                  tools: [...event.initFingerprint.tools],
                  mcpServers: event.initFingerprint.mcpServers.map((server) => ({ name: server.name, status: server.status })),
                  apiKeySource: event.initFingerprint.apiKeySource ?? '',
                },
          // What the session handed the SDK, recorded when it was created. Empty and absent for a
          // kernel session that recorded nothing; createSession always records it.
          effectiveDisallowedTools: [...(event.effectiveToolOptions?.disallowedTools ?? [])],
          effectiveTools: event.effectiveToolOptions?.tools === undefined ? undefined : { tools: [...event.effectiveToolOptions.tools] },
          // The tiers and profile the session handed the SDK, recorded when it was created; empty and
          // UNSPECIFIED for a kernel session that recorded nothing (createSession always records).
          effectiveSettingSources: (event.effectiveSessionOptions?.settingSources ?? []).map((tier) => SETTING_SOURCE_TO_PROTO[tier]),
          // A profile with no wire spelling reads as UNSPECIFIED too: an undefined int32 would make
          // the whole event unserializable, and with it every watch that reaches it, replays included.
          effectiveConfiguration:
            (event.effectiveSessionOptions === undefined ? undefined : CONFIGURATION_TO_PROTO[event.effectiveSessionOptions.configuration])
            ?? ConfigurationProfile.CONFIGURATION_PROFILE_UNSPECIFIED,
          // Next to the verbatim string above, never instead of it.
          cliPermissionModeKind: cliPermissionModeKind(event.permissionMode),
        },
      };
    case 'turn_started':
      return { turnStarted: { turnId: event.turnId } };
    case 'text_delta':
      // `messageId` rides as a proto3 `optional`: absent stays absent, never an empty string a
      // client would read as "a message with the id ''".
      return { textDelta: { turnId: event.turnId, text: event.text, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) } };
    case 'thinking_delta':
      return { thinkingDelta: { turnId: event.turnId, text: event.text, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) } };
    case 'tool_call_started':
      return {
        toolCallStarted: {
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          name: event.name,
          // event.input is typed `unknown` in the kernel with no compile-time guarantee it's never
          // `undefined` -- JSON.stringify(undefined) produces the JS value `undefined`, not a string,
          // which throws inside the proto encoder and kills this exact event (and, since it's already
          // in the ring buffer by the time this runs at broadcast/replay time, every future reconnect
          // replays and re-kills on it too, until eventual eviction). `?? null` guarantees a real
          // string here always.
          inputJson: JSON.stringify(event.input ?? null),
        },
      };
    case 'tool_call_completed':
      return {
        toolCallCompleted: {
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          contentJson: JSON.stringify(event.content ?? null),
          isError: event.isError,
        },
      };
    case 'permission_requested':
      return {
        permissionRequested: {
          permissionId: event.permissionId,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          inputJson: JSON.stringify(event.input ?? null),
          // Always stated. UNSPECIFIED is what a sidecar older than the field sends, so it is never
          // chosen here for a known origin.
          origin: PERMISSION_ORIGIN_MAP[event.origin] ?? PermissionOrigin.PERMISSION_ORIGIN_UNSPECIFIED,
          // proto3 `optional`: absent stays absent, never an empty string a client would show as
          // "the CLI gave an empty reason". `typeof`, not `!== undefined`: a non-string here would
          // throw inside the encoder at broadcast time (the kernel already filters; this is the
          // boundary that must not trust it).
          ...(typeof event.providerReason === 'string' ? { providerReason: event.providerReason } : {}),
          ...(typeof event.providerDescription === 'string' ? { providerDescription: event.providerDescription } : {}),
          ...(typeof event.providerBlockedPath === 'string' ? { providerBlockedPath: event.providerBlockedPath } : {}),
          providerMatchedAskRule:
            event.providerMatchedAskRule === undefined
              ? undefined
              : {
                  source: event.providerMatchedAskRule.source,
                  toolName: event.providerMatchedAskRule.toolName,
                  ...(typeof event.providerMatchedAskRule.ruleContent === 'string' ? { ruleContent: event.providerMatchedAskRule.ruleContent } : {}),
                },
        },
      };
    case 'permission_resolved':
      return {
        permissionResolved: {
          permissionId: event.permissionId,
          outcome: PERMISSION_OUTCOME_MAP[event.outcome] ?? PermissionOutcome.PERMISSION_OUTCOME_UNSPECIFIED,
        },
      };
    case 'usage_updated':
      // Not part of this round's implemented event set (design spec §5.2) -- the kernel does not
      // currently emit this variant either, but if it starts to before this sidecar is updated to
      // handle it, fall through to the providerNotice default below rather than assuming a shape.
      return { providerNotice: { kind: event.type, subtype: undefined } };
    case 'turn_completed':
      return {
        turnCompleted: {
          turnId: event.turnId,
          outcome: TURN_OUTCOME_MAP[event.outcome] ?? TurnOutcome.TURN_OUTCOME_UNSPECIFIED,
          resultText: event.resultText,
          isError: event.isError,
          stopReason: event.stopReason ?? undefined,
          // Guarded on `undefined` because JSON.stringify(undefined) is not a string -- the same trap
          // tool_call_started's inputJson comment describes. A present `null` output is real data
          // and becomes the string "null".
          structuredOutputJson: event.structuredOutput === undefined ? undefined : JSON.stringify(event.structuredOutput),
          resultSubtype: event.resultSubtype,
          terminalReason: event.terminalReason,
          apiErrorStatus: event.apiErrorStatus,
          // Never undefined: the generated encoder iterates this field unconditionally.
          errors: event.errors ?? [],
          usage: event.usage === undefined ? undefined : turnUsageToProto(event.usage),
        },
      };
    case 'session_closed':
      return {
        sessionClosed: {
          reason: SESSION_CLOSE_REASON_MAP[event.reason] ?? SessionCloseReason.SESSION_CLOSE_REASON_UNSPECIFIED,
        },
      };
    case 'resume_outcome':
      return {
        resumeOutcome: {
          requestedProviderSessionId: event.requestedProviderSessionId,
          status: RESUME_STATUS_MAP[event.status] ?? ResumeStatus.RESUME_STATUS_UNSPECIFIED,
          attachedProviderSessionId: event.attachedProviderSessionId ?? '',
          forked: event.forked,
          detail: event.detail ?? '',
        },
      };
    case 'permission_mode_changed':
      return {
        permissionModeChanged: {
          mode: PERMISSION_MODE_MAP[event.permissions] ?? PermissionMode.PERMISSION_MODE_UNSPECIFIED,
          permissionMode: event.permissionMode,
          bypassDefaultDenyApplied: event.bypassDefaultDenyApplied,
        },
      };
    case 'permission_denied':
      // Only a session whose policy stated cli_permission_mode produces this kernel event; every other
      // session still gets the ProviderNotice{system, permission_denied} it always got. `typeof`
      // guards for the reason permission_requested's provider fields have them.
      return {
        permissionDenied: {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          ...(typeof event.reasonType === 'string' ? { reasonType: event.reasonType } : {}),
          ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
        },
      };
    case 'user_message_delivered':
      return { userMessageDelivered: { clientMessageId: event.clientMessageId, turnId: event.turnId, intoRunningTurn: event.intoRunningTurn } };
    case 'user_message_dropped':
      return {
        userMessageDropped: {
          clientMessageId: event.clientMessageId,
          reason: USER_MESSAGE_DROP_REASON_MAP[event.reason] ?? UserMessageDropReason.USER_MESSAGE_DROP_REASON_UNSPECIFIED,
        },
      };
    case 'commands_updated':
      // Copied field by field: the kernel's list is its own, and a missing string would make the event
      // unencodable for every watcher that reaches it.
      return {
        commandsUpdated: {
          commands: event.commands.map((command) => ({
            name: command.name,
            description: command.description,
            argumentHint: command.argumentHint,
            aliases: [...command.aliases],
          })),
        },
      };
    case 'provider_notice':
      return { providerNotice: { kind: event.kind, subtype: event.subtype ?? undefined } };
    default:
      return { providerNotice: { kind: (event as { type: string }).type, subtype: undefined } };
  }
}

/**
 * Extracts the turn_id that belongs at SessionEvent's own top level (design spec's event envelope,
 * mirroring source design doc §9.5's "turn_id? ... stable ID"), for the subset of kernel event
 * variants that carry one. Returns undefined for variants with no turn association (session
 * lifecycle and permission events). Kept separate from translateEvent because the top-level field and
 * the oneof member are independent concerns -- PumpDriver/RuntimeServiceImpl call both when building
 * a full SessionEvent, never just one.
 */
export function extractTurnId(event: ClaudeRuntimeEvent): string | undefined {
  switch (event.type) {
    case 'turn_started':
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_call_started':
    case 'tool_call_completed':
    case 'turn_completed':
    case 'user_message_delivered':
      return event.turnId;
    default:
      // Includes `resume_outcome` deliberately: a resume verdict belongs to the session, not to any
      // turn, and the one this session reports arrives before the first turn exists.
      return undefined;
  }
}
