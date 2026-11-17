import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { SessionRegistry, type MinimalKernelSession } from '../src/sessionRegistry.js';
import { buildKernelSessionConfig, createRuntimeServiceImpl, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import { createInteractionRpc } from '../src/interactionRpc.js';
import { PumpDriver } from '../src/pumpDriver.js';
import { SidecarError } from '../src/errorMapping.js';
import { translateEvent } from '../src/eventTranslation.js';
import { handshakeCapabilities } from '../src/capabilities.js';
import { startSidecar } from '../src/lifecycle.js';
import { PROTOCOL_MINOR } from '../src/generated/protocolConstants.js';
import type { SequencedEvent } from '../src/ringBuffer.js';
import {
  ClaudeHostPolicy,
  CliPermissionMode,
  ClientInteractions,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  HandshakeResponse,
  ImageContent,
  InteractionKind,
  InteractionOutcome,
  InteractionRequested,
  InteractionResolved,
  PlanAllowedPrompt,
  PlanApproval,
  PlanExecutionMode,
  PlanKeepPlanning,
  PlanProposal,
  ResolveInteractionRequest,
  RuntimeServiceClient,
  SendTurnRequest,
  SessionEvent,
  SetPlanningRequest,
  SetPlanningResponse,
  TurnContentBlock,
  TurnContentLimits,
  type GetInteractionStateResponse,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { compileProto, modelOf, type FieldModel, type ProtoModel } from './compat/protoModel.js';
import { CURRENT_PROTO } from './compat/paths.js';
import { makeFakeSession } from './fakeSession.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/** Protocol 3.26 carries plan approval as a second kind of interaction, the SetPlanning RPC and image
 * content on SendTurn, both advertised. The descriptor and codecs cover both features' wire shapes. */

const PKG = 'verdandi.claude.runtime.v1';
const T = `.${PKG}.`;

const live: ProtoModel = modelOf(compileProto(CURRENT_PROTO));

/** A field as the descriptor states it: label, type, name, number, and whether it is a real oneof
 * member or a proto3 optional. */
function describe(field: FieldModel): string {
  return `${field.label} ${field.typeName === '' ? field.type : field.typeName} ${field.name} = ${field.number}${field.oneof !== undefined ? ` (oneof ${field.oneof})` : ''}${field.proto3Optional ? ' (proto3 optional)' : ''}`;
}

function fieldsOf(message: string, numbers?: number[]): string[] {
  const model = live.messages.get(`${PKG}.${message}`);
  assert.ok(model !== undefined, `message ${message}`);
  return [...model.fields.values()].filter((f) => numbers === undefined || numbers.includes(f.number)).map(describe);
}

function valuesOf(enumeration: string): Array<[number, string]> {
  const model = live.enums.get(`${PKG}.${enumeration}`);
  assert.ok(model !== undefined, `enum ${enumeration}`);
  return [...model.values.entries()].map(([number, names]) => [number, names.join('/')]);
}

const opt = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number} (proto3 optional)`;
const one = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number}`;
const many = (type: string, name: string, number: number) => `repeated ${type} ${name} = ${number}`;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The field number of the first key in `bytes`. */
function firstTag(bytes: Uint8Array): number {
  let key = 0;
  let shift = 0;
  for (const byte of bytes) {
    key |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return key >>> 3;
    }
    shift += 7;
  }
  throw new Error('no complete key');
}

// ---- The descriptor ---------------------------------------------------------------------------------------------

test('3.26: the new fields of existing messages are at their numbers, with their types and presence', () => {
  assert.deepEqual(fieldsOf('ClientInteractions', [2]), [one('bool', 'plan_mode', 2)]);
  assert.deepEqual(fieldsOf('InteractionRequested', [11]), [`optional ${T}PlanProposal plan = 11 (oneof payload)`]);
  assert.deepEqual(fieldsOf('InteractionResolved', [5, 6, 7]), [
    one(`${T}InteractionKind`, 'kind', 5),
    opt(`${T}PlanExecutionMode`, 'mode_after', 6),
    opt('string', 'feedback', 7),
  ]);
  assert.deepEqual(fieldsOf('ResolveInteractionRequest', [12, 13]), [
    `optional ${T}PlanApproval approve = 12 (oneof result)`,
    `optional ${T}PlanKeepPlanning keep_planning = 13 (oneof result)`,
  ]);
  assert.deepEqual(fieldsOf('SendTurnRequest', [6]), [many(`${T}TurnContentBlock`, 'content', 6)]);
  assert.deepEqual(fieldsOf('HandshakeResponse', [20]), [one(`${T}TurnContentLimits`, 'turn_content_limits', 20)]);
});

