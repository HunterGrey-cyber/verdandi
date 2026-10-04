import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { m1Manifest, readM1Fixture } from './m1FixtureFiles.js';
import { translateMessage } from '../src/eventTranslation.js';
import { createSession, type ClaudeRuntimeSession } from '../src/session.js';
import { STRUCTURED_OUTPUT_CARRIER_TOOLS, initCheckProblem, initToolViolation, permittedInitTools, verifiesInitTools } from '../src/toolInvariant.js';
import { buildSessionOptions } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';

const COMPLETION: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};
const SCHEMA = { type: 'json_schema' as const, schema: { type: 'object' } };

async function pumpUntil(session: ClaudeRuntimeSession, done: (events: ClaudeRuntimeEvent[]) => boolean): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 200 && !done(events); i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 1));
  }
  return events;
}

/** Replays recorded SDK messages through a real createSession + pump, as the provider would send them. */
async function replay(config: Omit<ClaudeSessionConfig, 'cwd'>, messages: unknown[]) {
  const fake = makeFakeQuery();
  const session = createSession({ cwd: '/tmp/project', ...config }, () => fake.query);
  await session.accountIdentity();
  const { turnId } = session.sendTurn('score these candidates');
  for (const message of messages) {
    fake.controller.emit(message as SDKMessage);
  }
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'turn_completed') || e.some((x) => x.type === 'session_closed'));
  return { session, fake, turnId, events };
}

test('the carrier constant is the one the M1 recording saw in system/init', () => {
  const manifest = m1Manifest();
  assert.deepEqual([...STRUCTURED_OUTPUT_CARRIER_TOOLS].sort(), [...new Set(manifest.init_tools)].sort());
  if (manifest.carrier_tool !== null) {
    assert.ok(STRUCTURED_OUTPUT_CARRIER_TOOLS.includes(manifest.carrier_tool));
  }
});

test('permittedInitTools: every explicit allow list is checked; an absent one never is', () => {
  assert.deepEqual(permittedInitTools({ policy: COMPLETION }), []);
  assert.deepEqual(permittedInitTools({ policy: COMPLETION, outputFormat: SCHEMA }), STRUCTURED_OUTPUT_CARRIER_TOOLS);
  assert.equal(permittedInitTools({ policy: { ...COMPLETION, toolPolicy: undefined } }), undefined);
  assert.equal(permittedInitTools({ policy: { ...COMPLETION, toolPolicy: { unrestricted: true } } }), undefined);
  assert.deepEqual(permittedInitTools({ policy: { ...COMPLETION, toolPolicy: { allow: ['Read'] } } }), ['Read']);
});

test('initToolViolation: exact set passes, anything extra or an unreported list does not', () => {
  const init = (tools: string[]) => ({ tools, mcpServers: [], apiKeySource: 'none' });
  assert.equal(initToolViolation(init([]), []), null);
  assert.equal(initToolViolation(init(['StructuredOutput']), ['StructuredOutput']), null);
  assert.equal(initToolViolation(init([]), ['StructuredOutput']), null, 'reporting fewer tools than permitted is fine');
  assert.equal(initToolViolation(init(['StructuredOutput']), []), 'system/init reported ["StructuredOutput"] beyond the permitted []');
  assert.equal(initToolViolation(init(['Bash', 'mcp__x__y']), ['StructuredOutput']), 'system/init reported ["Bash","mcp__x__y"] beyond the permitted ["StructuredOutput"]');
  assert.match(initToolViolation(undefined, []) ?? '', /no tools list/);
});

test('translateMessage: system/init yields the fingerprint verbatim; no tools array, no fingerprint', () => {
  const [ready] = translateMessage({
    type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/c', permissionMode: 'bypassPermissions',
    tools: ['StructuredOutput'], mcp_servers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }, { bogus: true }], apiKeySource: 'none',
  } as unknown as SDKMessage, { currentTurnId: undefined });
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual(ready.initFingerprint, { tools: ['StructuredOutput'], mcpServers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }], apiKeySource: 'none' });
  const [bare] = translateMessage({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/c', permissionMode: 'default' } as unknown as SDKMessage, { currentTurnId: undefined });
  assert.ok(bare?.type === 'session_ready');
  assert.equal('initFingerprint' in bare, false);
});

