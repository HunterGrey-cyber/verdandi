import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SidecarError, toGrpcStatusCode } from '../src/errorMapping.js';
import { ClientToolCallOutcome, ErrorCode, InitMcpServer, SessionEvent } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { compileProto, modelOf, type FieldModel, type ProtoModel } from './compat/protoModel.js';
import { CURRENT_PROTO } from './compat/paths.js';
import * as old from './compat/b3aa188/generated/runtime.js';

/**
 * Protocol 3.23's wire, the seam of tools a host answers itself: every message, field, enum value, error
 * code and RPC at its number, each new SessionEvent arm encoding at its tag, and a frozen client reading
 * past all of it. A host's generated client is written against these numbers, so a change here is a
 * change to that client.
 */

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

const one = (type: string, name: string, number: number) => `optional ${type} ${name} = ${number}`;
const many = (type: string, name: string, number: number) => `repeated ${type} ${name} = ${number}`;

// ---- The descriptor ---------------------------------------------------------------------------------------------

test('3.23: the new fields of existing messages are at their numbers, with their types and presence', () => {
  assert.deepEqual(fieldsOf('CreateSessionRequest', [13]), [one(`${T}ClientTools`, 'client_tools', 13)]);
  assert.deepEqual(fieldsOf('InitMcpServer'), [one('string', 'name', 1), one('string', 'status', 2), one('string', 'source', 3)]);
});

test('3.23: the new messages carry exactly their fields', () => {
  const expected: Record<string, string[]> = {
    ClientTools: [one('string', 'server_name', 1), one('uint32', 'timeout_ms', 2), many(`${T}ClientToolDeclaration`, 'tools', 3)],
    ClientToolDeclaration: [one('string', 'name', 1), one('string', 'description', 2), one('string', 'input_schema_json', 3), one('bool', 'always_load', 4)],
    ClientToolCall: [one('string', 'call_id', 1), one('string', 'tool_use_id', 2), one('string', 'tool', 3), one('string', 'arguments_json', 4)],
    ClientToolCallSettled: [one('string', 'call_id', 1), one(`${T}ClientToolCallOutcome`, 'outcome', 2)],
    ClientToolContent: ['optional string text = 1 (oneof kind)'],
    AnswerClientToolCallRequest: [
      one('string', 'session_id', 1), one('string', 'command_id', 2), one('string', 'call_id', 3), many(`${T}ClientToolContent`, 'content', 4), one('bool', 'is_error', 5),
    ],
    AnswerClientToolCallResponse: [],
    OpenClientToolCall: [one('string', 'call_id', 1), one('string', 'tool_use_id', 2), one('string', 'tool', 3)],
    GetClientToolCallStateRequest: [one('string', 'session_id', 1)],
    GetClientToolCallStateResponse: [one('uint64', 'through_sequence', 1), many(`${T}OpenClientToolCall`, 'open', 2)],
  };
  for (const [message, fields] of Object.entries(expected)) {
    assert.deepEqual(fieldsOf(message).sort(), [...fields].sort(), message);
  }
});

test('3.23: ClientToolCallOutcome has exactly its values, each prefixed with its enum\'s name', () => {
  const names = ['UNSPECIFIED', 'ANSWERED', 'INTERRUPTED', 'SESSION_CLOSED', 'TIMED_OUT', 'WITHDRAWN', 'PROVIDER_FAILED'];
  assert.deepEqual(valuesOf('ClientToolCallOutcome'), names.map((name, number) => [number, `CLIENT_TOOL_CALL_OUTCOME_${name}`]));
});

test('3.23: the new error codes are 32 and 33', () => {
  const codes = new Map(valuesOf('ErrorCode'));
  assert.equal(codes.get(32), 'ERROR_CODE_CLIENT_TOOL_CALL_NOT_FOUND');
  assert.equal(codes.get(33), 'ERROR_CODE_CLIENT_TOOL_CALL_ALREADY_ANSWERED');
});

test('3.23: a host reads the new error codes as NOT_FOUND and FAILED_PRECONDITION, not as an unmapped UNKNOWN', () => {
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_NOT_FOUND, 'x')), grpc.status.NOT_FOUND);
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_ALREADY_ANSWERED, 'x')), grpc.status.FAILED_PRECONDITION);
});

test('3.23: the new SessionEvent arms are at 50 and 51, and 42-49 stay free', () => {
  assert.deepEqual(fieldsOf('SessionEvent', [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]), [
    `optional ${T}ClientToolCall client_tool_call = 50 (oneof event)`,
    `optional ${T}ClientToolCallSettled client_tool_call_settled = 51 (oneof event)`,
  ]);
});

test('3.23: the two new RPCs are in the service with their request and response types', () => {
  const service = live.services.get(`${PKG}.RuntimeService`);
  assert.ok(service !== undefined);
  for (const [name, input, output] of [
    ['AnswerClientToolCall', 'AnswerClientToolCallRequest', 'AnswerClientToolCallResponse'],
    ['GetClientToolCallState', 'GetClientToolCallStateRequest', 'GetClientToolCallStateResponse'],
  ] as const) {
    assert.deepEqual(service.get(name), { name, input: `${T}${input}`, output: `${T}${output}`, clientStreaming: false, serverStreaming: false }, name);
  }
});

// ---- Each new arm on the wire -------------------------------------------------------------------------------------

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

const ARMS: Array<[tag: number, event: Partial<SessionEvent>]> = [
  [50, { clientToolCall: { callId: 'call-1', toolUseId: 'toolu_1', tool: 'open_file', argumentsJson: '{"path":"src/main.rs"}' } }],
  [51, { clientToolCallSettled: { callId: 'call-1', outcome: ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_TIMED_OUT } }],
];

for (const [tag, arm] of ARMS) {
  const name = Object.keys(arm)[0];
  test(`3.23: ${name} encodes at tag ${tag} and decodes to itself`, () => {
    // Only the arm is set, so it is the first key on the wire.
    const event = SessionEvent.fromPartial(arm);
    const bytes = SessionEvent.encode(event).finish();
    assert.equal(firstTag(bytes), tag);
    assert.deepEqual(SessionEvent.decode(bytes), event);
  });
}

test('3.23: an old client decodes an event with a new arm as an event with no arm, keeping the envelope', () => {
  for (const [, arm] of ARMS) {
    const bytes = SessionEvent.encode(SessionEvent.fromPartial({ sessionId: 's1', sequence: 7n, ...arm })).finish();
    const decoded = old.SessionEvent.decode(bytes);
    assert.equal(decoded.sessionId, 's1');
    assert.equal(decoded.sequence, 7n);
    assert.equal(decoded.turnStarted, undefined);
  }
});

test('3.23: a frozen client reads InitMcpServer\'s name and status from a message with source set', () => {
  const decoded = old.InitMcpServer.decode(InitMcpServer.encode({ name: 'eitri', status: 'connected', source: 'sdk' }).finish());
  assert.equal(decoded.name, 'eitri');
  assert.equal(decoded.status, 'connected');
});
