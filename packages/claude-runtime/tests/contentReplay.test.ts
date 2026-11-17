import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession } from '../src/session.js';
import { sniffImage, type ImageMediaType } from '../src/turnContent.js';
import { makeFakeQuery } from './fakeQuery.js';
import { fixtureRoot, loadRecording, type Wire } from './replay/recording.js';

/**
 * Image turns against a recording of the kernel driving the pinned CLI (CLI 2.1.311, scripted model, no account; the
 * recording harness's `probe.mjs --kernel image`): a text block and two images (PNG, JPEG) sent as one user message.
 */

test('content replay m40_image: the pushed message\'s blocks equal the recorded request\'s', async t => {
  const name = 'm40_image.blocks';
  if (!existsSync(new URL(`${name}.core.messages.json`, fixtureRoot))) {
    assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: missing fixture`);
    t.skip('fixture missing'); return;
  }
  const recording = loadRecording(`${name}.core`);
  const controls: { model_requests: { images?: { media_type: string; sha256: string }[] }[] } =
    JSON.parse(readFileSync(new URL(`${name}.core.control.json`, fixtureRoot), 'utf8'));
  try {
    // The user message the kernel wrote to the CLI at recording time.
    const sent = recording.messages.filter(l => l.from === 'host' && l.message.type === 'user');
    assert.equal(sent.length, 1, 'one user message was recorded');
    const blocks: Wire[] = sent[0].message.message.content;
    assert.deepEqual(blocks.map(b => b.type), ['text', 'image', 'image'], 'the text first, then the images in the order given');
    const text: string = blocks[0].text;
    assert.deepEqual(blocks.slice(1).map(b => [b.source.type, b.source.media_type]), [['base64', 'image/png'], ['base64', 'image/jpeg']]);

    // The same turn through the kernel now: the images' bytes and types, and the text, as the recording holds them.
    const images = blocks.slice(1).map(b => ({ mediaType: b.source.media_type as ImageMediaType, data: new Uint8Array(Buffer.from(b.source.data, 'base64')) }));
    for (const image of images) assert.equal(sniffImage(image.data), image.mediaType, 'the recorded bytes are what their type says');
    const { query, controller: fake } = makeFakeQuery();
    const session = createSession({ cwd: recording.directory, policy: {
      configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled',
    } }, params => {
      fake.captureInput(params.prompt as AsyncIterable<SDKUserMessage>);
      return query;
    });
    try {
      session.sendTurn(text, { content: images });
      for (let waited = 0; waited < 50 && fake.pushed.length === 0; waited++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(fake.pushed.length, 1, 'the turn was pushed to the CLI');
      assert.deepEqual(fake.pushed[0].message.content, blocks);
    } finally { session.close(); }

    // The CLI took them as they were: the first model request carries the same images, in the same order (these
    // are small enough that the CLI re-encodes nothing).
    const first = controls.model_requests.find(r => r.images !== undefined);
    assert.ok(first, 'a model request carried the images');
    assert.deepEqual(first.images, blocks.slice(1).map(b => ({
      media_type: b.source.media_type, sha256: createHash('sha256').update(Buffer.from(b.source.data, 'base64')).digest('hex'),
    })));
  } finally { recording.cleanup(); }
});
