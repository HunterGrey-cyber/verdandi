import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { accountEnv, resolveAccount, resolveAccountSpec } from '@verdandi/claude-runtime';
import * as old from './b3aa188/generated/runtime.js';
import { HOST_CLI_PATH, withHarness } from './harness.js';
import { SIDECAR_DIR } from './paths.js';
import { alive, spawnSidecar, startCliSession, stubCliScript, waitForBind } from './processHarness.js';
import { versionReport } from '../../src/versionReport.js';

/**
 * (c) Text and timing freezes: what only the real process shows. Every stderr text below is produced
 * by its real code path -- the real entry point (dist/src/index.js) started the way Eitri starts it,
 * with a stub `claude` that answers `--version` and nothing else -- and is checked twice: against
 * Eitri's own matcher (copied from its source, with the file named), and against the full current
 * wording, because Eitri matches these texts and a reworded one fails silently on its side.
 *
 * What is held: the environment variables, binding within Eitri's 3 s connect window, exiting within its
 * 6 s grace after stdin closes, removing a stale socket, the stdin parent watch, the four stderr texts,
 * the arguments the real CLI is started with, and `--version`'s first and fourth lines.
 */

// ---- Eitri's matchers, copied --------------------------------------------------------------------------

/** agent/src/providers/claude_sidecar/mod.rs, `startup_diagnostics_from_stderr`: `line.contains(...)`. */
const EITRI_DIAGNOSTIC_MARKER = 'CLI version diagnostic';
/** agent-ui/web/src/problems.ts `CLI_OUT_OF_RANGE_RE`. */
const EITRI_CLI_OUT_OF_RANGE = /refusing to start: host claude CLI version ([^:]+): .*?is outside this sidecar's supported range \(>=(\S+) <([^)]+)\)/s;
/** agent-ui/web/src/problems.ts `CLI_MISSING_MARKER`. */
const EITRI_CLI_MISSING_MARKER = 'could not determine the installed claude CLI version';
/** agent-ui/web/src/problems.ts `SIDECAR_NOT_LOGGED_IN_RE`. */
const EITRI_NOT_LOGGED_IN = /claude account "([^"]+)" is not logged in: (.+?)\/\.credentials\.json is missing/;

/** Eitri's bind window (spawn.rs: 60 attempts x 50 ms) and its exit grace (`SIDECAR_EXIT_GRACE`). */
const EITRI_BIND_BUDGET_MS = 3_000;
const EITRI_EXIT_GRACE_MS = 6_000;
/** How many of the sidecar's latest stderr lines Eitri retains (`STDERR_TAIL_CAPACITY` in its spawn.rs). */
const EITRI_STDERR_TAIL_LINES = 40;
/**
 * Our own, tighter budget for the same wait: the contract above is Eitri's, this one is how much of it
 * we are willing to spend. Measured on this machine (2026-10-02, six cold starts with a stub CLI that
 * takes 0.5 s to answer `--version`, as a real one does): 708-710 ms, of which 500 ms is the stub's sleep
 * and about 200 ms is node's own start. 1.5 s is twice that. A startup step that adds more than about
 * 0.8 s fails here while Eitri's window is still open, so it is noticed before it becomes a timeout.
 */
const BIND_REGRESSION_BUDGET_MS = 1_500;

// ---- The four stderr texts -----------------------------------------------------------------------

test('stderr text: an in-range CLI that was never tested starts, with exactly one "CLI version diagnostic" line, worded as it was', async () => {
  const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999') });
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, `never bound; stderr:\n${sidecar.stderr()}`);
    const lines = sidecar.stderr().split('\n');
    // Eitri keeps only the last 40 stderr lines (`STDERR_TAIL_CAPACITY`) and looks for the marker in those, so
    // by the time the socket is bound the line must still be among the last 40 -- a flood of startup output after it would hide it.
    const kept = lines.slice(0, -1).slice(-EITRI_STDERR_TAIL_LINES);
    assert.ok(
      kept.some((line) => line.includes(EITRI_DIAGNOSTIC_MARKER)),
      `the diagnostic is not within the last ${EITRI_STDERR_TAIL_LINES} stderr lines at bind time (${lines.length - 1} lines in all):\n${sidecar.stderr()}`,
    );
    const diagnostics = lines.filter((line) => line.includes(EITRI_DIAGNOSTIC_MARKER));
    assert.equal(diagnostics.length, 1, `Eitri shows every line containing the marker; there must be exactly this one:\n${sidecar.stderr()}`);
    assert.match(
      diagnostics[0],
      /^claude-sidecar: host CLI version diagnostic: claude CLI version 2\.1\.999 is inside this sidecar's supported range \(>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+\) but has not been tested against it \(tested: [^)]*\)\. Starting anyway\. If you hit protocol, permission, or event-translation failures, this version skew is the first thing to check\.$/,
    );
  } finally {
    sidecar.stop();
  }
});

