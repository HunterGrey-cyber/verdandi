import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SIDECAR_DIR } from './compat/paths.js';

/**
 * `build:binary` leaves dist-bin/manifest.json beside the artifact: what a consumer needs to know
 * about the file without running it (and a way to detect that the file is not the one described).
 * The real build is exercised by hand and recorded in the commit that added this; what can be held
 * offline is the manifest's content and its checker, on a stand-in artifact.
 */

type Manifest = {
  v: number;
  artifact: { file: string; platform: string; arch: string; sidecar_version: string; sha256: string; size_bytes: number };
  node: { version: string; tarball_sha256: string };
  build_stamp: string;
  bundled_packages: Array<{ name: string; version: string; license: string | null }>;
};
const lib = (await import(pathToFileURL(join(SIDECAR_DIR, 'scripts', 'buildManifest.mjs')).href)) as {
  describeBuild: (input: unknown) => Manifest;
  checkManifest: (distBin: string) => string[];
  bundledPackages: (metafile: unknown, repoRoot: string) => Manifest['bundled_packages'];
};

function standIn(): { dir: string; manifest: Manifest } {
  const dir = mkdtempSync(join(tmpdir(), 'build-manifest-'));
  const file = 'verdandi-claude-sidecar-1.2.3-linux-x64';
  writeFileSync(join(dir, file), 'pretend this is an executable');
  const manifest = lib.describeBuild({
    distBin: dir,
    file,
    platform: 'linux-x64',
    sidecarVersion: '1.2.3',
    node: { version: 'v22.0.0', tarballSha256: 'a'.repeat(64) },
    buildStamp: '0123456789abcdef',
    packages: [],
  });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

test('manifest: names the artifact, its platform and arch, version, size and SHA-256, and the Node inside it', () => {
  const { dir, manifest } = standIn();
  try {
    assert.equal(manifest.v, 1);
    assert.deepEqual(manifest.artifact, {
      file: 'verdandi-claude-sidecar-1.2.3-linux-x64',
      platform: 'linux',
      arch: 'x64',
      sidecar_version: '1.2.3',
      sha256: createHash('sha256').update('pretend this is an executable').digest('hex'),
      size_bytes: 'pretend this is an executable'.length,
    });
    assert.deepEqual(manifest.node, { version: 'v22.0.0', tarball_sha256: 'a'.repeat(64) });
    assert.equal(manifest.build_stamp, '0123456789abcdef');
    assert.deepEqual(lib.checkManifest(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: the checker catches a file that is not the one described', () => {
  const { dir } = standIn();
  try {
    writeFileSync(join(dir, 'verdandi-claude-sidecar-1.2.3-linux-x64'), 'tampered');
    const problems = lib.checkManifest(dir);
    assert.ok(problems.some((p) => /sha256/.test(p)), problems.join('\n'));
    rmSync(join(dir, 'verdandi-claude-sidecar-1.2.3-linux-x64'));
    assert.ok(lib.checkManifest(dir).some((p) => /missing/.test(p)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: the checker flags an artifact.file that is not the name its own fields give', () => {
  const { dir } = standIn();
  try {
    const path = join(dir, 'manifest.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    doc.artifact.arch = 'arm64';
    writeFileSync(path, JSON.stringify(doc));
    const problems = lib.checkManifest(dir);
    assert.ok(problems.some((p) => /artifact\.file .* is not verdandi-claude-sidecar-<version>-<platform>-<arch>/.test(p)), problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundledPackages: lists the npm packages in the bundle with their licences, and leaves out our own sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'bundled-pkgs-'));
  try {
    const pkg = (rel: string, json: object) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, 'package.json'), JSON.stringify(json));
    };
    pkg('node_modules/zeta', { name: 'zeta', version: '1.0.0', license: 'MIT' });
    pkg('node_modules/@scope/alpha', { name: '@scope/alpha', version: '2.1.0', license: { type: 'Apache-2.0' } });
    pkg('node_modules/legacy', { name: 'legacy', version: '0.1.0', licenses: [{ type: 'MIT', url: 'x' }, { type: 'Apache-2.0', url: 'y' }] });
    pkg('node_modules/zeta/node_modules/inner', { name: 'inner', version: '0.3.0' });
    pkg('node_modules/@anthropic-ai/claude-agent-sdk', { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.252', license: 'SEE LICENSE IN LICENSE.md' });
    const metafile = {
      inputs: {
        'apps/claude-sidecar/dist/src/index.js': {},
        'packages/claude-runtime/dist/src/kernel.js': {},
        'node_modules/legacy/index.js': {},
        'node_modules/zeta/lib/a.js': {},
        'node_modules/zeta/lib/b.js': {},
        'node_modules/@scope/alpha/index.js': {},
        'node_modules/zeta/node_modules/inner/i.js': {},
        'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs': {},
      },
    };
    assert.deepEqual(lib.bundledPackages(metafile, root), [
      { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.252', license: 'SEE LICENSE IN LICENSE.md' },
      { name: '@scope/alpha', version: '2.1.0', license: 'Apache-2.0' },
      { name: 'inner', version: '0.3.0', license: null },
      { name: 'legacy', version: '0.1.0', license: 'MIT OR Apache-2.0' },
      { name: 'zeta', version: '1.0.0', license: 'MIT' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
