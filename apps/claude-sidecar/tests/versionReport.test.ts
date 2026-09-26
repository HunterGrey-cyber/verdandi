import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionReport } from '../src/versionReport.js';
import { SIDECAR_VERSION, CLAUDE_AGENT_SDK_VERSION, SDK_DECLARED_CLAUDE_CODE_VERSION } from '../src/generated/sdkVersions.js';
import { MIN_SUPPORTED_CLI_VERSION, MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE } from '../src/cliCompatibility.js';

/**
 * `--version` exists for a question a packaged artifact has to be able to answer about itself:
 * *which Node is inside the binary I shipped?*
 *
 * Accepting the SEA shape means this package now carries someone else's runtime -- when Node has a
 * CVE, the artifact carries it until it is rebuilt, which a `depends: nodejs` package would not.
 * That trade is fine only if the answer is readable from the artifact without unpacking it, months
 * after the release, for a binary already sitting in a mirror. `process.version` is the honest
 * source: it is the runtime actually executing, so it cannot drift from a value stamped beside it.
 *
 * Deliberately spawns nothing. A `--version` that shells out to the host CLI would fail on exactly
 * the hosts this whole line of work is about -- one whose PATH `claude` is a guarded launcher.
 */

test('versionReport: names the Node runtime inside the artifact', () => {
  assert.match(versionReport({ sdkBundledAvailable: false }), new RegExp(`node ${process.version.replace(/\./g, '\\.')}`));
});

test('versionReport: leads with the sidecar version, which is the compatibility token a client range-checks', () => {
  assert.match(versionReport({ sdkBundledAvailable: false }), new RegExp(`^verdandi-claude-sidecar ${SIDECAR_VERSION.replace(/\./g, '\\.')}\\b`));
});

test('versionReport: reports both Claude Code version facts and the range it accepts', () => {
  const report = versionReport({ sdkBundledAvailable: true });
  assert.ok(report.includes(CLAUDE_AGENT_SDK_VERSION), `missing agent SDK version in:\n${report}`);
  assert.ok(report.includes(SDK_DECLARED_CLAUDE_CODE_VERSION), `missing sdk-declared CLI version in:\n${report}`);
  assert.ok(report.includes(MIN_SUPPORTED_CLI_VERSION), `missing supported-range floor in:\n${report}`);
  assert.ok(report.includes(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE), `missing supported-range ceiling in:\n${report}`);
});

/** The same fact the handshake advertises, readable without a socket -- so `--version` answers "what
 * will this artifact refuse?" for a binary nobody has started yet. */
test('versionReport: states which executable sources this build serves', () => {
  assert.match(versionReport({ sdkBundledAvailable: true }), /host_cli, sdk_bundled/);
  assert.match(versionReport({ sdkBundledAvailable: false }), /host_cli(?!, sdk_bundled)/);
});

/**
 * A built artifact goes stale against a workspace dependency SILENTLY, and the only signal is
 * behaviour. Measured downstream 2026-09-18: a conformance run failed against the artifact and
 * passed against a checkout -- the same control shape that had misled both of us the day before --
 * and the cause was neither packaging nor the test. The SEA bundles `packages/claude-runtime`, the
 * artifact predated a fix there, and nothing anywhere said so. The same class cost a second hour
 * earlier that evening, when a rebuild of only this workspace left the old runtime dist in place and
 * a re-run "proved" a fix that was never in the binary.
 *
 * The build script now makes that impossible rather than visible (it runs the whole claude fan-out).
 * This is the other half: a vendored binary sitting in a mirror must be able to answer "which build
 * is this?" without diffing behaviour against another copy.
 */
test('versionReport: carries a build stamp, so two artifacts can be told apart without running them', () => {
  assert.match(versionReport({ sdkBundledAvailable: false }), /build [0-9a-f]{16}|build dev/);
});

test('versionReport: an unbundled checkout says dev rather than inventing a stamp', () => {
  // The stamp is injected by the release build; a checkout has no honest value for it, and a
  // fabricated one would be worse than none -- it is the field people will compare.
  assert.match(versionReport({ sdkBundledAvailable: true }), /build dev/);
});
