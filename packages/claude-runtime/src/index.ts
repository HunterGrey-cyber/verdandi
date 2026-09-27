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
} from './types.js';
export { STRUCTURED_OUTPUT_CARRIER_TOOLS, permittedInitTools, requiredInitTools, initToolViolation } from './toolInvariant.js';
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
} from './session.js';
export type { QueryFn, SessionGuards, PermissionGateState } from './session.js';
export type { GateDecision } from './permissionBroker.js';
export type { AccountProbe } from './accountIdentity.js';
export { PermissionBroker, DEFAULT_PROVIDER_PROMPT_DENY_MESSAGE } from './permissionBroker.js';
export { resolveAccount, resolveAccountSpec, assertAccountUsable, accountEnv, applyAccountEnv, accountGlobalConfigPath, ACCOUNT_ENV_VARS, IDENTITY_SEED_ENV_VARS, DEFAULT_ACCOUNT_NAME } from './account.js';
export type { ClaudeAccount } from './account.js';
