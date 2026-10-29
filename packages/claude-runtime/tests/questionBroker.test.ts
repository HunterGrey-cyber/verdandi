import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import type { HookCallback, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';
import {
  CLARIFY_TEXT_OPENING,
  CLI_REJECT_TEXT,
  QUESTION_LIMITS,
  QUESTION_NOT_OFFERED_TEXT,
  QUESTION_WITHDRAWN_TEXT,
  QuestionBroker,
  questionRefusedText,
} from '../src/questionBroker.js';
import { InteractionAnswerError, InteractionNotFoundError, createInteractionPort, type InteractionAnswerInput } from '../src/interactionPort.js';
import { HOST_SETTLEMENT_MESSAGES, PermissionBroker } from '../src/permissionBroker.js';
import { createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig, InteractionQuestion, InteractionRequestedEvent } from '../src/types.js';

/**
 * The question path: a model's AskUserQuestion becomes an `interaction_requested` the host answers through
 * `resolve()`, and the CLI's callback gets the terminal's own result shape. Nothing but that answer, a
 * decline, the CLI withdrawing the call or the session settling everything at once ends a question.
 */

const OFFERING: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true };
const QUESTIONS = { questions: true };

type Opt = { label: string; description: string; preview?: string };
type Q = { question: string; header: string; multiSelect: boolean; options: Opt[] };

const opt = (label: string, preview?: string): Opt => ({ label, description: `about ${label}`, ...(preview === undefined ? {} : { preview }) });
const q = (question: string, options: Opt[], multiSelect = false): Q => ({ question, header: 'Pick', multiSelect, options });
const SINGLE = q('Which database?', [opt('Postgres'), opt('SQLite'), opt('Redis, not Memcached')]);
const MULTI = q('Which features?', [opt('Auth'), opt('say "hi"'), opt('Search'), opt('Billing')], true);
const PREVIEWED = q('Which layout?', [opt('Grid', '# Grid\n\n| a | b |'), opt('List', ''), opt('Cards')]);

function harness() {
  const events: ClaudeRuntimeEvent[] = [];
  const broker = new QuestionBroker((event) => events.push(event));
  const ask = (input: unknown, signal: AbortSignal = new AbortController().signal, toolUseID = 'toolu_q') => broker.ask(input, { signal, toolUseID });
  const requested = () => events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  const resolved = () => events.filter((e): e is Extract<ClaudeRuntimeEvent, { type: 'interaction_resolved' }> => e.type === 'interaction_resolved');
  return { broker, events, ask, requested, resolved };
}

/** Whether a promise has settled by the time pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

function refusal(run: () => unknown): InteractionAnswerError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof InteractionAnswerError, `expected an InteractionAnswerError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a refusal');
}

// ---- The texts the model reads -------------------------------------------------------------------------------------

test('the CLI texts are Claude Code 2.1.302\'s own: the rejection the terminal sends on Esc and the clarify opening', () => {
  assert.equal(
    CLI_REJECT_TEXT,
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  );
  assert.equal(
    CLARIFY_TEXT_OPENING,
    'The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n',
  );
  assert.equal(questionRefusedText('why'), 'This client could not show the question: why. Ask in plain text instead.');
  assert.equal(QUESTION_WITHDRAWN_TEXT, 'The host denied this question because the CLI withdrew it.');
  assert.equal(QUESTION_NOT_OFFERED_TEXT, 'AskUserQuestion is not offered on this session');
});

// ---- Asking ---------------------------------------------------------------------------------------------------------

test('a question is announced with exactly its parsed set, its tool use id and a fresh id, and waits', async () => {
  const { broker, ask, events } = harness();
  const input = { questions: [SINGLE, PREVIEWED], metadata: { source: 'remember' } };
  const answer = ask(input);
  assert.equal(events.length, 1);
  const [event] = events as InteractionRequestedEvent[];
  assert.match(event.interactionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(event, {
    type: 'interaction_requested',
    interactionId: event.interactionId,
    toolUseId: 'toolu_q',
    questions: [
      { question: 'Which database?', header: 'Pick', multiSelect: false, options: [{ label: 'Postgres', description: 'about Postgres' }, { label: 'SQLite', description: 'about SQLite' }, { label: 'Redis, not Memcached', description: 'about Redis, not Memcached' }] },
      { question: 'Which layout?', header: 'Pick', multiSelect: false, options: [{ label: 'Grid', description: 'about Grid', preview: '# Grid\n\n| a | b |' }, { label: 'List', description: 'about List', preview: '' }, { label: 'Cards', description: 'about Cards' }] },
    ],
  });
  assert.deepEqual(broker.pending(), [event]);
  assert.equal(await settled(answer), false, 'a question waits for the host; nothing answers it on its own');
  const second = ask({ questions: [SINGLE] });
  assert.notEqual((broker.pending()[1] as InteractionRequestedEvent).interactionId, event.interactionId);
  broker.failAll('session_closed');
  await Promise.all([answer, second]);
});

test('a missing multiSelect reads as single choice, a missing tool use id as empty, and the input\'s own annotations are replaced', async () => {
  const { broker, ask, requested } = harness();
  const { multiSelect: _, ...noMulti } = SINGLE;
  const input = { questions: [noMulti], annotations: { 'Which database?': { notes: 'planted' } } };
  const answer = broker.ask(input, { signal: new AbortController().signal });
  const [event] = requested();
  assert.equal(event.toolUseId, '');
  assert.equal(event.questions![0].multiSelect, false);
  broker.resolve(event.interactionId, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [0] }] });
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { ...input, answers: { 'Which database?': 'Postgres' }, annotations: {} } });
  void ask;
});

// ---- What is refused before anything is shown ----------------------------------------------------------------------

/** A question set with every item at its limit except as `edit` changes it. */
function atLimits(): Q[] {
  const L = QUESTION_LIMITS;
  return [q('q'.repeat(L.questionChars), [{ label: 'l'.repeat(L.labelChars), description: 'd'.repeat(L.descriptionChars) }, opt('two')])].map((question) => ({
    ...question,
    header: 'h'.repeat(L.headerChars),
  }));
}

