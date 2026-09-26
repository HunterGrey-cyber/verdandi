import * as grpc from '@grpc/grpc-js';
import { ErrorCode, ErrorDetail } from './generated/verdandi/claude/runtime/v1/runtime.js';

export class SidecarError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
  }
}

const STATUS_CODE_MAP: Record<number, grpc.status> = {
  [ErrorCode.ERROR_CODE_INCOMPATIBLE_PROTOCOL]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_SESSION_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_NO_ACTIVE_TURN]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.ERROR_CODE_PERMISSION_ALREADY_RESOLVED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.ERROR_CODE_EVENT_GAP]: grpc.status.OUT_OF_RANGE,
  [ErrorCode.ERROR_CODE_INVALID_CONFIGURATION]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE]: grpc.status.UNAVAILABLE,
  [ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR]: grpc.status.INTERNAL,
  [ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED]: grpc.status.DEADLINE_EXCEEDED,
  [ErrorCode.UNRECOGNIZED]: grpc.status.INTERNAL,
};

export function toGrpcStatusCode(error: SidecarError): grpc.status {
  return STATUS_CODE_MAP[error.code] ?? grpc.status.UNKNOWN;
}

/** Encodes an ErrorDetail into the gRPC rich-error-model trailing metadata key (design spec §5.3). */
export function toGrpcMetadata(error: SidecarError): grpc.Metadata {
  const detail: ErrorDetail = { code: error.code, message: error.message };
  const bytes = ErrorDetail.encode(detail).finish();
  const metadata = new grpc.Metadata();
  metadata.set('grpc-status-details-bin', Buffer.from(bytes));
  return metadata;
}
