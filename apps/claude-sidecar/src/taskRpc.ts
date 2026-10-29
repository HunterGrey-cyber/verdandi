import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { TaskNotFoundError, TaskOutputUnavailableError } from '@verdandi/claude-runtime';
import { ErrorCode, type GetTaskOutputRequest, type StopTaskRequest } from './generated/verdandi/claude/runtime/v1/runtime.js';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from './errorMapping.js';
import type { SessionEntry } from './sessionRegistry.js';

/** What the task RPCs need from the service that hosts them. */
export type TaskRpcDeps = {
  /** The session's entry, or SESSION_NOT_FOUND thrown. */
  requireEntry: (sessionId: string) => SessionEntry;
};

type Callback = (err: grpc.ServiceError | null, res?: unknown) => void;

/** The kernel's task refusals as the wire's error codes; anything else the CLI or SDK threw is a
 * provider error, as for the other RPCs. */
function toServiceError(err: unknown): grpc.ServiceError {
  const error =
    err instanceof SidecarError
      ? err
      : err instanceof TaskNotFoundError
        ? new SidecarError(ErrorCode.ERROR_CODE_TASK_NOT_FOUND, err.message)
        : err instanceof TaskOutputUnavailableError
          ? new SidecarError(ErrorCode.ERROR_CODE_TASK_OUTPUT_UNAVAILABLE, err.message)
          : new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR, err instanceof Error ? err.message : String(err));
  return Object.assign(new Error(error.message), { code: toGrpcStatusCode(error), details: error.message, metadata: toGrpcMetadata(error) }) as grpc.ServiceError;
}

/** StopTask's payload for idempotency: the task, the only field besides the session and command ids. */
function payloadHash(request: StopTaskRequest): string {
  return createHash('sha256').update(JSON.stringify({ taskId: request.taskId })).digest('hex');
}

/** The StopTask and GetTaskOutput handlers. */
export function createTaskRpc(deps: TaskRpcDeps) {
  /** StopTask calls still waiting on the CLI, per session and command id. A duplicate that arrives in
   * that window joins the call in flight instead of sending the CLI a second stop. */
  const inFlight = new WeakMap<SessionEntry, Map<string, { payloadHash: string; outcome: Promise<void> }>>();

  return {
    /**
     * Stops one background task, a workflow's whole run included. Idempotent per
     * `(session_id, command_id)`: the same request again succeeds without reaching the CLI, and another
     * task under the same id is IDEMPOTENCY_CONFLICT. A task the session never saw is TASK_NOT_FOUND;
     * one that has already ended succeeds. Only a success is recorded under the command id, so a
     * refused request may be sent again under it.
     */
    stopTask(call: { request: StopTaskRequest }, callback: Callback): void {
      try {
        const request = call.request;
        const entry = deps.requireEntry(request.sessionId);
        const hash = payloadHash(request);
        const conflict = () => new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${request.commandId} reused with a different payload`);
        const cached = entry.stopTaskIdempotency.check(request.commandId, hash);
        if (cached.kind === 'conflict') throw conflict();
        if (cached.kind === 'replay') {
          callback(null, {});
          return;
        }
        let calls = inFlight.get(entry);
        if (calls === undefined) {
          calls = new Map();
          inFlight.set(entry, calls);
        }
        const running = calls.get(request.commandId);
        if (running !== undefined) {
          if (running.payloadHash !== hash) throw conflict();
          running.outcome.then(
            () => callback(null, {}),
            (err: unknown) => callback(toServiceError(err)),
          );
          return;
        }
        // Registered before the kernel is called, so even a refusal it throws at once leaves no entry.
        const outcome = Promise.resolve()
          .then(() => entry.session.stopTask(request.taskId))
          .then(() => entry.stopTaskIdempotency.record(request.commandId, hash, {}));
        const waiting = calls;
        waiting.set(request.commandId, { payloadHash: hash, outcome });
        outcome.then(
          () => {
            waiting.delete(request.commandId);
            callback(null, {});
          },
          (err: unknown) => {
            waiting.delete(request.commandId);
            callback(toServiceError(err));
          },
        );
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    /**
     * The tail of a shell's or a Monitor's output, read by the kernel from the file the CLI named for
     * that task; the request carries no path. A read, so there is no command id. TASK_NOT_FOUND for a
     * task the session never saw; TASK_OUTPUT_UNAVAILABLE when there is nothing it may read (always
     * for a workflow or a local agent).
     */
    getTaskOutput(call: { request: GetTaskOutputRequest }, callback: Callback): void {
      try {
        const entry = deps.requireEntry(call.request.sessionId);
        Promise.resolve()
          .then(() => entry.session.taskOutput(call.request.taskId))
          .then(
            (read) => callback(null, { output: Buffer.from(read.output), totalBytes: BigInt(read.totalBytes), truncated: read.truncated }),
            (err: unknown) => callback(toServiceError(err)),
          );
      } catch (err) {
        callback(toServiceError(err));
      }
    },
  };
}
