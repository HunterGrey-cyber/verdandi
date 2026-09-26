import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerQuestions, type M1Answers } from '../probes/m1/analyze.js';
import { buildManifest, compareToBaseline, renderAppendix, type ProbeMeta } from '../probes/m1/report.js';
import { parseCli, promoteWebCommand } from '../probes/m1/main.js';
import { LAN, WEB_INIT, WEB_OK, WEB_RESULT, lanMessages, record } from './m1WebFixtures.js';

const META: ProbeMeta = {
  host: 'host-a', started_at: '2026-09-25T20:00:00.000Z', finished_at: '', cli_path: '/c', cli_realpath: '/c', cli_version_flag: '2.1.282 (Claude Code)',
  sdk_version: '0.3.252', node_version: 'v22', git_head: null, account: { name: 'work', config_dir: '/home/probe/.claude-work' }, model: 'sonnet', effort: 'medium', cases: ['web-tools'],
};
const INVENTORY = { settings_hook_events: [], enabled_plugins: [], user_mcp_servers: [], skill_dirs: [], claude_md_present: false, claude_json_projects: null };

function webAnswers(initTools: string[], withLan = false): M1Answers {
  return answerQuestions({
    records: {
      'web-tools': record('web-tools', [{ ...WEB_INIT, tools: initTools }, ...WEB_OK.slice(1)]),
      ...(withLan ? { 'web-lan': record('web-lan', lanMessages(['rule', 'error', 'rule'])) } : {}),
    },
    verdicts: {}, inventoryBefore: INVENTORY, inventoryAfter: INVENTORY, pinnedConfigDir: '/home/probe/.claude-work', cliVersionFlag: '2.1.282 (Claude Code)',
    promptBytes: 0, estimatedTokens: 0, lanUrls: withLan ? LAN : [],
  });
}

test('answerQuestions: a web run reports its init tools, Haiku models, public fetch and LAN outcomes', () => {
  const answers = webAnswers(['StructuredOutput', 'WebFetch', 'WebSearch'], true);
  assert.deepEqual(answers.web, {
    init_tools: ['StructuredOutput', 'WebFetch', 'WebSearch'], haiku_models: ['claude-haiku-4-5-20251001'], fetched_public: true,
    lan: [{ url: LAN[0], blocked_by: 'rule' }, { url: LAN[1], blocked_by: 'error' }, { url: LAN[2], blocked_by: 'rule' }],
  });
  const appendix = renderAppendix(META, answers, []);
  assert.match(appendix, /\*\*Web tools \(muninn client spec §9\.1\)\*\*/);
  assert.match(appendix, /LAN https:\/\/10\.0\.0\.10:18190\/healthz: error/);
});

test('answerQuestions: a run without web cases has no web answers at all', () => {
  const answers = answerQuestions({ records: {}, verdicts: {}, inventoryBefore: INVENTORY, inventoryAfter: INVENTORY, pinnedConfigDir: '/p', cliVersionFlag: '2.1.282', promptBytes: 0, estimatedTokens: 0 });
  assert.equal('web' in answers, false);
});

test('compareToBaseline: a web-only run compares the web fingerprint and nothing about the zero-tool cases', () => {
  const answers = webAnswers(['StructuredOutput', 'WebFetch', 'WebSearch']);
  const ok = [{ case: 'web-tools' as const, status: 'as_expected' as const, reasons: [] }];
  const baseline = { ...buildManifest({ meta: META, answers, files: {}, redactions: [] }), web_init_tools: ['WebSearch', 'WebFetch', 'StructuredOutput'] };
  assert.deepEqual(compareToBaseline(answers, ok, baseline), { differences: [], notes: [] });
  const drifted = webAnswers(['StructuredOutput', 'WebFetch', 'WebSearch', 'Bash']);
  assert.deepEqual(compareToBaseline(drifted, ok, baseline).differences, ['web init.tools ["Bash","StructuredOutput","WebFetch","WebSearch"] != baseline ["StructuredOutput","WebFetch","WebSearch"]']);
  const { web_init_tools: _omitted, ...noWebBaseline } = baseline;
  assert.match(compareToBaseline(answers, ok, noWebBaseline).differences.join('\n'), /no web-tools recording/);
  assert.match(compareToBaseline(answers, [], baseline).differences.join('\n'), /nothing to compare/);
  const lanDiverged = [...ok, { case: 'web-lan' as const, status: 'diverged' as const, reasons: ['x'] }];
  assert.deepEqual(compareToBaseline(answers, lanDiverged, baseline).differences, ['web-lan case is diverged']);
});