test('stderr text: a CLI outside the range refuses to start before binding, with the sentence Eitri parses, byte for byte', async () => {
  const sidecar = spawnSidecar({ stub: stubCliScript('0.0.1') });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    assert.equal(existsSync(sidecar.socketPath), false, 'refused BEFORE the socket was bound');
    const stderr = sidecar.stderr();
    const matched = EITRI_CLI_OUT_OF_RANGE.exec(stderr);
    assert.ok(matched !== null, `Eitri's matcher does not match:\n${stderr}`);
    const [, version, floor, ceiling] = matched;
    assert.equal(version, '0.0.1');
    assert.match(floor, /^\d+\.\d+\.\d+$/);
    assert.match(ceiling, /^\d+\.\d+\.\d+$/);
    // The full line, as Eitri's own fixture (agent-ui/web/src/fixtures/problems/cli-out-of-range.txt) captured it.
    assert.ok(
      stderr.split('\n').includes(
        `refusing to start: host claude CLI version 0.0.1: claude CLI version 0.0.1 is outside this sidecar's supported range (>=${floor} <${ceiling}). Install a claude CLI inside that range, or widen the range in apps/claude-sidecar/src/cliCompatibility.ts once a real-CLI test run has confirmed it works.`,
      ),
      `the refusal sentence changed:\n${stderr}`,
    );
  } finally {
    sidecar.stop();
  }
});

test('stderr text: a CLI whose version cannot be read refuses to start with "could not determine the installed claude CLI version via ...", naming the path and the cause', async () => {
  // A path that does not exist (Eitri's own fixture cli-missing.txt): spawnSync fails outright.
  const missing = spawnSidecar({ cliPath: '/nonexistent/v1-compat/claude' });
  // A launcher that refuses, as a guarded `claude` on a multi-account host does.
  const refusing = spawnSidecar({ stub: '#!/bin/sh\necho "claude-launcher: refusing to start outside an approved session" >&2\nexit 64\n' });
  try {
    for (const [sidecar, cause] of [
      [missing, /\(spawn error: spawnSync \/nonexistent\/v1-compat\/claude ENOENT\)$/],
      [refusing, /\(exit status 64; stderr: claude-launcher: refusing to start outside an approved session\)$/],
    ] as const) {
      assert.equal(await sidecar.exited(30_000), 1);
      assert.equal(existsSync(sidecar.socketPath), false);
      const line = sidecar.stderr().split('\n').find((each) => each.includes(EITRI_CLI_MISSING_MARKER));
      assert.ok(line !== undefined, `Eitri's marker is missing:\n${sidecar.stderr()}`);
      assert.match(line, /^could not determine the installed claude CLI version via "[^"]+" \(/);
      assert.match(line, cause);
    }
  } finally {
    missing.stop();
    refusing.stop();
  }
});

