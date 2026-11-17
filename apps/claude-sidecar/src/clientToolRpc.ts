import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { ClientToolCallNotFoundError, ClientToolCallSettledError, type ClientToolAnswer, type ClientToolPort } from '@verdandi/claude-runtime';
import {
  AnswerClientToolCallRequest,
  ErrorCode,
  type GetClientToolCallStateRequest,
  type OpenClientToolCall,
} from './generated/verdandi/claude/runtime/v1/runtime.js';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from './errorMapping.js';
import type { SessionEntry } from './sessionRegistry.js';

/** What the client-tool RPCs need from the service that hosts them. */
export type ClientToolRpcDeps = {
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
function payloadHash(request: AnswerClientToolCallRequest): string {
  const payload = AnswerClientToolCallRequest.toJSON({ ...request, sessionId: '', commandId: '' });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function notFound(callId: string): SidecarError {
  return new SidecarError(ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_NOT_FOUND, `no client tool call ${callId} on this session`);
}

/** The answer's content as the kernel takes it. An entry with no kind is one this sidecar cannot read:
 * a kind added later reaches it that way, and dropping it would change what the model is told. */
function answerContent(request: AnswerClientToolCallRequest): ClientToolAnswer['content'] {
  return request.content.map((entry) => {
    if (entry.text === undefined) {
      throw new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'a client tool answer holds a content entry of no kind this sidecar knows', 'client_tool_content_unknown');
    }
    return { type: 'text', text: entry.text };
  });
}

function answerCall(port: ClientToolPort, request: AnswerClientToolCallRequest, content: ClientToolAnswer['content']): void {
  try {
    port.answer(request.callId, { content, isError: request.isError });
  } catch (kernelErr) {
    if (kernelErr instanceof ClientToolCallNotFoundError) {
      throw notFound(request.callId);
    }
    if (kernelErr instanceof ClientToolCallSettledError) {
      throw new SidecarError(ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_ALREADY_ANSWERED, kernelErr.message, kernelErr.outcome);
    }
    throw kernelErr;
  }
}

/** The AnswerClientToolCall and GetClientToolCallState handlers. */
export function createClientToolRpc(deps: ClientToolRpcDeps) {
  return {
    /**
     * Carries the host's answer to one open call back to the CLI. Idempotent per `(session_id,
     * command_id)`: the same request again answers OK, even after the call is spent, and a different
     * payload under the same id is IDEMPOTENCY_CONFLICT. The first answer to a call wins: a later one
     * under another command id, or an answer to a call that ended some other way, is
     * CLIENT_TOOL_CALL_ALREADY_ANSWERED with how it settled as `reason`, so a host can treat all of them
     * as done. An id this session has no record of -- never issued, another session's, or malformed,
     * which reaches nothing but a map lookup -- is CLIENT_TOOL_CALL_NOT_FOUND. Only a success is
     * recorded: after a refusal the call is as it was, and a corrected request may reuse the command id.
     */
    answerClientToolCall(call: { request: AnswerClientToolCallRequest }, callback: Callback): void {
      try {
        const request = call.request;
        const entry = deps.requireEntry(request.sessionId);
        const hash = payloadHash(request);
        const cached = entry.answerClientToolCallIdempotency.check(request.commandId, hash);
        if (cached.kind === 'conflict') {
          throw new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${request.commandId} reused with a different payload`);
        }
        if (cached.kind === 'replay') {
          callback(null, {});
          return;
        }
        const port = entry.session.clientTools();
        if (port === undefined) {
          throw notFound(request.callId);
        }
        answerCall(port, request, answerContent(request));
        entry.answerClientToolCallIdempotency.record(request.commandId, hash, {});
        callback(null, {});
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    /**
     * The calls still waiting on a session and the event sequence the answer was read at, both read in
     * one synchronous step. An event the session produced but has not yet sequenced comes later in the
     * stream with a sequence above `through_sequence`, so a client that applies the events after it and
     * deduplicates by `call_id` reaches the session's state, and a call at or below it that is not
     * listed has settled. The open set is read from the kernel rather than the ring, which may have
     * evicted a long-open call. Arguments stay out: 64 open calls of 1 MiB each would pass
     * `max_message_bytes`, and a host adopting a session needs only the ids, which the kernel bounds.
     */
    getClientToolCallState(call: { request: GetClientToolCallStateRequest }, callback: Callback): void {
      try {
        const entry = deps.requireEntry(call.request.sessionId);
        const throughSequence = entry.sequence;
        const pending = entry.session.clientTools()?.pending() ?? [];
        const open: OpenClientToolCall[] = pending.map(({ callId, toolUseId, tool }) => ({ callId, toolUseId, tool }));
        callback(null, { throughSequence, open });
      } catch (err) {
        callback(toServiceError(err));
      }
    },
  };
}
