import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionOptions } from '@verdandi/claude-runtime';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildKernelSessionConfig, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { ClaudeHostPolicy, CreateSessionRequest, PermissionMode } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/**
 * Every field on the wire `CreateSessionRequest` has an observable effect on the SDK `Options`.
 *
 * policyTotality.test.ts does this for ClaudeHostPolicy's fields; this file does it one level up,
 * for the request's own fields (consumer spec §6.3 P2). The failure it exists to catch is the one
 * this repository has already shipped at this exact layer: `resume` was accepted on the wire and
 * dropped in the request -> kernel-config mapping, so a client asking to resume silently got a
 * fresh session. Two assertions, same shape as policyTotality's:
 *
 *   1. The FIELD LIST comes from the generated message (`CreateSessionRequest.create({})`), so a
 *      new proto field shows up here the moment `npm run generate` runs, and a field with no row
 *      fails the first test.
 *   2. Each row runs two requests that differ only in its field through the PRODUCTION path --
 *      `buildKernelSessionConfig`, then the kernel's `buildSessionOptions` (the function
 *      `createSession` itself uses) -- and asserts the two `Options` differ where that field
 *      should move them.
 */

type Row = {
  /** Two requests that differ ONLY in the field this row is named for (overlaid on BASE). */
  a: Partial<ClaudeSessionConfigLike>;
  b: Partial<ClaudeSessionConfigLike>;
  /** The part of `Options` the field is supposed to move. Compared with deepEqual. */
  observe: (options: Options) => unknown;
};

const TABLE: Record<string, Row> = {
  cwd: { a: { cwd: '/tmp/a' }, b: { cwd: '/tmp/b' }, observe: (o) => o.cwd },
  policy: {
    a: { policy: undefined },
    b: { policy: ClaudeHostPolicy.create({ permissions: PermissionMode.PERMISSION_MODE_BYPASS }) },
    observe: (o) => o.permissionMode,
  },
  resumeProviderSessionId: {
    a: { resumeProviderSessionId: undefined },
    b: { resumeProviderSessionId: 'sess-resume' },
    observe: (o) => o.resume,
  },
  fork: {
    a: { resumeProviderSessionId: 'sess-resume', fork: false },
    b: { resumeProviderSessionId: 'sess-resume', fork: true },
    observe: (o) => o.forkSession,
  },
  model: { a: { model: undefined }, b: { model: 'sonnet' }, observe: (o) => o.model },
  effort: { a: { effort: undefined }, b: { effort: 'medium' }, observe: (o) => o.effort },
  systemPrompt: {
    a: { systemPrompt: undefined },
    b: { systemPrompt: 'You are a test prompt.' },
    observe: (o) => o.systemPrompt,
  },
  outputFormat: {
    a: { outputFormat: undefined },
    b: { outputFormat: { jsonSchemaJson: '{"type":"object"}' } },
    observe: (o) => o.outputFormat,
  },
};

/**
 * Request fields that are deliberately NOT session options: they change what the RPC itself does, so
 * there is no `Options` difference to observe. Each one names the test that pins its effect instead;
 * a field may only be listed here with such a test, never to make the first check pass.
 */
const NOT_AN_SDK_OPTION: Record<string, string> = {
  awaitAccountIdentity:
    'changes when CreateSession answers and what its response carries, not the session: explicitFields.test.ts '
    + '("await_account_identity ...") pins both the set and the absent case',
};

const BASE: ClaudeSessionConfigLike = { cwd: '/tmp/project', policy: undefined };

function optionsFor(overlay: Partial<ClaudeSessionConfigLike>): Options {
  return buildSessionOptions(buildKernelSessionConfig({ ...BASE, ...overlay }, { hostCliPath: '/usr/local/bin/claude' }));
}

test('every field on the wire CreateSessionRequest is represented in this table', () => {
  assert.deepEqual(
    Object.keys(CreateSessionRequest.create({})).sort(),
    [...Object.keys(TABLE), ...Object.keys(NOT_AN_SDK_OPTION)].sort(),
    'A field was added to CreateSessionRequest in the .proto without a row here. Add the row (and the '
      + 'wiring it asserts) rather than deleting this check -- a request field accepted on the wire and '
      + 'dropped on the floor is exactly the failure this file exists to catch.',
  );
});

test('a request field that is not a session option leaves the SDK Options untouched', () => {
  // The other half of listing it in NOT_AN_SDK_OPTION: if one of these ever started moving Options, it
  // would belong in TABLE with a row of its own.
  const base = optionsFor({});
  assert.deepEqual(optionsFor({ awaitAccountIdentity: true }), base);
  assert.deepEqual(optionsFor({ awaitAccountIdentity: false }), base);
});

test('every field on the wire CreateSessionRequest has an observable effect on the SDK Options', () => {
  for (const [field, row] of Object.entries(TABLE)) {
    const seenA = row.observe(optionsFor(row.a));
    const seenB = row.observe(optionsFor(row.b));
    assert.notDeepEqual(
      seenA,
      seenB,
      `CreateSessionRequest.${field} made no observable difference to the Options handed to the SDK: `
        + `both requests produced ${JSON.stringify(seenA)}. The field is accepted on the wire and dropped.`,
    );
  }
});
