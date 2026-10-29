import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountIdentity as KernelAccountIdentity,
  BackgroundTask as KernelBackgroundTask,
  ClaudeRuntimeEvent,
  InteractionOutcome as KernelInteractionOutcome,
  NoticeLevel as KernelNoticeLevel,
  PeerHoldState as KernelPeerHoldState,
  PermissionOrigin as KernelPermissionOrigin,
  RateLimitStatus as KernelRateLimitStatus,
  SessionNoticeKind as KernelSessionNoticeKind,
  SteerDropReason as KernelSteerDropReason,
  TaskEdge as KernelTaskEdge,
  TaskKind as KernelTaskKind,
  TaskStatus as KernelTaskStatus,
  TaskUsage as KernelTaskUsage,
  TurnCause as KernelTurnCause,
  TurnCauseKind as KernelTurnCauseKind,
  TurnOrigin as KernelTurnOrigin,
  TurnUsage as KernelTurnUsage,
  WorkflowProgress as KernelWorkflowProgress,
} from '@verdandi/claude-runtime';
import {
  CliPermissionModeKind,
  ConfigurationProfile,
  InteractionKind,
  InteractionOutcome,
  NoticeLevel,
  PeerHoldState,
  PermissionMode,
  PermissionOrigin,
  PermissionOutcome,
  RateLimitStatus,
  SessionNoticeKind,
  TaskEdge,
  TaskKind,
  TaskStatus,
  TurnCauseKind,
  TurnOrigin,
  TurnOutcome,
  SessionCloseReason,
  ResumeStatus,
  SettingSource as SettingSourceProto,
  UserMessageDropReason,
  type AccountIdentity,
  type BackgroundTask,
  type SessionEvent,
  type SessionNotice,
  type TaskEvent,
  type TaskUsage,
  type TurnCause,
  type TurnUsage,
  type WorkflowProgress,
} from './generated/verdandi/claude/runtime/v1/runtime.js';
import {
  DESCRIPTION_MAX_CHARS,
  ID_MAX_CHARS,
  MAX_TASKS_PER_LEVEL,
  MAX_WORKFLOW_AGENTS,
  MAX_WORKFLOW_PHASES,
  PATH_MAX_CHARS,
  TEXT_MAX_CHARS,
  WORD_MAX_CHARS,
  WORKFLOW_ERROR_MAX_CHARS,
  WORKFLOW_LABEL_MAX_CHARS,
  cut,
} from './bounds.js';

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

/** Unsigned 32-bit on the wire; a count the kernel computed as a JS number is floored and clamped. */
function toUint32(value: number): number {
  return Number.isFinite(value) ? Math.min(0xffff_ffff, Math.max(0, Math.trunc(value))) : 0;
}

function toInt32(value: number): number {
  return Number.isFinite(value) ? Math.min(0x7fff_ffff, Math.max(-0x8000_0000, Math.trunc(value))) : 0;
}

/** A time in milliseconds since the epoch, signed 64-bit on the wire. */
function toInt64(value: number): bigint {
  return BigInt(Number.isFinite(value) ? Math.trunc(value) : 0);
}

/** Sets `out[key]` to `value` cut to `max` characters, or leaves it unset when `value` is absent: an
 * optional wire field that was never stated stays absent instead of reading as an empty string. */
function putText<T, K extends keyof T>(out: T, key: K, value: string | undefined, max: number): void {
  if (value !== undefined) {
    out[key] = cut(value, max) as T[K];
  }
}

/** Sets `out[key]` to `value` when it is stated. */
function putValue<T, K extends keyof T>(out: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    out[key] = value;
  }
}

// The enum maps below are keyed by the kernel's own unions, so a value added there fails to compile
// here instead of reaching the wire as UNSPECIFIED.
const TURN_ORIGIN_MAP: Record<KernelTurnOrigin, TurnOrigin> = {
  client: TurnOrigin.TURN_ORIGIN_CLIENT,
  follow_up: TurnOrigin.TURN_ORIGIN_FOLLOW_UP,
  cli: TurnOrigin.TURN_ORIGIN_CLI,
};

const TURN_CAUSE_KIND_MAP: Record<KernelTurnCauseKind, TurnCauseKind> = {
  task: TurnCauseKind.TURN_CAUSE_KIND_TASK,
  scheduled: TurnCauseKind.TURN_CAUSE_KIND_SCHEDULED,
  peer: TurnCauseKind.TURN_CAUSE_KIND_PEER,
  other: TurnCauseKind.TURN_CAUSE_KIND_OTHER,
  unknown: TurnCauseKind.TURN_CAUSE_KIND_UNKNOWN,
};

