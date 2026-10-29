import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { classifyCliVersion, type CliSurface, type CliCompatibilityPolicy } from '../src/cliCompatibility/index.js';

// Source paths work in a checkout and in the public export, even from dist/tests.
const master = new URL('../../src/cliCompatibility/', import.meta.url);
type Case = {
  version: string; surface: CliSurface;
  policy: Omit<CliCompatibilityPolicy, 'tested' | 'knownIncompatible'> & {
    tested?: string[]; knownIncompatible?: string[];
  };
  verdict: { kind: string; reason?: string };
};
const cases: Case[] = JSON.parse(readFileSync(new URL('cli-compatibility.cases.json', master), 'utf8'));
for (const [i, c] of cases.entries()) {
  test(`golden ${i}: ${c.surface} ${JSON.stringify(c.version)} -> ${c.verdict.reason ?? c.verdict.kind}`, () => {
    const policy: CliCompatibilityPolicy = {
      ...c.policy,
      tested: c.policy.tested === undefined ? undefined : new Set(c.policy.tested),
      knownIncompatible: c.policy.knownIncompatible === undefined ? undefined : new Set(c.policy.knownIncompatible),
    };
    const result = classifyCliVersion(c.version, {
      surface: c.surface, policy, wording: { strictSwitch: 'STRICT', dataFile: 'cli-compatibility.json' },
    });
    assert.deepEqual({ kind: result.kind, ...('reason' in result ? { reason: result.reason } : {}) }, c.verdict);
  });
}

test('Go embedded copies match both JSON masters byte for byte', (t) => {
  const te = new URL('../../../../te/', import.meta.url);
  if (!existsSync(te)) { t.skip('te/ absent in public export'); return; }
  for (const name of ['cli-compatibility.json', 'cli-compatibility.cases.json']) {
    assert.deepEqual(readFileSync(new URL(`clicompat/${name}`, te)), readFileSync(new URL(name, master)), name);
  }
});

test('CLI 2.1.311 recording evidence admits only the SDK surface', () => {
  assert.equal(classifyCliVersion('2.1.311', { surface: 'sdk', wording: { strictSwitch: 'STRICT', dataFile: 'cli-compatibility.json' } }).kind, 'supported');
  for (const surface of ['interactive', 'screen', 'transcript'] as const) {
    assert.equal(classifyCliVersion('2.1.311', { surface, wording: { strictSwitch: 'STRICT', dataFile: 'cli-compatibility.json' } }).kind, 'untested');
  }
});