test('3.26: the new messages carry exactly their fields', () => {
  const expected: Record<string, string[]> = {
    PlanProposal: [one('string', 'plan', 1), one('string', 'plan_sha256', 2), many(`${T}PlanAllowedPrompt`, 'allowed_prompts', 3)],
    PlanAllowedPrompt: [one('string', 'tool', 1), one('string', 'prompt', 2)],
    PlanApproval: [one(`${T}PlanExecutionMode`, 'mode', 1), one('string', 'plan_sha256', 2)],
    PlanKeepPlanning: [one('string', 'feedback', 1)],
    SetPlanningRequest: [one('string', 'session_id', 1), one('string', 'command_id', 2), one('bool', 'enter', 3)],
    SetPlanningResponse: [one('string', 'permission_mode', 1)],
    TurnContentBlock: [`optional ${T}ImageContent image = 1 (oneof block)`],
    ImageContent: [one('string', 'media_type', 1), one('bytes', 'data', 2)],
    TurnContentLimits: [
      many('string', 'image_media_types', 1), one('uint32', 'max_images_per_turn', 2), one('uint64', 'max_image_bytes', 3), one('uint64', 'max_content_bytes', 4),
    ],
  };
  for (const [message, fields] of Object.entries(expected)) {
    assert.deepEqual(fieldsOf(message).sort(), [...fields].sort(), message);
  }
});

test('3.26: the new enum values are at their numbers, and PlanExecutionMode has exactly its values', () => {
  assert.deepEqual(valuesOf('InteractionKind'), [[0, 'INTERACTION_KIND_UNSPECIFIED'], [1, 'INTERACTION_KIND_QUESTION'], [2, 'INTERACTION_KIND_PLAN_APPROVAL']]);
  const outcomes = new Map(valuesOf('InteractionOutcome'));
  assert.equal(outcomes.get(9), 'INTERACTION_OUTCOME_APPROVED');
  assert.equal(outcomes.get(10), 'INTERACTION_OUTCOME_KEPT_PLANNING');
  assert.equal(outcomes.size, 11);
  assert.deepEqual(valuesOf('PlanExecutionMode'), [
    [0, 'PLAN_EXECUTION_MODE_UNSPECIFIED'], [1, 'PLAN_EXECUTION_MODE_MANUAL'], [2, 'PLAN_EXECUTION_MODE_AUTO'], [3, 'PLAN_EXECUTION_MODE_BYPASS'],
  ]);
});

test('3.26: the numbers it took are no longer reserved, and the ones it leaves stay reserved', () => {
  assert.deepEqual(live.messages.get(`${PKG}.ClientInteractions`)?.reservedRanges, []);
  assert.deepEqual(live.enums.get(`${PKG}.InteractionKind`)?.reservedRanges, []);
  assert.deepEqual(live.messages.get(`${PKG}.HandshakeResponse`)?.reservedRanges, []);
  assert.deepEqual(live.messages.get(`${PKG}.ResolveInteractionRequest`)?.reservedRanges, [[14, 19]]);
  assert.deepEqual(live.messages.get(`${PKG}.TurnContentBlock`)?.reservedRanges, [[2, 2]]);
  // Content goes on the turn, not the session; plan mode's moves are reported by CliModeReported.
  assert.deepEqual(live.messages.get(`${PKG}.CreateSessionRequest`)?.reservedRanges, [[12, 12]]);
  assert.deepEqual(live.messages.get(`${PKG}.SessionEvent`)?.reservedRanges, [[27, 29]]);
});

test('3.26: SetPlanning is in the service with its request and response types', () => {
  const service = live.services.get(`${PKG}.RuntimeService`);
  assert.ok(service !== undefined);
  assert.deepEqual(service.get('SetPlanning'), { name: 'SetPlanning', input: `${T}SetPlanningRequest`, output: `${T}SetPlanningResponse`, clientStreaming: false, serverStreaming: false });
});

// ---- The generated codec ------------------------------------------------------------------------------------------

