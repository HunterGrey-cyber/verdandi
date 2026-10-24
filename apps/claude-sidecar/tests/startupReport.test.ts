import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, openSync, readSync, writeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountRefusal } from '../src/accountRefusal.js';
import { resolveAccount } from '../src/legacyAccountName.js';
import { startSidecar } from '../src/lifecycle.js';
import {
  DIAGNOSTIC_CODES,
  NO_REPORT,
  REFUSAL_CODES,
  REPORT_FILE_VARIABLE,
  StartupRefusal,
  exitRefused,
  parseEnvVariable,
  refusalFor,
  startupReporterFromEnv,
  type ReportIo,
  type StartupReporter,
} from '../src/startupReport.js';
import { REPO_ROOT, SIDECAR_DIR } from './compat/paths.js';
import { spawnSidecar, stubCliScript, waitForBind, type SpawnOptions, type Spawned } from './compat/processHarness.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * The startup report (`VERDANDI_CLAUDE_SIDECAR_REPORT_FILE`), held at the one place a host sees it: the
 * real entry point, started the way a host starts it, with a stub standing in for `claude`. Each refusal
 * code is triggered by its real condition; each is run twice, once without the variable and once with it,
 * and the stderr of the two is the same -- the report adds a file and nothing else.
 */

const SENTINEL = 'SENTINEL-credential-9f2c41d7a0b8';
const BIND_REGRESSION_BUDGET_MS = 1_500;

type ReportRecord = { v: number; kind: string; code: string; message: string; details: { [key: string]: unknown } };

function parseRecords(text: string): ReportRecord[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ReportRecord);
}

/** A report path in a directory of its own, as a host would make one. */
function reportPath(): { dir: string; path: string; text(): string; records(): ReportRecord[] } {
  const dir = mkdtempSync(join(tmpdir(), 'v5r-'));
  const path = join(dir, 'report.jsonl');
  return {
    dir,
    path,
    text: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
    records: () => parseRecords(existsSync(path) ? readFileSync(path, 'utf8') : ''),
  };
}

/** Wait for the startup event itself; the frozen client harness's three-second bind
 * window measures cold-start performance, not readiness for report assertions. */
function waitForReady(sidecar: Spawned, report: ReturnType<typeof reportPath>): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      watcher.close();
      sidecar.child.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (report.text().split('\n').slice(0, -1).some((line) => JSON.parse(line).kind === 'ready')) finish();
    };
    const onClose = () => finish(new Error(`sidecar exited before ready: ${sidecar.stderr()}`));
    const watcher = watch(report.dir, check);
    watcher.on('error', finish);
    // A deadlock guard, shared with exit waits; readiness never depends on this timer firing.
    const timer = setTimeout(() => finish(new Error(`no ready report: ${sidecar.stderr()}`)), 30_000);
    sidecar.child.once('close', onClose);
    check(); // Subscribe before reading, so a write between setup and this read cannot be lost.
    if (sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) onClose();
  });
}

/** A process's stderr with the directories that differ run to run replaced, so two runs compare equal. */
function normalised(sidecar: Spawned, extra: string[] = []): string {
  let text = sidecar.stderr().split(sidecar.dir).join('<DIR>');
  for (const dir of extra) {
    text = text.split(dir).join('<REPORT-DIR>');
  }
  return text;
}

type Outcome = { code: number | null | 'running'; stderr: string; records: ReportRecord[]; sidecar: Spawned };

/** Runs a scenario to its exit, with the report file (when `withReport`) and without. */
async function runToExit(options: SpawnOptions, withReport: boolean): Promise<Outcome> {
  const report = reportPath();
  const sidecar = spawnSidecar({ ...options, env: { ...options.env, ...(withReport ? { [REPORT_FILE_VARIABLE]: report.path } : {}) } });
  const code = await sidecar.exited(30_000);
  const outcome = { code, stderr: normalised(sidecar, [report.dir]), records: report.records(), sidecar };
  sidecar.stop();
  rmSync(report.dir, { recursive: true, force: true });
  return outcome;
}

// ---- One refusal per code, from its real condition -------------------------------------------------------

type Scenario = {
  name: string;
  code: (typeof REFUSAL_CODES)[number];
  spawn: SpawnOptions;
  /** A subset of `details`. */
  details?: { [key: string]: unknown };
  /** What the record's message must match. It is a line the process printed word for word, unless `printed` says otherwise. */
  message: RegExp;
  /** For a refusal that embeds the CLI's own output: the record leaves it out, so what stderr shows is matched here instead. */
  printed?: RegExp;
};

const NO_HOME_SPAWN: SpawnOptions = { env: { VERDANDI_CLAUDE_ACCOUNT: 'scratch', HOME: undefined } };
const REAL_LOOKING_IDENTITY = JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.invalid' } });

