import { createHash, randomUUID } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  InteractionAnswerError,
  InteractionNotFoundError,
  type InteractionAnswerRefusal,
  type InteractionFailCause,
  type InteractionPort,
  type InteractionResult,
} from './interactionPort.js';
import { PLAN_TOOL } from './planOptions.js';
import { interactionFailText } from './questionBroker.js';
import type { ClaudeRuntimeEvent, InteractionRequestedEvent, InteractionResolvedEvent, PlanAllowedPrompt, PlanExecutionMode } from './types.js';

/**
 * The limits a plan is held to before the host is shown it, and a person's feedback before the model
 * is. A plan over them is refused whole, never cut: a shortened plan is not the one the model proposed.
 */
export const PLAN_LIMITS = Object.freeze({
  /** The plan text, in UTF-8 bytes. A real plan is a few KiB. */
  planMaxBytes: 262144,
  /** The feedback sent back with "keep planning", in UTF-8 bytes. */
  feedbackMaxBytes: 16384,
  /** Entries in the plan's `allowedPrompts`. */
  allowedPromptsMax: 32,
  /** Each entry's `tool` and `prompt`, in UTF-16 code units. */
  allowedPromptMaxChars: 1000,
});

/** The CLI version the two rejection texts below were read from. */
export const CLI_PLAN_REJECT_TEXT_VERSION = '2.1.311';

/**
 * What the CLI's terminal sends the model when the person keeps planning without typing anything:
 * the rejection constant of Claude Code 2.1.311. The CLI adds nothing to a host's deny message, so the
 * host sends the terminal's own words.
 */
export const CLI_PLAN_REJECT_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** The opening the 2.1.311 terminal puts before the person's own words when they keep planning with
 * feedback; the feedback follows it directly. */
export const CLI_PLAN_REJECT_FEEDBACK_OPENING =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";

/** What the model reads when the person keeps planning: the terminal's text with the feedback, or its
 * plain rejection when there is none (an empty or blank field is none, as in the terminal). */
export function planRejectText(feedback: string): string {
  return feedback.trim() === '' ? CLI_PLAN_REJECT_TEXT : CLI_PLAN_REJECT_FEEDBACK_OPENING + feedback;
}

/** What the model reads when a plan could not be offered to the person. */
export function planRefusedText(reason: string): string {
  return `This client could not show the plan: ${reason}. Shorten the plan and call ExitPlanMode again.`;
}

/** What the model reads when it calls `ExitPlanMode` while the CLI is not in plan mode. */
export const PLAN_OUTSIDE_PLAN_MODE_TEXT = 'ExitPlanMode is only available in plan mode.';

/** What a subagent reads when it calls `ExitPlanMode`. A subagent's plan mode is its own: approving its
 * plan would not move the conversation's CLI out of plan mode, so it is never shown as the
 * conversation's plan. */
export const PLAN_SUBAGENT_TEXT = 'ExitPlanMode is not available to a subagent on this client: return the plan in your final response instead.';

/** What the model reads when the CLI gave up waiting on a plan (the SDK aborted the callback). */
export const PLAN_WITHDRAWN_TEXT = 'The host denied this plan because the CLI withdrew it.';

/** What the model reads when a session that does not offer plan mode gets an `ExitPlanMode` call. */
export const PLAN_NOT_OFFERED_TEXT = 'ExitPlanMode is not offered on this session';

const PLAN_EXECUTION_MODES: readonly string[] = ['manual', 'auto', 'bypass'] satisfies PlanExecutionMode[];

/** The SHA-256 of a plan's UTF-8 bytes, lowercase hex: what an approval must name. */
export function planSha256(plan: string): string {
  return createHash('sha256').update(plan, 'utf8').digest('hex');
}

type ParsedPlan = { ok: true; plan: string; allowedPrompts: PlanAllowedPrompt[] } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the plan out of an `ExitPlanMode` input: `plan`, a non-empty string within the byte limit, and
 * an optional `allowedPrompts` of `{tool, prompt}` within its limits. Other keys (`planFilePath`, which
 * the CLI fills in) are not read, and nothing in the input is changed.
 */
