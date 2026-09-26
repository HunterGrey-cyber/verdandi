import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseCli, promoteCommand, reanalyzeCommand } from '../probes/m1/main.js';

test('parseCli: run defaults to the four default cases in canonical order', () => {
  assert.deepEqual(parseCli(['run']), {
    command: 'run', cases: ['success', 'control-claudemd', 'auth-invalid', 'schema-unsatisfiable'], out: null,
    expectEmail: null, baseline: null, model: 'sonnet', effort: 'medium', dryRun: false, lanUrls: [],
  });
  const picked = parseCli(['run', '--cases', 'dontask,success', '--dry-run']);
  assert.equal(picked.command, 'run');
  assert.deepEqual(picked.command === 'run' ? picked.cases : [], ['success', 'dontask']);
});

test('parseCli: unknown cases, bad effort and an incomplete promote are rejected', () => {
  assert.throws(() => parseCli(['run', '--cases', 'success,bogus']), /unknown case "bogus"/);
  assert.throws(() => parseCli(['run', '--effort', 'ludicrous']), /--effort/);
  assert.throws(() => parseCli(['promote', '--run', '/tmp/x']), /--run and --dest/);
  assert.throws(() => parseCli(['reanalyze']), /reanalyze needs --run/);
  assert.deepEqual(parseCli(['reanalyze', '--run', '/tmp/x', '--expect-email', 'a@b.invalid']), { command: 'reanalyze', run: '/tmp/x', expectEmail: 'a@b.invalid', baseline: null });
  assert.throws(() => parseCli([]), /usage/);
});

test('main: argument errors exit 2 without touching any account', async () => {
  assert.equal(await main(['bogus']), 2);
});

function writeRun(dir: string, successStatus: 'as_expected' | 'diverged'): void {
  const email = 'owner.work@mail.test';
  const cwd = join(tmpdir(), 'm1-probe-success-zz');
  const success = {
    case: 'success', cwd, account: { name: 'work', configDir: join(homedir(), '.claude-work') },
    messages: [
      { t_ms: 1, message: { type: 'system', subtype: 'init', cwd, tools: [], permissionMode: 'bypassPermissions' } },
      { t_ms: 2, message: { type: 'result', subtype: 'success', is_error: false, structured_output: { scores: [], picks: [], events: [], weekly: [] }, note: `mail ${email}` } },
    ],
    next_rejection: null,
    account_info_before_turn: { ok: true, ms: 1, info: { email, organization: `${email}'s Organization` } },
    account_info_after_turn: null,
    transcript: { path: join(homedir(), '.claude-work', 'projects', 'p', 's.jsonl'), entries: [{ type: 'user', cwd }] },
  };
  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(join(dir, 'cases', 'success.json'), JSON.stringify(success));
  const answers = {
    q1: { structured_output_delivered: true, init_tools: [], init_model: 'claude-sonnet-5', carrier_tool: 'StructuredOutput', transcript_labels: [], transcript_has_structured_output_attachment: false },
    q2: { cases: {}, init_permission_mode: 'bypassPermissions', permission_requests: 0, recommendation: 'bypass_allow_empty' },
    q3: { sequence: [], trailing_assistant_after_tool_result: null, messages_after_result: [], kernel_turn_completed_outcome: 'completed', kernel_result_text: '' },
    q4: { channels: [], claude_json_projects_before: null, claude_json_projects_after: null },
    q5: { usage: null, model_usage: null, input_tokens_total: null, output_tokens_total: null, total_cost_usd: null, cache_dominant: null, prompt_bytes: 0, estimated_tokens: 0, ratio_total_to_estimate: null },
    q6: { auth: null, schema_retry: null, quota: null },
    identity: { account_info_before_turn: success.account_info_before_turn, account_info_after_turn: null, transcript_path: success.transcript.path, transcript_under_account_dir: true },
    cli: { version_flag: '2.1.280 (Claude Code)', init_version: '2.1.280', same_binary: true },
  };
  const meta = { host: 'host-a', started_at: '2026-09-23T20:00:00.000Z', finished_at: '', cli_path: '/c', cli_realpath: '/c', cli_version_flag: '2.1.280', sdk_version: '0.3.252', node_version: 'v22', git_head: null, account: { name: 'work', config_dir: join(homedir(), '.claude-work') }, model: 'sonnet', effort: 'medium', cases: ['success'] };
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ meta, verdicts: [{ case: 'success', status: successStatus, reasons: [] }], answers }));
}

