import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { M1FixtureManifest } from './m1FixtureManifest.js';

/**
 * Pins the M1 fixtures that P2 (kernel/sidecar), P3 (controlplane error mapping) and P6 (consumer
 * usage checks) build their tests on. These files are REAL recordings from the work account;
 * this suite checks they still say what the manifest claims, so a hand edit that turns them into
 * something no CLI ever produced fails here rather than in a later plan's green test.
 */
const DIR = fileURLToPath(new URL('../../tests/fixtures/m1/', import.meta.url));
const read = (file: string): unknown => JSON.parse(readFileSync(join(DIR, file), 'utf8'));
const manifest = read('manifest.json') as M1FixtureManifest;
type Obj = Record<string, unknown>;

test('m1 fixtures: v1 manifest, and every file it names exists', () => {
  assert.equal(manifest.schema, 'verdandi.m1-fixtures/v1');
  for (const file of Object.values(manifest.files)) {
    assert.ok(existsSync(join(DIR, file)), file);
  }
  for (const key of ['success_messages', 'success_init', 'success_result', 'success_account_info', 'success_prompt']) {
    assert.ok(manifest.files[key], key);
  }
  // Cross-plan ruling R1: P6 rebuilds the exact prompt that produced the recorded usage from this file.
  const prompt = read(manifest.files.success_prompt as string) as Obj;
  for (const key of ['system_prompt', 'user_message']) {
    assert.equal(typeof prompt[key], 'string', key);
    assert.notEqual(prompt[key], '', key);
  }
});

test('m1 fixtures: the success result is a zero-tool structured result with the four consumer arrays', () => {
  const result = read(manifest.files.success_result as string) as Obj;
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.is_error, false);
  const output = result.structured_output as Obj;
  for (const key of ['scores', 'picks', 'events', 'weekly']) {
    assert.ok(Array.isArray(output[key]), key);
  }
});

test('m1 fixtures: the usage split agrees with manifest.usage_shape', () => {
  const result = read(manifest.files.success_result as string) as Obj;
  const usage = result.usage as Record<string, number>;
  const cached = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  assert.equal(usage.input_tokens < cached, manifest.usage_shape === 'cache_dominant');
  const modelUsage = result.modelUsage as Record<string, Record<string, number>>;
  const total = Object.values(modelUsage).reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0), 0);
  assert.ok(total > 1_000, `modelUsage input total ${total}`);
});

test('m1 fixtures: init tools stay within the recorded carrier and the mode matches the manifest', () => {
  const init = read(manifest.files.success_init as string) as Obj;
  assert.equal(init.permissionMode, manifest.permission_mode);
  const tools = init.tools as string[];
  assert.deepEqual([...tools].sort(), [...manifest.init_tools].sort());
  assert.ok(tools.every((tool) => tool === manifest.carrier_tool), JSON.stringify(tools));
});

test('m1 fixtures: failure fixtures never carry a structured result', () => {
  // Not "never subtype success": the measured schema failure IS a success/is_error=false result
  // that delivered no structured_output (two rejected StructuredOutput calls, then plain text).
  for (const [key, file] of Object.entries(manifest.files)) {
    if (!key.endsWith('_result') || key.startsWith('success')) {
      continue;
    }
    const result = read(file) as Obj;
    assert.equal(result.structured_output, undefined, key);
  }
});

test('m1 fixtures: redaction held (no home paths, only example.invalid addresses)', () => {
  for (const file of readdirSync(DIR)) {
    const text = readFileSync(join(DIR, file), 'utf8');
    assert.equal(/\/home\/(?!m1-probe)/.test(text), false, `${file} contains a home path`);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    assert.deepEqual(emails.filter((e) => !e.endsWith('@example.invalid')), [], file);
  }
});
