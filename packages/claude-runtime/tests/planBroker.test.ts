import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import type { HookCallback, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import {
  CLI_PLAN_REJECT_FEEDBACK_OPENING,
  CLI_PLAN_REJECT_TEXT,
  CLI_PLAN_REJECT_TEXT_VERSION,
  PLAN_LIMITS,
  PLAN_NOT_OFFERED_TEXT,
  PLAN_OUTSIDE_PLAN_MODE_TEXT,
  PLAN_WITHDRAWN_TEXT,
  PlanBroker,
  planRefusedText,
  planRejectText,
} from '../src/planBroker.js';
import { ENTER_PLAN_TOOL, PLAN_TOOL } from '../src/planOptions.js';
import { InteractionAnswerError, InteractionNotFoundError, createInteractionPort, type InteractionResult } from '../src/interactionPort.js';
import { HOST_SETTLEMENT_MESSAGES, PermissionBroker } from '../src/permissionBroker.js';
import { createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, InteractionRequestedEvent, InteractionResolvedEvent } from '../src/types.js';

/**
 * The plan path: a model's `ExitPlanMode` in plan mode becomes an `interaction_requested` of kind
 * `plan_approval`, settled only by the person's decision through `resolve()`, by the CLI withdrawing the
 * call, or by the session settling everything at once.
 */

const PLAN_POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true, cliPermissionMode: 'auto' };
const PLAN_TEXT = '# Plan\n\n1. Change `hello.txt`.\n2. Run the tests.\n';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function harness(mode: string | null = 'plan') {
  const events: ClaudeRuntimeEvent[] = [];
  const state: { mode: string | undefined } = { mode: mode ?? undefined };
  const broker = new PlanBroker((event) => events.push(event), () => state.mode);
  const propose = (input: unknown, signal: AbortSignal = new AbortController().signal, toolUseID = 'toolu_p', agentID?: string) =>
    broker.propose(input, { signal, toolUseID, ...(agentID === undefined ? {} : { agentID }) });
  const requested = () => events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  const resolved = () => events.filter((e): e is InteractionResolvedEvent => e.type === 'interaction_resolved');
  return { broker, events, state, propose, requested, resolved };
}

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

test('the reject texts name CLI 2.1.311', () => {
  assert.equal(CLI_PLAN_REJECT_TEXT_VERSION, '2.1.311');
  assert.equal(
    CLI_PLAN_REJECT_TEXT,
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  );
  assert.equal(
    CLI_PLAN_REJECT_FEEDBACK_OPENING,
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n",
  );
  assert.equal(planRejectText('also update README.md'), `${CLI_PLAN_REJECT_FEEDBACK_OPENING}also update README.md`);
  assert.equal(planRejectText(''), CLI_PLAN_REJECT_TEXT);
  assert.equal(planRejectText('  \n'), CLI_PLAN_REJECT_TEXT, 'a blank field is no feedback, as in the terminal');
  assert.equal(planRefusedText('why'), 'This client could not show the plan: why. Shorten the plan and call ExitPlanMode again.');
  assert.equal(PLAN_OUTSIDE_PLAN_MODE_TEXT, 'ExitPlanMode is only available in plan mode.');
  assert.deepEqual({ ...PLAN_LIMITS }, { planMaxBytes: 262144, feedbackMaxBytes: 16384, allowedPromptsMax: 32, allowedPromptMaxChars: 1000 });
  assert.equal(PLAN_TOOL, 'ExitPlanMode');
  assert.equal(ENTER_PLAN_TOOL, 'EnterPlanMode');
});