const TASK_KIND_MAP: Record<KernelTaskKind, TaskKind> = {
  shell: TaskKind.TASK_KIND_SHELL,
  monitor: TaskKind.TASK_KIND_MONITOR,
  local_agent: TaskKind.TASK_KIND_LOCAL_AGENT,
  workflow: TaskKind.TASK_KIND_WORKFLOW,
  other: TaskKind.TASK_KIND_OTHER,
};

const TASK_STATUS_MAP: Record<KernelTaskStatus, TaskStatus> = {
  pending: TaskStatus.TASK_STATUS_PENDING,
  running: TaskStatus.TASK_STATUS_RUNNING,
  paused: TaskStatus.TASK_STATUS_PAUSED,
  completed: TaskStatus.TASK_STATUS_COMPLETED,
  failed: TaskStatus.TASK_STATUS_FAILED,
  stopped: TaskStatus.TASK_STATUS_STOPPED,
  killed: TaskStatus.TASK_STATUS_KILLED,
};

const TASK_EDGE_MAP: Record<KernelTaskEdge, TaskEdge> = {
  started: TaskEdge.TASK_EDGE_STARTED,
  progress: TaskEdge.TASK_EDGE_PROGRESS,
  updated: TaskEdge.TASK_EDGE_UPDATED,
  notified: TaskEdge.TASK_EDGE_NOTIFIED,
};

const SESSION_NOTICE_KIND_MAP: Record<KernelSessionNoticeKind, SessionNoticeKind> = {
  api_retry: SessionNoticeKind.SESSION_NOTICE_KIND_API_RETRY,
  rate_limit: SessionNoticeKind.SESSION_NOTICE_KIND_RATE_LIMIT,
  model_fallback: SessionNoticeKind.SESSION_NOTICE_KIND_MODEL_FALLBACK,
  model_refusal: SessionNoticeKind.SESSION_NOTICE_KIND_MODEL_REFUSAL,
  compacting: SessionNoticeKind.SESSION_NOTICE_KIND_COMPACTING,
  compact_boundary: SessionNoticeKind.SESSION_NOTICE_KIND_COMPACT_BOUNDARY,
  informational: SessionNoticeKind.SESSION_NOTICE_KIND_INFORMATIONAL,
  notification: SessionNoticeKind.SESSION_NOTICE_KIND_NOTIFICATION,
  peer_hold: SessionNoticeKind.SESSION_NOTICE_KIND_PEER_HOLD,
};

const NOTICE_LEVEL_MAP: Record<KernelNoticeLevel, NoticeLevel> = {
  info: NoticeLevel.NOTICE_LEVEL_INFO,
  notice: NoticeLevel.NOTICE_LEVEL_NOTICE,
  suggestion: NoticeLevel.NOTICE_LEVEL_SUGGESTION,
  warning: NoticeLevel.NOTICE_LEVEL_WARNING,
};

const RATE_LIMIT_STATUS_MAP: Record<KernelRateLimitStatus, RateLimitStatus> = {
  allowed: RateLimitStatus.RATE_LIMIT_STATUS_ALLOWED,
  allowed_warning: RateLimitStatus.RATE_LIMIT_STATUS_ALLOWED_WARNING,
  rejected: RateLimitStatus.RATE_LIMIT_STATUS_REJECTED,
};

const PEER_HOLD_STATE_MAP: Record<KernelPeerHoldState, PeerHoldState> = {
  held: PeerHoldState.PEER_HOLD_STATE_HELD,
  released: PeerHoldState.PEER_HOLD_STATE_RELEASED,
  dropped: PeerHoldState.PEER_HOLD_STATE_DROPPED,
};

const INTERACTION_OUTCOME_MAP: Record<KernelInteractionOutcome, InteractionOutcome> = {
  answered: InteractionOutcome.INTERACTION_OUTCOME_ANSWERED,
  declined: InteractionOutcome.INTERACTION_OUTCOME_DECLINED,
  chat_requested: InteractionOutcome.INTERACTION_OUTCOME_CHAT_REQUESTED,
  interrupted: InteractionOutcome.INTERACTION_OUTCOME_INTERRUPTED,
  expired: InteractionOutcome.INTERACTION_OUTCOME_EXPIRED,
  session_closed: InteractionOutcome.INTERACTION_OUTCOME_SESSION_CLOSED,
  provider_failed: InteractionOutcome.INTERACTION_OUTCOME_PROVIDER_FAILED,
  host_refused: InteractionOutcome.INTERACTION_OUTCOME_HOST_REFUSED,
};