const SCENARIOS: Scenario[] = [
  { name: 'no socket variable', code: 'SOCKET_ENV_MISSING', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: undefined } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_SOCKET' }, message: /^VERDANDI_CLAUDE_SIDECAR_SOCKET must be set$/ },
  {
    name: 'a socket variable that is set but empty',
    code: 'SOCKET_ENV_MISSING',
    spawn: { env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: '' } },
    details: { variable: 'VERDANDI_CLAUDE_SIDECAR_SOCKET' },
    // The printed text is grpc-js's, as it was before the code was named.
    message: /^No address added out of total 1 resolved errors/,
  },
  {
    name: 'a socket path longer than a unix address holds',
    code: 'SOCKET_PATH_TOO_LONG',
    spawn: { env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: `/tmp/${'a'.repeat(120)}.sock` } },
    details: { limit: process.platform === 'darwin' ? 103 : 107 },
    message: /^refusing to bind \/tmp\/a+\.sock: the path is \d+ bytes/,
  },
  { name: 'a live listener on the path (its own test below: it needs a second process)', code: 'SOCKET_IN_USE', spawn: {}, message: /^$/ },
  {
    name: 'a CLI path that does not exist',
    code: 'CLI_NOT_FOUND',
    spawn: { cliPath: '/nonexistent/v5-report/claude' },
    details: { cli_path: '/nonexistent/v5-report/claude', spawn_error_code: 'ENOENT' },
    message: /^could not determine the installed claude CLI version via "\/nonexistent\/v5-report\/claude" \(spawn error: /,
  },
  {
    name: 'a CLI that refuses to say its version',
    code: 'CLI_PROBE_FAILED',
    spawn: { stub: '#!/bin/sh\necho "launcher: refusing" >&2\nexit 64\n' },
    details: { exit_status: 64 },
    message: /^could not determine the installed claude CLI version via ".*" \(exit status 64; stderr: \[CLI output omitted: 18 bytes\]\)$/,
    printed: /\(exit status 64; stderr: launcher: refusing\)$/m,
  },
  {
    name: 'a CLI whose version is not a version',
    code: 'CLI_VERSION_UNPARSEABLE',
    spawn: { stub: '#!/bin/sh\necho "banana"\n' },
    details: { binaries: [{ binary: 'host', version: '[CLI output omitted: 6 bytes]', reason: 'unparseable' }] },
    message: /^refusing to start: host claude CLI version \[CLI output omitted: 6 bytes\]: could not parse the installed claude CLI version "\[CLI output omitted: 6 bytes\]"/,
    printed: /^refusing to start: host claude CLI version banana: could not parse the installed claude CLI version "banana"/m,
  },
  {
    name: 'a CLI below the supported range',
    code: 'CLI_OUT_OF_RANGE',
    spawn: { stub: stubCliScript('0.0.1') },
    details: { binaries: [{ binary: 'host', version: '0.0.1', reason: 'out_of_range' }] },
    message: /^refusing to start: host claude CLI version 0\.0\.1: .*is outside this sidecar's supported range/,
  },
  { name: 'an invalid egress mode', code: 'EGRESS_MODE_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_EGRESS: 'sometimes' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_EGRESS' }, message: /^VERDANDI_CLAUDE_SIDECAR_EGRESS: expected "open" or "restricted", got "sometimes"$/ },
  {
    name: 'restricted egress that loopback proves false',
    code: 'EGRESS_PROOF_FAILED',
    spawn: { env: { VERDANDI_CLAUDE_SIDECAR_EGRESS: 'restricted' } },
    details: { variable: 'VERDANDI_CLAUDE_SIDECAR_EGRESS' },
    message: /^VERDANDI_CLAUDE_SIDECAR_EGRESS=restricted, but this process reached a listener on 127\.0\.0\.1/,
  },
  { name: 'an account name that is not a path segment', code: 'ACCOUNT_INVALID_NAME', spawn: { env: { VERDANDI_CLAUDE_ACCOUNT: 'no/slashes' } }, details: { variable: 'VERDANDI_CLAUDE_ACCOUNT' }, message: /^claude account configuration is unusable: VERDANDI_CLAUDE_ACCOUNT must be a single path-safe segment/ },
  { name: 'a pinned account and no HOME', code: 'ACCOUNT_NO_HOME', spawn: NO_HOME_SPAWN, message: /^claude account configuration is unusable: VERDANDI_CLAUDE_ACCOUNT is set but HOME is not/ },
  {
    name: 'a relative configuration directory',
    code: 'ACCOUNT_RELATIVE_OVERRIDE',
    spawn: { env: { VERDANDI_CLAUDE_ACCOUNT: 'scratch', VERDANDI_CLAUDE_CONFIG_DIR: 'relative/dir' } },
    details: { variable: 'VERDANDI_CLAUDE_CONFIG_DIR' },
    message: /^claude account configuration is unusable: VERDANDI_CLAUDE_CONFIG_DIR must be an absolute path, got "relative\/dir"$/,
  },
  {
    name: 'the default location with another directory named',
    code: 'ACCOUNT_DEFAULT_CONFLICT',
    spawn: { env: { VERDANDI_CLAUDE_ACCOUNT: 'default', VERDANDI_CLAUDE_CONFIG_DIR: '/somewhere/else' } },
    details: { variable: 'VERDANDI_CLAUDE_CONFIG_DIR' },
    message: /^claude account configuration is unusable: VERDANDI_CLAUDE_ACCOUNT=default names the CLI's default location, but VERDANDI_CLAUDE_CONFIG_DIR="\/somewhere\/else" names another/,
  },
  { name: 'a pinned account whose directory does not exist', code: 'ACCOUNT_DIR_MISSING', spawn: { env: { VERDANDI_CLAUDE_ACCOUNT: 'ghost' } }, details: { account: 'ghost' }, message: /^claude account configuration is unusable: claude account "ghost" is pinned but its config directory .*\/\.claude-ghost does not exist/ },
  {
    name: 'a pinned account that holds no credentials',
    code: 'ACCOUNT_NOT_LOGGED_IN',
    spawn: { env: { VERDANDI_CLAUDE_ACCOUNT: 'scratch' }, prepare: ({ home }) => mkdirSync(join(home, '.claude-scratch')) },
    details: { account: 'scratch' },
    message: /^claude account configuration is unusable: claude account "scratch" is not logged in: .*\/\.claude-scratch\/\.credentials\.json is missing and ANTHROPIC_API_KEY is unset$/,
  },
  {
    name: 'the default location whose identity file is a symlink',
    code: 'ACCOUNT_DEFAULT_LOCATION_SYMLINK',
    spawn: {
      env: { VERDANDI_CLAUDE_ACCOUNT: 'default' },
      prepare: ({ home }) => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
        writeFileSync(join(home, 'elsewhere.json'), REAL_LOOKING_IDENTITY);
        symlinkSync(join(home, 'elsewhere.json'), join(home, '.claude.json'));
      },
    },
    details: { account: 'default' },
    message: /^claude account configuration is unusable: claude account "default" is at the CLI default location but .*\/\.claude\.json is a symlink; /,
  },
  {
    name: 'the default location whose identity file records no login',
    code: 'ACCOUNT_NO_RECORDED_IDENTITY',
    spawn: {
      env: { VERDANDI_CLAUDE_ACCOUNT: 'default' },
      prepare: ({ home }) => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
        writeFileSync(join(home, '.claude.json'), '{}');
      },
    },
    details: { account: 'default' },
    message: /^claude account configuration is unusable: claude account "default" is at the CLI default location but .*\/\.claude\.json records no oauthAccount\.emailAddress/,
  },
  { name: 'a ring capacity that is not a number', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY: 'lots' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY' }, message: /^VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY: expected a positive integer, got "lots"$/ },
  { name: 'a parent watch that is neither stdin nor none', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: 'always' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH' }, message: /^VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: expected "stdin" or "none", got "always"$/ },
  { name: 'a fault-injection count that is zero', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER: '0' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER' }, message: /^VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER: expected a positive integer, got "0"$/ },
  { name: 'a write-queue interval that is negative', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS: '-5' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS' }, message: /^VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS: expected a positive integer, got "-5"$/ },
  { name: 'a CLI gate that is neither refuse nor report', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'maybe' } }, details: { variable: 'VERDANDI_CLAUDE_SIDECAR_CLI_GATE' }, message: /^VERDANDI_CLAUDE_SIDECAR_CLI_GATE: expected "refuse" or "report", got "maybe"$/ },
  { name: 'extra MCP servers that are not JSON', code: 'ENV_INVALID', spawn: { env: { VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: '{remote' } }, details: { variable: 'VERDANDI_CLAUDE_EXTRA_MCP_SERVERS' }, message: /^VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: not valid JSON$/ },
  {
    name: 'an extra http MCP server whose header variable is unset',
    code: 'ENV_INVALID',
    spawn: { env: { VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: JSON.stringify({ remote: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers_from_env: { Authorization: 'VERDANDI_TEST_UNSET_MCP_AUTH' } } }) } },
    details: { variable: 'VERDANDI_CLAUDE_EXTRA_MCP_SERVERS' },
    message: /^VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: server "remote": header "Authorization" comes from VERDANDI_TEST_UNSET_MCP_AUTH, which is not set or empty in this process's environment$/,
  },
  {
    name: 'a valid extra MCP server next to one whose arg holds a NUL byte, which Node would refuse to spawn',
    code: 'ENV_INVALID',
    spawn: { env: { VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: JSON.stringify({ good: { command: '/bin/true' }, bad: { command: '/bin/true', args: ['a\u0000b'] } }) } },
    details: { variable: 'VERDANDI_CLAUDE_EXTRA_MCP_SERVERS' },
    message: /^VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: server "bad": args must not contain a NUL byte$/,
  },
  ...['a__x', 'a_'].map((name): Scenario => ({
    name: `an extra MCP server named ${name}, whose tools would read as another server's`,
    code: 'ENV_INVALID',
    spawn: { env: { VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: JSON.stringify({ a: { command: '/bin/true' }, [name]: { command: '/bin/true' } }) } },
    details: { variable: 'VERDANDI_CLAUDE_EXTRA_MCP_SERVERS' },
    message: new RegExp(`^VERDANDI_CLAUDE_EXTRA_MCP_SERVERS: server name "${name}" must match .*, must not contain "__" and must not end in "_"$`),
  })),
  {
    name: 'a socket directory that cannot be created',
    code: 'STARTUP_FAILED',
    spawn: { env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: '/dev/null/under-a-device/s.sock' } },
    details: { error_code: 'ENOTDIR' },
    message: /^ENOTDIR: not a directory, mkdir '\/dev\/null\/under-a-device'$/,
  },
];

