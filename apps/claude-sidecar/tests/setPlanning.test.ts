import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { PlanningError } from '@verdandi/claude-runtime';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { makeFakeSession } from './fakeSession.js';
import { ErrorCode, ErrorDetail, type SetPlanningRequest, type SetPlanningResponse } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

function setup(run: (enter: boolean) => Promise<SetPlanningResponse>) {
  const registry = new SessionRegistry();
  const calls: boolean[] = [];
  const fake = makeFakeSession();
  registry.create('s', Object.assign(fake.session, {
    setPlanning(enter: boolean) { calls.push(enter); return run(enter); },
  }), 64);
  const impl = createRuntimeServiceImpl(registry, () => fake.session, { sdkDeclared: 'fake', hostCli: '2.1.311' });
  const call = (enter: boolean, commandId = 'c', sessionId = 's') => new Promise<SetPlanningResponse>((resolve, reject) =>
    impl.setPlanning({ request: { sessionId, commandId, enter } satisfies SetPlanningRequest }, (err, res) => err ? reject(err) : resolve(res as SetPlanningResponse)));
  return { call, calls, registry };
}
function refusedWith(status: grpc.status, code: ErrorCode, reason: string, message?: string) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, status);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, code);
    assert.equal(detail.reason, reason);
    if (message !== undefined) assert.ok(err.message.includes(message));
    return true;
  };
}

test('enter and leave answer the acknowledged mode', async () => {
  const h = setup(async (enter) => ({ permissionMode: enter ? 'plan' : 'auto' }));
  assert.deepEqual(await h.call(true, 'enter'), { permissionMode: 'plan' });
  assert.deepEqual(await h.call(false, 'leave'), { permissionMode: 'auto' });
  assert.deepEqual(h.calls, [true, false]);
  assert.equal(h.registry.get('s')!.sequence, 0n, 'an acknowledgement invents no mode event');
});

test('each refusal maps to its code and reason', async () => {
  const cases: Array<[PlanningError, grpc.status, ErrorCode, string]> = [
    ...['planning_not_offered', 'planning_interaction_pending', 'planning_already'].map((reason): [PlanningError, grpc.status, ErrorCode, string] => [new PlanningError('refused', reason), grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, reason]),
    [new PlanningError('refused', 'planning_turn_running'), grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE, 'planning_turn_running'],
    [new PlanningError('provider_refused', 'Cannot set permission mode to plan'), grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'planning_cli_refused'],
    [new PlanningError('timed_out', 'not acknowledged'), grpc.status.DEADLINE_EXCEEDED, ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED, ''],
    [new PlanningError('closed', 'session is closed'), grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, ''],
  ];
  for (const [error, status, code, reason] of cases) {
    let fail = true;
    const h = setup(async () => {
      if (fail) throw error;
      return { permissionMode: 'plan' };
    });
    await assert.rejects(h.call(true), refusedWith(status, code, reason, error.message));
    fail = false;
    assert.deepEqual(await h.call(true), { permissionMode: 'plan' }, 'a refusal leaves the command id reusable');
    assert.equal(h.calls.length, 2);
  }
  const h = setup(async () => ({ permissionMode: 'plan' }));
  await assert.rejects(h.call(true, 'c', 'missing'), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, ''));
  assert.deepEqual(h.calls, []);
});

test('a retry with the same command id replays', async () => {
  let acknowledge!: (response: SetPlanningResponse) => void;
  const h = setup(() => new Promise((resolve) => { acknowledge = resolve; }));
  const first = h.call(true);
  const duplicate = h.call(true);
  await assert.rejects(h.call(false), refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''));
  assert.deepEqual(h.calls, [true]);
  acknowledge({ permissionMode: 'plan' });
  assert.deepEqual(await first, { permissionMode: 'plan' });
  assert.deepEqual(await duplicate, { permissionMode: 'plan' });
  assert.deepEqual(await h.call(true), { permissionMode: 'plan' });
  assert.deepEqual(h.calls, [true]);
  await assert.rejects(h.call(false), refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, ''));
});

test('SetPlanning command ids are independent across sessions and other RPCs', async () => {
  const h = setup(async () => ({ permissionMode: 'plan' }));
  await h.call(true);
  const other = makeFakeSession();
  h.registry.create('other', Object.assign(other.session, { setPlanning: async () => ({ permissionMode: 'default' }) }), 64);
  assert.deepEqual(await h.call(false, 'c', 'other'), { permissionMode: 'default' });
  const entry = h.registry.get('s')!;
  assert.equal(entry.settingsIdempotency.check('set_model:c', 'anything').kind, 'first_call');
  assert.equal(entry.setPermissionModeIdempotency.check('c', 'anything').kind, 'first_call');
});
