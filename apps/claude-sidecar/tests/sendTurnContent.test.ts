import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl } from '../src/runtimeServiceImpl.js';
import { makeFakeSession } from './fakeSession.js';
import { ErrorCode, ErrorDetail, SendTurnRequest, type HandshakeResponse } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 3_670_016;
type Handler = (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void;
function rpc<T>(fn: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => fn({ request }, (err, res) => err ? reject(err) : resolve(res)));
}
function setup(t: { after(fn: () => void): void }) {
  const registry = new SessionRegistry();
  const fake = makeFakeSession();
  t.after(() => fake.session.close());
  const entry = registry.create('s', fake.session, 64);
  const impl = createRuntimeServiceImpl(registry, () => fake.session, { sdkDeclared: 'fake', hostCli: '2.1.311' });
  const send = (request: Partial<SendTurnRequest>) => rpc<{ turnId: string }>(impl.sendTurn as Handler,
    SendTurnRequest.fromPartial({ sessionId: 's', commandId: 'c', text: 'look', ...request }));
  return { ...fake, entry, impl, send };
}
function image(size = PNG.length) {
  const data = Buffer.alloc(size);
  PNG.copy(data);
  return { image: { mediaType: 'image/png', data } };
}
function refused(reason: string, code = ErrorCode.ERROR_CODE_INVALID_CONFIGURATION) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, code);
    assert.equal(detail.reason, reason);
    return true;
  };
}

test('content is refused without a matching magic', async t => {
  const { send, controller } = setup(t);
  await assert.rejects(send({ content: [{ image: { mediaType: 'image/png', data: Buffer.from('not a png') } }] }), refused('turn_content_magic_mismatch'));
  assert.deepEqual(controller.sentTurns, []);
  await send({ content: [image()] });
  assert.equal(controller.sentTurns.length, 1, 'a refusal did not reserve its command id');
});

test('a turn at the content limit is accepted and one byte over is refused', async t => {
  const { send, controller } = setup(t);
  const atLimit = SendTurnRequest.fromPartial({ sessionId: 's', commandId: 'single', content: [image(MAX_BYTES)] });
  assert.ok(SendTurnRequest.encode(atLimit).finish().byteLength < 4 * 1024 * 1024);
  await send(atLimit);
  await send({ commandId: 'at', content: [image(MAX_BYTES / 2), image(MAX_BYTES / 2)] });
  await assert.rejects(send({ commandId: 'over', content: [image(MAX_BYTES / 2), image(MAX_BYTES / 2 + 1)] }), refused('turn_content_too_large'));
  assert.equal(controller.sentTurns.length, 2);
});

test('the handshake advertises turn_content_v1 and its limits', async t => {
  const { impl } = setup(t);
  const handshake = await rpc<HandshakeResponse>(impl.handshake as Handler, { clientProtocolMajor: 3 });
  assert.ok(handshake.capabilities.includes('turn_content_v1'));
  assert.deepEqual(handshake.turnContentLimits, {
    imageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxImagesPerTurn: 8, maxImageBytes: BigInt(MAX_BYTES), maxContentBytes: BigInt(MAX_BYTES),
  });
  assert.equal(handshake.maxMessageBytes, BigInt(4 * 1024 * 1024));
});

test('a retry with the same command id and content replays; other content conflicts', async t => {
  const { send, controller, entry } = setup(t);
  const first = await send({ content: [image(), image(9)] });
  assert.deepEqual(await send({ content: [image(), image(9)] }), first);
  assert.equal(controller.sentTurns.length, 1);
  for (const content of [[image(9), image()], [image(), image(10)], [image()], []]) {
    await assert.rejects(send({ content }), (err: grpc.ServiceError) => {
      const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
      assert.equal(detail.code, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
      return true;
    });
  }
  const payload = { text: 'look', content: [PNG, image(9).image.data].map(data => ({
    mediaType: 'image/png', sha256: createHash('sha256').update(data).digest('hex'),
  })) };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  assert.deepEqual(entry.sendTurnIdempotency.check('c', hash), { kind: 'replay', outcome: first });
});

test('empty or absent content preserves older payload hashes', async t => {
  const { send, controller, entry, impl } = setup(t);
  const hash = createHash('sha256').update(JSON.stringify({ text: 'look' })).digest('hex');
  entry.sendTurnIdempotency.record('old', hash, { turnId: 'old-turn' });
  assert.deepEqual(await send({ commandId: 'old', content: [] }), { turnId: 'old-turn' });
  assert.deepEqual(await rpc(impl.sendTurn as Handler, { sessionId: 's', commandId: 'old', text: 'look' }), { turnId: 'old-turn' });
  assert.deepEqual(controller.sentTurns, []);
});

test('SendTurn with content and empty text is accepted', async t => {
  const { send, controller } = setup(t);
  await send({ text: '', content: [image()] });
  assert.deepEqual(controller.sentTurns, ['']);
  assert.deepEqual(controller.sentTurnOptions, [{ content: [{ mediaType: 'image/png', data: PNG }] }]);
});

test('unknown kinds and invalid images are refused before the kernel', async t => {
  const { send, controller } = setup(t);
  for (const [content, reason] of [
    [[{}], 'turn_content_media_type'],
    [[{ image: { mediaType: 'image/svg+xml', data: PNG } }], 'turn_content_media_type'],
    [[{ image: { mediaType: 'image/png', data: Buffer.alloc(0) } }], 'turn_content_empty_image'],
    [Array.from({ length: 9 }, () => image()), 'turn_content_too_many'],
    [[image(MAX_BYTES + 1)], 'turn_content_image_too_large'],
  ] as const) {
    await assert.rejects(send({ content: [...content] }), refused(reason));
  }
  assert.deepEqual(controller.sentTurns, []);
});
