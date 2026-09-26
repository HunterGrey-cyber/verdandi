import type { CaseDef, CaseName } from './cases.js';
import { parseCliVersion } from './guard.js';
import type { AccountInfoProbe, AccountInventory, CaseRecord } from './runner.js';
import { bool, isObj, num, str, strings, type Json } from './json.js';
import { haikuModels, lanBlockedReasons, lanOutcomes, webFetchAttempts, webToolsReasons, type WebAnswers } from './web.js';

export type CaseStatus = 'as_expected' | 'diverged' | 'error';
export type CaseVerdict = { case: CaseName; status: CaseStatus; reasons: string[] };

export type FailureShape = {
  observed_as: 'result' | 'provider_failure' | 'timeout' | 'none';
  subtype: string | null;
  is_error: boolean | null;
  terminal_reason: string | null;
  api_error_status: number | null;
  errors: string[];
  result_text: string | null;
  assistant_error: string | null;
  rejection: string | null;
  rate_limit_status: string | null;
};

export type UsageSplit = {
  usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number } | null;
  model_usage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> | null;
  /** Summed over `modelUsage`: input + cache_creation + cache_read (spec §4 `input_tokens_total`). */
  input_tokens_total: number | null;
  output_tokens_total: number | null;
  total_cost_usd: number | null;
  /** `usage.input_tokens` smaller than the cached part: the shape spec §6.2's usage check must survive. */
  cache_dominant: boolean | null;
};

export type TurnEndShape = {
  sequence: string[];
  trailing_assistant_after_tool_result: boolean | null;
  messages_after_result: string[];
};

export type ChannelVerdict = 'closed' | 'leaks' | 'nothing_to_leak' | 'observer_unverified';

export type Recommendation = 'bypass_allow_empty' | 'interactive_carrier_policy' | 'dont_ask' | 'fallback_plain_json';

export type M1Answers = {
  q1: {
    structured_output_delivered: boolean;
    init_tools: string[] | null;
    init_model: string | null;
    carrier_tool: string | null;
    transcript_labels: string[] | null;
    transcript_has_structured_output_attachment: boolean | null;
  };
  q2: { cases: Partial<Record<CaseName, CaseStatus>>; init_permission_mode: string | null; permission_requests: number; recommendation: Recommendation };
  q3: TurnEndShape & { kernel_turn_completed_outcome: string | null; kernel_result_text: string | null };
  q4: {
    /**
     * `observed` holds only what came from the account (the verdict's input). `not_from_account`
     * is what the session carried anyway -- CLI builtins such as `agents-md@builtin` -- recorded
     * so the report still shows it; ISOLATED does not control it and it is not a leak.
     */
    channels: Array<{ channel: string; available: string[]; observed: string[]; not_from_account: string[]; verdict: ChannelVerdict }>;
    claude_json_projects_before: number | null;
    claude_json_projects_after: number | null;
  };
  q5: UsageSplit & { prompt_bytes: number; estimated_tokens: number; ratio_total_to_estimate: number | null };
  q6: { auth: FailureShape | null; schema_retry: FailureShape | null; quota: FailureShape | null };
  identity: {
    account_info_before_turn: AccountInfoProbe | null;
    account_info_after_turn: AccountInfoProbe | null;
    transcript_path: string | null;
    transcript_under_account_dir: boolean;
  };
  cli: { version_flag: string; init_version: string | null; same_binary: boolean | null };
  /** Present only when a web case ran (muninn client spec §9.1). */
  web?: WebAnswers;
};

const messagesOf = (record: CaseRecord | null | undefined): unknown[] => (record ? record.messages.map((m) => m.message) : []);

export function findInit(messages: readonly unknown[]): Json | null {
  for (const m of messages) {
    if (isObj(m) && m.type === 'system' && m.subtype === 'init') {
      return m;
    }
  }
  return null;
}