const BOUND_ROWS: Array<[name: string, atLimit: () => unknown, over: () => unknown, reason: RegExp]> = [
  ['questions per set', () => ({ questions: [1, 2, 3, 4].map((n) => q(`Q${n}?`, [opt('a'), opt('b')])) }), () => ({ questions: [1, 2, 3, 4, 5].map((n) => q(`Q${n}?`, [opt('a'), opt('b')])) }), /it has 5 questions, and a set takes 1 to 4/],
  ['no question at all', () => ({ questions: [q('Q?', [opt('a'), opt('b')])] }), () => ({ questions: [] }), /it has 0 questions/],
  ['options per question, most', () => ({ questions: [q('Q?', [opt('a'), opt('b'), opt('c'), opt('d')])] }), () => ({ questions: [q('Q?', [opt('a'), opt('b'), opt('c'), opt('d'), opt('e')])] }), /question 1 has 5 options, and a question takes 2 to 4/],
  ['options per question, fewest', () => ({ questions: [q('Q?', [opt('a'), opt('b')])] }), () => ({ questions: [q('Q?', [opt('a')])] }), /question 1 has 1 options/],
  ['question text', () => ({ questions: atLimits() }), () => ({ questions: [{ ...atLimits()[0], question: 'q'.repeat(QUESTION_LIMITS.questionChars + 1) }] }), /question 1 is longer than 4000 characters/],
  ['question text in UTF-16 units', () => ({ questions: [q('😀'.repeat(2000), [opt('a'), opt('b')])] }), () => ({ questions: [q('😀'.repeat(2000) + 'x', [opt('a'), opt('b')])] }), /longer than 4000/],
  ['header', () => ({ questions: atLimits() }), () => ({ questions: [{ ...atLimits()[0], header: 'h'.repeat(QUESTION_LIMITS.headerChars + 1) }] }), /the header of question 1 is longer than 256/],
  ['label', () => ({ questions: atLimits() }), () => ({ questions: [q('Q?', [{ label: 'l'.repeat(QUESTION_LIMITS.labelChars + 1), description: 'd' }, opt('b')])] }), /the label of option 1 of question 1 is longer than 1000/],
  ['description', () => ({ questions: atLimits() }), () => ({ questions: [q('Q?', [opt('a'), { label: 'b', description: 'd'.repeat(QUESTION_LIMITS.descriptionChars + 1) }])] }), /the description of option 2 of question 1 is longer than 4000/],
  ['preview', () => ({ questions: [q('Q?', [opt('a', 'p'.repeat(QUESTION_LIMITS.previewChars)), opt('b')])] }), () => ({ questions: [q('Q?', [opt('a', 'p'.repeat(QUESTION_LIMITS.previewChars + 1)), opt('b')])] }), /the preview of option 1 of question 1 is longer than 16384/],
  ['whole set in UTF-8 bytes', () => ({ questions: setOfBytes(QUESTION_LIMITS.setBytes) }), () => ({ questions: setOfBytes(QUESTION_LIMITS.setBytes + 1) }), /the question set is larger than 262144 bytes/],
];

/** Four questions of four previewed options whose JSON is exactly `bytes` long in UTF-8, each preview
 * within its own limit. Built in the parsed key order, so the parsed set serializes the same. */
