import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createInteractionPort, PermissionModeError, type ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { createInteractionRpc } from '../src/interactionRpc.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { translateEvent } from '../src/eventTranslation.js';
import { PumpDriver } from '../src/pumpDriver.js';
import { makeFakeSession } from './fakeSession.js';
import {
  ErrorCode, ErrorDetail, InteractionKind, InteractionOutcome, PermissionMode, PlanExecutionMode,
  ResolveInteractionRequest, SessionEvent, type GetInteractionStateResponse,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

const PLAN = '# Plan\n\n' + 'Keep the complete proposal.\n'.repeat(1000);
const DIGEST = createHash('sha256').update(PLAN).digest('hex');
const PROMPTS = [{ tool: 'Bash', prompt: 'npm test' }];

function setup() {
  const events: ClaudeRuntimeEvent[] = [];
  const port = createInteractionPort({
    policy: { configuration: 'native', permissions: 'interactive', executable: 'host_cli', persistence: 'host_cli', providerPermissionPrompts: true, cliPermissionMode: 'auto' },
    clientInteractions: { questions: true, planMode: true },
  }, (event) => events.push(event), { cliMode: () => 'plan' })!;
  const fake = makeFakeSession();
  const session = Object.assign(fake.session, { interactions: () => port, pump: async () => events.splice(0), resolvePermission: () => false });
  const registry = new SessionRegistry();
  const entry = registry.create('s', session, 64);
  const rpc = createInteractionRpc({ requireEntry: () => entry });
  const driver = new PumpDriver(entry, { onEvent: () => undefined, onTerminal: () => undefined });
  const propose = () => {
    const result = port.route('ExitPlanMode', { plan: PLAN, allowedPrompts: PROMPTS }, { signal: new AbortController().signal, toolUseID: 'toolu_p' })!;
    const id = port.pending().find((event) => event.kind === 'plan_approval')!.interactionId;
    return { result, id };
  };
  return { rpc, registry, entry, session, port, events, fake, driver, propose };
}

type Handler = (call: { request: never }, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => void;
function call<T>(handler: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => handler({ request: request as never }, (err, res) => err ? reject(err) : resolve(res as T)));
}
function refusal(code: ErrorCode, reason: string) {
  return (err: grpc.ServiceError) => {
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, code);
    assert.equal(detail.reason, reason);
    return true;
  };
}
const approve = (id: string, mode = PlanExecutionMode.PLAN_EXECUTION_MODE_MANUAL, commandId = 'c') =>
  ResolveInteractionRequest.fromPartial({ sessionId: 's', commandId, interactionId: id, approve: { mode, planSha256: DIGEST } });

test('a plan arrives as InteractionRequested PLAN_APPROVAL with plan, digest and allowed prompts', async () => {
  const h = setup();
  const { result, id } = h.propose();
  await h.driver.tick();
  const replay = h.entry.ringBuffer.replay({ mode: 'available_history' });
  assert.equal(replay.kind, 'ok');
  assert.ok(replay.kind === 'ok');
  const requested = translateEvent(replay.events[0].event).interactionRequested!;
  const wire = SessionEvent.decode(SessionEvent.encode(SessionEvent.fromPartial({ interactionRequested: requested })).finish()).interactionRequested!;
  assert.equal(wire.kind, InteractionKind.INTERACTION_KIND_PLAN_APPROVAL);
  assert.equal(wire.interactionId, id);
  assert.equal(wire.toolUseId, 'toolu_p');
  assert.equal(wire.questions, undefined);
  assert.deepEqual(wire.plan, { plan: PLAN, planSha256: DIGEST, allowedPrompts: PROMPTS });
  h.port.failAll('session_closed');
  await result;
});

test('approve and keep_planning settle with kind, outcome, mode_after and feedback', async () => {
  for (const mode of [PlanExecutionMode.PLAN_EXECUTION_MODE_MANUAL, PlanExecutionMode.PLAN_EXECUTION_MODE_AUTO, PlanExecutionMode.PLAN_EXECUTION_MODE_BYPASS]) {
    const h = setup();
    const { result, id } = h.propose();
    assert.deepEqual(await call(h.rpc.resolveInteraction, approve(id, mode)), { outcome: InteractionOutcome.INTERACTION_OUTCOME_APPROVED });
    assert.deepEqual(await result, { behavior: 'allow' });
    const resolved = translateEvent(h.events.at(-1)!).interactionResolved!;
    assert.equal(resolved.kind, InteractionKind.INTERACTION_KIND_PLAN_APPROVAL);
    assert.equal(resolved.outcome, InteractionOutcome.INTERACTION_OUTCOME_APPROVED);
    assert.equal(resolved.modeAfter, mode);
    assert.equal(resolved.feedback, undefined);
  }
  for (const feedback of ['', 'Include a migration.\u202e', 'Full feedback. '.repeat(500)]) {
    const h = setup();
    const { result, id } = h.propose();
    await call(h.rpc.resolveInteraction, ResolveInteractionRequest.fromPartial({ sessionId: 's', commandId: 'c', interactionId: id, keepPlanning: { feedback } }));
    const model = await result;
    assert.equal(model.behavior, 'deny');
    if (feedback !== '') assert.ok(model.behavior === 'deny' && model.message.includes(feedback));
    const resolved = translateEvent(h.events.at(-1)!).interactionResolved!;
    const wire = SessionEvent.decode(SessionEvent.encode(SessionEvent.fromPartial({ interactionResolved: resolved })).finish()).interactionResolved!;
    assert.equal(wire.kind, InteractionKind.INTERACTION_KIND_PLAN_APPROVAL);
    assert.equal(wire.outcome, InteractionOutcome.INTERACTION_OUTCOME_KEPT_PLANNING);
    assert.equal(wire.modeAfter, undefined);
    assert.equal(wire.feedback, feedback);
  }
});

