import { randomUUID } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  InteractionAnswerError,
  InteractionNotFoundError,
  type InteractionAnswerInput,
  type InteractionFailCause,
  type InteractionPort,
  type InteractionResult,
} from './interactionPort.js';
import { HOST_SETTLEMENT_MESSAGES } from './permissionBroker.js';
import type { ClaudeRuntimeEvent, InteractionQuestion, InteractionQuestionOption, InteractionRequestedEvent, InteractionResolvedEvent, ShownAnswer } from './types.js';

/** The model's question tool, the only call a question broker takes. */
export const QUESTION_TOOL = 'AskUserQuestion';

/**
 * The limits a question set is held to before the host is shown it, and an answer before the model is.
 * Lengths are UTF-16 code units, as the CLI counts them. A question over any of them is refused whole,
 * never cut: a shortened question would ask the person something the model did not.
 */
export const QUESTION_LIMITS = Object.freeze({
  /** Questions per set, and options per question: the CLI's own schema. */
  minQuestions: 1,
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 4,
  questionChars: 4000,
  headerChars: 256,
  labelChars: 1000,
  descriptionChars: 4000,
  previewChars: 16384,
  /** The whole parsed set, serialized as JSON, in UTF-8 bytes. */
  setBytes: 256 * 1024,
  /** Questions waiting for an answer at once on one session; one more is refused. */
  liveInteractions: 4,
  /** One question's answer as it is sent to the model. */
  answerChars: 32768,
  /** Every answer of one set together, as sent. */
  answersChars: 32768,
  notesChars: 8192,
});

/**
 * The CLI's own text for a tool use the user rejected, which its terminal sends when the user presses
 * Esc on a question. Copied from Claude Code 2.1.302, where it is the constant the CLI substitutes for
 * a rejection without a message; the model reads it as "stop and wait".
 */
export const CLI_REJECT_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * The opening of the CLI's own feedback when the user picks "Chat about this", up to the list of the
 * questions (Claude Code 2.1.302). The four-space indents are the CLI's: its template literal carries
 * them into the text the model reads.
 */
export const CLARIFY_TEXT_OPENING =
  'The user wants to clarify these questions.\n' +
  '    This means they may have additional information, context or questions for you.\n' +
  '    Take their response into account and then reformulate the questions if appropriate.\n' +
  '    Start by asking them what they would like to clarify.\n' +
  '\n' +
  '    Questions asked:\n';

/** What the model reads when the CLI gave up waiting on a question (the SDK aborted the callback). */
export const QUESTION_WITHDRAWN_TEXT = 'The host denied this question because the CLI withdrew it.';

/** What the model reads when a session that does not offer questions is asked one anyway. */
export const QUESTION_NOT_OFFERED_TEXT = 'AskUserQuestion is not offered on this session';

/** What the model reads when a question could not be offered to the person, so it can ask in prose. */
export function questionRefusedText(reason: string): string {
  return `This client could not show the question: ${reason}. Ask in plain text instead.`;
}

/** How each way of failing every open question at once reads to the model: the text a pending
 * permission request gets for the same cause, so the two cannot drift. Read when it is needed, not at
 * load: the permission broker's module imports this one. */
function failText(cause: InteractionFailCause): string {
  switch (cause) {
    case 'interrupted':
      return HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt;
    case 'session_closed':
      return HOST_SETTLEMENT_MESSAGES.cancelled_by_session_close;
    case 'provider_failed':
      return HOST_SETTLEMENT_MESSAGES.provider_failed;
  }
}

/** The keys a question tool input may carry. `annotations` is the CLI's own output slot and is
 * replaced by the answer; `answers` is accepted only to refuse it by name. */
const INPUT_KEYS = new Set(['questions', 'metadata', 'annotations', 'answers']);
const QUESTION_KEYS = new Set(['question', 'header', 'options', 'multiSelect']);
const OPTION_KEYS = new Set(['label', 'description', 'preview']);

type Parsed = { ok: true; questions: InteractionQuestion[] } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key name the model wrote, quoted and short enough for a reason line. */
function quotedKey(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
}

