import { WEBFETCH_PRIVATE_DENY } from '../src/webFetchDeny.js';
import type { CaseName } from '../probes/m1/cases.js';
import type { CaseRecord } from '../probes/m1/runner.js';

/**
 * Synthetic recordings for the two web cases (muninn client spec §9.1), shaped like what the CLI
 * sends: system/init, WebFetch tool_use / tool_result pairs, and a result with modelUsage and
 * permission_denials. Shared by m1Probe.web.test.ts and m1Probe.webReport.test.ts.
 */
export const LAN = ['https://127.0.0.1:18190/healthz', 'https://10.0.0.10:18190/healthz', 'https://10-0-0-10.nip.io:18190/healthz'];
export const INFO = { ok: true as const, ms: 3, info: { email: 'work@example.invalid' } };
export const WEB_INIT = { type: 'system', subtype: 'init', session_id: 's1', tools: ['StructuredOutput', 'WebFetch', 'WebSearch'], permissionMode: 'bypassPermissions', claude_code_version: '2.1.282', model: 'claude-sonnet-5', mcp_servers: [] };
export const FETCH = (id: string, url: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebFetch', input: { url, prompt: 'title?' } }] } });
export const TOOL_RESULT = (id: string, isError: boolean) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'refused' : 'Example Domain', is_error: isError }] } });
export const WEB_RESULT = {
  type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { title: 'Example Domain' }, session_id: 's1', total_cost_usd: 0.02, permission_denials: [] as unknown[],
  modelUsage: {
    'claude-sonnet-5': { inputTokens: 5, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 9000, costUSD: 0.02 },
    'claude-haiku-4-5-20251001': { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
  },
};
export const WEB_OK: unknown[] = [WEB_INIT, FETCH('f1', 'https://example.com/'), TOOL_RESULT('f1', false), WEB_RESULT];

export function record(name: CaseName, messages: unknown[], extra: Partial<CaseRecord> = {}): CaseRecord {
  return {
    case: name, started_at: '2026-09-25T00:00:00.000Z', finished_at: '2026-09-25T00:01:00.000Z', duration_ms: 60_000,
    cwd: '/tmp/m1-probe-web', account: { name: 'work', configDir: '/home/probe/.claude-work' }, options_summary: { disallowedTools: [...WEBFETCH_PRIVATE_DENY] },
    guard_violations: [], messages: messages.map((message, i) => ({ t_ms: i, message })), next_rejection: null,
    kernel_events: [{ type: 'turn_completed', turnId: 't', outcome: 'completed', resultText: '', isError: false, stopReason: null }],
    permission_requests: [], hook_observations: [], account_info_before_turn: INFO, account_info_after_turn: INFO,
    transcript: null, timed_out: false, runner_error: null, ...extra,
  };
}

/** A web-lan turn: per URL (LAN unless `urls` says otherwise), refused by a deny rule, refused
 * with an error, fetched, or never tried. */
export function lanMessages(outcomes: Array<'rule' | 'error' | 'content' | 'none'>, urls: readonly string[] = LAN): unknown[] {
  const messages: unknown[] = [WEB_INIT];
  const denials: unknown[] = [];
  urls.forEach((url, i) => {
    const id = `l${i}`;
    if (outcomes[i] === 'none') {
      return;
    }
    messages.push(FETCH(id, url), TOOL_RESULT(id, outcomes[i] !== 'content'));
    if (outcomes[i] === 'rule') {
      denials.push({ tool_name: 'WebFetch', tool_use_id: id, tool_input: { url } });
    }
  });
  messages.push({ ...WEB_RESULT, structured_output: { results: [] }, permission_denials: denials });
  return messages;
}
