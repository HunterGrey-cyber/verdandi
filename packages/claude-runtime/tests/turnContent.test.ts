import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, type QueryFn, type SendTurnOptions } from '../src/session.js';
import { checkTurnContent, sniffImage, userContent, TURN_CONTENT_LIMITS, type TurnImage } from '../src/turnContent.js';
import { makeFakeQuery } from './fakeQuery.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff]);
const GIF = new TextEncoder().encode('GIF89a');
const WEBP = new TextEncoder().encode('RIFFabcdWEBP');
const images: TurnImage[] = [
  { mediaType: 'image/png', data: PNG },
  { mediaType: 'image/jpeg', data: JPEG },
  { mediaType: 'image/gif', data: GIF },
  { mediaType: 'image/webp', data: WEBP },
];

async function sentContent(text: string, options?: SendTurnOptions) {
  const { query } = makeFakeQuery();
  let input!: AsyncIterator<SDKUserMessage>;
  const queryFn: QueryFn = params => {
    input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query;
  };
  const session = createSession({ cwd: '/tmp/project', policy: {
    configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli',
  } }, queryFn);
  try {
    session.sendTurn(text, options);
    const next = await input.next();
    assert.equal(next.done, false);
    return next.value!.message.content;
  } finally {
    session.close();
  }
}

test('a text-only turn sends the same string as before', async () => {
  for (const text of ['hello', '', '  hello\n', '/help']) {
    assert.equal(userContent(text, []), text);
    assert.equal(await sentContent(text), text);
    assert.equal(await sentContent(text, { content: [] }), text);
  }
});

test('images follow the text in order as base64 blocks', async () => {
  const expected = [
    { type: 'text', text: '  look\n' },
    ...images.map(image => ({ type: 'image', source: {
      type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64'),
    } })),
  ];
  assert.deepEqual(userContent('  look\n', images), expected);
  assert.deepEqual(await sentContent('  look\n', { content: images }), expected);
  const backing = Uint8Array.from([0, ...PNG, 0]);
  assert.deepEqual(userContent('', [{ mediaType: 'image/png', data: backing.subarray(1, -1) }]), [expected[1]]);
});

test('an image-only turn has no empty text block', async () => {
  const expected = [{ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64'),
  } }];
  assert.deepEqual(userContent('', [images[0]]), expected);
  assert.deepEqual(userContent(' \n\t', [images[0]]), expected);
  assert.deepEqual(await sentContent('', { content: [images[0]] }), expected);
});

test('sniffing tells the four formats apart and refuses others', () => {
  for (const image of images) {
    assert.equal(sniffImage(image.data), image.mediaType);
    for (let length = 0; length < image.data.length; length++) {
      assert.equal(sniffImage(image.data.subarray(0, length)), null);
    }
  }
  assert.equal(sniffImage(new TextEncoder().encode('GIF87a')), 'image/gif');
  for (const other of ['<svg/>', 'GIF88a', 'RIFFabcdWAVE', 'xxxxabcdWEBP']) {
    assert.equal(sniffImage(new TextEncoder().encode(other)), null);
  }
  for (let i = 0; i < PNG.length; i++) {
    const corrupt = PNG.slice();
    corrupt[i] ^= 1;
    assert.equal(sniffImage(corrupt), null);
  }
});

function png(size: number): TurnImage {
  const data = new Uint8Array(size);
  data.set(PNG);
  return { mediaType: 'image/png', data };
}

test('each limit is refused exactly one over and accepted at the limit', () => {
  assert.deepEqual(TURN_CONTENT_LIMITS, {
    imageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxImagesPerTurn: 8, maxImageBytes: 3_670_016, maxContentBytes: 3_670_016,
  });
  assert.equal(checkTurnContent([]), null);
  assert.equal(checkTurnContent(images), null);
  assert.equal(checkTurnContent(Array(8).fill(images[0])), null);
  assert.equal(checkTurnContent(Array(9).fill(images[0])), 'turn_content_too_many');
  assert.equal(checkTurnContent([png(3_670_016)]), null);
  assert.equal(checkTurnContent([png(3_670_017)]), 'turn_content_image_too_large');
  assert.equal(checkTurnContent([png(1_835_008), png(1_835_008)]), null);
  assert.equal(checkTurnContent([png(1_835_008), png(1_835_009)]), 'turn_content_too_large');
});

test('invalid images have stable reasons', () => {
  assert.equal(checkTurnContent([{ mediaType: 'image/svg+xml', data: PNG } as unknown as TurnImage]), 'turn_content_media_type');
  assert.equal(checkTurnContent([{ mediaType: 'image/png', data: new Uint8Array() }]), 'turn_content_empty_image');
  assert.equal(checkTurnContent([{ mediaType: 'image/png', data: JPEG }]), 'turn_content_magic_mismatch');
  assert.equal(checkTurnContent([{ mediaType: 'image/png', data: PNG.subarray(0, 7) }]), 'turn_content_magic_mismatch');
});
