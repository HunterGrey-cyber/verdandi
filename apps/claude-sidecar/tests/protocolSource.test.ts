import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl, PROTOCOL_MAJOR as SIDECAR_PROTOCOL_MAJOR } from '../src/runtimeServiceImpl.js';
import { handshakeCapabilities } from '../src/capabilities.js';
import { CAPABILITY_TABLE, PERMISSION_MODES, PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import { SIDECAR_VERSION } from '../src/generated/sdkVersions.js';
import { versionReport } from '../src/versionReport.js';
import { EITRI_020_CAPABILITIES } from './compat/eitri.js';
import { REPO_ROOT, SIDECAR_DIR } from './compat/paths.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * The TypeScript half of the one-source rule: `crates/claude-runtime-protocol/capabilities.json` is the
 * only place the protocol numbers, the capability strings and the permission-mode strings are written.
 * The sidecar's handshake is built from it (through src/generated/protocolConstants.ts, which
 * scripts/generateProtocolConstants.mjs writes at build time), and the Rust crate's constants are
 * generated from the same file (tests/protocol_constants.rs there is the other half).
 *
 * These tests read the file themselves and compute what the handshake must say WITHOUT going through the
 * generated module or capabilities.ts, so neither a stale generated copy nor a slip in the code that turns
 * the file into a list can pass for the file.
 */

const SOURCE = join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json');

type SourceCapability = { name: string; since_minor: number; baseline?: boolean; when?: string };
type SourceMinor = { minor: number; date: string; summary: string; wire_additions?: string[] };
const source = JSON.parse(readFileSync(SOURCE, 'utf8')) as {
  protocol: { major: number; minor: number };
  capabilities: SourceCapability[];
  permission_modes: string[];
  minors: SourceMinor[];
};

/** What the handshake lists, worked out from the raw file: every capability, less the conditional ones
 * whose fact is false. */
function expectedCapabilities(facts: { egress_restricted: boolean; sdk_bundled: boolean }): string[] {
  return source.capabilities.filter((c) => c.when === undefined || facts[c.when as 'egress_restricted' | 'sdk_bundled']).map((c) => c.name);
}

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

type Handshake = {
  protocolMajor: number;
  protocolMinor: number;
  sidecarVersion: string;
  capabilities: string[];
  permissionModes: string[];
};

async function handshake(options: { egressRestricted: boolean; sdkBundledAvailable: boolean }): Promise<Handshake> {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' }, options);
  return callResult<Handshake>(impl.handshake.bind(impl), { clientProtocolMajor: source.protocol.major });
}

// ---- The handshake says what the file says ----------------------------------------------------------------------

for (const egressRestricted of [false, true]) {
  for (const sdkBundledAvailable of [false, true]) {
    test(`the handshake is the file: egress_restricted=${egressRestricted}, sdk_bundled=${sdkBundledAvailable}`, async () => {
      const response = await handshake({ egressRestricted, sdkBundledAvailable });
      assert.equal(response.protocolMajor, source.protocol.major);
      assert.equal(response.protocolMinor, source.protocol.minor, 'protocol_minor is the file\'s, not a literal');
      assert.deepEqual(response.capabilities, expectedCapabilities({ egress_restricted: egressRestricted, sdk_bundled: sdkBundledAvailable }));
      assert.deepEqual(response.permissionModes, source.permission_modes);
    });
  }
}

