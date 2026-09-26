import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLAUDE_AGENT_SDK_VERSION,
  SDK_DECLARED_CLAUDE_CODE_VERSION,
  SIDECAR_VERSION,
} from '../src/generated/sdkVersions.js';

/**
 * The drift guard that makes baking these safe.
 *
 * Production used to read all three at module load -- `require.resolve` for the SDK's entry, then
 * `readFileSync` of its package.json and manifest.json beside it. That is correct in a checkout and
 * fatal in a shipped artifact: there is no node_modules inside a single-file executable, so the
 * bundle BUILDS clean and dies on its first run with MODULE_NOT_FOUND, before it has bound anything.
 * Measured 2026-09-18 while proving the SEA shape out.
 *
 * So the values are generated into src/generated/sdkVersions.ts at build time instead, and the
 * runtime resolution moves HERE, where node_modules always exists. This test is the only thing
 * standing between a stale generated file and a handshake that reports a version this process is
 * not running -- which is the same defect `getActualClaudeCodeVersion(hostCliPath)` exists to
 * prevent one layer down: measuring one thing and running another.
 */
const require = createRequire(import.meta.url);
const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const readJson = (path: string): { version: string } => JSON.parse(readFileSync(path, 'utf8')) as { version: string };

test('generated CLAUDE_AGENT_SDK_VERSION matches the installed SDK package', () => {
  assert.equal(CLAUDE_AGENT_SDK_VERSION, readJson(join(sdkDir, 'package.json')).version);
});

test('generated SDK_DECLARED_CLAUDE_CODE_VERSION matches the installed SDK manifest', () => {
  assert.equal(SDK_DECLARED_CLAUDE_CODE_VERSION, readJson(join(sdkDir, 'manifest.json')).version);
});

test('generated SIDECAR_VERSION matches this workspace package.json', () => {
  assert.equal(SIDECAR_VERSION, readJson(new URL('../../package.json', import.meta.url).pathname).version);
});
