import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SessionSettingsError, type AppliedSettings } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { translateEvent } from '../src/eventTranslation.js';
import { ApplyEffortRequest, CreateSessionRequest, ErrorCode, ErrorDetail, GetTaskOutputRequest, ListModelsRequest, SessionEvent, SetModelRequest } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { compileProto, modelOf, type FieldModel, type ProtoModel } from './compat/protoModel.js';
import { CURRENT_PROTO } from './compat/paths.js';
import * as old from './compat/b3aa188/generated/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * Protocol 3.24's wire and handlers: each new field, message and RPC at its number, an old client reading
 * past them, the changes' idempotency per command id, and the kernel's refusals as wire errors.
 */

const PKG = 'verdandi.claude.runtime.v1';
const T = `.${PKG}.`;
const live: ProtoModel = modelOf(compileProto(CURRENT_PROTO));

function describe(field: FieldModel): string {
  return `${field.label} ${field.typeName === '' ? field.type : field.typeName} ${field.name} = ${field.number}${field.oneof !== undefined ? ` (oneof ${field.oneof})` : ''}`;
}

function fieldsOf(message: string, numbers?: number[]): string[] {
  const model = live.messages.get(`${PKG}.${message}`);
  assert.ok(model !== undefined, `message ${message}`);
  return [...model.fields.values()].filter((f) => numbers === undefined || numbers.includes(f.number)).map(describe);
}