test('translateMessage: a tools array with a non-string entry yields no fingerprint, not a filtered one', () => {
  const [drifted] = translateMessage({
    type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/c', permissionMode: 'bypassPermissions',
    tools: [{ name: 'Bash' }, 'StructuredOutput'], mcp_servers: [], apiKeySource: 'none',
  } as unknown as SDKMessage, { currentTurnId: undefined });
  assert.ok(drifted?.type === 'session_ready');
  assert.equal('initFingerprint' in drifted, false, 'a mixed tools array must not silently drop the non-string entries into a passing fingerprint');
  assert.equal(initToolViolation(drifted.initFingerprint, ['StructuredOutput']), 'system/init reported no tools list, so the explicit empty allow list cannot be verified');
});

test('M1 replay: the recorded zero-tool structured turn passes the invariant and completes with its output', async () => {
  const messages = readM1Fixture('success_messages') as unknown[];
  const result = readM1Fixture('success_result') as { structured_output: unknown };
  const { session, fake, turnId, events } = await replay({ policy: COMPLETION, outputFormat: SCHEMA }, messages);
  const ready = events.find((e) => e.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual([...(ready.initFingerprint?.tools ?? [])].sort(), [...m1Manifest().init_tools].sort());
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.turnId, turnId);
  assert.equal(completed.outcome, 'completed');
  assert.deepEqual(completed.structuredOutput, result.structured_output);
  assert.equal(events.some((e) => e.type === 'session_closed'), false, 'a clean completion must not trip the invariant');
  assert.equal(fake.controller.closed, false);
  session.close();
});

test('M1 replay: the same recording with one extra init tool closes the session before anything else of the turn', async () => {
  const messages = (readM1Fixture('success_messages') as Array<Record<string, unknown>>).map((m) =>
    m.type === 'system' && m.subtype === 'init' ? { ...m, tools: [...(m.tools as string[]), 'Bash'] } : m,
  );
  const { fake, turnId, events } = await replay({ policy: COMPLETION, outputFormat: SCHEMA }, messages);
  const types = events.map((e) => e.type);
  const readyAt = types.indexOf('session_ready');
  assert.ok(readyAt >= 0, 'the offending session_ready is still reported, so the caller sees the tools');
  assert.deepEqual(types.slice(readyAt + 1), ['turn_completed', 'session_closed'], 'nothing of the turn is translated after the violation');
  const completed = events[readyAt + 1];
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.turnId, turnId);
  assert.equal(completed.outcome, 'failed');
  assert.equal('structuredOutput' in completed, false);
  assert.deepEqual(events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
  assert.equal(fake.controller.closed, true, 'the provider process is closed');
});

test('an empty allow list WITHOUT an output format permits no tools at all, not even the carrier', async () => {
  const messages = readM1Fixture('success_messages') as unknown[];
  const { events } = await replay({ policy: COMPLETION }, messages);
  const expectViolation = m1Manifest().init_tools.length > 0;
  assert.equal(events.some((e) => e.type === 'session_closed' && e.reason === 'tool_policy_violation'), expectViolation);
});