/** Every record is one line of exactly the documented keys, and `message` is a line the process also printed. */
function assertRefusal(outcome: Outcome, scenario: Scenario): void {
  const refused = outcome.records.filter((record) => record.kind === 'refused');
  assert.equal(refused.length, 1, `exactly one refused record; records: ${JSON.stringify(outcome.records)}`);
  assert.equal(outcome.records.at(-1), refused[0], 'the refusal is the last line written');
  const record = refused[0];
  assert.deepEqual(Object.keys(record), ['v', 'kind', 'code', 'message', 'details']);
  assert.equal(record.v, 1);
  assert.equal(record.code, scenario.code);
  assert.match(record.message, scenario.message);
  assert.equal(record.details.pid, outcome.sidecar.child.pid, 'every record names the process');
  if (scenario.printed === undefined) {
    // The record's text is a line of the process's own stderr, word for word.
    const printed = outcome.sidecar.stderr().split('\n');
    assert.ok(printed.includes(record.message), `the message is not a stderr line:\n${record.message}\nstderr:\n${outcome.sidecar.stderr()}`);
  } else {
    assert.match(outcome.sidecar.stderr(), scenario.printed);
  }
  for (const [key, expected] of Object.entries(scenario.details ?? {})) {
    assert.deepEqual(record.details[key], expected, `details.${key}`);
  }
}

describe('startup report: every refusal code, from its real condition, with stderr unchanged', { concurrency: 6 }, () => {
  for (const scenario of SCENARIOS.filter((each) => each.code !== 'SOCKET_IN_USE')) {
    test(`${scenario.code}: ${scenario.name}`, async () => {
      const [without, withReport] = await Promise.all([runToExit(scenario.spawn, false), runToExit(scenario.spawn, true)]);
      assert.equal(without.code, 1);
      assert.equal(withReport.code, 1, `exit code with the report on; stderr:\n${withReport.stderr}`);
      assert.deepEqual(without.records, [], 'no variable, no file');
      assert.equal(withReport.stderr, without.stderr, 'the report changed what is printed');
      assertRefusal(withReport, scenario);
    });
  }

  test('SOCKET_IN_USE: a live listener on the socket path', async () => {
    const holderReport = reportPath();
    const holder = spawnSidecar({ env: { [REPORT_FILE_VARIABLE]: holderReport.path } });
    try {
      await waitForReady(holder, holderReport);
      assert.notEqual(await waitForBind(holder), undefined, holder.stderr());
      const report = reportPath();
      const second = spawnSidecar({ env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: holder.socketPath, [REPORT_FILE_VARIABLE]: report.path } });
      try {
        assert.equal(await second.exited(30_000), 1);
        const records = report.records();
        assert.equal(records.filter((each) => each.kind === 'refused').length, 1, JSON.stringify(records));
        const record = records.at(-1)!;
        assert.equal(record.kind, 'refused');
        assert.equal(record.code, 'SOCKET_IN_USE');
        assert.equal(record.message, `refusing to bind ${holder.socketPath}: another process is already listening on it`);
        assert.deepEqual(record.details, { socket: holder.socketPath, pid: second.child.pid });
        assert.ok(second.stderr().split('\n').includes(record.message));
        // The sidecar that was already there is untouched.
        assert.equal(holder.child.exitCode, null);
      } finally {
        second.stop();
        rmSync(report.dir, { recursive: true, force: true });
      }
    } finally {
      holder.stop();
      rmSync(holderReport.dir, { recursive: true, force: true });
    }
  });

  test('CLI_OUT_OF_RANGE: a CLI that is in range but untested, under strict checking, says strict_untested', async () => {
    const report = reportPath();
    const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999'), env: { VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: '1', [REPORT_FILE_VARIABLE]: report.path } });
    try {
      assert.equal(await sidecar.exited(30_000), 1);
      const record = report.records().at(-1)!;
      assert.equal(record.kind, 'refused');
      assert.equal(record.code, 'CLI_OUT_OF_RANGE');
      const host = (record.details.binaries as Array<{ binary: string; version: string; reason: string }>).find((entry) => entry.binary === 'host');
      assert.deepEqual(host, { binary: 'host', version: '2.1.999', reason: 'strict_untested' });
      assert.ok(sidecar.stderr().split('\n').includes(record.message));
    } finally {
      sidecar.stop();
      rmSync(report.dir, { recursive: true, force: true });
    }
  });

  test('the codes the scenarios cover are exactly the codes the module defines, and COMPATIBILITY.md lists exactly those', () => {
    const covered = new Set<string>([...SCENARIOS.map((scenario) => scenario.code)]);
    assert.deepEqual([...covered].sort(), [...REFUSAL_CODES].sort(), 'a refusal code has no scenario here, or a scenario names a code that does not exist');
    const compat = readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'COMPATIBILITY.md'), 'utf8');
    const start = compat.indexOf('## The startup report');
    assert.ok(start >= 0);
    const end = compat.indexOf('\n### ', start);
    const body = compat.slice(start, end);
    const documented = new Set([...body.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm)].map((match) => match[1]));
    assert.deepEqual([...documented].sort(), [...REFUSAL_CODES].sort(), 'COMPATIBILITY.md and the module disagree about the refusal codes');
    assert.deepEqual([...DIAGNOSTIC_CODES], ['CLI_UNTESTED', 'CLI_LEFT_TO_HOST']);
    for (const code of DIAGNOSTIC_CODES) {
      assert.ok(body.includes(`**\`diagnostic\`** \`${code}\``), `COMPATIBILITY.md does not document the diagnostic ${code}`);
    }
  });
});

// ---- Every variable that has a parser ---------------------------------------------------------------------