function setOfBytes(bytes: number): Q[] {
  const questions = [1, 2, 3, 4].map((n) => q(`Q${n}?`, [1, 2, 3, 4].map((m) => opt(`o${m}`, 'p'.repeat(16000)))));
  let missing = bytes - Buffer.byteLength(JSON.stringify(questions), 'utf8');
  assert.ok(missing >= 0, 'the base set is already too large');
  for (const question of questions) {
    for (const option of question.options) {
      const add = Math.min(missing, QUESTION_LIMITS.previewChars - option.preview!.length);
      option.preview += 'p'.repeat(add);
      missing -= add;
    }
  }
  assert.equal(missing, 0, 'the previews could not reach the size');
  assert.equal(Buffer.byteLength(JSON.stringify(questions), 'utf8'), bytes);
  return questions;
}

for (const [name, atLimit, over, reason] of BOUND_ROWS) {
  test(`bound: ${name} -- shown at the limit, refused whole over it`, async () => {
    const shown = harness();
    const pending = shown.ask(atLimit());
    assert.equal(shown.broker.pending().length, 1, 'at the limit the question is shown');
    assert.equal(shown.resolved().length, 0);
    shown.broker.failAll('session_closed');
    await pending;

    const refused = harness();
    const result = await refused.ask(over());
    const [requested] = refused.requested();
    assert.equal(requested.questions, undefined, 'a refused question carries no payload');
    assert.match(requested.unsupportedReason!, reason);
    assert.deepEqual(refused.resolved(), [{ type: 'interaction_resolved', interactionId: requested.interactionId, outcome: 'host_refused', reason: requested.unsupportedReason }]);
    assert.deepEqual(result, { behavior: 'deny', message: questionRefusedText(requested.unsupportedReason!) });
    assert.deepEqual(refused.broker.pending(), []);
  });
}

const REFUSED_SHAPES: Array<[name: string, input: unknown, reason: RegExp]> = [
  ['a repeated question text', { questions: [SINGLE, { ...MULTI, question: SINGLE.question }] }, /question 2 repeats the text of an earlier question/],
  ['a repeated label within a question', { questions: [q('Q?', [opt('Same'), opt('Same')])] }, /option 2 of question 1 repeats the label/],
  ['an extra key on the input', { questions: [SINGLE], title: 'Setup' }, /the tool input has a field this client does not show \("title"\)/],
  ['an extra key on a question', { questions: [{ ...SINGLE, kind: 'rank' }] }, /question 1 has a field this client does not show \("kind"\)/],
  ['an extra key on an option', { questions: [q('Q?', [{ ...opt('a'), followUp: 'more' } as Opt, opt('b')])] }, /option 1 of question 1 has a field this client does not show \("followUp"\)/],
  ['answers already filled in', { questions: [SINGLE], answers: { 'Which database?': 'Postgres' } }, /the question arrived with answers already filled in/],
  ['an input that is not an object', 'questions', /the tool input is not an object/],
  ['questions that are not a list', { questions: { 0: SINGLE } }, /no list of questions/],
  ['a multiSelect that is not a boolean', { questions: [{ ...SINGLE, multiSelect: 'yes' }] }, /multiSelect that is not true or false/],
  ['a preview that is not text', { questions: [q('Q?', [{ ...opt('a'), preview: 3 } as unknown as Opt, opt('b')])] }, /the preview of option 1 of question 1 is not text/],
  ['an option with no description', { questions: [q('Q?', [{ label: 'a' } as Opt, opt('b')])] }, /option 1 of question 1 has no description/],
];

for (const [name, input, reason] of REFUSED_SHAPES) {
  test(`refused: ${name}`, async () => {
    const { ask, requested, resolved, broker } = harness();
    const result = await ask(input);
    const [event] = requested();
    assert.match(event.unsupportedReason!, reason);
    assert.equal(resolved()[0].outcome, 'host_refused');
    assert.equal((result as { behavior: string }).behavior, 'deny');
    assert.deepEqual(broker.pending(), []);
  });
}

test('the same label in two different questions is fine', async () => {
  const { ask, broker } = harness();
  const answer = ask({ questions: [q('One?', [opt('Yes'), opt('No')]), q('Two?', [opt('Yes'), opt('No')])] });
  assert.equal(broker.pending().length, 1);
  broker.failAll('session_closed');
  await answer;
});

test('a fifth question waiting at once is refused, and is shown again once one of the four has ended', async () => {
  const { ask, broker, requested, resolved } = harness();
  const four = [1, 2, 3, 4].map((n) => ask({ questions: [q(`Q${n}?`, [opt('a'), opt('b')])] }));
  assert.equal(broker.pending().length, 4);
  const fifth = await ask({ questions: [q('Q5?', [opt('a'), opt('b')])] });
  assert.deepEqual(fifth, { behavior: 'deny', message: questionRefusedText('4 questions are already waiting for an answer on this session') });
  assert.equal(resolved().at(-1)!.outcome, 'host_refused');
  broker.resolve(requested()[0].interactionId, { kind: 'decline', decline: 'cancel' });
  const sixth = ask({ questions: [q('Q6?', [opt('a'), opt('b')])] });
  assert.equal(broker.pending().length, 4);
  broker.failAll('session_closed');
  await Promise.all([...four, sixth]);
});