test('parseCli: --lan-urls must be https URLs, and web-lan cannot run without them', () => {
  const cli = parseCli(['run', '--cases', 'web-tools,web-lan', '--lan-urls', LAN.join(',')]);
  assert.equal(cli.command, 'run');
  assert.deepEqual(cli.command === 'run' ? [cli.cases, cli.lanUrls] : [], [['web-tools', 'web-lan'], LAN]);
  assert.throws(() => parseCli(['run', '--cases', 'web-lan']), /web-lan case needs --lan-urls/);
  assert.throws(() => parseCli(['run', '--cases', 'web-lan', '--lan-urls', 'http://10.0.0.10/']), /must be https/);
  assert.throws(() => parseCli(['run', '--cases', 'web-lan', '--lan-urls', 'not a url']), /is not a URL/);
  assert.deepEqual(parseCli(['promote-web', '--run', '/r', '--dest', '/d']), { command: 'promote-web', run: '/r', dest: '/d' });
  assert.throws(() => parseCli(['promote-web', '--run', '/r']), /promote-web needs --run and --dest/);
});

test('promoteWebCommand: adds the web recording to an existing fixture set, redacted, touching nothing else', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-web-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-promote-web-dest-'));
  try {
    const email = 'owner.work@mail.test';
    const rec = record('web-tools', WEB_OK.map((m) => (m === WEB_RESULT ? { ...WEB_RESULT, note: `mail ${email}` } : m)), {
      cwd: join(tmpdir(), 'm1-probe-web-tools-zz'),
      account_info_before_turn: { ok: true, ms: 1, info: { email, organization: `${email}'s Organization` } },
    });
    mkdirSync(join(run, 'cases'));
    writeFileSync(join(run, 'cases', 'web-tools.json'), JSON.stringify(rec));
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: META, verdicts: [{ case: 'web-tools', status: 'as_expected', reasons: [] }], answers: webAnswers(['StructuredOutput', 'WebFetch', 'WebSearch']) }));
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ schema: 'verdandi.m1-fixtures/v1', init_tools: ['StructuredOutput'], files: { success_result: 'success.result.json' }, redactions: ['account email'] }));
    writeFileSync(join(dest, 'success.result.json'), '{"untouched":true}\n');

    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 0);
    assert.deepEqual(readdirSync(dest).sort(), ['manifest.json', 'success-web.init.json', 'success-web.result.json', 'success.result.json']);
    assert.equal(readFileSync(join(dest, 'success.result.json'), 'utf8'), '{"untouched":true}\n');
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(manifest.init_tools, ['StructuredOutput'], 'the zero-tool fingerprint is untouched');
    assert.deepEqual(manifest.web_init_tools, ['StructuredOutput', 'WebFetch', 'WebSearch']);
    assert.deepEqual(manifest.web_haiku_models, ['claude-haiku-4-5-20251001']);
    assert.deepEqual(manifest.files, { success_result: 'success.result.json', success_web_init: 'success-web.init.json', success_web_result: 'success-web.result.json' });
    const all = readdirSync(dest).map((f) => readFileSync(join(dest, f), 'utf8')).join('\n');
    assert.equal(all.includes(email), false);
    assert.equal(all.includes(homedir()), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('promoteWebCommand: refuses a diverged web-tools case, and a destination without a manifest, writing nothing', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-web-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-promote-web-dest-'));
  try {
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: META, verdicts: [{ case: 'web-tools', status: 'diverged', reasons: ['x'] }], answers: {} }));
    writeFileSync(join(dest, 'manifest.json'), '{}');
    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 1);
    assert.deepEqual(readdirSync(dest), ['manifest.json']);
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: META, verdicts: [{ case: 'web-tools', status: 'as_expected', reasons: [] }], answers: {} }));
    rmSync(join(dest, 'manifest.json'));
    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 1);
    assert.deepEqual(readdirSync(dest), []);
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('promoteWebCommand: a web-lan run adds its messages and outcomes beside the web-tools recording, redacted', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-web-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-promote-web-dest-'));
  try {
    const email = 'owner.work@mail.test';
    const messages = lanMessages(['rule', 'rule', 'rule']).map((m, i) => (i === 0 ? { ...(m as object), note: `mail ${email}` } : m));
    const rec = record('web-lan', messages, { cwd: join(tmpdir(), 'm1-probe-web-lan-zz'), account_info_before_turn: { ok: true, ms: 1, info: { email } } });
    const outcomes = LAN.map((url) => ({ url, blocked_by: 'rule' }));
    mkdirSync(join(run, 'cases'));
    writeFileSync(join(run, 'cases', 'web-lan.json'), JSON.stringify(rec));
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: { ...META, cases: ['web-lan'], lan_urls: LAN }, verdicts: [{ case: 'web-lan', status: 'as_expected', reasons: [] }], answers: { web: { init_tools: null, haiku_models: [], fetched_public: false, lan: outcomes } } }));
    const before = { schema: 'verdandi.m1-fixtures/v1', init_tools: ['StructuredOutput'], files: { success_web_init: 'success-web.init.json' }, redactions: ['account email'], web_init_tools: ['StructuredOutput', 'WebFetch', 'WebSearch'] };
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify(before));
    writeFileSync(join(dest, 'success-web.init.json'), '{"untouched":true}\n');

    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 0);
    assert.deepEqual(readdirSync(dest).sort(), ['manifest.json', 'success-web-lan.messages.json', 'success-web.init.json']);
    assert.equal(readFileSync(join(dest, 'success-web.init.json'), 'utf8'), '{"untouched":true}\n');
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(manifest.files, { success_web_init: 'success-web.init.json', success_web_lan_messages: 'success-web-lan.messages.json' });
    assert.deepEqual(manifest.web_init_tools, before.web_init_tools, 'the web-tools fingerprint is untouched');
    assert.deepEqual(manifest.web_lan_outcomes, outcomes);
    const promoted = JSON.parse(readFileSync(join(dest, 'success-web-lan.messages.json'), 'utf8')) as unknown[];
    assert.equal(promoted.length, messages.length);
    const all = readdirSync(dest).map((f) => readFileSync(join(dest, f), 'utf8')).join('\n');
    assert.equal(all.includes(email), false);
    assert.equal(all.includes(homedir()), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('promoteWebCommand: refuses a run whose web-lan diverged even when web-tools is as expected, and a run with neither', () => {
  const run = mkdtempSync(join(tmpdir(), 'm1-promote-web-run-'));
  const dest = mkdtempSync(join(tmpdir(), 'm1-promote-web-dest-'));
  try {
    writeFileSync(join(dest, 'manifest.json'), '{}');
    const verdicts = [{ case: 'web-tools', status: 'as_expected', reasons: [] }, { case: 'web-lan', status: 'diverged', reasons: ['x'] }];
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: META, verdicts, answers: {} }));
    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 1);
    writeFileSync(join(run, 'report.json'), JSON.stringify({ meta: META, verdicts: [{ case: 'success', status: 'as_expected', reasons: [] }], answers: {} }));
    assert.equal(promoteWebCommand({ command: 'promote-web', run, dest }), 1);
    assert.deepEqual(readdirSync(dest), ['manifest.json']);
    assert.equal(readFileSync(join(dest, 'manifest.json'), 'utf8'), '{}');
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
