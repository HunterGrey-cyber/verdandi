import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { replayRequestFromProto } from '../src/replayRequest.js';
import { SidecarError, toGrpcStatusCode } from '../src/errorMapping.js';
import { ErrorCode, ReplayStart } from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

function expectInvalidConfiguration(fn: () => unknown, because: string): void {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof SidecarError, `expected a SidecarError (${because})`);
      assert.equal(err.code, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, because);
      // Typed all the way out: an unmapped throw from a streaming handler reaches the client as
      // UNKNOWN with no ErrorDetail, which is indistinguishable from the transport failing.
      assert.equal(toGrpcStatusCode(err), grpc.status.INVALID_ARGUMENT);
      return true;
    },
  );
}

test('replayRequestFromProto: FROM_NOW maps to from_now', () => {
  assert.deepEqual(replayRequestFromProto({ start: ReplayStart.REPLAY_START_FROM_NOW }), { mode: 'from_now' });
});

test('replayRequestFromProto: AVAILABLE_HISTORY maps to available_history', () => {
  assert.deepEqual(replayRequestFromProto({ start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY }), {
    mode: 'available_history',
  });
});

test('replayRequestFromProto: AFTER_SEQUENCE carries its cursor, including zero', () => {
  assert.deepEqual(replayRequestFromProto({ start: ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: 7n }), {
    mode: 'after_sequence',
    afterSequence: 7n,
  });
  // Zero is now an ORDINARY cursor meaning "I have seen nothing yet", not a sentinel. It gaps like
  // any other cursor, which is the whole point of the change.
  assert.deepEqual(replayRequestFromProto({ start: ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: 0n }), {
    mode: 'after_sequence',
    afterSequence: 0n,
  });
});

/**
 * The rule that replaces the old implicit one. `start` unset used to be indistinguishable from
 * `after_sequence = 0`, and the server guessed "give them everything retained" -- which is how an
 * evicted prefix went missing without anyone being told.
 */
test('replayRequestFromProto: an unset start is refused, never defaulted', () => {
  expectInvalidConfiguration(
    () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_UNSPECIFIED }),
    'an unstated intent must not be guessed at',
  );
  expectInvalidConfiguration(
    () => replayRequestFromProto({ start: 99 as ReplayStart }),
    'an unrecognized start must not fall through to a default',
  );
});

test('replayRequestFromProto: AFTER_SEQUENCE without a cursor is refused', () => {
  expectInvalidConfiguration(
    () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_AFTER_SEQUENCE }),
    'there is no cursor to replay from',
  );
});

/**
 * A cursor the server would ignore is refused rather than dropped. Silently ignoring it leaves the
 * caller believing it asked for a replay it is never going to get -- the same class of
 * misunderstanding the overloaded `after_sequence = 0` produced, just in the other direction.
 */
test('replayRequestFromProto: a cursor supplied with a cursorless mode is refused, not ignored', () => {
  expectInvalidConfiguration(
    () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_FROM_NOW, afterSequence: 5n }),
    'FROM_NOW takes no cursor',
  );
  expectInvalidConfiguration(
    () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY, afterSequence: 5n }),
    'AVAILABLE_HISTORY takes no cursor',
  );
});