// ---- Answers ---------------------------------------------------------------------------------------------------------

async function answerWith(questions: Q[], answers: InteractionAnswerInput[], extra: Record<string, unknown> = {}) {
  const { broker, ask, requested } = harness();
  const input = { questions, ...extra };
  const pending = ask(input);
  const { interactionId } = requested()[0];
  const event = broker.resolve(interactionId, { kind: 'answers', answers });
  return { result: (await pending) as Extract<PermissionResult, { behavior: 'allow' }>, event, input };
}

test('single select: the picked label, or the typed text', async () => {
  const picked = await answerWith([SINGLE], [{ questionIndex: 0, optionIndexes: [1] }]);
  assert.deepEqual(picked.result, { behavior: 'allow', updatedInput: { questions: [SINGLE], answers: { 'Which database?': 'SQLite' }, annotations: {} } });
  assert.deepEqual(picked.event, { type: 'interaction_resolved', interactionId: picked.event.interactionId, outcome: 'answered', answers: [{ questionIndex: 0, answer: 'SQLite' }] });
  const typed = await answerWith([SINGLE], [{ questionIndex: 0, optionIndexes: [], otherText: 'MariaDB' }]);
  assert.deepEqual(typed.result.updatedInput!.answers, { 'Which database?': 'MariaDB' });
  // A single-select label goes back exactly as the model wrote it, separator and all: only a
  // multi-select answer is a list that needs quoting.
  const separator = await answerWith([SINGLE], [{ questionIndex: 0, optionIndexes: [2] }]);
  assert.deepEqual(separator.result.updatedInput!.answers, { 'Which database?': 'Redis, not Memcached' });
});

test('multi select: picked labels in option order, then the typed text, each quoted when it holds ", " or a double quote', async () => {
  const { result, event } = await answerWith([MULTI], [{ questionIndex: 0, optionIndexes: [3, 1, 0], otherText: 'Redis, not Memcached' }]);
  const expected = 'Auth, "say \\"hi\\"", Billing, "Redis, not Memcached"';
  assert.deepEqual(result.updatedInput!.answers, { 'Which features?': expected });
  assert.deepEqual(event.answers, [{ questionIndex: 0, answer: expected }]);
  const plain = await answerWith([MULTI], [{ questionIndex: 0, optionIndexes: [2] }]);
  assert.deepEqual(plain.result.updatedInput!.answers, { 'Which features?': 'Search' });
  const typedOnly = await answerWith([MULTI], [{ questionIndex: 0, optionIndexes: [], otherText: 'Export' }]);
  assert.deepEqual(typedOnly.result.updatedInput!.answers, { 'Which features?': 'Export' });
});

test('Unicode and bidi text goes back unchanged and unquoted', async () => {
  const question = q('选哪个？‮right-to-left', [opt('数据库 ⁧isolated⁩'), opt('‮evil.exe')], true);
  const { result } = await answerWith([question], [{ questionIndex: 0, optionIndexes: [0, 1], otherText: 'émoji 😀' }]);
  assert.deepEqual(result.updatedInput!.answers, { '选哪个？‮right-to-left': '数据库 ⁧isolated⁩, ‮evil.exe, émoji 😀' });
});

test('an unanswered question is left out, and answers come in question order whatever order they were sent in', async () => {
  const { result, event } = await answerWith(
    [SINGLE, MULTI, PREVIEWED],
    [
      { questionIndex: 2, optionIndexes: [2] },
      { questionIndex: 1, optionIndexes: [], otherText: '' },
      { questionIndex: 0, optionIndexes: [0] },
    ],
  );
  assert.deepEqual(Object.keys(result.updatedInput!.answers as object), ['Which database?', 'Which layout?']);
  assert.deepEqual(event.answers!.map((a) => a.questionIndex), [0, 2]);
});

test('annotations: only for a single-select question with previews, each part only when it is not empty', async () => {
  const withBoth = await answerWith([PREVIEWED, SINGLE], [
    { questionIndex: 0, optionIndexes: [0], notes: '  keep the header  ' },
    { questionIndex: 1, optionIndexes: [0] },
  ]);
  assert.deepEqual(withBoth.result.updatedInput!.annotations, { 'Which layout?': { preview: '# Grid\n\n| a | b |', notes: 'keep the header' } });
  assert.deepEqual(withBoth.event.answers, [{ questionIndex: 0, answer: 'Grid', notes: 'keep the header' }, { questionIndex: 1, answer: 'Postgres' }]);
  // An empty preview, an option without one, typed text, or whitespace notes add nothing.
  for (const answer of [
    { questionIndex: 0, optionIndexes: [1] },
    { questionIndex: 0, optionIndexes: [2], notes: '   ' },
    { questionIndex: 0, optionIndexes: [], otherText: 'Masonry' },
  ]) {
    assert.deepEqual((await answerWith([PREVIEWED], [answer])).result.updatedInput!.annotations, {}, JSON.stringify(answer));
  }
  const notesOnly = await answerWith([PREVIEWED], [{ questionIndex: 0, optionIndexes: [2], notes: 'no preview here' }]);
  assert.deepEqual(notesOnly.result.updatedInput!.annotations, { 'Which layout?': { notes: 'no preview here' } });
  // Nothing answered at all is still an answer, with both maps present and empty.
  const none = await answerWith([SINGLE], []);
  assert.deepEqual(none.result, { behavior: 'allow', updatedInput: { questions: [SINGLE], answers: {}, annotations: {} } });
});

