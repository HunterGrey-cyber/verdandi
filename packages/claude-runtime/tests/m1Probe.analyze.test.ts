import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCase, type CaseName } from '../probes/m1/cases.js';
import type { AccountInventory, CaseRecord } from '../probes/m1/runner.js';
import {
  analyzeCase,
  answerQuestions,
  carrierTool,
  failureShape,
  label,
  turnEndShape,
  usageSplit,
  type CaseVerdict,
} from '../probes/m1/analyze.js';

const SO = { scores: [{ id: 'c001', score: 70 }], picks: [{ id: 'c001', summary_zh: '摘要', reason_zh: '理由' }], events: [], weekly: [] };
const INIT = { type: 'system', subtype: 'init', session_id: 's1', tools: ['StructuredOutput'], permissionMode: 'bypassPermissions', claude_code_version: '2.1.280', model: 'claude-sonnet-5', mcp_servers: [], plugins: [], skills: ['update-config'] };
const CARRIER = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'StructuredOutput', input: SO }] } };
const TOOL_RESULT = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } };
const RESULT_OK = {
  type: 'result', subtype: 'success', is_error: false, result: '', structured_output: SO, terminal_reason: 'completed', session_id: 's1', total_cost_usd: 0.05,
  usage: { input_tokens: 2, cache_creation_input_tokens: 11000, cache_read_input_tokens: 0, output_tokens: 900 },
  modelUsage: { 'claude-sonnet-5': { inputTokens: 2, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 11000, costUSD: 0.05 } },
};
const RESULT_401 = { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401', api_error_status: 401, terminal_reason: 'api_error', errors: [], session_id: 's2' };
const INFO = { ok: true as const, ms: 3, info: { email: 'work@example.invalid' } };
const EMPTY_INVENTORY: AccountInventory = { settings_hook_events: [], enabled_plugins: [], user_mcp_servers: [], skill_dirs: [], claude_md_present: false, claude_json_projects: 3 };

function record(name: CaseName, messages: unknown[], extra: Partial<CaseRecord> = {}): CaseRecord {
  return {
    case: name, started_at: '2026-09-23T00:00:00.000Z', finished_at: '2026-09-23T00:01:00.000Z', duration_ms: 60_000,
    cwd: '/tmp/m1-probe-x', account: { name: 'work', configDir: '/home/probe/.claude-work' }, options_summary: null,
    guard_violations: [], messages: messages.map((message, i) => ({ t_ms: i, message })), next_rejection: null,
    kernel_events: [{ type: 'turn_completed', turnId: 't', outcome: 'completed', resultText: '', isError: false, stopReason: null }],
    permission_requests: [], hook_observations: [], account_info_before_turn: INFO, account_info_after_turn: INFO,
    transcript: { path: '/home/probe/.claude-work/projects/-tmp-m1-probe-x/s1.jsonl', entries: [{ type: 'attachment', attachment: { type: 'structured_output' } }] },
    timed_out: false, runner_error: null, ...extra,
  };
}

const OK_MESSAGES = [INIT, CARRIER, TOOL_RESULT, RESULT_OK];

test('analyzeCase: a zero-tool structured turn under bypass is as expected', () => {
  const v = analyzeCase(buildCase('success'), record('success', OK_MESSAGES), { expectEmail: 'work@example.invalid' });
  assert.deepEqual(v, { case: 'success', status: 'as_expected', reasons: [] });
});

test('analyzeCase: extra init tools, a downgraded mode and a wrong email each diverge', () => {
  const messages = [{ ...INIT, tools: ['StructuredOutput', 'Bash'], permissionMode: 'default' }, CARRIER, TOOL_RESULT, RESULT_OK];
  const v = analyzeCase(buildCase('success'), record('success', messages), { expectEmail: 'someone-else@example.invalid' });
  assert.equal(v.status, 'diverged');
  assert.ok(v.reasons.some((r) => r.includes('["Bash"]')));
  assert.ok(v.reasons.some((r) => r.startsWith('init.permissionMode is "default"')));
  assert.ok(v.reasons.some((r) => r.startsWith('accountInfo().email is work@example.invalid')));
});

test('analyzeCase: a failure case diverges when the turn succeeds, holds when it fails', () => {
  assert.equal(analyzeCase(buildCase('auth-invalid'), record('auth-invalid', OK_MESSAGES), { expectEmail: null }).status, 'diverged');
  assert.equal(analyzeCase(buildCase('auth-invalid'), record('auth-invalid', [RESULT_401]), { expectEmail: null }).status, 'as_expected');
});

test('analyzeCase: the control case needs an InstructionsLoaded under its cwd', () => {
  const def = buildCase('control-claudemd');
  assert.equal(analyzeCase(def, record('control-claudemd', [INIT]), { expectEmail: null }).status, 'diverged');
  const seen = record('control-claudemd', [INIT], {
    hook_observations: [{ t_ms: 1, event: 'InstructionsLoaded', input: { file_path: '/tmp/m1-probe-x/CLAUDE.md', memory_type: 'Project' } }],
  });
  assert.equal(analyzeCase(def, seen, { expectEmail: null }).status, 'as_expected');
});

test('failureShape: reads the result fields P3 maps error classes from', () => {
  assert.deepEqual(failureShape(record('auth-invalid', [RESULT_401])), {
    observed_as: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 401, errors: [],
    result_text: 'Failed to authenticate. API Error: 401', assistant_error: null, rejection: null, rate_limit_status: null,
  });
  const died = failureShape(record('auth-invalid', [], { next_rejection: 'Claude Code process exited with code 1' }));
  assert.equal(died.observed_as, 'provider_failure');
  assert.equal(died.rejection, 'Claude Code process exited with code 1');
});

test('usageSplit and turnEndShape on the expected structured-output turn', () => {
  const usage = usageSplit(RESULT_OK);
  assert.equal(usage.input_tokens_total, 11002);
  assert.equal(usage.cache_dominant, true);
  assert.equal(usageSplit(null).usage, null);
  const shape = turnEndShape(OK_MESSAGES);
  assert.deepEqual(shape.sequence, ['system/init', 'assistant/tool_use:StructuredOutput', 'user/tool_result', 'result/success']);
  assert.equal(shape.trailing_assistant_after_tool_result, false);
  assert.equal(turnEndShape([INIT, CARRIER, TOOL_RESULT, { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, RESULT_OK]).trailing_assistant_after_tool_result, true);
  assert.equal(carrierTool(OK_MESSAGES), 'StructuredOutput');
  assert.equal(label({ type: 'attachment', attachment: { type: 'structured_output' } }), 'attachment/structured_output');
});

test('CLI drift: unknown message shapes never throw; they diverge', () => {
  const junk = [42, 'x', null, [], { type: 'result' }, { type: 'assistant', message: 'no blocks' }];
  const v = analyzeCase(buildCase('success'), record('success', junk, { kernel_events: [], transcript: null }), { expectEmail: null });
  assert.equal(v.status, 'diverged');
  const answers = answerQuestions({ records: {}, verdicts: {}, inventoryBefore: EMPTY_INVENTORY, inventoryAfter: EMPTY_INVENTORY, pinnedConfigDir: '/c', cliVersionFlag: '', promptBytes: 0, estimatedTokens: 0 });
  assert.equal(answers.q2.recommendation, 'fallback_plain_json');
  assert.equal(answers.q1.carrier_tool, null);
});

test('answerQuestions: recommendation, identity, isolation channels and passive quota detection', () => {
  const verdicts: Partial<Record<CaseName, CaseVerdict>> = {
    success: { case: 'success', status: 'as_expected', reasons: [] },
    'control-claudemd': { case: 'control-claudemd', status: 'as_expected', reasons: [] },
  };
  const throttled = record('schema-unsatisfiable', [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }, RESULT_401]);
  const answers = answerQuestions({
    records: { success: record('success', OK_MESSAGES), 'schema-unsatisfiable': throttled },
    verdicts,
    inventoryBefore: { ...EMPTY_INVENTORY, settings_hook_events: ['SessionStart'], claude_md_present: true, skill_dirs: ['update-config'] },
    inventoryAfter: { ...EMPTY_INVENTORY, claude_json_projects: 4 },
    pinnedConfigDir: '/home/probe/.claude-work',
    cliVersionFlag: '2.1.280 (Claude Code)\n',
    promptBytes: 44_000,
    estimatedTokens: 11_000,
  });
  assert.equal(answers.q2.recommendation, 'bypass_allow_empty');
  assert.equal(answers.q1.carrier_tool, 'StructuredOutput');
  assert.equal(answers.q1.transcript_has_structured_output_attachment, true);
  assert.equal(answers.identity.transcript_under_account_dir, true);
  assert.equal(answers.cli.same_binary, true);
  assert.equal(answers.q5.ratio_total_to_estimate, 1);
  const verdictOf = (channel: string) => answers.q4.channels.find((c) => c.channel === channel)?.verdict;
  assert.equal(verdictOf('settings hooks'), 'closed');
  assert.equal(verdictOf('CLAUDE.md / rules'), 'closed');
  assert.equal(verdictOf('skills'), 'leaks');
  assert.equal(verdictOf('MCP servers'), 'nothing_to_leak');
  assert.equal(answers.q4.claude_json_projects_after, 4);
  assert.equal(answers.q6.quota?.rate_limit_status, 'rejected');
});

// The shape M1 measured on host-a (CLI 2.1.281) for an unsatisfiable schema: two StructuredOutput
// calls rejected, one [structured-output-enforce] nudge, then a plain-text success result with no
// structured_output. That IS the failure the case induces.
const REJECTED = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Output does not match required schema: /n: must be <= 5, /n: must be >= 10', is_error: true }] } };
const NUDGE = { type: 'user', message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.' } };
const N7 = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'StructuredOutput', input: { n: 7 } }] } };
const RESULT_NO_SO = { type: 'result', subtype: 'success', is_error: false, result: 'I cannot satisfy n <= 5 and n >= 10.', terminal_reason: 'completed', session_id: 's3' };

