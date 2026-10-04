import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileProto, compileProtoText, diffProtos, fingerprint, modelOf } from './compat/protoModel.js';
import { CURRENT_PROTO, FROZEN_PROTO, REPO_ROOT } from './compat/paths.js';

/**
 * `protocol_minor` is bumped by every additive wire change, and this is what makes that a rule instead
 * of a habit: the live `runtime.proto` is diffed against the frozen copy of the one Eitri 0.2.0 was built
 * against (tests/compat/b3aa188/, the same check the old-client suite runs for breaking changes), and
 * every addition it finds has to be written down under a minor AFTER the frozen proto's, in
 * crates/claude-runtime-protocol/capabilities.json's `minors` ledger, `wire_additions`, verbatim. So:
 *
 *   - a field added with no ledger entry fails (the additions are not recorded);
 *   - a ledger entry for an addition that is not in the proto fails (stale);
 *   - a recorded addition at a minor that is not above the frozen proto's cannot be, by construction.
 *
 * The plan asked for "the proto diff against the last tag adds a field without bumping minor". There is
 * no release tag yet, so the frozen proto is the baseline; when a host re-freezes against a newer proto,
 * FROZEN_PROTO_MINOR moves with it.
 *
 * A RELEASED minor is frozen. The minor is bumped per release that changes the wire, so unreleased
 * development may add several fields under one new minor, but once the release is cut, that minor means
 * exactly one wire. The cutter writes `"released": "<tag>"` and `"wire_fingerprint": "<sha256>"` into the
 * ledger entry (`npm run proto:fingerprint -w @verdandi/claude-sidecar` prints the fingerprint); from then on
 * the live proto's fingerprint -- a hash of what the proto MEANS, not of its bytes or comments -- has to equal it
 * while that entry is the current minor, so any later wire change needs a new minor. Nothing here uses git or
 * the network, so it holds in the public export too.
 */

/** The b3aa188 proto is protocol 3.12: everything capabilities.json's minors 0..12 describe is in it. */
const FROZEN_PROTO_MINOR = 12;

type SourceMinor = { minor: number; date: string; summary: string; wire_additions?: string[]; released?: string; wire_fingerprint?: string };
const source = JSON.parse(readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json'), 'utf8')) as {
  protocol: { major: number; minor: number };
  minors: SourceMinor[];
};

/** What a proto diff found and what the ledger recorded, side by side. */
function reconcile(additions: string[], minors: SourceMinor[], frozenMinor: number): { unrecorded: string[]; stale: string[] } {
  const recorded = minors.filter((m) => m.minor > frozenMinor).flatMap((m) => m.wire_additions ?? []);
  return {
    unrecorded: additions.filter((line) => !recorded.includes(line)),
    stale: recorded.filter((line) => !additions.includes(line)),
  };
}

/**
 * What is wrong with the ledger's released entries, given the minor the protocol is at and the fingerprint
 * of the live proto. Empty means fine.
 *   - `released` and `wire_fingerprint` go together, and the fingerprint is a sha256 hex digest;
 *   - no two entries that record wire additions carry the same fingerprint (each is a distinct wire); a minor
 *     that changed no wire may share its predecessor's fingerprint, since its wire is the same;
 *   - when the CURRENT minor's entry is released, the live proto must still have its fingerprint.
 * Older released entries cannot be re-checked (their protos are not in the tree); the rule above is what
 * keeps them honest, because each was the current minor until the next one was added.
 */
