import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import type { ClaudeAccount } from '../src/account.js';
import { buildCase } from '../probes/m1/cases.js';
import { runCase, type ProbeQueryFn, type RunContext } from '../probes/m1/runner.js';

const STRUCTURED = { scores: [{ id: 'c001', score: 70 }], picks: [], events: [], weekly: [] };

/** The message sequence M1 expects from a zero-tool structured-output turn (spec §6.3 Q3). */
const SCRIPT = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['StructuredOutput'], permissionMode: 'bypassPermissions', claude_code_version: '2.1.280', model: 'claude-sonnet-5', mcp_servers: [], plugins: [], skills: [], cwd: '/tmp/x', apiKeySource: 'none', slash_commands: [], output_style: 'default', uuid: 'u1' },
  { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, uuid: 'u2', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'StructuredOutput', input: STRUCTURED }] } },
  { type: 'user', session_id: 'sess-1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: STRUCTURED, session_id: 'sess-1', terminal_reason: 'completed', stop_reason: 'tool_use', usage: { input_tokens: 2, cache_creation_input_tokens: 11000, cache_read_input_tokens: 0, output_tokens: 900 }, modelUsage: {}, total_cost_usd: 0.05 },
] as unknown as SDKMessage[];

function tempAccount(): { account: ClaudeAccount; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'm1-runner-test-'));
  return {
    account: { name: 'work', configDir: join(root, 'cfg'), anthropicConfigDir: join(root, 'anthropic') },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeUnderlying(script: SDKMessage[]): { underlying: ProbeQueryFn; seen: { options?: Options; calls: number } } {
  const seen: { options?: Options; calls: number } = { calls: 0 };
  const underlying: ProbeQueryFn = (params) => {
    seen.calls += 1;
    seen.options = params.options;
    const fake = makeFakeQuery();
    for (const message of script) {
      fake.controller.emit(message);
    }
    return Object.assign(fake.query, { accountInfo: async () => ({ email: 'probe@example.invalid', subscriptionType: 'pro' }) });
  };
  return { underlying, seen };
}

function ctx(account: ClaudeAccount, underlying: ProbeQueryFn): RunContext {
  return { pinnedAccount: account, cliPath: '/opt/claude', model: 'sonnet', effort: 'medium', carrierHint: 'StructuredOutput', underlying, pollMs: 1, settleMs: 5, accountInfoTimeoutMs: 200 };
}

test('runCase: records the raw messages, the kernel events and both accountInfo probes', async () => {
  const { account, cleanup } = tempAccount();
  try {
    const { underlying, seen } = fakeUnderlying(SCRIPT);
    const record = await runCase({ ...buildCase('success'), timeoutMs: 2_000 }, ctx(account, underlying));
    assert.equal(record.runner_error, null);
    assert.deepEqual(record.guard_violations, []);
    assert.deepEqual(record.messages.map((m) => (m.message as { type: string }).type), ['system', 'assistant', 'user', 'result']);
    const completed = record.kernel_events.find((e) => e.type === 'turn_completed');
    assert.equal(completed?.type === 'turn_completed' ? completed.outcome : null, 'completed');
    assert.ok(record.kernel_events.some((e) => e.type === 'session_closed'));
    assert.equal(record.account_info_before_turn?.ok, true);
    assert.equal(record.account_info_after_turn?.ok, true);
    assert.equal(record.timed_out, false);
    // The P2-shaped fields reached the SDK options; the kernel's own choices were left alone.
    assert.equal(typeof seen.options?.systemPrompt, 'string');
    assert.equal(seen.options?.outputFormat?.type, 'json_schema');
    assert.deepEqual(seen.options?.tools, []);
    assert.equal(seen.options?.permissionMode, 'bypassPermissions');
    assert.equal(seen.options?.env?.CLAUDE_CONFIG_DIR, account.configDir);
    assert.deepEqual(record.options_summary?.hook_events, ['InstructionsLoaded']);
    assert.equal(existsSync(record.cwd), false, 'the per-case cwd is removed');
  } finally {
    cleanup();
  }
});

test('runCase: the guard refuses to spawn when an auth re-routing variable would reach the child', async () => {
  const { account, cleanup } = tempAccount();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
  try {
    const { underlying, seen } = fakeUnderlying(SCRIPT);
    const record = await runCase({ ...buildCase('success'), timeoutMs: 2_000 }, ctx(account, underlying));
    assert.equal(seen.calls, 0, 'nothing was spawned');
    assert.deepEqual(record.guard_violations, ['options.env.ANTHROPIC_API_KEY is set']);
    assert.match(record.runner_error ?? '', /probe guard refused to spawn/);
    assert.deepEqual(record.messages, []);
  } finally {
    if (saved === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = saved;
    }
    cleanup();
  }
});

test('runCase: a provider that never finishes, and an accountInfo() that never answers, are both bounded', async () => {
  const { account, cleanup } = tempAccount();
  try {
    const underlying: ProbeQueryFn = () => {
      const fake = makeFakeQuery();
      fake.controller.emit(SCRIPT[0] as SDKMessage);
      return Object.assign(fake.query, { accountInfo: () => new Promise<never>(() => undefined) });
    };
    const record = await runCase({ ...buildCase('success'), timeoutMs: 50 }, ctx(account, underlying));
    assert.equal(record.timed_out, true);
    assert.equal(record.account_info_before_turn?.ok, false);
    assert.match(record.account_info_before_turn?.ok === false ? record.account_info_before_turn.error : '', /did not answer within 200ms/);
    assert.ok(record.kernel_events.some((e) => e.type === 'session_closed'));
    assert.equal(record.runner_error, null);
  } finally {
    cleanup();
  }
});

test('runCase: the interactive case answers every permission request by id, carrier only', async () => {
  const { account, cleanup } = tempAccount();
  try {
    const fake = makeFakeQuery();
    const seen: { options?: Options } = {};
    const underlying: ProbeQueryFn = (params) => {
      seen.options = params.options;
      return Object.assign(fake.query, { accountInfo: async () => ({ email: 'probe@example.invalid' }) });
    };
    const running = runCase({ ...buildCase('interactive'), timeoutMs: 2_000 }, ctx(account, underlying));
    while (seen.options === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const hook = seen.options.hooks?.PreToolUse?.[0]?.hooks[0];
    assert.ok(hook, 'interactive installs the PreToolUse gate');
    const call = (tool: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: `tu-${tool}`, session_id: 's', transcript_path: '', cwd: '' } as unknown as HookInput, `tu-${tool}`, { signal: new AbortController().signal });
    const [carrier, other] = await Promise.all([call('StructuredOutput'), call('ToolSearch')]);
    assert.equal((carrier as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'allow');
    assert.equal((other as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
    for (const message of SCRIPT) {
      fake.controller.emit(message);
    }
    const record = await running;
    assert.deepEqual(
      record.permission_requests.map((p) => [p.tool_name, p.decision]),
      [['StructuredOutput', 'allow'], ['ToolSearch', 'deny']],
    );
  } finally {
    cleanup();
  }
});

test('runCase: overrides applied after the guard; the throwaway account never touches the pinned one', async () => {
  const { account, cleanup } = tempAccount();
  try {
    const dontAsk = fakeUnderlying(SCRIPT);
    const recordA = await runCase({ ...buildCase('dontask'), timeoutMs: 2_000 }, ctx(account, dontAsk.underlying));
    assert.deepEqual(recordA.guard_violations, []);
    assert.equal(dontAsk.seen.options?.permissionMode, 'dontAsk');

    const auth = fakeUnderlying(SCRIPT);
    const recordB = await runCase({ ...buildCase('auth-invalid'), timeoutMs: 2_000 }, ctx(account, auth.underlying));
    assert.deepEqual(recordB.guard_violations, []);
    assert.equal(auth.seen.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-m1-probe-deliberately-invalid');
    assert.notEqual(auth.seen.options?.env?.CLAUDE_CONFIG_DIR, account.configDir);
    assert.deepEqual(recordB.options_summary?.env_extra_keys, ['CLAUDE_CODE_OAUTH_TOKEN']);
    assert.equal(existsSync(recordB.account.configDir), false, 'the throwaway config dir is deleted');
  } finally {
    cleanup();
  }
});
