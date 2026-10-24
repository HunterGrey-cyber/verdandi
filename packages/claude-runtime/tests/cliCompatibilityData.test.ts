import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testedVersionsFor, rangeFor, parseVersion, compareVersions, KNOWN_INCOMPATIBLE_CLI_VERSIONS }
  from '../src/cliCompatibility/index.js';
import { CLI_COMPATIBILITY, CLI_SURFACES } from '../src/cliCompatibility/index.js';

test('today\'s tested sets, verbatim and in order -- P0 adds entries, nothing else does', () => {
  assert.deepEqual(testedVersionsFor('sdk'), ['2.1.267', '2.1.252', '2.1.270', '2.1.283', '2.1.292']);
  assert.deepEqual(testedVersionsFor('interactive'), ['2.1.267', '2.1.268']);
  assert.deepEqual(testedVersionsFor('transcript'), []);
  assert.deepEqual(testedVersionsFor('screen'), ['2.1.293', '2.1.292', '2.1.288']);
  assert.equal(CLI_COMPATIBILITY.schema, 1);
  assert.deepEqual(CLI_SURFACES, ['sdk', 'interactive', 'screen', 'transcript']);
});

test('every entry is well-formed and inside the range of each surface it claims', () => {
  const seen = new Set<string>();
  for (const e of CLI_COMPATIBILITY.tested) {
    assert.ok(!seen.has(e.version), `duplicate ${e.version}`); seen.add(e.version);
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.ok(e.surfaces.length > 0 && e.evidence.trim() !== '');
    for (const s of e.surfaces) {
      assert.ok(CLI_SURFACES.includes(s));
      const r = rangeFor(s), v = parseVersion(e.version)!;
      assert.ok(compareVersions(v, parseVersion(r.min)!) >= 0 && compareVersions(v, parseVersion(r.maxExclusive)!) < 0, `${e.version} outside ${s}`);
    }
    assert.ok(!KNOWN_INCOMPATIBLE_CLI_VERSIONS.has(e.version));
  }
  assert.deepEqual(rangeFor('sdk'), { min: '2.1.252', maxExclusive: '3.0.0' });
  assert.deepEqual(rangeFor('screen'), { min: '2.1.278', maxExclusive: '2.2.0' });
  assert.deepEqual(rangeFor('interactive'), { min: '2.1.267', maxExclusive: '2.2.0' });
});
