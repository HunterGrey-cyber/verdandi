import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSidecar } from '../src/lifecycle.js';
import { createRuntimeServiceImpl, sdkBundledAvailable, validatePolicy } from '../src/runtimeServiceImpl.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import {
  ErrorCode,
  ConfigurationProfile,
  PermissionMode,
  PersistenceMode,
  ExecutableSource,
  StreamingMode,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * `executable: 'sdk_bundled'` is the one policy value that cannot survive packaging.
 *
 * It leaves `pathToClaudeCodeExecutable` unset, which is how the SDK is told to spawn the CLI inside
 * its own npm package -- and the SDK finds that CLI through
 * `createRequire(import.meta.url).resolve(...)` of its platform-specific optional dependency.
 * Verified in the installed sdk.mjs: that resolution is inside `if (!options.pathToClaudeCodeExecutable)`,
 * so `host_cli` never reaches it and is bundle-safe by construction, while `sdk_bundled` needs a real
 * node_modules on disk. The package it looks for is `@anthropic-ai/claude-agent-sdk-linux-x64`,
 * measured at 205 MB, so vendoring it would roughly triple a 105 MiB artifact to serve a mode a
 * packaged install has no use for.
 *
 * The failure mode if this is left alone is the one worth avoiding: the request is accepted, a
 * session is created, and the SDK throws `Native CLI binary for linux-x64 not found` from inside the
 * first turn -- far from the policy field that caused it. Refusing at validation is the same shape
 * `validatePolicy` already uses for a settings tier this sidecar cannot load.
 */

function protoPolicy(extra: Partial<ClaudeHostPolicyProto> = {}): ClaudeHostPolicyProto {
  return {
    configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
    permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
    persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
    executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
    streaming: StreamingMode.STREAMING_MODE_COMPLETE,
    toolPolicy: undefined,
    settingSources: undefined,
    permissionModeSwitchable: false,
    providerPermissionPrompts: false,
    ...extra,
  };
}

test('sdkBundledAvailable: true in a checkout, because a checkout has the node_modules the SDK resolves through', () => {
  assert.equal(sdkBundledAvailable(), true);
});

test('validatePolicy: sdk_bundled is invalid_configuration in a build that cannot run it', () => {
  assert.throws(
    () => validatePolicy(protoPolicy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED }), { sdkBundledAvailable: false }),
    (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
  );
});

/** The refusal has to name the alternative. A client reading "sdk_bundled is unavailable" with no
 * mention of `host_cli` learns that its request failed, not what to send instead. */
test('validatePolicy: the sdk_bundled refusal names host_cli as the mode this build does serve', () => {
  assert.throws(
    () => validatePolicy(protoPolicy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED }), { sdkBundledAvailable: false }),
    /host_cli/,
  );
});

/** The other direction, so the refusal is a property of the BUILD and not of the enum value. */
test('validatePolicy: sdk_bundled is accepted in a build that can run it', () => {
  validatePolicy(protoPolicy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED }), { sdkBundledAvailable: true });
});

/** host_cli -- what the default policy and an unset proto enum both mean -- is never affected. */
test('validatePolicy: host_cli is accepted in a build that cannot run sdk_bundled', () => {
  validatePolicy(protoPolicy({ executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI }), { sdkBundledAvailable: false });
  validatePolicy(protoPolicy({ executable: ExecutableSource.EXECUTABLE_SOURCE_UNSPECIFIED }), { sdkBundledAvailable: false });
});

/**
 * The startup gate classifies BOTH binaries, because both are reachable. In a build where one of
 * them is not reachable, classifying it is worse than pointless: the sdk-bundled CLI version is
 * baked in at build time, so a build whose SDK ships a CLI outside the supported range would refuse
 * to boot over a binary it could never have spawned -- taking the host_cli path, the only one it can
 * serve, down with it.
 */
test('startSidecar: a build that cannot run sdk_bundled does not classify the sdk-bundled CLI version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-packaged-'));
  const classified: string[] = [];
  let sidecar: { close(): Promise<void> } | undefined;
  try {
    sidecar = await startSidecar({
      socketPath: join(dir, 'sidecar.sock'),
      sessionFactory: () => makeFakeSession().session,
      getClaudeCodeVersions: () => ({ sdkDeclared: '0.0.1-way-out-of-range', hostCli: '2.1.272' }),
      classifyCliVersion: (version) => {
        classified.push(version);
        return version === '2.1.272' ? { kind: 'supported' } : { kind: 'refused', diagnostic: 'out of range' };
      },
      sdkBundledAvailable: false,
    });
    assert.deepEqual(classified, ['2.1.272']);
  } finally {
    await sidecar?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Same inputs, a build that CAN run it: the sdk-bundled binary is classified and its refusal is
 * fatal, exactly as before. Without this, the test above would also pass if the gate stopped
 * classifying that binary for everyone. */
test('startSidecar: a build that can run sdk_bundled still refuses to boot on an out-of-range sdk-bundled CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sidecar-packaged-'));
  try {
    await assert.rejects(
      startSidecar({
        socketPath: join(dir, 'sidecar.sock'),
        sessionFactory: () => makeFakeSession().session,
        getClaudeCodeVersions: () => ({ sdkDeclared: '0.0.1-way-out-of-range', hostCli: '2.1.272' }),
        classifyCliVersion: (version) => (version === '2.1.272' ? { kind: 'supported' } : { kind: 'refused', diagnostic: 'out of range' }),
        sdkBundledAvailable: true,
      }),
      /sdk-bundled/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The handshake already lists what this sidecar can do, with a stated rule: nothing is advertised
 * before it is implemented. The converse now matters too -- a build that serves one executable
 * source must not read, to a client, like one that serves both. Neovibe re-checks provider
 * capability live at session creation (its `require_permission_mode` refuses an unsupported mode
 * rather than silently mapping it), so the same shape for executable source fits a seam it already
 * has.
 *
 * Capability strings, not a new field: nothing on the wire changes.
 */
async function handshakeCapabilities(available: boolean): Promise<string[]> {
  const registry = new SessionRegistry();
  const impl = createRuntimeServiceImpl(
    registry,
    () => makeFakeSession().session,
    { sdkDeclared: '2.1.252', hostCli: '2.1.272' },
    { sdkBundledAvailable: available },
  );
  return await new Promise((resolve, reject) => {
    impl.handshake({ request: { clientProtocolMajor: 3 } }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((res as { capabilities: string[] }).capabilities);
    });
  });
}

test('handshake: a build that can run both executable sources advertises both', async () => {
  const capabilities = await handshakeCapabilities(true);
  assert.ok(capabilities.includes('executable_host_cli'), `missing executable_host_cli in ${JSON.stringify(capabilities)}`);
  assert.ok(capabilities.includes('executable_sdk_bundled'), `missing executable_sdk_bundled in ${JSON.stringify(capabilities)}`);
});

test('handshake: a packaged build advertises host_cli only, never the source it would refuse', async () => {
  const capabilities = await handshakeCapabilities(false);
  assert.ok(capabilities.includes('executable_host_cli'), `missing executable_host_cli in ${JSON.stringify(capabilities)}`);
  assert.ok(!capabilities.includes('executable_sdk_bundled'), `advertised a source it would refuse: ${JSON.stringify(capabilities)}`);
});