test('an approval answers plain allow and records the mode after', async () => {
  for (const mode of ['manual', 'auto', 'bypass'] as const) {
    const h = harness();
    const input = { plan: PLAN_TEXT, planFilePath: '/c/plans/a-b-c.md' };
    const answer = h.propose(input);
    const [requested] = h.requested();
    assert.deepEqual(requested, {
      type: 'interaction_requested',
      interactionId: requested.interactionId,
      toolUseId: 'toolu_p',
      kind: 'plan_approval',
      plan: { plan: PLAN_TEXT, planSha256: sha(PLAN_TEXT), allowedPrompts: [] },
    });
    assert.deepEqual(h.broker.pending(), [requested]);
    const event = h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode, planSha256: sha(PLAN_TEXT) });
    assert.deepEqual(event, { type: 'interaction_resolved', interactionId: requested.interactionId, kind: 'plan_approval', outcome: 'approved', modeAfter: mode });
    // Exactly a plain allow: no edited input, no permission update.
    assert.deepEqual(await answer, { behavior: 'allow' });
    assert.deepEqual(h.resolved(), [event]);
    assert.deepEqual(h.broker.pending(), []);
    assert.deepEqual(input, { plan: PLAN_TEXT, planFilePath: '/c/plans/a-b-c.md' }, 'the input is left as the CLI sent it');
    assert.throws(() => h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode, planSha256: sha(PLAN_TEXT) }), InteractionNotFoundError);
  }
});

test('a wrong digest leaves the plan waiting', async () => {
  const h = harness();
  const answer = h.propose({ plan: PLAN_TEXT });
  const [requested] = h.requested();
  for (const digest of [sha('another plan'), '', sha(PLAN_TEXT).toUpperCase()]) {
    assert.equal(refusal(() => h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: digest })).reason, 'plan_digest_mismatch');
  }
  assert.equal(refusal(() => h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'unspecified', planSha256: sha(PLAN_TEXT) } as unknown as InteractionResult)).reason, 'plan_mode_unspecified');
  assert.equal(refusal(() => h.broker.resolve(requested.interactionId, { kind: 'answers', answers: [] })).reason, 'kind_mismatch');
  assert.equal(refusal(() => h.broker.resolve(requested.interactionId, { kind: 'decline', decline: 'cancel' })).reason, 'kind_mismatch');
  assert.equal(await settled(answer), false);
  assert.deepEqual(h.resolved(), []);
  assert.deepEqual(h.broker.pending(), [requested]);
  h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'manual', planSha256: sha(PLAN_TEXT) });
  assert.deepEqual(await answer, { behavior: 'allow' });
});

test('keep planning denies with the CLI\'s rejection text and the feedback, without interrupt', async () => {
  for (const feedback of ['also update README.md', '']) {
    const h = harness();
    const answer = h.propose({ plan: PLAN_TEXT });
    const [requested] = h.requested();
    const event = h.broker.resolve(requested.interactionId, { kind: 'plan_keep', feedback });
    assert.deepEqual(event, { type: 'interaction_resolved', interactionId: requested.interactionId, kind: 'plan_approval', outcome: 'kept_planning', feedback });
    const result = await answer;
    assert.deepEqual(result, { behavior: 'deny', message: planRejectText(feedback) });
    assert.equal('interrupt' in result, false);
  }
});

test('feedback over 16 KiB is refused and the plan keeps waiting', async () => {
  const h = harness();
  const answer = h.propose({ plan: PLAN_TEXT });
  const [requested] = h.requested();
  // 5462 three-byte characters: 16386 bytes, within 16 KiB of UTF-16 units.
  const over = '中'.repeat(5462);
  assert.equal(refusal(() => h.broker.resolve(requested.interactionId, { kind: 'plan_keep', feedback: over })).reason, 'feedback_too_long');
  assert.equal(await settled(answer), false);
  assert.deepEqual(h.broker.pending(), [requested]);
  const atLimit = 'x'.repeat(PLAN_LIMITS.feedbackMaxBytes);
  h.broker.resolve(requested.interactionId, { kind: 'plan_keep', feedback: atLimit });
  assert.deepEqual(await answer, { behavior: 'deny', message: planRejectText(atLimit) });
});