test('the handshake reports the sidecar\'s real semantic version, the one in package.json', async () => {
  const response = await handshake({ egressRestricted: false, sdkBundledAvailable: true });
  const packageVersion = (JSON.parse(readFileSync(join(SIDECAR_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(response.sidecarVersion, packageVersion);
  assert.match(response.sidecarVersion, /^\d+\.\d+\.\d+$/, 'a semantic version, not a placeholder');
  assert.notEqual(response.sidecarVersion, '0.0.0');
  assert.equal(SIDECAR_VERSION, packageVersion);
  assert.ok(versionReport({ sdkBundledAvailable: true }).startsWith(`verdandi-claude-sidecar ${packageVersion} (`), '`--version` leads with the same version');
});

test('the generated module is the file (a stale src/generated copy fails here, not in a host)', () => {
  assert.equal(PROTOCOL_MAJOR, source.protocol.major);
  assert.equal(SIDECAR_PROTOCOL_MAJOR, source.protocol.major, 'runtimeServiceImpl re-exports the same number');
  assert.equal(PROTOCOL_MINOR, source.protocol.minor);
  assert.deepEqual(
    CAPABILITY_TABLE.map((c) => ({ name: c.name, since_minor: c.sinceMinor, baseline: c.baseline, when: c.when })),
    source.capabilities.map((c) => ({ name: c.name, since_minor: c.since_minor, baseline: c.baseline ?? false, when: c.when })),
  );
  assert.deepEqual([...PERMISSION_MODES], source.permission_modes);
  assert.deepEqual(handshakeCapabilities({ egressRestricted: true, sdkBundledAvailable: true }), source.capabilities.map((c) => c.name));
});

// ---- What the file must always be --------------------------------------------------------------------------------

test('Eitri 0.2.0 handshakes with major 3: a sidecar answering another major would lock it out', () => {
  assert.equal(source.protocol.major, 3);
});

test('the protocol minor is real: past the literal 0 the handshake used to report', () => {
  assert.ok(source.protocol.minor > 0);
});

test('capability names are unique lower_snake_case, and the executable_* pair stays last', () => {
  const names = source.capabilities.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'a duplicate capability');
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
  }
  const first = names.findIndex((name) => name.startsWith('executable_'));
  assert.ok(first >= 0);
  assert.ok(names.slice(first).every((name) => name.startsWith('executable_')), `executable_* must be last: ${names.join(' ')}`);
});

test('the frozen list Eitri 0.2.0 saw is still in the file, in its order (the wire proves it too; this reads the source)', () => {
  const names = source.capabilities.map((c) => c.name);
  let at = -1;
  for (const capability of EITRI_020_CAPABILITIES) {
    const found = names.indexOf(capability, at + 1);
    assert.ok(found > at, `${capability} is missing from capabilities.json or moved before an earlier one`);
    at = found;
  }
});

test('the major-3 baseline is exactly what major 3 itself guarantees, and only minor 0 can be baseline', () => {
  const baseline = source.capabilities.filter((c) => c.baseline === true);
  // Growing this list is a major bump by definition (COMPATIBILITY.md): it is written out here on purpose.
  assert.deepEqual(
    baseline.map((c) => c.name),
    ['handshake', 'create_session', 'send_turn', 'watch_session_events', 'interrupt_turn', 'resolve_permission', 'close_session', 'resume_session', 'fork_session', 'setting_sources', 'tool_policy'],
  );
  for (const capability of baseline) {
    assert.equal(capability.since_minor, 0, `${capability.name} is baseline but was introduced by minor ${capability.since_minor}`);
  }
  for (const capability of source.capabilities.filter((c) => c.since_minor === 0)) {
    assert.equal(capability.baseline, true, `${capability.name} is from minor 0 and must be baseline`);
  }
});

test('the permission modes keep `interactive` (Eitri refuses a session without it) and are unique names', () => {
  assert.ok(source.permission_modes.includes('interactive'));
  assert.equal(new Set(source.permission_modes).size, source.permission_modes.length);
  assert.deepEqual(source.permission_modes, ['interactive', 'verdandi_rules', 'bypass']);
});

test('the minors ledger lists every minor up to the current one, each with a date and a summary, and no capability is from a minor past it', () => {
  assert.deepEqual(
    source.minors.map((m) => m.minor),
    Array.from({ length: source.protocol.minor + 1 }, (_, i) => i),
  );
  for (const entry of source.minors) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.summary.length > 0, `minor ${entry.minor} has no summary`);
  }
  for (const capability of source.capabilities) {
    assert.ok(capability.since_minor <= source.protocol.minor, `${capability.name} is from minor ${capability.since_minor}, past the current ${source.protocol.minor}`);
  }
  // Every minor that introduced a capability (other than the baseline, which minor 0 introduces as a whole)
  // says so in its summary, so a reader of the ledger finds it.
  for (const capability of source.capabilities.filter((c) => c.baseline !== true)) {
    const entry = source.minors[capability.since_minor];
    assert.ok(entry.summary.includes(capability.name), `minor ${entry.minor}'s summary does not name ${capability.name}, which it introduced`);
  }
});
