import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { PermissionModeError } from '@verdandi/claude-runtime';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { startSidecar } from '../src/lifecycle.js';
import { translateEvent } from '../src/eventTranslation.js';
import { makeFakeSession } from './fakeSession.js';
import {
  ErrorCode,
  ErrorDetail,
  PermissionMode,
  ReplayStart,
  RuntimeServiceClient,
  type SessionEvent,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/** SetPermissionMode, sidecar half: the RPC, its error mapping and idempotency, the event on the
 * wire, and the two TextDelta/ThinkingDelta message ids. The kernel half (what the CLI and the gate
 * are told, and in which order) is packages/claude-runtime/tests/permissionModeSwitch.test.ts. */

const created: MinimalKernelSession[] = [];
after(async () => {
  for (const session of created) {
    session.close();
  }
  await new Promise((r) => setTimeout(r, 100));
});

function setup() {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const impl = createRuntimeServiceImpl(
    registry,
    () => {
      const m = makeFakeSession();
      made.push(m);
      created.push(m.session);
      return m.session;
    },
    { sdkDeclared: 'fake', hostCli: 'fake' },
  );
  return { impl, made };
}

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

function errorCodeOf(err: grpc.ServiceError): ErrorCode | undefined {
  const bytes = err.metadata?.get('grpc-status-details-bin')[0];
  return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer).code;
}

test('setPermissionMode maps the proto mode onto the kernel and answers with the acknowledged provider mode', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const res = await callResult<{ permissionMode: string }>(impl.setPermissionMode.bind(impl), {
    sessionId,
    commandId: 'c1',
    mode: PermissionMode.PERMISSION_MODE_BYPASS,
  });
  assert.deepEqual(res, { permissionMode: 'bypassPermissions' });
  await callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: 'c2', mode: PermissionMode.PERMISSION_MODE_VERDANDI_RULES });
  assert.deepEqual(made[0].controller.setPermissionModeCalls, ['bypass', 'verdandi_rules']);
});

test('setPermissionMode refuses an unstated mode instead of defaulting it, and never reaches the kernel', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  for (const mode of [PermissionMode.PERMISSION_MODE_UNSPECIFIED, PermissionMode.UNRECOGNIZED, 99]) {
    await assert.rejects(callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: `c-${mode}`, mode }), (err: grpc.ServiceError) => {
      assert.equal(errorCodeOf(err), ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
      return true;
    });
  }
  assert.deepEqual(made[0].controller.setPermissionModeCalls, []);
});

test('setPermissionMode error mapping: refused -> INVALID_CONFIGURATION, closed -> SESSION_NOT_FOUND, unknown session -> SESSION_NOT_FOUND', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const cases: Array<[unknown, ErrorCode, RegExp]> = [
    [new PermissionModeError('refused', 'created under bypass'), ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, /created under bypass/],
    [new PermissionModeError('provider_refused', 'disabled by settings'), ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, /provider refused.*disabled by settings/],
    [new PermissionModeError('closed', 'session is closed'), ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, /closed/],
    [new Error('socket hang up'), ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE, /socket hang up/],
  ];
  for (const [i, [thrown, code, message]] of cases.entries()) {
    made[0].controller.makeNextSetPermissionModeReject(thrown);
    await assert.rejects(callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: `e${i}`, mode: PermissionMode.PERMISSION_MODE_BYPASS }), (err: grpc.ServiceError) => {
      assert.equal(errorCodeOf(err), code);
      assert.match(err.message, message);
      return true;
    });
  }
  await assert.rejects(
    callResult(impl.setPermissionMode.bind(impl), { sessionId: 'nope', commandId: 'x', mode: PermissionMode.PERMISSION_MODE_BYPASS }),
    (err: grpc.ServiceError) => errorCodeOf(err) === ErrorCode.ERROR_CODE_SESSION_NOT_FOUND,
  );
});

test('setPermissionMode is idempotent per command_id; a refused call records nothing a retry could replay as success', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const controller = made[0].controller;

  controller.makeNextSetPermissionModeReject(new PermissionModeError('provider_refused', 'not now'));
  await assert.rejects(callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: 'same', mode: PermissionMode.PERMISSION_MODE_BYPASS }));
  // The retry is really attempted, not replayed.
  const retried = await callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: 'same', mode: PermissionMode.PERMISSION_MODE_BYPASS });
  assert.deepEqual(retried, { permissionMode: 'bypassPermissions' });
  assert.equal(controller.setPermissionModeCalls.length, 2);

  // Replayed now: the kernel is not asked a third time.
  await callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: 'same', mode: PermissionMode.PERMISSION_MODE_BYPASS });
  assert.equal(controller.setPermissionModeCalls.length, 2);
  await assert.rejects(
    callResult(impl.setPermissionMode.bind(impl), { sessionId, commandId: 'same', mode: PermissionMode.PERMISSION_MODE_INTERACTIVE }),
    (err: grpc.ServiceError) => errorCodeOf(err) === ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT,
  );
});