test('the answer is built over the input the CLI sent: metadata and every other field kept', async () => {
  const { result, input } = await answerWith([SINGLE], [{ questionIndex: 0, optionIndexes: [0] }], { metadata: { source: 'remember' } });
  assert.deepEqual(result.updatedInput, { ...input, answers: { 'Which database?': 'Postgres' }, annotations: {} });
});

test('a question whose text is __proto__ or constructor keeps its answer and annotation as ordinary entries', async () => {
  const proto = q('__proto__', [opt('Grid', '# Grid'), opt('List')]);
  const ctor = q('constructor', [opt('Yes'), opt('No')]);
  const { result, event } = await answerWith([proto, ctor], [
    { questionIndex: 0, optionIndexes: [0], notes: 'wide' },
    { questionIndex: 1, optionIndexes: [1] },
  ]);
  const { answers, annotations } = result.updatedInput as { answers: Record<string, unknown>; annotations: Record<string, unknown> };
  // The maps stay ordinary objects, so the CLI-bound JSON carries every key the user answered.
  assert.equal(Object.getPrototypeOf(answers), Object.prototype);
  assert.equal(Object.getPrototypeOf(annotations), Object.prototype);
  assert.deepEqual(Object.keys(answers), ['__proto__', 'constructor']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.updatedInput)).answers, JSON.parse('{"__proto__":"Grid","constructor":"No"}'));
  assert.deepEqual(JSON.parse(JSON.stringify(result.updatedInput)).annotations, JSON.parse('{"__proto__":{"preview":"# Grid","notes":"wide"}}'));
  // A copy made by spreading, as the SDK may do before writing, keeps the entries too.
  assert.equal(JSON.stringify({ ...answers }), '{"__proto__":"Grid","constructor":"No"}');
  assert.deepEqual(event.answers, [{ questionIndex: 0, answer: 'Grid', notes: 'wide' }, { questionIndex: 1, answer: 'No' }]);
});

// ---- Answers refused, and the question still waiting ------------------------------------------------------------------

const ANSWER_REFUSALS: Array<[reason: string, answers: InteractionAnswerInput[]]> = [
  ['unknown_question_index', [{ questionIndex: 3, optionIndexes: [0] }]],
  ['unknown_question_index', [{ questionIndex: -1, optionIndexes: [0] }]],
  ['duplicate_question_index', [{ questionIndex: 0, optionIndexes: [0] }, { questionIndex: 0, optionIndexes: [1] }]],
  ['unknown_option_index', [{ questionIndex: 1, optionIndexes: [4] }]],
  ['duplicate_option_index', [{ questionIndex: 1, optionIndexes: [1, 1] }]],
  ['single_select_takes_one', [{ questionIndex: 0, optionIndexes: [0, 1] }]],
  ['single_select_takes_one', [{ questionIndex: 0, optionIndexes: [0], otherText: 'and this' }]],
  ['notes_not_allowed', [{ questionIndex: 0, optionIndexes: [0], notes: 'n' }]],
  ['notes_not_allowed', [{ questionIndex: 1, optionIndexes: [0], notes: 'n' }]],
  ['notes_too_long', [{ questionIndex: 2, optionIndexes: [0], notes: 'n'.repeat(QUESTION_LIMITS.notesChars + 1) }]],
  ['answer_too_long', [{ questionIndex: 0, optionIndexes: [], otherText: 't'.repeat(QUESTION_LIMITS.answerChars + 1) }]],
  [
    'answers_too_long',
    [
      { questionIndex: 0, optionIndexes: [], otherText: 't'.repeat(20000) },
      { questionIndex: 1, optionIndexes: [], otherText: 't'.repeat(20000) },
    ],
  ],
];