function extraKey(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

/**
 * Reads a question tool input against the baseline schema the host can draw: `questions[]` of
 * `{question, header, options[{label, description, preview?}], multiSelect}`, an optional `metadata`
 * kept as it is, and an `annotations` that is ignored here and replaced in the answer. Anything else,
 * a value of the wrong type, a length over `QUESTION_LIMITS`, a repeated question or label (answers
 * are keyed by them) or answers already filled in refuses the whole question with a reason a model can
 * act on. An absent `multiSelect` is the CLI's default, a single choice.
 */
export function parseQuestionInput(input: unknown): Parsed {
  const refuse = (reason: string): Parsed => ({ ok: false, reason });
  if (!isRecord(input)) {
    return refuse('the tool input is not an object');
  }
  const stray = extraKey(input, INPUT_KEYS);
  if (stray !== undefined) {
    return refuse(`the tool input has a field this client does not show (${quotedKey(stray)})`);
  }
  if (input.answers !== undefined) {
    return refuse('the question arrived with answers already filled in');
  }
  const raw = input.questions;
  if (!Array.isArray(raw)) {
    return refuse('the tool input has no list of questions');
  }
  if (raw.length < QUESTION_LIMITS.minQuestions || raw.length > QUESTION_LIMITS.maxQuestions) {
    return refuse(`it has ${raw.length} questions, and a set takes ${QUESTION_LIMITS.minQuestions} to ${QUESTION_LIMITS.maxQuestions}`);
  }
  const questions: InteractionQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `question ${index + 1}`;
    if (!isRecord(entry)) {
      return refuse(`${at} is not an object`);
    }
    const strayInQuestion = extraKey(entry, QUESTION_KEYS);
    if (strayInQuestion !== undefined) {
      return refuse(`${at} has a field this client does not show (${quotedKey(strayInQuestion)})`);
    }
    const { question, header, options, multiSelect } = entry;
    if (typeof question !== 'string') {
      return refuse(`${at} has no question text`);
    }
    if (question.length > QUESTION_LIMITS.questionChars) {
      return refuse(`${at} is longer than ${QUESTION_LIMITS.questionChars} characters`);
    }
    if (seenQuestions.has(question)) {
      return refuse(`${at} repeats the text of an earlier question`);
    }
    seenQuestions.add(question);
    if (typeof header !== 'string') {
      return refuse(`${at} has no header`);
    }
    if (header.length > QUESTION_LIMITS.headerChars) {
      return refuse(`the header of ${at} is longer than ${QUESTION_LIMITS.headerChars} characters`);
    }
    if (multiSelect !== undefined && typeof multiSelect !== 'boolean') {
      return refuse(`${at} has a multiSelect that is not true or false`);
    }
    if (!Array.isArray(options)) {
      return refuse(`${at} has no list of options`);
    }
    if (options.length < QUESTION_LIMITS.minOptions || options.length > QUESTION_LIMITS.maxOptions) {
      return refuse(`${at} has ${options.length} options, and a question takes ${QUESTION_LIMITS.minOptions} to ${QUESTION_LIMITS.maxOptions}`);
    }
    const parsedOptions: InteractionQuestionOption[] = [];
    const seenLabels = new Set<string>();
    for (const [optionIndex, option] of options.entries()) {
      const optionAt = `option ${optionIndex + 1} of ${at}`;
      if (!isRecord(option)) {
        return refuse(`${optionAt} is not an object`);
      }
      const strayInOption = extraKey(option, OPTION_KEYS);
      if (strayInOption !== undefined) {
        return refuse(`${optionAt} has a field this client does not show (${quotedKey(strayInOption)})`);
      }
      const { label, description, preview } = option;
      if (typeof label !== 'string') {
        return refuse(`${optionAt} has no label`);
      }
      if (label.length > QUESTION_LIMITS.labelChars) {
        return refuse(`the label of ${optionAt} is longer than ${QUESTION_LIMITS.labelChars} characters`);
      }
      if (seenLabels.has(label)) {
        return refuse(`${optionAt} repeats the label of an earlier option`);
      }
      seenLabels.add(label);
      if (typeof description !== 'string') {
        return refuse(`${optionAt} has no description`);
      }
      if (description.length > QUESTION_LIMITS.descriptionChars) {
        return refuse(`the description of ${optionAt} is longer than ${QUESTION_LIMITS.descriptionChars} characters`);
      }
      if (preview !== undefined && typeof preview !== 'string') {
        return refuse(`the preview of ${optionAt} is not text`);
      }
      if (typeof preview === 'string' && preview.length > QUESTION_LIMITS.previewChars) {
        return refuse(`the preview of ${optionAt} is longer than ${QUESTION_LIMITS.previewChars} characters`);
      }
      parsedOptions.push({ label, description, ...(preview === undefined ? {} : { preview }) });
    }
    questions.push({ question, header, multiSelect: multiSelect === true, options: parsedOptions });
  }
  if (Buffer.byteLength(JSON.stringify(questions), 'utf8') > QUESTION_LIMITS.setBytes) {
    return refuse(`the question set is larger than ${QUESTION_LIMITS.setBytes} bytes`);
  }
  return { ok: true, questions };
}