test('every VERDANDI_CLAUDE_SIDECAR_* variable the sources read is either refused by name when invalid, or stated to have no invalid value', () => {
  const read = new Set<string>();
  for (const file of readdirSync(join(SIDECAR_DIR, 'src')).filter((name) => name.endsWith('.ts'))) {
    for (const match of readFileSync(join(SIDECAR_DIR, 'src', file), 'utf8').matchAll(/\bVERDANDI_CLAUDE_SIDECAR_[A-Z_]+[A-Z]\b/g)) {
      read.add(match[0]);
    }
  }
  const refusedByName = new Set(
    SCENARIOS.filter((scenario) => scenario.code === 'ENV_INVALID' || scenario.code === 'EGRESS_MODE_INVALID')
      .map((scenario) => scenario.details?.variable as string)
      // VERDANDI_CLAUDE_EXTRA_MCP_SERVERS is the runtime package's (extraMcpServers.ts), not one of these.
      .filter((variable) => variable.startsWith('VERDANDI_CLAUDE_SIDECAR_')),
  );
  const exempt: { [variable: string]: string } = {
    VERDANDI_CLAUDE_SIDECAR_SOCKET: 'required, not parsed: its absence is SOCKET_ENV_MISSING',
    VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: 'anything but 1 or true is off: no invalid value (see the next test)',
    VERDANDI_CLAUDE_SIDECAR_REPORT_FILE: 'a path that cannot be written is one stderr line, never a refusal',
  };
  const unaccounted = [...read].filter((variable) => !refusedByName.has(variable) && !(variable in exempt));
  assert.deepEqual(unaccounted, [], 'a variable is read by the sidecar and neither refused by name when invalid nor exempted here');
  assert.ok(read.size >= 9, `found only ${read.size} variables: the pattern moved`);
  assert.deepEqual([...refusedByName].filter((variable) => !read.has(variable)), [], 'a scenario names a variable the sources do not read');
});

