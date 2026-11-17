import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { PlanBroker } from './planBroker.js';
import { planOffered } from './planOptions.js';
import { QuestionBroker } from './questionBroker.js';
import { questionsOffered } from './questionOptions.js';
import type { ClaudeRuntimeEvent, ClaudeSessionConfig, InteractionRequestedEvent, InteractionResolvedEvent, PlanExecutionMode } from './types.js';

/** Why every interaction still open is being settled at once. */
export type InteractionFailCause = 'interrupted' | 'session_closed' | 'provider_failed';

/** One answered question: the options picked (by index) and any text typed beside or instead of them. */
export type InteractionAnswerInput = { questionIndex: number; optionIndexes: number[]; otherText?: string; notes?: string };

/** What the host answered to one open interaction. */
export type InteractionResult =
  | { kind: 'answers'; answers: InteractionAnswerInput[] }
  | { kind: 'decline'; decline: 'cancel' | 'chat'; soFar?: InteractionAnswerInput[] }
  /** Approves a plan into `mode`; `planSha256` must name the plan that is waiting. */
  | { kind: 'plan_approve'; mode: PlanExecutionMode; planSha256: string }
  /** Keeps planning; `feedback` (may be empty) is what the person wants changed. */
  | { kind: 'plan_keep'; feedback: string };

/** The rule an answer broke, as the stable name a refusal carries. */
export type InteractionAnswerRefusal =
  | 'unknown_question_index'
  | 'duplicate_question_index'
  | 'unknown_option_index'
  | 'duplicate_option_index'
  | 'single_select_takes_one'
  | 'notes_not_allowed'
  | 'answer_too_long'
  | 'answers_too_long'
  | 'notes_too_long'
  | 'kind_mismatch'
  | 'plan_digest_mismatch'
  | 'plan_mode_unspecified'
  | 'feedback_too_long';

/** `resolve()` was given an id that names no open interaction of this session: never one, or one
 * already settled. Nothing changed. */
export class InteractionNotFoundError extends Error {
  constructor(readonly interactionId: string) {
    super(`no open interaction ${interactionId} on this session`);
    this.name = 'InteractionNotFoundError';
  }
}

/** `resolve()` refused an answer for an open interaction without settling it: the interaction keeps
 * waiting for an answer that keeps the rules. */
export class InteractionAnswerError extends Error {
  constructor(
    readonly reason: InteractionAnswerRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'InteractionAnswerError';
  }
}

/**
 * The route a tool call takes when its answer has to come from the person at the host rather than
 * from a permission rule: the session offers the call to `route` first, and a session without a port
 * never does.
 */
export interface InteractionPort {
  /** Takes over a tool call this port handles and answers it once the interaction settles; `undefined`
   * when the call is not one this port handles, so the caller goes on as it would without a port. */
  route(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> | undefined;
  /** Settles every open interaction at once, each with the outcome the cause names, except those asked
   * by a subagent `spares` names (an interrupt that leaves background tasks running passes it). */
  failAll(cause: InteractionFailCause, spares?: (agentId: string) => boolean): void;
  /** The interactions still waiting for an answer, oldest first. */
  pending(): InteractionRequestedEvent[];
  /** Settles one open interaction with the host's answer; the event it emitted. Throws
   * `InteractionNotFoundError` for an id that is not open and `InteractionAnswerError` for an answer
   * that breaks a rule; neither changes anything. */
  resolve(interactionId: string, result: InteractionResult): InteractionResolvedEvent;
}

/** The session state a port reads when a call arrives. */
export type InteractionPortContext = {
  /** The CLI's permission mode as the session knows it, `plan` when any account of it says so. A plan
   * port without it treats the CLI as never in plan mode, so every plan is refused there. */
  cliMode?: () => string | undefined;
};

/**
 * One port over a question broker and a plan broker. A call goes to whichever takes it; an answer goes
 * to the broker holding its interaction, which refuses an answer of the other kind (`kind_mismatch`).
 */
class InteractionRouter implements InteractionPort {
  /** When each open interaction was announced, so the pending list of both brokers is oldest first. */
  private readonly order = new Map<string, number>();
  private announced = 0;
  readonly questions: QuestionBroker;
  readonly plans: PlanBroker;

  constructor(emit: (event: ClaudeRuntimeEvent) => void, cliMode: () => string | undefined) {
    const tracked = (event: ClaudeRuntimeEvent): void => {
      if (event.type === 'interaction_requested') {
        this.order.set(event.interactionId, this.announced++);
      } else if (event.type === 'interaction_resolved') {
        this.order.delete(event.interactionId);
      }
      emit(event);
    };
    this.questions = new QuestionBroker(tracked);
    this.plans = new PlanBroker(tracked, cliMode);
  }

  route(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> | undefined {
    return this.questions.route(toolName, input, options) ?? this.plans.route(toolName, input, options);
  }

  failAll(cause: InteractionFailCause, spares?: (agentId: string) => boolean): void {
    this.questions.failAll(cause, spares);
    this.plans.failAll(cause, spares);
  }

  pending(): InteractionRequestedEvent[] {
    const rank = (event: InteractionRequestedEvent): number => this.order.get(event.interactionId) ?? Number.MAX_SAFE_INTEGER;
    return [...this.questions.pending(), ...this.plans.pending()].sort((a, b) => rank(a) - rank(b));
  }

  resolve(interactionId: string, result: InteractionResult): InteractionResolvedEvent {
    return this.plans.holds(interactionId) ? this.plans.resolve(interactionId, result) : this.questions.resolve(interactionId, result);
  }
}

/**
 * The port a session routes its interactions through, or `undefined` for a session that does not
 * offer any. A session opted into structured questions carries them to the host; one opted into plan
 * mode carries the model's `ExitPlanMode` plans; one opted into both gets a single port for both.
 */
export function createInteractionPort(
  config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>,
  emit: (event: ClaudeRuntimeEvent) => void,
  context: InteractionPortContext = {},
): InteractionPort | undefined {
  const questions = questionsOffered(config);
  const plans = planOffered(config);
  const cliMode = context.cliMode ?? (() => undefined);
  if (questions && plans) {
    return new InteractionRouter(emit, cliMode);
  }
  if (plans) {
    return new PlanBroker(emit, cliMode);
  }
  return questions ? new QuestionBroker(emit) : undefined;
}
