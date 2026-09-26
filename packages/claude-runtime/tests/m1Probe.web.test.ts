import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyToBaseOptions } from '../src/session.js';
import { WEBFETCH_PRIVATE_DENY } from '../src/webFetchDeny.js';
import { ALL_CASES, DEFAULT_CASES, WEB_CASES, WEB_POLICY, buildCase } from '../probes/m1/cases.js';
import { checkChildOptions } from '../probes/m1/guard.js';
import { analyzeCase } from '../probes/m1/analyze.js';
import { coveringDenyRule, haikuModels, lanOutcomes, webFetchAttempts } from '../probes/m1/web.js';
import { FETCH, LAN, TOOL_RESULT, WEB_INIT, WEB_OK, WEB_RESULT, lanMessages, record } from './m1WebFixtures.js';
import { m1Manifest, readM1Fixture } from './m1FixtureFiles.js';

test('web cases: never default, both carry the web policy, only web-lan carries URLs', () => {
  for (const name of WEB_CASES) {
    assert.ok(ALL_CASES.includes(name));
    assert.equal(DEFAULT_CASES.includes(name), false);
  }
  const tools = buildCase('web-tools');
  assert.deepEqual(tools.policy, WEB_POLICY);
  assert.deepEqual(tools.policy.toolPolicy, { allow: ['WebFetch', 'WebSearch'] });
  assert.deepEqual(tools.lanUrls, []);
  const lan = buildCase('web-lan', { lanUrls: LAN });
  assert.deepEqual(lan.policy, WEB_POLICY);
  assert.deepEqual(lan.lanUrls, LAN);
  for (const url of LAN) {
    assert.ok(lan.userMessage.includes(url), url);
  }
});

test('checkChildOptions: the kernel options for the web policy pass the web expectation, and only that one', () => {
  const account = { name: 'work', configDir: '/home/probe/.claude-work', anthropicConfigDir: '/home/probe/.config/anthropic-work' };
  const options = policyToBaseOptions(WEB_POLICY, '/tmp/run', { account, baseEnv: { PATH: '/usr/bin' }, hostCliPath: '/opt/claude' });
  const base = { account, cliPath: '/opt/claude', permissionMode: 'bypassPermissions' as const, settingSources: [] };
  assert.deepEqual(checkChildOptions(options, { ...base, tools: ['WebFetch', 'WebSearch'], disallowedTools: WEBFETCH_PRIVATE_DENY }), []);
  const asZeroTool = checkChildOptions(options, base);
  assert.ok(asZeroTool.some((p) => p.startsWith('options.tools is ["WebFetch","WebSearch"], expected []')));
  assert.ok(asZeroTool.some((p) => p.startsWith('options.disallowedTools is')));
});

test('webFetchAttempts: pairs each WebFetch with its tool_result and the result denials', () => {
  const attempts = webFetchAttempts(lanMessages(['rule', 'error', 'content']), null);
  assert.deepEqual(attempts.map((a) => [a.url, a.result]), [[LAN[0], 'error'], [LAN[1], 'error'], [LAN[2], 'content']]);
  const withDenials = lanMessages(['rule', 'error', 'content']);
  const result = withDenials.at(-1) as Record<string, unknown>;
  assert.deepEqual(webFetchAttempts(withDenials, result).map((a) => a.deniedByRule), [true, false, false]);
});

test('haikuModels: only Haiku entries that used tokens', () => {
  assert.deepEqual(haikuModels(WEB_RESULT), ['claude-haiku-4-5-20251001']);
  assert.deepEqual(haikuModels({ modelUsage: { 'claude-haiku-4-5': { inputTokens: 0, outputTokens: 0 } } }), []);
  assert.deepEqual(haikuModels(null), []);
});

test('web-tools: a clean tool-bearing turn is as expected', () => {
  const v = analyzeCase(buildCase('web-tools'), record('web-tools', WEB_OK), { expectEmail: 'work@example.invalid' });
  assert.deepEqual(v, { case: 'web-tools', status: 'as_expected', reasons: [] });
});