for (const [reason, answers] of ANSWER_REFUSALS) {
  test(`answer refused: ${reason} (${JSON.stringify(answers).slice(0, 80)}) leaves the question waiting`, async () => {
    const { broker, ask, requested, resolved } = harness();
    const pending = ask({ questions: [SINGLE, MULTI, PREVIEWED] });
    const { interactionId } = requested()[0];
    assert.equal(refusal(() => broker.resolve(interactionId, { kind: 'answers', answers })).reason, reason);
    assert.equal(refusal(() => broker.resolve(interactionId, { kind: 'decline', decline: 'chat', soFar: answers })).reason, reason);
    assert.equal(broker.pending().length, 1);
    assert.deepEqual(resolved(), []);
    assert.equal(await settled(pending), false);
    broker.resolve(interactionId, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [0] }] });
    assert.equal(((await pending) as { behavior: string }).behavior, 'allow');
  });
}

test('answers at their limits are taken', async () => {
  const L = QUESTION_LIMITS;
  const { result } = await answerWith([SINGLE, PREVIEWED], [
    { questionIndex: 0, optionIndexes: [], otherText: 't'.repeat(L.answerChars - 8192) },
    { questionIndex: 1, optionIndexes: [], otherText: 'u'.repeat(8192), notes: 'n'.repeat(L.notesChars) },
  ]);
  assert.equal(Object.keys(result.updatedInput!.answers as object).length, 2);
});

test('a cancel carrying answers does not fit and leaves the question waiting', async () => {
  const { broker, ask, requested } = harness();
  const pending = ask({ questions: [SINGLE] });
  const { interactionId } = requested()[0];
  assert.equal(refusal(() => broker.resolve(interactionId, { kind: 'decline', decline: 'cancel', soFar: [{ questionIndex: 0, optionIndexes: [0] }] })).reason, 'kind_mismatch');
  assert.equal(broker.pending().length, 1);
  broker.failAll('session_closed');
  await pending;
});

// ---- Declines --------------------------------------------------------------------------------------------------------

test('cancel: deny with the CLI\'s rejection text and interrupt, outcome declined', async () => {
  const { broker, ask, requested, resolved } = harness();
  const pending = ask({ questions: [SINGLE] });
  const { interactionId } = requested()[0];
  // Answers so far are not part of a cancel; an empty list is not answers.
  const event = broker.resolve(interactionId, { kind: 'decline', decline: 'cancel', soFar: [] });
  assert.deepEqual(await pending, { behavior: 'deny', message: CLI_REJECT_TEXT, interrupt: true });
  assert.deepEqual(event, { type: 'interaction_resolved', interactionId, outcome: 'declined' });
  assert.deepEqual(resolved(), [event]);
});

test('chat: deny with the CLI\'s clarify text listing every question, its answer so far and its notes; the turn goes on', async () => {
  const { broker, ask, requested } = harness();
  const pending = ask({ questions: [SINGLE, MULTI, PREVIEWED] });
  const { interactionId } = requested()[0];
  const event = broker.resolve(interactionId, {
    kind: 'decline',
    decline: 'chat',
    soFar: [
      { questionIndex: 0, optionIndexes: [2] },
      { questionIndex: 2, optionIndexes: [0], notes: ' wider ' },
    ],
  });
  const expected =
    'The user wants to clarify these questions.\n' +
    '    This means they may have additional information, context or questions for you.\n' +
    '    Take their response into account and then reformulate the questions if appropriate.\n' +
    '    Start by asking them what they would like to clarify.\n' +
    '\n' +
    '    Questions asked:\n' +
    '- "Which database?"\n' +
    '  Answer: Redis, not Memcached\n' +
    '- "Which features?"\n' +
    '  (No answer provided)\n' +
    '- "Which layout?"\n' +
    '  Answer: Grid\n' +
    '  User notes: wider';
  assert.deepEqual(await pending, { behavior: 'deny', message: expected });
  assert.deepEqual(event, {
    type: 'interaction_resolved',
    interactionId,
    outcome: 'chat_requested',
    answers: [{ questionIndex: 0, answer: 'Redis, not Memcached' }, { questionIndex: 2, answer: 'Grid', notes: 'wider' }],
  });
});

// ---- One settlement, the first ---------------------------------------------------------------------------------------

type Ender = { name: string; run: (h: ReturnType<typeof harness>, id: string, abort: AbortController) => void; outcome: string; message?: string };
const ENDERS: Ender[] = [
  { name: 'answer', run: (h, id) => void h.broker.resolve(id, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [0] }] }), outcome: 'answered' },
  { name: 'cancel', run: (h, id) => void h.broker.resolve(id, { kind: 'decline', decline: 'cancel' }), outcome: 'declined', message: CLI_REJECT_TEXT },
  { name: 'abort', run: (_h, _id, abort) => abort.abort(), outcome: 'expired', message: QUESTION_WITHDRAWN_TEXT },
  { name: 'interrupt', run: (h) => h.broker.failAll('interrupted'), outcome: 'interrupted', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt },
  { name: 'close', run: (h) => h.broker.failAll('session_closed'), outcome: 'session_closed', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_session_close },
  { name: 'provider death', run: (h) => h.broker.failAll('provider_failed'), outcome: 'provider_failed', message: HOST_SETTLEMENT_MESSAGES.provider_failed },
];