function releasedProblems(minors: SourceMinor[], currentMinor: number, liveFingerprint: string): string[] {
  const problems: string[] = [];
  for (const entry of minors) {
    if ((entry.released === undefined) !== (entry.wire_fingerprint === undefined)) {
      problems.push(`minor ${entry.minor}: \`released\` and \`wire_fingerprint\` must be set together`);
    }
    if (entry.released !== undefined && entry.released.trim() === '') {
      problems.push(`minor ${entry.minor}: \`released\` must name the tag`);
    }
    if (entry.wire_fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(entry.wire_fingerprint)) {
      problems.push(`minor ${entry.minor}: wire_fingerprint is not a sha256 hex digest`);
    }
  }
  const prints = minors.flatMap((m) => (m.wire_fingerprint === undefined || (m.wire_additions ?? []).length === 0 ? [] : [m.wire_fingerprint]));
  if (new Set(prints).size !== prints.length) {
    problems.push('two ledger entries that record wire additions carry the same wire_fingerprint: a minor that changes the wire must be a different wire');
  }
  const current = minors.find((m) => m.minor === currentMinor);
  if (current?.released !== undefined && current.wire_fingerprint !== liveFingerprint) {
    problems.push(
      `minor ${currentMinor} is released (${current.released}) and its wire is frozen, but runtime.proto's fingerprint is now ${liveFingerprint}, ` +
        `not ${current.wire_fingerprint}. A wire change after a release needs a new minor: raise protocol.minor and add a minors entry for it`,
    );
  }
  return problems;
}

const frozenText = readFileSync(FROZEN_PROTO, 'utf8');
const frozenModel = modelOf(compileProto(FROZEN_PROTO));

test('every wire addition since the frozen proto is recorded under a minor above the frozen one, and nothing else is', () => {
  const diff = diffProtos(frozenModel, modelOf(compileProto(CURRENT_PROTO)));
  assert.deepEqual(diff.breaking, [], 'the live proto breaks the frozen one (the old-client suite says how)');
  const { unrecorded, stale } = reconcile(diff.additions, source.minors, FROZEN_PROTO_MINOR);
  assert.deepEqual(
    unrecorded,
    [],
    `runtime.proto grew with no record in capabilities.json's minors ledger. Raise protocol.minor, add a minors entry above ${FROZEN_PROTO_MINOR} ` +
      `and list these under its wire_additions:\n  ${unrecorded.join('\n  ')}`,
  );
  assert.deepEqual(stale, [], `the ledger records additions the proto does not have:\n  ${stale.join('\n  ')}`);
});

test('an additive proto change needs a minor above the frozen proto\'s', () => {
  const diff = diffProtos(frozenModel, modelOf(compileProto(CURRENT_PROTO)));
  if (diff.additions.length > 0) {
    assert.ok(source.protocol.minor > FROZEN_PROTO_MINOR, `the proto grew but protocol.minor is still ${source.protocol.minor}`);
  }
  assert.ok(source.protocol.minor >= FROZEN_PROTO_MINOR, 'the minor went backwards past the frozen proto');
});

test('a released minor\'s wire is frozen: the live proto still has the fingerprint its ledger entry recorded', () => {
  assert.deepEqual(releasedProblems(source.minors, source.protocol.minor, fingerprint(modelOf(compileProto(CURRENT_PROTO)))), []);
});

test('the ledger\'s history (minors up to the frozen proto\'s) records no wire additions: those are in the frozen proto already', () => {
  for (const entry of source.minors.filter((m) => m.minor <= FROZEN_PROTO_MINOR)) {
    assert.equal(entry.wire_additions, undefined, `minor ${entry.minor} is part of the frozen proto and cannot list additions`);
  }
});

// ---- The check itself, against known changes ----------------------------------------------------------------------

/**
 * The synthetic checks below start from the ledger's history up to the frozen proto's minor with no release
 * marks on it, whatever the real ledger says: once a real entry is released, these must not change meaning.
 */
const history: SourceMinor[] = source.minors.filter((m) => m.minor <= FROZEN_PROTO_MINOR).map(({ released: _r, wire_fingerprint: _w, ...rest }) => rest);

function additionsOfMutation(mutated: string): string[] {
  const diff = diffProtos(frozenModel, modelOf(compileProtoText(mutated)));
  assert.deepEqual(diff.breaking, [], 'the mutation was meant to be additive');
  return diff.additions;
}

const addedField = frozenText.replace(
  'message HandshakeRequest {\n  uint32 client_protocol_major = 1;\n}',
  'message HandshakeRequest {\n  uint32 client_protocol_major = 1;\n  string brand_new = 99;\n}',
);

