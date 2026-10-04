import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SIDECAR_DIR } from './compat/paths.js';

/**
 * The prose that says what the contract is must not drift from the code and the file it describes. Three
 * tables are held here, the ones a host reads to decide what it may rely on:
 *
 *   - COMPATIBILITY.md's capability table against capabilities.json (name, order, the minor that
 *     introduced it, whether it is baseline);
 *   - COMPATIBILITY.md's list of notice kinds against the kinds the sources emit;
 *   - the sidecar README's environment-variable table against the `VERDANDI_CLAUDE_*` variables the
 *     sources read.
 *
 * All three files sit in directories the public export takes whole, and every source read here is one
 * it exports too, so the tests pass in the public tree as well.
 */

const CRATE = join(REPO_ROOT, 'crates', 'claude-runtime-protocol');
const compatibility = readFileSync(join(CRATE, 'COMPATIBILITY.md'), 'utf8');
const readme = readFileSync(join(SIDECAR_DIR, 'README.md'), 'utf8');
const source = JSON.parse(readFileSync(join(CRATE, 'capabilities.json'), 'utf8')) as {
  capabilities: Array<{ name: string; since_minor: number; baseline?: boolean }>;
};

/** Every `.ts` file under a source directory, except generated output. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.split('/').includes('generated'))
    .map((path) => join(dir, path));
}

const sources = [...sourceFiles(join(SIDECAR_DIR, 'src')), ...sourceFiles(join(REPO_ROOT, 'packages', 'claude-runtime', 'src'))];

/** The text of a `## ` section, up to the next `## `. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const body = markdown.slice(start + 1);
  const next = body.indexOf('\n## ', 4);
  return next === -1 ? body : body.slice(0, next);
}

test('COMPATIBILITY.md\'s capability table is capabilities.json: the same capabilities, in the same order, each with its minor and its baseline flag', () => {
  const rows = [...section(compatibility, 'Capabilities').matchAll(/^\| `([a-z0-9_]+)` \| (\d+) \| (yes|no) \|/gm)].map((m) => ({
    name: m[1],
    since_minor: Number(m[2]),
    baseline: m[3] === 'yes',
  }));
  assert.deepEqual(
    rows,
    source.capabilities.map((c) => ({ name: c.name, since_minor: c.since_minor, baseline: c.baseline === true })),
    'the table in COMPATIBILITY.md and capabilities.json disagree',
  );
});

test('COMPATIBILITY.md says every baseline capability once in its baseline paragraph', () => {
  const paragraph = section(compatibility, 'The rule').split('### The major-3 baseline')[1] ?? '';
  for (const capability of source.capabilities.filter((c) => c.baseline === true)) {
    assert.ok(paragraph.includes(`\`${capability.name}\``), `${capability.name} is baseline but the baseline paragraph does not name it`);
  }
});

test('COMPATIBILITY.md lists exactly the notice kinds the sources emit with a literal kind', () => {
  const emitted = new Set<string>();
  for (const file of sources) {
    for (const match of readFileSync(file, 'utf8').matchAll(/type:\s*'provider_notice',\s*kind:\s*'([a-z_]+)'/g)) {
      emitted.add(match[1]);
    }
  }
  assert.ok(emitted.size > 0, 'found no notice producers: the pattern this test looks for moved');
  const documented = new Set([...section(compatibility, 'Notices').matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...emitted].sort(), 'COMPATIBILITY.md\'s notice kinds and the sources disagree');
});

test('the sidecar README\'s environment table lists exactly the VERDANDI_CLAUDE_* variables the sources read', () => {
  const read = new Set<string>();
  for (const file of sources) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bVERDANDI_CLAUDE_[A-Z_]+\b/g)) {
      read.add(match[0]);
    }
  }
  const documented = new Set([...section(readme, 'Environment variables').matchAll(/^\| `(VERDANDI_CLAUDE_[A-Z_]+)` \|/gm)].map((m) => m[1]));
  assert.ok(read.size >= 10, `found only ${read.size} variables in the sources: the pattern moved`);
  assert.deepEqual([...documented].sort(), [...read].sort(), 'the README table and the sources disagree about the environment');
});