test('a plan over 256 KiB is refused with a reason the model can act on', async () => {
  for (const [input, reason] of [
    [{ plan: 'é'.repeat(PLAN_LIMITS.planMaxBytes / 2 + 1) }, /larger than 262144 bytes/],
    [{ plan: '' }, /no plan text/],
    [{}, /no plan text/],
    [{ plan: 42 }, /no plan text/],
    ['not an object', /not an object/],
    [{ plan: PLAN_TEXT, allowedPrompts: 'Bash' }, /not a list/],
    [{ plan: PLAN_TEXT, allowedPrompts: Array.from({ length: 33 }, () => ({ tool: 'Bash', prompt: 'run tests' })) }, /33 entries/],
    [{ plan: PLAN_TEXT, allowedPrompts: [{ tool: 'Bash' }] }, /entry 1 is not a tool and a prompt/],
    [{ plan: PLAN_TEXT, allowedPrompts: [{ tool: 'Bash', prompt: 'x'.repeat(1001) }] }, /longer than 1000 characters/],
  ] as const) {
    const h = harness();
    const result = await h.propose(input);
    const [requested] = h.requested();
    assert.equal(requested.kind, 'plan_approval');
    assert.equal(requested.plan, undefined, 'a refused plan carries no payload');
    assert.match(requested.unsupportedReason!, reason);
    assert.deepEqual(h.resolved(), [{ type: 'interaction_resolved', interactionId: requested.interactionId, kind: 'plan_approval', outcome: 'host_refused', reason: requested.unsupportedReason }]);
    assert.deepEqual(result, { behavior: 'deny', message: planRefusedText(requested.unsupportedReason!) });
    assert.match((result as { message: string }).message, /Shorten the plan and call ExitPlanMode again\.$/);
    assert.deepEqual(h.broker.pending(), []);
  }
  // Exactly at the limit is shown.
  const h = harness();
  void h.propose({ plan: 'x'.repeat(PLAN_LIMITS.planMaxBytes) });
  assert.equal(h.requested()[0].plan?.plan.length, PLAN_LIMITS.planMaxBytes);
});

test('allowedPrompts are carried as information and never become a permission', async () => {
  const prompts = [
    { tool: 'Bash', prompt: 'run the tests' },
    { tool: 'Bash', prompt: 'install dependencies', extra: true },
  ];
  const h = harness();
  const answer = h.propose({ plan: PLAN_TEXT, allowedPrompts: prompts });
  const [requested] = h.requested();
  assert.deepEqual(requested.plan?.allowedPrompts, [
    { tool: 'Bash', prompt: 'run the tests' },
    { tool: 'Bash', prompt: 'install dependencies' },
  ]);
  h.broker.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: sha(PLAN_TEXT) });
  const result = await answer;
  assert.deepEqual(result, { behavior: 'allow' });
  assert.equal('updatedPermissions' in result, false);
  assert.equal('updatedInput' in result, false);
});

test('a second plan while one waits is refused', async () => {
  const h = harness();
  const first = h.propose({ plan: PLAN_TEXT });
  const second = await h.propose({ plan: 'another plan' }, new AbortController().signal, 'toolu_p2');
  const refused = h.requested()[1];
  assert.equal(refused.unsupportedReason, 'a plan is already waiting for review');
  assert.equal(refused.toolUseId, 'toolu_p2');
  assert.deepEqual(second, { behavior: 'deny', message: planRefusedText('a plan is already waiting for review') });
  assert.deepEqual(h.broker.pending().map((e) => e.toolUseId), ['toolu_p']);
  assert.equal(await settled(first), false);
});

test('ExitPlanMode outside plan mode is denied without an event', async () => {
  for (const mode of ['auto', 'default', null]) {
    const h = harness(mode);
    assert.deepEqual(await h.propose({ plan: PLAN_TEXT }), { behavior: 'deny', message: PLAN_OUTSIDE_PLAN_MODE_TEXT });
    assert.deepEqual(h.events, [], String(mode));
  }
  // A port built without a way to read the mode never takes a plan.
  const events: ClaudeRuntimeEvent[] = [];
  const port = createInteractionPort({ policy: PLAN_POLICY, clientInteractions: { questions: false, planMode: true } }, (e) => events.push(e));
  assert.deepEqual(await port!.route(PLAN_TOOL, { plan: PLAN_TEXT }, { signal: new AbortController().signal }), { behavior: 'deny', message: PLAN_OUTSIDE_PLAN_MODE_TEXT });
  assert.deepEqual(events, []);
});

test('a subagent\'s ExitPlanMode is denied with a fixed text and no event', async () => {
  // A subagent in plan mode of its own: approving its plan would leave the main CLI where it is, so it
  // is never shown to the person as the conversation's plan.
  const h = harness();
  const result = await h.propose({ plan: PLAN_TEXT }, new AbortController().signal, 'toolu_sub', 'agent-1');
  assert.deepEqual(result, {
    behavior: 'deny',
    message: 'ExitPlanMode is not available to a subagent on this client: return the plan in your final response instead.',
  });
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.broker.pending(), []);
  // Outside plan mode too: the same answer, still no event.
  const out = harness('auto');
  assert.deepEqual(await out.propose({ plan: PLAN_TEXT }, new AbortController().signal, 'toolu_sub', 'agent-1'), result);
  assert.deepEqual(out.events, []);
  // An empty agent id is the main thread's.
  const main = harness();
  void main.propose({ plan: PLAN_TEXT }, new AbortController().signal, 'toolu_main', '');
  assert.equal(main.requested().length, 1);
});

