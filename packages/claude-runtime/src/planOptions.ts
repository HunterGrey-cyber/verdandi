import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { usesProviderPermissionPrompts } from './session.js';
import type { ClaudeHostPolicy, ClaudeSessionConfig, ClientInteractions } from './types.js';

/** The tool the model proposes a plan with; on a plan session its call goes to the `PlanBroker`. */
export const PLAN_TOOL = 'ExitPlanMode';

/** The tool the model enters plan mode with. The CLI does not ask the host about it (the PreToolUse
 * hook fires, and an abstention lets it through), so it reaches no broker. */
export const ENTER_PLAN_TOOL = 'EnterPlanMode';

/** The two tools a plan session offers the model. */
const PLAN_TOOLS: readonly string[] = Object.freeze([ENTER_PLAN_TOOL, PLAN_TOOL]);

/**
 * The file-writing tools a host `allow` is not passed on for while the CLI is in plan mode. An explicit
 * hook allow is a grant of its own that carries a call past plan mode's rules; with no decision the CLI
 * applies them: it writes its own plan file without asking, and asks the host through `canUseTool`
 * about a write anywhere else (CLI 2.1.311).
 */
const PLAN_ABSTAIN_TOOLS: readonly string[] = Object.freeze(['Edit', 'Write', 'NotebookEdit']);

/**
 * The tool a host `allow` is turned into an `ask` for while the CLI is in plan mode. With no decision
 * the CLI would leave a command that is not read-only to its auto-mode classifier, which can run it
 * with nobody asked; a hook `ask` sends the call to the CLI's permission prompt instead, which reaches
 * the host through `canUseTool`, and a classifier allow cannot replace that prompt (CLI 2.1.311).
 */
const PLAN_ASK_TOOLS: readonly string[] = Object.freeze(['Bash']);

/** What a plan session's hook sends the CLI in place of a host `allow` (see `planAllowAnswer`). */
export type PlanAllowAnswer = 'allow' | 'abstain' | 'ask';

/**
 * True when the session asked for plan mode AND can have it: an interactive session whose CLI
 * permission prompts reach the host (the only kind with a `canUseTool` for `ExitPlanMode`'s plan to
 * arrive at), whose policy states the CLI's permission mode (the mode plan mode returns to), and that
 * is not `permissionModeSwitchable` (a plan session's mode never switches, and the flag would launch the
 * CLI able to enter bypass for nothing). A request outside that shape changes nothing here; the sidecar refuses it (`planOptInProblem`).
 */
function optedIn(policy: ClaudeHostPolicy, clientInteractions: ClientInteractions | undefined): boolean {
  return (
    clientInteractions?.planMode === true &&
    usesProviderPermissionPrompts(policy) &&
    policy.cliPermissionMode !== undefined &&
    policy.permissionModeSwitchable !== true
  );
}

/** Whether the session offers plan mode: it asked for it, and it is a session that can carry it. */
export function planOffered(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>): boolean {
  return optedIn(config.policy, config.clientInteractions);
}

/**
 * Why a session's request for plan mode cannot be honoured, as the stable reason a refusal carries, or
 * `null` when there is nothing to refuse. A session that does not ask (`planMode` absent or false) is
 * never refused.
 *
 * - `client_interactions_needs_provider_prompts`: not an `interactive` session with
 *   `providerPermissionPrompts` (the rule questions follow).
 * - `client_interactions_plan_needs_cli_mode`: the policy does not state `cliPermissionMode`, so there
 *   is no stated mode for plan mode to return to.
 * - `client_interactions_plan_with_switchable`: the policy is `permissionModeSwitchable`. A plan
 *   session's permission mode never switches, and the flag would only launch the CLI able to enter
 *   bypass.
 */
export function planOptInProblem(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>): string | null {
  if (config.clientInteractions?.planMode !== true) {
    return null;
  }
  if (!usesProviderPermissionPrompts(config.policy)) {
    return 'client_interactions_needs_provider_prompts';
  }
  if (config.policy.cliPermissionMode === undefined) {
    return 'client_interactions_plan_needs_cli_mode';
  }
  if (config.policy.permissionModeSwitchable === true) {
    return 'client_interactions_plan_with_switchable';
  }
  return null;
}

/**
 * Applies what a plan session needs on the SDK options, last in `policyToBaseOptions`: `EnterPlanMode`
 * and `ExitPlanMode` leave the applied deny list, unless the caller's own `toolPolicy.deny` names them.
 * The CLI's own plan-mode instructions are left as they are. A session that does not offer plan mode is
 * left exactly as it was.
 */
export function applyPlanOptIn(options: Options, input: { policy: ClaudeHostPolicy; clientInteractions?: ClientInteractions }): void {
  if (!optedIn(input.policy, input.clientInteractions)) {
    return;
  }
  const callerDeny = input.policy.toolPolicy?.deny ?? [];
  options.disallowedTools = (options.disallowedTools ?? []).filter((tool) => !PLAN_TOOLS.includes(tool) || callerDeny.includes(tool));
}

/**
 * True when the permission gate stays out of a plan tool's call on a plan session. Entering plan mode
 * only tightens what the CLI does, and the CLI does not ask anyone about it; a plan is settled by the
 * person on the plan itself (`PlanBroker`), never by a permission answer. Every other tool, and every
 * session that does not offer plan mode, is decided by the gate as before.
 */
export function planGateAbstains(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>, toolName: string): boolean {
  return PLAN_TOOLS.includes(toolName) && optedIn(config.policy, config.clientInteractions);
}

/**
 * What a plan session's hook sends the CLI when the host answered `allow`, with the CLI in `cliMode`:
 * the allow itself, except in plan mode for a tool that changes files (`abstain`: the CLI's plan mode
 * decides) or runs commands (`ask`: the CLI's permission prompt decides). Neither is looser than the
 * allow it replaces. Every other tool, mode and session gets the allow.
 */
export function planAllowAnswer(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>, toolName: string, cliMode: string | undefined): PlanAllowAnswer {
  if (cliMode !== 'plan' || !optedIn(config.policy, config.clientInteractions)) {
    return 'allow';
  }
  return PLAN_ABSTAIN_TOOLS.includes(toolName) ? 'abstain' : PLAN_ASK_TOOLS.includes(toolName) ? 'ask' : 'allow';
}

/**
 * True when a host `allow` for this call is not sent as an allow (`planAllowAnswer` is not `allow`): a
 * plan session, the CLI in plan mode, and one of the tools that change files or run commands.
 */
export function planDeferral(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>, toolName: string, cliMode: string | undefined): boolean {
  return planAllowAnswer(config, toolName, cliMode) !== 'allow';
}
