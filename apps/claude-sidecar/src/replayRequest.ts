import { SidecarError } from './errorMapping.js';
import { ErrorCode, ReplayStart } from './generated/verdandi/claude/runtime/v1/runtime.js';
import type { ReplayRequest } from './ringBuffer.js';

/**
 * Turns a `WatchSessionEventsRequest`'s start fields into the buffer's own typed request, refusing
 * every combination the protocol does not define.
 *
 * Pure, and separate from the handler, so the rules are testable without a gRPC call and stated in
 * one place. The rules themselves are on `ReplayStart` in the proto; what matters here is that each
 * violation is a typed refusal rather than a default:
 *
 * - An unset `start` is an error. That is the entire reason this enum exists -- the field it
 *   replaced used `0` to mean four different things, and guessing which one a caller meant is what
 *   silently dropped an evicted prefix.
 * - A cursor supplied with a mode that has no use for one is an error, not an ignored field. A
 *   server that quietly ignores a cursor is how a caller comes to believe it asked for something it
 *   did not.
 */
export function replayRequestFromProto(request: {
  start: ReplayStart;
  afterSequence?: bigint | undefined;
}): ReplayRequest {
  const cursor = request.afterSequence;
  switch (request.start) {
    case ReplayStart.REPLAY_START_FROM_NOW:
      requireNoCursor(cursor, 'REPLAY_START_FROM_NOW');
      return { mode: 'from_now' };

    case ReplayStart.REPLAY_START_AVAILABLE_HISTORY:
      requireNoCursor(cursor, 'REPLAY_START_AVAILABLE_HISTORY');
      return { mode: 'available_history' };

    case ReplayStart.REPLAY_START_AFTER_SEQUENCE:
      if (cursor === undefined) {
        throw new SidecarError(
          ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
          'REPLAY_START_AFTER_SEQUENCE requires after_sequence; without it there is no cursor to replay from',
        );
      }
      return { mode: 'after_sequence', afterSequence: cursor };

    default:
      throw new SidecarError(
        ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
        'WatchSessionEventsRequest.start is unset or unrecognized; it must be one of REPLAY_START_FROM_NOW, ' +
          'REPLAY_START_AFTER_SEQUENCE, or REPLAY_START_AVAILABLE_HISTORY. It is not defaulted: an unstated ' +
          'intent is exactly what the old after_sequence=0 encoding guessed at, and guessed wrong.',
      );
  }
}

function requireNoCursor(cursor: bigint | undefined, mode: string): void {
  if (cursor !== undefined) {
    throw new SidecarError(
      ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
      `${mode} does not take after_sequence, but one was supplied (${cursor}). Refused rather than ignored: ` +
        'a cursor the server silently discards leaves the caller believing it asked for a replay it will never get.',
    );
  }
}