const PLAN = '# Plan\n\n1. Change `src/x.ts`.\n2. Run the tests.\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('each 3.26 message round-trips through the generated codec', () => {
  const proposal: PlanProposal = { plan: PLAN, planSha256: sha256(PLAN), allowedPrompts: [{ tool: 'Bash', prompt: 'run the tests' }] };
  const cases: Array<[name: string, codec: { encode(m: never): { finish(): Uint8Array }; decode(b: Uint8Array): unknown }, message: unknown]> = [
    ['ClientInteractions', ClientInteractions, { questions: true, planMode: true }],
    ['PlanProposal', PlanProposal, proposal],
    ['PlanAllowedPrompt', PlanAllowedPrompt, { tool: 'Bash', prompt: 'npm test' }],
    ['PlanApproval', PlanApproval, { mode: PlanExecutionMode.PLAN_EXECUTION_MODE_AUTO, planSha256: sha256(PLAN) }],
    ['PlanKeepPlanning', PlanKeepPlanning, { feedback: 'Split step 2.' }],
    ['SetPlanningRequest', SetPlanningRequest, { sessionId: 's', commandId: 'c', enter: true }],
    ['SetPlanningResponse', SetPlanningResponse, { permissionMode: 'plan' }],
    ['ImageContent', ImageContent, { mediaType: 'image/png', data: Buffer.from(PNG) }],
    ['TurnContentBlock', TurnContentBlock, { image: { mediaType: 'image/png', data: Buffer.from(PNG) } }],
    ['TurnContentLimits', TurnContentLimits, { imageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], maxImagesPerTurn: 8, maxImageBytes: 3_670_016n, maxContentBytes: 3_670_016n }],
    [
      'InteractionRequested (plan)',
      InteractionRequested,
      InteractionRequested.fromPartial({ interactionId: 'i1', toolUseId: 'toolu_p', kind: InteractionKind.INTERACTION_KIND_PLAN_APPROVAL, plan: proposal }),
    ],
    [
      'InteractionResolved (approved)',
      InteractionResolved,
      InteractionResolved.fromPartial({
        interactionId: 'i1', outcome: InteractionOutcome.INTERACTION_OUTCOME_APPROVED, kind: InteractionKind.INTERACTION_KIND_PLAN_APPROVAL,
        modeAfter: PlanExecutionMode.PLAN_EXECUTION_MODE_MANUAL,
      }),
    ],
    [
      'InteractionResolved (kept planning)',
      InteractionResolved,
      InteractionResolved.fromPartial({
        interactionId: 'i1', outcome: InteractionOutcome.INTERACTION_OUTCOME_KEPT_PLANNING, kind: InteractionKind.INTERACTION_KIND_PLAN_APPROVAL, feedback: '',
      }),
    ],
    [
      'ResolveInteractionRequest (approve)',
      ResolveInteractionRequest,
      ResolveInteractionRequest.fromPartial({ sessionId: 's', commandId: 'c', interactionId: 'i1', approve: { mode: PlanExecutionMode.PLAN_EXECUTION_MODE_BYPASS, planSha256: sha256(PLAN) } }),
    ],
    [
      'ResolveInteractionRequest (keep planning)',
      ResolveInteractionRequest,
      ResolveInteractionRequest.fromPartial({ sessionId: 's', commandId: 'c', interactionId: 'i1', keepPlanning: { feedback: 'more detail' } }),
    ],
    [
      'SendTurnRequest (content)',
      SendTurnRequest,
      SendTurnRequest.fromPartial({ sessionId: 's', commandId: 'c', text: '', content: [{ image: { mediaType: 'image/png', data: Buffer.from(PNG) } }, { image: { mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) } }] }),
    ],
    [
      'HandshakeResponse (limits)',
      HandshakeResponse,
      HandshakeResponse.fromPartial({ protocolMajor: 3, protocolMinor: 26, turnContentLimits: { imageMediaTypes: ['image/png'], maxImagesPerTurn: 1, maxImageBytes: 10n, maxContentBytes: 10n } }),
    ],
  ];
  for (const [name, codec, message] of cases) {
    const bytes = codec.encode(message as never).finish();
    assert.ok(bytes.length > 0, `${name} encodes to something`);
    assert.deepEqual(codec.decode(bytes), message, name);
  }
  // The plan and kept-planning outcome on the wire, inside a SessionEvent at the existing interaction arms.
  for (const [tag, arm] of [
    [40, { interactionRequested: InteractionRequested.fromPartial({ interactionId: 'i1', kind: InteractionKind.INTERACTION_KIND_PLAN_APPROVAL, plan: proposal }) }],
    [41, { interactionResolved: InteractionResolved.fromPartial({ interactionId: 'i1', outcome: InteractionOutcome.INTERACTION_OUTCOME_KEPT_PLANNING, kind: InteractionKind.INTERACTION_KIND_PLAN_APPROVAL, feedback: 'no' }) }],
  ] as const) {
    const event = SessionEvent.fromPartial(arm);
    const bytes = SessionEvent.encode(event).finish();
    assert.equal(firstTag(bytes), tag);
    assert.deepEqual(SessionEvent.decode(bytes), event);
  }
});

