import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';
import { createSession, PermissionModeError, PLANNING_SWITCH_TIMEOUT_MS, PlanningError, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClientInteractions, InteractionRequestedEvent } from '../src/types.js';

/**
 * `setPlanning`: a plan session's own move into and out of plan mode. The CLI acknowledges the switch
 * and then reports the move itself in a status frame; the session passes that report on and never makes
 * one of its own (CLI 2.1.311: the acknowledgement, then one `system/status` with the new mode).
 */

const PROMPTING: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true };
const AUTO: ClaudeHostPolicy = { ...PROMPTING, cliPermissionMode: 'auto' };
const DEFAULT: ClaudeHostPolicy = { ...PROMPTING, cliPermissionMode: 'default' };
const PLAN: ClientInteractions = { questions: false, planMode: true };

const status = (permissionMode: string) => ({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: 'u', session_id: 'c1' }) as unknown as SDKMessage;
const toolResult = (toolUseId: string, text: string) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, parent_tool_use_id: null, uuid: `r-${toolUseId}`, session_id: 'c1' }) as unknown as SDKMessage;

function setup(policy: ClaudeHostPolicy = AUTO, clientInteractions: ClientInteractions = PLAN, queryOptions: FakeQueryOptions = {}) {
  let options: Options | undefined;
  const { query, controller } = makeFakeQuery(queryOptions);
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return query;
  };
  const session = createSession({ cwd: '/w', policy, clientInteractions }, queryFn, { onDiagnostic: () => {} });
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
  return { session, controller, options: options!, feed };
}

const reported = (events: ClaudeRuntimeEvent[]) => events.filter((event) => event.type === 'cli_mode_reported');
const switched = (events: ClaudeRuntimeEvent[]) => events.filter((event) => event.type === 'permission_mode_changed');

