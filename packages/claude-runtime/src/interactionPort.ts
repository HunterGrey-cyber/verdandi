import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { QuestionBroker } from './questionBroker.js';
import { questionsOffered } from './questionOptions.js';
import type { ClaudeRuntimeEvent, ClaudeSessionConfig, InteractionRequestedEvent, InteractionResolvedEvent } from './types.js';

/** Why every interaction still open is being settled at once. */
export type InteractionFailCause = 'interrupted' | 'session_closed' | 'provider_failed';

/** One answered question: the options picked (by index) and any text typed beside or instead of them. */
export type InteractionAnswerInput = { questionIndex: number; optionIndexes: number[]; otherText?: string; notes?: string };

/** What the host answered to one open interaction. */
export type InteractionResult =
  | { kind: 'answers'; answers: InteractionAnswerInput[] }
  | { kind: 'decline'; decline: 'cancel' | 'chat'; soFar?: InteractionAnswerInput[] };

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
  | 'kind_mismatch';

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

/**
 * The port a session routes its interactions through, or `undefined` for a session that does not
 * offer any: only a session opted into structured questions has one, and its port carries those
 * questions to the host and nothing else.
 */
export function createInteractionPort(
  config: Pick<ClaudeSessionConfig, 'policy' | 'clientInteractions'>,
  emit: (event: ClaudeRuntimeEvent) => void,
): InteractionPort | undefined {
  return questionsOffered(config) ? new QuestionBroker(emit) : undefined;
}