test('3.26: a frozen client reads a SendTurn with content as its text, and a handshake with limits as before', () => {
  const send = old.SendTurnRequest.decode(
    SendTurnRequest.encode(SendTurnRequest.fromPartial({ sessionId: 's', commandId: 'c', text: 'look', content: [{ image: { mediaType: 'image/png', data: Buffer.from(PNG) } }] })).finish(),
  );
  assert.deepEqual([send.sessionId, send.commandId, send.text], ['s', 'c', 'look']);
  const handshake = old.HandshakeResponse.decode(
    HandshakeResponse.encode(HandshakeResponse.fromPartial({ protocolMajor: 3, protocolMinor: 26, capabilities: ['handshake'], turnContentLimits: { maxImagesPerTurn: 8 } })).finish(),
  );
  assert.deepEqual([handshake.protocolMajor, handshake.protocolMinor, handshake.capabilities], [3, 26, ['handshake']]);
  // A client that predates the field sends no content: it decodes as an empty list.
  assert.deepEqual(SendTurnRequest.decode(old.SendTurnRequest.encode(old.SendTurnRequest.fromPartial({ sessionId: 's', commandId: 'c', text: 'hi' })).finish()).content, []);
});

// ---- Requests before their features ---------------------------------------------------------------------------------

const createdSessions: MinimalKernelSession[] = [];
after(async () => {
  for (const session of createdSessions) {
    session.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
});

function setup() {
  const registry = new SessionRegistry();
  const made: Array<ReturnType<typeof makeFakeSession>> = [];
  const configs: ClaudeSessionConfigLike[] = [];
  const impl = createRuntimeServiceImpl(
    registry,
    (config) => {
      configs.push(config);
      const fake = makeFakeSession();
      made.push(fake);
      createdSessions.push(fake.session);
      return fake.session;
    },
    { sdkDeclared: 'fake-sdk-cli-version', hostCli: '2.1.311' },
    { sdkBundledAvailable: true },
  );
  return { impl, made, configs };
}

type Handler = (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void;

function rpc<R>(fn: Handler, request: unknown): Promise<R> {
  return new Promise((resolve, reject) => fn({ request }, (err, res) => (err ? reject(err) : resolve(res as R))));
}

function refusedWith(code: grpc.status, errorCode: ErrorCode, reason: string) {
  return (err: grpc.ServiceError) => {
    assert.equal(err.code, code);
    const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
    assert.equal(detail.code, errorCode);
    assert.equal(detail.reason, reason);
    return true;
  };
}

const PROMPT_POLICY = ClaudeHostPolicy.fromPartial({ providerPermissionPrompts: true });
const ALL_FACTS = { egressRestricted: true, sdkBundledAvailable: true, cliMessageLifecycle: true, taskOutputRead: true };

test('plan_mode is advertised and validates the opt-in before creating a session', async () => {
  assert.equal(handshakeCapabilities(ALL_FACTS).includes('plan_mode_v1'), true);
  const { impl, made, configs } = setup();
  for (const [policy, reason] of [
    [PROMPT_POLICY, 'client_interactions_plan_needs_cli_mode'],
    [ClaudeHostPolicy.fromPartial({ providerPermissionPrompts: true, cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_DEFAULT, permissionModeSwitchable: true }), 'client_interactions_plan_with_switchable'],
    [undefined, 'client_interactions_needs_provider_prompts'],
  ] as const) {
    await assert.rejects(
      rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', policy, clientInteractions: { planMode: true } })),
      refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, reason),
    );
  }
  assert.equal(made.length, 0);
  for (const questions of [false, true]) {
    const policy = ClaudeHostPolicy.fromPartial({ providerPermissionPrompts: true, cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_AUTO });
    await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', policy, clientInteractions: { questions, planMode: true } }));
    assert.deepEqual(buildKernelSessionConfig(configs.at(-1)!).clientInteractions, { questions, planMode: true });
  }
  await rpc(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp', policy: PROMPT_POLICY, clientInteractions: { questions: true, planMode: false } }));
  assert.deepEqual(buildKernelSessionConfig(configs.at(-1)!).clientInteractions, { questions: true });
});

test('the handshake lists turn_content_v1 and content on SendTurn is accepted', async () => {
  assert.equal(handshakeCapabilities(ALL_FACTS).includes('turn_content_v1'), true);
  const { impl, made } = setup();
  const { sessionId } = await rpc<{ sessionId: string }>(impl.createSession as Handler, CreateSessionRequest.fromPartial({ cwd: '/tmp' }));
  // A block of a kind this sidecar does not know is refused without reserving the command id.
  await assert.rejects(
    rpc(impl.sendTurn as Handler, SendTurnRequest.fromPartial({ sessionId, commandId: 'c1', text: 'look', content: [{}] })),
    refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'turn_content_media_type'),
  );
  assert.deepEqual(made[0].controller.sentTurns, [], 'nothing reached the kernel');
  const withImage = SendTurnRequest.fromPartial({ sessionId, commandId: 'c1', text: 'look', content: [{ image: { mediaType: 'image/png', data: Buffer.from(PNG) } }] });
  await rpc(impl.sendTurn as Handler, withImage);
  assert.deepEqual(made[0].controller.sentTurns, ['look']);
  assert.deepEqual(made[0].controller.sentTurnOptions, [{ content: [{ mediaType: 'image/png', data: Buffer.from(PNG) }] }]);
});

test('SetPlanning is wired over a real socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p326-'));
  const socketPath = join(dir, 's.sock');
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: () => Object.assign(makeFakeSession().session, { setPlanning: async (enter: boolean) => ({ permissionMode: enter ? 'plan' : 'auto' }) }),
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: 'fake' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    const { sessionId } = await new Promise<{ sessionId: string }>((resolve, reject) =>
      client.createSession(CreateSessionRequest.fromPartial({ cwd: '/tmp' }), (err, res) => err ? reject(err) : resolve(res)));
    for (const enter of [true, false]) {
      const response = await new Promise<SetPlanningResponse>((resolve, reject) =>
        client.setPlanning({ sessionId, commandId: String(enter), enter }, (err, res) => err ? reject(err) : resolve(res)));
      assert.equal(response.permissionMode, enter ? 'plan' : 'auto');
    }
    await assert.rejects(new Promise((resolve, reject) =>
      client.setPlanning({ sessionId: 'missing', commandId: 'c', enter: true }, (err, res) => err ? reject(err) : resolve(res))),
      refusedWith(grpc.status.NOT_FOUND, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, ''));
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Interactions --------------------------------------------------------------------------------------------------