/** A cause as the wire states it: only the facts the kernel gave, each string cut to its limit. */
export function turnCauseToProto(cause: KernelTurnCause): TurnCause {
  const out: TurnCause = { kind: TURN_CAUSE_KIND_MAP[cause.kind] ?? TurnCauseKind.TURN_CAUSE_KIND_UNSPECIFIED };
  putText(out, 'taskId', cause.taskId, ID_MAX_CHARS);
  putValue(out, 'taskKind', cause.taskKind === undefined ? undefined : (TASK_KIND_MAP[cause.taskKind] ?? TaskKind.TASK_KIND_UNSPECIFIED));
  putValue(out, 'taskStatus', cause.taskStatus === undefined ? undefined : (TASK_STATUS_MAP[cause.taskStatus] ?? TaskStatus.TASK_STATUS_UNSPECIFIED));
  putText(out, 'description', cause.description, DESCRIPTION_MAX_CHARS);
  putText(out, 'summary', cause.summary, TEXT_MAX_CHARS);
  putText(out, 'peerName', cause.peerName, ID_MAX_CHARS);
  putText(out, 'text', cause.text, TEXT_MAX_CHARS);
  putText(out, 'wakeupSource', cause.wakeupSource, WORD_MAX_CHARS);
  putValue(out, 'scheduledForMs', cause.scheduledForMs === undefined ? undefined : toInt64(cause.scheduledForMs));
  putText(out, 'scheduleReason', cause.scheduleReason, DESCRIPTION_MAX_CHARS);
  putText(out, 'cronId', cause.cronId, ID_MAX_CHARS);
  putText(out, 'prompt', cause.prompt, TEXT_MAX_CHARS);
  return out;
}

function backgroundTaskToProto(task: KernelBackgroundTask): BackgroundTask {
  const out: BackgroundTask = {
    taskId: cut(task.taskId, ID_MAX_CHARS),
    kind: TASK_KIND_MAP[task.kind] ?? TaskKind.TASK_KIND_UNSPECIFIED,
    taskType: cut(task.taskType, WORD_MAX_CHARS),
    description: cut(task.description, DESCRIPTION_MAX_CHARS),
    ambient: task.ambient,
  };
  putText(out, 'runId', task.runId, ID_MAX_CHARS);
  putText(out, 'subagentType', task.subagentType, ID_MAX_CHARS);
  putText(out, 'parentTaskId', task.parentTaskId, ID_MAX_CHARS);
  putText(out, 'toolUseId', task.toolUseId, ID_MAX_CHARS);
  putText(out, 'workflowName', task.workflowName, ID_MAX_CHARS);
  return out;
}

function taskUsageToProto(usage: KernelTaskUsage): TaskUsage {
  return { totalTokens: toUint64(usage.totalTokens), toolUses: toUint32(usage.toolUses), durationMs: toUint64(usage.durationMs) };
}

function workflowProgressToProto(progress: KernelWorkflowProgress): WorkflowProgress {
  return {
    phases: progress.phases.slice(0, MAX_WORKFLOW_PHASES).map((phase) => ({
      index: toUint32(phase.index),
      title: cut(phase.title, WORKFLOW_LABEL_MAX_CHARS),
      kind: cut(phase.kind, WORKFLOW_LABEL_MAX_CHARS),
    })),
    agents: progress.agents.slice(0, MAX_WORKFLOW_AGENTS).map((agent) => {
      const out: WorkflowProgress['agents'][number] = {
        index: toUint32(agent.index),
        label: cut(agent.label, WORKFLOW_LABEL_MAX_CHARS),
        phaseIndex: toUint32(agent.phaseIndex),
        state: cut(agent.state, WORKFLOW_LABEL_MAX_CHARS),
      };
      putText(out, 'model', agent.model, WORKFLOW_LABEL_MAX_CHARS);
      putText(out, 'agentType', agent.agentType, WORKFLOW_LABEL_MAX_CHARS);
      putValue(out, 'tokens', agent.tokens === undefined ? undefined : toUint64(agent.tokens));
      putValue(out, 'toolCalls', agent.toolCalls === undefined ? undefined : toUint32(agent.toolCalls));
      putValue(out, 'durationMs', agent.durationMs === undefined ? undefined : toUint64(agent.durationMs));
      putText(out, 'error', agent.error, WORKFLOW_ERROR_MAX_CHARS);
      return out;
    }),
  };
}

