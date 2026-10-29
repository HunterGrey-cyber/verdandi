import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { InteractionAnswerError, InteractionNotFoundError, type InteractionAnswerInput, type InteractionResult } from '@verdandi/claude-runtime';
import {
  ErrorCode,
  QuestionDeclineKind,
  ResolveInteractionRequest,
  type GetInteractionStateRequest,
  type InteractionOutcome,
  type InteractionRequested,
  type QuestionAnswer,
} from './generated/verdandi/claude/runtime/v1/runtime.js';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from './errorMapping.js';
import { translateEvent } from './eventTranslation.js';
import type { SessionEntry } from './sessionRegistry.js';

/** What the interaction RPCs need from the service that hosts them. */
export type InteractionRpcDeps = {
  /** The session's entry, or SESSION_NOT_FOUND thrown. */
  requireEntry: (sessionId: string) => SessionEntry;
};

type Callback = (err: grpc.ServiceError | null, res?: unknown) => void;

function toServiceError(err: unknown): grpc.ServiceError {
  const error = err instanceof SidecarError ? err : new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR, err instanceof Error ? err.message : String(err));
  return Object.assign(new Error(error.message), { code: toGrpcStatusCode(error), details: error.message, metadata: toGrpcMetadata(error) }) as grpc.ServiceError;
}

/** The request's payload for idempotency: everything but the session and command ids, in the
 * generated JSON form, which leaves out unset fields and so hashes the same answer the same way. */
function payloadHash(request: ResolveInteractionRequest): string {
  const payload = ResolveInteractionRequest.toJSON({ ...request, sessionId: '', commandId: '' });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function notFound(interactionId: string): SidecarError {
  return new SidecarError(ErrorCode.ERROR_CODE_INTERACTION_NOT_FOUND, `no open interaction ${interactionId} on this session`);
}

function answerInputs(answers: QuestionAnswer[]): InteractionAnswerInput[] {
  return answers.map((answer) => ({
    questionIndex: answer.questionIndex,
    optionIndexes: [...answer.optionIndexes],
    ...(answer.otherText === undefined ? {} : { otherText: answer.otherText }),
    ...(answer.notes === undefined ? {} : { notes: answer.notes }),
  }));
}

/**
 * The request's result arm as the kernel takes it. A question takes answers or a decline that is a
 * cancel or a request to chat; any other shape -- no arm, or a decline kind this sidecar does not know
 * -- does not fit it.
 */
function resultOf(request: ResolveInteractionRequest): InteractionResult {
  if (request.answers !== undefined) {
    return { kind: 'answers', answers: answerInputs(request.answers.answers) };
  }
  const decline = request.decline;
  if (decline?.kind === QuestionDeclineKind.QUESTION_DECLINE_KIND_CANCEL) {
    return { kind: 'decline', decline: 'cancel', soFar: answerInputs(decline.soFar?.answers ?? []) };
  }
  if (decline?.kind === QuestionDeclineKind.QUESTION_DECLINE_KIND_CHAT) {
    return { kind: 'decline', decline: 'chat', soFar: answerInputs(decline.soFar?.answers ?? []) };
  }
  throw new SidecarError(
    ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED,
    'a question is resolved with answers, or with a decline whose kind is CANCEL or CHAT',
    'kind_mismatch',
  );
}

/** The ResolveInteraction and GetInteractionState handlers. */
export function createInteractionRpc(deps: InteractionRpcDeps) {
  return {
    /**
     * Settles one open question with the host's answer. Idempotent per `(session_id, command_id)`: the
     * same request again returns the outcome the first one had, even after the interaction is spent,
     * and a different payload under the same id is IDEMPOTENCY_CONFLICT. An id that is not open on
     * this session -- unknown, settled, or another session's -- is INTERACTION_NOT_FOUND. An answer that
     * breaks a rule is INTERACTION_ANSWER_REFUSED with the rule's name as `reason`; the question keeps
     * waiting and nothing is recorded under the command id, so a corrected answer may reuse it.
     */
    resolveInteraction(call: { request: ResolveInteractionRequest }, callback: Callback): void {
      try {
        const request = call.request;
        const entry = deps.requireEntry(request.sessionId);
        const hash = payloadHash(request);
        const cached = entry.resolveInteractionIdempotency.check(request.commandId, hash);
        if (cached.kind === 'conflict') {
          throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${request.commandId} reused with a different payload`);
        }
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        const port = entry.session.interactions();
        if (port === undefined || !port.pending().some((open) => open.interactionId === request.interactionId)) {
          throw notFound(request.interactionId);
        }
        const result = resultOf(request);
        let outcome: InteractionOutcome;
        try {
          outcome = translateEvent(port.resolve(request.interactionId, result)).interactionResolved!.outcome;
        } catch (kernelErr) {
          if (kernelErr instanceof InteractionNotFoundError) {
            throw notFound(request.interactionId);
          }
          if (kernelErr instanceof InteractionAnswerError) {
            throw new SidecarError(ErrorCode.ERROR_CODE_INTERACTION_ANSWER_REFUSED, kernelErr.message, kernelErr.reason);
          }
          throw kernelErr;
        }
        entry.resolveInteractionIdempotency.record(request.commandId, hash, { outcome });
        callback(null, { outcome });
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    /**
     * The questions still waiting on a session and the event sequence the answer was read at, both
     * read in one synchronous step. An event the session produced but has not yet sequenced comes
     * later in the stream with a sequence above `through_sequence`, so a client that applies the
     * events after it and deduplicates by `interaction_id` reaches the session's state; a question
     * absent from the snapshot and not in the events has ended.
     */
    getInteractionState(call: { request: GetInteractionStateRequest }, callback: Callback): void {
      try {
        const entry = deps.requireEntry(call.request.sessionId);
        const throughSequence = entry.sequence;
        const open = entry.session.interactions()?.pending() ?? [];
        const pending: InteractionRequested[] = open.map((event) => translateEvent(event).interactionRequested!);
        callback(null, { throughSequence, pending });
      } catch (err) {
        callback(toServiceError(err));
      }
    },
  };
}