export function parsePlanInput(input: unknown): ParsedPlan {
  const refuse = (reason: string): ParsedPlan => ({ ok: false, reason });
  if (!isRecord(input)) {
    return refuse('the tool input is not an object');
  }
  const { plan, allowedPrompts } = input;
  if (typeof plan !== 'string' || plan === '') {
    return refuse('the tool input has no plan text');
  }
  if (Buffer.byteLength(plan, 'utf8') > PLAN_LIMITS.planMaxBytes) {
    return refuse(`the plan is larger than ${PLAN_LIMITS.planMaxBytes} bytes`);
  }
  const prompts: PlanAllowedPrompt[] = [];
  if (allowedPrompts !== undefined) {
    if (!Array.isArray(allowedPrompts)) {
      return refuse('allowedPrompts is not a list');
    }
    if (allowedPrompts.length > PLAN_LIMITS.allowedPromptsMax) {
      return refuse(`allowedPrompts has ${allowedPrompts.length} entries, and a plan takes at most ${PLAN_LIMITS.allowedPromptsMax}`);
    }
    for (const [index, entry] of allowedPrompts.entries()) {
      const at = `allowedPrompts entry ${index + 1}`;
      if (!isRecord(entry) || typeof entry.tool !== 'string' || typeof entry.prompt !== 'string') {
        return refuse(`${at} is not a tool and a prompt`);
      }
      if (entry.tool.length > PLAN_LIMITS.allowedPromptMaxChars || entry.prompt.length > PLAN_LIMITS.allowedPromptMaxChars) {
        return refuse(`${at} is longer than ${PLAN_LIMITS.allowedPromptMaxChars} characters`);
      }
      prompts.push({ tool: entry.tool, prompt: entry.prompt });
    }
  }
  return { ok: true, plan, allowedPrompts: prompts };
}

function refuseAnswer(reason: InteractionAnswerRefusal, message: string): never {
  throw new InteractionAnswerError(reason, message);
}

type OpenPlan = {
  requested: InteractionRequestedEvent;
  digest: string;
  answer: (result: PermissionResult) => void;
  /** Removes this plan's SDK abort listener; called on every settlement but the abort itself. */
  cleanupAbortListener: () => void;
};

/**
 * Owns the plan one session's model proposed with `ExitPlanMode` and the person at the host has not
 * decided on yet.
 *
 * A plan is settled by nothing but `resolve()`: there is no default, no timer and no policy here, and
 * the permission gate abstains for the plan tool on a plan session, so no automatic permission answer
 * can reach it. An approval answers the CLI with a plain allow -- never an edited input, never a
 * permission update -- and the CLI then leaves plan mode by itself, for the mode the session was created
 * in. Keeping planning denies the call with the terminal's own words and the person's feedback, without
 * an interrupt: the CLI stays in plan mode and the model goes on planning. Each plan ends exactly once,
 * by the first of: the host's decision, the SDK aborting the callback, or `failAll`.
 *
 * One plan waits at a time, and only the main thread's: a subagent's `ExitPlanMode` is denied at once.
 * Events go out through `emit`, the channel the question broker uses: one
 * `interaction_requested` and then exactly one `interaction_resolved` per plan shown, and the pair at
 * once for a plan that could not be shown.
 */
export class PlanBroker implements InteractionPort {
  private readonly open = new Map<string, OpenPlan>();

  /**
   * @param cliMode the CLI's permission mode as the session knows it, `plan` when any account of it
   * says so (a session reads it from `CliModeEvidence`); a call made while it is not `plan` is refused
   * without being shown.
   */
  constructor(
    private readonly emit: (event: ClaudeRuntimeEvent) => void,
    private readonly cliMode: () => string | undefined,
  ) {}

