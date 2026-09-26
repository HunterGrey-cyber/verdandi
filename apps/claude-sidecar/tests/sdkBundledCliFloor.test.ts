import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyCliVersion, MIN_SUPPORTED_CLI_VERSION } from '../src/cliCompatibility.js';
import { getSdkDeclaredClaudeCodeVersion } from '../src/runtimeServiceImpl.js';

/**
 * Guards `MIN_SUPPORTED_CLI_VERSION` against the CLI that is actually installed inside
 * `@anthropic-ai/claude-agent-sdk` right now, rather than against a number written down next to it.
 *
 * **Why this is a test and not a runtime derivation.** The obvious "fix" is to stop hardcoding the
 * floor and compute it from the SDK manifest at startup. That is worse than useless: it would make
 * the sdk-bundled binary impossible to classify as out-of-range *by construction* -- the floor would
 * follow whatever the SDK ships, so the gate would read vacuously true for exactly the binary the
 * floor was lowered to admit. A gate that cannot fail for its own subject is not a gate. The floor
 * stays a literal, deliberately edited with evidence; this test is what notices when reality moves
 * out from under it.
 *
 * **The drift this catches.** The repo root pins the SDK as `"@anthropic-ai/claude-agent-sdk":
 * "^0.3.0"` -- a caret. A future `npm ci` is free to resolve a different 0.3.x, and each SDK release
 * carries its own bundled CLI, so the bundled CLI can move *below* the floor with no edit to any
 * file in this repository. Nothing else would notice:
 *
 *   - `startSidecar` classifies both binaries BEFORE the socket is bound, so a refusal means the
 *     socket never appears at all;
 *   - a host process waiting on that socket therefore sees a connect timeout, not a version error;
 *   - the only statement of the real cause is one line on this process's stderr, which a host that
 *     spawned it for its Agent pane generally is not showing anyone.
 *
 * The result is a downstream outage, possibly months after the merge that set this floor, with no
 * code change to blame and a symptom that points at the network layer. Hence a cheap, spawn-free
 * assertion that runs in the ordinary suite.
 *
 * Spawns nothing: the SDK's manifest is its own declaration of the CLI it ships, which is precisely
 * what a `sdk_bundled` session runs.
 */

/**
 * Resolved here rather than imported from `runtimeServiceImpl`, so the test's input does not come
 * from the module it is checking. `getSdkDeclaredClaudeCodeVersion()` is then asserted to agree,
 * which is what keeps the production read and this one from drifting apart silently.
 */
function readInstalledSdkDeclaredCliVersion(): string {
  const require = createRequire(import.meta.url);
  const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const manifestPath = join(dirname(sdkEntryPath), 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  assert.equal(
    typeof manifest.version,
    'string',
    `${manifestPath} has no string "version" -- the SDK changed the shape this gate reads, which is itself the finding`,
  );
  return manifest.version as string;
}

test('the installed sdk_bundled CLI is not refused by the shipped floor', () => {
  const sdkDeclared = readInstalledSdkDeclaredCliVersion();

  const verdict = classifyCliVersion(sdkDeclared);
  assert.notEqual(
    verdict.kind,
    'refused',
    `the CLI bundled in the installed @anthropic-ai/claude-agent-sdk is ${sdkDeclared}, which the ` +
      `shipped policy REFUSES (MIN_SUPPORTED_CLI_VERSION = ${MIN_SUPPORTED_CLI_VERSION}). A session ` +
      `with executable: 'sdk_bundled' runs that binary, and startSidecar classifies it before the ` +
      `socket is bound -- so this ships as "connect timeout" to whatever host spawns this sidecar, ` +
      `with the real reason only on stderr. Either lower the floor with evidence, or pin the SDK ` +
      `off the caret. Verdict was: ` +
      `${verdict.kind === 'refused' ? verdict.diagnostic : verdict.kind}`,
  );
});

test('the production sdk-declared version probe reads the same manifest this guard does', () => {
  // Without this, the guard above could keep passing while runtimeServiceImpl started sourcing the
  // gated version from somewhere else entirely -- the guard would be watching a value nothing uses.
  assert.equal(getSdkDeclaredClaudeCodeVersion(), readInstalledSdkDeclaredCliVersion());
});