test('the limits are inclusive: 32 allowed prompts and a 1000-character prompt are shown', async () => {
  const h = harness();
  const prompts = Array.from({ length: PLAN_LIMITS.allowedPromptsMax }, (_, i) => ({ tool: 'Bash', prompt: i === 0 ? 'p'.repeat(PLAN_LIMITS.allowedPromptMaxChars) : `run step ${i}` }));
  void h.propose({ plan: PLAN_TEXT, allowedPrompts: prompts });
  const [requested] = h.requested();
  assert.equal(requested.unsupportedReason, undefined);
  assert.equal(requested.plan?.allowedPrompts.length, 32);
  assert.equal(requested.plan?.allowedPrompts[0].prompt.length, 1000);
});

test('an abort after a decision emits nothing more', async () => {
  for (const result of [{ kind: 'plan_approve', mode: 'auto', planSha256: sha(PLAN_TEXT) }, { kind: 'plan_keep', feedback: 'more tests' }] as InteractionResult[]) {
    const h = harness();
    const abort = new AbortController();
    const answer = h.propose({ plan: PLAN_TEXT }, abort.signal);
    const [requested] = h.requested();
    h.broker.resolve(requested.interactionId, result);
    const settledWith = await answer;
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.resolved().length, 1, result.kind);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    assert.deepEqual(await answer, settledWith);
  }
});

type Ender = { name: string; run: (h: ReturnType<typeof harness>, id: string, abort: AbortController) => void; outcome: string; message: string };

const ENDERS: Ender[] = [
  { name: 'abort', run: (_h, _id, abort) => abort.abort(), outcome: 'expired', message: PLAN_WITHDRAWN_TEXT },
  { name: 'interrupt', run: (h) => h.broker.failAll('interrupted'), outcome: 'interrupted', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt },
  { name: 'close', run: (h) => h.broker.failAll('session_closed'), outcome: 'session_closed', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_session_close },
  { name: 'provider death', run: (h) => h.broker.failAll('provider_failed'), outcome: 'provider_failed', message: HOST_SETTLEMENT_MESSAGES.provider_failed },
];

test('interrupt, close, abort and provider death settle once each', async () => {
  for (const first of ENDERS) {
    const h = harness();
    const abort = new AbortController();
    const answer = h.propose({ plan: PLAN_TEXT }, abort.signal);
    const [requested] = h.requested();
    first.run(h, requested.interactionId, abort);
    assert.deepEqual(await answer, { behavior: 'deny', message: first.message }, first.name);
    for (const then of ENDERS) {
      then.run(h, requested.interactionId, abort);
    }
    assert.throws(() => h.broker.resolve(requested.interactionId, { kind: 'plan_keep', feedback: '' }), InteractionNotFoundError);
    assert.deepEqual(h.resolved(), [{ type: 'interaction_resolved', interactionId: requested.interactionId, kind: 'plan_approval', outcome: first.outcome }], first.name);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0, `${first.name}: no listener left behind`);
  }
  // Every waiting plan is the main thread's, so an interrupt that spares background tasks still ends it.
  const h = harness();
  const mainPlan = h.propose({ plan: PLAN_TEXT });
  h.broker.failAll('interrupted', () => true);
  assert.deepEqual(await mainPlan, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
  assert.equal(h.broker.pending().length, 0);
  // An already-aborted call is withdrawn with nothing shown.
  const gone = harness();
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await gone.propose({ plan: PLAN_TEXT }, aborted.signal), { behavior: 'deny', message: PLAN_WITHDRAWN_TEXT });
  assert.deepEqual(gone.events, []);
});

