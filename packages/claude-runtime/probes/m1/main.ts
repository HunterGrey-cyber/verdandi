import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import { accountGlobalConfigPath, applyAccountEnv, resolveAccount } from '../../src/account.js';
import { ALL_CASES, DEFAULT_CASES, WEB_CASES, buildCase, estimateTokens, type CaseName } from './cases.js';
import { checkParentEnv, isShellWrapper, parseCliVersion } from './guard.js';
import { inventoryAccount, runCase, type CaseRecord, type ProbeQueryFn } from './runner.js';
import { analyzeCase, answerQuestions, carrierTool, findInit, findResult, inventoryFromAnswers, type CaseVerdict, type M1Answers } from './analyze.js';
import { buildManifest, buildRedactionRules, compareToBaseline, leaks, redactDeep, renderAppendix, type M1FixtureManifest, type ProbeMeta } from './report.js';
import { describeError, num } from './json.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/** packages/claude-runtime, from dist/probes/m1/main.js. */
const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export type RunCli = {
  command: 'run';
  cases: CaseName[];
  out: string | null;
  expectEmail: string | null;
  baseline: string | null;
  model: string;
  effort: Effort;
  dryRun: boolean;
  /** `web-lan` only: the private-address https URLs that must all fail (`--lan-urls a,b`). */
  lanUrls: string[];
};
export type PromoteCli = { command: 'promote'; run: string; dest: string };
export type PromoteWebCli = { command: 'promote-web'; run: string; dest: string };
export type ReanalyzeCli = { command: 'reanalyze'; run: string; expectEmail: string | null; baseline: string | null };
export type ParsedCli = RunCli | PromoteCli | PromoteWebCli | ReanalyzeCli;

const USAGE = [
  'usage: main.js run [--cases a,b] [--out DIR] [--expect-email E] [--baseline MANIFEST] [--model M] [--effort E] [--lan-urls U1,U2] [--dry-run]',
  '       main.js promote --run RUN_DIR --dest FIXTURE_DIR',
  '       main.js promote-web --run RUN_DIR --dest FIXTURE_DIR',
  '       main.js reanalyze --run RUN_DIR [--expect-email E] [--baseline MANIFEST]',
].join('\n');