async function planningError(promise: Promise<unknown>): Promise<PlanningError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlanningError, `expected a PlanningError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected setPlanning to fail');
}

test('entering calls setPermissionMode plan and leaves the report to the CLI', async () => {
  const { session, controller, feed } = setup();
  assert.deepEqual(await session.setPlanning(true), { permissionMode: 'plan' });
  assert.deepEqual(controller.setPermissionModeCalls, ['plan']);
  const before = await feed();
  assert.deepEqual(reported(before), [], 'nothing is reported on the acknowledgement alone');
  assert.deepEqual(switched(before), [], 'the host policy did not change');
  assert.deepEqual(reported(await feed(status('plan'))), [{ type: 'cli_mode_reported', permissionMode: 'plan' }]);
  assert.deepEqual(reported(await feed(status('plan'))), [], 'the same mode again');
  session.close();
});

test('the host switch is reported from the CLI\'s status frame only', async () => {
  // Leaving too: the acknowledgement says nothing, the status frame says auto, once.
  const { session, feed } = setup();
  await feed(status('plan'));
  assert.deepEqual(await session.setPlanning(false), { permissionMode: 'auto' });
  assert.deepEqual(reported(await feed()), []);
  assert.deepEqual(reported(await feed(status('auto'))), [{ type: 'cli_mode_reported', permissionMode: 'auto' }]);
  session.close();
});

test('leaving restores the creation mode, auto or default', async () => {
  for (const [policy, creation] of [
    [AUTO, 'auto'],
    [DEFAULT, 'default'],
  ] as const) {
    const { session, controller, feed } = setup(policy);
    await session.setPlanning(true);
    await feed(status('plan'));
    assert.deepEqual(await session.setPlanning(false), { permissionMode: creation });
    assert.deepEqual(controller.setPermissionModeCalls, ['plan', creation]);
    assert.deepEqual(switched(await feed(status(creation))), []);
    session.close();
  }
});

test('each refusal reason', async () => {
  // Not a plan session: no opt-in, or one that cannot be honoured.
  for (const [policy, clientInteractions] of [
    [AUTO, { questions: false }],
    [AUTO, { questions: true }],
    [PROMPTING, PLAN],
  ] as const) {
    const { session, controller } = setup(policy, clientInteractions);
    const error = await planningError(session.setPlanning(true));
    assert.equal(error.kind, 'refused');
    assert.equal(error.reason, 'planning_not_offered');
    assert.deepEqual(controller.setPermissionModeCalls, []);
    session.close();
  }
  // A turn is running.
  {
    const { session, controller } = setup();
    session.sendTurn('hello');
    const error = await planningError(session.setPlanning(true));
    assert.deepEqual([error.kind, error.reason], ['refused', 'planning_turn_running']);
    assert.deepEqual(controller.setPermissionModeCalls, []);
    session.close();
  }
  // A plan is waiting for the person.
  {
    const { session, controller, options, feed } = setup();
    await feed(status('plan'));
    const answer = options.canUseTool!('ExitPlanMode', { plan: '# Plan' }, { signal: new AbortController().signal, toolUseID: 'toolu_p', suggestions: [] } as never);
    const [requested] = (await session.pump()).filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
    assert.ok(requested !== undefined);
    const error = await planningError(session.setPlanning(false));
    assert.deepEqual([error.kind, error.reason], ['refused', 'planning_interaction_pending']);
    assert.deepEqual(controller.setPermissionModeCalls, []);
    session.close();
    await answer;
  }
  // Already where it was asked to go.
  {
    const { session, controller, feed } = setup();
    const leave = await planningError(session.setPlanning(false));
    assert.deepEqual([leave.kind, leave.reason], ['refused', 'planning_already']);
    await feed(status('plan'));
    const enter = await planningError(session.setPlanning(true));
    assert.deepEqual([enter.kind, enter.reason], ['refused', 'planning_already']);
    assert.deepEqual(controller.setPermissionModeCalls, []);
    session.close();
  }
  // Closed.
  {
    const { session } = setup();
    session.close();
    const error = await planningError(session.setPlanning(true));
    assert.equal(error.kind, 'closed');
  }
});

test('a CLI refusal is provider_refused and changes nothing', async () => {
  let refuse = true;
  const { session, controller, feed } = setup(AUTO, PLAN, {
    setPermissionMode: async () => {
      if (refuse) throw new Error('Cannot set permission mode to plan');
    },
  });
  const error = await planningError(session.setPlanning(true));
  assert.equal(error.kind, 'provider_refused');
  assert.match(error.reason, /Cannot set permission mode to plan/);
  const events = await feed();
  assert.deepEqual(reported(events), []);
  assert.deepEqual(switched(events), []);
  // Nothing was assumed: entering is still possible, and goes through.
  refuse = false;
  assert.deepEqual(await session.setPlanning(true), { permissionMode: 'plan' });
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'plan']);
  session.close();
});

test('a switch the CLI never acknowledges times out after 15 s', async () => {
  const { session, controller } = setup(AUTO, PLAN, { setPermissionMode: () => new Promise<void>(() => {}) });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(PLANNING_SWITCH_TIMEOUT_MS, 15_000);
    let outcome: unknown;
    const pending = session.setPlanning(true).then(
      (value) => (outcome = value),
      (error: unknown) => (outcome = error),
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(controller.setPermissionModeCalls, ['plan'] as PermissionMode[]);
    mock.timers.tick(PLANNING_SWITCH_TIMEOUT_MS - 1);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const settledYet = () => outcome !== undefined;
    assert.equal(settledYet(), false, 'still waiting a millisecond before the limit');
    mock.timers.tick(1);
    await pending;
    assert.ok(outcome instanceof PlanningError);
    assert.equal(outcome.kind, 'timed_out');
  } finally {
    mock.timers.reset();
  }
  // The chain is free again: the next request reaches the CLI.
  void session.setPlanning(true).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'plan'] as PermissionMode[]);
  session.close();
});

test('a leave queued behind an enter switches back before the plan report is read', async () => {
  // Both asked at once on a fresh auto session: the enter is acknowledged, its status frame is not read
  // yet, and the leave must still go to the CLI rather than be refused as already out of plan.
  const { session, controller, feed } = setup();
  const enter = session.setPlanning(true);
  const leave = session.setPlanning(false);
  assert.deepEqual(await enter, { permissionMode: 'plan' });
  assert.deepEqual(await leave, { permissionMode: 'auto' });
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'auto']);
  // Nothing was reported ahead of the CLI; its own frames are reported as they come.
  assert.deepEqual(reported(await feed()), []);
  assert.deepEqual(reported(await feed(status('plan'), status('auto'))), [
    { type: 'cli_mode_reported', permissionMode: 'plan' },
    { type: 'cli_mode_reported', permissionMode: 'auto' },
  ]);
  // Once read, the reports are what the next switch is judged by.
  const again = await planningError(session.setPlanning(false));
  assert.deepEqual([again.kind, again.reason], ['refused', 'planning_already']);
  session.close();
});

test('a stale report cannot retire a newer acknowledgement: enter, leave, enter, two frames read', async () => {
  // Three switches acknowledged before any frame is read; the first enter's plan and the leave's auto are
  // read, the last enter's plan is not. The CLI is planning, so a leave must go to it.
  const { session, controller, feed } = setup();
  await session.setPlanning(true);
  await session.setPlanning(false);
  await session.setPlanning(true);
  await feed(status('plan'), status('auto'));
  assert.deepEqual(await session.setPlanning(false), { permissionMode: 'auto' });
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'auto', 'plan', 'auto']);
  // The rest of the frames come in order; then the reports alone say where the CLI is.
  await feed(status('plan'), status('auto'));
  const again = await planningError(session.setPlanning(false));
  assert.equal(again.reason, 'planning_already');
  session.close();
});

test('a frame that does not match the oldest acknowledgement retires nothing', async () => {
  // Enter and leave acknowledged; an auto frame from before them is read first. The enter is still
  // unreported, then each frame retires its own switch in order.
  const { session, controller, feed } = setup();
  await session.setPlanning(true);
  await session.setPlanning(false);
  await feed(status('auto'));
  // By the newest acknowledgement the CLI is out of plan: entering goes to the CLI.
  assert.deepEqual(await session.setPlanning(true), { permissionMode: 'plan' });
  await feed(status('plan'), status('auto'), status('plan'));
  const already = await planningError(session.setPlanning(true));
  assert.equal(already.reason, 'planning_already');
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'auto', 'plan']);
  session.close();
});

test('an older frame read after an acknowledged switch does not undo it', async () => {
  // An auto frame queued before the enter's acknowledgement is read after it: the enter still stands.
  const { session, controller } = setup();
  controller.emit(status('auto'));
  await session.setPlanning(true);
  for (let i = 0; i < 3; i += 1) await session.pump();
  assert.deepEqual(await session.setPlanning(false), { permissionMode: 'auto' });
  assert.deepEqual(controller.setPermissionModeCalls, ['plan', 'auto']);
  session.close();
});

test('the old setPermissionMode refuses on a plan session', async () => {
  for (const policy of [AUTO, DEFAULT]) {
    const { session, controller } = setup(policy);
    for (const mode of ['interactive', 'bypass', 'verdandi_rules'] as const) {
      await assert.rejects(session.setPermissionMode(mode), (error: unknown) => {
        assert.ok(error instanceof PermissionModeError);
        assert.equal(error.kind, 'refused');
        assert.equal(error.message, 'this session uses planning; its permission mode is not switchable');
        assert.equal(error.reason, 'plan_session');
        return true;
      });
    }
    assert.deepEqual(controller.setPermissionModeCalls, []);
    session.close();
  }
});

test('entry is reported from the status frame, not the tool result', async () => {
  // The CLI sends `system/status` plan before EnterPlanMode's tool result; the result itself says nothing.
  const { session, feed } = setup();
  assert.deepEqual(reported(await feed(toolResult('toolu_e', 'Entered plan mode. You should now focus on exploring the codebase.'))), []);
  assert.deepEqual(reported(await feed(status('plan'), toolResult('toolu_e2', 'Entered plan mode.'))), [{ type: 'cli_mode_reported', permissionMode: 'plan' }]);
  session.close();
});

test('an exit that lands in the creation mode is not switched again', async () => {
  // An approved ExitPlanMode: the CLI's status frame says the creation mode, then the tool result comes.
  for (const [policy, creation] of [
    [AUTO, 'auto'],
    [DEFAULT, 'default'],
  ] as const) {
    const { session, controller, options, feed } = setup(policy);
    await feed(status('plan'));
    const answer = options.canUseTool!('ExitPlanMode', { plan: '# Plan' }, { signal: new AbortController().signal, toolUseID: 'toolu_x', suggestions: [] } as never);
    const [requested] = (await session.pump()).filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
    session.interactions()!.resolve(requested.interactionId, { kind: 'plan_approve', mode: 'auto', planSha256: requested.plan!.planSha256 });
    assert.deepEqual(await answer, { behavior: 'allow' });
    const events = await feed(status(creation), toolResult('toolu_x', 'User has approved your plan.'));
    assert.deepEqual(reported(events), [{ type: 'cli_mode_reported', permissionMode: creation }]);
    assert.deepEqual(controller.setPermissionModeCalls, [], 'the session does not move the CLI after an approval');
    session.close();
  }
});
