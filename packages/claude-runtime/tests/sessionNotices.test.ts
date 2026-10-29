import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translateMessage } from '../src/eventTranslation.js';
import { sessionNoticeOf } from '../src/sessionNotices.js';
import { drive } from './replay/drive.js';
import { loadRecording, fixtureRoot } from './replay/recording.js';

const translate = (raw: Record<string, unknown>) => translateMessage(raw as unknown as SDKMessage, { currentTurnId: undefined });
const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, ...fields });
const notice = (kind: string, fields: Record<string, unknown> = {}) => [{ type: 'session_notice', kind, level: 'notice', ...fields }];

const cases: [string, Record<string, unknown>, unknown][] = [
  ['API retry has all scalars and no content', system('api_retry', { attempt: 2, max_retries: 3, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit', content: 'ignored' }), notice('api_retry', { attempt: 2, maxRetries: 3, retryDelayMs: 1000, errorStatus: 429, errorKind: 'rate_limit' })],
  ['null error status is absent', system('api_retry', { error_status: null }), notice('api_retry')],
  ['rate limit seconds (hand-built C13b substitute; recording emitted no rate limit frame)', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1800000000, utilization: 0.8 } }, notice('rate_limit', { rateStatus: 'allowed_warning', resetsAtMs: 1800000000000, utilization: 0.8 })],
  ['rate limit milliseconds', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1800000000000, utilization: 1 } }, notice('rate_limit', { rateStatus: 'rejected', resetsAtMs: 1800000000000, utilization: 1 })],
  ['allowed rate limit', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, notice('rate_limit', { rateStatus: 'allowed' })],
  ['refusal', system('model_refusal_no_fallback', { original_model: 'a', content: 'CLI refusal' }), notice('model_refusal', { level: 'warning', fromModel: 'a', content: 'CLI refusal' })],
  ['compacting', system('status', { status: 'compacting' }), notice('compacting')],
  ['compact boundary', system('compact_boundary', { compact_metadata: { pre_tokens: 100, post_tokens: 20, trigger: 'manual' } }), notice('compact_boundary', { preTokens: 100, postTokens: 20, trigger: 'manual' })],
  ['informational', system('informational', { content: 'CLI information', level: 'suggestion' }), notice('informational', { level: 'suggestion', content: 'CLI information' })],
  ['without content', system('informational'), notice('informational')],
  ['notification.text', system('notification', { text: 'CLI notification', content: 'ignored' }), notice('notification', { content: 'CLI notification' })],
];
for (const [name, raw, expected] of cases) test(name, () => assert.deepEqual(translate(raw), expected));
for (const subtype of ['model_refusal_fallback', 'model_fallback']) {
  for (const scope of ['local', 'session', undefined]) {
    test(`${subtype} scope ${scope ?? 'absent'}`, () => {
      assert.deepEqual(translate(system(subtype, { original_model: 'a', fallback_model: 'b', ...(scope === undefined ? {} : { scope }), content: 'CLI fallback' })),
        notice('model_fallback', { fromModel: 'a', toModel: 'b', fallbackScope: scope ?? 'session', content: 'CLI fallback' }));
    });
  }
}
for (const state of ['held', 'released', 'dropped', 'unknown']) {
  for (const raw of [{ type: 'peer_message_hold', state, peer_name: 'peer' }, system('peer_message_hold', { state, peer_name: 'peer' })]) {
    test(`peer hold ${raw.type} ${state}`, () => {
      if (state === 'unknown') assert.deepEqual(translate(raw), [{ type: 'provider_notice', kind: raw.type, subtype: raw.type === 'system' ? 'peer_message_hold' : null, raw }]);
      else assert.deepEqual(translate(raw), notice('peer_hold', { peerName: 'peer', holdState: state }));
    });
  }
}
for (const trigger of ['clear', undefined]) {
  test(`reset ${trigger ?? 'without trigger'} never forwards retracted ids`, () => {
    const raw = { type: 'conversation_reset', new_conversation_id: 'new', ...(trigger === undefined ? {} : { trigger }), retracted_message_uuids: ['secret'] };
    assert.deepEqual(translate(raw), [{ type: 'conversation_reset', newConversationId: 'new', ...(trigger === undefined ? {} : { trigger }) }]);
  });
}
test('unknown system subtype remains payload-less on the wire', async () => {
  const raw = system('future', { content: 'private' });
  const events = translate(raw);
  assert.deepEqual(events, [{ type: 'provider_notice', kind: 'system', subtype: 'future', raw }]);
  const { translateEvent } = await wireEncoder();
  assert.deepEqual(translateEvent(events[0]), { providerNotice: { kind: 'system', subtype: 'future' } });
});

