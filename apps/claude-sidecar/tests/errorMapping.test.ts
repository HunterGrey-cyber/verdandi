import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from '../src/errorMapping.js';
import { ErrorCode, ErrorDetail } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

test('SidecarError carries its ErrorCode and message', () => {
  const error = new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, 'no such session: sess-1');
  assert.equal(error.code, ErrorCode.ERROR_CODE_SESSION_NOT_FOUND);
  assert.equal(error.message, 'no such session: sess-1');
});

test('toGrpcMetadata: encodes an ErrorDetail into the grpc-status-details-bin key, round-trippable by the client', () => {
  const error = new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, 'command_id cmd-1 reused with a different payload');
  const metadata = toGrpcMetadata(error);

  const bytes = metadata.get('grpc-status-details-bin')[0] as Buffer;
  const decoded = ErrorDetail.decode(bytes);
  assert.equal(decoded.code, ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
  assert.equal(decoded.message, 'command_id cmd-1 reused with a different payload');
});

test('toGrpcStatusCode: session_not_found maps to NOT_FOUND', () => {
  const error = new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, 'x');
  assert.equal(toGrpcStatusCode(error), grpc.status.NOT_FOUND);
});

test('toGrpcStatusCode: idempotency_conflict and turn_already_active map to FAILED_PRECONDITION', () => {
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, 'x')), grpc.status.FAILED_PRECONDITION);
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE, 'x')), grpc.status.FAILED_PRECONDITION);
});

test('toGrpcStatusCode: event_gap maps to OUT_OF_RANGE', () => {
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_EVENT_GAP, 'x')), grpc.status.OUT_OF_RANGE);
});

test('toGrpcStatusCode: incompatible_protocol maps to FAILED_PRECONDITION', () => {
  assert.equal(toGrpcStatusCode(new SidecarError(ErrorCode.ERROR_CODE_INCOMPATIBLE_PROTOCOL, 'x')), grpc.status.FAILED_PRECONDITION);
});

test('toGrpcStatusCode: every ErrorCode this round defines has an explicit mapping, none fall through to a default UNKNOWN', () => {
  const allCodes = Object.values(ErrorCode).filter((v): v is ErrorCode => typeof v === 'number' && v !== ErrorCode.ERROR_CODE_UNSPECIFIED);
  for (const code of allCodes) {
    const mapped = toGrpcStatusCode(new SidecarError(code, 'x'));
    assert.notEqual(mapped, grpc.status.UNKNOWN, `ErrorCode ${ErrorCode[code]} has no explicit gRPC status mapping`);
  }
});