test('stderr text: a pinned account that is not logged in refuses to start naming the account and its credentials file', async () => {
  // The account's directory exists but holds no credentials, and no API key is set (spawnSidecar scrubs it).
  const sidecar = spawnSidecar({
    env: { VERDANDI_CLAUDE_ACCOUNT: 'scratch' },
    prepare: ({ home }) => mkdirSync(join(home, '.claude-scratch')),
  });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    const stderr = sidecar.stderr();
    const matched = EITRI_NOT_LOGGED_IN.exec(stderr);
    assert.ok(matched !== null, `Eitri's matcher does not match:\n${stderr}`);
    assert.equal(matched[1], 'scratch');
    assert.equal(matched[2], join(sidecar.home, '.claude-scratch'), 'the directory named is the one the account resolved to');
    assert.ok(
      stderr.split('\n').includes(`claude account configuration is unusable: claude account "scratch" is not logged in: ${join(sidecar.home, '.claude-scratch', '.credentials.json')} is missing and ANTHROPIC_API_KEY is unset`),
      `the wording changed:\n${stderr}`,
    );
    assert.equal(existsSync(sidecar.socketPath), false, 'refused BEFORE the socket was bound');
  } finally {
    sidecar.stop();
  }
});

// ---- --version ---------------------------------------------------------------------------------------

test('--version: `--version` keeps its first and fourth lines, and the three facts Eitri\'s installer and licence collector read out of it', async () => {
  const { stdout, code } = await run(['--version']);
  assert.equal(code, 0);
  const lines = stdout.trimEnd().split('\n');
  // packaging/install.sh `accept_sidecar_artifact`: line 1 `*"(protocol 3, node vX.Y.Z,"*`, line 4 exactly `executable sources served: host_cli` (a packaged build).
  assert.match(lines[0], /^verdandi-claude-sidecar \S+ \(protocol 3, node v\d+\.\d+\.\d+, build (dev|[0-9a-f]{16})\)$/);
  assert.match(lines[1], /^claude-agent-sdk \S+ \(bundled claude code \S+\)$/);
  assert.match(lines[3], /^executable sources served: host_cli(, sdk_bundled)?$/, 'a checkout also serves sdk_bundled; a packaged build is exactly `host_cli` (next test)');
  // packaging/collect-licenses.py `sidecar_facts`: three regexes over the whole text.
  assert.match(stdout, /node (v\d+\.\d+\.\d+)/);
  assert.match(stdout, /claude-agent-sdk (\S+)/);
  const sidecarVersion = /verdandi-claude-sidecar (\S+)/.exec(stdout)?.[1];
  // ...which then insists the artifact's version IS the checkout's package.json version.
  assert.equal(sidecarVersion, JSON.parse(readFileSync(join(SIDECAR_DIR, 'package.json'), 'utf8')).version);
});

test('--version: a packaged build\'s fourth line is exactly `executable sources served: host_cli`, which install.sh compares for equality', () => {
  const report = versionReport({ sdkBundledAvailable: false }).split('\n');
  assert.equal(report[3], 'executable sources served: host_cli');
  assert.equal(versionReport({ sdkBundledAvailable: true }).split('\n')[3], 'executable sources served: host_cli, sdk_bundled');
});

function run(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SIDECAR_DIR, 'dist', 'src', 'index.js'), ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

// ---- Timing and lifecycle ----------------------------------------------------------------------------

test('lifecycle: the sidecar binds inside Eitri\'s 3 s window, and inside our own 1.5 s regression budget (best of three cold starts)', async () => {
  // Best of three, because a cold start on a busy machine can be slow once; an attempt that never binds (or whose
  // process dies) counts as a failed attempt and the next one still runs.
  const seen: string[] = [];
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= BIND_REGRESSION_BUDGET_MS; attempt += 1) {
    const sidecar = spawnSidecar();
    try {
      const bound = await waitForBind(sidecar);
      if (bound === undefined) {
        seen.push(`never bound (exit ${String(sidecar.child.exitCode)}; stderr: ${sidecar.stderr().trim().split('\n').slice(-3).join(' | ')})`);
      } else {
        seen.push(`${bound} ms`);
        best = Math.min(best, bound);
      }
    } finally {
      sidecar.stop();
    }
  }
  assert.ok(best < EITRI_BIND_BUDGET_MS, `Eitri gives up after ${EITRI_BIND_BUDGET_MS} ms; bound in: ${seen.join('; ')}. Something was added to the default startup path.`);
  assert.ok(best < BIND_REGRESSION_BUDGET_MS, `inside Eitri's window but over our ${BIND_REGRESSION_BUDGET_MS} ms budget: ${seen.join('; ')}. Something slow was added to the default startup path.`);
});

