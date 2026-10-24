import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { policyToBaseOptions } from '@verdandi/claude-runtime';
import { startSidecar } from '../src/lifecycle.js';
import { buildKernelSessionConfig, type ClaudeCodeVersions } from '../src/runtimeServiceImpl.js';
import {
  classifyCliVersion,
  cliGateModeFromEnv,
  MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE,
  MIN_SUPPORTED_CLI_VERSION,
  TESTED_CLI_VERSIONS,
  type CliGateMode,
} from '../src/cliCompatibility.js';
import {
  ClaudeHostPolicy,
  CliVerdict,
  ConfigurationProfile,
  ErrorCode,
  ErrorDetail,
  ExecutableSource,
  HandshakeResponse,
  PermissionMode,
  PersistenceMode,
  RuntimeServiceClient,
  StreamingMode,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';
import { spawnSidecar, stubCliScript, waitForBind } from './compat/processHarness.js';

/**
 * The CLI gate. Two modes, four verdicts, and the one rule that matters: in `report` mode a session never
 * runs on a refused or unreadable CLI unless the request itself says so, and in the default mode nothing
 * changes at all. Every verdict is exercised through both modes, in-process over a real socket with a fake
 * session (so the factory call count says whether a session was created at all) and as the real entry
 * point with a stub `claude` (so the stderr, the exit code and the bind are the process's own).
 */

// ---- helpers -------------------------------------------------------------------------------------

type Verdict = 'supported' | 'untested' | 'refused' | 'unknown';

const UNREADABLE = 'could not determine the installed claude CLI version via "/gone/claude" (spawn error: spawnSync /gone/claude ENOENT)';

/** The host CLI a verdict stands for, as `getClaudeCodeVersions` would report it. */
const HOST_FOR: Record<Verdict, ClaudeCodeVersions> = {
  supported: { sdkDeclared: '2.1.252', hostCli: '2.1.270' },
  untested: { sdkDeclared: '2.1.252', hostCli: '2.1.999' },
  refused: { sdkDeclared: '2.1.252', hostCli: '0.0.1' },
  unknown: { sdkDeclared: '2.1.252', hostCli: '', hostCliProbeError: UNREADABLE },
};

const EXPECTED_PROTO_VERDICT: Record<Verdict, CliVerdict> = {
  supported: CliVerdict.CLI_VERDICT_SUPPORTED,
  untested: CliVerdict.CLI_VERDICT_UNTESTED,
  refused: CliVerdict.CLI_VERDICT_REFUSED,
  unknown: CliVerdict.CLI_VERDICT_UNKNOWN,
};

const VERDICTS: Verdict[] = ['supported', 'untested', 'refused', 'unknown'];
const MODES: CliGateMode[] = ['refuse', 'report'];

function codeOf(err: unknown): ErrorCode | undefined {
  const bytes = (err as grpc.ServiceError).metadata?.get('grpc-status-details-bin')[0];
  return bytes === undefined ? undefined : ErrorDetail.decode(bytes as Buffer).code;
}

function call<Res>(fn: (req: never, cb: (err: grpc.ServiceError | null, res?: Res) => void) => unknown, request: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(request as never, (err, res) => (err ? reject(err) : resolve(res as Res)));
  });
}

/** Eitri-shaped policy plus whatever the test overrides. */
function policy(extra: Partial<ClaudeHostPolicy> = {}): ClaudeHostPolicy {
  return ClaudeHostPolicy.create({
    configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
    permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
    persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
    executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
    streaming: StreamingMode.STREAMING_MODE_PARTIAL,
    ...extra,
  });
}

type Running = {
  client: RuntimeServiceClient;
  /** How many sessions the sidecar actually built. */
  sessionsBuilt: () => number;
  diagnostics: string[];
  handshake: () => Promise<HandshakeResponse>;
  /** CreateSession; resolves with the session id or rejects with the gRPC error. */
  create: (policyOrUndefined: ClaudeHostPolicy | undefined) => Promise<{ sessionId: string }>;
};