test('a system/init with no tools list fails closed under an empty allow list', async () => {
  const { events } = await replay({ policy: COMPLETION, outputFormat: SCHEMA }, [
    { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/project', permissionMode: 'bypassPermissions' },
  ]);
  assert.deepEqual(events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
});

test('sessions without an empty allow list are never checked (the investigator shape keeps every tool)', async () => {
  const { session, events } = await replay({ policy: { ...COMPLETION, configuration: 'native', toolPolicy: { unrestricted: true } } }, [
    { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/project', permissionMode: 'bypassPermissions', tools: ['Bash', 'Read', 'Write'] },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn' },
  ]);
  assert.equal(events.some((e) => e.type === 'session_closed'), false);
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.equal(completed?.type === 'turn_completed' ? completed.outcome : null, 'completed');
  session.close();
});

// Consumer client spec §9.1 「录带工具时的初始化指纹」: the web-tools recording (promote-web) pins what
// a tool-bearing completion's system/init reports -- exactly the carrier plus the two web tools --
// and that WebFetch's own Haiku call was billed inside the proven session.
test('the web-tools recording: init reports exactly the carrier plus WebFetch and WebSearch', () => {
  const manifest = m1Manifest();
  assert.ok(manifest.web_init_tools !== undefined, 'no web-tools recording in the M1 fixtures: run the web-tools case and promote-web');
  const want = [...new Set([...STRUCTURED_OUTPUT_CARRIER_TOOLS, 'WebFetch', 'WebSearch'])].sort();
  assert.deepEqual([...manifest.web_init_tools].sort(), want);
  const init = readM1Fixture('success_web_init') as { tools: string[]; permissionMode: string };
  assert.deepEqual([...init.tools].sort(), want);
  assert.equal(init.permissionMode, 'bypassPermissions');
  assert.ok((manifest.web_haiku_models ?? []).length > 0, "the recording shows no Haiku use: WebFetch's own model call was not attributed to the session");
});

test('M1 web replay: the recorded web init passes the web allow list and fails the zero-tool one', async () => {
  const init = readM1Fixture('success_web_init') as Record<string, unknown>;
  const result = { type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', structured_output: { title: 'Example Domain' } };
  const web: ClaudeHostPolicy = { ...COMPLETION, toolPolicy: { allow: ['WebFetch', 'WebSearch'] } };
  const passing = await replay({ policy: web, outputFormat: SCHEMA }, [init, result]);
  assert.equal(passing.events.some((e) => e.type === 'session_closed'), false);
  passing.session.close();
  const zero = await replay({ policy: COMPLETION, outputFormat: SCHEMA }, [init, result]);
  assert.deepEqual(zero.events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' });
});

// ---- initCheck: absent and 'verify' behave as before the field existed; 'report_only' never closes ----

/** The recording with one tool the allow list does not name, as a CLI that ignored the list would send it. */
function recordingWithExtraTool(): unknown[] {
  return (readM1Fixture('success_messages') as Array<Record<string, unknown>>).map((m) =>
    m.type === 'system' && m.subtype === 'init' ? { ...m, tools: [...(m.tools as string[]), 'Bash'] } : m,
  );
}

/** Events with the per-turn random id taken out, so two runs of one scenario compare equal. */
function shapeOf(events: ClaudeRuntimeEvent[], turnId: string): unknown[] {
  return events.map((e) => ('turnId' in e && e.turnId === turnId ? { ...e, turnId: '<turn>' } : e));
}

test('verifiesInitTools: no allow list is not checked; an allow list is verified unless it says report_only', () => {
  assert.equal(verifiesInitTools({ policy: { ...COMPLETION, toolPolicy: undefined } }), undefined);
  assert.equal(verifiesInitTools({ policy: { ...COMPLETION, toolPolicy: { unrestricted: true } } }), undefined);
  assert.equal(verifiesInitTools({ policy: COMPLETION }), true, 'absent initCheck verifies');
  assert.equal(verifiesInitTools({ policy: { ...COMPLETION, toolPolicy: { allow: [], initCheck: 'verify' } } }), true);
  assert.equal(verifiesInitTools({ policy: { ...COMPLETION, toolPolicy: { allow: [], initCheck: 'report_only' } } }), false);
});

test('initCheck changes nothing the SDK is told: Options are identical for absent, verify and report_only', () => {
  for (const allow of [[], ['WebFetch', 'WebSearch']]) {
    const absent = buildSessionOptions({ cwd: '/tmp/project', policy: { ...COMPLETION, toolPolicy: { allow } }, outputFormat: SCHEMA });
    for (const initCheck of ['verify', 'report_only'] as const) {
      const stated = buildSessionOptions({ cwd: '/tmp/project', policy: { ...COMPLETION, toolPolicy: { allow, initCheck } }, outputFormat: SCHEMA });
      assert.deepEqual(stated, absent, `${initCheck} with allow ${JSON.stringify(allow)}`);
    }
    assert.deepEqual(absent.tools, allow, 'Options.tools is the allow list as it is');
  }
});

test('an extra init tool: absent initCheck and verify close the session the same way; report_only does not close', async () => {
  const runs = new Map<string, { events: ClaudeRuntimeEvent[]; turnId: string; closed: boolean }>();
  for (const initCheck of [undefined, 'verify', 'report_only'] as const) {
    const policy: ClaudeHostPolicy = { ...COMPLETION, toolPolicy: initCheck === undefined ? { allow: [] } : { allow: [], initCheck } };
    const { session, fake, turnId, events } = await replay({ policy, outputFormat: SCHEMA }, recordingWithExtraTool());
    runs.set(String(initCheck), { events, turnId, closed: fake.controller.closed });
    session.close();
  }
  const absent = runs.get('undefined')!;
  const verify = runs.get('verify')!;
  const reportOnly = runs.get('report_only')!;

  assert.deepEqual(absent.events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' }, 'absent still verifies');
  assert.equal(absent.closed, true);
  assert.deepEqual(shapeOf(verify.events, verify.turnId), shapeOf(absent.events, absent.turnId), 'verify is absent, said explicitly');

  assert.equal(reportOnly.events.some((e) => e.type === 'session_closed'), false, 'report_only never closes over the mismatch');
  assert.equal(reportOnly.closed, false);
  const ready = reportOnly.events.find((e) => e.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.ok(ready.initFingerprint?.tools.includes('Bash'), 'the fingerprint still reports what the CLI built, extra tool included');
  const completed = reportOnly.events.find((e) => e.type === 'turn_completed');
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.outcome, 'completed', 'the turn runs on');
});

test('report_only also tolerates a missing requested tool and a system/init with no tools list', async () => {
  const init = readM1Fixture('success_web_init') as Record<string, unknown>;
  const withoutWebSearch = { ...init, tools: (init.tools as string[]).filter((t) => t !== 'WebSearch') };
  const result = { type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', structured_output: {} };
  const web = (initCheck?: 'verify' | 'report_only'): ClaudeHostPolicy => ({
    ...COMPLETION,
    toolPolicy: initCheck === undefined ? { allow: ['WebFetch', 'WebSearch'] } : { allow: ['WebFetch', 'WebSearch'], initCheck },
  });
  const bare = { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/project', permissionMode: 'bypassPermissions' };
  for (const [name, messages] of [['missing WebSearch', [withoutWebSearch, result]], ['no tools list', [bare, result]]] as const) {
    const verified = await replay({ policy: web(), outputFormat: SCHEMA }, [...messages]);
    assert.deepEqual(verified.events.at(-1), { type: 'session_closed', reason: 'tool_policy_violation' }, `${name}: absent verifies`);
    const reported = await replay({ policy: web('report_only'), outputFormat: SCHEMA }, [...messages]);
    assert.equal(reported.events.some((e) => e.type === 'session_closed'), false, `${name}: report_only does not close`);
    reported.session.close();
  }
});

test('initCheck without an allow list is refused before any provider is started', () => {
  assert.equal(initCheckProblem({ policy: COMPLETION }), null);
  assert.equal(initCheckProblem({ policy: { ...COMPLETION, toolPolicy: { allow: [], initCheck: 'report_only' } } }), null);
  for (const toolPolicy of [{ initCheck: 'verify' as const }, { deny: ['Bash'], initCheck: 'report_only' as const }, { unrestricted: true, initCheck: 'report_only' as const }]) {
    let started = 0;
    assert.throws(
      () => createSession({ cwd: '/tmp/project', policy: { ...COMPLETION, toolPolicy } }, () => {
        started += 1;
        return makeFakeQuery().query;
      }),
      /initCheck is "(verify|report_only)" but there is no toolPolicy.allow/,
      JSON.stringify(toolPolicy),
    );
    assert.equal(started, 0, 'no provider process for a policy that cannot be honoured');
  }
});
