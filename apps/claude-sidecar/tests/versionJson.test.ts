import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sortedByVersion, versionReport, versionReportJson } from '../src/versionReport.js';
import { TESTED_CLI_VERSIONS } from '../src/cliCompatibility.js';
import { REPO_ROOT, SIDECAR_DIR } from './compat/paths.js';

/**
 * `--version --json` is the machine-readable twin of `--version`. The text is frozen (an installer
 * compares its lines); the JSON is how a host or a build step reads the same facts without a regex.
 * Two renderings of one set of facts can drift apart, so the first test parses the text back and
 * compares it field by field, for both builds a binary can be (a checkout and a packaged one).
 */

type Report = {
  v: number;
  sidecar_version: string;
  protocol: { major: number; minor: number };
  node: string;
  build_stamp: string;
  sdk_version: string;
  sdk_bundled_cli: string;
  supported_cli_range: { min: string; max_exclusive: string };
  tested_cli_versions: string[];
  executables: string[];
  capabilities: string[];
};

for (const sdkBundledAvailable of [true, false]) {
  test(`--version --json agrees with the text report, field by field (sdk_bundled ${sdkBundledAvailable ? 'available' : 'unavailable'})`, () => {
    const json = JSON.parse(versionReportJson({ sdkBundledAvailable })) as Report;
    const [line1, line2, line3, line4] = versionReport({ sdkBundledAvailable }).split('\n');

    const first = /^verdandi-claude-sidecar (\S+) \(protocol (\d+), node (v\S+), build (\S+)\)$/.exec(line1);
    assert.ok(first !== null, `line 1 changed shape: ${line1}`);
    assert.equal(json.sidecar_version, first[1]);
    assert.equal(json.protocol.major, Number(first[2]));
    assert.equal(json.node, first[3]);
    assert.equal(json.build_stamp, first[4]);

    const second = /^claude-agent-sdk (\S+) \(bundled claude code (\S+)\)$/.exec(line2);
    assert.ok(second !== null, `line 2 changed shape: ${line2}`);
    assert.equal(json.sdk_version, second[1]);
    assert.equal(json.sdk_bundled_cli, second[2]);

    const third = /^supported claude code CLI: >=(\S+) <(\S+)$/.exec(line3);
    assert.ok(third !== null, `line 3 changed shape: ${line3}`);
    assert.deepEqual(json.supported_cli_range, { min: third[1], max_exclusive: third[2] });

    assert.equal(line4, `executable sources served: ${json.executables.join(', ')}`);
    assert.deepEqual(json.executables, sdkBundledAvailable ? ['host_cli', 'sdk_bundled'] : ['host_cli']);
  });
}

test('--version --json: the capabilities are the ones the protocol source lists, not a second list', () => {
  const source = JSON.parse(readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json'), 'utf8')) as {
    protocol: { major: number; minor: number };
    capabilities: Array<{ name: string; when?: string }>;
  };
  const packaged = JSON.parse(versionReportJson({ sdkBundledAvailable: false })) as Report;
  const checkout = JSON.parse(versionReportJson({ sdkBundledAvailable: true })) as Report;

  assert.deepEqual(packaged.protocol, source.protocol);
  // `egress_restricted` is a fact about a running process (it is proven at startup), and so is
  // `cli_message_lifecycle` (the host CLI's version, probed at startup), so a static report claims
  // neither; `sdk_bundled` is a fact about the build, so it follows the build.
  assert.deepEqual(
    checkout.capabilities,
    source.capabilities.filter((c) => c.when !== 'egress_restricted' && c.when !== 'cli_message_lifecycle').map((c) => c.name),
  );
  assert.ok(!checkout.capabilities.includes('steer_turn'));
  assert.deepEqual(packaged.capabilities, source.capabilities.filter((c) => c.when === undefined).map((c) => c.name));
  assert.ok(!checkout.capabilities.includes('egress_restricted'));
  // The wire-order rule the handshake keeps: the executable_* pair stays last.
  assert.match(packaged.capabilities.at(-1) ?? '', /^executable_/);
});

test('--version --json: reports the tested CLI versions, in version order, so a host can see what was exercised', () => {
  const json = JSON.parse(versionReportJson({ sdkBundledAvailable: true })) as Report;
  assert.deepEqual([...json.tested_cli_versions].sort(), [...TESTED_CLI_VERSIONS].sort(), 'the report lists exactly the tested set');
  const numeric = (v: string) => v.split('.').map(Number);
  const inOrder = [...json.tested_cli_versions].sort((x, y) => {
    const [a, b] = [numeric(x), numeric(y)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  assert.deepEqual(json.tested_cli_versions, inOrder);
});

test('sortedByVersion: orders by numeric segment, which a plain string sort does not (2.1.9 before 2.1.10)', () => {
  assert.deepEqual(sortedByVersion(['2.1.10', '2.1.9', '2.1.100', '2.0.270', '10.0.0', '3.0.0']), ['2.0.270', '2.1.9', '2.1.10', '2.1.100', '3.0.0', '10.0.0']);
  assert.deepEqual([...['2.1.10', '2.1.9']].sort(), ['2.1.10', '2.1.9'], 'control: the string sort puts 2.1.10 first');
  assert.deepEqual(sortedByVersion(new Set(['2.1.9', 'nonsense', '2.1.10'])), ['2.1.9', '2.1.10', 'nonsense'], 'an unreadable entry goes last, not first');
});

test('--version --json: is one JSON line on stdout, needs no socket and no claude CLI, and plain --version is untouched', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(SIDECAR_DIR, 'dist', 'src', 'index.js'), ...args], {
      encoding: 'utf8',
      // No socket, and a CLI path that does not exist: either would fail a startup, neither may fail this.
      env: { PATH: '/nonexistent', VERDANDI_CLAUDE_CLI_PATH: '/nonexistent/claude' },
    });

  for (const args of [['--version', '--json'], ['--json', '--version']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith('\n') && result.stdout.trimEnd().split('\n').length === 1, `not exactly one line:\n${result.stdout}`);
    const json = JSON.parse(result.stdout) as Report;
    assert.equal(json.v, 1);
    assert.deepEqual(json.executables, ['host_cli', 'sdk_bundled'], 'an unbundled checkout serves both');
  }

  const text = run(['--version']);
  assert.equal(text.status, 0);
  assert.equal(text.stdout, `${versionReport({ sdkBundledAvailable: true })}\n`);
  // `--json` alone is not a version request: it must not change what an ordinary start does.
  assert.ok(!run(['--json']).stdout.startsWith('{'), '--json without --version printed a report');
});
