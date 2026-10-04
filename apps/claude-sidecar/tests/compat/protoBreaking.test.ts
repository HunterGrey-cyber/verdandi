import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileProto, compileProtoText, diffProtos, modelOf, type ProtoModel } from './protoModel.js';
import { CURRENT_PROTO, FROZEN_PROTO } from './paths.js';
import { BREAKING, HARMLESS } from './protoMutations.js';

/**
 * (a) The proto breaking-change check: the CURRENT runtime.proto against the FROZEN copy of the one
 * Eitri 0.2.0 was built against (Verdandi b3aa188, tests/compat/b3aa188/runtime.proto).
 *
 * The rule: package and service, the eight RPC names, every existing
 * field's tag / type / meaning, every enum value's number, and the reserved tag in
 * WatchSessionEventsRequest stay. Anything ADDED is fine; the additions are printed so a reviewer sees
 * what a change grew.
 *
 * The checker itself (protoModel.ts) is proven below the real comparison: a table of one-at-a-time
 * mutations of the frozen proto, each of which must be reported, and of harmless ones, each of which
 * must not. That table is the permanent form of "mutate one thing and see red".
 */

const frozenText = readFileSync(FROZEN_PROTO, 'utf8');
const frozen: ProtoModel = modelOf(compileProto(FROZEN_PROTO));

test('the current runtime.proto is the frozen one plus additions: nothing Eitri 0.2.0 relies on moved', () => {
  const diff = diffProtos(frozen, modelOf(compileProto(CURRENT_PROTO)));
  assert.deepEqual(diff.breaking, [], `the live proto breaks a client generated from b3aa188's:\n  ${diff.breaking.join('\n  ')}`);
  if (diff.additions.length > 0) {
    console.log(`runtime.proto has grown since b3aa188 (additive, allowed):\n  ${diff.additions.join('\n  ')}`);
  }
});

test('the frozen proto is what Eitri 0.2.0 was built against: one service with the eight RPCs, and field 2 of WatchSessionEventsRequest reserved', () => {
  assert.equal(frozen.package, 'verdandi.claude.runtime.v1');
  assert.equal(frozen.syntax, 'proto3');
  const service = frozen.services.get('verdandi.claude.runtime.v1.RuntimeService');
  assert.ok(service !== undefined, 'RuntimeService');
  assert.deepEqual(
    [...service.keys()].sort(),
    ['CloseSession', 'CreateSession', 'Handshake', 'InterruptTurn', 'ResolvePermission', 'SendTurn', 'SetPermissionMode', 'WatchSessionEvents'],
  );
  const watch = frozen.messages.get('verdandi.claude.runtime.v1.WatchSessionEventsRequest');
  assert.deepEqual(watch?.reservedRanges, [[2, 2]]);
  // The nine fields Eitri's request states, one per tag, in this order.
  const policy = frozen.messages.get('verdandi.claude.runtime.v1.ClaudeHostPolicy');
  assert.deepEqual(
    [...(policy?.fields.values() ?? [])].map((f) => `${f.number}:${f.name}`),
    ['1:configuration', '2:permissions', '3:persistence', '4:executable', '5:streaming', '6:tool_policy', '7:setting_sources', '8:permission_mode_switchable', '9:provider_permission_prompts'],
  );
});

// ---- The checker against known mutations --------------------------------------------------------

function breakingOf(mutated: string): string[] {
  return diffProtos(frozen, modelOf(compileProtoText(mutated))).breaking;
}

function additionsOf(mutated: string): { breaking: string[]; additions: string[] } {
  return diffProtos(frozen, modelOf(compileProtoText(mutated)));
}

for (const { name, mutate, reported } of BREAKING) {
  test(`the checker reports it when ${name}`, () => {
    const breaking = breakingOf(mutate(frozenText));
    assert.ok(breaking.length > 0, `not reported at all`);
    assert.ok(breaking.some((line) => reported.test(line)), `reported, but not as expected:\n  ${breaking.join('\n  ')}`);
  });
}

for (const { name, mutate, added } of HARMLESS) {
  test(`the checker accepts it when ${name}`, () => {
    const diff = additionsOf(mutate(frozenText));
    assert.deepEqual(diff.breaking, [], `an additive change was reported as breaking:\n  ${diff.breaking.join('\n  ')}`);
    if (added !== undefined) {
      assert.ok(diff.additions.some((line) => added.test(line)), `the addition is not listed:\n  ${diff.additions.join('\n  ')}`);
    } else {
      assert.deepEqual(diff.additions, []);
    }
  });
}

test('the unmodified frozen proto compares clean against itself, with no additions', () => {
  assert.deepEqual(diffProtos(frozen, modelOf(compileProtoText(frozenText))), { breaking: [], additions: [] });
});