/**
 * A question whose answer may carry notes and a preview annotation: single choice, with a preview on
 * at least one option. The CLI's terminal offers notes on exactly these.
 */
function takesNotes(question: InteractionQuestion): boolean {
  return !question.multiSelect && question.options.some((option) => option.preview !== undefined);
}

/**
 * One multi-select item as it goes into the joined answer: quoted as a JSON string when it contains
 * the separator or a double quote, so the CLI's split on `", "` gets the items back whole.
 */
function joinItem(item: string): string {
  return item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item;
}

/** One question's answer as built for the model. */
type BuiltAnswer = { questionIndex: number; answer: string; notes?: string; preview?: string };

function refuseAnswer(reason: ConstructorParameters<typeof InteractionAnswerError>[0], message: string): never {
  throw new InteractionAnswerError(reason, message);
}

/**
 * Checks the host's answers against the question set and builds each answered question's text. Throws
 * `InteractionAnswerError` for the first rule broken; an answer with no option and no text is left out
 * (the question was not answered). The result is in question order.
 */
function buildAnswers(questions: InteractionQuestion[], answers: InteractionAnswerInput[]): BuiltAnswer[] {
  const built: BuiltAnswer[] = [];
  const seen = new Set<number>();
  let total = 0;
  for (const answer of answers) {
    const index = answer.questionIndex;
    if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
      refuseAnswer('unknown_question_index', `there is no question ${index} in this set of ${questions.length}`);
    }
    if (seen.has(index)) {
      refuseAnswer('duplicate_question_index', `question ${index} is answered twice`);
    }
    seen.add(index);
    const question = questions[index];
    const picked = new Set<number>();
    for (const option of answer.optionIndexes) {
      if (!Number.isInteger(option) || option < 0 || option >= question.options.length) {
        refuseAnswer('unknown_option_index', `question ${index} has no option ${option}`);
      }
      if (picked.has(option)) {
        refuseAnswer('duplicate_option_index', `question ${index} picks option ${option} twice`);
      }
      picked.add(option);
    }
    const text = answer.otherText ?? '';
    if (!question.multiSelect && picked.size + (text === '' ? 0 : 1) > 1) {
      refuseAnswer('single_select_takes_one', `question ${index} takes one choice: an option or typed text`);
    }
    const notes = answer.notes ?? '';
    if (notes !== '' && !takesNotes(question)) {
      refuseAnswer('notes_not_allowed', `question ${index} takes no notes`);
    }
    if (notes.length > QUESTION_LIMITS.notesChars) {
      refuseAnswer('notes_too_long', `the notes on question ${index} are longer than ${QUESTION_LIMITS.notesChars} characters`);
    }
    if (picked.size === 0 && text === '') {
      continue;
    }
    const labels = [...picked].sort((a, b) => a - b).map((option) => question.options[option].label);
    const value = question.multiSelect ? [...labels, ...(text === '' ? [] : [text])].map(joinItem).join(', ') : (labels[0] ?? text);
    if (value.length > QUESTION_LIMITS.answerChars) {
      refuseAnswer('answer_too_long', `the answer to question ${index} is longer than ${QUESTION_LIMITS.answerChars} characters`);
    }
    total += value.length;
    const trimmedNotes = notes.trim();
    const preview = takesNotes(question) && labels.length === 1 ? question.options[[...picked][0]].preview : undefined;
    built.push({
      questionIndex: index,
      answer: value,
      ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }),
      ...(preview === undefined || preview === '' ? {} : { preview }),
    });
  }
  if (total > QUESTION_LIMITS.answersChars) {
    refuseAnswer('answers_too_long', `the answers together are longer than ${QUESTION_LIMITS.answersChars} characters`);
  }
  return built.sort((a, b) => a.questionIndex - b.questionIndex);
}