test('analyzeCase: schema-unsatisfiable holds on success without structured_output; auth-invalid keeps its rule', () => {
  const gaveUp = [INIT, N7, REJECTED, NUDGE, N7, REJECTED, RESULT_NO_SO];
  assert.deepEqual(analyzeCase(buildCase('schema-unsatisfiable'), record('schema-unsatisfiable', gaveUp), { expectEmail: null }), {
    case: 'schema-unsatisfiable', status: 'as_expected', reasons: [],
  });
  const delivered = analyzeCase(buildCase('schema-unsatisfiable'), record('schema-unsatisfiable', [INIT, N7, { ...RESULT_NO_SO, structured_output: { n: 7 } }]), { expectEmail: null });
  assert.equal(delivered.status, 'diverged');
  assert.ok(delivered.reasons.includes('structured_output was delivered'));
  // A throwaway account that authenticated has not failed, whether or not the model then delivered.
  assert.equal(analyzeCase(buildCase('auth-invalid'), record('auth-invalid', [INIT, RESULT_NO_SO]), { expectEmail: null }).status, 'diverged');
});

const instructionsEntry = (path: string) => ({ type: 'attachment', attachment: { type: 'instructions', files: [{ path, type: 'Project', content: '# M1 control' }] } });

test('analyzeCase: the control case also accepts the transcript instructions attachment under its cwd', () => {
  const def = buildCase('control-claudemd');
  const withTranscript = (path: string) => record('control-claudemd', [INIT], { transcript: { path: '/home/probe/.claude-work/projects/p/c.jsonl', entries: [instructionsEntry(path)] } });
  assert.equal(analyzeCase(def, withTranscript('/tmp/m1-probe-x/CLAUDE.md'), { expectEmail: null }).status, 'as_expected');
  assert.equal(analyzeCase(def, withTranscript('/home/probe/.claude-work/CLAUDE.md'), { expectEmail: null }).status, 'diverged');
});

