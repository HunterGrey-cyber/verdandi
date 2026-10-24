import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The runtime package knows accounts only as explicit directories. A host's way of arriving at them --
 * a name that expands to a directory pair, the launcher variable that names it -- belongs to the host
 * (the sidecar's legacy module, for the hosts that still send names). Read from the sources, so a
 * convention that creeps back in fails here rather than in a review.
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []));
}

test('the package source holds no name-to-directory convention', () => {
  const files = sources(SRC);
  assert.ok(files.length > 10, 'the scan must find the package sources');
  const offences: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/\.claude-\$|anthropic-\$|\.claude-<|anthropic-<|VERDANDI_CLAUDE_ACCOUNT/.test(line)) {
        offences.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offences, []);
});

test('CLAUDE_PROFILE appears only in the account mechanism, which exports the label under it', () => {
  const users = sources(SRC).filter((file) => readFileSync(file, 'utf8').includes('CLAUDE_PROFILE'));
  assert.deepEqual(users.map((file) => file.slice(SRC.length)), ['account.ts']);
});