const one = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number}`;

test('3.24: the new fields of existing messages are at their numbers', () => {
  assert.deepEqual(fieldsOf('SessionReady', [13]), [one('string', 'effort', 13)]);
  assert.deepEqual(fieldsOf('GetTaskOutputRequest', [4]), [one('uint32', 'max_bytes', 4)]);
  assert.deepEqual(fieldsOf('GetTaskOutputResponse', [4]), [one('uint64', 'offset', 4)]);
  assert.equal(fieldsOf('GetTaskOutputRequest', [3]).length, 1);
  assert.match(fieldsOf('GetTaskOutputRequest', [3])[0], /uint64 offset = 3/);
  assert.deepEqual(fieldsOf('SessionEvent', [52, 53, 54, 55, 56, 57, 58, 59, 60]), [`optional ${T}CliModeReported cli_mode_reported = 60 (oneof event)`]);
});

test('3.24: the new messages carry exactly their fields', () => {
  const expected: Record<string, string[]> = {
    AppliedSettings: [one('string', 'model', 1), one('string', 'effort', 2)],
    SetModelRequest: [one('string', 'session_id', 1), one('string', 'command_id', 2), one('string', 'model', 3)],
    SetModelResponse: [one(`${T}AppliedSettings`, 'applied', 1)],
    ListModelsRequest: [one('string', 'session_id', 1)],
    ModelOption: [
      one('string', 'value', 1), one('string', 'resolved_model', 2), one('string', 'display_name', 3), one('string', 'description', 4),
      one('bool', 'supports_effort', 5), `repeated string supported_effort_levels = 6`, one('bool', 'supports_auto_mode', 7),
    ],
    ListModelsResponse: [`repeated ${T}ModelOption models = 1`, one(`${T}AppliedSettings`, 'applied', 2)],
    ApplyEffortRequest: [one('string', 'session_id', 1), one('string', 'command_id', 2), one('string', 'effort', 3)],
    ApplyEffortResponse: [one(`${T}AppliedSettings`, 'applied', 1)],
    CliModeReported: [one('string', 'permission_mode', 1)],
  };
  for (const [message, fields] of Object.entries(expected)) assert.deepEqual(fieldsOf(message), fields, message);
});

test('3.24: the three new RPCs are in the service with their request and response types', () => {
  const service = live.services.get(`${PKG}.RuntimeService`);
  assert.ok(service !== undefined);
  for (const [name, input, output] of [
    ['SetModel', 'SetModelRequest', 'SetModelResponse'],
    ['ListModels', 'ListModelsRequest', 'ListModelsResponse'],
    ['ApplyEffort', 'ApplyEffortRequest', 'ApplyEffortResponse'],
  ] as const) {
    assert.deepEqual(service.get(name), { name, input: `${T}${input}`, output: `${T}${output}`, clientStreaming: false, serverStreaming: false }, name);
  }
});

test('3.24: an old client decodes CliModeReported as an event with no arm, keeping the envelope', () => {
  const bytes = SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's', sequence: 7n, cliModeReported: { permissionMode: 'default' } })).finish();
  const decoded = old.SessionEvent.decode(bytes);
  assert.equal(decoded.sessionId, 's');
  assert.equal(decoded.sequence, 7n);
  assert.equal(Object.values(decoded).filter((value) => value !== undefined && typeof value === 'object').length, 0);
});

test('3.24: the kernel\'s report and the effort reach the wire, cut like other short words', () => {
  assert.deepEqual(translateEvent({ type: 'cli_mode_reported', permissionMode: 'default' }), { cliModeReported: { permissionMode: 'default' } });
  const ready = translateEvent({ type: 'session_ready', sessionId: 's', providerSessionId: 'p', model: 'm', cwd: '/', permissionMode: 'auto', effort: 'high' });
  assert.equal(ready.sessionReady?.effort, 'high');
  const none = translateEvent({ type: 'session_ready', sessionId: 's', providerSessionId: 'p', model: 'm', cwd: '/', permissionMode: 'auto' });
  assert.equal(none.sessionReady?.effort, '');
});

// ---- The handlers ---------------------------------------------------------------------------------------------------

type Handler = (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void;

function rpc<T>(fn: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => fn({ request }, (err, res) => (err ? reject(err) : resolve(res as T))));
}

function refusedWith(errorCode: ErrorCode, reason?: string, words?: string) {
  return (err: grpc.ServiceError) => {
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, errorCode);
    if (reason !== undefined) assert.equal(detail.reason, reason);
    if (words !== undefined) assert.ok(detail.message.includes(words), detail.message);
    return true;
  };
}

const createdSessions: MinimalKernelSession[] = [];
after(async () => {
  for (const session of createdSessions) session.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

async function setup() {
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
    { sdkBundledAvailable: true },
  );
  const { sessionId } = await rpc<{ sessionId: string }>(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  return { impl, sessionId, controller: made[0].controller };
}

const setModel = (sessionId: string, commandId: string, model: string) => SetModelRequest.fromPartial({ sessionId, commandId, model });
const applyEffort = (sessionId: string, commandId: string, effort: string) => ApplyEffortRequest.fromPartial({ sessionId, commandId, effort });
type Applied = { applied: AppliedSettings };

test('SetModel answers what the CLI will use, and the same command id again does not reach the session', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerSetModel(async () => ({ model: 'claude-sonnet-5-5', effort: 'medium' }));
  const first = await rpc<Applied>(impl.setModel as Handler, setModel(sessionId, 'c1', 'sonnet'));
  assert.deepEqual(first.applied, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(await rpc<Applied>(impl.setModel as Handler, setModel(sessionId, 'c1', 'sonnet')), first);
  assert.deepEqual(controller.setModelCalls, ['sonnet']);
});

test('SetModel: another model under the same command id is a conflict', async () => {
  const { impl, sessionId } = await setup();
  await rpc(impl.setModel as Handler, setModel(sessionId, 'c1', 'sonnet'));
  await assert.rejects(rpc(impl.setModel as Handler, setModel(sessionId, 'c1', 'opus')), refusedWith(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT));
});

test('SetModel: a duplicate joins the call in flight, and the id is the model\'s alone: an effort may use it', async () => {
  const { impl, sessionId, controller } = await setup();
  let release = (_: AppliedSettings) => {};
  controller.answerSetModel(() => new Promise((resolve) => (release = resolve)));
  const first = rpc<Applied>(impl.setModel as Handler, setModel(sessionId, 'c1', 'sonnet'));
  const second = rpc<Applied>(impl.setModel as Handler, setModel(sessionId, 'c1', 'sonnet'));
  assert.equal((await rpc<Applied>(impl.applyEffort as Handler, applyEffort(sessionId, 'c1', 'low'))).applied.effort, 'low');
  await new Promise((resolve) => setImmediate(resolve));
  release({ model: 'm', effort: '' });
  assert.deepEqual(await first, await second);
  assert.deepEqual(controller.setModelCalls, ['sonnet']);
});

test('SetModel: the CLI\'s refusal reaches the client in its own words, and the id may be sent again', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerSetModel(async () => {
    throw new SessionSettingsError('provider_refused', "Model 'x' not found");
  });
  await assert.rejects(rpc(impl.setModel as Handler, setModel(sessionId, 'c1', 'x')), refusedWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'model_refused', "Model 'x' not found"));
  controller.answerSetModel(async () => ({ model: 'y', effort: '' }));
  assert.equal((await rpc<Applied>(impl.setModel as Handler, setModel(sessionId, 'c1', 'x'))).applied.model, 'y');
});

test('SetModel: a word the kernel would not ask about, and a closed session', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerSetModel(async () => {
    throw new SessionSettingsError('refused', 'a model id is one word');
  });
  await assert.rejects(rpc(impl.setModel as Handler, setModel(sessionId, 'c1', 'two words')), refusedWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'model_invalid'));
  controller.answerSetModel(async () => {
    throw new SessionSettingsError('closed', 'session is closed');
  });
  await assert.rejects(rpc(impl.setModel as Handler, setModel(sessionId, 'c2', 'x')), refusedWith(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND));
});

test('SetModel: a CLI that has not answered is a deadline, not a refusal', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerSetModel(async () => {
    throw new SessionSettingsError('timed_out', 'the CLI has not answered');
  });
  await assert.rejects(rpc(impl.setModel as Handler, setModel(sessionId, 'c1', 'x')), refusedWith(ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED));
});

test('SetModel on a session the sidecar does not have', async () => {
  const { impl } = await setup();
  await assert.rejects(rpc(impl.setModel as Handler, setModel('nope', 'c1', 'x')), refusedWith(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND));
});

test('ApplyEffort: the level reaches the session, a refusal has its reason, nothing is recorded for it', async () => {
  const { impl, sessionId, controller } = await setup();
  assert.equal((await rpc<Applied>(impl.applyEffort as Handler, applyEffort(sessionId, 'c1', 'low'))).applied.effort, 'low');
  await rpc(impl.applyEffort as Handler, applyEffort(sessionId, 'c1', 'low'));
  assert.deepEqual(controller.applyEffortCalls, ['low']);
  controller.answerApplyEffort(async () => {
    throw new SessionSettingsError('refused', 'an effort is one of');
  });
  await assert.rejects(rpc(impl.applyEffort as Handler, applyEffort(sessionId, 'c2', 'loud')), refusedWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'effort_unknown'));
  controller.answerApplyEffort(async () => {
    throw new SessionSettingsError('provider_refused', 'no');
  });
  await assert.rejects(rpc(impl.applyEffort as Handler, applyEffort(sessionId, 'c2', 'loud')), refusedWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'effort_refused'));
});

test('ListModels answers the rows and what the CLI will use', async () => {
  const { impl, sessionId, controller } = await setup();
  const row = { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'd', supportsEffort: true, supportedEffortLevels: ['low'], supportsAutoMode: true };
  controller.answerListModels(async () => ({ models: [row], applied: { model: 'claude-opus-5-5', effort: 'medium' } }));
  assert.deepEqual(await rpc(impl.listModels as Handler, ListModelsRequest.fromPartial({ sessionId })), { models: [row], applied: { model: 'claude-opus-5-5', effort: 'medium' } });
  controller.answerListModels(async () => {
    throw new SessionSettingsError('provider_refused', 'no');
  });
  await assert.rejects(rpc(impl.listModels as Handler, ListModelsRequest.fromPartial({ sessionId })), refusedWith(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'models_unavailable'));
});

test('GetTaskOutput with an offset asks for that range; with none it asks for the tail', async () => {
  const { impl, sessionId, controller } = await setup();
  controller.answerTaskOutput(async (_, range) => ({ output: new Uint8Array([1]), totalBytes: 9, truncated: true, offset: range?.offset ?? 8 }));
  const ranged = await rpc<{ offset: bigint }>(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1', offset: 3n, maxBytes: 5 }));
  const tail = await rpc<{ offset: bigint }>(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1' }));
  assert.deepEqual([ranged.offset, tail.offset], [3n, 8n]);
  assert.deepEqual(controller.taskOutputRanges, [{ offset: 3, maxBytes: 5 }, undefined]);
  const zero = await rpc<{ offset: bigint }>(impl.getTaskOutput as Handler, GetTaskOutputRequest.fromPartial({ sessionId, taskId: 'b1', offset: 0n }));
  assert.equal(zero.offset, 0n, 'offset 0 is a range, not a tail');
});