async function withSidecar(
  options: { mode?: CliGateMode; versions: ClaudeCodeVersions; sdkBundledAvailable?: boolean; modeOmitted?: boolean },
  body: (running: Running) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'v3gate-'));
  const socketPath = join(dir, 's.sock');
  let built = 0;
  const diagnostics: string[] = [];
  let sidecar: { close(): Promise<void> } | undefined;
  let client: RuntimeServiceClient | undefined;
  try {
    sidecar = await startSidecar({
      socketPath,
      sessionFactory: () => {
        built += 1;
        return makeFakeSession().session;
      },
      getClaudeCodeVersions: () => options.versions,
      classifyCliVersion: (version) => classifyCliVersion(version),
      ...(options.modeOmitted === true ? {} : { cliGate: options.mode ?? 'refuse' }),
      sdkBundledAvailable: options.sdkBundledAvailable ?? false,
      parentWatch: 'none',
      onDiagnostic: (message) => diagnostics.push(message),
      runtime: { sdkBundledAvailable: options.sdkBundledAvailable ?? false },
    });
    const c = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
    client = c;
    await body({
      client: c,
      sessionsBuilt: () => built,
      diagnostics,
      handshake: () => call<HandshakeResponse>(c.handshake.bind(c), { clientProtocolMajor: 3 }),
      create: (p) => call<{ sessionId: string }>(c.createSession.bind(c), { cwd: '/tmp', policy: p }),
    });
  } finally {
    client?.close();
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the variable ---------------------------------------------------------------------------------

test('CLI_GATE: unset, empty and "refuse" are the default; "report" is the only other value; anything else is refused', () => {
  assert.equal(cliGateModeFromEnv({}), 'refuse');
  assert.equal(cliGateModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_CLI_GATE: '' }), 'refuse');
  assert.equal(cliGateModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_CLI_GATE: '  ' }), 'refuse');
  assert.equal(cliGateModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'refuse' }), 'refuse');
  assert.equal(cliGateModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'report' }), 'report');
  for (const garbage of ['banana', 'REPORT', 'Report', 'report,refuse', 'off', '1', 'true', 'none', 'reportt']) {
    assert.throws(
      () => cliGateModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_CLI_GATE: garbage }),
      (err: Error) => err.message === `VERDANDI_CLAUDE_SIDECAR_CLI_GATE: expected "refuse" or "report", got ${JSON.stringify(garbage)}`,
      garbage,
    );
  }
});

// ---- the data -------------------------------------------------------------------------------------

test('2.1.283 is now tested (it stops being reported untested), 2.1.284 is not, and the range did not move', () => {
  assert.ok(TESTED_CLI_VERSIONS.has('2.1.283'));
  assert.deepEqual(classifyCliVersion('2.1.283'), { kind: 'supported' });
  assert.equal(classifyCliVersion('2.1.284').kind, 'untested', 'no real-CLI run of this sidecar on 2.1.284 exists, so it is not claimed');
  assert.equal(MIN_SUPPORTED_CLI_VERSION, '2.1.252');
  assert.equal(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE, '3.0.0');
});

// ---- both modes x four verdicts, in process -------------------------------------------------------

