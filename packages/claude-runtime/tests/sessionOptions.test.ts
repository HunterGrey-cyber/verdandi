import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { buildSessionOptions, createSession, type QueryFn } from '../src/session.js';
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

test('buildSessionOptions: no system prompt leaves Options.systemPrompt unset, so Claude Code keeps its own', () => {
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