/** The last result message: the CLI emits exactly one per turn, and each probe case sends one turn. */
export function findResult(messages: readonly unknown[]): Json | null {
  let found: Json | null = null;
  for (const m of messages) {
    if (isObj(m) && m.type === 'result') {
      found = m;
    }
  }
  return found;
}

function contentBlocks(m: Json): unknown[] {
  const inner = isObj(m.message) ? m.message.content : undefined;
  return Array.isArray(inner) ? inner : [];
}

/** Compact, stable label for one SDK message or transcript entry, e.g. `assistant/tool_use:StructuredOutput`. */
export function label(m: unknown): string {
  if (!isObj(m)) {
    return typeof m;
  }
  const type = str(m.type) ?? '?';
  if (type === 'assistant' || type === 'user') {
    const inner = isObj(m.message) ? m.message.content : undefined;
    if (typeof inner === 'string') {
      return `${type}/text`;
    }
    const parts = contentBlocks(m).map((b) => (isObj(b) ? (b.type === 'tool_use' ? `tool_use:${str(b.name) ?? '?'}` : (str(b.type) ?? '?')) : '?'));
    return `${type}/${parts.join('+') || 'empty'}`;
  }
  if (isObj(m.attachment)) {
    return `${type}/${str(m.attachment.type) ?? '?'}`;
  }
  const subtype = str(m.subtype);
  return subtype === null ? type : `${type}/${subtype}`;
}

/** The tool that carried the structured output: the last tool_use before a result that has one. */
export function carrierTool(messages: readonly unknown[]): string | null {
  const result = findResult(messages);
  if (result === null || result.structured_output === undefined) {
    return null;
  }
  let name: string | null = null;
  for (const m of messages) {
    if (m === result) {
      break;
    }
    if (isObj(m) && m.type === 'assistant') {
      for (const b of contentBlocks(m)) {
        if (isObj(b) && b.type === 'tool_use') {
          name = str(b.name);
        }
      }
    }
  }
  return name;
}

export function turnEndShape(messages: readonly unknown[]): TurnEndShape {
  const resultIndex = messages.findIndex((m) => isObj(m) && m.type === 'result');
  const before = resultIndex === -1 ? messages : messages.slice(0, resultIndex);
  let lastToolResult = -1;
  before.forEach((m, i) => {
    if (isObj(m) && m.type === 'user' && contentBlocks(m).some((b) => isObj(b) && b.type === 'tool_result')) {
      lastToolResult = i;
    }
  });
  return {
    sequence: messages.map(label),
    trailing_assistant_after_tool_result:
      lastToolResult === -1 ? null : before.slice(lastToolResult + 1).some((m) => isObj(m) && m.type === 'assistant'),
    messages_after_result: resultIndex === -1 ? [] : messages.slice(resultIndex + 1).map(label),
  };
}

export function usageSplit(result: Json | null): UsageSplit {
  const usage = result !== null && isObj(result.usage) ? result.usage : null;
  const modelUsage = result !== null && isObj(result.modelUsage) ? result.modelUsage : null;
  const u = usage === null
    ? null
    : {
        input_tokens: num(usage.input_tokens) ?? 0,
        cache_creation_input_tokens: num(usage.cache_creation_input_tokens) ?? 0,
        cache_read_input_tokens: num(usage.cache_read_input_tokens) ?? 0,
        output_tokens: num(usage.output_tokens) ?? 0,
      };
  let perModel: UsageSplit['model_usage'] = null;
  let inTotal: number | null = null;
  let outTotal: number | null = null;
  if (modelUsage !== null) {
    const collected: NonNullable<UsageSplit['model_usage']> = {};
    let sumIn = 0;
    let sumOut = 0;
    for (const [model, v] of Object.entries(modelUsage)) {
      if (!isObj(v)) {
        continue;
      }
      const entry = {
        inputTokens: num(v.inputTokens) ?? 0,
        outputTokens: num(v.outputTokens) ?? 0,
        cacheReadInputTokens: num(v.cacheReadInputTokens) ?? 0,
        cacheCreationInputTokens: num(v.cacheCreationInputTokens) ?? 0,
        costUSD: num(v.costUSD) ?? 0,
      };
      collected[model] = entry;
      sumIn += entry.inputTokens + entry.cacheCreationInputTokens + entry.cacheReadInputTokens;
      sumOut += entry.outputTokens;
    }
    perModel = collected;
    inTotal = sumIn;
    outTotal = sumOut;
  }
  return {
    usage: u,
    model_usage: perModel,
    input_tokens_total: inTotal,
    output_tokens_total: outTotal,
    total_cost_usd: result === null ? null : num(result.total_cost_usd),
    cache_dominant: u === null ? null : u.input_tokens < u.cache_creation_input_tokens + u.cache_read_input_tokens,
  };
}