function shown(built: BuiltAnswer[]): ShownAnswer[] {
  return built.map(({ questionIndex, answer, notes }) => ({ questionIndex, answer, ...(notes === undefined ? {} : { notes }) }));
}

/**
 * The CLI's "Chat about this" feedback: its opening, then every question of the set with the answer
 * given so far or "(No answer provided)", and the notes when there are any.
 */
export function clarifyText(questions: InteractionQuestion[], soFar: ShownAnswer[]): string {
  const byIndex = new Map(soFar.map((answer) => [answer.questionIndex, answer]));
  const lines = questions.map((question, index) => {
    const answer = byIndex.get(index);
    const parts = [`- "${question.question}"`, answer === undefined ? '  (No answer provided)' : `  Answer: ${answer.answer}`];
    if (answer?.notes !== undefined) {
      parts.push(`  User notes: ${answer.notes}`);
    }
    return parts.join('\n');
  });
  return CLARIFY_TEXT_OPENING + lines.join('\n');
}

/**
 * Stores `value` under a question's text as an own, enumerable property. The text is the model's
 * own words, so it can be `__proto__`: a plain assignment would hit the inherited setter, change the
 * map's prototype and drop the answer from what the CLI receives.
 */
function keyedByQuestion<T>(map: Record<string, T>, question: string, value: T): void {
  Object.defineProperty(map, question, { value, enumerable: true, writable: true, configurable: true });
}

type OpenQuestion = {
  requested: InteractionRequestedEvent;
  /** The tool input exactly as the CLI sent it; the answer is built over it. */
  input: Record<string, unknown>;
  questions: InteractionQuestion[];
  answer: (result: PermissionResult) => void;
  /** The subagent that asked, when the CLI named one; absent for the main thread. */
  agentId?: string;
  /** Removes this question's SDK abort listener; called on every settlement but the abort itself. */
  cleanupAbortListener: () => void;
};

/**
 * Owns the questions one session's model has asked and the person at the host has not answered yet.
 *
 * A question is never answered by anything but `resolve()`: there is no default, no timer and no
 * policy here, and the permission gate never sees the call (it abstains for the question tool on a
 * session that offers questions), so no automatic permission answer can reach it. It ends exactly
 * once, by the first of: the host's answer or decline, the SDK aborting the callback, or `failAll`.
 *
 * Events go out through `emit`, the same out-of-band channel the permission broker's use: one
 * `interaction_requested` and then exactly one `interaction_resolved` per question shown, and the
 * pair at once for a question that could not be shown.
 */
export class QuestionBroker implements InteractionPort {
  private readonly open = new Map<string, OpenQuestion>();

  constructor(private readonly emit: (event: ClaudeRuntimeEvent) => void) {}