test('web-tools: missing WebSearch, no Haiku, no public content and missing deny rules each diverge', () => {
  const noSearch = [{ ...WEB_INIT, tools: ['StructuredOutput', 'WebFetch'] }, ...WEB_OK.slice(1)];
  assert.match(analyzeCase(buildCase('web-tools'), record('web-tools', noSearch), { expectEmail: null }).reasons.join('\n'), /init\.tools is \["StructuredOutput","WebFetch"\]/);
  const noHaiku = [...WEB_OK.slice(0, 3), { ...WEB_RESULT, modelUsage: { 'claude-sonnet-5': WEB_RESULT.modelUsage['claude-sonnet-5'] } }];
  assert.match(analyzeCase(buildCase('web-tools'), record('web-tools', noHaiku), { expectEmail: null }).reasons.join('\n'), /no Haiku model/);
  const refused = [WEB_INIT, FETCH('f1', 'https://example.com/'), TOOL_RESULT('f1', true), WEB_RESULT];
  assert.match(analyzeCase(buildCase('web-tools'), record('web-tools', refused), { expectEmail: null }).reasons.join('\n'), /no WebFetch call returned content/);
  const noRules = analyzeCase(buildCase('web-tools'), record('web-tools', WEB_OK, { options_summary: { disallowedTools: null } }), { expectEmail: null });
  assert.match(noRules.reasons.join('\n'), /did not apply the WebFetch deny rules/);
  const wrongAccount = analyzeCase(buildCase('web-tools'), record('web-tools', WEB_OK), { expectEmail: 'someone@example.invalid' });
  assert.match(wrongAccount.reasons.join('\n'), /accountInfo\(\)\.email is work@example\.invalid, expected someone@example\.invalid/);
});

test('coveringDenyRule: which WEBFETCH_PRIVATE_DENY rule covers a URL, by the documented matching', () => {
  assert.equal(coveringDenyRule('https://127.0.0.1:18190/healthz'), 'WebFetch(domain:127.*.*.*)');
  assert.equal(coveringDenyRule('https://10.0.0.1/'), 'WebFetch(domain:10.*.*.*)');
  assert.equal(coveringDenyRule('https://10-0-0-10.nip.io:18190/healthz'), 'WebFetch(domain:*.nip.io)');
  assert.equal(coveringDenyRule('https://git.owner.example/users/sign_in'), 'WebFetch(domain:*.owner.example)');
  assert.equal(coveringDenyRule('https://GIT.Owner.EXAMPLE/'), 'WebFetch(domain:*.owner.example)');
  assert.equal(coveringDenyRule('https://a.b.owner.example/'), 'WebFetch(domain:*.owner.example)');
  assert.equal(coveringDenyRule('https://owner.example/'), 'WebFetch(domain:owner.example)');
  assert.equal(coveringDenyRule('https://localhost:8080/'), 'WebFetch(domain:localhost)');
  assert.equal(coveringDenyRule('https://nas.lan/'), 'WebFetch(domain:*.lan)');
  // Not covered: a look-alike suffix, a public name, an IPv6 literal (the network's job), garbage.
  assert.equal(coveringDenyRule('https://evilowner.example/'), null);
  assert.equal(coveringDenyRule('https://owner.example.example.com/'), null);
  assert.equal(coveringDenyRule('https://example.com/'), null);
  assert.equal(coveringDenyRule('https://nip.io/'), null);
  assert.equal(coveringDenyRule('https://[fd0b:f0db:b427::1]/'), null);
  assert.equal(coveringDenyRule('not a url'), null);
});

test('web-lan: every rule-covered URL refused by its rule is as expected; one with content is not', () => {
  const def = buildCase('web-lan', { lanUrls: LAN });
  assert.equal(analyzeCase(def, record('web-lan', lanMessages(['rule', 'rule', 'rule'])), { expectEmail: null }).status, 'as_expected');
  const leaked = analyzeCase(def, record('web-lan', lanMessages(['rule', 'content', 'rule'])), { expectEmail: null });
  assert.equal(leaked.status, 'diverged');
  assert.match(leaked.reasons.join('\n'), /10\.0\.0\.10:18190\/healthz: WebFetch returned content/);
  const skipped = analyzeCase(def, record('web-lan', lanMessages(['rule', 'rule', 'none'])), { expectEmail: null });
  assert.match(skipped.reasons.join('\n'), /nip\.io:18190\/healthz: never fetched/);
  assert.match(analyzeCase(buildCase('web-lan'), record('web-lan', lanMessages(['rule', 'rule', 'rule'])), { expectEmail: null }).reasons.join('\n'), /no LAN URLs were given/);
});