for (const mode of MODES) {
  for (const verdict of VERDICTS) {
    const needsAcceptance = verdict === 'refused' || verdict === 'unknown';
    test(`${mode} mode, host CLI ${verdict}: ${mode === 'refuse' && needsAcceptance ? 'the process does not start' : 'binds, reports the verdict, and gates CreateSession as specified'}`, async () => {
      const versions = HOST_FOR[verdict];
      if (mode === 'refuse' && needsAcceptance) {
        // The old behaviour, word for word: nothing is bound and the sentence a host parses is unchanged.
        const dir = mkdtempSync(join(tmpdir(), 'v3gate-'));
        const socketPath = join(dir, 's.sock');
        try {
          await assert.rejects(
            startSidecar({
              socketPath,
              sessionFactory: () => makeFakeSession().session,
              getClaudeCodeVersions: () => versions,
              classifyCliVersion: (v) => classifyCliVersion(v),
              cliGate: 'refuse',
              sdkBundledAvailable: false,
              parentWatch: 'none',
              onDiagnostic: () => undefined,
            }),
            (err: Error) =>
              verdict === 'refused'
                ? err.message === `refusing to start: host claude CLI version 0.0.1: ${(classifyCliVersion('0.0.1') as { diagnostic: string }).diagnostic}`
                : err.message === UNREADABLE,
          );
          assert.equal(existsSync(socketPath), false, 'refused before the socket was bound');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return;
      }

      await withSidecar({ mode, versions }, async (s) => {
        const handshake = await s.handshake();
        const report = handshake.cliCompatibility;
        assert.ok(report !== undefined, 'the handshake carries the host CLI verdict');
        assert.equal(report.verdict, EXPECTED_PROTO_VERDICT[verdict]);
        assert.equal(report.version, versions.hostCli);
        assert.equal(report.supportedRange, `>=${MIN_SUPPORTED_CLI_VERSION} <${MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE}`);
        assert.deepEqual(report.testedVersions, [...TESTED_CLI_VERSIONS]);
        if (verdict === 'supported') {
          assert.equal(report.diagnostic, '');
        } else if (verdict === 'unknown') {
          assert.equal(report.diagnostic, UNREADABLE);
        } else {
          assert.notEqual(report.diagnostic, '');
        }
        assert.equal(handshake.bundledCliCompatibility, undefined, 'no bundled CLI is served in this build, so no verdict for it');
        assert.equal(handshake.actualClaudeCodeVersion, versions.hostCli);

        // CreateSession: field absent (no policy at all), absent from a policy, false, true.
        const attempts: Array<[string, ClaudeHostPolicy | undefined, boolean]> = [
          ['no policy', undefined, false],
          ['field absent', policy(), false],
          ['field false', policy({ acceptUnsupportedCli: false }), false],
          ['field true', policy({ acceptUnsupportedCli: true }), true],
        ];
        let expectedBuilt = 0;
        for (const [label, p, sent] of attempts) {
          const allowed = mode === 'refuse' || !needsAcceptance || sent;
          if (allowed) {
            const { sessionId } = await s.create(p);
            assert.ok(sessionId.length > 0, label);
            expectedBuilt += 1;
          } else {
            await assert.rejects(s.create(p), (err: grpc.ServiceError) => {
              assert.equal(codeOf(err), ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION, label);
              assert.equal(err.code, grpc.status.FAILED_PRECONDITION, label);
              assert.match(err.details ?? err.message, /VERDANDI_CLAUDE_SIDECAR_CLI_GATE=report/, label);
              assert.match(err.details ?? err.message, /accept_unsupported_cli/, label);
              return true;
            }, label);
          }
          assert.equal(s.sessionsBuilt(), expectedBuilt, `${label}: a refused CreateSession must not have built a session`);
        }
      });
    });
  }
}

test('default mode ignores accept_unsupported_cli: the same sessions, with or without it', async () => {
  for (const versions of [HOST_FOR.supported, HOST_FOR.untested]) {
    await withSidecar({ mode: 'refuse', versions }, async (s) => {
      for (const p of [undefined, policy(), policy({ acceptUnsupportedCli: true })]) {
        assert.ok((await s.create(p)).sessionId.length > 0);
      }
      assert.equal(s.sessionsBuilt(), 3);
    });
  }
});

test('leaving `cliGate` out of startSidecar is the default mode, not the report mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3gate-'));
  try {
    await assert.rejects(
      startSidecar({
        socketPath: join(dir, 's.sock'),
        sessionFactory: () => makeFakeSession().session,
        getClaudeCodeVersions: () => HOST_FOR.refused,
        classifyCliVersion: (v) => classifyCliVersion(v),
        sdkBundledAvailable: false,
        parentWatch: 'none',
        onDiagnostic: () => undefined,
      }),
      /^Error: refusing to start: host claude CLI version 0\.0\.1: /,
    );
    // An unreadable host CLI that somehow reaches the default mode is refused too, with the probe's words.
    await assert.rejects(
      startSidecar({
        socketPath: join(dir, 's2.sock'),
        sessionFactory: () => makeFakeSession().session,
        getClaudeCodeVersions: () => HOST_FOR.unknown,
        classifyCliVersion: (v) => classifyCliVersion(v),
        sdkBundledAvailable: false,
        parentWatch: 'none',
        onDiagnostic: () => undefined,
      }),
      (err: Error) => err.message === UNREADABLE,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report mode says so once on stderr for a refused or unreadable CLI, without the marker a host matches for an accepted one', async () => {
  for (const verdict of ['refused', 'unknown'] as const) {
    await withSidecar({ mode: 'report', versions: HOST_FOR[verdict] }, async (s) => {
      const lines = s.diagnostics.filter((line) => !line.includes('parent watch is off'));
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /^claude-sidecar: CLI gate is in report mode and the host claude CLI is (REFUSED|UNKNOWN): /);
      assert.ok(!lines[0].includes('CLI version diagnostic'));
    });
  }
  // An untested CLI keeps exactly the diagnostic line it always had, in either mode.
  for (const mode of MODES) {
    await withSidecar({ mode, versions: HOST_FOR.untested }, async (s) => {
      const lines = s.diagnostics.filter((line) => !line.includes('parent watch is off'));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^claude-sidecar: host CLI version diagnostic: claude CLI version 2\.1\.999 is inside this sidecar's supported range /);
    });
  }
});

