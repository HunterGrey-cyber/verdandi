import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundledProtoc, compileProto, compileProtoText, fingerprint, modelOf } from './protoModel.js';
import { FROZEN_DIR, FROZEN_GENERATED, FROZEN_PROTO, GOLDEN_REQUESTS } from './paths.js';

/**
 * The frozen copy has to BE frozen. Three ways it could quietly stop being the thing Eitri 0.2.0 was
 * built against, each held here:
 *
 *   1. someone edits the meaning of tests/compat/b3aa188/runtime.proto (to make a red test green, say);
 *   2. someone regenerates the TypeScript client from the LIVE proto instead of the frozen one, or
 *      edits the generated file by hand;
 *   3. the golden request bytes drift from the requests the conformance test replays.
 *
 * The frozen proto is Verdandi's own proto/verdandi/claude/runtime/v1/runtime.proto at b3aa188 (the
 * revision Eitri 0.2.0's Cargo.toml pins; the public twin is 22400e8). Its git blob id, 96649b26..., is
 * what `git rev-parse b3aa188:proto/verdandi/claude/runtime/v1/runtime.proto` prints.
 */

/**
 * The fingerprint of the frozen proto's MEANING (protoModel.ts `fingerprint`), taken from Verdandi
 * b3aa188's proto/verdandi/claude/runtime/v1/runtime.proto (git blob 96649b26a8e8e15ea6f3b3d77ae3661ed50e1f10,
 * checkable with `git rev-parse b3aa188:proto/verdandi/claude/runtime/v1/runtime.proto`).
 *
 * A fingerprint of meaning rather than a hash of bytes, on purpose: the public export rewrites a few
 * words in comments of every file it ships (an account name in this one's), so the public tree's copy
 * is not byte-identical to the private one while meaning exactly the same. What must never change is
 * a tag, a type, a name, a number, a reservation or an rpc, and any of those moves this.
 */
const FROZEN_FINGERPRINT = '8d7ad6b74f36f9cd5f290e3f1f77a38c44f3d0f8dffe61130ab0d37d80a7cc62';

/** Generation options of tests/compat/b3aa188/generated/runtime.ts. `src/generated` (the live client)
 * uses the sidecar's `generate` script's options; this one drops comments and the JSON methods, which
 * an old client under test never calls, so the checked-in file stays at 140 KB instead of 250. */
const TS_PROTO_OPTIONS = 'outputServices=grpc-js,esModuleInterop=true,env=node,forceLong=bigint,comments=false,outputJsonMethods=false';

test('the frozen proto still means exactly what Verdandi b3aa188\'s runtime.proto meant', () => {
  assert.equal(
    fingerprint(modelOf(compileProto(FROZEN_PROTO))),
    FROZEN_FINGERPRINT,
    'tests/compat/b3aa188/runtime.proto was edited in a way that changes the contract: it must never change (comments aside)',
  );
});

test('the frozen TypeScript client is exactly what protoc and ts-proto generate from the frozen proto', () => {
  const out = mkdtempSync(join(tmpdir(), 'frozen-client-'));
  try {
    const plugin = join(dirname(createRequire(import.meta.url).resolve('ts-proto/package.json')), 'protoc-gen-ts_proto');
    execFileSync(bundledProtoc(), [`--plugin=protoc-gen-ts_proto=${plugin}`, `--ts_proto_out=${out}`, `--ts_proto_opt=${TS_PROTO_OPTIONS}`, `--proto_path=${FROZEN_DIR}`, FROZEN_PROTO], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const regenerated = readFileSync(join(out, 'runtime.ts'), 'utf8');
    const checkedIn = readFileSync(FROZEN_GENERATED, 'utf8');
    assert.ok(
      regenerated === checkedIn,
      'tests/compat/b3aa188/generated/runtime.ts is not what the generator produces from tests/compat/b3aa188/runtime.proto. ' +
        'If ts-proto or protoc was upgraded, regenerate it from the FROZEN proto (never the live one) with:\n' +
        `  protoc --plugin=protoc-gen-ts_proto=node_modules/ts-proto/protoc-gen-ts_proto --ts_proto_out=tests/compat/b3aa188/generated --ts_proto_opt=${TS_PROTO_OPTIONS} --proto_path=tests/compat/b3aa188 tests/compat/b3aa188/runtime.proto\n` +
        'and review the diff: a changed decoder is a changed "old client".',
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the golden file lists each of Eitri\'s requests once, as hex', () => {
  const lines = readFileSync(GOLDEN_REQUESTS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const names = lines.map((line) => line.split('\t')[0]);
  assert.equal(new Set(names).size, names.length, 'a request is listed twice');
  assert.deepEqual(names, [
    'handshake',
    'create_session_fresh_partial',
    'create_session_fresh_complete',
    'create_session_resume_partial',
    'watch_after_sequence_0',
    'watch_after_sequence_5',
    'send_turn',
    'interrupt_turn',
    'resolve_permission_allow',
    'resolve_permission_deny',
    'close_session',
  ]);
  for (const line of lines) {
    assert.match(line.split('\t')[1] ?? '', /^([0-9a-f]{2})+$/, line);
  }
});

test('the fingerprint ignores what the public export scrubs (comment words) and notices what matters (a tag)', () => {
  const text = readFileSync(FROZEN_PROTO, 'utf8');
  const fingerprintOf = (source: string): string => fingerprint(modelOf(compileProtoText(source)));
  assert.equal(fingerprintOf(text), FROZEN_FINGERPRINT);
  // Every token the export's rewrites.py substitutes could sit in a comment; changing them changes no meaning.
  // (The first token is spelt in two pieces on purpose: the export would rewrite it in THIS file too and turn the replacement into a no-op.)
  assert.equal(fingerprintOf(text.replace(new RegExp(['can', 'ary'].join(''), 'g'), 'work').replace(/^\/\/ ---- Handshake ----$/m, '// ---- Handshake (scrubbed) ----')), FROZEN_FINGERPRINT);
  assert.notEqual(fingerprintOf(text.replace('string account_name = 13;', 'string account_name = 113;')), FROZEN_FINGERPRINT);
  assert.notEqual(fingerprintOf(text.replace('PERMISSION_MODE_BYPASS = 3;', 'PERMISSION_MODE_BYPASS = 30;')), FROZEN_FINGERPRINT);
});
