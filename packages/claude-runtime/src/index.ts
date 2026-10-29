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
  ShownAnswer,
  TaskOutputResult,
  SendTurnOptions,
  SteerTurnOptions,
} from './types.js';
export { interactionOptInProblem, applyQuestionOptIn, gateAbstains } from './questionOptions.js';
export { createInteractionPort, InteractionAnswerError, InteractionNotFoundError } from './interactionPort.js';
export type { InteractionPort, InteractionFailCause, InteractionResult, InteractionAnswerInput, InteractionAnswerRefusal } from './interactionPort.js';
export { TaskNotFoundError, TaskOutputUnavailableError, TASK_OUTPUT_TAIL_BYTES, taskOutputReadable } from './taskOutput.js';
export type { TaskOutputUnavailableReason } from './taskOutput.js';
export { STRUCTURED_OUTPUT_CARRIER_TOOLS, permittedInitTools, requiredInitTools, expectedInitMcpServers, mcpToolServer, initToolViolation, verifiesInitTools, initCheckProblem } from './toolInvariant.js';
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
  cliPermissionModeProblem,
  permissionDeniedEventsFor,
  SteerError,
  CLI_MESSAGE_LIFECYCLE_CAPABILITY,
  STEER_MIN_CLI_VERSION,
} from './session.js';
export type { QueryFn, SessionGuards, PermissionGateState, SteerRefusalReason } from './session.js';
export type { MinimalQuery } from './queryTypes.js';
export type { GateDecision, PermissionAnswer } from './permissionBroker.js';
export type { AccountProbe } from './accountIdentity.js';
export { PermissionBroker, PermissionAnswerError, DEFAULT_PROVIDER_PROMPT_DENY_MESSAGE } from './permissionBroker.js';
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