// ---- the bundled CLI ------------------------------------------------------------------------------

test('bundled_cli_compatibility is filled only when the SDK-bundled executable is served, and then it is that binary\'s own verdict', async () => {
  await withSidecar({ mode: 'refuse', versions: HOST_FOR.supported, sdkBundledAvailable: true }, async (s) => {
    const handshake = await s.handshake();
    assert.equal(handshake.bundledCliCompatibility?.verdict, CliVerdict.CLI_VERDICT_SUPPORTED);
    assert.equal(handshake.bundledCliCompatibility?.version, '2.1.252');
    assert.equal(handshake.cliCompatibility?.version, '2.1.270');
    assert.ok(handshake.capabilities.includes('executable_sdk_bundled'));
  });
  for (const mode of MODES) {
    await withSidecar({ mode, versions: HOST_FOR.supported, sdkBundledAvailable: false }, async (s) => {
      const handshake = await s.handshake();
      assert.equal(handshake.bundledCliCompatibility, undefined, 'a packaged build has no bundled CLI to judge');
      assert.ok(!handshake.capabilities.includes('executable_sdk_bundled'));
      assert.ok(handshake.cliCompatibility !== undefined);
    });
  }
});

test('report mode judges a session by the binary it would run: a refused bundled CLI does not block a host_cli session, and the reverse', async () => {
  const bundledRefused: ClaudeCodeVersions = { sdkDeclared: '0.0.1', hostCli: '2.1.270' };
  await withSidecar({ mode: 'report', versions: bundledRefused, sdkBundledAvailable: true }, async (s) => {
    const handshake = await s.handshake();
    assert.equal(handshake.bundledCliCompatibility?.verdict, CliVerdict.CLI_VERDICT_REFUSED);
    assert.equal(handshake.cliCompatibility?.verdict, CliVerdict.CLI_VERDICT_SUPPORTED);
    // host_cli, the unset enum and no policy at all run the installed CLI.
    for (const p of [undefined, policy(), policy({ executable: ExecutableSource.EXECUTABLE_SOURCE_UNSPECIFIED })]) {
      assert.ok((await s.create(p)).sessionId.length > 0);
    }
    const sdkBundled = (accept: boolean): ClaudeHostPolicy =>
      policy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED, acceptUnsupportedCli: accept });
    await assert.rejects(s.create(sdkBundled(false)), (err: unknown) => codeOf(err) === ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION);
    assert.equal(s.sessionsBuilt(), 3);
    assert.ok((await s.create(sdkBundled(true))).sessionId.length > 0);
    assert.equal(s.sessionsBuilt(), 4);
  });

  const hostRefused: ClaudeCodeVersions = { sdkDeclared: '2.1.252', hostCli: '0.0.1' };
  await withSidecar({ mode: 'report', versions: hostRefused, sdkBundledAvailable: true }, async (s) => {
    await assert.rejects(s.create(policy()), (err: unknown) => codeOf(err) === ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION);
    assert.ok((await s.create(policy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED }))).sessionId.length > 0);
    assert.equal(s.sessionsBuilt(), 1);
  });
});