test('the check: a field added with no ledger entry is reported', () => {
  assert.notEqual(addedField, frozenText, 'the mutation did not apply');
  const additions = additionsOfMutation(addedField);
  assert.equal(additions.length, 1);
  const { unrecorded, stale } = reconcile(additions, history, FROZEN_PROTO_MINOR);
  assert.deepEqual(unrecorded, additions);
  assert.deepEqual(stale, []);
});

test('the check: the same field recorded under a minor above the frozen one is accepted; recorded at or below it, it is not', () => {
  const additions = additionsOfMutation(addedField);
  const recordedAbove = [...history, { minor: FROZEN_PROTO_MINOR + 1, date: '2099-01-01', summary: 'x', wire_additions: additions }];
  assert.deepEqual(reconcile(additions, recordedAbove, FROZEN_PROTO_MINOR), { unrecorded: [], stale: [] });
  const recordedAtFrozen = history.map((m) => (m.minor === FROZEN_PROTO_MINOR ? { ...m, wire_additions: additions } : m));
  assert.deepEqual(reconcile(additions, recordedAtFrozen, FROZEN_PROTO_MINOR).unrecorded, additions, 'a record at the frozen minor does not count');
});

test('the check: a recorded addition the proto does not have is stale', () => {
  const ledger = [...history, { minor: FROZEN_PROTO_MINOR + 1, date: '2099-01-01', summary: 'x', wire_additions: ['verdandi.claude.runtime.v1.Nowhere: new field optional string gone = 1'] }];
  assert.deepEqual(reconcile([], ledger, FROZEN_PROTO_MINOR).stale, ['verdandi.claude.runtime.v1.Nowhere: new field optional string gone = 1']);
});

test('the check: a change that adds nothing (a comment, a reserved tag) needs no record', () => {
  const comment = frozenText.replace('// ---- Handshake ----', '// ---- Handshake (reworded) ----');
  assert.notEqual(comment, frozenText);
  assert.deepEqual(additionsOfMutation(comment), []);
});

// ---- The released-minor rule, against a synthetic ledger ------------------------------------------------------------

const frozenFingerprint = fingerprint(modelOf(compileProto(FROZEN_PROTO)));
const fingerprintOf = (text: string): string => fingerprint(modelOf(compileProtoText(text)));

/** The real ledger with minor 12 (the frozen proto's) marked released at the frozen proto's fingerprint. */
const releasedAtFrozen = history.map((m) => (m.minor === FROZEN_PROTO_MINOR ? { ...m, released: 'synthetic-tag', wire_fingerprint: frozenFingerprint } : m));

test('the released rule: an unchanged wire under a released minor passes, and so does a comment-only edit', () => {
  assert.deepEqual(releasedProblems(releasedAtFrozen, FROZEN_PROTO_MINOR, frozenFingerprint), []);
  const comment = frozenText.replace('// ---- Handshake ----', '// ---- Handshake (reworded) ----');
  assert.notEqual(comment, frozenText);
  assert.deepEqual(releasedProblems(releasedAtFrozen, FROZEN_PROTO_MINOR, fingerprintOf(comment)), []);
});

test('the released rule: a second field added under an already released minor fails, even when the ledger records it there', () => {
  assert.notEqual(addedField, frozenText, 'the mutation did not apply');
  // Minor 13 is released with one new field...
  const firstAdditions = additionsOfMutation(addedField);
  const releasedThirteen = [
    ...history,
    { minor: 13, date: '2099-01-01', summary: 'x', wire_additions: firstAdditions, released: 'synthetic-tag', wire_fingerprint: fingerprintOf(addedField) },
  ];
  assert.deepEqual(releasedProblems(releasedThirteen, 13, fingerprintOf(addedField)), []);
  // ...then another field is added and appended to minor 13's own list without raising the minor.
  const twoFields = addedField.replace('string session_id = 1;\n  string command_id = 2;\n}\n', 'string session_id = 1;\n  string command_id = 2;\n  string brand_newer = 98;\n}\n');
  assert.notEqual(twoFields, addedField, 'the second mutation did not apply');
  const secondAdditions = additionsOfMutation(twoFields);
  assert.equal(secondAdditions.length, 2);
  const absorbed = releasedThirteen.map((m) => (m.minor === 13 ? { ...m, wire_additions: secondAdditions } : m));
  // The additions check alone is satisfied: that is the hole this rule closes.
  assert.deepEqual(reconcile(secondAdditions, absorbed, FROZEN_PROTO_MINOR), { unrecorded: [], stale: [] });
  const problems = releasedProblems(absorbed, 13, fingerprintOf(twoFields));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /minor 13 is released .* needs a new minor/);
  // Under a new minor 14 the same second field is fine.
  const fixed = [
    ...releasedThirteen,
    { minor: 14, date: '2099-01-02', summary: 'y', wire_additions: secondAdditions.filter((line) => !firstAdditions.includes(line)) },
  ];
  assert.deepEqual(releasedProblems(fixed, 14, fingerprintOf(twoFields)), []);
  assert.deepEqual(reconcile(secondAdditions, fixed, FROZEN_PROTO_MINOR), { unrecorded: [], stale: [] });
});