function taskEventToProto(event: Extract<ClaudeRuntimeEvent, { type: 'task_event' }>): TaskEvent {
  const out: TaskEvent = {
    edge: TASK_EDGE_MAP[event.edge] ?? TaskEdge.TASK_EDGE_UNSPECIFIED,
    taskId: cut(event.taskId, ID_MAX_CHARS),
    task: event.task === undefined ? undefined : backgroundTaskToProto(event.task),
    usage: event.usage === undefined ? undefined : taskUsageToProto(event.usage),
    workflowProgress: event.workflowProgress === undefined ? undefined : workflowProgressToProto(event.workflowProgress),
  };
  putText(out, 'runId', event.runId, ID_MAX_CHARS);
  putValue(out, 'status', event.status === undefined ? undefined : (TASK_STATUS_MAP[event.status] ?? TaskStatus.TASK_STATUS_UNSPECIFIED));
  putText(out, 'summary', event.summary, TEXT_MAX_CHARS);
  putText(out, 'lastToolName', event.lastToolName, WORD_MAX_CHARS);
  putValue(out, 'endTimeMs', event.endTimeMs === undefined ? undefined : toInt64(event.endTimeMs));
  putText(out, 'error', event.error, TEXT_MAX_CHARS);
  putValue(out, 'isBackgrounded', event.isBackgrounded);
  putText(out, 'reason', event.reason, TEXT_MAX_CHARS);
  putText(out, 'outputFile', event.outputFile, PATH_MAX_CHARS);
  return out;
}