test('report mode: an executable value the proto does not declare (-1 included) is refused as such, before any CLI verdict, accepted or not', async () => {
  // Host refused, bundled supported: whichever binary an unknown value were read as, one verdict would
  // let it through. It is read as neither.
  await withSidecar({ mode: 'report', versions: { sdkDeclared: '2.1.252', hostCli: '0.0.1' }, sdkBundledAvailable: true }, async (s) => {
    for (const executable of [99 as ExecutableSource, ExecutableSource.UNRECOGNIZED]) {
      for (const acceptUnsupportedCli of [false, true]) {
        await assert.rejects(s.create(policy({ executable, acceptUnsupportedCli })), (err: unknown) => {
          assert.equal(codeOf(err), ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
          assert.equal(ErrorDetail.decode((err as grpc.ServiceError).metadata.get('grpc-status-details-bin')[0] as Buffer).reason, 'executable_unknown');
          return true;
        });
      }
    }
    assert.equal(s.sessionsBuilt(), 0, 'a refused request built nothing');
  });
});

// ---- the gated-mode invariant ---------------------------------------------------------------------

test('gated_cli_mode_default: advertised in both modes, and an INTERACTIVE or VERDANDI_RULES session reaches the SDK in `default` however the request is spelt', async () => {
  for (const mode of MODES) {
    await withSidecar({ mode, versions: HOST_FOR.supported }, async (s) => {
      const capabilities = (await s.handshake()).capabilities;
      assert.ok(capabilities.includes('cli_compatibility_report'));
      assert.ok(capabilities.includes('gated_cli_mode_default'));
      assert.ok(
        capabilities.indexOf('gated_cli_mode_default') < capabilities.indexOf('executable_host_cli'),
        'new capabilities sit before the executable pair',
      );
    });
  }
  for (const permissions of [
    PermissionMode.PERMISSION_MODE_UNSPECIFIED,
    PermissionMode.PERMISSION_MODE_INTERACTIVE,
    PermissionMode.PERMISSION_MODE_VERDANDI_RULES,
  ]) {
    for (const permissionModeSwitchable of [false, true]) {
      const config = buildKernelSessionConfig(
        { cwd: '/tmp/project', policy: policy({ permissions, permissionModeSwitchable }) },
        { hostCliPath: '/usr/local/bin/claude' },
      );
      assert.equal(policyToBaseOptions(config.policy, config.cwd, { hostCliPath: config.hostCliPath }).permissionMode, 'default', PermissionMode[permissions]);
    }
  }
});

// ---- the real entry point -------------------------------------------------------------------------

/** Spawns the real process, waits for it to end (or to bind), and returns what it did. */
async function refusedRun(options: Parameters<typeof spawnSidecar>[0]): Promise<{ code: number | null | 'running'; stderr: string; bound: boolean }> {
  const sidecar = spawnSidecar(options);
  try {
    const code = await sidecar.exited(30_000);
    return { code, stderr: sidecar.stderr(), bound: existsSync(sidecar.socketPath) };
  } finally {
    sidecar.stop();
  }
}

test('process: the default mode refuses a refused CLI before binding with the same bytes whether the variable is unset or "refuse"', async () => {
  const unset = await refusedRun({ stub: stubCliScript('0.0.1') });
  const explicit = await refusedRun({ stub: stubCliScript('0.0.1'), env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'refuse' } });
  assert.equal(unset.code, 1);
  assert.equal(explicit.code, 1);
  assert.equal(unset.bound, false);
  assert.equal(explicit.bound, false);
  assert.match(unset.stderr, /refusing to start: host claude CLI version 0\.0\.1: claude CLI version 0\.0\.1 is outside this sidecar's supported range/);
  // The temp directory differs per run and is never named in this text, so the two are byte-comparable.
  assert.equal(explicit.stderr, unset.stderr);
});

test('process: the default mode refuses an unreadable CLI before binding with the same bytes whether the variable is unset or "refuse"', async () => {
  const unset = await refusedRun({ cliPath: '/nonexistent/v3-gate/claude' });
  const explicit = await refusedRun({ cliPath: '/nonexistent/v3-gate/claude', env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'refuse' } });
  for (const run of [unset, explicit]) {
    assert.equal(run.code, 1);
    assert.equal(run.bound, false);
    assert.match(run.stderr, /could not determine the installed claude CLI version via "\/nonexistent\/v3-gate\/claude" \(spawn error: spawnSync \/nonexistent\/v3-gate\/claude ENOENT\)/);
  }
  assert.equal(explicit.stderr, unset.stderr);
});