test('answerQuestions: CLAUDE.md is read from the transcript too; plugins count only account plugins', () => {
  const builtins = [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }, { name: 'telemetry', path: 'builtin', source: 'telemetry@builtin' }];
  const inventory: AccountInventory = { ...EMPTY_INVENTORY, claude_md_present: true, enabled_plugins: ['superpowers@claude-plugins-official'], skill_dirs: ['mac'] };
  const verdicts: Partial<Record<CaseName, CaseVerdict>> = {
    success: { case: 'success', status: 'as_expected', reasons: [] },
    'control-claudemd': { case: 'control-claudemd', status: 'as_expected', reasons: [] },
  };
  const ask = (success: CaseRecord, channel: string) =>
    answerQuestions({ records: { success }, verdicts, inventoryBefore: inventory, inventoryAfter: inventory, pinnedConfigDir: '/home/probe/.claude-work', cliVersionFlag: '2.1.281', promptBytes: 4, estimatedTokens: 1 })
      .q4.channels.find((c) => c.channel === channel);

  const clean = ask(record('success', [{ ...INIT, plugins: builtins }, CARRIER, TOOL_RESULT, RESULT_OK]), 'plugins');
  assert.deepEqual(clean, { channel: 'plugins', available: inventory.enabled_plugins, observed: [], not_from_account: ['agents-md@builtin', 'telemetry@builtin'], verdict: 'closed' });
  const withAccountPlugin = [...builtins, { name: 'superpowers', path: '/p', source: 'superpowers@claude-plugins-official' }];
  const leaked = ask(record('success', [{ ...INIT, plugins: withAccountPlugin }, CARRIER, TOOL_RESULT, RESULT_OK]), 'plugins');
  assert.equal(leaked?.verdict, 'leaks');
  assert.deepEqual(leaked?.observed, ['superpowers@claude-plugins-official']);

  assert.equal(ask(record('success', OK_MESSAGES), 'CLAUDE.md / rules')?.verdict, 'closed');
  const loaded = ask(record('success', OK_MESSAGES, { transcript: { path: '/home/probe/.claude-work/projects/p/s1.jsonl', entries: [instructionsEntry('/home/probe/.claude-work/CLAUDE.md')] } }), 'CLAUDE.md / rules');
  assert.equal(loaded?.verdict, 'leaks');
  assert.deepEqual(loaded?.observed, ['/home/probe/.claude-work/CLAUDE.md']);
  // With no transcript half the observer the control proved is missing: never report "closed".
  assert.equal(ask(record('success', OK_MESSAGES, { transcript: null }), 'CLAUDE.md / rules')?.verdict, 'observer_unverified');
});
