import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCliVersion as shared } from '@verdandi/claude-runtime/cli-compatibility';
import { classifyCliVersion, TESTED_CLI_VERSIONS, MIN_SUPPORTED_CLI_VERSION, MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE } from '../src/cliCompatibility.js';

const CORPUS = ['2.1.251','2.1.252','2.1.266','2.1.267','2.1.268','2.1.283','2.1.288','2.2.0','2.9.9','3.0.0','1.0.0','2.1.300-beta.1','','Claude Code','v2.1.267'];

test('the Claude sidecar answers exactly what the shared sdk surface answers', () => {
  const wording = { strictSwitch: 'VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION', dataFile: 'apps/claude-sidecar/src/cliCompatibility.ts' };
  for (const strict of [false, true]) for (const v of CORPUS)
    assert.deepEqual(classifyCliVersion(v, { strict }), shared(v, { surface: 'sdk', wording, policy: { strict } }), v);
  assert.deepEqual([...TESTED_CLI_VERSIONS], ['2.1.267', '2.1.252', '2.1.270', '2.1.283', '2.1.292', '2.1.311']);
  assert.equal(MIN_SUPPORTED_CLI_VERSION, '2.1.252'); assert.equal(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE, '3.0.0');
});