/** `--lan-urls`: absolute https URLs (WebFetch upgrades http anyway), comma-separated. */
function parseLanUrls(raw: string | undefined): string[] {
  const urls = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--lan-urls: ${JSON.stringify(url)} is not a URL`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`--lan-urls: ${JSON.stringify(url)} must be https (WebFetch upgrades http, so an http URL would test a different request)`);
    }
  }
  return urls;
}

function isCase(value: unknown): value is CaseName {
  return typeof value === 'string' && (ALL_CASES as readonly string[]).includes(value);
}

export function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cases: { type: 'string' },
      out: { type: 'string' },
      'expect-email': { type: 'string' },
      baseline: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'dry-run': { type: 'boolean' },
      run: { type: 'string' },
      dest: { type: 'string' },
      'lan-urls': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (command === 'promote' || command === 'promote-web') {
    if (values.run === undefined || values.dest === undefined) {
      throw new Error(`${command} needs --run and --dest\n${USAGE}`);
    }
    return { command, run: values.run, dest: values.dest };
  }
  if (command === 'reanalyze') {
    if (values.run === undefined) {
      throw new Error(`reanalyze needs --run\n${USAGE}`);
    }
    return { command: 'reanalyze', run: values.run, expectEmail: values['expect-email'] ?? null, baseline: values.baseline ?? null };
  }
  if (command !== 'run') {
    throw new Error(USAGE);
  }
  const requested = values.cases === undefined ? [...DEFAULT_CASES] : values.cases.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const name of requested) {
    if (!isCase(name)) {
      throw new Error(`unknown case ${JSON.stringify(name)}; known: ${ALL_CASES.join(', ')}`);
    }
  }
  const effort = values.effort ?? 'medium';
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
  }
  const lanUrls = parseLanUrls(values['lan-urls']);
  if (requested.includes('web-lan') && lanUrls.length === 0) {
    throw new Error('the web-lan case needs --lan-urls: private-address https URLs that answer on this host when nothing blocks them');
  }
  return {
    command: 'run',
    cases: ALL_CASES.filter((name) => requested.includes(name)),
    out: values.out ?? null,
    expectEmail: values['expect-email'] ?? null,
    baseline: values.baseline ?? null,
    model: values.model ?? 'sonnet',
    effort: effort as Effort,
    dryRun: values['dry-run'] === true,
    lanUrls,
  };
}

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1');
  } finally {
    closeSync(fd);
  }
}

function sdkVersion(): string {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function runCommand(cli: RunCli): Promise<number> {
  const problems = checkParentEnv(process.env);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`refused: ${problem}`);
    }
    return 2;
  }
  const account = resolveAccount(process.env);
  if (account === undefined) {
    console.error('refused: no account is pinned');
    return 2;
  }
  // run-m1-probe.sh pins the name work; a directory override (passed through from the caller's
  // environment) relabels whatever login sits there as work. Only the email says whose it is.
  const overridden = ['VERDANDI_CLAUDE_CONFIG_DIR', 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR'].filter((name) => (process.env[name] ?? '').trim() !== '');
  if (overridden.length > 0 && cli.expectEmail === null) {
    console.error(`refused: ${overridden.join(' and ')} moves the account away from its convention directory; pass --expect-email so the run proves whose login it used`);
    return 2;
  }
  const cliPath = process.env.VERDANDI_CLAUDE_CLI_PATH?.trim() ?? '';
  if (!isAbsolute(cliPath)) {
    console.error('refused: VERDANDI_CLAUDE_CLI_PATH must be the absolute path of the real CLI (run-m1-probe.sh sets it)');
    return 2;
  }
  const cliRealpath = realpathSync(cliPath);
  if (isShellWrapper(readHead(cliRealpath))) {
    console.error(`refused: ${cliPath} resolves to a shell launcher (${cliRealpath}); point VERDANDI_CLAUDE_CLI_PATH at the real binary`);
    return 2;
  }
  const versionFlag = execFileSync(cliPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: applyAccountEnv({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, account) as NodeJS.ProcessEnv,
  });
  if (parseCliVersion(versionFlag) === null) {
    console.error(`refused: ${cliPath} --version printed ${JSON.stringify(versionFlag)}, not a CLI version`);
    return 2;
  }
  const meta: ProbeMeta = {
    host: hostname(),
    started_at: new Date().toISOString(),
    finished_at: '',
    cli_path: cliPath,
    cli_realpath: cliRealpath,
    cli_version_flag: versionFlag.trim(),
    sdk_version: sdkVersion(),
    node_version: process.version,
    git_head: gitHead(),
    account: { name: account.name, config_dir: account.configDir },
    model: cli.model,
    effort: cli.effort,
    cases: cli.cases,
    ...(cli.lanUrls.length > 0 ? { lan_urls: cli.lanUrls } : {}),
  };
  if (cli.dryRun) {
    console.log(JSON.stringify(meta, null, 2));
    console.log('[m1] dry run: preflight passed, no session was started');
    return 0;
  }

  const out = cli.out ?? join(homedir(), '.cache', 'verdandi-m1', `${hostname()}-${meta.started_at.replace(/[:.]/g, '')}`);
  mkdirSync(join(out, 'cases'), { recursive: true, mode: 0o700 });
  const inventoryBefore = inventoryAccount(account.configDir, accountGlobalConfigPath(account));
  const records: Partial<Record<CaseName, CaseRecord>> = {};
  const verdicts: Partial<Record<CaseName, CaseVerdict>> = {};
  let carrierHint = 'StructuredOutput';
  let spent = 0;
  for (const name of cli.cases) {
    const def = buildCase(name, { lanUrls: cli.lanUrls });
    console.log(`[m1] ${name}: running (timeout ${def.timeoutMs / 1000}s)`);
    const record = await runCase(def, {
      pinnedAccount: account,
      cliPath,
      model: cli.model,
      effort: cli.effort,
      carrierHint,
      underlying: realQuery as unknown as ProbeQueryFn,
      pollMs: 50,
      settleMs: 1_500,
      accountInfoTimeoutMs: 15_000,
    });
    records[name] = record;
    writePrivate(join(out, 'cases', `${name}.json`), record);
    const messages = record.messages.map((m) => m.message);
    spent += num(findResult(messages)?.total_cost_usd) ?? 0;
    if (name === 'success') {
      carrierHint = carrierTool(messages) ?? carrierHint;
    }
    const verdict = analyzeCase(def, record, { expectEmail: cli.expectEmail });
    verdicts[name] = verdict;
    console.log(`[m1] ${name}: ${verdict.status}${verdict.reasons.length > 0 ? ` -- ${verdict.reasons.join('; ')}` : ''}`);
  }

  const success = buildCase('success');
  const prompt = `${success.systemPrompt}${success.userMessage}`;
  const answers = answerQuestions({
    records,
    verdicts,
    inventoryBefore,
    inventoryAfter: inventoryAccount(account.configDir, accountGlobalConfigPath(account)),
    pinnedConfigDir: account.configDir,
    cliVersionFlag: versionFlag,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    estimatedTokens: estimateTokens(prompt),
    lanUrls: cli.lanUrls,
  });
  meta.finished_at = new Date().toISOString();
  return conclude({ out, meta, verdicts: cli.cases.map((name) => verdicts[name]), answers, baseline: cli.baseline, cost: `spent about $${spent.toFixed(4)}` });
}

/**
 * Writes `report.json` and `appendix.md` into `out`, checks the baseline, and returns the exit
 * code: 1 when any case is not as expected (its `[m1] <case>: …` line says why) or the baseline
 * differs (`DIFFERENCE:` lines), else 0.
 */
function conclude(input: {
  out: string;
  meta: ProbeMeta;
  verdicts: ReadonlyArray<CaseVerdict | undefined>;
  answers: M1Answers;
  baseline: string | null;
  cost: string;
}): number {
  const { out, meta, answers } = input;
  const verdictList = input.verdicts.filter((v): v is CaseVerdict => v !== undefined);
  writePrivate(join(out, 'report.json'), { meta, verdicts: verdictList, answers });
  writePrivate(join(out, 'appendix.md'), renderAppendix(meta, answers, verdictList));

  let failed = verdictList.some((v) => v.status !== 'as_expected');
  if (input.baseline !== null) {
    const baseline = JSON.parse(readFileSync(input.baseline, 'utf8')) as M1FixtureManifest;
    const { differences, notes } = compareToBaseline(answers, verdictList, baseline);
    for (const note of notes) {
      console.log(`[m1] note: ${note}`);
    }
    for (const difference of differences) {
      console.log(`[m1] DIFFERENCE: ${difference}`);
    }
    failed ||= differences.length > 0;
  }
  console.log(`[m1] recommendation: ${answers.q2.recommendation}; ${input.cost}`);
  console.log(`[m1] wrote ${out}`);
  return failed ? 1 : 0;
}

type RunReport = { meta: ProbeMeta; verdicts: CaseVerdict[]; answers: M1Answers };

/**
 * Re-derives a recorded run's verdicts and answers with the current analyzer, without a new turn,
 * and rewrites that run's `report.json` and `appendix.md` in place (copy the run dir first to keep
 * the old report). The account inventory comes from the run's own Q4 table, the prompt size from
 * its Q5 answer, so nothing is re-measured. Exit codes as `run`.
 */
export function reanalyzeCommand(cli: ReanalyzeCli): number {
  const report = JSON.parse(readFileSync(join(cli.run, 'report.json'), 'utf8')) as RunReport;
  const { before, after } = inventoryFromAnswers(report.answers.q4);
  const records: Partial<Record<CaseName, CaseRecord>> = {};
  const verdicts: Partial<Record<CaseName, CaseVerdict>> = {};
  for (const name of report.meta.cases) {
    if (!isCase(name)) {
      throw new Error(`report.json names an unknown case ${JSON.stringify(name)}`);
    }
    const record = JSON.parse(readFileSync(join(cli.run, 'cases', `${name}.json`), 'utf8')) as CaseRecord;
    records[name] = record;
    const verdict = analyzeCase(buildCase(name, { lanUrls: report.meta.lan_urls ?? [] }), record, { expectEmail: cli.expectEmail });
    verdicts[name] = verdict;
    console.log(`[m1] ${name}: ${verdict.status}${verdict.reasons.length > 0 ? ` -- ${verdict.reasons.join('; ')}` : ''}`);
  }
  const answers = answerQuestions({
    records,
    verdicts,
    inventoryBefore: before,
    inventoryAfter: after,
    pinnedConfigDir: report.meta.account.config_dir,
    cliVersionFlag: report.meta.cli_version_flag,
    promptBytes: report.answers.q5.prompt_bytes,
    estimatedTokens: report.answers.q5.estimated_tokens,
    lanUrls: report.meta.lan_urls ?? [],
  });
  const meta: ProbeMeta = { ...report.meta, reanalyzed: { at: new Date().toISOString(), git_head: gitHead() } };
  return conclude({ out: cli.run, meta, verdicts: report.meta.cases.map((name) => verdicts[name]), answers, baseline: cli.baseline, cost: 'no new turn (reanalysis)' });
}

/**
 * Copies a run into committed fixtures. Refuses unless the success case was as expected -- a
 * fixture pins a state later plans build on, so it must be a state that is right -- and checks
 * every file for residue of the redacted values before writing any of them.
 */
export function promoteCommand(cli: PromoteCli): number {
  const report = JSON.parse(readFileSync(join(cli.run, 'report.json'), 'utf8')) as RunReport;
  const statusOf = (name: CaseName) => report.verdicts.find((v) => v.case === name)?.status;
  if (statusOf('success') !== 'as_expected') {
    console.error(`refused: the success case is ${statusOf('success') ?? 'missing'} in ${cli.run}`);
    return 1;
  }
  const load = (name: CaseName): CaseRecord | null => {
    const path = join(cli.run, 'cases', `${name}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as CaseRecord) : null;
  };
  const success = load('success');
  if (success === null) {
    console.error(`refused: ${cli.run}/cases/success.json is missing`);
    return 1;
  }
  const probe = [success.account_info_before_turn, success.account_info_after_turn].find((p) => p?.ok === true);
  const info = probe?.ok === true ? probe.info : null;
  const records = ALL_CASES.map(load).filter((r): r is CaseRecord => r !== null);
  const rules = buildRedactionRules({
    home: homedir(),
    email: info?.email ?? null,
    organization: info?.organization ?? null,
    tempPaths: records.flatMap((r) => (r.account.configDir.startsWith(tmpdir()) ? [r.cwd, dirname(r.account.configDir)] : [r.cwd])),
  });

  const outputs = new Map<string, unknown>();
  const files: Record<string, string> = {};
  const add = (logical: string, file: string, value: unknown): void => {
    outputs.set(file, redactDeep(value, rules));
    files[logical] = file;
  };
  const successMessages = success.messages.map((m) => m.message);
  add('success_messages', 'success.messages.json', successMessages);
  add('success_init', 'success.init.json', findInit(successMessages));
  add('success_result', 'success.result.json', findResult(successMessages));
  add('success_account_info', 'success.account-info.json', info);
  // Cross-plan ruling R1 (controller): P6 Task 7 needs the exact prompt that produced the
  // recorded usage -- the same values runCommand used for prompt_bytes and estimated_tokens.
  const successDef = buildCase('success');
  add('success_prompt', 'success.prompt.json', { system_prompt: successDef.systemPrompt, user_message: successDef.userMessage });
  if (success.transcript !== null) {
    add('success_transcript', 'success.transcript.json', success.transcript.entries);
  }
  for (const name of ['auth-invalid', 'schema-unsatisfiable'] as const) {
    const record = load(name);
    if (record === null || statusOf(name) !== 'as_expected') {
      continue;
    }
    const messages = record.messages.map((m) => m.message);
    add(`${name}_messages`, `${name}.messages.json`, messages);
    const result = findResult(messages);
    if (result !== null) {
      add(`${name}_result`, `${name}.result.json`, result);
    }
    if (record.next_rejection !== null) {
      add(`${name}_rejection`, `${name}.rejection.json`, { rejection: record.next_rejection });
    }
  }
  const redactions = [...new Set(rules.map((r) => r.label))];
  outputs.set('manifest.json', redactDeep(buildManifest({ meta: report.meta, answers: report.answers, files, redactions }), rules));

  const texts = [...outputs.entries()].map(([file, value]) => [file, `${JSON.stringify(value, null, 2)}\n`] as const);
  const leaked = texts.flatMap(([file, text]) => leaks(text, rules).map((label) => `${file}: ${label}`));
  if (leaked.length > 0) {
    console.error(`refused: redaction left ${leaked.join(', ')}`);
    return 1;
  }
  mkdirSync(cli.dest, { recursive: true });
  for (const [file, text] of texts) {
    writeFileSync(join(cli.dest, file), text);
  }
  console.log(`[m1] promoted ${texts.length} files to ${cli.dest}`);
  return 0;
}