function lastOf<T>(messages: readonly unknown[], pick: (m: Json) => T | null): T | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isObj(m)) {
      const value = pick(m);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

export function failureShape(record: CaseRecord): FailureShape {
  const messages = messagesOf(record);
  const result = findResult(messages);
  return {
    observed_as: result !== null ? 'result' : record.next_rejection !== null ? 'provider_failure' : record.timed_out ? 'timeout' : 'none',
    subtype: result === null ? null : str(result.subtype),
    is_error: result === null ? null : bool(result.is_error),
    terminal_reason: result === null ? null : str(result.terminal_reason),
    api_error_status: result === null ? null : num(result.api_error_status),
    errors: result === null ? [] : strings(result.errors).slice(0, 10),
    result_text: result === null ? null : (str(result.result)?.slice(0, 300) ?? null),
    assistant_error: lastOf(messages, (m) => (m.type === 'assistant' ? str(m.error) : null)),
    rejection: record.next_rejection,
    rate_limit_status: lastOf(messages, (m) => (m.type === 'rate_limit_event' && isObj(m.rate_limit_info) ? str(m.rate_limit_info.status) : null)),
  };
}

/**
 * Instruction files the session loaded, from both observers: the SDK `InstructionsLoaded` hook and
 * the transcript's `attachment/instructions` entry. On CLI 2.1.281 only the transcript saw the
 * control's project CLAUDE.md -- the hook never fired -- so either one counts.
 */
export function instructionPaths(record: CaseRecord | null): string[] {
  if (record === null) {
    return [];
  }
  const fromHook = record.hook_observations
    .filter((h) => h.event === 'InstructionsLoaded')
    .map((h) => (isObj(h.input) ? (str(h.input.file_path) ?? '?') : '?'));
  const fromTranscript = (record.transcript?.entries ?? []).flatMap((e) =>
    isObj(e) && e.type === 'attachment' && isObj(e.attachment) && e.attachment.type === 'instructions' && Array.isArray(e.attachment.files)
      ? e.attachment.files.map((f) => (isObj(f) ? (str(f.path) ?? '?') : '?'))
      : [],
  );
  return [...new Set([...fromHook, ...fromTranscript])];
}

function hasMuninnArrays(value: unknown): boolean {
  return isObj(value) && ['scores', 'picks', 'events', 'weekly'].every((key) => Array.isArray(value[key]));
}

export function accountEmail(record: CaseRecord): string | null {
  for (const probe of [record.account_info_before_turn, record.account_info_after_turn]) {
    if (probe?.ok === true && typeof probe.info.email === 'string' && probe.info.email !== '') {
      return probe.info.email;
    }
  }
  return null;
}

function verdict(name: CaseName, reasons: string[]): CaseVerdict {
  return { case: name, status: reasons.length === 0 ? 'as_expected' : 'diverged', reasons };
}

/** Divergence when the session's accountInfo() email is missing, or wrong when a specific account
 * is expected. Shared by every branch of `analyzeCase` that checks billing identity (the general
 * path and the web cases). Empty = as expected. */
function accountReasons(record: CaseRecord, opts: { expectEmail: string | null }): string[] {
  const email = accountEmail(record);
  if (email === null) {
    return ['accountInfo() gave no email before or after the turn'];
  }
  if (opts.expectEmail !== null && email !== opts.expectEmail) {
    return [`accountInfo().email is ${email}, expected ${opts.expectEmail}`];
  }
  return [];
}

/** The kernel's turn_completed outcome, or null if that event never arrived. Shared with web.ts's
 * `webToolsReasons`, which checks the same thing for the web-tools case. */
export function turnOutcome(record: CaseRecord): string | null {
  const completed = record.kernel_events.find((e) => e.type === 'turn_completed');
  return completed !== undefined && completed.type === 'turn_completed' ? completed.outcome : null;
}

/** timed_out / no-result / result-subtype+is_error checks shared by every expectation that reads a
 * result message (the general "success" path and web.ts's `webToolsReasons`). Empty here means
 * only these checks passed; callers add their own checks of what a valid result must contain. */
export function resultShapeReasons(record: CaseRecord, result: Json | null): string[] {
  const reasons: string[] = [];
  if (record.timed_out) {
    reasons.push('timed out');
  }
  if (result === null) {
    reasons.push('no result message');
  } else if (result.subtype !== 'success' || result.is_error !== false) {
    reasons.push(`result is ${JSON.stringify(result.subtype)} with is_error=${JSON.stringify(result.is_error)}`);
  }
  return reasons;
}

export function analyzeCase(def: CaseDef, record: CaseRecord, opts: { expectEmail: string | null }): CaseVerdict {
  if (record.guard_violations.length > 0) {
    return { case: def.name, status: 'error', reasons: record.guard_violations.map((v) => `guard: ${v}`) };
  }
  if (record.runner_error !== null && record.messages.length === 0) {
    return { case: def.name, status: 'error', reasons: [`runner: ${record.runner_error}`] };
  }
  const messages = messagesOf(record);
  const result = findResult(messages);
  const reasons: string[] = [];

  if (def.expectation === 'failure') {
    if (record.timed_out) {
      reasons.push('timed out before any failure was reported');
    }
    // What "the failure did not happen" means depends on what the case breaks. auth-invalid breaks
    // the login: any success/is_error=false result means it authenticated. schema-unsatisfiable
    // breaks the schema, and the CLI reports that as success/is_error=false with NO
    // structured_output (measured on CLI 2.1.281: two rejected StructuredOutput calls, one
    // [structured-output-enforce] nudge, then plain text) -- so only a delivered structured_output
    // means the turn succeeded there.
    const deliveredWhatWasAsked = def.name !== 'schema-unsatisfiable' || (result !== null && result.structured_output !== undefined);
    if (result !== null && result.subtype === 'success' && result.is_error === false && deliveredWhatWasAsked) {
      reasons.push('the turn succeeded: the failure this case induces did not happen');
    }
    if (result !== null && result.structured_output !== undefined) {
      reasons.push('structured_output was delivered');
    }
    return verdict(def.name, reasons);
  }

  if (def.expectation === 'instructions_loaded') {
    if (!instructionPaths(record).some((path) => path.startsWith(record.cwd))) {
      reasons.push(
        `neither an InstructionsLoaded hook nor a transcript instructions attachment for ${record.cwd}/CLAUDE.md: the observer is blind, so silence elsewhere proves nothing`,
      );
    }
    return verdict(def.name, reasons);
  }

  if (def.expectation === 'web_success' || def.expectation === 'lan_blocked') {
    const webResult = findResult(messages);
    reasons.push(
      ...(def.expectation === 'web_success'
        ? webToolsReasons(record, messages, findInit(messages), webResult)
        : lanBlockedReasons(def.lanUrls, record, messages, webResult)),
    );
    reasons.push(...accountReasons(record, opts));
    return verdict(def.name, reasons);
  }

  const init = findInit(messages);
  const carrier = carrierTool(messages);
  reasons.push(...resultShapeReasons(record, result));
  if (result !== null && !hasMuninnArrays(result.structured_output)) {
    reasons.push('structured_output is missing or lacks the scores/picks/events/weekly arrays');
  }
  if (init === null) {
    reasons.push('no system/init message');
  } else {
    if (init.permissionMode !== def.expectedInitPermissionMode) {
      reasons.push(`init.permissionMode is ${JSON.stringify(init.permissionMode)}, expected ${JSON.stringify(def.expectedInitPermissionMode)}`);
    }
    if (!Array.isArray(init.tools)) {
      reasons.push('init.tools is missing');
    } else {
      const extra = strings(init.tools).filter((tool) => tool !== carrier);
      if (extra.length > 0) {
        reasons.push(`init.tools has ${JSON.stringify(extra)} beyond the carrier ${JSON.stringify(carrier)}`);
      }
    }
  }
  if (def.policy.permissions === 'bypass' && record.permission_requests.length > 0) {
    reasons.push(`${record.permission_requests.length} permission requests under bypass`);
  }
  const denied = record.permission_requests.filter((p) => p.decision === 'deny').map((p) => p.tool_name);
  if (denied.length > 0) {
    reasons.push(`denied permission requests for ${JSON.stringify(denied)}`);
  }
  const outcome = turnOutcome(record);
  if (outcome !== 'completed') {
    reasons.push(`kernel turn_completed outcome is ${JSON.stringify(outcome)}`);
  }
  reasons.push(...accountReasons(record, opts));
  if (record.transcript === null) {
    reasons.push('no transcript under the account config dir');
  }
  return verdict(def.name, reasons);
}

function channelVerdict(available: number, observed: number, observerOk: boolean): ChannelVerdict {
  if (!observerOk) {
    return 'observer_unverified';
  }
  if (observed > 0) {
    return 'leaks';
  }
  return available === 0 ? 'nothing_to_leak' : 'closed';
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (isObj(v) ? (str(v.name) ?? '?') : String(v))) : [];
}