  route(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> | undefined {
    return toolName === PLAN_TOOL ? this.propose(input, options) : undefined;
  }

  /** Whether `interactionId` names a plan waiting here. */
  holds(interactionId: string): boolean {
    return this.open.has(interactionId);
  }

  /** Shows one plan to the host and answers the CLI's callback once it settles. */
  propose(input: unknown, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> {
    if (options.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: PLAN_WITHDRAWN_TEXT });
    }
    if (typeof options.agentID === 'string' && options.agentID !== '') {
      return Promise.resolve({ behavior: 'deny', message: PLAN_SUBAGENT_TEXT });
    }
    if (this.cliMode() !== 'plan') {
      // Nothing to approve out of: the call is answered at once and nobody is shown anything.
      return Promise.resolve({ behavior: 'deny', message: PLAN_OUTSIDE_PLAN_MODE_TEXT });
    }
    const interactionId = randomUUID();
    const toolUseId = typeof options.toolUseID === 'string' ? options.toolUseID : '';
    const parsed = parsePlanInput(input);
    const refusal = !parsed.ok ? parsed.reason : this.open.size > 0 ? 'a plan is already waiting for review' : undefined;
    if (refusal !== undefined || !parsed.ok) {
      const reason = refusal ?? 'the plan could not be read';
      this.emit({ type: 'interaction_requested', interactionId, toolUseId, kind: 'plan_approval', unsupportedReason: reason });
      this.emit({ type: 'interaction_resolved', interactionId, kind: 'plan_approval', outcome: 'host_refused', reason });
      return Promise.resolve({ behavior: 'deny', message: planRefusedText(reason) });
    }
    const digest = planSha256(parsed.plan);
    const requested: InteractionRequestedEvent = {
      type: 'interaction_requested',
      interactionId,
      toolUseId,
      kind: 'plan_approval',
      plan: { plan: parsed.plan, planSha256: digest, allowedPrompts: parsed.allowedPrompts },
    };
    const signal = options.signal;
    return new Promise<PermissionResult>((answer) => {
      const onAbort = (): void => {
        // The CLI gave up on the callback: the plan is gone, and a later decision for this id finds
        // nothing to settle.
        if (this.open.delete(interactionId)) {
          this.emit({ type: 'interaction_resolved', interactionId, kind: 'plan_approval', outcome: 'expired' });
        }
        answer({ behavior: 'deny', message: PLAN_WITHDRAWN_TEXT });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.open.set(interactionId, {
        requested,
        digest,
        answer,
        cleanupAbortListener: () => signal.removeEventListener('abort', onAbort),
      });
      this.emit(requested);
    });
  }

  resolve(interactionId: string, result: InteractionResult): InteractionResolvedEvent {
    const entry = this.open.get(interactionId);
    if (entry === undefined) {
      throw new InteractionNotFoundError(interactionId);
    }
    // Every refusal comes before anything changes, so a refused decision leaves the plan waiting.
    let permission: PermissionResult;
    let resolved: InteractionResolvedEvent;
    if (result.kind === 'plan_approve') {
      if (!PLAN_EXECUTION_MODES.includes(result.mode)) {
        refuseAnswer('plan_mode_unspecified', 'an approval names the mode to run the plan in: manual, auto or bypass');
      }
      if (result.planSha256 !== entry.digest) {
        refuseAnswer('plan_digest_mismatch', 'the approval names a different plan from the one waiting');
      }
      // Exactly a plain allow: the CLI keeps the plan as the model wrote it and restores the session's
      // own mode. An edited input would rewrite the plan file, and a permission update would change
      // the CLI's rules behind the host.
      permission = { behavior: 'allow' };
      resolved = { type: 'interaction_resolved', interactionId, kind: 'plan_approval', outcome: 'approved', modeAfter: result.mode };
    } else if (result.kind === 'plan_keep') {
      const feedback = typeof result.feedback === 'string' ? result.feedback : '';
      if (Buffer.byteLength(feedback, 'utf8') > PLAN_LIMITS.feedbackMaxBytes) {
        refuseAnswer('feedback_too_long', `the feedback is larger than ${PLAN_LIMITS.feedbackMaxBytes} bytes`);
      }
      // No interrupt: the CLI stays in plan mode and the model reads the feedback and goes on planning.
      permission = { behavior: 'deny', message: planRejectText(feedback) };
      resolved = { type: 'interaction_resolved', interactionId, kind: 'plan_approval', outcome: 'kept_planning', feedback };
    } else {
      refuseAnswer('kind_mismatch', 'a plan is approved or kept in planning; a question answer does not fit it');
    }
    this.settle(interactionId, entry, permission, resolved);
    return resolved;
  }

  /** Every plan here is the main thread's (a subagent's is refused), so `spares` never keeps one. */
  failAll(cause: InteractionFailCause, _spares?: (agentId: string) => boolean): void {
    for (const [interactionId, entry] of this.open) {
      this.settle(interactionId, entry, { behavior: 'deny', message: interactionFailText(cause) }, { type: 'interaction_resolved', interactionId, kind: 'plan_approval', outcome: cause });
    }
  }

  pending(): InteractionRequestedEvent[] {
    return [...this.open.values()].map((entry) => ({ ...entry.requested }));
  }

  private settle(interactionId: string, entry: OpenPlan, permission: PermissionResult, resolved: InteractionResolvedEvent): void {
    this.open.delete(interactionId);
    entry.cleanupAbortListener();
    entry.answer(permission);
    this.emit(resolved);
  }
}