test('the released rule: the same addition under a new minor passes', () => {
  const additions = additionsOfMutation(addedField);
  const next = [...releasedAtFrozen, { minor: FROZEN_PROTO_MINOR + 1, date: '2099-01-01', summary: 'x', wire_additions: additions }];
  assert.deepEqual(releasedProblems(next, FROZEN_PROTO_MINOR + 1, fingerprintOf(addedField)), []);
  assert.deepEqual(reconcile(additions, next, FROZEN_PROTO_MINOR), { unrecorded: [], stale: [] });
  // Released too, the new minor is frozen in its turn; the old one stays what it was.
  const releasedNext = next.map((m) => (m.minor === FROZEN_PROTO_MINOR + 1 ? { ...m, released: 'synthetic-tag-2', wire_fingerprint: fingerprintOf(addedField) } : m));
  assert.deepEqual(releasedProblems(releasedNext, FROZEN_PROTO_MINOR + 1, fingerprintOf(addedField)), []);
  assert.equal(releasedProblems(releasedNext, FROZEN_PROTO_MINOR + 1, frozenFingerprint).length, 1);
});

test('the released rule: malformed released entries are refused', () => {
  const half = history.map((m) => (m.minor === FROZEN_PROTO_MINOR ? { ...m, released: 'synthetic-tag' } : m));
  assert.match(releasedProblems(half, FROZEN_PROTO_MINOR, frozenFingerprint).join('\n'), /set together/);
  const bad = history.map((m) => (m.minor === FROZEN_PROTO_MINOR ? { ...m, released: 't', wire_fingerprint: 'abc' } : m));
  assert.match(releasedProblems(bad, FROZEN_PROTO_MINOR, frozenFingerprint).join('\n'), /not a sha256/);
  const additions = additionsOfMutation(addedField);
  const twice = [
    ...history,
    { minor: 13, date: '2099-01-01', summary: 'x', wire_additions: additions, released: 't1', wire_fingerprint: fingerprintOf(addedField) },
    { minor: 14, date: '2099-01-02', summary: 'y', wire_additions: ['verdandi.claude.runtime.v1.Nowhere: new field optional string other = 1'], released: 't2', wire_fingerprint: fingerprintOf(addedField) },
  ];
  assert.match(releasedProblems(twice, 14, fingerprintOf(addedField)).join('\n'), /same wire_fingerprint/);
});

test('the released rule: a released minor that changed no wire may share its predecessor\'s fingerprint', () => {
  const wireless = [
    ...releasedAtFrozen,
    { minor: FROZEN_PROTO_MINOR + 1, date: '2099-01-01', summary: 'behaviour only', released: 'synthetic-tag-2', wire_fingerprint: frozenFingerprint },
  ];
  assert.deepEqual(releasedProblems(wireless, FROZEN_PROTO_MINOR + 1, frozenFingerprint), []);
  // And it is frozen like any other: a wire change now needs the next minor.
  assert.equal(releasedProblems(wireless, FROZEN_PROTO_MINOR + 1, fingerprintOf(addedField)).length, 1);
});