test('lifecycle: a stale socket file from a dead sidecar is removed, not refused', async () => {
  const sidecar = spawnSidecar({
    // A process that listened on the path and was killed: the socket file stays behind, with no listener.
    prepare: ({ socketPath }) => {
      spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`]);
      assert.ok(existsSync(socketPath), 'the stale socket file is in place before the sidecar starts');
    },
  });
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, `did not bind over a stale socket; stderr:\n${sidecar.stderr()}`);
    // And it is a live sidecar on that path now.
    const client = new old.RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    const response = await new Promise<old.HandshakeResponse>((resolve, reject) =>
      client.handshake(old.HandshakeRequest.fromPartial({ clientProtocolMajor: 3 }), (error, reply) => (error ? reject(error) : resolve(reply))),
    );
    assert.equal(response.protocolMajor, 3);
    client.close();
  } finally {
    sidecar.stop();
  }
});

test('lifecycle: stdin is the parent watch by default: closing it stops an idle sidecar with exit 0, well inside Eitri\'s 6 s grace', async () => {
  const sidecar = spawnSidecar();
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const closedAt = Date.now();
    sidecar.child.stdin!.end();
    assert.equal(await sidecar.exited(EITRI_EXIT_GRACE_MS), 0, `still running ${EITRI_EXIT_GRACE_MS} ms after stdin closed; stderr:\n${sidecar.stderr()}`);
    assert.ok(Date.now() - closedAt < EITRI_EXIT_GRACE_MS);
    assert.match(sidecar.stderr(), /stdin reached EOF/);
  } finally {
    sidecar.stop();
  }
});

test('lifecycle: stdin closed while a session\'s CLI ignores SIGTERM: the sidecar still exits inside 6 s, and that CLI is dead when it does', { timeout: 60_000 }, async () => {
  // The worst CLI: keeps running after stdin EOF and ignores SIGTERM, so only SIGKILL ends it. (The stub idles only while
  // a marker file exists, and `close()` removes it, so a failure anywhere in here leaves nothing running.)
  const session = await startCliSession({ ignoreSigterm: true });
  try {
    assert.ok(alive(session.cliPid), 'the session\'s CLI is running');
    const closedAt = Date.now();
    session.sidecar.child.stdin!.end();
    const code = await session.sidecar.exited(EITRI_EXIT_GRACE_MS);
    const took = Date.now() - closedAt;
    assert.equal(code, 0, `still running ${took} ms after stdin closed (Eitri kills it at ${EITRI_EXIT_GRACE_MS} ms); stderr:\n${session.sidecar.stderr()}`);
    assert.ok(took < EITRI_EXIT_GRACE_MS, `took ${took} ms`);
    assert.equal(alive(session.cliPid), false, 'the CLI outlived the sidecar: Eitri would leave it running');
  } finally {
    session.close();
  }
});

// ---- What the CLI is told, seen from the CLI's side -----------------------------------------------------------

test('what the real CLI is started with for Eitri\'s request: permission mode default, project+local settings, the three card-less tools removed, and no bypass in any form', { timeout: 60_000 }, async () => {
  // The conformance suite asserts the SDK's OPTIONS through a composition root it rebuilds by hand; this is the same
  // promise read off the real entry point's real SDK: the arguments a stub `claude` receives.
  const session = await startCliSession();
  try {
    const { argv } = session;
    const valueOf = (flag: string): string | undefined => {
      const at = argv.indexOf(flag);
      return at >= 0 ? argv[at + 1] : undefined;
    };
    assert.equal(valueOf('--permission-mode'), 'default', `argv: ${argv.join(' ')}`);
    assert.equal(argv.filter((arg) => arg === '--permission-mode').length, 1, 'stated once');
    // The SDK spells it `--setting-sources=project,local` today; `--setting-sources project,local` means the same.
    const settingSources = argv.flatMap((arg, at) =>
      arg === '--setting-sources' ? [argv[at + 1]] : arg.startsWith('--setting-sources=') ? [arg.slice('--setting-sources='.length)] : [],
    );
    assert.deepEqual(settingSources, ['project,local'], 'the sources the panel tells the user every session loads, and not `user`');
    const denied = (valueOf('--disallowedTools') ?? '').split(',');
    for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      assert.ok(denied.includes(tool), `${tool} must stay removed from a prompt-routed session; --disallowedTools was ${JSON.stringify(valueOf('--disallowedTools'))}`);
    }
    for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      assert.ok(!denied.includes(tool), `${tool} must not be denied`);
    }
    assert.ok(argv.includes('--include-partial-messages'), 'PARTIAL streaming');
    // No flag that lets the CLI run ungated, spelled any way. Flag NAMES only: a value (a settings JSON, a prompt)
    // may contain these words without meaning anything.
    for (const arg of argv.filter((a) => a.startsWith('-'))) {
      assert.doesNotMatch(arg.split('=')[0], /dangerously|bypass/i, `an ungated-mode flag reached the CLI: ${arg}`);
    }
    assert.notEqual(valueOf('--permission-mode'), 'bypassPermissions');
    assert.ok(!argv.includes('--allow-dangerously-skip-permissions'));
  } finally {
    session.close();
  }
});

// ---- Environment variables -------------------------------------------------------------------------------

test('environment: VERDANDI_CLAUDE_SIDECAR_SOCKET is required, and its absence is said on stderr with exit 1', async () => {
  const sidecar = spawnSidecar({ env: { VERDANDI_CLAUDE_SIDECAR_SOCKET: undefined } });
  try {
    assert.equal(await sidecar.exited(30_000), 1);
    assert.match(sidecar.stderr(), /VERDANDI_CLAUDE_SIDECAR_SOCKET must be set/);
  } finally {
    sidecar.stop();
  }
});

test('environment: VERDANDI_CLAUDE_CLI_PATH is the CLI the sidecar probes (and nothing on PATH is)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1p-cli-'));
  const log = join(dir, 'argv.log');
  try {
    const sidecar = spawnSidecar({ stub: `#!/bin/sh\necho "$@" >> '${log}'\necho "2.1.999 (Claude Code)"\n` });
    try {
      assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
      assert.equal(readFileSync(log, 'utf8').trim(), '--version', 'the named CLI was asked for its version, exactly once');
    } finally {
      sidecar.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('environment: the real process honours an absolute VERDANDI_CLAUDE_CONFIG_DIR: the not-logged-in refusal names THAT directory (Eitri\'s matcher), not $HOME/.claude-<name>', async () => {
  const override = mkdtempSync(join(tmpdir(), 'v1p-override-'));
  const sidecar = spawnSidecar({
    env: { VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: override },
    // The derived directory exists and IS logged in: only an implementation that ignored the override would be happy with it.
    prepare: ({ home }) => {
      mkdirSync(join(home, '.claude-tester'));
      writeFileSync(join(home, '.claude-tester', '.credentials.json'), '{}');
    },
  });
  try {
    assert.equal(await sidecar.exited(30_000), 1, `must refuse: the override directory holds no credentials; stderr:\n${sidecar.stderr()}`);
    const matched = EITRI_NOT_LOGGED_IN.exec(sidecar.stderr());
    assert.ok(matched !== null, `Eitri's matcher does not match:\n${sidecar.stderr()}`);
    assert.equal(matched[1], 'tester');
    assert.equal(matched[2], override, 'the directory named is the override, whole');
    assert.equal(existsSync(sidecar.socketPath), false, 'refused BEFORE the socket was bound');
  } finally {
    sidecar.stop();
    rmSync(override, { recursive: true, force: true });
  }
});

test('environment: the real process with a logged-in absolute VERDANDI_CLAUDE_CONFIG_DIR says so on its startup line and reports it in the Handshake; a relative one refuses to start', async () => {
  const override = mkdtempSync(join(tmpdir(), 'v1p-override-'));
  writeFileSync(join(override, '.credentials.json'), '{}');
  const sidecar = spawnSidecar({ env: { VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: override } });
  const relative = spawnSidecar({ env: { VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: 'relative/dir' } });
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, `did not bind; stderr:\n${sidecar.stderr()}`);
    assert.ok(sidecar.stderr().split('\n').includes(`claude account: tester (${override})`), `the startup line must name the override directory:\n${sidecar.stderr()}`);
    const client = new old.RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    try {
      const handshake = await new Promise<old.HandshakeResponse>((resolve, reject) =>
        client.handshake(old.HandshakeRequest.fromPartial({ clientProtocolMajor: 3 }), (error, reply) => (error ? reject(error) : resolve(reply))),
      );
      assert.equal(handshake.accountBinding, old.AccountBinding.ACCOUNT_BINDING_PINNED);
      assert.equal(handshake.accountName, 'tester');
      assert.equal(handshake.accountConfigDir, override, 'the real process reports the override as the account\'s directory');
    } finally {
      client.close();
    }

    assert.equal(await relative.exited(30_000), 1);
    assert.match(relative.stderr(), /VERDANDI_CLAUDE_CONFIG_DIR must be an absolute path/);
    assert.equal(existsSync(relative.socketPath), false);
  } finally {
    sidecar.stop();
    relative.stop();
    rmSync(override, { recursive: true, force: true });
  }
});

test('environment: VERDANDI_CLAUDE_ACCOUNT=<name> is $HOME/.claude-<name>; an absolute VERDANDI_CLAUDE_CONFIG_DIR replaces the path whole; `default` is $HOME/.claude', () => {
  const home = '/home/nobody';
  assert.deepEqual(resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'tester' }), {
    name: 'tester',
    configDir: '/home/nobody/.claude-tester',
    anthropicConfigDir: '/home/nobody/.config/anthropic-tester',
  });
  assert.deepEqual(resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: '/srv/logins/tester' }), {
    name: 'tester',
    configDir: '/srv/logins/tester',
    anthropicConfigDir: '/home/nobody/.config/anthropic-tester',
  });
  assert.throws(() => resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'tester', VERDANDI_CLAUDE_CONFIG_DIR: 'relative/dir' }), /VERDANDI_CLAUDE_CONFIG_DIR must be an absolute path/);
  assert.deepEqual(resolveAccountSpec({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'default' }), {
    name: 'default',
    configDir: '/home/nobody/.claude',
    anthropicConfigDir: '',
    defaultLocation: true,
  });
  assert.equal(resolveAccountSpec({ HOME: home }), undefined, 'nothing pinned unless named');
});

