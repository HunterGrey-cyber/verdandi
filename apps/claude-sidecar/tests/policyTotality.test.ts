import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionOptions, policyToBaseOptions } from '@verdandi/claude-runtime';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildKernelSessionConfig } from '../src/runtimeServiceImpl.js';
import {
  ClaudeHostPolicy,
  ConfigurationProfile,
  PermissionMode,
  PersistenceMode,
  ExecutableSource,
  StreamingMode,
  SettingSource,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/**
 * Every field on the wire `ClaudeHostPolicy` has an observable effect on the SDK `Options`.
 *
 * This is the generalised form of a bug this repository actually shipped: `ClaudeHostPolicy.executable`
 * was declared in the proto, translated at the sidecar boundary, and then read by nobody, so every
 * session silently ran the SDK's bundled CLI no matter what the policy said -- including under the
 * DEFAULT policy, which asks for `host_cli`. Nothing failed. Nothing could have: no test related the
 * field's presence on the wire to any observable difference in what the SDK was told.
 *
 * Two assertions, and they catch different halves of that failure:
 *
 *   1. The FIELD LIST comes from the generated message itself -- `Object.keys(ClaudeHostPolicy.create({}))`
 *      -- not from a human's memory of it. ts-proto's `createBase` emits a key for every declared
 *      field, message-typed ones included (as `undefined`), so a new proto field appears here the
 *      moment `npm run generate` runs. Add a field and wire nothing: this assertion fails.
 *      (Verified against the regenerated output for this very change: createBaseClaudeHostPolicy()
 *      returns `{ configuration: 0, ..., toolPolicy: undefined, settingSources: undefined }`.)
 *
 *   2. Each row runs BOTH of its policies through the PRODUCTION path -- `buildKernelSessionConfig`
 *      (which calls `mapClaudeHostPolicy`) and then `policyToBaseOptions` -- and asserts the two
 *      produce a different `Options`. Wire a field into the mapper but never read it in
 *      policyToBaseOptions and its row fails.
 *
 * The production path matters more than it looks. `buildKernelSessionConfig` exists as an exported
 * function precisely so this test can call the real request->config mapping rather than a local
 * reimplementation of it: the `resume` passthrough was once dropped in exactly that lambda, and a
 * test that rebuilt the config itself would have gone on passing.
 */

type Row = {
  /** Two policies that differ ONLY in the field this row is named for. */
  a: Partial<ClaudeHostPolicyProto>;
  b: Partial<ClaudeHostPolicyProto>;
  /** The part of `Options` the field is supposed to move. Compared with deepEqual. */
  observe: (options: Options) => unknown;
};

const TABLE: Record<string, Row> = {
  configuration: {
    a: { configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE },
    b: { configuration: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED },
    // strictMcpConfig, not settingSources: axis B is the half of `configuration` that nothing else
    // can express, so observing it here keeps this row honest even once setting_sources exists.
    observe: (o) => o.strictMcpConfig,
  },
  permissions: {
    a: { permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE },
    b: { permissions: PermissionMode.PERMISSION_MODE_BYPASS },
    observe: (o) => o.permissionMode,
  },
  persistence: {
    a: { persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI },
    b: { persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL },
    observe: (o) => o.persistSession,
  },
  executable: {
    a: { executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI },
    b: { executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED },
    observe: (o) => o.pathToClaudeCodeExecutable,
  },
  streaming: {
    a: { streaming: StreamingMode.STREAMING_MODE_COMPLETE },
    b: { streaming: StreamingMode.STREAMING_MODE_PARTIAL },
    observe: (o) => o.includePartialMessages,
  },
  // Tag 6 gets TWO rows, not one. Its two sub-fields land on different Options keys, so a single
  // row observing only `disallowedTools` leaves `allow` -> `Options.tools` unguarded here: deleting
  // that assignment would keep this file green while the field was silently dropped. The table is
  // keyed by top-level field name, so the second row is keyed to the same field and the key-set
  // assertion below de-duplicates before comparing.
  toolPolicy: {
    a: { toolPolicy: undefined },
    b: { toolPolicy: { unrestricted: false, deny: ['Bash'], allow: undefined } },
    observe: (o) => o.disallowedTools,
  },
  'toolPolicy.allow': {
    a: { toolPolicy: { unrestricted: false, deny: [], allow: undefined } },
    b: { toolPolicy: { unrestricted: false, deny: [], allow: { tools: ['Read'] } } },
    observe: (o) => o.tools,
  },
  settingSources: {
    a: { settingSources: undefined },
    b: { settingSources: { sources: [SettingSource.SETTING_SOURCE_PROJECT] } },
    observe: (o) => o.settingSources,
  },
  permissionModeSwitchable: {
    a: { permissionModeSwitchable: false },
    b: { permissionModeSwitchable: true },
    observe: (o) => o.allowDangerouslySkipPermissions,
  },
  // Its other half, `canUseTool`, is installed by createSession beside the hook and is not part of
  // the Options policyToBaseOptions builds; the kernel's providerPermissionPrompts.test.ts pins it.
  // The tool removal is here, decided by the same predicate.
  providerPermissionPrompts: {
    a: { providerPermissionPrompts: false },
    b: { providerPermissionPrompts: true },
    observe: (o) => o.disallowedTools,
  },
};

/** A policy with every field at a stated, non-default value, so a row's `a`/`b` overlay changes one
 * field and nothing else. `permissions` is INTERACTIVE here deliberately: under BYPASS the
 * conservative default deny list would fire and make the toolPolicy row's two sides differ for a
 * reason other than the field under test. */
const BASE: ClaudeHostPolicyProto = {
  configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
  permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
  persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
  executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
  streaming: StreamingMode.STREAMING_MODE_COMPLETE,
  toolPolicy: undefined,
  settingSources: undefined,
  permissionModeSwitchable: false,
  providerPermissionPrompts: false,
};

function optionsFor(overlay: Partial<ClaudeHostPolicyProto>): Options {
  const config = buildKernelSessionConfig(
    { cwd: '/tmp/project', policy: { ...BASE, ...overlay } },
    { hostCliPath: '/usr/local/bin/claude' },
  );
  return policyToBaseOptions(config.policy, config.cwd, { hostCliPath: config.hostCliPath });
}

test('every field on the wire ClaudeHostPolicy is represented in this table', () => {
  // A row may be keyed `field.subField` to observe one half of a message-typed field on its own
  // Options key, so compare on the top-level field names the table actually covers.
  const covered = [...new Set(Object.keys(TABLE).map((k) => k.split('.')[0]))].sort();
  assert.deepEqual(
    Object.keys(ClaudeHostPolicy.create({})).sort(),
    covered,
    'A field was added to ClaudeHostPolicy in the .proto without a row here. Add the row (and the '
      + 'wiring it is asserting) rather than deleting this check -- a policy field accepted on the '
      + 'wire and dropped on the floor is exactly the failure this file exists to catch.',
  );
});

test('every field on the wire ClaudeHostPolicy has an observable effect on the SDK Options', () => {
  for (const [field, row] of Object.entries(TABLE)) {
    const seenA = row.observe(optionsFor(row.a));
    const seenB = row.observe(optionsFor(row.b));
    assert.notDeepEqual(
      seenA,
      seenB,
      `ClaudeHostPolicy.${field} made no observable difference to the Options handed to the SDK: `
        + `both policies produced ${JSON.stringify(seenA)}. The field is being accepted on the wire `
        + `and then dropped -- the ClaudeHostPolicy.executable bug, again.`,
    );
  }
});

/**
 * Every wire PermissionMode -- UNSPECIFIED and ts-proto's UNRECOGNIZED included, since a client can
 * send either -- reaches the SDK as an EXPLICIT `permissionMode`, fresh or resumed, switchable or
 * not. The row above only proves `permissions` moves the field; this proves no value leaves it
 * unset. Unset is not neutral: the CLI then takes its starting mode from `permissions.defaultMode`
 * in the project/local settings tiers, which are files in the repository under work, so a gated
 * session could start in `acceptEdits` (measured in the kernel's realSdk.defaultMode test).
 * The field list comes from the generated enum, so a new mode fails here until it is mapped.
 */
test('every wire PermissionMode reaches the SDK as an explicit permissionMode, fresh or resumed', () => {
  const modes = Object.values(PermissionMode).filter((v): v is PermissionMode => typeof v === 'number');
  assert.equal(modes.length, 5, 'PermissionMode gained a member: decide what it maps to, then update this count');
  for (const permissions of modes) {
    for (const permissionModeSwitchable of [false, true]) {
      for (const resumeProviderSessionId of [undefined, 'sess-resume']) {
        const config = buildKernelSessionConfig(
          { cwd: '/tmp/project', policy: { ...BASE, permissions, permissionModeSwitchable }, resumeProviderSessionId },
          { hostCliPath: '/usr/local/bin/claude' },
        );
        const options = buildSessionOptions(config);
        const label = `${PermissionMode[permissions]} switchable=${permissionModeSwitchable} resume=${String(resumeProviderSessionId)}`;
        assert.equal(
          options.permissionMode,
          permissions === PermissionMode.PERMISSION_MODE_BYPASS ? 'bypassPermissions' : 'default',
          label,
        );
        assert.equal(options.resume, resumeProviderSessionId, label);
      }
    }
  }
});
