import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { usesProviderPermissionPrompts } from './session.js';
import type { ClaudeHostPolicy, ClaudeSessionConfig, ClientInteractions } from './types.js';

/** The tool a question session offers the model, and the only one of the provider-prompt tools it does. */
const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * The CLI environment variables that pick a question schema or preview format of their own. An opted-in
 * session removes them from its copy of the environment: the host can draw the baseline schema only, so
 * a variable inherited from the machine's shell must not select another.
 */
const QUESTION_ENV_NAMES: readonly string[] = Object.freeze([
  'CLAUDE_CODE_QUESTION_EXTENDED',
  'CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS',
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
]);

/**
 * True when the session asked for structured questions AND is the kind of session that can have them:
 * an interactive one whose CLI permission prompts reach the host, the only sessions with a
 * `canUseTool` for the tool's call to arrive at. A request outside that shape changes nothing here;
 * the sidecar refuses it (`interactionOptInProblem`) before a session exists, and a kernel caller that
 * skips the sidecar gets the session it would have had without asking.
 */
function optedIn(policy: ClaudeHostPolicy, clientInteractions: ClientInteractions | undefined): boolean {
  return clientInteractions?.questions === true && usesProviderPermissionPrompts(policy);
}

/** Whether the session offers the model structured questions: it asked for them, and it is a session
 * whose `canUseTool` can carry them to the host. */
export function questionsOffered(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>): boolean {
  return optedIn(config.policy, config.clientInteractions);
}

/**
 * Why a session's `clientInteractions` cannot be honoured, as the stable reason a refusal carries, or
 * `null` when there is nothing to refuse.
 *
 * Asking for structured questions needs an `interactive` policy with `providerPermissionPrompts`
 * (`client_interactions_needs_provider_prompts`). A session that does not ask (`clientInteractions`
 * absent, or `questions: false`) is never refused.
 */
export function interactionOptInProblem(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>): string | null {
  if (config.clientInteractions?.questions !== true) {
    return null;
  }
  if (!usesProviderPermissionPrompts(config.policy)) {
    return 'client_interactions_needs_provider_prompts';
  }
  return null;
}

/**
 * Applies what a session that offers structured questions needs on the SDK options and its environment,
 * last in `policyToBaseOptions`, after the deny list and the account binding are built:
 *
 * - `AskUserQuestion` leaves the applied deny list, unless the caller's own `toolPolicy.deny` names it;
 *   `EnterPlanMode` and `ExitPlanMode` stay denied.
 * - `toolConfig.askUserQuestion.previewFormat` is `markdown`, stated rather than left to the CLI.
 * - The question-schema variables are removed from `options.env`. When no `env` has been built yet, a
 *   copy of `baseEnv` (or the process environment) is made first, so the process's own is never touched.
 *
 * A session that is not opted in is left exactly as it was.
 */
export function applyQuestionOptIn(
  options: Options,
  input: { policy: ClaudeHostPolicy; clientInteractions?: ClientInteractions; baseEnv?: NodeJS.ProcessEnv },
): void {
  if (!optedIn(input.policy, input.clientInteractions)) {
    return;
  }
  if (!(input.policy.toolPolicy?.deny ?? []).includes(ASK_USER_QUESTION)) {
    options.disallowedTools = (options.disallowedTools ?? []).filter((tool) => tool !== ASK_USER_QUESTION);
  }
  options.toolConfig = { askUserQuestion: { previewFormat: 'markdown' } };
  const env = options.env ?? { ...(input.baseEnv ?? process.env) };
  for (const name of QUESTION_ENV_NAMES) {
    delete env[name];
  }
  options.env = env;
}

/**
 * True when the permission gate stays out of a call because the person at the host answers it by
 * another route: the `AskUserQuestion` call of an opted-in session, which the host's question card
 * answers. Every other tool, and every session that is not opted in, is decided by the gate as before.
 */
export function gateAbstains(config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>, toolName: string): boolean {
  return toolName === ASK_USER_QUESTION && optedIn(config.policy, config.clientInteractions);
}