for (const first of ENDERS) {
  for (const second of ENDERS) {
    if (first === second) {
      continue;
    }
    test(`first settlement wins: ${first.name} then ${second.name}`, async () => {
      const h = harness();
      const abort = new AbortController();
      const pending = h.ask({ questions: [SINGLE] }, abort.signal);
      const { interactionId } = h.requested()[0];
      assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
      first.run(h, interactionId, abort);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0, 'the abort listener is gone once the question ended');
      try {
        second.run(h, interactionId, abort);
      } catch (error) {
        assert.ok(error instanceof InteractionNotFoundError, `a later answer finds nothing: ${String(error)}`);
      }
      const result = (await pending) as { behavior: string; message?: string };
      if (first.message !== undefined) {
        assert.equal(result.message, first.message);
      } else {
        assert.equal(result.behavior, 'allow');
      }
      assert.deepEqual(h.resolved().map((e) => e.outcome), [first.outcome]);
      assert.deepEqual(h.broker.pending(), []);
    });
  }
}

test('a question whose callback was already aborted is denied as withdrawn and never announced', async () => {
  const { ask, events } = harness();
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await ask({ questions: [SINGLE] }, abort.signal), { behavior: 'deny', message: QUESTION_WITHDRAWN_TEXT });
  assert.deepEqual(events, []);
});

test('an unknown id is not found, and so is a spent one', async () => {
  const { broker, ask, requested } = harness();
  assert.throws(() => broker.resolve('nope', { kind: 'decline', decline: 'cancel' }), InteractionNotFoundError);
  const pending = ask({ questions: [SINGLE] });
  const { interactionId } = requested()[0];
  broker.resolve(interactionId, { kind: 'decline', decline: 'cancel' });
  await pending;
  assert.throws(() => broker.resolve(interactionId, { kind: 'answers', answers: [] }), InteractionNotFoundError);
});

test('the port takes the question tool only', () => {
  const { broker, events } = harness();
  assert.equal(broker.route('Bash', {}, { signal: new AbortController().signal }), undefined);
  assert.equal(broker.route('askuserquestion', {}, { signal: new AbortController().signal }), undefined);
  assert.deepEqual(events, []);
});

// ---- Through a session -------------------------------------------------------------------------------------------------

function capture(config: ClaudeSessionConfig, queryOptions: FakeQueryOptions = {}) {
  let options: Options | undefined;
  const { query } = makeFakeQuery(queryOptions);
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return query;
  };
  const session = createSession(config, queryFn);
  return { session, options: options! };
}

const hookInput = (tool: string, input: unknown) =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_q', session_id: 's', transcript_path: '', cwd: '/p' }) as never;

const canUse = (signal: AbortSignal) => ({ signal, toolUseID: 'toolu_q', suggestions: [] }) as never;

test('an opted-in session: the gate makes no decision for the question, and the CLI\'s ask becomes an interaction, never a permission request', async () => {
  const { session, options } = capture({ cwd: '/p', policy: OFFERING, clientInteractions: QUESTIONS });
  const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  assert.deepEqual(await hook(hookInput('AskUserQuestion', { questions: [SINGLE] }), 'toolu_q', { signal: new AbortController().signal }), {});
  const answer = options.canUseTool!('AskUserQuestion', { questions: [SINGLE] }, canUse(new AbortController().signal));
  const events = await session.pump();
  assert.deepEqual(events.filter((e) => e.type === 'permission_requested'), []);
  const [requested] = events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  assert.equal(requested.toolUseId, 'toolu_q');
  assert.deepEqual(session.interactions()!.pending(), [requested]);
  session.interactions()!.resolve(requested.interactionId, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [0] }] });
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { questions: [SINGLE], answers: { 'Which database?': 'Postgres' }, annotations: {} } });
  const after = await session.pump();
  assert.deepEqual(after.filter((e) => e.type === 'interaction_resolved' || e.type.startsWith('permission_')).map((e) => e.type), ['interaction_resolved']);
  session.close();
});

test('a session that did not opt in denies the question tool with no event, and its gate still asks about it', async () => {
  const { session, options } = capture({ cwd: '/p', policy: OFFERING });
  assert.equal(session.interactions(), undefined);
  assert.deepEqual(await options.canUseTool!('AskUserQuestion', { questions: [SINGLE] }, canUse(new AbortController().signal)), { behavior: 'deny', message: QUESTION_NOT_OFFERED_TEXT });
  const abort = new AbortController();
  const hooked = (options.hooks!.PreToolUse![0].hooks[0] as HookCallback)(hookInput('AskUserQuestion', {}), 'toolu_q', { signal: abort.signal });
  const events = await session.pump();
  assert.deepEqual(events.filter((e) => e.type.startsWith('permission_') || e.type.startsWith('interaction_')).map((e) => e.type), ['permission_requested']);
  abort.abort();
  await hooked;
  // A bare broker without a port is the same: the question tool never becomes a permission request.
  const bareEvents: ClaudeRuntimeEvent[] = [];
  const bare = new PermissionBroker((e) => bareEvents.push(e));
  assert.deepEqual(await bare.buildCanUseTool()('AskUserQuestion', {}, canUse(new AbortController().signal)), { behavior: 'deny', message: QUESTION_NOT_OFFERED_TEXT });
  assert.deepEqual(bareEvents, []);
  session.close();
});