test('process: a garbage CLI_GATE value refuses to boot, naming the variable, and binds nothing', async () => {
  for (const garbage of ['banana', 'REPORT', 'off', '1']) {
    const run = await refusedRun({ stub: stubCliScript('2.1.270'), env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: garbage } });
    assert.equal(run.code, 1, garbage);
    assert.equal(run.bound, false, garbage);
    assert.ok(
      run.stderr.split('\n').includes(`VERDANDI_CLAUDE_SIDECAR_CLI_GATE: expected "refuse" or "report", got ${JSON.stringify(garbage)}`),
      `${garbage}: ${run.stderr}`,
    );
  }
});

/**
 * A stub `claude` at `version` that, if it is ever started as a session's CLI (anything but `--version`), records
 * that it was and idles while a marker file exists, so a test that dies half-way leaves nothing running.
 */
function recordingStub(version: string, cwd: string): { script: string; startedFile: string; aliveFile: string } {
  const startedFile = join(cwd, 'cli.started');
  const aliveFile = join(cwd, 'cli.alive');
  writeFileSync(aliveFile, '');
  const body = [`echo $$ > '${startedFile}.tmp' && mv '${startedFile}.tmp' '${startedFile}'`, `while [ -e '${aliveFile}' ]; do sleep 0.05; done`].join('\n');
  return { script: stubCliScript(version, body, 0.05), startedFile, aliveFile };
}

