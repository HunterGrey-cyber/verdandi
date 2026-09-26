import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { M1FixtureManifest } from '../probes/m1/report.js';

/**
 * Read access to the M1 recordings P1 committed (`tests/fixtures/m1/`, schema
 * `verdandi.m1-fixtures/v1`). Real work output, redacted: tests built on these check the
 * contract against what the CLI actually sends, not against a hand-written guess of it.
 *
 * Resolved from the compiled test's location (`dist/tests/`) back to the source tree, the same
 * way tests/m1Fixtures.test.ts does -- the JSON files are not copied into dist.
 */
export const M1_FIXTURE_DIR = fileURLToPath(new URL('../../tests/fixtures/m1/', import.meta.url));

export function m1Manifest(): M1FixtureManifest {
  return JSON.parse(readFileSync(join(M1_FIXTURE_DIR, 'manifest.json'), 'utf8')) as M1FixtureManifest;
}

/** The parsed fixture the manifest lists under `key`. Throws for a key the manifest lacks. */
export function readM1Fixture(key: string): unknown {
  const file = m1Manifest().files[key];
  if (file === undefined) {
    throw new Error(`the M1 manifest lists no fixture ${JSON.stringify(key)}`);
  }
  return JSON.parse(readFileSync(join(M1_FIXTURE_DIR, file), 'utf8')) as unknown;
}

/** Manifest keys of every recorded non-success result message, e.g. `schema-unsatisfiable_result`. */
export function m1FailureResultKeys(): string[] {
  return Object.keys(m1Manifest().files)
    .filter((key) => key.endsWith('_result') && !key.startsWith('success'))
    .sort();
}