// Load the sidecar's built encoder without making the runtime package depend on sidecar sources.
async function wireEncoder() {
  const path = new URL('../../../../apps/claude-sidecar/dist/src/eventTranslation.js', import.meta.url).href;
  return import(path);
}
test('sidecar cuts long content at a character boundary with ellipsis inside the 2000 limit', async () => {
  const content = '😀'.repeat(2001);
  const event = translate(system('informational', { content }))[0];
  const { translateEvent } = await wireEncoder();
  assert.equal(translateEvent(event).sessionNotice.content, '😀'.repeat(1999) + '…');
  assert.equal(event.type === 'session_notice' && event.content, content);
});
test('malformed optional fields are dropped and counted once without failing the frame', () => {
  const diagnostics: string[] = [];
  assert.deepEqual(sessionNoticeOf(system('model_fallback', { original_model: 1, fallback_model: {}, scope: false, content: [] }), line => diagnostics.push(line)), notice('model_fallback', { fallbackScope: 'session' }));
  assert.deepEqual(diagnostics, ['dropped 4 malformed session notice fields']);
  assert.deepEqual(translate({ type: 'conversation_reset', new_conversation_id: 'new', trigger: 5 }), [{ type: 'conversation_reset', newConversationId: 'new' }]);
  assert.deepEqual(translate({ type: 'rate_limit_event', rate_limit_info: { status: 'new', resetsAt: 'bad', utilization: NaN } }), notice('rate_limit'));
});

const replayKinds: Record<string, string[]> = {
  c09: ['informational', 'compacting', 'compact_boundary', 'compacting', 'compact_boundary'],
  c10: ['informational', 'compacting', 'compact_boundary'],
  c12: ['informational', 'conversation_reset'],
  c13a: ['informational', 'api_retry', 'api_retry'],
  c13b: ['informational', 'api_retry', 'api_retry'],
  c14: ['informational', 'informational'],
};
for (const [name, kinds] of Object.entries(replayKinds)) {
  test(`notice replay ${name}: recorded kinds, text and scalars survive`, async () => {
    const recording = loadRecording(name, fixtureRoot);
    try {
      const replay = await drive(recording.messages, recording.directory);
      const notices = replay.events.filter(e => e.type === 'session_notice' || e.type === 'conversation_reset');
      assert.deepEqual(notices.map(e => e.type === 'session_notice' ? e.kind : e.type), kinds);
      for (const step of replay.steps) {
        const raw = step.line.message;
        for (const event of step.events) {
          if (event.type === 'session_notice') {
            if (event.kind === 'informational') { assert.equal(event.content, raw.content); assert.equal(event.level, raw.level); }
            if (event.kind === 'api_retry') assert.deepEqual(event, { type: 'session_notice', kind: 'api_retry', level: 'notice', attempt: raw.attempt, maxRetries: raw.max_retries, retryDelayMs: raw.retry_delay_ms, errorStatus: raw.error_status, errorKind: raw.error });
            if (event.kind === 'compact_boundary') assert.deepEqual(event, { type: 'session_notice', kind: 'compact_boundary', level: 'notice', preTokens: raw.compact_metadata.pre_tokens, postTokens: raw.compact_metadata.post_tokens, trigger: raw.compact_metadata.trigger });
          }
          if (event.type === 'conversation_reset') {
            assert.equal(event.newConversationId, raw.new_conversation_id);
            assert.equal(event.trigger, raw.trigger);
            const next = replay.events.slice(replay.events.indexOf(event) + 1).find(e => e.type === 'session_ready');
            assert.ok(next?.type === 'session_ready');
            const nextInit = recording.messages.find(l => (l.i ?? 0) > (step.line.i ?? 0) && l.message.subtype === 'init');
            assert.equal(next.providerSessionId, nextInit?.message.session_id);
            assert.notEqual(next.providerSessionId, event.newConversationId);
            assert.deepEqual(replay.log.filter(line => line.includes('conversation reset id')), ['conversation reset id differs from the next init session id']);
          }
        }
      }
    } finally { recording.cleanup(); }
  });
}

test('matching reset and next init id produces no mismatch diagnostic', async () => {
  const recording = loadRecording('c12');
  try {
    const reset = recording.messages.find(l => l.message.type === 'conversation_reset')!;
    reset.message.new_conversation_id = recording.messages.find(l => (l.i ?? 0) > (reset.i ?? 0) && l.message.subtype === 'init')!.message.session_id;
    const replay = await drive(recording.messages, recording.directory);
    assert.equal(replay.log.some(line => line.includes('conversation reset id')), false);
  } finally { recording.cleanup(); }
});
