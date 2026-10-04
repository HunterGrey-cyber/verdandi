import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SIDECAR_DIR, SIDECAR_ENTRY } from './paths.js';

/**
 * The build interface: what a development checkout of Eitri 0.2.0 drives. Eitri's sidecar
 * discovery runs `npm run build` (and, for a checkout, `build:claude`) and then starts
 * `apps/claude-sidecar/dist/src/index.js`; its installer and packaging glob
 * `apps/claude-sidecar/dist-bin/verdandi-claude-sidecar-<version>-<platform>-<arch>`.
 *
 * Static on purpose. A real `build:binary` downloads a pinned Node runtime, which an offline test
 * cannot do; what can be held offline is the names, and these are the names that would break a host
 * silently (a missing script is a spawn that "worked" and built nothing).
 */

test('the npm scripts Eitri runs are still there, under the same names', () => {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  // Eitri probes the ROOT package.json for `scripts.build` to tell a current checkout from an old one.
  assert.equal(typeof root.scripts.build, 'string');
  assert.equal(typeof root.scripts['build:claude'], 'string');
  const sidecar = JSON.parse(readFileSync(join(SIDECAR_DIR, 'package.json'), 'utf8')) as { main: string; scripts: Record<string, string> };
  assert.equal(typeof sidecar.scripts.build, 'string');
  assert.equal(typeof sidecar.scripts['build:binary'], 'string');
});

test('the sidecar\'s entry point is where Eitri starts it: apps/claude-sidecar/dist/src/index.js', () => {
  const sidecar = JSON.parse(readFileSync(join(SIDECAR_DIR, 'package.json'), 'utf8')) as { main: string };
  assert.equal(sidecar.main, './dist/src/index.js');
  assert.ok(existsSync(SIDECAR_ENTRY), `${SIDECAR_ENTRY} is not built`);
});

test('build:binary still names its artifact dist-bin/verdandi-claude-sidecar-<version>-<platform>-<arch>', () => {
  const script = readFileSync(join(SIDECAR_DIR, 'scripts', 'buildBinary.mjs'), 'utf8');
  assert.ok(script.includes("const platform = `${process.platform}-${process.arch}`;"), 'platform-arch suffix');
  assert.ok(script.includes("const outDir = join(workspaceRoot, 'dist-bin');"), 'output directory');
  assert.ok(script.includes('`verdandi-claude-sidecar-${sidecarVersion}-${platform}`'), 'artifact file name');
});
