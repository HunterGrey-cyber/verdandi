import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCliVersion,
  compareVersions,
  parseVersion,
  strictModeFromEnv,
  MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE,
  MIN_SUPPORTED_CLI_VERSION,
  TESTED_CLI_VERSIONS,
} from '../src/cliCompatibility.js';

/**
 * Every branch of the CLI compatibility policy, with no real `claude` binary involved. The policy
 * decides whether the whole sidecar boots, so an untested branch here is an untested failure mode
 * for every downstream consumer.
 */

const POLICY = {
  tested: new Set(['2.1.267']),
  minVersion: '2.1.267',
  maxVersionExclusive: '3.0.0',
  knownIncompatible: new Set<string>([]),
};

test('parseVersion: reads a plain three-part version', () => {
  assert.deepEqual(parseVersion('2.1.269'), [2, 1, 269]);
});

test('parseVersion: ignores a trailing pre-release/build suffix', () => {
  assert.deepEqual(parseVersion('2.1.269-beta.1'), [2, 1, 269]);
});

test('parseVersion: tolerates surrounding whitespace', () => {
  assert.deepEqual(parseVersion('  2.1.269  '), [2, 1, 269]);
});

test('parseVersion: returns undefined rather than a partial tuple for an unreadable version', () => {
  assert.equal(parseVersion('untested-version'), undefined);
  assert.equal(parseVersion('2.1'), undefined);
  assert.equal(parseVersion(''), undefined);
});

test('compareVersions: orders by major, then minor, then patch', () => {
  assert.ok(compareVersions([2, 1, 267], [2, 1, 269]) < 0);
  assert.ok(compareVersions([2, 2, 0], [2, 1, 999]) > 0);
  assert.ok(compareVersions([3, 0, 0], [2, 9, 9]) > 0);
  assert.equal(compareVersions([2, 1, 267], [2, 1, 267]), 0);
});

test('classifyCliVersion: an exactly tested version is supported, with no diagnostic', () => {
  assert.deepEqual(classifyCliVersion('2.1.267', POLICY), { kind: 'supported' });
});

test('classifyCliVersion: the real-world case -- an in-range patch bump starts, with a diagnostic', () => {
  // This is the exact situation that took the Agent pane offline: sidecar tested against 2.1.267,
  // installed CLI already at 2.1.269.
  const verdict = classifyCliVersion('2.1.269', POLICY);
  assert.equal(verdict.kind, 'untested');
  assert.match(verdict.kind === 'untested' ? verdict.diagnostic : '', /2\.1\.269/);
  assert.match(verdict.kind === 'untested' ? verdict.diagnostic : '', />=2\.1\.267 <3\.0\.0/);
});

test('classifyCliVersion: an in-range MINOR bump also starts with a diagnostic, not a refusal', () => {
  assert.equal(classifyCliVersion('2.5.0', POLICY).kind, 'untested');
});

test('classifyCliVersion: below the floor is refused', () => {
  const verdict = classifyCliVersion('2.1.266', POLICY);
  assert.equal(verdict.kind, 'refused');
  assert.match(verdict.kind === 'refused' ? verdict.diagnostic : '', /outside this sidecar's supported range/);
});

test('classifyCliVersion: a new MAJOR is refused -- the documented break point', () => {
  assert.equal(classifyCliVersion('3.0.0', POLICY).kind, 'refused');
  assert.equal(classifyCliVersion('3.1.5', POLICY).kind, 'refused');
});

test('classifyCliVersion: an unparseable version fails closed rather than comparing as zero', () => {
  const verdict = classifyCliVersion('untested-version', POLICY);
  assert.equal(verdict.kind, 'refused');
  assert.match(verdict.kind === 'refused' ? verdict.diagnostic : '', /could not parse/);
});

test('classifyCliVersion: the known-incompatible denylist beats the tested set', () => {
  // A version can be discovered broken AFTER it was once tested. Fail closed must win, or the
  // denylist would be unable to retract a version that is still listed as tested.
  const verdict = classifyCliVersion('2.1.267', { ...POLICY, knownIncompatible: new Set(['2.1.267']) });
  assert.equal(verdict.kind, 'refused');
  assert.match(verdict.kind === 'refused' ? verdict.diagnostic : '', /known-incompatible/);
});

test('classifyCliVersion: strict mode refuses an in-range untested version', () => {
  const verdict = classifyCliVersion('2.1.269', { ...POLICY, strict: true });
  assert.equal(verdict.kind, 'refused');
  assert.match(verdict.kind === 'refused' ? verdict.diagnostic : '', /strict CLI version checking/);
});

test('classifyCliVersion: strict mode still accepts an exactly tested version', () => {
  assert.deepEqual(classifyCliVersion('2.1.267', { ...POLICY, strict: true }), { kind: 'supported' });
});

test('classifyCliVersion: every refusal diagnostic names the version and is actionable', () => {
  for (const version of ['2.1.266', '3.0.0', 'untested-version']) {
    const verdict = classifyCliVersion(version, POLICY);
    assert.equal(verdict.kind, 'refused', `${version} should be refused`);
    const diagnostic = verdict.kind === 'refused' ? verdict.diagnostic : '';
    assert.ok(diagnostic.includes(version), `diagnostic for ${version} must name it: ${diagnostic}`);
    assert.ok(diagnostic.length > 40, `diagnostic for ${version} is too terse to act on: ${diagnostic}`);
  }
});

test('the shipped defaults accept the CLI version that this change exists to unblock', () => {
  // Guards the shipped constants, not just the injectable policy: if MIN_SUPPORTED_CLI_VERSION or
  // MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE is ever edited into something that re-breaks a routine patch
  // bump, this fails.
  assert.equal(classifyCliVersion('2.1.269').kind, 'untested');
  assert.deepEqual(classifyCliVersion('2.1.267'), { kind: 'supported' });
  assert.ok(TESTED_CLI_VERSIONS.has(MIN_SUPPORTED_CLI_VERSION), 'the floor version should itself be a tested version');
});

test('MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE is derived from the floor, so it cannot go stale', () => {
  assert.equal(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE, '3.0.0');
  assert.equal(parseVersion(MIN_SUPPORTED_CLI_VERSION)![0] + 1, parseVersion(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE)![0]);
});

test('strictModeFromEnv: with no argument it reads the real process.env -- the only form index.ts calls', () => {
  // Every other assertion here passes an explicit env object, so the `env = process.env` default
  // binding is never taken by the suite -- yet `src/index.ts` calls it exactly one way, zero-arg.
  // Without this test, deleting strict mode entirely (making the default `{}`) leaves the suite green.
  const KEY = 'VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION';
  const prior = process.env[KEY];
  try {
    delete process.env[KEY];
    assert.equal(strictModeFromEnv(), false);
    process.env[KEY] = '1';
    assert.equal(strictModeFromEnv(), true);
    process.env[KEY] = '0';
    assert.equal(strictModeFromEnv(), false);
  } finally {
    if (prior === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = prior;
    }
  }
});

test('strictModeFromEnv: only 1/true enable it; an empty or absent value does not', () => {
  assert.equal(strictModeFromEnv({}), false);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: '' }), false);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: '0' }), false);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: 'no' }), false);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: '1' }), true);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: 'true' }), true);
  assert.equal(strictModeFromEnv({ VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION: ' TRUE ' }), true);
});