/**
 * Adds a run's web recordings to an existing fixture directory WITHOUT touching anything else in
 * it: the zero-tool recordings (and every test and later plan built on them) stay exactly as they
 * are. Keys are `success`-prefixed, because every non-success `_result` fixture is read as a
 * failure shape.
 * - `web-tools` writes `success-web.init.json` and `success-web.result.json` and sets the
 *   manifest's `web_init_tools` and `web_haiku_models`.
 * - `web-lan` writes `success-web-lan.messages.json` and sets `web_lan_outcomes`. Record it on a
 *   host that does not restrict the network, so the recording shows what a deny rule firing looks
 *   like on a real CLI.
 * Promotes every web case the run has. Refuses when it has neither, or when either one is not as
 * expected, and checks every file for residue of the redacted values before writing any of them.
 */
export function promoteWebCommand(cli: PromoteWebCli): number {
  const report = JSON.parse(readFileSync(join(cli.run, 'report.json'), 'utf8')) as RunReport;
  const present = WEB_CASES.filter((name) => report.verdicts.some((v) => v.case === name));
  if (present.length === 0) {
    console.error(`refused: the web-tools case is missing in ${cli.run}, and so is web-lan`);
    return 1;
  }
  for (const name of present) {
    const status = report.verdicts.find((v) => v.case === name)?.status;
    if (status !== 'as_expected') {
      console.error(`refused: the ${name} case is ${status} in ${cli.run}`);
      return 1;
    }
  }
  const manifestPath = join(cli.dest, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`refused: ${manifestPath} does not exist; promote-web adds to an existing fixture set`);
    return 1;
  }
  const records = new Map(present.map((name) => [name, JSON.parse(readFileSync(join(cli.run, 'cases', `${name}.json`), 'utf8')) as CaseRecord]));
  const probe = [...records.values()].flatMap((r) => [r.account_info_before_turn, r.account_info_after_turn]).find((p) => p?.ok === true);
  const info = probe?.ok === true ? probe.info : null;
  const rules = buildRedactionRules({
    home: homedir(),
    email: info?.email ?? null,
    organization: info?.organization ?? null,
    tempPaths: [...records.values()].map((r) => r.cwd),
  });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as M1FixtureManifest;
  const updated: M1FixtureManifest = { ...manifest, files: { ...manifest.files }, redactions: [...new Set([...manifest.redactions, ...rules.map((r) => r.label)])] };
  const texts: Array<readonly [string, string]> = [];
  const add = (logical: string, file: string, value: unknown): void => {
    texts.push([file, `${JSON.stringify(redactDeep(value, rules), null, 2)}\n`]);
    updated.files[logical] = file;
  };
  const tools = records.get('web-tools');
  if (tools !== undefined) {
    const messages = tools.messages.map((m) => m.message);
    add('success_web_init', 'success-web.init.json', findInit(messages));
    add('success_web_result', 'success-web.result.json', findResult(messages));
    updated.web_init_tools = report.answers.web?.init_tools ?? [];
    updated.web_haiku_models = report.answers.web?.haiku_models ?? [];
  }
  const lan = records.get('web-lan');
  if (lan !== undefined) {
    add('success_web_lan_messages', 'success-web-lan.messages.json', lan.messages.map((m) => m.message));
    updated.web_lan_outcomes = report.answers.web?.lan ?? [];
  }
  texts.push(['manifest.json', `${JSON.stringify(redactDeep(updated, rules), null, 2)}\n`]);
  const leaked = texts.flatMap(([file, text]) => leaks(text, rules).map((label) => `${file}: ${label}`));
  if (leaked.length > 0) {
    console.error(`refused: redaction left ${leaked.join(', ')}`);
    return 1;
  }
  for (const [file, text] of texts) {
    writeFileSync(join(cli.dest, file), text);
  }
  console.log(`[m1] promoted the ${present.join(' and ')} recording${present.length > 1 ? 's' : ''} (${texts.length} files) to ${cli.dest}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (err) {
    console.error(describeError(err));
    return 2;
  }
  try {
    switch (cli.command) {
      case 'promote':
        return promoteCommand(cli);
      case 'promote-web':
        return promoteWebCommand(cli);
      case 'reanalyze':
        return reanalyzeCommand(cli);
      case 'run':
        return await runCommand(cli);
    }
  } catch (err) {
    console.error(`refused: ${describeError(err)}`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // A CLI child that ignores close() must not keep a finished measurement alive.
      setTimeout(() => process.exit(code), 5_000).unref();
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 2;
    },
  );
}
