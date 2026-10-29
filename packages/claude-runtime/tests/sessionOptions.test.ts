import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { buildSessionOptions, createSession, policyToBaseOptions, SESSION_STATE_EVENTS_ENV, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeSessionConfig } from '../src/types.js';

/** The completion lane's policy (consumer spec §6.3 P3): ISOLATED, BYPASS, an explicit empty allow list. */
const COMPLETION: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};

test('buildSessionOptions: a system prompt reaches Options.systemPrompt as a plain string, i.e. a full replacement', () => {
  const options = buildSessionOptions({ cwd: '/tmp/p', policy: COMPLETION, systemPrompt: 'You are the editor.' });
  assert.equal(options.systemPrompt, 'You are the editor.');
});

test('buildSessionOptions: no system prompt leaves Options.systemPrompt unset, so the SDK uses its minimal prompt', () => {
  const options = buildSessionOptions({ cwd: '/tmp/p', policy: COMPLETION });
  assert.equal('systemPrompt' in options, false);
});

test('createSession hands the SDK exactly what buildSessionOptions builds, plus hooks and nothing else', () => {
  const config: ClaudeSessionConfig = {
    cwd: '/tmp/p',
    policy: { ...COMPLETION, permissions: 'interactive' },
    systemPrompt: 'x',
    model: 'sonnet',
    effort: 'medium',
    resume: { providerSessionId: 'sess-1' },
    fork: true,
    outputFormat: { type: 'json_schema', schema: { type: 'object' } },
  };
  let seen: Options | undefined;
  const { query } = makeFakeQuery();
  const queryFn: QueryFn = (params) => {
    seen = params.options;
    return query;
  };
  const session = createSession(config, queryFn);
  const { hooks, ...rest } = seen ?? {};
  assert.ok(hooks?.PreToolUse, 'an interactive session installs its PreToolUse gate');
  assert.deepEqual(rest, buildSessionOptions(config));
  session.close();
});

test('buildSessionOptions: an output format reaches Options.outputFormat in the SDK shape; absent leaves it unset', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const options = buildSessionOptions({ cwd: '/tmp/p', policy: COMPLETION, outputFormat: { type: 'json_schema', schema } });
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema });
  assert.equal('outputFormat' in buildSessionOptions({ cwd: '/tmp/p', policy: COMPLETION }), false);
});

test('preset options preserve presence', () => {
  const base: ClaudeSessionConfig = { cwd: '/tmp/p', policy: COMPLETION };
  assert.deepEqual(buildSessionOptions({ ...base, systemPromptPreset: { append: 'panel note' } }).systemPrompt,
    { type: 'preset', preset: 'claude_code', append: 'panel note' });
  assert.deepEqual(buildSessionOptions({ ...base, systemPromptPreset: {} }).systemPrompt,
    { type: 'preset', preset: 'claude_code' });
  assert.equal('systemPrompt' in buildSessionOptions(base), false);
  assert.equal(buildSessionOptions({ ...base, systemPrompt: 'replacement' }).systemPrompt, 'replacement');
  for (const systemPrompt of ['', 'replacement']) {
    assert.throws(() => buildSessionOptions({ ...base, systemPrompt, systemPromptPreset: {} }));
  }
  assert.deepEqual(buildSessionOptions({ ...base, systemPromptPreset: { append: ' panel note ' } }).systemPrompt,
    { type: 'preset', preset: 'claude_code', append: ' panel note ' });
});

test('every session shape asks the CLI for its session state frames, on top of the environment it would otherwise get', () => {
  const account = { name: 'work', configDir: '/home/u/.claude-work', anthropicConfigDir: '/home/u/.config/anthropic-work' };
  const atDefault = { name: 'default', configDir: '/home/u/.claude', anthropicConfigDir: '', defaultLocation: true as const };
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/u', [SESSION_STATE_EVENTS_ENV]: '0' };
  for (const configuration of ['native', 'isolated'] as const) {
    for (const permissions of ['interactive', 'verdandi_rules', 'bypass'] as const) {
      for (const pinned of [undefined, account, atDefault]) {
        const policy: ClaudeHostPolicy = { configuration, permissions, persistence: 'host_cli', executable: 'host_cli' };
        const label = `${configuration} ${permissions} ${pinned?.name ?? 'unpinned'}`;
        const options = policyToBaseOptions(policy, '/tmp/p', { baseEnv, ...(pinned === undefined ? {} : { account: pinned }) });
        assert.equal(options.env?.[SESSION_STATE_EVENTS_ENV], '1', `${label}: a value already in the environment is overwritten`);
        assert.equal(options.env?.PATH, '/usr/bin', `${label}: an overlay, never a replacement`);
        assert.equal(baseEnv[SESSION_STATE_EVENTS_ENV], '0', `${label}: the caller's environment is left as it was`);
      }
    }
  }
  // Through the full mapping, with no base environment given: the process environment plus the variable.
  const built = buildSessionOptions({ cwd: '/tmp/p', policy: { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' } });
  assert.deepEqual(built.env, { ...process.env, [SESSION_STATE_EVENTS_ENV]: '1' });
});

test('Bash timeout values pass through the process environment with or without an account, and through baseEnv', t => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['BASH_MAX_TIMEOUT_MS', 'BASH_DEFAULT_TIMEOUT_MS', SESSION_STATE_EVENTS_ENV,
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'VERDANDI_CLAUDE_ACCOUNT']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.BASH_MAX_TIMEOUT_MS = '2147483647';
  process.env.BASH_DEFAULT_TIMEOUT_MS = '234567';
  process.env[SESSION_STATE_EVENTS_ENV] = '0';
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0';
  const account = { name: 'work', configDir: '/tmp/claude-work', anthropicConfigDir: '/tmp/anthropic-work' };
  for (const pinned of [undefined, account]) {
    if (pinned) process.env.VERDANDI_CLAUDE_ACCOUNT = pinned.name;
    else delete process.env.VERDANDI_CLAUDE_ACCOUNT;
    for (const baseEnv of [undefined, {
      BASH_MAX_TIMEOUT_MS: '7654321', BASH_DEFAULT_TIMEOUT_MS: '345678',
      [SESSION_STATE_EVENTS_ENV]: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    }]) {
      const source = baseEnv ?? process.env;
      const before = { ...source };
      const options = policyToBaseOptions(COMPLETION, '/tmp/p', {
        ...(pinned === undefined ? {} : { account: pinned }), ...(baseEnv === undefined ? {} : { baseEnv }),
      });
      assert.equal(options.env?.BASH_MAX_TIMEOUT_MS, source.BASH_MAX_TIMEOUT_MS);
      assert.equal(options.env?.BASH_DEFAULT_TIMEOUT_MS, source.BASH_DEFAULT_TIMEOUT_MS);
      assert.equal(options.env?.[SESSION_STATE_EVENTS_ENV], '1');
      assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
      assert.deepEqual({ ...source }, before);
    }
  }
});