test('ResolveInteraction is idempotent per command id and conflicts on another payload', async () => {
  const h = setup();
  const { result, id } = h.propose();
  const request = approve(id);
  const first = await call(h.rpc.resolveInteraction, request);
  assert.deepEqual(await call(h.rpc.resolveInteraction, request), first);
  await assert.rejects(call(h.rpc.resolveInteraction, approve(id, PlanExecutionMode.PLAN_EXECUTION_MODE_AUTO)), refusal(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''));
  assert.equal(h.events.filter((event) => event.type === 'interaction_resolved').length, 1);
  await result;
});

test('a question arm on a plan is kind_mismatch and the plan keeps waiting', async () => {
  const h = setup();
  const { result, id } = h.propose();
  await assert.rejects(call(h.rpc.resolveInteraction, ResolveInteractionRequest.fromPartial({ sessionId: 's', commandId: 'c', interactionId: id, answers: { answers: [] } })), refusal(ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, 'kind_mismatch'));
  assert.equal(h.port.pending()[0].interactionId, id);
  await call(h.rpc.resolveInteraction, approve(id));
  await result;
});

test('invalid execution modes and a stale digest leave the plan waiting and the command reusable', async () => {
  const h = setup();
  const { result, id } = h.propose();
  for (const mode of [PlanExecutionMode.PLAN_EXECUTION_MODE_UNSPECIFIED, 12345, -1]) {
    await assert.rejects(call(h.rpc.resolveInteraction, approve(id, mode)), refusal(ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, 'plan_mode_unspecified'));
  }
  const stale = approve(id);
  stale.approve!.planSha256 = '0'.repeat(64);
  await assert.rejects(call(h.rpc.resolveInteraction, stale), refusal(ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, 'plan_digest_mismatch'));
  assert.equal(h.port.pending().length, 1);
  await call(h.rpc.resolveInteraction, approve(id));
  await result;
});

test('GetInteractionState lists a waiting plan beside a waiting question', async () => {
  const h = setup();
  const question = h.port.route('AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] }, { signal: new AbortController().signal })!;
  const { result, id } = h.propose();
  const state = await call<GetInteractionStateResponse>(h.rpc.getInteractionState, { sessionId: 's' });
  assert.equal(state.throughSequence, 0n);
  assert.deepEqual(state.pending.map((event) => event.kind), [InteractionKind.INTERACTION_KIND_QUESTION, InteractionKind.INTERACTION_KIND_PLAN_APPROVAL]);
  assert.equal(state.pending[1].interactionId, id);
  assert.equal(state.pending[1].plan!.plan, PLAN);
  h.port.failAll('session_closed');
  await Promise.all([question, result]);
});

test('ResolvePermission and a switch never settle a plan', async () => {
  const h = setup();
  const { result, id } = h.propose();
  const impl = createRuntimeServiceImpl(h.registry, () => h.session, { sdkDeclared: 'fake', hostCli: '2.1.311' });
  await assert.rejects(call(impl.resolvePermission, { sessionId: 's', commandId: 'p', permissionId: id, allow: true }), refusal(ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND, ''));
  assert.equal(h.port.pending().length, 1);
  h.fake.controller.makeNextSetPermissionModeReject(new PermissionModeError('refused', 'this session uses planning; its permission mode is not switchable', 'plan_session'));
  await assert.rejects(call(impl.setPermissionMode, { sessionId: 's', commandId: 'm', mode: PermissionMode.PERMISSION_MODE_BYPASS }), refusal(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'set_permission_mode_plan_session'));
  assert.equal(h.port.pending().length, 1);
  await call(h.rpc.resolveInteraction, approve(id));
  await result;
});

test('plan refusal reasons are bounded while plan text and feedback stay whole', () => {
  const reason = 'x'.repeat(10_000);
  const requested = translateEvent({ type: 'interaction_requested', interactionId: 'i', toolUseId: 't', kind: 'plan_approval', unsupportedReason: reason }).interactionRequested!;
  assert.ok(requested.unsupportedReason!.length < reason.length);
  const resolved = translateEvent({ type: 'interaction_resolved', interactionId: 'i', kind: 'plan_approval', outcome: 'host_refused', reason }).interactionResolved!;
  assert.equal(resolved.kind, InteractionKind.INTERACTION_KIND_PLAN_APPROVAL);
  assert.ok(resolved.reason!.length < reason.length);
});