test('the port takes ExitPlanMode only; EnterPlanMode is not routed', () => {
  const h = harness();
  for (const tool of [ENTER_PLAN_TOOL, 'AskUserQuestion', 'Write', 'exitplanmode']) {
    assert.equal(h.broker.route(tool, { plan: PLAN_TEXT }, { signal: new AbortController().signal }), undefined, tool);
  }
  assert.deepEqual(h.events, []);
});

test('one port for questions and plans: pending lists both oldest first, and each refuses the other kind\'s answer', async () => {
  const events: ClaudeRuntimeEvent[] = [];
  const port = createInteractionPort({ policy: PLAN_POLICY, clientInteractions: { questions: true, planMode: true } }, (e) => events.push(e), { cliMode: () => 'plan' })!;
  const question = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };
  const askedFirst = port.route('AskUserQuestion', question, { signal: new AbortController().signal, toolUseID: 'toolu_q' })!;
  const planned = port.route(PLAN_TOOL, { plan: PLAN_TEXT }, { signal: new AbortController().signal, toolUseID: 'toolu_p' })!;
  const askedLater = port.route('AskUserQuestion', question, { signal: new AbortController().signal, toolUseID: 'toolu_q2' })!;
  assert.deepEqual(port.pending().map((e) => [e.toolUseId, e.kind]), [['toolu_q', 'question'], ['toolu_p', 'plan_approval'], ['toolu_q2', 'question']]);
  const [q1, p, q2] = port.pending();
  assert.equal(refusal(() => port.resolve(p.interactionId, { kind: 'answers', answers: [{ questionIndex: 0, optionIndexes: [0] }] })).reason, 'kind_mismatch');
  assert.equal(refusal(() => port.resolve(q1.interactionId, { kind: 'plan_keep', feedback: '' })).reason, 'kind_mismatch');
  assert.equal(refusal(() => port.resolve(q1.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: sha(PLAN_TEXT) })).reason, 'kind_mismatch');
  assert.equal(port.pending().length, 3, 'a refused answer changes nothing');
  assert.throws(() => port.resolve('no-such-id', { kind: 'plan_keep', feedback: '' }), InteractionNotFoundError);
  assert.equal(port.resolve(p.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: sha(PLAN_TEXT) }).kind, 'plan_approval');
  assert.deepEqual(await planned, { behavior: 'allow' });
  assert.equal(port.resolve(q2.interactionId, { kind: 'decline', decline: 'chat' }).kind, 'question');
  port.failAll('session_closed');
  assert.deepEqual((await askedFirst as PermissionResult).behavior, 'deny');
  await askedLater;
  assert.deepEqual(port.pending(), []);
  assert.deepEqual(events.filter((e): e is InteractionResolvedEvent => e.type === 'interaction_resolved').map((e) => [e.kind, e.outcome]), [
    ['plan_approval', 'approved'],
    ['question', 'chat_requested'],
    ['question', 'session_closed'],
  ]);
});

// ---- Through a session -------------------------------------------------------------------------------------------------

const status = (permissionMode: string) => ({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: 'u', session_id: 'c1' }) as unknown as SDKMessage;

function capture(clientInteractions = { questions: false, planMode: true }) {
  let options: Options | undefined;
  const { query, controller } = makeFakeQuery();
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return query;
  };
  const session = createSession({ cwd: '/p', policy: PLAN_POLICY, clientInteractions }, queryFn, { onDiagnostic: () => {} });
  const feed = async (...frames: SDKMessage[]): Promise<ClaudeRuntimeEvent[]> => {
    for (const frame of frames) controller.emit(frame);
    const out: ClaudeRuntimeEvent[] = [];
    for (let quiet = 0; quiet < 3; ) {
      const events = await session.pump();
      out.push(...events);
      quiet = events.length === 0 ? quiet + 1 : 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return out;
  };
  return { session, options: options!, feed };
}

const hookInput = (tool: string, input: unknown, permissionMode?: string) =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_p', session_id: 's', transcript_path: '', cwd: '/p', ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }) }) as never;

const canUse = (signal: AbortSignal) => ({ signal, toolUseID: 'toolu_p', suggestions: [] }) as never;