test('nothing that answers permissions settles a question: a switch to bypass, an approve-all, resolvePermission on every id', async () => {
  const { session, options } = capture({ cwd: '/p', policy: { ...OFFERING, permissionModeSwitchable: true }, clientInteractions: QUESTIONS });
  const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  const bash = hook(hookInput('Bash', { command: 'ls' }), 'toolu_b', { signal: new AbortController().signal });
  const question = options.canUseTool!('AskUserQuestion', { questions: [SINGLE] }, canUse(new AbortController().signal));
  await session.setPermissionMode('bypass');
  // Under bypass the gate still makes no decision for the question tool, and raises nothing.
  assert.deepEqual(await hook(hookInput('AskUserQuestion', { questions: [SINGLE] }), 'toolu_q2', { signal: new AbortController().signal }), {});
  const events = await session.pump();
  const permissionIds = events.flatMap((e) => (e.type === 'permission_requested' ? [e.permissionId] : []));
  const [{ interactionId }] = events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  assert.equal(permissionIds.length, 1, 'only the Bash call is a permission request');
  // The approve-all a host does on entering bypass, and an allow aimed at the question's own id.
  for (const id of [...permissionIds, interactionId]) {
    session.resolvePermission(id, { allow: true });
  }
  assert.equal(session.resolvePermission(interactionId, { allow: true }), false);
  await bash;
  assert.equal(await settled(question), false, 'the question still waits for the host');
  assert.deepEqual(session.interactions()!.pending().map((e) => e.interactionId), [interactionId]);
  session.interactions()!.resolve(interactionId, { kind: 'decline', decline: 'cancel' });
  assert.deepEqual(await question, { behavior: 'deny', message: CLI_REJECT_TEXT, interrupt: true });
  session.close();
});

test('an interrupt ends an open question as interrupted, even though the CLI withdraws the callback while interrupting', async () => {
  const abort = new AbortController();
  // The real CLI cancels a callback it is waiting on as part of an interrupt.
  const { session, options } = capture({ cwd: '/p', policy: OFFERING, clientInteractions: QUESTIONS }, { interrupt: async () => abort.abort() });
  const question = options.canUseTool!('AskUserQuestion', { questions: [SINGLE] }, canUse(abort.signal));
  await session.interrupt();
  assert.deepEqual(await question, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
  const events = await session.pump();
  assert.deepEqual(
    events.filter((e) => e.type === 'interaction_resolved').map((e) => (e as { outcome: string }).outcome),
    ['interrupted'],
  );
  session.close();
});

test('closing the session ends an open question as session_closed, before session_closed itself', async () => {
  const { session, options } = capture({ cwd: '/p', policy: OFFERING, clientInteractions: QUESTIONS });
  const question = options.canUseTool!('AskUserQuestion', { questions: [SINGLE] }, canUse(new AbortController().signal));
  await session.pump();
  session.close();
  assert.deepEqual(await question, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_session_close });
  const types = (await session.pump()).map((e) => (e.type === 'interaction_resolved' ? `${e.type}:${e.outcome}` : e.type));
  assert.ok(types.indexOf('interaction_resolved:session_closed') >= 0 && types.indexOf('interaction_resolved:session_closed') < types.indexOf('session_closed'), types.join(','));
});

test('createInteractionPort gives a port only to a session that offers questions', () => {
  const emit = () => undefined;
  assert.ok(createInteractionPort({ policy: OFFERING, clientInteractions: QUESTIONS }, emit) instanceof QuestionBroker);
  for (const [policy, clientInteractions] of [
    [OFFERING, undefined],
    [OFFERING, { questions: false }],
    [{ ...OFFERING, providerPermissionPrompts: false }, QUESTIONS],
    [{ ...OFFERING, permissions: 'verdandi_rules' }, QUESTIONS],
    [{ ...OFFERING, permissions: 'bypass' }, QUESTIONS],
  ] as Array<[ClaudeHostPolicy, { questions: boolean } | undefined]>) {
    assert.equal(createInteractionPort({ policy, clientInteractions }, emit), undefined, JSON.stringify([policy.permissions, clientInteractions]));
  }
});

// Keeps the question-set type honest against the kernel's own.
const _shape: InteractionQuestion = SINGLE;
void _shape;