const QUESTION = {
  questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'p' }, { label: 'SQLite', description: 's' }] }],
};

function interactionSetup() {
  const registry = new SessionRegistry();
  const rpcs = createInteractionRpc({
    requireEntry: (sessionId) => {
      const entry = registry.get(sessionId);
      if (entry === undefined) {
        throw new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, `no such session: ${sessionId}`);
      }
      return entry;
    },
  });
  const events: SequencedEvent[] = [];
  const fake = makeFakeSession({ questions: true });
  const entry = registry.create('s1', fake.session, 64);
  const driver = new PumpDriver(entry, { onEvent: (sequenced) => events.push(sequenced), onTerminal: () => undefined });
  const asked = entry.session.interactions()!.route('AskUserQuestion', QUESTION, { signal: new AbortController().signal, toolUseID: 'toolu_q' })!;
  return { rpcs, entry, driver, events, asked };
}

async function pendingIds(rpcs: ReturnType<typeof createInteractionRpc>, sessionId: string): Promise<string[]> {
  const state = await rpc<GetInteractionStateResponse>(rpcs.getInteractionState as Handler, { sessionId });
  return state.pending.map((open) => open.interactionId);
}

test('a plan arm on a question remains a kind mismatch with plan_mode_v1 advertised', async () => {
  const { rpcs, entry, asked } = interactionSetup();
  const [interactionId] = await pendingIds(rpcs, 's1');
  assert.ok(interactionId !== undefined, 'the question is open');
  for (const arm of [
    { approve: { mode: PlanExecutionMode.PLAN_EXECUTION_MODE_MANUAL, planSha256: sha256(PLAN) } },
    { keepPlanning: { feedback: 'go on' } },
  ]) {
    await assert.rejects(
      rpc(rpcs.resolveInteraction as Handler, ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, ...arm })),
      refusedWith(grpc.status.INVALID_ARGUMENT, ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, 'kind_mismatch'),
      Object.keys(arm)[0],
    );
    assert.deepEqual(await pendingIds(rpcs, 's1'), [interactionId], 'the question keeps waiting');
  }
  // Nothing was recorded under the command id: a real answer may reuse it.
  const answered = await rpc<{ outcome: InteractionOutcome }>(
    rpcs.resolveInteraction as Handler,
    ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, answers: { answers: [{ questionIndex: 0, optionIndexes: [1] }] } }),
  );
  assert.equal(answered.outcome, InteractionOutcome.INTERACTION_OUTCOME_ANSWERED);
  assert.equal((await asked).behavior, 'allow');
  entry.session.close();
});