test('a plan session: the gate makes no decision for either plan tool, and a plan in plan mode becomes an interaction, never a permission request', async () => {
  const { session, options, feed } = capture();
  const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  assert.deepEqual(await hook(hookInput(ENTER_PLAN_TOOL, {}), 'toolu_e', { signal: new AbortController().signal }), {});
  await feed(status('plan'));
  assert.deepEqual(await hook(hookInput(PLAN_TOOL, {}, 'plan'), 'toolu_p', { signal: new AbortController().signal }), {});
  const answer = options.canUseTool!(PLAN_TOOL, { plan: PLAN_TEXT, planFilePath: '/c/plans/x.md' }, canUse(new AbortController().signal));
  const events = await session.pump();
  assert.deepEqual(events.filter((e) => e.type.startsWith('permission_')), []);
  const [requested] = events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  assert.equal(requested.kind, 'plan_approval');
  assert.deepEqual(session.interactions()!.pending(), [requested]);
  // Nothing that answers permissions reaches it: resolvePermission on its id finds nothing.
  assert.equal(session.resolvePermission(requested.interactionId, { allow: true }), false);
  // The interrupt settles it as interrupted.
  await session.interrupt();
  assert.deepEqual(await answer, { behavior: 'deny', message: HOST_SETTLEMENT_MESSAGES.cancelled_by_interrupt });
  const after = await session.pump();
  assert.deepEqual(after.filter((e): e is InteractionResolvedEvent => e.type === 'interaction_resolved').map((e) => [e.kind, e.outcome]), [['plan_approval', 'interrupted']]);
  session.close();
});

test('a plan settled through the session carries kind, outcome and mode after', async () => {
  const { session, options, feed } = capture({ questions: true, planMode: true });
  await feed(status('plan'));
  const answer = options.canUseTool!(PLAN_TOOL, { plan: PLAN_TEXT }, canUse(new AbortController().signal));
  const [requested] = (await session.pump()).filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
  const event = session.interactions()!.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: requested.plan!.planSha256 });
  assert.deepEqual(event, { type: 'interaction_resolved', interactionId: requested.interactionId, kind: 'plan_approval', outcome: 'approved', modeAfter: 'auto' });
  assert.deepEqual(await answer, { behavior: 'allow' });
  const after = await session.pump();
  assert.deepEqual(after.filter((e) => e.type === 'interaction_resolved'), [event]);
  session.close();
});

test('a plan session reads the mode from the plan tool\'s own hook before the status frame is pumped', async () => {
  const { session, options } = capture();
  // The CLI's status frame has not been read yet; the hook of the ExitPlanMode call says plan.
  await (options.hooks!.PreToolUse![0].hooks[0] as HookCallback)(hookInput(PLAN_TOOL, {}, 'plan'), 'toolu_p', { signal: new AbortController().signal });
  void options.canUseTool!(PLAN_TOOL, { plan: PLAN_TEXT }, canUse(new AbortController().signal));
  const events = await session.pump();
  assert.equal(events.filter((e) => e.type === 'interaction_requested').length, 1);
  session.close();
});

test('a session without plan mode denies ExitPlanMode with no event, and its gate still asks about it', async () => {
  let options: Options | undefined;
  const { query } = makeFakeQuery();
  const session = createSession({ cwd: '/p', policy: PLAN_POLICY }, ((params) => {
    options = params.options;
    return query;
  }) as QueryFn);
  assert.equal(session.interactions(), undefined);
  assert.deepEqual(await options!.canUseTool!(PLAN_TOOL, { plan: PLAN_TEXT }, canUse(new AbortController().signal)), { behavior: 'deny', message: PLAN_NOT_OFFERED_TEXT });
  const abort = new AbortController();
  const hooked = (options!.hooks!.PreToolUse![0].hooks[0] as HookCallback)(hookInput(PLAN_TOOL, {}), 'toolu_p', { signal: abort.signal });
  const events = await session.pump();
  assert.deepEqual(events.filter((e) => e.type.startsWith('permission_') || e.type.startsWith('interaction_')).map((e) => e.type), ['permission_requested']);
  abort.abort();
  await hooked;
  // A bare broker is the same.
  const bareEvents: ClaudeRuntimeEvent[] = [];
  const bare = new PermissionBroker((e) => bareEvents.push(e));
  assert.deepEqual(await bare.buildCanUseTool()(PLAN_TOOL, {}, canUse(new AbortController().signal)), { behavior: 'deny', message: PLAN_NOT_OFFERED_TEXT });
  assert.deepEqual(bareEvents, []);
  session.close();
});
