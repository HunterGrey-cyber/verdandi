import type { CaseName } from './cases.js';
import type { AccountInfoProbe } from './runner.js';
import type { CaseVerdict, FailureShape, M1Answers } from './analyze.js';
import { isObj } from './json.js';
import { expectedWebInitTools, type LanOutcome } from './web.js';

export type ProbeMeta = {
  host: string;
  started_at: string;
  finished_at: string;
  cli_path: string;
  cli_realpath: string;
  cli_version_flag: string;
  sdk_version: string;
  node_version: string;
  git_head: string | null;
  account: { name: string; config_dir: string };
  model: string;
  effort: string;
  cases: CaseName[];
  /** The `web-lan` case's URLs, kept so `reanalyze` judges the recording against the same list. */
  lan_urls?: string[];
  /**
   * Set by `reanalyze`: verdicts and answers were re-derived from this run's recordings by a later
   * analyzer, without a new turn. Everything else in the meta still describes the recording run.
   */
  reanalyzed?: { at: string; git_head: string | null };
};

/**
 * What later plans read. `files` maps a logical name (`success_result`, `auth-invalid_messages`,
 * ...) to a file name in the same directory. Every value was redacted before it was written.
 */
export type M1FixtureManifest = {
  schema: 'verdandi.m1-fixtures/v1';
  recorded_at: string;
  host: string;
  cli_version: string;
  sdk_version: string;
  model_requested: string;
  model_resolved: string | null;
  effort_requested: string;
  carrier_tool: string | null;
  init_tools: string[];
  permission_mode: string;
  usage_shape: 'cache_dominant' | 'uncached';
  account_info_before_first_turn: 'ok' | 'timeout' | 'error' | 'not_measured';
  failure_shapes: { auth: FailureShape | null; schema_retry: FailureShape | null; quota: FailureShape | null };
  files: Record<string, string>;
  redactions: string[];
  /** The `web-tools` recording (promote-web): system/init tools of a tool-bearing completion. */
  web_init_tools?: string[];
  /** The `web-tools` recording: the Haiku models WebFetch's own call billed in that session. */
  web_haiku_models?: string[];
  /** The `web-lan` recording (promote-web): how each LAN URL ended. Recorded on a host that does
   * not restrict the network, so `rule` there can only be the WebFetch deny rule. */
  web_lan_outcomes?: LanOutcome[];
};

export type RedactionRule = { find: string; replace: string; label: string };

/** Longest first, so a path under HOME is replaced as a whole before HOME itself is. */
export function buildRedactionRules(input: { home: string; email: string | null; organization: string | null; tempPaths: string[] }): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (const path of input.tempPaths) {
    if (path !== '') {
      rules.push({ find: path, replace: '/tmp/m1-probe-path', label: 'temp path' });
    }
  }
  if (input.email !== null && input.email !== '') {
    rules.push({ find: input.email, replace: 'work@example.invalid', label: 'account email' });
  }
  if (input.organization !== null && input.organization !== '') {
    rules.push({ find: input.organization, replace: 'm1-probe-organization', label: 'account organization' });
  }
  if (input.home !== '' && input.home !== '/') {
    rules.push({ find: input.home, replace: '/home/m1-probe', label: 'home directory' });
  }
  return rules.sort((a, b) => b.find.length - a.find.length);
}

export function redactString(text: string, rules: readonly RedactionRule[]): string {
  let out = text;
  for (const rule of rules) {
    out = out.split(rule.find).join(rule.replace);
  }
  return out;
}

/** Deep copy with every string -- object keys included -- redacted. */
export function redactDeep(value: unknown, rules: readonly RedactionRule[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, rules);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, rules));
  }
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[redactString(key, rules)] = redactDeep(item, rules);
    }
    return out;
  }
  return value;
}

/** Labels of every rule whose secret still appears in `text`. Empty means safe to write. */
export function leaks(text: string, rules: readonly RedactionRule[]): string[] {
  return rules.filter((rule) => text.includes(rule.find)).map((rule) => rule.label);
}

function accountInfoStatus(probe: AccountInfoProbe | null): M1FixtureManifest['account_info_before_first_turn'] {
  if (probe === null) {
    return 'not_measured';
  }
  if (probe.ok) {
    return 'ok';
  }
  return probe.error.includes('did not answer') ? 'timeout' : 'error';
}

