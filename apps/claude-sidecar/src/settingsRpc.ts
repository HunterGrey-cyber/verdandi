import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { SessionSettingsError, type AppliedSettings } from '@verdandi/claude-runtime';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from './errorMapping.js';
import { ErrorCode, type ApplyEffortRequest, type ListModelsRequest, type SetModelRequest } from './generated/verdandi/claude/runtime/v1/runtime.js';
import type { SessionEntry } from './sessionRegistry.js';

type Callback = (err: grpc.ServiceError | null, res?: unknown) => void;

export type SettingsRpcDeps = {
  requireEntry(sessionId: string): SessionEntry;
};

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** A kernel refusal in the wire's words: `refused` is the reason for a request the kernel would not put
 * to the CLI, `provider` for one the CLI turned down. Anything else is a provider error, as for the
 * other RPCs. */
function toServiceError(err: unknown, refused = '', provider = ''): grpc.ServiceError {
  const error =
    err instanceof SidecarError
      ? err
      : err instanceof SessionSettingsError
        ? err.kind === 'closed'
          ? new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, err.message)
          : err.kind === 'timed_out'
            ? new SidecarError(ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED, err.message)
            : new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, err.message, err.kind === 'refused' ? refused : provider)
        : new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR, err instanceof Error ? err.message : String(err));
  return Object.assign(new Error(error.message), { code: toGrpcStatusCode(error), details: error.message, metadata: toGrpcMetadata(error) }) as grpc.ServiceError;
}

/** The SetModel, ListModels and ApplyEffort handlers. */
export function createSettingsRpc(deps: SettingsRpcDeps) {
  /** Changes still waiting on the CLI, per session and command id. A duplicate that arrives in that
   * window joins the call in flight instead of changing the session twice. */
  const inFlight = new WeakMap<SessionEntry, Map<string, { payloadHash: string; outcome: Promise<AppliedSettings> }>>();

  /** One change, idempotent per `(session_id, command_id)`. Only a success is recorded under the command
   * id, so a refused request may be sent again under it. */
  function change(
    operation: string,
    request: { sessionId: string; commandId: string },
    payload: unknown,
    reasons: { refused: string; provider: string },
    run: (entry: SessionEntry) => Promise<AppliedSettings>,
    callback: Callback,
  ): void {
    try {
      const entry = deps.requireEntry(request.sessionId);
      const hash = payloadHash(payload);
      // Dedupe is per operation: the two RPCs share one cache, and an id may be used once by each.
      const key = `${operation}:${request.commandId}`;
      const conflict = () => new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${request.commandId} reused with a different payload`);
      const cached = entry.settingsIdempotency.check(key, hash);
      if (cached.kind === 'conflict') throw conflict();
      if (cached.kind === 'replay') {
        callback(null, { applied: cached.outcome });
        return;
      }
      let calls = inFlight.get(entry);
      if (calls === undefined) {
        calls = new Map();
        inFlight.set(entry, calls);
      }
      const running = calls.get(key);
      if (running !== undefined) {
        if (running.payloadHash !== hash) throw conflict();
        running.outcome.then(
          (applied) => callback(null, { applied }),
          (err: unknown) => callback(toServiceError(err, reasons.refused, reasons.provider)),
        );
        return;
      }
      // Registered before the kernel is called, so even a refusal it throws at once leaves no entry.
      const outcome = Promise.resolve()
        .then(() => run(entry))
        .then((applied) => {
          entry.settingsIdempotency.record(key, hash, applied);
          return applied;
        });
      const waiting = calls;
      waiting.set(key, { payloadHash: hash, outcome });
      outcome.then(
        (applied) => {
          waiting.delete(key);
          callback(null, { applied });
        },
        (err: unknown) => {
          waiting.delete(key);
          callback(toServiceError(err, reasons.refused, reasons.provider));
        },
      );
    } catch (err) {
      callback(toServiceError(err));
    }
  }

  return {
    /** Changes the model of the running session; see `ClaudeRuntimeSession.setModel`. */
    setModel(call: { request: SetModelRequest }, callback: Callback): void {
      const { model } = call.request;
      change(
        'set_model',
        call.request,
        { model },
        { refused: 'model_invalid', provider: 'model_refused' },
        (entry) => entry.session.setModel(model),
        callback,
      );
    },

    /** The models the CLI offers. A read, so it carries no command id. */
    listModels(call: { request: ListModelsRequest }, callback: Callback): void {
      try {
        const entry = deps.requireEntry(call.request.sessionId);
        Promise.resolve()
          .then(() => entry.session.listModels())
          .then(
            (listed) => callback(null, listed),
            (err: unknown) => callback(toServiceError(err, 'models_unavailable', 'models_unavailable')),
          );
      } catch (err) {
        callback(toServiceError(err));
      }
    },

    /** Sets the session's effort; see `ClaudeRuntimeSession.applyEffort`. */
    applyEffort(call: { request: ApplyEffortRequest }, callback: Callback): void {
      const { effort } = call.request;
      change(
        'apply_effort',
        call.request,
        { effort },
        { refused: 'effort_unknown', provider: 'effort_refused' },
        (entry) => entry.session.applyEffort(effort),
        callback,
      );
    },
  };
}
