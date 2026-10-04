import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { buildSessionOptions, createSession, type ClaudeRuntimeSession } from '../src/session.js';
import { STRUCTURED_OUTPUT_CARRIER_TOOLS, initToolViolation, permittedInitTools, requiredInitTools } from '../src/toolInvariant.js';
import { WEBFETCH_PRIVATE_DENY, webFetchDenyFor } from '../src/webFetchDeny.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';

/** The tool-bearing completion (consumer client spec §9.1): the zero-tool policy plus two web tools. */
const WEB: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: ['WebFetch', 'WebSearch'] },
};
const ZERO: ClaudeHostPolicy = { ...WEB, toolPolicy: { allow: [] } };
const SCHEMA = { type: 'json_schema' as const, schema: { type: 'object' } };

async function pumpUntil(session: ClaudeRuntimeSession, done: (events: ClaudeRuntimeEvent[]) => boolean): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 200 && !done(events); i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 1));
  }
  return events;
}

/** One turn whose system/init reports `tools`, then a clean structured result. */
async function replayInit(config: Omit<ClaudeSessionConfig, 'cwd'>, tools: string[] | undefined) {
  const fake = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', ...config }, () => fake.query);
  await session.accountIdentity();
  session.sendTurn('fetch the page');
  const init: Record<string, unknown> = { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/project', permissionMode: 'bypassPermissions', apiKeySource: 'none' };
  if (tools !== undefined) {
    init.tools = tools;
  }
  fake.controller.emit(init as unknown as SDKMessage);
  fake.controller.emit({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', structured_output: { title: 't' } } as unknown as SDKMessage);
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'turn_completed') || e.some((x) => x.type === 'session_closed'));
  return { session, fake, events };
}

test('permittedInitTools / requiredInitTools: the carrier plus exactly the requested tools', () => {
  assert.deepEqual(permittedInitTools({ policy: WEB, outputFormat: SCHEMA }), [...STRUCTURED_OUTPUT_CARRIER_TOOLS, 'WebFetch', 'WebSearch']);
  assert.deepEqual(permittedInitTools({ policy: WEB }), ['WebFetch', 'WebSearch']);
  assert.deepEqual(requiredInitTools({ policy: WEB }), ['WebFetch', 'WebSearch']);
  assert.deepEqual(requiredInitTools({ policy: ZERO }), []);
  assert.deepEqual(requiredInitTools({ policy: { ...WEB, toolPolicy: { unrestricted: true } } }), []);
});

test('initToolViolation: a requested tool that init does not report is a violation; the carrier never is required', () => {
  const init = (tools: string[]) => ({ tools, mcpServers: [], apiKeySource: 'none' });
  const permitted = ['StructuredOutput', 'WebFetch', 'WebSearch'];
  const required = ['WebFetch', 'WebSearch'];
  assert.equal(initToolViolation(init(['StructuredOutput', 'WebFetch', 'WebSearch']), permitted, required), null);
  assert.equal(initToolViolation(init(['WebSearch', 'WebFetch']), permitted, required), null, 'no carrier reported is fine, as it always was');
  assert.equal(initToolViolation(init(['StructuredOutput', 'WebFetch']), permitted, required), 'system/init did not report ["WebSearch"], which the allow list requested');
  assert.equal(
    initToolViolation(init(['StructuredOutput', 'WebFetch', 'WebSearch', 'Bash']), permitted, required),
    'system/init reported ["Bash"] beyond the permitted ["StructuredOutput","WebFetch","WebSearch"]',
  );
  assert.equal(initToolViolation(undefined, permitted, required), 'system/init reported no tools list, so the explicit allow list cannot be verified');
});

test('a web session whose init reports the carrier plus both web tools completes', async () => {
  const { session, events } = await replayInit({ policy: WEB, outputFormat: SCHEMA }, ['StructuredOutput', 'WebFetch', 'WebSearch']);
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.equal(completed?.type === 'turn_completed' ? completed.outcome : null, 'completed');
  assert.equal(events.some((e) => e.type === 'session_closed'), false);
  session.close();
});

test('a web session missing WebSearch in init is closed for tool_policy_violation', async () => {
  const { fake, events } = await replayInit({ policy: WEB, outputFormat: SCHEMA }, ['StructuredOutput', 'WebFetch']);
  assert.deepEqual(events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
  assert.equal(fake.controller.closed, true);
});

test('a web session whose init reports Bash as well is closed for tool_policy_violation', async () => {
  const { events } = await replayInit({ policy: WEB, outputFormat: SCHEMA }, ['StructuredOutput', 'WebFetch', 'WebSearch', 'Bash']);
  assert.deepEqual(events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
});

test('a web session whose init reports no tools list fails closed', async () => {
  const { events } = await replayInit({ policy: WEB, outputFormat: SCHEMA }, undefined);
  assert.deepEqual(events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
});

test('WEBFETCH_PRIVATE_DENY is frozen and only scoped WebFetch rules', () => {
  assert.equal(Object.isFrozen(WEBFETCH_PRIVATE_DENY), true);
  for (const rule of WEBFETCH_PRIVATE_DENY) {
    assert.match(rule, /^WebFetch\(domain:[^()\s]+\)$/, rule);
  }
  for (const want of ['WebFetch(domain:127.*.*.*)', 'WebFetch(domain:192.168.*.*)', 'WebFetch(domain:10.*.*.*)', 'WebFetch(domain:*.owner.example)', 'WebFetch(domain:*.nip.io)']) {
    assert.ok(WEBFETCH_PRIVATE_DENY.includes(want), want);
  }
});

test('webFetchDenyFor: only an explicit allow list naming WebFetch gets the rules', () => {
  assert.equal(webFetchDenyFor(WEB), WEBFETCH_PRIVATE_DENY);
  assert.deepEqual(webFetchDenyFor({ toolPolicy: { allow: ['WebSearch'] } }), []);
  assert.deepEqual(webFetchDenyFor(ZERO), []);
  assert.deepEqual(webFetchDenyFor({ toolPolicy: { unrestricted: true } }), []);
  assert.deepEqual(webFetchDenyFor({ toolPolicy: undefined }), []);
});

test('buildSessionOptions: a web session gets its tools and the deny rules; a zero-tool one gets no deny list at all', () => {
  const web = buildSessionOptions({ cwd: '/tmp/p', policy: WEB, outputFormat: SCHEMA });
  assert.deepEqual(web.tools, ['WebFetch', 'WebSearch']);
  assert.deepEqual(web.disallowedTools, [...WEBFETCH_PRIVATE_DENY]);
  assert.equal(web.permissionMode, 'bypassPermissions');
  const zero = buildSessionOptions({ cwd: '/tmp/p', policy: ZERO, outputFormat: SCHEMA });
  assert.deepEqual(zero.tools, []);
  assert.equal('disallowedTools' in zero, false, 'the zero-tool completion (the daily digest) must keep exactly the options it had');
});