/**
 * `init.plugins` entries as `name@source-marketplace` ids, the key shape of the account's
 * `enabledPlugins`. An entry is the account's when its id -- or, failing that, its bare name --
 * matches an enabled plugin; matching on the bare name errs towards "leaks".
 */
function splitPlugins(value: unknown, enabled: readonly string[]): { account: string[]; other: string[] } {
  const account: string[] = [];
  const other: string[] = [];
  for (const v of Array.isArray(value) ? value : []) {
    const name = isObj(v) ? (str(v.name) ?? '?') : String(v);
    const id = (isObj(v) ? str(v.source) : null) ?? name;
    (enabled.includes(id) || enabled.some((e) => e.split('@')[0] === name) ? account : other).push(id);
  }
  return { account, other };
}

function hasQuotaEvidence(shape: FailureShape): boolean {
  return shape.api_error_status === 429 || shape.rate_limit_status === 'rejected' || shape.assistant_error === 'rate_limit';
}

export type AnswerInput = {
  records: Partial<Record<CaseName, CaseRecord>>;
  verdicts: Partial<Record<CaseName, CaseVerdict>>;
  inventoryBefore: AccountInventory;
  inventoryAfter: AccountInventory;
  pinnedConfigDir: string;
  cliVersionFlag: string;
  promptBytes: number;
  estimatedTokens: number;
  /** The `web-lan` case's URLs (meta.lan_urls); absent or empty when that case did not run. */
  lanUrls?: readonly string[];
};

