import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIDECAR_DIR } from './compat/paths.js';

/**
 * BUILD-INTERFACE.md declares the stable build surface. It is only worth having if it keeps naming what
 * the build really has, and if it can travel with this directory into a public tree.
 */

const doc = readFileSync(join(SIDECAR_DIR, 'BUILD-INTERFACE.md'), 'utf8');

test('BUILD-INTERFACE.md names the three scripts, both output paths, the manifest, the pin and the rule', () => {
  for (const needle of [
    'npm run build`',
    'npm run build:claude`',
    'npm run build:binary -w @verdandi/claude-sidecar`',
    'apps/claude-sidecar/dist/src/index.js',
    'apps/claude-sidecar/dist-bin/verdandi-claude-sidecar-<version>-<platform>-<arch>',
    'dist-bin/manifest.json',
    'node-pin.json',
    '--version --json',
    'minor-or-major',
  ]) {
    assert.ok(doc.includes(needle), `BUILD-INTERFACE.md no longer mentions ${needle}`);
  }
});

test('BUILD-INTERFACE.md lists every field --version --json prints', () => {
  const options = { sdkBundledAvailable: true };
  return import('../src/versionReport.js').then(({ versionReportJson }) => {
    for (const field of Object.keys(JSON.parse(versionReportJson(options)))) {
      assert.ok(doc.includes(`\`${field}\``), `the --version --json field ${field} is not documented`);
    }
  });
});

test('the build-interface files carry no private path, host or name (this directory is exported whole)', () => {
  for (const file of ['BUILD-INTERFACE.md', 'node-pin.json', 'scripts/nodePin.mjs', 'scripts/buildManifest.mjs']) {
    const text = readFileSync(join(SIDECAR_DIR, file), 'utf8');
    assert.doesNotMatch(text, /\/home\/|\/data\/|huntergrey|\.cn\b|tailscale|\bgrey\b/i, `${file} names something private`);
  }
});
