export type {
  ClaudeHostPolicy,
  ClaudeSessionConfig,
  ClaudeRuntimeEvent,
  TurnOutcome,
  SessionCloseReason,
  PermissionOutcome,
  PermissionOrigin,
  ProviderMatchedAskRule,
  TurnResultDetail,
  TurnUsage,
  AccountIdentity,
  InitFingerprint,
  InitCheckMode,
  EffectiveSessionOptions,
  EffectiveToolOptions,
  CliPermissionMode,
  SlashCommandInfo,
  SteerDropReason,
  ClientInteractions,
  TurnOrigin,
  TurnCauseKind,
  TurnCause,
  TaskKind,
  TaskStatus,
  TaskEdge,
  BackgroundTask,
  TaskUsage,
  TaskEventPayload,
  WorkflowProgress,
  WorkflowPhase,
  WorkflowAgent,
  SessionNoticeKind,
  NoticeLevel,
  RateLimitStatus,
  PeerHoldState,
  SessionNoticePayload,
  InteractionQuestion,
  InteractionQuestionOption,
  InteractionOutcome,
  InteractionRequestedEvent,
  InteractionResolvedEvent,
  InteractionKind,
  PlanExecutionMode,
  PlanProposal,
  PlanAllowedPrompt,
  ClientToolCallOutcome,
  ClientToolCallEvent,
  ClientToolCallSettledEvent,
  ShownAnswer,
  TaskOutputResult,
  AppliedSettings,
  ModelOption,
  SteerTurnOptions,
} from './types.js';
export { interactionOptInProblem, applyQuestionOptIn, gateAbstains } from './questionOptions.js';
export { createInteractionPort, InteractionAnswerError, InteractionNotFoundError } from './interactionPort.js';
export type { InteractionPort, InteractionPortContext, InteractionFailCause, InteractionResult, InteractionAnswerInput, InteractionAnswerRefusal } from './interactionPort.js';
export { PLAN_TOOL, ENTER_PLAN_TOOL, planOffered, planOptInProblem, applyPlanOptIn, planGateAbstains, planDeferral, planAllowAnswer } from './planOptions.js';
export type { PlanAllowAnswer } from './planOptions.js';
export {
  PlanBroker,
  PLAN_LIMITS,
  CLI_PLAN_REJECT_TEXT,
  CLI_PLAN_REJECT_FEEDBACK_OPENING,
  CLI_PLAN_REJECT_TEXT_VERSION,
  PLAN_OUTSIDE_PLAN_MODE_TEXT,
  PLAN_NOT_OFFERED_TEXT,
  PLAN_SUBAGENT_TEXT,
  PLAN_WITHDRAWN_TEXT,
  planRejectText,
  planRefusedText,
  planSha256,
  parsePlanInput,
} from './planBroker.js';
export { TaskNotFoundError, TaskOutputUnavailableError, TASK_OUTPUT_RANGE_MAX_BYTES, TASK_OUTPUT_TAIL_BYTES, taskOutputReadable } from './taskOutput.js';
export type { OutputRange, TaskOutputUnavailableReason } from './taskOutput.js';
export { STRUCTURED_OUTPUT_CARRIER_TOOLS, permittedInitTools, requiredInitTools, expectedInitMcpServers, mcpToolServer, initToolViolation, verifiesInitTools, initCheckProblem } from './toolInvariant.js';
export { CLIENT_TOOL_LIMITS, clientToolsProblem } from './clientTools.js';
export type { ClientToolDeclaration, ClientTools, ClientToolsRefusal } from './clientTools.js';
export { createClientToolPort, ClientToolCallNotFoundError, ClientToolCallSettledError } from './clientToolBroker.js';
export type { ClientToolPort, ClientToolAnswer, ClientToolFailCause } from './clientToolBroker.js';
export { EXTRA_MCP_SERVERS_VARIABLE, MAX_EXTRA_MCP_SERVERS, resolveExtraMcpServers, describeExtraMcpServers, copyExtraMcpServers } from './extraMcpServers.js';
export type { ExtraMcpServers, ExtraMcpServerConfig } from './extraMcpServers.js';
export { WEBFETCH_PRIVATE_DENY, webFetchDenyFor } from './webFetchDeny.js';
export { probeAccountIdentity, accountIdentityFromInfo, DEFAULT_ACCOUNT_INFO_TIMEOUT_MS } from './accountIdentity.js';
export { resultDetail, boundErrors, usageFromModelUsage, MAX_RESULT_ERRORS, MAX_RESULT_ERROR_CHARS } from './resultDetail.js';
export { translateMessage } from './eventTranslation.js';
export type { TranslationContext } from './eventTranslation.js';
export {
  createSession,
  ClaudeRuntimeSession,
  policyToBaseOptions,
  buildSessionOptions,
  DEFAULT_HOST_CLI_PATH,
  // Single-sourced here on purpose: the sidecar, its tests and any documentation must reference this
  // one array rather than keeping a second copy that can drift out of agreement with what a session
  // actually got.
  CONSERVATIVE_BYPASS_DENY,
  usesDefaultBypassDeny,
  // Same reason as CONSERVATIVE_BYPASS_DENY: one list of the tools a provider-prompt session loses.
  PROVIDER_PROMPT_TOOL_DENY,
  usesProviderPermissionPrompts,
  holdsFirstTurnForAccount,
  gateDecision,
  providerPermissionMode,
  PermissionModeError,
  PlanningError,
  PLANNING_SWITCH_TIMEOUT_MS,
  CliModeEvidence,
  SessionSettingsError,
  cliPermissionModeProblem,
  permissionDeniedEventsFor,
  SteerError,
  CLI_MESSAGE_LIFECYCLE_CAPABILITY,
  STEER_MIN_CLI_VERSION,
} from './session.js';
export type { QueryFn, SessionGuards, PermissionGateState, SteerRefusalReason, PlanningRefusalReason, SendTurnOptions } from './session.js';
export { TURN_CONTENT_LIMITS, sniffImage, checkTurnContent, userContent } from './turnContent.js';
export type { TurnImage, ImageMediaType } from './turnContent.js';
export type { MinimalQuery } from './queryTypes.js';
export type { GateDecision, PermissionAnswer, PlanHookGuard } from './permissionBroker.js';
export type { AccountProbe } from './accountIdentity.js';
export { PermissionBroker, PermissionAnswerError, DEFAULT_PROVIDER_PROMPT_DENY_MESSAGE, PLAN_ASK_REASON } from './permissionBroker.js';
export {
  explicitAccount,
  isDefaultConfigDir,
  effectiveClaudeConfigDir,
  assertAccountUsable,
  accountEnv,
  applyAccountEnv,
  accountGlobalConfigPath,
  ACCOUNT_ENV_VARS,
  IDENTITY_SEED_ENV_VARS,
  DEFAULT_ACCOUNT_NAME,
} from './account.js';
export type { ClaudeAccount, ExplicitAccountSpec } from './account.js';