/**
 * The account inventory a run measured, rebuilt from its Q4 table (the `available` column), so a
 * reanalysis judges against what the account held then rather than now. A missing row is refused,
 * not guessed: an empty guess would come back as "nothing_to_leak".
 */
export function inventoryFromAnswers(q4: M1Answers['q4']): { before: AccountInventory; after: AccountInventory } {
  const available = (channel: string): string[] => {
    const row = q4.channels.find((c) => c.channel === channel);
    if (row === undefined) {
      throw new Error(`report has no Q4 ${JSON.stringify(channel)} row, so the account inventory cannot be rebuilt`);
    }
    return row.available;
  };
  const before: AccountInventory = {
    settings_hook_events: available('settings hooks'),
    enabled_plugins: available('plugins'),
    user_mcp_servers: available('MCP servers'),
    skill_dirs: available('skills'),
    claude_md_present: available('CLAUDE.md / rules').length > 0,
    claude_json_projects: q4.claude_json_projects_before,
  };
  return { before, after: { ...before, claude_json_projects: q4.claude_json_projects_after } };
}

export function answerQuestions(input: AnswerInput): M1Answers {
  const success = input.records.success ?? null;
  const messages = messagesOf(success);
  const init = findInit(messages);
  const result = findResult(messages);
  const statusOf = (name: CaseName): CaseStatus | undefined => input.verdicts[name]?.status;
  const completed = success?.kernel_events.find((e) => e.type === 'turn_completed');
  const entries = success?.transcript?.entries ?? null;
  const usage = usageSplit(result);

  const observerOk = success !== null && init !== null;
  const settingsHooks = messages
    .filter((m) => isObj(m) && m.type === 'system' && (m.subtype === 'hook_started' || m.subtype === 'hook_response') && m.hook_event !== 'InstructionsLoaded')
    .map((m) => (isObj(m) ? `${str(m.hook_event) ?? '?'}:${str(m.hook_name) ?? '?'}` : '?'));
  const instructions = instructionPaths(success);
  // The control proves the observer, and on CLI 2.1.281 the observer that works is the transcript:
  // without the success transcript, silence proves nothing.
  const instructionsObserverOk = observerOk && statusOf('control-claudemd') === 'as_expected' && success?.transcript != null;
  const inv = input.inventoryBefore;
  const plugins = splitPlugins(init?.plugins, inv.enabled_plugins);
  const mcp = names(init?.mcp_servers);
  const sessionSkills = strings(init?.skills);
  const skills = sessionSkills.filter((skill) => inv.skill_dirs.includes(skill));

  let quota: FailureShape | null = null;
  for (const record of Object.values(input.records)) {
    if (record !== undefined && quota === null) {
      const shape = failureShape(record);
      if (hasQuotaEvidence(shape)) {
        quota = shape;
      }
    }
  }

  const initVersion = str(init?.claude_code_version);
  const flagVersion = parseCliVersion(input.cliVersionFlag);
  const transcriptPath = success?.transcript?.path ?? null;

  return {
    q1: {
      structured_output_delivered: result !== null && hasMuninnArrays(result.structured_output),
      init_tools: init === null ? null : strings(init.tools),
      init_model: str(init?.model),
      carrier_tool: carrierTool(messages),
      transcript_labels: entries === null ? null : entries.map(label),
      transcript_has_structured_output_attachment:
        entries === null ? null : entries.some((e) => isObj(e) && e.type === 'attachment' && JSON.stringify(e).includes('structured_output')),
    },
    q2: {
      cases: Object.fromEntries(
        (['success', 'interactive', 'dontask'] as const).filter((n) => statusOf(n) !== undefined).map((n) => [n, statusOf(n)]),
      ) as Partial<Record<CaseName, CaseStatus>>,
      init_permission_mode: str(init?.permissionMode),
      permission_requests: success?.permission_requests.length ?? 0,
      recommendation:
        statusOf('success') === 'as_expected'
          ? 'bypass_allow_empty'
          : statusOf('interactive') === 'as_expected'
            ? 'interactive_carrier_policy'
            : statusOf('dontask') === 'as_expected'
              ? 'dont_ask'
              : 'fallback_plain_json',
    },
    q3: {
      ...turnEndShape(messages),
      kernel_turn_completed_outcome: completed?.type === 'turn_completed' ? completed.outcome : null,
      kernel_result_text: completed?.type === 'turn_completed' ? completed.resultText.slice(0, 200) : null,
    },
    q4: {
      channels: [
        {
          channel: 'settings hooks',
          available: inv.settings_hook_events,
          observed: settingsHooks,
          not_from_account: [],
          verdict: channelVerdict(inv.settings_hook_events.length, settingsHooks.length, observerOk),
        },
        {
          channel: 'CLAUDE.md / rules',
          available: inv.claude_md_present ? ['CLAUDE.md'] : [],
          observed: instructions,
          not_from_account: [],
          verdict: channelVerdict(inv.claude_md_present ? 1 : 0, instructions.length, instructionsObserverOk),
        },
        {
          channel: 'plugins',
          available: inv.enabled_plugins,
          observed: plugins.account,
          not_from_account: plugins.other,
          verdict: channelVerdict(inv.enabled_plugins.length, plugins.account.length, observerOk),
        },
        { channel: 'MCP servers', available: inv.user_mcp_servers, observed: mcp, not_from_account: [], verdict: channelVerdict(inv.user_mcp_servers.length, mcp.length, observerOk) },
        {
          channel: 'skills',
          available: inv.skill_dirs,
          observed: skills,
          not_from_account: sessionSkills.filter((skill) => !inv.skill_dirs.includes(skill)),
          verdict: channelVerdict(inv.skill_dirs.length, skills.length, observerOk),
        },
      ],
      claude_json_projects_before: inv.claude_json_projects,
      claude_json_projects_after: input.inventoryAfter.claude_json_projects,
    },
    q5: {
      ...usage,
      prompt_bytes: input.promptBytes,
      estimated_tokens: input.estimatedTokens,
      ratio_total_to_estimate:
        usage.input_tokens_total === null || input.estimatedTokens === 0 ? null : Math.round((usage.input_tokens_total / input.estimatedTokens) * 100) / 100,
    },
    q6: {
      auth: input.records['auth-invalid'] ? failureShape(input.records['auth-invalid']) : null,
      schema_retry: input.records['schema-unsatisfiable'] ? failureShape(input.records['schema-unsatisfiable']) : null,
      quota,
    },
    identity: {
      account_info_before_turn: success?.account_info_before_turn ?? null,
      account_info_after_turn: success?.account_info_after_turn ?? null,
      transcript_path: transcriptPath,
      transcript_under_account_dir: transcriptPath !== null && transcriptPath.startsWith(`${input.pinnedConfigDir}/`),
    },
    cli: {
      version_flag: input.cliVersionFlag.trim(),
      init_version: initVersion,
      same_binary: initVersion === null || flagVersion === null ? null : initVersion === flagVersion,
    },
    ...webAnswers(input),
  };
}

/** `{ web }` when a web case ran, `{}` otherwise, so a run without them keeps its report shape. */
function webAnswers(input: AnswerInput): { web?: WebAnswers } {
  const tools = input.records['web-tools'];
  const lan = input.records['web-lan'];
  if (tools === undefined && lan === undefined) {
    return {};
  }
  const toolMessages = messagesOf(tools);
  const toolInit = findInit(toolMessages);
  const toolResult = findResult(toolMessages);
  const lanMessages = messagesOf(lan);
  return {
    web: {
      init_tools: tools === undefined || toolInit === null ? null : strings(toolInit.tools),
      haiku_models: haikuModels(toolResult),
      fetched_public: webFetchAttempts(toolMessages, toolResult).some((a) => a.result === 'content'),
      lan: lan === undefined ? [] : lanOutcomes(input.lanUrls ?? [], lanMessages, findResult(lanMessages)),
    },
  };
}