test('promoteCommand: writes redacted fixtures and a manifest', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-promote-dest-'));
  try {
    writeRun(run, 'as_expected');
    assert.equal(promoteCommand({ command: 'promote', run, dest }), 0);
    const written = readdirSync(dest).sort();
    assert.deepEqual(written, ['manifest.json', 'success.account-info.json', 'success.init.json', 'success.messages.json', 'success.prompt.json', 'success.result.json', 'success.transcript.json']);
    const all = written.map((f) => readFileSync(join(dest, f), 'utf8')).join('\n');
    assert.equal(all.includes('owner.work@mail.test'), false);
    assert.equal(all.includes(homedir()), false);
    assert.ok(all.includes('work@example.invalid'));
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as { schema: string; files: Record<string, string> };
    assert.equal(manifest.schema, 'verdandi.m1-fixtures/v1');
    assert.equal(manifest.files.success_result, 'success.result.json');
    assert.equal(manifest.files.success_prompt, 'success.prompt.json');
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('promoteCommand: refuses a run whose success case diverged, writing nothing', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-run-'));
  const dest = join(tmpdir(), `m1-promote-never-${process.pid}`);
  try {
    writeRun(run, 'diverged');
    assert.equal(promoteCommand({ command: 'promote', run, dest }), 1);
    assert.throws(() => readdirSync(dest));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

/**
 * A recorded default run as the analyzer before the I-1/I-2 fix judged it: the control and the
 * schema case both "diverged", and the builtin plugins counted as a leak.
 */
function writeRecordedRun(dir: string): void {
  const email = 'owner.work@mail.test';
  const configDir = join(homedir(), '.claude-work');
  const info = { ok: true, ms: 1, info: { email, organization: `${email}'s Organization` } };
  const completed = { type: 'turn_completed', turnId: 't', outcome: 'completed', resultText: '', isError: false, stopReason: null };
  const plugins = [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }];
  const init = (cwd: string) => ({ type: 'system', subtype: 'init', cwd, tools: ['StructuredOutput'], permissionMode: 'bypassPermissions', claude_code_version: '2.1.281', model: 'claude-sonnet-5', plugins, skills: ['update-config'], mcp_servers: [] });
  const base = (name: string, suffix: string) => {
    const cwd = join(tmpdir(), `m1-probe-${name}-${suffix}`);
    return {
      case: name, started_at: '2026-09-24T01:10:40.622Z', finished_at: '2026-09-24T01:11:40.622Z', duration_ms: 60_000, cwd,
      account: { name: 'work', configDir }, options_summary: null, guard_violations: [], next_rejection: null,
      kernel_events: [completed], permission_requests: [], hook_observations: [], account_info_before_turn: info, account_info_after_turn: info,
      timed_out: false, runner_error: null,
    };
  };
  const at = (messages: unknown[]) => messages.map((message, i) => ({ t_ms: i, message }));
  const success = base('success', 'aa');
  const so = { scores: [], picks: [], events: [], weekly: [] };
  const records: Record<string, unknown> = {
    success: {
      ...success,
      messages: at([init(success.cwd), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', name: 'StructuredOutput', input: so }] } }, { type: 'result', subtype: 'success', is_error: false, structured_output: so, terminal_reason: 'completed' }]),
      transcript: { path: join(configDir, 'projects', 'p', 's.jsonl'), entries: [{ type: 'attachment', attachment: { type: 'structured_output' } }] },
    },
  };
  const control = base('control-claudemd', 'bb');
  records['control-claudemd'] = {
    ...control,
    messages: at([init(control.cwd), { type: 'result', subtype: 'success', is_error: false, result: 'ok' }]),
    transcript: { path: join(configDir, 'projects', 'p', 'c.jsonl'), entries: [{ type: 'attachment', attachment: { type: 'instructions', files: [{ path: join(control.cwd, 'CLAUDE.md'), type: 'Project' }] } }] },
  };
  const schema = base('schema-unsatisfiable', 'cc');
  records['schema-unsatisfiable'] = {
    ...schema,
    messages: at([init(schema.cwd), { type: 'result', subtype: 'success', is_error: false, result: 'cannot', terminal_reason: 'completed', total_cost_usd: 0.01 }]),
    transcript: null,
  };
  mkdirSync(join(dir, 'cases'), { recursive: true });
  for (const [name, value] of Object.entries(records)) {
    writeFileSync(join(dir, 'cases', `${name}.json`), JSON.stringify(value));
  }
  const channel = (name: string, available: string[]) => ({ channel: name, available, observed: [], verdict: 'closed' });
  const answers = {
    q4: {
      channels: [channel('settings hooks', ['Stop']), channel('CLAUDE.md / rules', ['CLAUDE.md']), channel('plugins', ['superpowers@claude-plugins-official']), channel('MCP servers', []), channel('skills', ['mac'])],
      claude_json_projects_before: 14,
      claude_json_projects_after: 14,
    },
    q5: { prompt_bytes: 400, estimated_tokens: 100 },
  };
  const meta = { host: 'host-a', started_at: '2026-09-24T01:10:40.622Z', finished_at: '2026-09-24T01:15:00.000Z', cli_path: '/c', cli_realpath: '/c', cli_version_flag: '2.1.281 (Claude Code)', sdk_version: '0.3.252', node_version: 'v22', git_head: '140121c', account: { name: 'work', config_dir: configDir }, model: 'sonnet', effort: 'medium', cases: ['success', 'control-claudemd', 'schema-unsatisfiable'] };
  const verdicts = [
    { case: 'success', status: 'as_expected', reasons: [] },
    { case: 'control-claudemd', status: 'diverged', reasons: ['no InstructionsLoaded'] },
    { case: 'schema-unsatisfiable', status: 'diverged', reasons: ['the turn succeeded'] },
  ];
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ meta, verdicts, answers }));
}

test('reanalyzeCommand: re-derives verdicts and answers from the recordings, then promote keeps the schema failure', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-reanalyze-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-reanalyze-dest-'));
  try {
    writeRecordedRun(run);
    assert.equal(reanalyzeCommand({ command: 'reanalyze', run, expectEmail: 'owner.work@mail.test', baseline: null }), 0);
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8')) as {
      meta: { started_at: string; git_head: string; reanalyzed?: { at: string } };
      verdicts: Array<{ case: string; status: string }>;
      answers: { q4: { channels: Array<{ channel: string; verdict: string; not_from_account: string[] }>; claude_json_projects_after: number }; q5: { prompt_bytes: number } };
    };
    assert.deepEqual(report.verdicts.map((v) => `${v.case}:${v.status}`), ['success:as_expected', 'control-claudemd:as_expected', 'schema-unsatisfiable:as_expected']);
    assert.equal(report.meta.started_at, '2026-09-24T01:10:40.622Z');
    assert.equal(report.meta.git_head, '140121c');
    assert.equal(typeof report.meta.reanalyzed?.at, 'string');
    const plugins = report.answers.q4.channels.find((c) => c.channel === 'plugins');
    assert.equal(plugins?.verdict, 'closed');
    assert.deepEqual(plugins?.not_from_account, ['agents-md@builtin']);
    assert.equal(report.answers.q4.channels.find((c) => c.channel === 'CLAUDE.md / rules')?.verdict, 'closed');
    assert.equal(report.answers.q4.claude_json_projects_after, 14);
    assert.equal(report.answers.q5.prompt_bytes, 400);
    const appendix = readFileSync(join(run, 'appendix.md'), 'utf8');
    assert.ok(appendix.includes('| schema-unsatisfiable | as_expected | - |'));
    assert.ok(appendix.includes('| reanalyzed |'));

    assert.equal(promoteCommand({ command: 'promote', run, dest }), 0);
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
    assert.equal(manifest.files['schema-unsatisfiable_result'], 'schema-unsatisfiable.result.json');
    assert.equal(manifest.files['schema-unsatisfiable_messages'], 'schema-unsatisfiable.messages.json');
    // The documented host-b check: a host that behaves exactly like the baseline exits 0.
    assert.equal(reanalyzeCommand({ command: 'reanalyze', run, expectEmail: null, baseline: join(dest, 'manifest.json') }), 0);
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('reanalyze: a report without the Q4 inventory is refused (exit 2), not guessed', async () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-reanalyze-run-'));
  try {
    writeRecordedRun(run);
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8')) as { answers: { q4: { channels: unknown[] } } };
    report.answers.q4.channels = report.answers.q4.channels.slice(1);
    writeFileSync(join(run, 'report.json'), JSON.stringify(report));
    assert.equal(await main(['reanalyze', '--run', run]), 2);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