// Final review I1: a rule-covered URL is refused by the rule before any packet goes out, so an
// `error` there means the rule did not fire and the fetch failed for some other reason (TLS against
// plain HTTP fails with no protection at all). That must be red, or the deny-rule layer is never shown.
test('web-lan: a rule-covered URL that fails with a plain error diverges; an uncovered one may', () => {
  const def = buildCase('web-lan', { lanUrls: LAN });
  const inert = analyzeCase(def, record('web-lan', lanMessages(['rule', 'error', 'rule'])), { expectEmail: null });
  assert.equal(inert.status, 'diverged');
  assert.deepEqual(inert.reasons.map((r) => r.split(' -- ')[0]), ['https://10.0.0.10:18190/healthz: failed with an error, not refused by WebFetch(domain:10.*.*.*)']);
  const allInert = analyzeCase(def, record('web-lan', lanMessages(['error', 'error', 'error'])), { expectEmail: null });
  assert.equal(allInert.reasons.filter((r) => r.includes('did not fire')).length, 3);

  const ula = 'https://[fd0b:f0db:b427::1]/';
  const mixed = [...LAN, ula];
  const networkOnly = analyzeCase(buildCase('web-lan', { lanUrls: mixed }), record('web-lan', lanMessages(['rule', 'rule', 'rule', 'error'], mixed)), { expectEmail: null });
  assert.deepEqual(networkOnly, { case: 'web-lan', status: 'as_expected', reasons: [] });

  const owner = 'https://git.owner.example/users/sign_in';
  const ownerLeak = analyzeCase(buildCase('web-lan', { lanUrls: [owner] }), record('web-lan', lanMessages(['content'], [owner])), { expectEmail: null });
  assert.match(ownerLeak.reasons.join('\n'), /sign_in: WebFetch returned content -- WebFetch\(domain:\*\.owner\.example\) did not stop it/);

  const uncovered = analyzeCase(buildCase('web-lan', { lanUrls: [ula] }), record('web-lan', lanMessages(['error'], [ula])), { expectEmail: null });
  assert.deepEqual(uncovered.reasons, ['no --lan-urls URL is covered by a WebFetch deny rule, so this run cannot show that the rules fire']);
});

// The web-lan recording promote-web keeps (host-a, work, no network restriction, 2026-09-26): what
// a WebFetch deny rule firing looks like on a real CLI. Every URL is in permission_denials; take the
// denials away -- a CLI whose rules stopped firing, or stopped being reported -- and the same turn is red.
test('the web-lan recording: every URL refused by its rule on a real CLI, and red without the denials', () => {
  const outcomes = m1Manifest().web_lan_outcomes;
  assert.ok(outcomes !== undefined && outcomes.length > 0, 'no web-lan recording in the M1 fixtures: run the web-lan case on host-a and promote-web');
  const urls = outcomes.map((o) => o.url);
  assert.ok(urls.some((url) => new URL(url).hostname.endsWith('.owner.example')), 'the recording has no owner-domain URL');
  assert.deepEqual(outcomes.map((o) => o.blocked_by), urls.map(() => 'rule'));
  for (const url of urls) {
    assert.notEqual(coveringDenyRule(url), null, url);
  }
  const messages = readM1Fixture('success_web_lan_messages') as unknown[];
  const result = messages.find((m) => (m as { type?: unknown }).type === 'result') as Record<string, unknown>;
  assert.deepEqual(lanOutcomes(urls, messages, result), outcomes);
  const def = buildCase('web-lan', { lanUrls: urls });
  assert.deepEqual(analyzeCase(def, record('web-lan', messages), { expectEmail: null }), { case: 'web-lan', status: 'as_expected', reasons: [] });

  const silent = messages.map((m) => (m === result ? { ...result, permission_denials: [] } : m));
  const red = analyzeCase(def, record('web-lan', silent), { expectEmail: null });
  assert.equal(red.status, 'diverged');
  assert.equal(red.reasons.filter((r) => r.includes('did not fire')).length, urls.length);
});

test('lanOutcomes: rule, error, not_blocked, not_attempted', () => {
  const messages = lanMessages(['rule', 'error', 'none']);
  assert.deepEqual(lanOutcomes(LAN, messages, messages.at(-1) as Record<string, unknown>), [
    { url: LAN[0], blocked_by: 'rule' },
    { url: LAN[1], blocked_by: 'error' },
    { url: LAN[2], blocked_by: 'not_attempted' },
  ]);
  const leaked = lanMessages(['content', 'rule', 'rule']);
  assert.equal(lanOutcomes(LAN, leaked, leaked.at(-1) as Record<string, unknown>)[0]?.blocked_by, 'not_blocked');
});