export function buildManifest(input: {
  meta: ProbeMeta;
  answers: M1Answers;
  files: Record<string, string>;
  redactions: string[];
}): M1FixtureManifest {
  const { meta, answers } = input;
  return {
    schema: 'verdandi.m1-fixtures/v1',
    recorded_at: meta.started_at,
    host: meta.host,
    cli_version: answers.cli.init_version ?? meta.cli_version_flag,
    sdk_version: meta.sdk_version,
    model_requested: meta.model,
    model_resolved: answers.q1.init_model,
    effort_requested: meta.effort,
    carrier_tool: answers.q1.carrier_tool,
    init_tools: answers.q1.init_tools ?? [],
    permission_mode: answers.q2.init_permission_mode ?? 'unknown',
    usage_shape: answers.q5.cache_dominant === true ? 'cache_dominant' : 'uncached',
    account_info_before_first_turn: accountInfoStatus(answers.identity.account_info_before_turn),
    failure_shapes: answers.q6,
    files: input.files,
    redactions: input.redactions,
  };
}

const j = (value: unknown): string => JSON.stringify(value);

/**
 * The host-b rerun check. `differences` fail the rerun; `notes` (a CLI version bump, for
 * instance) are reported but expected over time.
 */
export function compareToBaseline(answers: M1Answers, verdicts: readonly CaseVerdict[], baseline: M1FixtureManifest): { differences: string[]; notes: string[] } {
  const differences: string[] = [];
  const notes: string[] = [];
  const success = verdicts.find((v) => v.case === 'success');
  const web = verdicts.find((v) => v.case === 'web-tools');
  const lan = verdicts.find((v) => v.case === 'web-lan');
  if (success === undefined && web === undefined && lan === undefined) {
    differences.push('the run has none of success, web-tools, web-lan: there is nothing to compare with the baseline');
  }
  if (web !== undefined) {
    if (web.status !== 'as_expected') {
      differences.push(`web-tools case is ${web.status}`);
    }
    if (baseline.web_init_tools === undefined) {
      differences.push('the baseline has no web-tools recording (web_init_tools); record one with promote-web first');
    } else {
      const nowWeb = [...(answers.web?.init_tools ?? [])].sort();
      const thenWeb = [...baseline.web_init_tools].sort();
      if (j(nowWeb) !== j(thenWeb)) {
        differences.push(`web init.tools ${j(nowWeb)} != baseline ${j(thenWeb)}`);
      }
    }
  }
  if (lan !== undefined && lan.status !== 'as_expected') {
    differences.push(`web-lan case is ${lan.status}`);
  }
  if (success === undefined) {
    return { differences, notes };
  }
  if (success.status !== 'as_expected') {
    differences.push(`success case is ${success.status}`);
  }
  if (answers.q1.carrier_tool !== baseline.carrier_tool) {
    differences.push(`carrier tool ${j(answers.q1.carrier_tool)} != baseline ${j(baseline.carrier_tool)}`);
  }
  const now = [...(answers.q1.init_tools ?? [])].sort();
  const then = [...baseline.init_tools].sort();
  if (j(now) !== j(then)) {
    differences.push(`init.tools ${j(now)} != baseline ${j(then)}`);
  }
  if (answers.q2.init_permission_mode !== baseline.permission_mode) {
    differences.push(`init.permissionMode ${j(answers.q2.init_permission_mode)} != baseline ${j(baseline.permission_mode)}`);
  }
  for (const key of ['auth', 'schema_retry'] as const) {
    const current = answers.q6[key];
    const recorded = baseline.failure_shapes[key];
    if (recorded === null) {
      continue;
    }
    if (current === null) {
      differences.push(`${key}: the baseline has a failure shape, this run has none`);
      continue;
    }
    for (const field of ['observed_as', 'subtype', 'terminal_reason', 'api_error_status'] as const) {
      if (current[field] !== recorded[field]) {
        differences.push(`${key}.${field} ${j(current[field])} != baseline ${j(recorded[field])}`);
      }
    }
  }
  if (answers.cli.init_version !== baseline.cli_version) {
    notes.push(`CLI ${j(answers.cli.init_version)} (baseline ${j(baseline.cli_version)})`);
  }
  if (answers.q1.init_model !== baseline.model_resolved) {
    notes.push(`model ${j(answers.q1.init_model)} (baseline ${j(baseline.model_resolved)})`);
  }
  return { differences, notes };
}

function info(probe: AccountInfoProbe | null): string {
  if (probe === null) {
    return 'not measured';
  }
  return probe.ok ? `${j(probe.info)} in ${probe.ms} ms` : `failed after ${probe.ms} ms: ${probe.error}`;
}