for (const [label, stubVersion, cliPath, expectedVerdict] of [
  ['a CLI outside the range (REFUSED)', '0.0.1', undefined, CliVerdict.CLI_VERDICT_REFUSED],
  ['a CLI whose version cannot be read (UNKNOWN)', undefined, '/nonexistent/v3-gate/claude', CliVerdict.CLI_VERDICT_UNKNOWN],
] as const) {
  test(`process: report mode on ${label} binds, reports it, refuses CreateSession without the field and never starts the CLI, and runs it only with the field`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'v3gate-session-'));
    const stub = recordingStub(stubVersion ?? '2.1.999', cwd);
    const sidecar = spawnSidecar({
      stub: stub.script,
      ...(cliPath !== undefined ? { cliPath } : {}),
      env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'report' },
    });
    const client = new RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    try {
      assert.notEqual(await waitForBind(sidecar), undefined, `report mode never bound; stderr:\n${sidecar.stderr()}`);
      const handshake = await call<HandshakeResponse>(client.handshake.bind(client), { clientProtocolMajor: 3 });
      assert.equal(handshake.cliCompatibility?.verdict, expectedVerdict);
      if (expectedVerdict === CliVerdict.CLI_VERDICT_UNKNOWN) {
        assert.equal(handshake.cliCompatibility?.version, '');
        assert.match(handshake.cliCompatibility?.diagnostic ?? '', /^could not determine the installed claude CLI version via /);
      } else {
        assert.equal(handshake.cliCompatibility?.version, '0.0.1');
      }
      assert.match(sidecar.stderr(), /claude-sidecar: CLI gate is in report mode and the host claude CLI is (REFUSED|UNKNOWN): /);
      assert.ok(!/refusing to start/.test(sidecar.stderr()));

      const create = (accept: boolean | undefined): Promise<{ sessionId: string }> =>
        call(client.createSession.bind(client), { cwd, policy: policy(accept === undefined ? {} : { acceptUnsupportedCli: accept }) });
      for (const accept of [undefined, false]) {
        await assert.rejects(create(accept), (err: grpc.ServiceError) => codeOf(err) === ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION);
      }
      // Nothing ran: a session that was refused has no CLI behind it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(existsSync(stub.startedFile), false, 'a refused CreateSession must not start the CLI');

      if (expectedVerdict === CliVerdict.CLI_VERDICT_REFUSED) {
        // The stub is only a real CLI for the REFUSED case (the UNKNOWN case's path does not exist).
        const { sessionId } = await create(true);
        assert.ok(sessionId.length > 0);
        const deadline = Date.now() + 15_000;
        while (!existsSync(stub.startedFile) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(existsSync(stub.startedFile), `with accept_unsupported_cli the session's CLI must start; stderr:\n${sidecar.stderr()}`);
      }
    } finally {
      client.close();
      rmSync(stub.aliveFile, { force: true });
      const pid = existsSync(stub.startedFile) ? Number(readFileSync(stub.startedFile, 'utf8').trim()) : undefined;
      if (pid !== undefined && Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      sidecar.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

const CLI_OUTPUT_MARKER = 'launcher-token-6c1e0f';

for (const [label, stub, expectedVerdict] of [
  ['an unreadable CLI that prints on stderr (UNKNOWN)', `#!/bin/sh\necho "launcher: refusing; ${CLI_OUTPUT_MARKER}" >&2\nexit 3\n`, 'unknown'],
  ['a refused CLI whose version does not parse (REFUSED)', stubCliScript(`v-${CLI_OUTPUT_MARKER}`), 'refused'],
] as const) {
  test(`process: report mode on ${label}: nothing the CLI printed reaches the handshake, a refused CreateSession or the report file, which records the decision left to the host; stderr keeps it all`, async () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'v3gate-report-'));
    const reportFile = join(reportDir, 'report.jsonl');
    const sidecar = spawnSidecar({ stub, env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'report', VERDANDI_CLAUDE_SIDECAR_REPORT_FILE: reportFile } });
    const client = new RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
    try {
      assert.notEqual(await waitForBind(sidecar), undefined, `report mode never bound; stderr:\n${sidecar.stderr()}`);
      const handshake = await call<HandshakeResponse>(client.handshake.bind(client), { clientProtocolMajor: 3 });
      const report = handshake.cliCompatibility!;
      assert.equal(report.verdict, expectedVerdict === 'unknown' ? CliVerdict.CLI_VERDICT_UNKNOWN : CliVerdict.CLI_VERDICT_REFUSED);
      // The whole response, not just the report: actual_claude_code_version names the same CLI.
      const wholeHandshake = JSON.stringify(handshake, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
      assert.ok(!wholeHandshake.includes(CLI_OUTPUT_MARKER), `the handshake carries the CLI's output: ${wholeHandshake}`);
      assert.equal(handshake.actualClaudeCodeVersion, expectedVerdict === 'unknown' ? '' : report.version);
      if (expectedVerdict === 'unknown') {
        assert.match(report.diagnostic, /^could not determine the installed claude CLI version via .* \(exit status 3; stderr: \[CLI output omitted: \d+ bytes\]\)$/);
      } else {
        assert.match(report.version, /^\[CLI output omitted: \d+ bytes\]$/);
        assert.match(report.diagnostic, /could not parse the installed claude CLI version "\[CLI output omitted: \d+ bytes\]"/);
      }

      const refusal = await call(client.createSession.bind(client), { cwd: '/tmp', policy: policy() }).then(
        () => assert.fail('CreateSession was accepted'),
        (err: grpc.ServiceError) => err,
      );
      const detail = ErrorDetail.decode(refusal.metadata.get('grpc-status-details-bin')[0] as Buffer);
      assert.equal(detail.code, ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION);
      assert.ok(!detail.message.includes(CLI_OUTPUT_MARKER), `the refusal carries the CLI's output: ${detail.message}`);
      assert.ok(!refusal.details.includes(CLI_OUTPUT_MARKER), `the status text carries the CLI's output: ${refusal.details}`);

      const records = readFileSync(reportFile, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; code: string; message: string; details: Record<string, unknown> });
      assert.deepEqual(records.map((record) => `${record.kind}:${record.code}`), ['diagnostic:CLI_LEFT_TO_HOST', 'ready:READY']);
      const [left] = records;
      assert.deepEqual(left.details, { binary: 'host', verdict: expectedVerdict, version: report.version, pid: sidecar.child.pid });
      assert.match(left.message, /^claude-sidecar: CLI gate is in report mode and the host claude CLI is (UNKNOWN|REFUSED): .* -- CreateSession is refused on it unless the request sets accept_unsupported_cli\.$/);
      assert.ok(!left.message.includes(CLI_OUTPUT_MARKER), `the report file carries the CLI's output: ${left.message}`);

      // The process's own stderr, read by whoever started it, shows the whole text as it always has.
      assert.match(sidecar.stderr(), new RegExp(`claude-sidecar: CLI gate is in report mode and the host claude CLI is (UNKNOWN|REFUSED): .*${CLI_OUTPUT_MARKER}`));
    } finally {
      client.close();
      sidecar.stop();
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
}

test('process: report mode on a CLI that is merely untested starts it without the field, as always', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'v3gate-session-'));
  const stub = recordingStub('2.1.999', cwd);
  const sidecar = spawnSidecar({ stub: stub.script, env: { VERDANDI_CLAUDE_SIDECAR_CLI_GATE: 'report' } });
  const client = new RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
  try {
    assert.notEqual(await waitForBind(sidecar), undefined, sidecar.stderr());
    const handshake = await call<HandshakeResponse>(client.handshake.bind(client), { clientProtocolMajor: 3 });
    assert.equal(handshake.cliCompatibility?.verdict, CliVerdict.CLI_VERDICT_UNTESTED);
    assert.equal(handshake.cliCompatibility?.version, '2.1.999');
    await call(client.createSession.bind(client), { cwd, policy: policy() });
    const deadline = Date.now() + 15_000;
    while (!existsSync(stub.startedFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(stub.startedFile), sidecar.stderr());
  } finally {
    client.close();
    rmSync(stub.aliveFile, { force: true });
    const pid = existsSync(stub.startedFile) ? Number(readFileSync(stub.startedFile, 'utf8').trim()) : undefined;
    if (pid !== undefined && Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    sidecar.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