function sessionNoticeToProto(event: Extract<ClaudeRuntimeEvent, { type: 'session_notice' }>): SessionNotice {
  const out: SessionNotice = {
    kind: SESSION_NOTICE_KIND_MAP[event.kind] ?? SessionNoticeKind.SESSION_NOTICE_KIND_UNSPECIFIED,
    level: NOTICE_LEVEL_MAP[event.level] ?? NoticeLevel.NOTICE_LEVEL_UNSPECIFIED,
  };
  putText(out, 'content', event.content, TEXT_MAX_CHARS);
  putValue(out, 'attempt', event.attempt === undefined ? undefined : toUint32(event.attempt));
  putValue(out, 'maxRetries', event.maxRetries === undefined ? undefined : toUint32(event.maxRetries));
  putValue(out, 'retryDelayMs', event.retryDelayMs === undefined ? undefined : toUint64(event.retryDelayMs));
  putValue(out, 'errorStatus', event.errorStatus === undefined ? undefined : toInt32(event.errorStatus));
  putText(out, 'fromModel', event.fromModel, ID_MAX_CHARS);
  putText(out, 'toModel', event.toModel, ID_MAX_CHARS);
  putValue(out, 'preTokens', event.preTokens === undefined ? undefined : toUint64(event.preTokens));
  putValue(out, 'postTokens', event.postTokens === undefined ? undefined : toUint64(event.postTokens));
  putValue(out, 'rateStatus', event.rateStatus === undefined ? undefined : (RATE_LIMIT_STATUS_MAP[event.rateStatus] ?? RateLimitStatus.RATE_LIMIT_STATUS_UNSPECIFIED));
  putValue(out, 'resetsAtMs', event.resetsAtMs === undefined ? undefined : toInt64(event.resetsAtMs));
  putValue(out, 'utilization', event.utilization);
  putText(out, 'trigger', event.trigger, WORD_MAX_CHARS);
  putText(out, 'peerName', event.peerName, ID_MAX_CHARS);
  putValue(out, 'holdState', event.holdState === undefined ? undefined : (PEER_HOLD_STATE_MAP[event.holdState] ?? PeerHoldState.PEER_HOLD_STATE_UNSPECIFIED));
  putText(out, 'errorKind', event.errorKind, WORD_MAX_CHARS);
  putText(out, 'fallbackScope', event.fallbackScope, WORD_MAX_CHARS);
  return out;
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
      // UNSPECIFIED is the zero value, so a turn whose origin the kernel did not state encodes as it did
      // before `origin` existed, and a host reads it as "not stated".
      return {
        turnStarted: {
          turnId: event.turnId,
          origin: event.origin === undefined ? TurnOrigin.TURN_ORIGIN_UNSPECIFIED : (TURN_ORIGIN_MAP[event.origin] ?? TurnOrigin.TURN_ORIGIN_UNSPECIFIED),
          cause: event.cause === undefined ? undefined : turnCauseToProto(event.cause),
        },
      };
    case 'text_delta':
      // `messageId` rides as a proto3 `optional`: absent stays absent, never an empty string a
      // client would read as "a message with the id ''".
      return {
        textDelta: {
          turnId: event.turnId,
          text: event.text,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: cut(event.parentToolUseId, ID_MAX_CHARS) }),
        },
      };
    case 'thinking_delta':
      return {
        thinkingDelta: {
          turnId: event.turnId,
          text: event.text,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: cut(event.parentToolUseId, ID_MAX_CHARS) }),
        },
      };
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
          ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: cut(event.parentToolUseId, ID_MAX_CHARS) }),
        },
      };
    case 'tool_call_completed':
      return {
        toolCallCompleted: {
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          contentJson: JSON.stringify(event.content ?? null),
          isError: event.isError,
          ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: cut(event.parentToolUseId, ID_MAX_CHARS) }),
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
          ...(event.originKind === undefined ? {} : { originKind: cut(event.originKind, WORD_MAX_CHARS) }),
          ...(event.numTurns === undefined ? {} : { numTurns: toUint32(event.numTurns) }),
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
    case 'turn_cause_updated':
      return { turnCauseUpdated: { turnId: event.turnId, cause: turnCauseToProto(event.cause) } };
    case 'cli_cycle_started':
      return { cliCycleStarted: { turnId: event.turnId, cause: turnCauseToProto(event.cause) } };
    case 'background_tasks_changed':
      return { backgroundTasksChanged: { tasks: event.tasks.slice(0, MAX_TASKS_PER_LEVEL).map(backgroundTaskToProto) } };
    case 'task_event':
      return { taskEvent: taskEventToProto(event) };
    case 'session_notice':
      return { sessionNotice: sessionNoticeToProto(event) };
    case 'conversation_reset':
      return {
        conversationReset: {
          newConversationId: cut(event.newConversationId, ID_MAX_CHARS),
          ...(event.trigger === undefined ? {} : { trigger: cut(event.trigger, WORD_MAX_CHARS) }),
        },
      };
    case 'interaction_requested':
      // The questions themselves are passed whole: a question over its limits is refused before this
      // event exists, never cut here.
      return {
        interactionRequested: {
          interactionId: event.interactionId,
          toolUseId: event.toolUseId,
          kind: InteractionKind.INTERACTION_KIND_QUESTION,
          questions:
            event.questions === undefined
              ? undefined
              : {
                  questions: event.questions.map((question) => ({
                    question: question.question,
                    header: question.header,
                    multiSelect: question.multiSelect,
                    options: question.options.map((option) => ({
                      label: option.label,
                      description: option.description,
                      ...(option.preview === undefined ? {} : { preview: option.preview }),
                    })),
                  })),
                },
          ...(event.unsupportedReason === undefined ? {} : { unsupportedReason: cut(event.unsupportedReason, TEXT_MAX_CHARS) }),
        },
      };
    case 'interaction_resolved':
      return {
        interactionResolved: {
          interactionId: event.interactionId,
          outcome: INTERACTION_OUTCOME_MAP[event.outcome] ?? InteractionOutcome.INTERACTION_OUTCOME_UNSPECIFIED,
          answers: (event.answers ?? []).map((answer) => ({
            questionIndex: toUint32(answer.questionIndex),
            answer: answer.answer,
            ...(answer.notes === undefined ? {} : { notes: answer.notes }),
          })),
          ...(event.reason === undefined ? {} : { reason: cut(event.reason, TEXT_MAX_CHARS) }),
        },
      };
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
    case 'turn_cause_updated':
    case 'cli_cycle_started':
      return event.turnId;
    default:
      // Includes `resume_outcome` deliberately: a resume verdict belongs to the session, not to any
      // turn, and the one this session reports arrives before the first turn exists.
      return undefined;
  }
}
