import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { createSession, type ClaudeRuntimeEvent, type ClaudeRuntimeSession } from '@verdandi/claude-runtime';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { buildKernelSessionConfig, createRuntimeServiceImpl, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { cliPermissionModeKind, translateEvent } from '../src/eventTranslation.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import {
  CliPermissionModeKind,
  ConfigurationProfile,
  CreateSessionRequest,
  ExecutableSource,
  PermissionMode,
  PersistenceMode,
  SessionEvent,
  SettingSource,
  type SessionReady,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { FakeSdk, type FakeProvider } from './compat/fakeSdk.js';
import { goldenRequests } from './compat/eitri.js';
import { REPO_ROOT } from './compat/paths.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/**
 * What a session says it loaded, in SessionReady (protocol 3.18): the setting tiers, the configuration
 * profile, and the CLI's permission mode as an enum next to the verbatim string. Driven through the
 * production handlers, the production request mapping and the real kernel, with only the SDK's query()
 * replaced; every reported value is compared with what that fake SDK was actually handed.
 */

const VERSIONS = { sdkDeclared: 'fake-sdk-cli-version', hostCli: 'fake-cli-version' };
const HOST_CLI_PATH = '/opt/fake/claude';

const liveSessions: ClaudeRuntimeSession[] = [];
after(async () => {
  for (const session of liveSessions) {
    session.close();
  }
  await new Promise((r) => setTimeout(r, 100));
});

type Handler = (call: never, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => unknown;

function rpc<T>(handler: Handler, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    void handler({ request } as never, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sidecar() {
  const sdk = new FakeSdk({ tools: [] });
  const sessions: ClaudeRuntimeSession[] = [];
  const impl = createRuntimeServiceImpl(
    new SessionRegistry(),
    (config: ClaudeSessionConfigLike) => {
      const session = createSession(buildKernelSessionConfig(config, { hostCliPath: HOST_CLI_PATH }), sdk.queryFn);
      sessions.push(session);
      liveSessions.push(session);
      return session;
    },
    VERSIONS,
    { sdkBundledAvailable: true },
  );
  return { impl, sdk, sessions };
}

/** SessionReady as a client decodes it: through the production translation and the real codec. */
function wireSessionReady(events: readonly ClaudeRuntimeEvent[], which = 0): SessionReady {
  const readies = events.filter((e) => e.type === 'session_ready');
  const ready = readies[which];
  assert.ok(ready !== undefined, `no session_ready number ${which}`);
  const full = SessionEvent.fromPartial({ sessionId: 's', sequence: 1n, occurredAt: 0n, ...translateEvent(ready) });
  const decoded = SessionEvent.decode(SessionEvent.encode(full).finish()).sessionReady;
  assert.ok(decoded !== undefined);
  return decoded;
}

/** Creates the session, runs the first turn as far as system/init, and returns what the client would see. */
async function firstReady(request: CreateSessionRequest, initOverrides: Record<string, unknown> = {}) {
  const s = sidecar();
  const { sessionId } = await rpc<{ sessionId: string }>(s.impl.createSession as Handler, request);
  const session = s.sessions.at(-1)!;
  const provider: FakeProvider = s.sdk.last;
  await rpc(s.impl.sendTurn as Handler, { sessionId, commandId: 'c1', text: 'hello' });
  await provider.nextUserMessage();
  provider.init(initOverrides);
  await until('session_ready', () => session.eventLog().some((e) => e.type === 'session_ready'));
  return { s, session, provider, sessionId, ready: wireSessionReady(session.eventLog()) };
}

function request(configuration: ConfigurationProfile, sources: SettingSource[] | undefined): CreateSessionRequest {
  return CreateSessionRequest.fromPartial({
    cwd: '/tmp/project',
    policy: {
      configuration,
      permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
      persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      ...(sources === undefined ? {} : { settingSources: { sources } }),
    },
  });
}

const TIER_NAME: Record<number, string> = {
  [SettingSource.SETTING_SOURCE_USER]: 'user',
  [SettingSource.SETTING_SOURCE_PROJECT]: 'project',
  [SettingSource.SETTING_SOURCE_LOCAL]: 'local',
};
const tierNames = (tiers: readonly SettingSource[]): string[] => tiers.map((t) => TIER_NAME[t] ?? `?${t}`);

// ---- configuration x setting_sources -------------------------------------------------------------

const PROFILES: Array<{ name: string; value: ConfigurationProfile; reported: ConfigurationProfile }> = [
  { name: 'UNSPECIFIED', value: ConfigurationProfile.CONFIGURATION_PROFILE_UNSPECIFIED, reported: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE },
  { name: 'NATIVE', value: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE, reported: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE },
  { name: 'ISOLATED', value: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED, reported: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED },
];

const SOURCES: Array<{ name: string; value: SettingSource[] | undefined; sdk: (profile: string) => string[] }> = [
  { name: 'absent', value: undefined, sdk: (profile) => (profile === 'ISOLATED' ? [] : ['user', 'project', 'local']) },
  { name: 'empty', value: [], sdk: () => [] },
  { name: '[PROJECT, LOCAL]', value: [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL], sdk: () => ['project', 'local'] },
  {
    name: 'all three',
    value: [SettingSource.SETTING_SOURCE_USER, SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL],
    sdk: () => ['user', 'project', 'local'],
  },
  {
    // The canonical order and the de-duplication happen in the sidecar; the report is what came out of them.
    name: 'out of order with a duplicate',
    value: [SettingSource.SETTING_SOURCE_LOCAL, SettingSource.SETTING_SOURCE_USER, SettingSource.SETTING_SOURCE_LOCAL],
    sdk: () => ['user', 'local'],
  },
];

for (const profile of PROFILES) {
  for (const sources of SOURCES) {
    test(`configuration ${profile.name} x setting_sources ${sources.name}: the report is what the SDK was handed`, async () => {
      const { provider, ready } = await firstReady(request(profile.value, sources.value));
      // Equal to the SDK's own option, read from the fake SDK.
      assert.deepEqual(tierNames(ready.effectiveSettingSources), provider.options.settingSources);
      // And to what the request means (so a drift in the mapping cannot hide behind a drift in the report).
      assert.deepEqual(provider.options.settingSources, sources.sdk(profile.name));
      assert.equal(ready.effectiveConfiguration, profile.reported);
      assert.equal(ready.cliPermissionModeKind, CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DEFAULT);
      assert.equal(ready.permissionMode, 'default');
    });
  }
}

test('the report is recorded once: every SessionReady of a session carries the same values', async () => {
  const { s, session, provider, sessionId } = await firstReady(request(ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED, [SettingSource.SETTING_SOURCE_PROJECT]));
  provider.emit({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', terminal_reason: 'completed' });
  await until('the first turn to end', () => session.eventLog().some((e) => e.type === 'turn_completed'));
  await rpc(s.impl.sendTurn as Handler, { sessionId, commandId: 'c2', text: 'again' });
  await provider.nextUserMessage();
  provider.init();
  await until('a second session_ready', () => session.eventLog().filter((e) => e.type === 'session_ready').length === 2);
  const first = wireSessionReady(session.eventLog(), 0);
  const second = wireSessionReady(session.eventLog(), 1);
  assert.deepEqual(second.effectiveSettingSources, first.effectiveSettingSources);
  assert.deepEqual(tierNames(second.effectiveSettingSources), ['project']);
  assert.equal(second.effectiveConfiguration, ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED);
});

test('Eitri 0.2.0\'s request reports [PROJECT, LOCAL], NATIVE and a DEFAULT CLI mode', async () => {
  const golden = goldenRequests().get('create_session_fresh_partial');
  assert.ok(golden !== undefined);
  const { provider, ready } = await firstReady(CreateSessionRequest.decode(golden));
  assert.deepEqual(ready.effectiveSettingSources, [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL]);
  assert.deepEqual(provider.options.settingSources, ['project', 'local']);
  assert.equal(ready.effectiveConfiguration, ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE);
  assert.equal(ready.cliPermissionModeKind, CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DEFAULT);
  assert.equal(ready.permissionMode, 'default', 'the verbatim string is unchanged');
});

test('nothing but a session_ready carries the report: the kernel records it on that event alone', async () => {
  const { session } = await firstReady(request(ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE, undefined));
  for (const event of session.eventLog()) {
    if (event.type === 'session_ready') {
      continue;
    }
    assert.equal('effectiveSessionOptions' in event, false, event.type);
    const translated = translateEvent(event);
    assert.equal(translated.sessionReady, undefined, event.type);
  }
});

// ---- the CLI's mode ---------------------------------------------------------------------------------

/** Every spelling in the SDK's own `PermissionMode` type, read out of its declaration so a mode it gains cannot go unnoticed. */
function sdkPermissionModes(): string[] {
  const declaration = readFileSync(join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'), 'utf8');
  const match = /export declare type PermissionMode\s*=\s*([^;]+);/.exec(declaration);
  assert.ok(match !== null, 'the SDK declares no PermissionMode type');
  const modes = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(modes.length >= 6, `PermissionMode lists ${modes.join(', ')}`);
  return modes;
}

const EXPECTED_KIND: Record<string, CliPermissionModeKind> = {
  default: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DEFAULT,
  acceptEdits: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_ACCEPT_EDITS,
  plan: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_PLAN,
  bypassPermissions: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_BYPASS_PERMISSIONS,
  dontAsk: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_DONT_ASK,
  auto: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_AUTO,
};

test('every mode in the SDK\'s PermissionMode type maps to its own kind, never UNKNOWN', () => {
  for (const mode of sdkPermissionModes()) {
    const expected = EXPECTED_KIND[mode];
    assert.ok(expected !== undefined, `the SDK has a mode "${mode}" this test does not know: add it to the enum and to both maps`);
    assert.equal(cliPermissionModeKind(mode), expected, mode);
  }
  assert.deepEqual(new Set(sdkPermissionModes()), new Set(Object.keys(EXPECTED_KIND)), 'the SDK dropped a mode this sidecar still maps');
});

test('an unseen string is UNKNOWN, an empty one UNSPECIFIED, and lookalikes of known modes are not those modes', () => {
  assert.equal(cliPermissionModeKind('someFutureMode'), CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNKNOWN);
  assert.equal(cliPermissionModeKind(''), CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNSPECIFIED);
  assert.equal(cliPermissionModeKind(undefined), CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNSPECIFIED);
  for (const lookalike of ['Default', 'AUTO', 'bypass', 'accept_edits', ' plan', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(cliPermissionModeKind(lookalike), CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNKNOWN, lookalike);
  }
});

test('every mode the CLI can report reaches the wire as its kind with the verbatim string unchanged', async () => {
  for (const [mode, kind] of Object.entries(EXPECTED_KIND)) {
    const { ready } = await firstReady(request(ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE, undefined), { permissionMode: mode });
    assert.equal(ready.permissionMode, mode);
    assert.equal(ready.cliPermissionModeKind, kind, mode);
  }
});

test('a mode this sidecar does not know is UNKNOWN beside the unchanged string; no mode at all is UNSPECIFIED beside an empty one', async () => {
  const unseen = await firstReady(request(ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE, undefined), { permissionMode: 'someFutureMode' });
  assert.equal(unseen.ready.permissionMode, 'someFutureMode');
  assert.equal(unseen.ready.cliPermissionModeKind, CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNKNOWN);
  const none = await firstReady(request(ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE, undefined), { permissionMode: undefined });
  assert.equal(none.ready.permissionMode, '');
  assert.equal(none.ready.cliPermissionModeKind, CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNSPECIFIED);
});

test('the enum keeps UNSPECIFIED at zero and UNKNOWN last, so a later mode goes between them', () => {
  assert.equal(CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNSPECIFIED, 0);
  const named = Object.values(CliPermissionModeKind).filter((v): v is number => typeof v === 'number' && v >= 0);
  assert.equal(Math.max(...named), CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_UNKNOWN);
});

// ---- the wire ---------------------------------------------------------------------------------------

test('on the wire: an empty tier list and an absent one decode alike, which is why the capability exists', () => {
  const roundTrip = (effectiveSettingSources: SettingSource[]) =>
    SessionEvent.decode(SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's', sessionReady: { sessionId: 'p', effectiveSettingSources } })).finish()).sessionReady;
  assert.deepEqual(roundTrip([])?.effectiveSettingSources, []);
  assert.deepEqual(roundTrip([SettingSource.SETTING_SOURCE_LOCAL, SettingSource.SETTING_SOURCE_USER])?.effectiveSettingSources, [
    SettingSource.SETTING_SOURCE_LOCAL,
    SettingSource.SETTING_SOURCE_USER,
  ]);
});

test('the frozen client decodes a SessionReady with the new fields, dropping only them', () => {
  const event = SessionEvent.fromPartial({
    sessionId: 's',
    sessionReady: {
      sessionId: 'p',
      permissionMode: 'auto',
      effectiveSettingSources: [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL],
      effectiveConfiguration: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED,
      cliPermissionModeKind: CliPermissionModeKind.CLI_PERMISSION_MODE_KIND_AUTO,
    },
  });
  const oldEvent = old.SessionEvent.decode(SessionEvent.encode(event).finish());
  assert.equal(oldEvent.sessionReady?.sessionId, 'p');
  assert.equal(oldEvent.sessionReady?.permissionMode, 'auto');
});

// ---- the ledger -------------------------------------------------------------------------------------

test('protocol 3.18 records these fields, and its capability sits before the executable pair', async () => {
  assert.ok(PROTOCOL_MINOR >= 18, `protocol minor ${PROTOCOL_MINOR}`);
  const source = JSON.parse(readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json'), 'utf8')) as {
    capabilities: Array<{ name: string; since_minor: number }>;
    minors: Array<{ minor: number; wire_additions?: string[] }>;
  };
  assert.equal(source.capabilities.find((c) => c.name === 'effective_session_report')?.since_minor, 18);
  const recorded = source.minors.find((m) => m.minor === 18)?.wire_additions ?? [];
  for (const field of ['effective_setting_sources = 10', 'effective_configuration = 11', 'cli_permission_mode_kind = 12']) {
    assert.ok(recorded.some((line) => line.endsWith(field) && line.includes('SessionReady')), `minor 18 does not record SessionReady ${field}`);
  }
  assert.ok(recorded.includes('new enum verdandi.claude.runtime.v1.CliPermissionModeKind'));
  const res = await rpc<{ capabilities: string[] }>(sidecar().impl.handshake as Handler, { clientProtocolMajor: 3 });
  const at = res.capabilities.indexOf('effective_session_report');
  assert.ok(at >= 0 && at < res.capabilities.indexOf('executable_host_cli'), 'advertised before the executable pair');
});