/** Markdown for the spec's Appendix A. Facts only; the decision is written by a person. */
export function renderAppendix(meta: ProbeMeta, answers: M1Answers, verdicts: readonly CaseVerdict[]): string {
  const lines: string[] = [];
  const q = answers;
  lines.push(`### M1 run ${meta.started_at} on ${meta.host}`, '');
  lines.push('| item | value |', '|---|---|');
  lines.push(`| claude --version | ${j(meta.cli_version_flag)} at ${meta.cli_realpath} |`);
  lines.push(`| init claude_code_version | ${j(q.cli.init_version)} (same binary: ${q.cli.same_binary}) |`);
  lines.push(`| agent SDK / node | ${meta.sdk_version} / ${meta.node_version} |`);
  lines.push(`| verdandi HEAD | ${meta.git_head ?? 'unknown'} |`);
  if (meta.reanalyzed !== undefined) {
    lines.push(`| reanalyzed | ${meta.reanalyzed.at} at verdandi ${meta.reanalyzed.git_head ?? 'unknown'} (verdicts and answers re-derived from these recordings; no new turn) |`);
  }
  lines.push(`| account | ${meta.account.name} (${meta.account.config_dir}) |`);
  lines.push(`| model / effort | ${meta.model} -> ${j(q.q1.init_model)} / ${meta.effort} |`);
  lines.push(`| accountInfo() before first turn | ${info(q.identity.account_info_before_turn)} |`);
  lines.push(`| accountInfo() after turn | ${info(q.identity.account_info_after_turn)} |`);
  lines.push(`| transcript | ${q.identity.transcript_path ?? 'not found'} (under account dir: ${q.identity.transcript_under_account_dir}) |`, '');
  lines.push('| case | status | reasons |', '|---|---|---|');
  for (const v of verdicts) {
    lines.push(`| ${v.case} | ${v.status} | ${v.reasons.join('; ').replaceAll('|', '/') || '-'} |`);
  }
  lines.push('', '**Q1 structured output with zero tools**');
  lines.push(`- delivered: ${q.q1.structured_output_delivered}; init.tools: ${j(q.q1.init_tools)}; carrier: ${j(q.q1.carrier_tool)}`);
  lines.push(`- transcript entries: ${j(q.q1.transcript_labels)}`);
  lines.push(`- structured_output attachment in transcript: ${q.q1.transcript_has_structured_output_attachment}`);
  lines.push('', '**Q2 permission modes**');
  lines.push(`- cases: ${j(q.q2.cases)}; init.permissionMode (success): ${j(q.q2.init_permission_mode)}; permission requests: ${q.q2.permission_requests}`);
  lines.push(`- recommendation: ${q.q2.recommendation}`);
  lines.push('', '**Q3 turn end**');
  lines.push(`- sequence: ${j(q.q3.sequence)}`);
  lines.push(`- trailing assistant after tool_result: ${q.q3.trailing_assistant_after_tool_result}; after result: ${j(q.q3.messages_after_result)}`);
  lines.push(`- kernel turn_completed: ${j(q.q3.kernel_turn_completed_outcome)}, resultText: ${j(q.q3.kernel_result_text)}`);
  lines.push(
    '',
    '**Q4 ISOLATED against the account dir**',
    '',
    '| channel | available in account | observed in session | verdict | in session, not from account |',
    '|---|---|---|---|---|',
  );
  for (const c of q.q4.channels) {
    lines.push(`| ${c.channel} | ${j(c.available)} | ${j(c.observed)} | ${c.verdict} | ${j(c.not_from_account)} |`);
  }
  lines.push(`- .claude.json projects: ${q.q4.claude_json_projects_before} before, ${q.q4.claude_json_projects_after} after`);
  lines.push('', '**Q5 usage**');
  lines.push(`- result.usage: ${j(q.q5.usage)}`);
  lines.push(`- modelUsage: ${j(q.q5.model_usage)}`);
  lines.push(`- input_tokens_total ${q.q5.input_tokens_total}, output ${q.q5.output_tokens_total}, cost ${q.q5.total_cost_usd}; cache dominant: ${q.q5.cache_dominant}`);
  lines.push(`- prompt ${q.q5.prompt_bytes} bytes, estimate ${q.q5.estimated_tokens} tokens, ratio total/estimate ${q.q5.ratio_total_to_estimate}`);
  lines.push('', '**Q6 failure shapes**');
  lines.push(`- auth: ${j(q.q6.auth)}`);
  lines.push(`- structured-output retry: ${j(q.q6.schema_retry)}`);
  lines.push(`- quota: ${q.q6.quota === null ? 'not observed (not induced; see Spec questions)' : j(q.q6.quota)}`);
  if (q.web !== undefined) {
    lines.push('', '**Web tools (muninn client spec §9.1)**');
    lines.push(`- init.tools: ${j(q.web.init_tools)} (expected ${j(expectedWebInitTools())})`);
    lines.push(`- public WebFetch returned content: ${q.web.fetched_public}; Haiku in modelUsage: ${j(q.web.haiku_models)}`);
    for (const outcome of q.web.lan) {
      lines.push(`- LAN ${outcome.url}: ${outcome.blocked_by}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