  route(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> | undefined {
    return toolName === QUESTION_TOOL ? this.ask(input, options) : undefined;
  }

  /** Shows one question to the host and answers the CLI's callback once it settles. */
  ask(input: unknown, options: { signal: AbortSignal; toolUseID?: string; agentID?: string }): Promise<PermissionResult> {
    if (options.signal.aborted) {
      // The CLI stopped waiting before the question could be registered: nothing was shown, so
      // nothing is announced.
      return Promise.resolve({ behavior: 'deny', message: QUESTION_WITHDRAWN_TEXT });
    }
    const interactionId = randomUUID();
    // An empty id rather than whatever the control request carried keeps the event encodable.
    const toolUseId = typeof options.toolUseID === 'string' ? options.toolUseID : '';
    const parsed = parseQuestionInput(input);
    const refusal = !parsed.ok
      ? parsed.reason
      : this.open.size >= QUESTION_LIMITS.liveInteractions
        ? `${QUESTION_LIMITS.liveInteractions} questions are already waiting for an answer on this session`
        : undefined;
    if (refusal !== undefined || !parsed.ok) {
      const reason = refusal ?? 'the question could not be read';
      this.emit({ type: 'interaction_requested', interactionId, toolUseId, unsupportedReason: reason });
      this.emit({ type: 'interaction_resolved', interactionId, outcome: 'host_refused', reason });
      return Promise.resolve({ behavior: 'deny', message: questionRefusedText(reason) });
    }
    const requested: InteractionRequestedEvent = { type: 'interaction_requested', interactionId, toolUseId, questions: parsed.questions };
    const signal = options.signal;
    return new Promise<PermissionResult>((answer) => {
      const onAbort = (): void => {
        // The CLI gave up on the callback: the question is gone, and a later answer for this id
        // finds nothing to settle.
        if (this.open.delete(interactionId)) {
          this.emit({ type: 'interaction_resolved', interactionId, outcome: 'expired' });
        }
        answer({ behavior: 'deny', message: QUESTION_WITHDRAWN_TEXT });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.open.set(interactionId, {
        requested,
        input: input as Record<string, unknown>,
        questions: parsed.questions,
        answer,
        ...(typeof options.agentID === 'string' && options.agentID !== '' ? { agentId: options.agentID } : {}),
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
    // Everything that can refuse runs before anything changes, so a refused answer leaves the
    // question waiting exactly as it was.
    let permission: PermissionResult;
    let resolved: InteractionResolvedEvent;
    if (result.kind === 'answers') {
      const built = buildAnswers(entry.questions, result.answers);
      const answers: Record<string, string> = {};
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const answer of built) {
        const question = entry.questions[answer.questionIndex].question;
        keyedByQuestion(answers, question, answer.answer);
        if (answer.preview !== undefined || answer.notes !== undefined) {
          keyedByQuestion(annotations, question, {
            ...(answer.preview === undefined ? {} : { preview: answer.preview }),
            ...(answer.notes === undefined ? {} : { notes: answer.notes }),
          });
        }
      }
      permission = { behavior: 'allow', updatedInput: { ...entry.input, answers, annotations } };
      resolved = { type: 'interaction_resolved', interactionId, outcome: 'answered', answers: shown(built) };
    } else if (result.decline === 'cancel') {
      if ((result.soFar ?? []).length > 0) {
        refuseAnswer('kind_mismatch', 'a cancel carries no answers; only a request to chat does');
      }
      permission = { behavior: 'deny', message: CLI_REJECT_TEXT, interrupt: true };
      resolved = { type: 'interaction_resolved', interactionId, outcome: 'declined' };
    } else {
      const soFar = shown(buildAnswers(entry.questions, result.soFar ?? []));
      permission = { behavior: 'deny', message: clarifyText(entry.questions, soFar) };
      resolved = { type: 'interaction_resolved', interactionId, outcome: 'chat_requested', answers: soFar };
    }
    this.settle(interactionId, entry, permission, resolved);
    return resolved;
  }

  failAll(cause: InteractionFailCause, spares?: (agentId: string) => boolean): void {
    for (const [interactionId, entry] of this.open) {
      if (entry.agentId !== undefined && spares?.(entry.agentId) === true) {
        continue;
      }
      this.settle(interactionId, entry, { behavior: 'deny', message: failText(cause) }, { type: 'interaction_resolved', interactionId, outcome: cause });
    }
  }

  pending(): InteractionRequestedEvent[] {
    return [...this.open.values()].map((entry) => ({ ...entry.requested }));
  }

  private settle(interactionId: string, entry: OpenQuestion, permission: PermissionResult, resolved: InteractionResolvedEvent): void {
    this.open.delete(interactionId);
    entry.cleanupAbortListener();
    entry.answer(permission);
    this.emit(resolved);
  }
}
