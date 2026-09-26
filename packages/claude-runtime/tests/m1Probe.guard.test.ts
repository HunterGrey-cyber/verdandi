import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyToBaseOptions } from '../src/session.js';
import type { ClaudeAccount } from '../src/account.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import { checkChildOptions, checkParentEnv, isShellWrapper, parseCliVersion } from '../probes/m1/guard.js';

const ACCOUNT: ClaudeAccount = {
  name: 'work',
  configDir: '/home/probe/.claude-work',
  anthropicConfigDir: '/home/probe/.config/anthropic-work',
};

/** Spec §6.3 P3 session parameters: ISOLATED, no settings tiers, explicit empty allow list. */
const COMPLETION: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};

const EXPECT = { account: ACCOUNT, cliPath: '/opt/claude', permissionMode: 'bypassPermissions' as const, settingSources: [] };

test('checkParentEnv: a clean environment with a pinned account passes', () => {
  assert.deepEqual(checkParentEnv({ HOME: '/home/probe', PATH: '/usr/bin', VERDANDI_CLAUDE_ACCOUNT: 'work' }), []);
});

test('checkParentEnv: refuses a missing account and every auth re-routing variable', () => {
  const problems = checkParentEnv({ ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://x' });
  assert.ok(problems.some((p) => p.startsWith('VERDANDI_CLAUDE_ACCOUNT is not set')));
  assert.ok(problems.some((p) => p.startsWith('ANTHROPIC_API_KEY is set')));
  assert.ok(problems.some((p) => p.startsWith('CLAUDE_CODE_OAUTH_TOKEN is set')));
  assert.ok(problems.some((p) => p.startsWith('ANTHROPIC_BASE_URL is set')));
  // Reported once, as an auth problem, not a second time as a nested-session marker.
  assert.equal(problems.filter((p) => p.includes('CLAUDE_CODE_OAUTH_TOKEN')).length, 1);
});

test('checkParentEnv: refuses markers of a parent Claude Code session, ignores empty values', () => {
  const problems = checkParentEnv({ VERDANDI_CLAUDE_ACCOUNT: 'work', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_EFFORT: 'high', ANTHROPIC_API_KEY: '' });
  assert.deepEqual(problems.map((p) => p.split(' ')[0]), ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT']);
});

test('checkChildOptions: the kernel options for the completion policy pass', () => {
  const options = policyToBaseOptions(COMPLETION, '/tmp/run', { account: ACCOUNT, baseEnv: { PATH: '/usr/bin' }, hostCliPath: '/opt/claude' });
  assert.deepEqual(checkChildOptions(options, EXPECT), []);
});

test('checkChildOptions: an absent allow list is caught (tools untouched, bypass floor applied)', () => {
  const policy: ClaudeHostPolicy = { ...COMPLETION, toolPolicy: undefined };
  const options = policyToBaseOptions(policy, '/tmp/run', { account: ACCOUNT, baseEnv: {}, hostCliPath: '/opt/claude' });
  const problems = checkChildOptions(options, EXPECT);
  assert.ok(problems.some((p) => p.startsWith('options.tools is undefined')));
  assert.ok(problems.some((p) => p.startsWith('options.disallowedTools is')));
});

test('checkChildOptions: a missing account overlay and a leaked API key are both caught', () => {
  const options = policyToBaseOptions({ ...COMPLETION, configuration: 'native', settingSources: [] }, '/tmp/run', {
    baseEnv: { ANTHROPIC_API_KEY: 'sk-leak' },
    hostCliPath: '/opt/claude',
  });
  const problems = checkChildOptions(options, EXPECT);
  assert.ok(problems.some((p) => p.startsWith('options.env is unset')));
  assert.ok(problems.some((p) => p.startsWith('options.env.CLAUDE_CONFIG_DIR is undefined')));
  assert.ok(problems.some((p) => p.startsWith('options.strictMcpConfig is not true')));

  const leaked = policyToBaseOptions(COMPLETION, '/tmp/run', { account: ACCOUNT, baseEnv: { ANTHROPIC_API_KEY: 'sk-leak' }, hostCliPath: '/opt/claude' });
  assert.deepEqual(checkChildOptions(leaked, EXPECT), ['options.env.ANTHROPIC_API_KEY is set']);
});

test('parseCliVersion: accepts the CLI banner, rejects anything else', () => {
  assert.equal(parseCliVersion('2.1.280 (Claude Code)\n'), '2.1.280');
  assert.equal(parseCliVersion('claude-launcher: refusing to start outside an approved session'), null);
  assert.equal(parseCliVersion(''), null);
});

test('isShellWrapper: refuses shell launchers, accepts binaries and node scripts', () => {
  assert.equal(isShellWrapper('#!/usr/bin/env bash\nexec claude-launcher "$@"\n'), true);
  assert.equal(isShellWrapper('#!/bin/sh\n'), true);
  assert.equal(isShellWrapper('#!/usr/bin/env node\nimport "./cli.js"\n'), false);
  assert.equal(isShellWrapper('\u007fELF\u0002\u0001\u0001'), false);
});

test('checkChildOptions: an account at the CLI default location expects the tuple absent, not set', () => {
  const atDefault: ClaudeAccount = { name: 'work', configDir: '/home/probe/.claude', anthropicConfigDir: '', defaultLocation: true };
  const expect = { ...EXPECT, account: atDefault };
  const options = policyToBaseOptions(COMPLETION, '/tmp/m1', { account: atDefault, hostCliPath: '/opt/claude', baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/probe/.claude-personal' } });
  assert.deepEqual(checkChildOptions(options, expect), []);
  // A tuple that did reach the child is caught.
  const leaked = { ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/home/probe/.claude' } };
  assert.ok(checkChildOptions(leaked, expect).some((p) => p.startsWith('options.env.CLAUDE_CONFIG_DIR is "/home/probe/.claude", expected unset')));
  // No env at all is refused too: the SDK default would let an inherited CLAUDE_CONFIG_DIR decide.
  const noEnv = { ...options, env: undefined };
  assert.deepEqual(checkChildOptions(noEnv, expect), ['options.env is unset: the account overlay did not happen']);
});
