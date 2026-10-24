import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SIDECAR_DIR } from './compat/paths.js';

/**
 * node-pin.json is the one place that says which Node the packaged artifact carries. These tests hold
 * the two halves of that: the file is well-formed, and buildBinary.mjs is what enforces it -- a build
 * against a tarball whose checksum differs from the pin must stop, before it compiles anything.
 */

const SCRIPT = join(SIDECAR_DIR, 'scripts', 'buildBinary.mjs');
const PLATFORM = `${process.platform}-${process.arch}`;

type Pin = { version: string; tarballSha256: Record<string, string> };
const { loadNodePin } = (await import(pathToFileURL(join(SIDECAR_DIR, 'scripts', 'nodePin.mjs')).href)) as {
  loadNodePin: (workspaceRoot: string) => Pin;
};

test('node-pin.json: names a version and a SHA-256 for both supported Linux targets', () => {
  const pin = loadNodePin(SIDECAR_DIR);
  assert.match(pin.version, /^v\d+\.\d+\.\d+$/);
  for (const platform of ['linux-x64', 'linux-arm64']) {
    assert.match(pin.tarballSha256[platform] ?? '', /^[0-9a-f]{64}$/, platform);
  }
});

test('node-pin.json: a malformed pin is refused rather than read loosely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-pin-'));
  try {
    const write = (doc: unknown) => writeFileSync(join(dir, 'node-pin.json'), JSON.stringify(doc));
    const good = { version: 'v22.23.2', tarball_sha256: { 'linux-x64': 'a'.repeat(64) } };
    write(good);
    assert.equal(loadNodePin(dir).version, 'v22.23.2');
    for (const [label, bad] of [
      ['a version without the leading v', { ...good, version: '22.23.2' }],
      ['a range instead of a version', { ...good, version: 'v22' }],
      ['no checksums', { version: good.version, tarball_sha256: {} }],
      ['a short checksum', { ...good, tarball_sha256: { 'linux-x64': 'abc' } }],
      ['an upper-case checksum', { ...good, tarball_sha256: { 'linux-x64': 'A'.repeat(64) } }],
    ] as const) {
      write(bad);
      assert.throws(() => loadNodePin(dir), /node-pin:/, label);
    }
    rmSync(join(dir, 'node-pin.json'));
    assert.throws(() => loadNodePin(dir), /cannot read or parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildBinary.mjs carries no Node version or checksum of its own', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/\b[0-9a-f]{64}\b/.test(script), 'a SHA-256 literal in the build script is a second source');
  assert.ok(!/['"`]v\d+\.\d+\.\d+['"`]/.test(script), 'a Node version literal in the build script is a second source');
  assert.ok(script.includes('loadNodePin('), 'the build script does not read the pin');
});

/**
 * Runs the real buildBinary.mjs in a throwaway copy of the workspace layout (apps/claude-sidecar/
 * {scripts,node-pin.json}) whose download cache already holds `tarball`. Nothing is downloaded: the
 * script only fetches when the cache is empty.
 */
function buildAgainst(pinnedSha: string | undefined, tarball: Buffer, staleManifest = false) {
  const root = mkdtempSync(join(tmpdir(), 'node-pin-build-'));
  const workspace = join(root, 'apps', 'claude-sidecar');
  const pin = loadNodePin(SIDECAR_DIR);
  try {
    mkdirSync(join(workspace, 'build', 'node-cache'), { recursive: true });
    cpSync(join(SIDECAR_DIR, 'scripts'), join(workspace, 'scripts'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    writeFileSync(
      join(workspace, 'node-pin.json'),
      JSON.stringify({ version: pin.version, tarball_sha256: { ...(pinnedSha === undefined ? {} : { [PLATFORM]: pinnedSha }), 'other-os': 'b'.repeat(64) } }),
    );
    const cached = join(workspace, 'build', 'node-cache', `node-${pin.version}-${PLATFORM}.tar.xz`);
    writeFileSync(cached, tarball);
    const manifest = join(workspace, 'dist-bin', 'manifest.json');
    if (staleManifest) {
      mkdirSync(join(workspace, 'dist-bin'), { recursive: true });
      writeFileSync(manifest, '{"left":"by an earlier build"}\n');
    }
    const result = spawnSync(process.execPath, [join(workspace, 'scripts', 'buildBinary.mjs')], { encoding: 'utf8', cwd: root });
    return { ...result, cacheKept: existsSync(cached), manifestKept: existsSync(manifest) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('build:binary stops on a tarball whose SHA-256 is not the pinned one, before compiling anything', () => {
  const result = buildAgainst('c'.repeat(64), Buffer.from('not the node tarball'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the pinned c{64} -- refusing to build an artifact around an unverified runtime/);
  assert.equal(result.cacheKept, false, 'the mismatching cached copy is removed so the next run re-downloads');
  assert.ok(!result.stderr.includes('building TypeScript'), 'the check must come before the expensive steps');
});

test('build:binary, control: the same tarball with its true SHA-256 pinned passes the check', () => {
  const tarball = Buffer.from('not the node tarball');
  const result = buildAgainst(createHash('sha256').update(tarball).digest('hex'), tarball);
  // It then fails further on (the stub is not a real build tree) -- what matters is that the check let it by.
  assert.match(result.stderr, /verified node-v\S+ against its pinned checksum/);
  assert.doesNotMatch(result.stderr, /does not match the pinned/);
});

test('build:binary refuses a platform the pin has no checksum for', () => {
  const result = buildAgainst(undefined, Buffer.from('x'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`no pinned Node tarball for ${PLATFORM}`));
});

test('build:binary removes the previous build\'s manifest up front, so a failed rebuild leaves none', () => {
  const tarball = Buffer.from('not the node tarball');
  const result = buildAgainst(createHash('sha256').update(tarball).digest('hex'), tarball, true);
  // The stub is not a real build tree, so the run fails at the compile step -- after the manifest's
  // fate was decided and long before a new one could have been written.
  assert.notEqual(result.status, 0);
  assert.equal(result.manifestKept, false, 'a manifest from an earlier build survived a build that did not finish');
  // A refused tarball stops even earlier, but still after the removal.
  assert.equal(buildAgainst('c'.repeat(64), tarball, true).manifestKept, false);
});

test('extractVerifiedNode: always unpacks from the tarball, discarding any extraction already on disk', async () => {
  const { extractVerifiedNode } = (await import(pathToFileURL(join(SIDECAR_DIR, 'scripts', 'extractNode.mjs')).href)) as {
    extractVerifiedNode: (input: { tarballPath: string; cacheDir: string; version: string; platform: string }) => string;
  };
  const root = mkdtempSync(join(tmpdir(), 'extract-node-'));
  try {
    const name = 'node-v0.0.0-test-x64';
    mkdirSync(join(root, 'src', name, 'bin'), { recursive: true });
    writeFileSync(join(root, 'src', name, 'bin', 'node'), 'the bytes in the verified tarball');
    const cacheDir = join(root, 'cache');
    mkdirSync(join(cacheDir, name, 'bin'), { recursive: true });
    const tarballPath = join(cacheDir, `${name}.tar.xz`);
    const packed = spawnSync('tar', ['cJf', tarballPath, '-C', join(root, 'src'), name], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);

    // A leftover extraction that is not what the tarball holds -- tampered, or from another pin.
    writeFileSync(join(cacheDir, name, 'bin', 'node'), 'tampered executable');
    writeFileSync(join(cacheDir, name, 'bin', 'stray'), 'not in the tarball');

    const node = extractVerifiedNode({ tarballPath, cacheDir, version: 'v0.0.0', platform: 'test-x64' });
    assert.equal(node, join(cacheDir, name, 'bin', 'node'));
    assert.equal(readFileSync(node, 'utf8'), 'the bytes in the verified tarball');
    assert.ok(!existsSync(join(cacheDir, name, 'bin', 'stray')), 'the old extraction was not removed first');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A real build cannot run offline, so the wiring itself can only be pinned by reading the script; the
// behaviour it wires to is the test above.
test('buildBinary.mjs unpacks the base Node through extractVerifiedNode', () => {
  assert.ok(readFileSync(SCRIPT, 'utf8').includes('extractVerifiedNode('));
});
