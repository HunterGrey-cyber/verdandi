import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { PlanningError, type ClaudeRuntimeSession } from '@verdandi/claude-runtime';
import { SidecarError, toGrpcMetadata, toGrpcStatusCode } from './errorMapping.js';
import { IdempotencyCache } from './idempotency.js';
import { ErrorCode, type SetPlanningRequest, type SetPlanningResponse } from './generated/verdandi/claude/runtime/v1/runtime.js';
import type { MinimalKernelSession, SessionEntry } from './sessionRegistry.js';

type Callback = (err: grpc.ServiceError | null, res?: unknown) => void;

function toServiceError(err: unknown): grpc.ServiceError {
  let error: SidecarError;
  if (err instanceof SidecarError) {
    error = err;
  } else if (err instanceof PlanningError) {
    switch (err.kind) {
      case 'refused':
        error = new SidecarError(err.reason === 'planning_turn_running' ? ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE : ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, err.message, err.reason);
        break;
      case 'provider_refused':
        error = new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, err.message, 'planning_cli_refused');
        break;
      case 'timed_out':
        error = new SidecarError(ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED, err.message);
        break;
      case 'closed':
        error = new SidecarError(ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, err.message);
        break;
    }
  } else {
    error = new SidecarError(ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR, err instanceof Error ? err.message : String(err));
  }
  return Object.assign(new Error(error.message), { code: toGrpcStatusCode(error), details: error.message, metadata: toGrpcMetadata(error) }) as grpc.ServiceError;
}

/** The shared minimal session can also be supplied by an embedder without planning controls. */
function hasPlanning(session: MinimalKernelSession): session is MinimalKernelSession & Pick<ClaudeRuntimeSession, 'setPlanning'> {
  return 'setPlanning' in session && typeof session.setPlanning === 'function';
}

/** SetPlanning shares one outcome across retries, including duplicates still waiting on the CLI. Only
 * successful acknowledgements are cached; refusals leave the command id reusable. State belongs to the
 * registry entry; it is never shared with another session or persisted. */
export function createPlanningRpc(deps: { requireEntry(sessionId: string): SessionEntry }) {
  const states = new WeakMap<SessionEntry, {
    cache: IdempotencyCache<SetPlanningResponse>;
    inFlight: Map<string, { hash: string; outcome: Promise<SetPlanningResponse> }>;
  }>();

  return {
    setPlanning(call: { request: SetPlanningRequest }, callback: Callback): void {
      try {
        const { sessionId, commandId, enter } = call.request;
        const entry = deps.requireEntry(sessionId);
        let state = states.get(entry);
        if (state === undefined) {
          state = { cache: new IdempotencyCache(), inFlight: new Map() };
          states.set(entry, state);
        }
        const hash = createHash('sha256').update(JSON.stringify({ enter })).digest('hex');
        const conflict = () => new SidecarError(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, `command_id ${commandId} reused with a different payload`);
        const cached = state.cache.check(commandId, hash);
        if (cached.kind === 'conflict') throw conflict();
        if (cached.kind === 'replay') {
          callback(null, cached.outcome);
          return;
        }
        const running = state.inFlight.get(commandId);
        if (running !== undefined) {
          if (running.hash !== hash) throw conflict();
          running.outcome.then((response) => callback(null, response), (err: unknown) => callback(toServiceError(err)));
          return;
        }
        const { cache, inFlight } = state;
        // Register the promise before invoking the kernel, including a synchronous refusal.
        const outcome = Promise.resolve().then(() => {
          if (!hasPlanning(entry.session)) throw new PlanningError('refused', 'planning_not_offered');
          return entry.session.setPlanning(enter);
        }).then((response) => {
          const done = { permissionMode: response.permissionMode };
          cache.record(commandId, hash, done);
          return done;
        });
        inFlight.set(commandId, { hash, outcome });
        outcome.then(
          (response) => { inFlight.delete(commandId); callback(null, response); },
          (err: unknown) => { inFlight.delete(commandId); callback(toServiceError(err)); },
        );
      } catch (err) {
        callback(toServiceError(err));
      }
    },
  };
}
