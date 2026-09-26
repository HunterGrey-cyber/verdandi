import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { M1Answers } from '../probes/m1/analyze.js';
import {
  buildManifest,
  buildRedactionRules,
  compareToBaseline,
  leaks,
  redactDeep,
  renderAppendix,
  type ProbeMeta,
} from '../probes/m1/report.js';

const META: ProbeMeta = {
  host: 'host-a', started_at: '2026-09-23T20:00:00.000Z', finished_at: '2026-09-23T20:05:00.000Z',
  cli_path: '/home/user/.local/bin/claude', cli_realpath: '/home/user/.local/share/claude/versions/2.1.280', cli_version_flag: '2.1.280 (Claude Code)',
  sdk_version: '0.3.252', node_version: 'v22.23.2', git_head: 'abc123', account: { name: 'work', config_dir: '/home/user/.claude-work' },
  model: 'sonnet', effort: 'medium', cases: ['success'],
};

const AUTH = { observed_as: 'result' as const, subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 401, errors: [], result_text: 'x', assistant_error: null, rejection: null, rate_limit_status: null };

function answers(overrides: Partial<M1Answers['q1']> = {}): M1Answers {
  return {
    q1: { structured_output_delivered: true, init_tools: ['StructuredOutput'], init_model: 'claude-sonnet-5', carrier_tool: 'StructuredOutput', transcript_labels: [], transcript_has_structured_output_attachment: true, ...overrides },
    q2: { cases: { success: 'as_expected' }, init_permission_mode: 'bypassPermissions', permission_requests: 0, recommendation: 'bypass_allow_empty' },
    q3: { sequence: [], trailing_assistant_after_tool_result: false, messages_after_result: [], kernel_turn_completed_outcome: 'completed', kernel_result_text: '' },
    q4: { channels: [{ channel: 'plugins', available: [], observed: [], not_from_account: ['agents-md@builtin'], verdict: 'nothing_to_leak' }], claude_json_projects_before: 1, claude_json_projects_after: 2 },
    q5: { usage: null, model_usage: null, input_tokens_total: 11002, output_tokens_total: 900, total_cost_usd: 0.05, cache_dominant: true, prompt_bytes: 1, estimated_tokens: 1, ratio_total_to_estimate: 1 },
    q6: { auth: AUTH, schema_retry: null, quota: null },
    identity: { account_info_before_turn: { ok: true, ms: 4, info: { email: 'owner.work@mail.test' } }, account_info_after_turn: null, transcript_path: null, transcript_under_account_dir: false },
    cli: { version_flag: '2.1.280 (Claude Code)', init_version: '2.1.280', same_binary: true },
  };
}

test('redaction: nested values and keys are rewritten, longest rule first, and leaks() finds residue', () => {
  const rules = buildRedactionRules({ home: '/home/user', email: 'owner.work@mail.test', organization: "owner.work@mail.test's Organization", tempPaths: ['/tmp/m1-probe-success-AbC'] });
  const out = redactDeep(
    { cwd: '/tmp/m1-probe-success-AbC', nested: [{ '/home/user/.claude-work': "owner.work@mail.test's Organization" }], n: 3 },
    rules,
  );
  assert.deepEqual(out, { cwd: '/tmp/m1-probe-path', nested: [{ '/home/m1-probe/.claude-work': 'm1-probe-organization' }], n: 3 });
  assert.deepEqual(leaks(JSON.stringify(out), rules), []);
  assert.deepEqual(leaks('mail owner.work@mail.test', rules), ['account email']);
});

test('buildManifest: records what later plans key on', () => {
  const manifest = buildManifest({ meta: META, answers: answers(), files: { success_result: 'success.result.json' }, redactions: ['account email'] });
  assert.equal(manifest.schema, 'verdandi.m1-fixtures/v1');
  assert.equal(manifest.carrier_tool, 'StructuredOutput');
  assert.equal(manifest.permission_mode, 'bypassPermissions');
  assert.equal(manifest.usage_shape, 'cache_dominant');
  assert.equal(manifest.account_info_before_first_turn, 'ok');
  assert.equal(manifest.cli_version, '2.1.280');
});

test('compareToBaseline: same facts pass, a changed carrier fails, a CLI bump is only a note', () => {
  const baseline = buildManifest({ meta: META, answers: answers(), files: {}, redactions: [] });
  const verdicts = [{ case: 'success' as const, status: 'as_expected' as const, reasons: [] }];
  assert.deepEqual(compareToBaseline(answers(), verdicts, baseline), { differences: [], notes: [] });
  const changed = compareToBaseline(answers({ carrier_tool: 'Output', init_tools: ['Output'] }), verdicts, baseline);
  assert.equal(changed.differences.length, 2);
  const bumped = answers();
  bumped.cli.init_version = '2.1.290';
  const result = compareToBaseline(bumped, verdicts, baseline);
  assert.deepEqual(result.differences, []);
  assert.equal(result.notes.length, 1);
});

test('renderAppendix: one table row per case and a line for every question', () => {
  const md = renderAppendix(META, answers(), [{ case: 'success', status: 'as_expected', reasons: [] }]);
  assert.ok(md.includes('| success | as_expected | - |'));
  for (const heading of ['**Q1', '**Q2', '**Q3', '**Q4', '**Q5', '**Q6']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(md.includes('| plugins | [] | [] | nothing_to_leak | ["agents-md@builtin"] |'));
  assert.equal(md.includes('| reanalyzed |'), false);
  const again = renderAppendix({ ...META, reanalyzed: { at: '2026-09-24T09:00:00.000Z', git_head: 'def456' } }, answers(), []);
  assert.ok(again.includes('| reanalyzed | 2026-09-24T09:00:00.000Z at verdandi def456 '));
});