test('setPermissionMode: a duplicate command_id arriving while the first call waits on the CLI joins it, never runs twice', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const controller = made[0].controller;
  const release = controller.holdNextSetPermissionMode();
  const req = { sessionId, commandId: 'dup', mode: PermissionMode.PERMISSION_MODE_BYPASS };
  const first = callResult(impl.setPermissionMode.bind(impl), req);
  await new Promise((r) => setImmediate(r));
  const second = callResult(impl.setPermissionMode.bind(impl), req);
  // Same id, different payload, while in flight: a conflict, as it would be once recorded.
  await assert.rejects(
    callResult(impl.setPermissionMode.bind(impl), { ...req, mode: PermissionMode.PERMISSION_MODE_INTERACTIVE }),
    (err: grpc.ServiceError) => errorCodeOf(err) === ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT,
  );
  release();
  assert.deepEqual(await first, { permissionMode: 'bypassPermissions' });
  assert.deepEqual(await second, { permissionMode: 'bypassPermissions' });
  assert.equal(controller.setPermissionModeCalls.length, 1, 'the kernel was asked once');
});

test('setPermissionMode: a duplicate of an in-flight call that FAILS gets the same failure, and a later retry runs again', async () => {
  const { impl, made } = setup();
  const { sessionId } = await callResult<{ sessionId: string }>(impl.createSession.bind(impl), { cwd: '/tmp', policy: {} });
  const controller = made[0].controller;
  const release = controller.holdNextSetPermissionMode();
  controller.makeNextSetPermissionModeReject(new PermissionModeError('provider_refused', 'no'));
  const req = { sessionId, commandId: 'dup-fail', mode: PermissionMode.PERMISSION_MODE_BYPASS };
  const first = callResult(impl.setPermissionMode.bind(impl), req);
  await new Promise((r) => setImmediate(r));
  const second = callResult(impl.setPermissionMode.bind(impl), req);
  release();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(controller.setPermissionModeCalls.length, 1);
  await callResult(impl.setPermissionMode.bind(impl), req);
  assert.equal(controller.setPermissionModeCalls.length, 2);
});

test('translateEvent: permission_mode_changed, and message ids present only when the kernel had one', () => {
  assert.deepEqual(translateEvent({ type: 'permission_mode_changed', permissions: 'bypass', permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: true }), {
    permissionModeChanged: { mode: PermissionMode.PERMISSION_MODE_BYPASS, permissionMode: 'bypassPermissions', bypassDefaultDenyApplied: true },
  });
  assert.deepEqual(translateEvent({ type: 'text_delta', turnId: 't', text: 'x', messageId: 'msg_1' }), { textDelta: { turnId: 't', text: 'x', messageId: 'msg_1' } });
  assert.deepEqual(translateEvent({ type: 'thinking_delta', turnId: 't', text: 'y', messageId: 'msg_1' }), { thinkingDelta: { turnId: 't', text: 'y', messageId: 'msg_1' } });
  assert.deepEqual(translateEvent({ type: 'text_delta', turnId: 't', text: 'x' }), { textDelta: { turnId: 't', text: 'x' } });
});

function promisify<Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<Res> {
  return new Promise((resolve, reject) => fn(req, (err, res) => (err ? reject(err) : resolve(res as Res))));
}

test('over a real UDS with the generated client: SetPermissionMode answers, and every watcher sees PermissionModeChanged and a TextDelta message id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-spm-'));
  const socketPath = join(dir, 'sidecar.sock');
  let fake: ReturnType<typeof makeFakeSession> | undefined;
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: () => {
      fake = makeFakeSession();
      return fake.session;
    },
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: 'fake' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    const handshake = await promisify<{ capabilities: string[] }>(client.handshake.bind(client), { clientProtocolMajor: 3 });
    assert.ok(handshake.capabilities.includes('set_permission_mode'));
    assert.ok(handshake.capabilities.includes('text_delta_message_id'));

    const { sessionId } = await promisify<{ sessionId: string }>(client.createSession.bind(client), { cwd: '/tmp', policy: undefined });
    const watch = client.watchSessionEvents({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY });
    const seen: SessionEvent[] = [];
    const sawBoth = new Promise<void>((resolve) => {
      watch.on('data', (event: SessionEvent) => {
        seen.push(event);
        if (seen.some((e) => e.permissionModeChanged !== undefined) && seen.some((e) => e.textDelta !== undefined)) {
          resolve();
        }
      });
    });
    watch.on('error', () => undefined);

    const res = await promisify<{ permissionMode: string }>(client.setPermissionMode.bind(client), {
      sessionId,
      commandId: 'spm-1',
      mode: PermissionMode.PERMISSION_MODE_BYPASS,
    });
    assert.equal(res.permissionMode, 'bypassPermissions');
    fake!.controller.emit({ type: 'text_delta', turnId: 't1', text: 'hi', messageId: 'msg_wire' });
    await sawBoth;

    const changed = seen.find((e) => e.permissionModeChanged !== undefined)!.permissionModeChanged!;
    assert.equal(changed.mode, PermissionMode.PERMISSION_MODE_BYPASS);
    assert.equal(changed.permissionMode, 'bypassPermissions');
    assert.equal(seen.find((e) => e.textDelta !== undefined)!.textDelta!.messageId, 'msg_wire');
    watch.cancel();
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