test('environment: a pinned account reaches the Handshake as PINNED, and every session runs as it (the four-variable tuple), while nothing pinned leaves the SDK\'s environment alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'v1p-acct-'));
  try {
    mkdirSync(join(home, '.claude-tester'));
    writeFileSync(join(home, '.claude-tester', '.credentials.json'), '{}');
    const account = resolveAccount({ HOME: home, VERDANDI_CLAUDE_ACCOUNT: 'tester' })!;
    assert.deepEqual(accountEnv(account), {
      CLAUDE_PROFILE: 'tester',
      CLAUDE_CONFIG_DIR: join(home, '.claude-tester'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude-tester'),
      ANTHROPIC_CONFIG_DIR: join(home, '.config', 'anthropic-tester'),
    });
    await withHarness({ account }, async (h) => {
      const handshake = await h.handshake();
      assert.equal(handshake.accountBinding, old.AccountBinding.ACCOUNT_BINDING_PINNED);
      assert.equal(handshake.accountName, 'tester');
      assert.equal(handshake.accountConfigDir, join(home, '.claude-tester'));
      await h.createGolden('create_session_fresh_partial');
      const env = h.sdk.last.options.env;
      assert.equal(env?.CLAUDE_PROFILE, 'tester');
      assert.equal(env?.CLAUDE_CONFIG_DIR, join(home, '.claude-tester'));
      assert.equal(env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(home, '.claude-tester'));
      assert.equal(env?.ANTHROPIC_CONFIG_DIR, join(home, '.config', 'anthropic-tester'));
    });
    await withHarness({}, async (h) => {
      assert.equal((await h.handshake()).accountBinding, old.AccountBinding.ACCOUNT_BINDING_UNPINNED);
      await h.createGolden('create_session_fresh_partial');
      assert.equal(h.sdk.last.options.env, undefined);
      assert.equal(h.sdk.last.options.pathToClaudeCodeExecutable, HOST_CLI_PATH);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