test('VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION has no invalid value: an unrecognised one is off and the sidecar starts', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({ env: { VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: 'perhaps', [REPORT_FILE_VARIABLE]: report.path } });
  try {
    await waitForReady(sidecar, report);
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    assert.deepEqual(report.records().filter((record) => record.kind === 'refused'), []);
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- ready, and the diagnostic -----------------------------------------------------------------------------

test('ready: written once the sidecar is up, with the socket, the pid, the version and the protocol; the file is 0600', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({ stub: stubCliScript('2.1.283'), env: { [REPORT_FILE_VARIABLE]: report.path } });
  try {
    await waitForReady(sidecar, report);
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const records = report.records();
    const ready = records.at(-1)!;
    assert.deepEqual(Object.keys(ready), ['v', 'kind', 'code', 'message', 'details']);
    assert.equal(ready.v, 1);
    assert.equal(ready.kind, 'ready');
    assert.equal(ready.code, 'READY');
    const capabilities = JSON.parse(readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json'), 'utf8')) as { protocol: { major: number; minor: number } };
    assert.deepEqual(Object.keys(ready.details).sort(), ['pid', 'protocol', 'sidecar_version', 'socket']);
    assert.deepEqual(ready.details, {
      socket: sidecar.socketPath,
      pid: sidecar.child.pid,
      sidecar_version: JSON.parse(readFileSync(join(SIDECAR_DIR, 'package.json'), 'utf8')).version,
      protocol: capabilities.protocol,
    });
    assert.equal(records.filter((record) => record.kind !== 'ready').length, 0, 'a tested CLI raises no diagnostic');
    assert.equal(statSync(report.path).mode & 0o777, 0o600);
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

test('CLI_UNTESTED: an in-range CLI that was never tested starts, says so in the file as in stderr, and then says ready', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999'), env: { [REPORT_FILE_VARIABLE]: report.path } });
  try {
    await waitForReady(sidecar, report);
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const records = report.records();
    assert.deepEqual(records.map((record) => `${record.kind}:${record.code}`), ['diagnostic:CLI_UNTESTED', 'ready:READY']);
    const [diagnostic] = records;
    assert.deepEqual(diagnostic.details, { binary: 'host', version: '2.1.999', pid: sidecar.child.pid });
    assert.match(diagnostic.message, /^claude-sidecar: host CLI version diagnostic: claude CLI version 2\.1\.999 is inside this sidecar's supported range/);
    await until(() => sidecar.stderr().split('\n').includes(diagnostic.message));
    assert.ok(sidecar.stderr().split('\n').includes(diagnostic.message), 'the message is the stderr line');
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

describe('ready is written only once a client can connect', () => {
  test('100 starts, each connected the moment its ready line is read: every connect succeeds', { timeout: 280_000 }, async () => {
    const failures: string[] = [];
    let next = 0;
    const one = async (): Promise<void> => {
      const report = reportPath();
      const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999', 'exit 0', 0), env: { [REPORT_FILE_VARIABLE]: report.path } });
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          // Read as fast as the file system allows: the connect below must follow the line as closely as a host's would.
          if (report.text().includes('"kind":"ready"')) {
            break;
          }
          if (Date.now() > deadline || sidecar.child.exitCode !== null) {
            failures.push(`never ready (exit ${String(sidecar.child.exitCode)}): ${sidecar.stderr().slice(0, 200)}`);
            return;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        const connected = await new Promise<string>((resolve) => {
          const socket = net.createConnection(sidecar.socketPath);
          socket.once('connect', () => {
            socket.destroy();
            resolve('ok');
          });
          socket.once('error', (error) => resolve((error as NodeJS.ErrnoException).code ?? error.message));
        });
        if (connected !== 'ok') {
          failures.push(`ready was visible but connecting gave ${connected}`);
        }
      } finally {
        sidecar.stop();
        rmSync(report.dir, { recursive: true, force: true });
      }
    };
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < 100) {
          next += 1;
          await one();
        }
      }),
    );
    assert.equal(next, 100);
    assert.deepEqual(failures, []);
  });

  test('in process: when ready is written the socket exists at 0600 and the stop signals are already handled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v5ready-'));
    const socketPath = join(dir, 's.sock');
    const seen: string[] = [];
    const before = process.listenerCount('SIGTERM');
    const report: StartupReporter = {
      enabled: true,
      ready: ({ socket }) => {
        seen.push(`socket:${socket === socketPath}`);
        seen.push(`exists:${existsSync(socketPath)}`);
        seen.push(`mode:${(statSync(socketPath).mode & 0o777).toString(8)}`);
        seen.push(`sigterm:${process.listenerCount('SIGTERM') > before}`);
      },
      refused: () => seen.push('refused'),
      diagnostic: () => seen.push('diagnostic'),
    };
    const sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => makeFakeSession().session,
      getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: '2.1.999' }),
      classifyCliVersion: () => ({ kind: 'untested', diagnostic: 'untested for this test' }),
      parentWatch: 'none',
      onDiagnostic: () => undefined,
      report,
    });
    try {
      // The diagnostic comes first and ready is last, once.
      assert.deepEqual(seen, ['diagnostic', 'diagnostic', 'socket:true', 'exists:true', 'mode:600', 'sigterm:true']);
    } finally {
      await sidecar.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- The reporter on its own --------------------------------------------------------------------------------

describe('the reporter never throws, and a path it cannot use costs one line', () => {
  const callAll = (reporter: StartupReporter): void => {
    reporter.diagnostic('CLI_UNTESTED', 'a');
    reporter.ready({ socket: '/s' });
    reporter.refused('STARTUP_FAILED', 'b');
  };

  test('unset or blank: nothing is touched and nothing is said', () => {
    const lines: string[] = [];
    for (const env of [{}, { [REPORT_FILE_VARIABLE]: '' }, { [REPORT_FILE_VARIABLE]: '   ' }]) {
      const reporter = startupReporterFromEnv(env, (line) => lines.push(line));
      assert.equal(reporter, NO_REPORT);
      assert.equal(reporter.enabled, false);
      callAll(reporter);
    }
    assert.deepEqual(lines, []);
  });

  const dir = mkdtempSync(join(tmpdir(), 'v5bad-'));
  mkdirSync(join(dir, 'a-directory'));
  symlinkSync(join(dir, 'target'), join(dir, 'a-link'));
  const BAD: Array<[string, string, RegExp]> = [
    ['a relative path', 'rel/report.jsonl', /must be an absolute path/],
    ['a missing directory', join(dir, 'missing', 'report.jsonl'), /ENOENT/],
    ['a directory', join(dir, 'a-directory'), /EISDIR/],
    ['a symlink', join(dir, 'a-link'), /ELOOP/],
  ];
  for (const [name, path, why] of BAD) {
    test(`${name}: one line, however many records are written, and no throw`, () => {
      const lines: string[] = [];
      const reporter = startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: path }, (line) => lines.push(line));
      assert.doesNotThrow(() => callAll(reporter));
      assert.doesNotThrow(() => callAll(reporter));
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.match(lines[0], /^claude-sidecar: cannot write the startup report to /);
      assert.match(lines[0], why);
      assert.ok(!existsSync(join(dir, 'target')), 'a link is never followed');
    });
  }

  test('a warn that itself throws is swallowed', () => {
    const reporter = startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: 'rel' }, () => {
      throw new Error('stderr is gone');
    });
    assert.doesNotThrow(() => callAll(reporter));
  });

  test('records append one per line, a file the host made wider is narrowed to 0600, and a new one is 0600 under any umask', () => {
    const target = mkdtempSync(join(tmpdir(), 'v5mode-'));
    try {
      const wide = join(target, 'wide.jsonl');
      writeFileSync(wide, '', { mode: 0o644 });
      chmodSync(wide, 0o644);
      const fresh = join(target, 'fresh.jsonl');
      const umask = process.umask(0);
      try {
        for (const path of [wide, fresh]) {
          const reporter = startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: path }, () => assert.fail('warned'));
          reporter.diagnostic('CLI_UNTESTED', 'one', { binary: 'host' });
          reporter.ready({ socket: '/s' });
          assert.equal(statSync(path).mode & 0o777, 0o600, path);
          assert.deepEqual(
            parseRecords(readFileSync(path, 'utf8')).map((record) => `${record.kind}/${record.code}`),
            ['diagnostic/CLI_UNTESTED', 'ready/READY'],
          );
        }
      } finally {
        process.umask(umask);
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('the values of the credential variables are masked in whatever is written', () => {
    const target = mkdtempSync(join(tmpdir(), 'v5mask-'));
    try {
      const path = join(target, 'r.jsonl');
      const reporter = startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: path, ANTHROPIC_API_KEY: SENTINEL, CLAUDE_CODE_OAUTH_TOKEN: 'a"b\\c-quoted-secret' }, () => assert.fail('warned'));
      reporter.refused('STARTUP_FAILED', `stderr: ${SENTINEL} and a"b\\c-quoted-secret`, { quote: SENTINEL });
      const text = readFileSync(path, 'utf8');
      assert.ok(!text.includes(SENTINEL));
      assert.ok(!text.includes('quoted-secret'));
      assert.match(text, /\[redacted\]/);
      // A short value is not a credential worth masking (an empty or one-letter variable would shred every message).
      const short = join(target, 's.jsonl');
      startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: short, ANTHROPIC_API_KEY: 'a' }, () => assert.fail('warned')).refused('STARTUP_FAILED', 'a banana');
      assert.match(readFileSync(short, 'utf8'), /a banana/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test('exitRefused prints the refusal text, records it, and exits 1; an error nobody classified is STARTUP_FAILED with its text', () => {
  const written: Array<[string, string, object | undefined]> = [];
  const reporter: StartupReporter = {
    enabled: true,
    ready: () => undefined,
    refused: (code, message, details) => written.push([code, message, details]),
    diagnostic: () => undefined,
  };
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => printed.push(args.join(' '));
  const exited: number[] = [];
  const exit = (code: number): never => {
    exited.push(code);
    throw new Error('exit');
  };
  try {
    assert.throws(() => exitRefused(reporter, new StartupRefusal('SOCKET_IN_USE', 'in use', { socket: '/s' }), exit), /exit/);
    assert.throws(() => exitRefused(reporter, new RangeError('odd'), exit), /exit/);
    assert.throws(() => exitRefused(reporter, 'a string was thrown', exit), /exit/);
  } finally {
    console.error = original;
  }
  assert.deepEqual(exited, [1, 1, 1]);
  assert.deepEqual(printed, ['in use', 'odd', 'a string was thrown']);
  assert.deepEqual(written, [
    ['SOCKET_IN_USE', 'in use', { socket: '/s' }],
    ['STARTUP_FAILED', 'odd', { error_name: 'RangeError' }],
    ['STARTUP_FAILED', 'a string was thrown', {}],
  ]);
  assert.equal(String(new StartupRefusal('ENV_INVALID', 'x')), 'Error: x', 'a refusal prints like the plain error it replaced');
  assert.equal(refusalFor(new StartupRefusal('ENV_INVALID', 'x')).code, 'ENV_INVALID');
});

test('parseEnvVariable names the variable, keeps the parser\'s own text, and passes a good value through', () => {
  assert.equal(parseEnvVariable('X', () => 7), 7);
  const refusal = (() => {
    try {
      parseEnvVariable('X_VARIABLE', () => {
        throw new Error('X_VARIABLE: expected a thing');
      });
    } catch (error) {
      return error as StartupRefusal;
    }
    return assert.fail('no refusal');
  })();
  assert.equal(refusal.code, 'ENV_INVALID');
  assert.equal(refusal.message, 'X_VARIABLE: expected a thing');
  assert.deepEqual(refusal.details, { variable: 'X_VARIABLE' });
});

// ---- The account codes, read off the real resolver's texts ----------------------------------------------------

describe('the ACCOUNT_* codes are read off the messages the resolvers really throw', () => {
  function home(setup: (home: string) => void): { env: NodeJS.ProcessEnv; done(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'v5acct-'));
    setup(dir);
    return { env: { HOME: dir }, done: () => rmSync(dir, { recursive: true, force: true }) };
  }
  /** `resolveAccount` is both halves: the name and directory rules, then the filesystem checks. */
  function codeOf(env: NodeJS.ProcessEnv): StartupRefusal {
    try {
      resolveAccount(env);
    } catch (error) {
      return accountRefusal(error);
    }
    return assert.fail('the account resolved');
  }

  test('each message of legacyAccountName.ts and account.ts that this module recognises', () => {
    const cases: Array<[NodeJS.ProcessEnv, (typeof REFUSAL_CODES)[number], string | undefined]> = [
      [{ HOME: '/h', VERDANDI_CLAUDE_ACCOUNT: 'bad name' }, 'ACCOUNT_INVALID_NAME', 'VERDANDI_CLAUDE_ACCOUNT'],
      [{ VERDANDI_CLAUDE_ACCOUNT: 'x' }, 'ACCOUNT_NO_HOME', undefined],
      [{ HOME: 'relative-home', VERDANDI_CLAUDE_ACCOUNT: 'x' }, 'ACCOUNT_NO_HOME', undefined],
      [{ VERDANDI_CLAUDE_ACCOUNT: 'default' }, 'ACCOUNT_NO_HOME', undefined],
      [{ HOME: '/h', VERDANDI_CLAUDE_ACCOUNT: 'x', VERDANDI_CLAUDE_CONFIG_DIR: 'rel' }, 'ACCOUNT_RELATIVE_OVERRIDE', 'VERDANDI_CLAUDE_CONFIG_DIR'],
      [{ HOME: '/h', VERDANDI_CLAUDE_ACCOUNT: 'x', VERDANDI_CLAUDE_CONFIG_DIR: '/abs', VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: 'rel' }, 'ACCOUNT_RELATIVE_OVERRIDE', 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR'],
      [{ HOME: '/h', VERDANDI_CLAUDE_ACCOUNT: 'default', VERDANDI_CLAUDE_CONFIG_DIR: '/abs' }, 'ACCOUNT_DEFAULT_CONFLICT', 'VERDANDI_CLAUDE_CONFIG_DIR'],
      [{ HOME: '/h', VERDANDI_CLAUDE_ACCOUNT: 'default', VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR: '/abs' }, 'ACCOUNT_DEFAULT_CONFLICT', 'VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR'],
    ];
    for (const [env, code, variable] of cases) {
      const refusal = codeOf(env);
      assert.equal(refusal.code, code, refusal.message);
      assert.equal(refusal.details.variable, variable, refusal.message);
      assert.ok(refusal.message.startsWith('claude account configuration is unusable: '));
    }
  });

  test('the usability checks: missing directory, not logged in, a symlink, and the three ways an identity is missing', () => {
    const cases: Array<[(home: string) => void, string, (typeof REFUSAL_CODES)[number]]> = [
      [() => undefined, 'x', 'ACCOUNT_DIR_MISSING'],
      [(h) => mkdirSync(join(h, '.claude-x')), 'x', 'ACCOUNT_NOT_LOGGED_IN'],
      [
        (h) => {
          mkdirSync(join(h, '.claude'));
          writeFileSync(join(h, '.claude', '.credentials.json'), '{}');
        },
        'default',
        'ACCOUNT_NO_RECORDED_IDENTITY', // $HOME/.claude.json is missing
      ],
      [
        (h) => {
          mkdirSync(join(h, '.claude'));
          writeFileSync(join(h, '.claude', '.credentials.json'), '{}');
          writeFileSync(join(h, '.claude.json'), 'not json');
        },
        'default',
        'ACCOUNT_NO_RECORDED_IDENTITY', // present but not readable JSON
      ],
      [
        (h) => {
          mkdirSync(join(h, '.claude'));
          writeFileSync(join(h, '.claude', '.credentials.json'), '{}');
          writeFileSync(join(h, '.claude.json'), '{"oauthAccount":{}}');
        },
        'default',
        'ACCOUNT_NO_RECORDED_IDENTITY', // no email recorded
      ],
      [
        (h) => {
          mkdirSync(join(h, 'real'));
          writeFileSync(join(h, 'real', '.credentials.json'), '{}');
          symlinkSync(join(h, 'real'), join(h, '.claude'));
          writeFileSync(join(h, '.claude.json'), REAL_LOOKING_IDENTITY);
        },
        'default',
        'ACCOUNT_DEFAULT_LOCATION_SYMLINK', // the directory itself
      ],
    ];
    for (const [setup, name, code] of cases) {
      const fixture = home(setup);
      try {
        const refusal = codeOf({ ...fixture.env, VERDANDI_CLAUDE_ACCOUNT: name });
        assert.equal(refusal.code, code, refusal.message);
        assert.equal(refusal.details.account, name);
      } finally {
        fixture.done();
      }
    }
  });

  test('an identity file that is not JSON: stderr keeps the parser\'s words, the record leaves out what they quote of the file', () => {
    // Short enough to sit inside the parser's excerpt: all of a short file, a few characters either side of the fault in a long one.
    const quotedSecret = 'TOK9';
    for (const contents of [`{"x": ${quotedSecret}}`, `{"oauthAccount": {"emailAddress": "someone@example.invalid"}, "pad": "${'y'.repeat(200)}", "k": ${quotedSecret}}`]) {
      const fixture = home((h) => {
        mkdirSync(join(h, '.claude'));
        writeFileSync(join(h, '.claude', '.credentials.json'), '{}');
        writeFileSync(join(h, '.claude.json'), contents);
      });
      try {
        const refusal = codeOf({ ...fixture.env, VERDANDI_CLAUDE_ACCOUNT: 'default' });
        assert.equal(refusal.code, 'ACCOUNT_NO_RECORDED_IDENTITY', refusal.message);
        assert.ok(refusal.message.includes(quotedSecret), `stderr is meant to keep the parser's text: ${refusal.message}`);
        assert.ok(!refusal.recordMessage.includes(quotedSecret), `the record quotes the file: ${refusal.recordMessage}`);
        assert.match(refusal.recordMessage, /^claude account configuration is unusable: claude account "default": .*\/\.claude\.json is not readable JSON \(SyntaxError; the parser's text quotes the file, so it is left out\)$/);
      } finally {
        fixture.done();
      }
    }
  });

  test('a message no row recognises stays STARTUP_FAILED with the same text, so a reworded message is loud', () => {
    const refusal = accountRefusal(new Error('an account at an explicit directory needs its Anthropic config directory too ("/x" given alone)'));
    assert.equal(refusal.code, 'STARTUP_FAILED');
    assert.equal(refusal.message, 'claude account configuration is unusable: an account at an explicit directory needs its Anthropic config directory too ("/x" given alone)');
    assert.equal(accountRefusal(new Error('an account label must be a non-empty single line, got " "')).code, 'ACCOUNT_INVALID_NAME');
  });
});

// ---- No credential reaches the file -----------------------------------------------------------------------------

test('no credential reaches the report: an account with a stored login and credential variables set starts, and the file holds none of them', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({
    stub: stubCliScript('2.1.999'),
    env: {
      VERDANDI_CLAUDE_ACCOUNT: 'scratch',
      ANTHROPIC_API_KEY: `${SENTINEL}-api`,
      ANTHROPIC_AUTH_TOKEN: `${SENTINEL}-auth`,
      CLAUDE_CODE_OAUTH_TOKEN: `${SENTINEL}-oauth`,
      [REPORT_FILE_VARIABLE]: report.path,
    },
    prepare: ({ home }) => {
      mkdirSync(join(home, '.claude-scratch'));
      writeFileSync(join(home, '.claude-scratch', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${SENTINEL}-stored`, refreshToken: `${SENTINEL}-refresh` } }));
    },
  });
  try {
    await waitForReady(sidecar, report);
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const text = report.text();
    assert.ok(text.length > 0);
    assert.ok(!text.includes(SENTINEL), 'a credential reached the report file');
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

test('no credential reaches the report: a CLI that echoes the key in its refusal is on stderr as before and masked in the file', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({
    stub: '#!/bin/sh\necho "launcher: bad key $ANTHROPIC_API_KEY" >&2\nexit 64\n',
    env: { ANTHROPIC_API_KEY: `${SENTINEL}-echoed`, [REPORT_FILE_VARIABLE]: report.path },
  });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    assert.ok(sidecar.stderr().includes(`${SENTINEL}-echoed`), 'stderr keeps the text it always had');
    const text = report.text();
    assert.ok(!text.includes(SENTINEL), 'the key reached the report file');
    const record = report.records().at(-1)!;
    assert.equal(record.code, 'CLI_PROBE_FAILED');
    assert.match(record.message, /\(exit status 64; stderr: \[CLI output omitted: \d+ bytes\]\)$/);
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

// ---- An unwritable path changes nothing but one line ---------------------------------------------------------------

describe('an unwritable report path changes neither the exit code nor stderr beyond one line', () => {
  for (const [name, path] of [
    ['a missing directory', '/nonexistent-v5-dir/report.jsonl'],
    ['a relative path', 'relative-report.jsonl'],
    ['a directory', '/tmp'],
  ] as const) {
    test(`${name}, on a refusal`, async () => {
      const spawn: SpawnOptions = { stub: stubCliScript('0.0.1') };
      const [plain, broken] = await Promise.all([
        runToExit(spawn, false),
        (async () => {
          const sidecar = spawnSidecar({ ...spawn, env: { [REPORT_FILE_VARIABLE]: path } });
          const code = await sidecar.exited(30_000);
          const stderr = normalised(sidecar);
          sidecar.stop();
          return { code, stderr };
        })(),
      ]);
      assert.equal(broken.code, plain.code);
      const lines = broken.stderr.split('\n');
      const extra = lines.filter((line) => line.startsWith('claude-sidecar: cannot write the startup report to '));
      assert.equal(extra.length, 1, broken.stderr);
      assert.equal(lines.filter((line) => !line.startsWith('claude-sidecar: cannot write the startup report to ')).join('\n'), plain.stderr);
    });

    test(`${name}, on a start that goes on to bind and serve`, async () => {
      const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999'), env: { [REPORT_FILE_VARIABLE]: path } });
      try {
        assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
        await until(() => sidecar.stderr().includes('cannot write the startup report'));
        assert.equal(sidecar.stderr().split('\n').filter((line) => line.includes('cannot write the startup report')).length, 1);
        assert.equal(sidecar.child.exitCode, null, 'still running');
      } finally {
        sidecar.stop();
      }
    });
  }
});

// ---- Cost on the way to bind --------------------------------------------------------------------------------------

test('with the report file set the sidecar still binds inside the regression budget (best of three cold starts)', async () => {
  const seen: string[] = [];
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= BIND_REGRESSION_BUDGET_MS; attempt += 1) {
    const report = reportPath();
    const sidecar = spawnSidecar({ env: { [REPORT_FILE_VARIABLE]: report.path } });
    try {
      const bound = await waitForBind(sidecar);
      seen.push(bound === undefined ? `never bound (exit ${String(sidecar.child.exitCode)})` : `${bound} ms`);
      if (bound !== undefined) {
        best = Math.min(best, bound);
      }
    } finally {
      sidecar.stop();
      rmSync(report.dir, { recursive: true, force: true });
    }
  }
  assert.ok(best < BIND_REGRESSION_BUDGET_MS, `bound in: ${seen.join('; ')}; the budget is ${BIND_REGRESSION_BUDGET_MS} ms. Writing the report added work before bind.`);
});

// ---- No way out that skips the reporter -------------------------------------------------------------------------------

/** Source with its comments removed, so a sentence that mentions `process.exit()` is not read as a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('nothing before bind exits the process on its own: the only process.exit calls are --version, the shutdown triggers and the reporter\'s', () => {
  const index = code(readFileSync(join(SIDECAR_DIR, 'src', 'index.ts'), 'utf8'));
  const lifecycle = code(readFileSync(join(SIDECAR_DIR, 'src', 'lifecycle.ts'), 'utf8'));
  const report = code(readFileSync(join(SIDECAR_DIR, 'src', 'startupReport.ts'), 'utf8'));
  assert.deepEqual(
    [...index.matchAll(/process\.exit\(([^)]*)\)/g)].map((match) => match[1]),
    ['0'],
    'index.ts exits only for --version; every refusal goes through exitRefused',
  );
  assert.deepEqual(
    [...lifecycle.matchAll(/process\.exit\(([^)]*)\)/g)].map((match) => match[1]),
    ['code'],
    'lifecycle.ts exits only from the shutdown triggers',
  );
  assert.ok(index.includes('main().catch((error: unknown) => exitRefused(report, error));'), 'the entry point must end in exitRefused');
  assert.deepEqual([...report.matchAll(/process\.exit\(([^)]*)\)/g)].map((match) => match[1]), ['code']);
  assert.ok(!/console\.error\([^;]*\);\s*process\.exit/.test(index), 'a print-and-exit pair in index.ts is a refusal the report would miss');
});

// ---- The CLI's own output never reaches the file -----------------------------------------------------------------

const BEARER = 'SENTINEL-bearer-4d81c0e97b52';

test('the CLI\'s own output is on stderr as before and never in the file: a launcher that prints a credential on failure', async () => {
  const report = reportPath();
  const sidecar = spawnSidecar({
    stub: `#!/bin/sh\necho "Authorization: Bearer ${BEARER}" >&2\nexit 64\n`,
    env: { [REPORT_FILE_VARIABLE]: report.path },
  });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    assert.ok(sidecar.stderr().includes(BEARER), 'stderr keeps the text it always had');
    assert.ok(!report.text().includes(BEARER), 'the credential reached the report file');
    const record = report.records().at(-1)!;
    assert.equal(record.code, 'CLI_PROBE_FAILED');
    assert.match(record.message, new RegExp(`stderr: \\[CLI output omitted: ${Buffer.byteLength(`Authorization: Bearer ${BEARER}`)} bytes\\]\\)$`));
    assert.equal(record.details.exit_status, 64);
  } finally {
    sidecar.stop();
    rmSync(report.dir, { recursive: true, force: true });
  }
});

test('the CLI\'s own output is never in the file: the version word it prints is recorded as its numbers, or as a marker', async () => {
  // Unreadable: a refusal, and the word is replaced whole.
  const refusing = reportPath();
  const garbage = spawnSidecar({ stub: `#!/bin/sh\necho "${BEARER}"\n`, env: { [REPORT_FILE_VARIABLE]: refusing.path } });
  // Readable with a tail: starts (untested), and only the leading numbers are recorded.
  const starting = reportPath();
  const tail = spawnSidecar({ stub: `#!/bin/sh\necho "2.1.999${BEARER} (Claude Code)"\n`, env: { [REPORT_FILE_VARIABLE]: starting.path } });
  try {
    assert.equal(await garbage.exited(30_000), 1);
    assert.ok(garbage.stderr().includes(BEARER), 'stderr keeps the text it always had');
    assert.ok(!refusing.text().includes(BEARER), 'the version word reached the file in a refusal');
    assert.equal(refusing.records().at(-1)!.code, 'CLI_VERSION_UNPARSEABLE');

    assert.notEqual(await waitForBind(tail), undefined, tail.stderr());
    await until(() => starting.records().some((record) => record.kind === 'ready'));
    assert.ok(tail.stderr().includes(BEARER), 'stderr keeps the text it always had');
    assert.ok(!starting.text().includes(BEARER), 'the version word reached the file in a diagnostic');
    const diagnostic = starting.records().find((record) => record.kind === 'diagnostic')!;
    assert.equal(diagnostic.details.version, '2.1.999');
    assert.match(diagnostic.message, /claude CLI version 2\.1\.999 is inside/);
  } finally {
    garbage.stop();
    tail.stop();
    rmSync(refusing.dir, { recursive: true, force: true });
    rmSync(starting.dir, { recursive: true, force: true });
  }
});

// ---- What the file may be, and what a failed write does ---------------------------------------------------------------

describe('the file is a regular file, written whole, and a failure to write costs one line', () => {
  const warned = (): { lines: string[]; warn: (line: string) => void } => {
    const lines: string[] = [];
    return { lines, warn: (line) => lines.push(line) };
  };

  test('a FIFO nobody reads cannot hang startup: the process binds inside the budget and says so once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v5fifo-'));
    const fifo = join(dir, 'report.fifo');
    execFileSync('mkfifo', [fifo]);
    const sidecar = spawnSidecar({ env: { [REPORT_FILE_VARIABLE]: fifo } });
    try {
      const bound = await waitForBind(sidecar, 100);
      assert.notEqual(bound, undefined, `never bound; stderr:\n${sidecar.stderr()}`);
      assert.ok(bound! < 3_000, `bound in ${bound} ms`);
      assert.equal(sidecar.stderr().split('\n').filter((line) => line.includes('cannot write the startup report')).length, 1);
    } finally {
      sidecar.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FIFO that has a reader is refused too: nothing is written into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v5fifo-'));
    const fifo = join(dir, 'report.fifo');
    execFileSync('mkfifo', [fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const { lines, warn } = warned();
      const reporter = startupReporterFromEnv({ [REPORT_FILE_VARIABLE]: fifo }, warn);
      reporter.ready({ socket: '/s' });
      reporter.refused('STARTUP_FAILED', 'x');
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.match(lines[0], /not a regular file/);
      // No writer holds it open any more, so an empty FIFO reads as end-of-file (0 bytes); EAGAIN would
      // mean a writer is still attached. Either way, not one byte was written into it.
      let read = 0;
      try {
        read = readSync(reader, Buffer.alloc(16));
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'EAGAIN');
      }
      assert.equal(read, 0, 'the FIFO held data');
    } finally {
      closeSync(reader);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const fresh = (): { dir: string; path: string; env: NodeJS.ProcessEnv } => {
    const dir = mkdtempSync(join(tmpdir(), 'v5io-'));
    const path = join(dir, 'r.jsonl');
    return { dir, path, env: { [REPORT_FILE_VARIABLE]: path } };
  };

  test('a short write is a failure: one warning, the report is off from then on', () => {
    const { dir, path, env } = fresh();
    try {
      const { lines, warn } = warned();
      let calls = 0;
      const io: ReportIo = { write: (_fd, line) => (calls += 1, line.length - 1), fchmod: () => undefined };
      const reporter = startupReporterFromEnv(env, warn, io);
      reporter.diagnostic('CLI_UNTESTED', 'a');
      reporter.ready({ socket: '/s' });
      reporter.refused('STARTUP_FAILED', 'b');
      assert.equal(calls, 1, 'no second attempt after the first failure');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /short write/);
      void path;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a write that throws is the same: one line, no throw', () => {
    const { dir, env } = fresh();
    try {
      const { lines, warn } = warned();
      const io: ReportIo = {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        fchmod: () => undefined,
      };
      const reporter = startupReporterFromEnv(env, warn, io);
      assert.doesNotThrow(() => reporter.ready({ socket: '/s' }));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /ENOSPC/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a chmod that is refused does not lose the record', () => {
    const { dir, path, env } = fresh();
    try {
      const { lines, warn } = warned();
      const io: ReportIo = {
        write: (fd, line) => require_write(fd, line),
        fchmod: () => {
          throw new Error('EPERM');
        },
      };
      const reporter = startupReporterFromEnv(env, warn, io);
      reporter.refused('STARTUP_FAILED', 'kept');
      assert.deepEqual(lines, []);
      assert.equal(parseRecords(readFileSync(path, 'utf8'))[0].message, 'kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a message is capped at 8 KiB with a marker, and the record is still one valid line', () => {
    const { dir, path, env } = fresh();
    try {
      startupReporterFromEnv(env, () => assert.fail('warned')).refused('STARTUP_FAILED', 'x'.repeat(20_000));
      const text = readFileSync(path, 'utf8');
      assert.equal(text.split('\n').length, 2);
      const [record] = parseRecords(text);
      assert.ok(record.message.length < 8 * 1024 + 100, `${record.message.length}`);
      assert.match(record.message, /\[truncated: 11808 more bytes\]$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('masking is applied to values, not to the line: a credential equal to a key name, or holding a quote, leaves the record intact', () => {
    const { dir, path, env } = fresh();
    try {
      // `protocol` is a key of the ready record and `details` of every one; the quote is JSON's own syntax.
      for (const secret of ['protocol', 'details!!', 'qu"ote-secret', 'back\\slash-secret']) {
        const reporter = startupReporterFromEnv({ ...env, ANTHROPIC_API_KEY: secret }, () => assert.fail('warned'));
        reporter.ready({ socket: '/s' });
        reporter.refused('STARTUP_FAILED', `the key was ${secret} here`, { note: secret });
      }
      const records = parseRecords(readFileSync(path, 'utf8'));
      assert.equal(records.length, 8, 'every line still parses');
      for (const [at, record] of records.entries()) {
        assert.deepEqual(Object.keys(record), ['v', 'kind', 'code', 'message', 'details'], `record ${at}`);
        if (record.kind === 'ready') {
          assert.deepEqual(Object.keys(record.details).sort(), ['pid', 'protocol', 'sidecar_version', 'socket']);
          assert.equal(typeof record.details.protocol, 'object', 'the key `protocol` is not touched');
        } else {
          assert.match(record.message, /^the key was \[redacted\] here$/);
          assert.equal(record.details.note, '[redacted]');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a credential quoted as JSON inside a message is masked too, and masking happens before the 8 KiB cap', () => {
    const { dir, path, env } = fresh();
    try {
      const secret = 'qu"ote-secret-value';
      const reporter = startupReporterFromEnv({ ...env, ANTHROPIC_API_KEY: secret }, () => assert.fail('warned'));
      // A parser that names the bad value with JSON.stringify puts the escaped spelling in its sentence.
      reporter.refused('ENV_INVALID', `bad value ${JSON.stringify(secret)}`, { variable: 'X' });
      // A credential straddling the cap must not leave its prefix behind.
      const long = 'credential-' + 'S'.repeat(40);
      const second = startupReporterFromEnv({ ...env, ANTHROPIC_AUTH_TOKEN: long }, () => assert.fail('warned'));
      second.refused('STARTUP_FAILED', 'p'.repeat(8 * 1024 - 20) + long + ' tail');
      const records = parseRecords(readFileSync(path, 'utf8'));
      assert.equal(records.length, 2);
      assert.equal(records[0].message, 'bad value "[redacted]"');
      assert.ok(!records[1].message.includes('credential-'), 'no prefix of the credential survives the cap');
      assert.match(records[1].message, /\[redacted\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every record names the process, the ones the sidecar writes itself included', () => {
    const { dir, path, env } = fresh();
    try {
      const reporter = startupReporterFromEnv(env, () => assert.fail('warned'));
      reporter.diagnostic('CLI_UNTESTED', 'a');
      reporter.ready({ socket: '/s' });
      reporter.refused('STARTUP_FAILED', 'b');
      assert.deepEqual(
        parseRecords(readFileSync(path, 'utf8')).map((record) => record.details.pid),
        [process.pid, process.pid, process.pid],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The real write, for a test that stubs only the chmod. */
function require_write(fd: number, line: Buffer): number {
  return writeSync(fd, line);
}
