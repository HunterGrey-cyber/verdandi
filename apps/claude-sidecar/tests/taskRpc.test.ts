import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { TaskNotFoundError, TaskOutputUnavailableError } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { CreateSessionRequest, ErrorCode, ErrorDetail, GetTaskOutputRequest, StopTaskRequest } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * StopTask and GetTaskOutput at the handler: the session lookup, StopTask's idempotency per command id
 * (a replay, a conflict, a duplicate joining the call in flight, nothing recorded for a refusal), the
 * kernel's refusals as wire error codes, and the `task_output` capability following the process fact.
 */

type Handler = (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void;

function rpc<T>(fn: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => fn({ request }, (err, res) => (err ? reject(err) : resolve(res as T))));
}

function refusedWith(code: grpc.status, errorCode: ErrorCode) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, code);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, errorCode);
    return true;
  };
}

/** Closed at the end, so no session's pump outlives the file. */
const createdSessions: MinimalKernelSession[] = [];
after(async () => {
  for (const session of createdSessions) session.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

async function setup(options: { taskOutputRead?: boolean } = {}) {
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    () => {
      const fake = makeFakeSession();
      made.push(fake);
      createdSessions.push(fake.session);
      return fake.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' },
    { sdkBundledAvailable: true, ...options },
  );
  const { sessionId } = await rpc<{ sessionId: string }>(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  return { impl, sessionId, controller: made[0].controller };
}

const stop = (sessionId: string, commandId: string, taskId: string) => StopTaskRequest.fromPartial({ sessionId, commandId, taskId });

test('StopTask: the same command id again answers the first outcome without reaching the session', async () => {
  const { impl, sessionId, controller } = await setup();
  await rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b1'));
  await rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b1'));
  assert.deepEqual(controller.stopTaskCalls, ['b1']);
  await rpc(impl.stopTask as Handler, stop(sessionId, 'c2', 'b1'));
  assert.deepEqual(controller.stopTaskCalls, ['b1', 'b1'], 'a new command id is a new stop');
});

test('StopTask: another task under the same command id is IDEMPOTENCY_CONFLICT, recorded or still in flight', async () => {
  const { impl, sessionId, controller } = await setup();
  await rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b1'));
  await assert.rejects(rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b2')), refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT));
  let release!: () => void;
  controller.answerStopTask(() => new Promise<void>((resolve) => (release = resolve)));
  const first = rpc(impl.stopTask as Handler, stop(sessionId, 'c2', 'b1'));
  await assert.rejects(rpc(impl.stopTask as Handler, stop(sessionId, 'c2', 'b2')), refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.deepEqual(controller.stopTaskCalls, ['b1', 'b1']);
});

test('StopTask: a duplicate that arrives while the first waits on the CLI joins it, and the CLI hears one stop', async () => {
  const { impl, sessionId, controller } = await setup();
  let release!: () => void;
  controller.answerStopTask(() => new Promise<void>((resolve) => (release = resolve)));
  const first = rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'w1'));
  const second = rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'w1'));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(controller.stopTaskCalls, ['w1']);
});

test('StopTask: a refusal records nothing, so the same command id may be sent again', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerStopTask((taskId) => Promise.reject(new TaskNotFoundError(taskId)));
  await assert.rejects(rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b9')), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_TASK_NOT_FOUND));
  controller.answerStopTask(async () => {});
  await rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b9'));
  assert.deepEqual(controller.stopTaskCalls, ['b9', 'b9']);
});

test('the task RPCs: the kernel\'s refusals and an unknown session as their wire codes', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerTaskOutput((taskId) => Promise.reject(new TaskNotFoundError(taskId)));
  await assert.rejects(
    rpc(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'nope' })),
    refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_TASK_NOT_FOUND),
  );
  controller.answerTaskOutput((taskId) => Promise.reject(new TaskOutputUnavailableError(taskId, 'no_output_path')));
  await assert.rejects(
    rpc(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1' })),
    refusedWith(grpc.status.FAILED_PRECONDITION, ErrorCode.ERROR_CODE_TASK_OUTPUT_UNAVAILABLE),
  );
  // Whatever else the CLI or SDK throws is a provider error, never an unmapped status.
  controller.answerStopTask(() => Promise.reject(new Error('stop_task failed')));
  await assert.rejects(rpc(impl.stopTask as Handler, stop(sessionId, 'c1', 'b1')), refusedWith(grpc.status.INTERNAL, ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR));
  for (const [handler, request] of [
    [impl.stopTask, stop('no-such-session', 'c1', 'b1')],
    [impl.getTaskOutput, GetTaskOutputRequest.fromPartial({ sessionId: 'no-such-session', taskId: 'b1' })],
  ] as const) {
    await assert.rejects(rpc(handler as Handler, request), refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND));
  }
});

test('GetTaskOutput: the tail as bytes, the whole size and the cut', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerTaskOutput(async () => ({ output: new Uint8Array([0x78, 0x0a]), totalBytes: 20000, truncated: true }));
  const read = await rpc<{ output: Buffer; totalBytes: bigint; truncated: boolean }>(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1' }));
  assert.deepEqual([...read.output], [0x78, 0x0a]);
  assert.equal(read.totalBytes, 20000n);
  assert.equal(read.truncated, true);
  assert.deepEqual(controller.taskOutputCalls, ['b1']);
});

test('handshake: task_control always; task_output only with the process fact behind it', async () => {
  for (const taskOutputRead of [true, false, undefined]) {
    const { impl } = await setup(taskOutputRead === undefined ? {} : { taskOutputRead });
    const { capabilities } = await rpc<{ capabilities: string[] }>(impl.handshake as Handler, { clientProtocolMajor: 3 });
    assert.ok(capabilities.includes('task_control'), String(taskOutputRead));
    assert.equal(capabilities.includes('task_output'), taskOutputRead === true, String(taskOutputRead));
    if (taskOutputRead === true) assert.equal(capabilities.indexOf('task_output'), capabilities.indexOf('task_control') + 1);
  }
});