test('InteractionResolved of a question carries kind QUESTION', async () => {
  // Every outcome a question can end with, straight through the translation.
  for (const outcome of ['answered', 'declined', 'chat_requested', 'interrupted', 'expired', 'session_closed', 'provider_failed', 'host_refused'] as const) {
    const resolved = translateEvent({ type: 'interaction_resolved', interactionId: 'i', outcome }).interactionResolved!;
    assert.equal(resolved.kind, InteractionKind.INTERACTION_KIND_QUESTION, outcome);
    assert.equal(resolved.modeAfter, undefined, outcome);
    assert.equal(resolved.feedback, undefined, outcome);
  }
  // And a real settlement, as the session's stream carries it.
  const { rpcs, driver, events, asked } = interactionSetup();
  const [interactionId] = await pendingIds(rpcs, 's1');
  await rpc(rpcs.resolveInteraction as Handler, ResolveInteractionRequest.fromPartial({ sessionId: 's1', commandId: 'c1', interactionId, answers: { answers: [{ questionIndex: 0, optionIndexes: [0] }] } }));
  await asked;
  await driver.tick();
  const settled = events.map((sequenced) => translateEvent(sequenced.event).interactionResolved).filter((resolved) => resolved !== undefined);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.kind, InteractionKind.INTERACTION_KIND_QUESTION);
  assert.equal(settled[0]!.outcome, InteractionOutcome.INTERACTION_OUTCOME_ANSWERED);
  const wire = SessionEvent.decode(SessionEvent.encode(SessionEvent.fromPartial({ interactionResolved: settled[0] })).finish()).interactionResolved!;
  assert.equal(wire.kind, InteractionKind.INTERACTION_KIND_QUESTION);
});

// ---- The handshake ---------------------------------------------------------------------------------------------------

test('3.26: the handshake reports minor 26 and advertises plan mode, image content and its limits', async () => {
  assert.equal(PROTOCOL_MINOR, 26);
  for (const taskOutputRead of [false, true]) {
    const advertised = handshakeCapabilities({ ...ALL_FACTS, taskOutputRead });
    assert.deepEqual(advertised.filter((name) => name === 'plan_mode_v1' || name === 'turn_content_v1'), ['plan_mode_v1', 'turn_content_v1']);
  }
  const { impl } = setup();
  const response = await rpc<HandshakeResponse>(impl.handshake as Handler, { clientProtocolMajor: 3 });
  assert.equal(response.protocolMinor, 26);
  assert.equal(response.capabilities.includes('plan_mode_v1'), true);
  assert.equal(response.capabilities.includes('turn_content_v1'), true);
  const limits = {
    imageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxImagesPerTurn: 8,
    maxImageBytes: 3_670_016n,
    maxContentBytes: 3_670_016n,
  };
  assert.deepEqual(response.turnContentLimits, limits);
  assert.deepEqual(HandshakeResponse.decode(HandshakeResponse.encode(response).finish()).turnContentLimits, limits);
});
