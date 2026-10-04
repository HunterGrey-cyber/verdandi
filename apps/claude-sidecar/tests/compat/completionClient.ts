import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { ConfigurationProfile, CreateSessionRequest, ErrorCode, ExecutableSource, PermissionMode, PersistenceMode } from './b3aa188/generated/runtime.js';
import { COMPLETION_GOLDEN_REQUESTS } from './paths.js';

/**
 * What the completion client and the pipeline client believe about a sidecar, written down as data
 * and as the few rules they apply -- the way eitri.ts does it for Eitri 0.2.0. Both are Verdandi's own
 * Go clients in the same repository as the sidecar, which makes them the clients most exposed to a
 * sidecar change that "only removes an implicit default": each of them LEANS on one (the sidecar adds
 * the WebFetch deny rules, holds a completion's first turn, checks the init tool list, and installs
 * no bypass floor on an unrestricted session). What is frozen here is what they send at b3aa188 and
 * what they read back; nothing is Verdandi's opinion of today.
 *
 * Names below are those of the clients' own functions (`CompletionHostPolicy`, `RunCompletion`,
 * `checkIdentity`, `Classify`, `Start`), so the code they were read from can be found.
 */

/**
 * `CompletionCapabilities`: the capabilities a sidecar must advertise before the completion client is
 * routed to it. Each promises one field its run depends on: system-prompt replacement, output format,
 * structured output (and the result's own error fields), token usage, the account identity, and the
 * init fingerprint with the zero-tools close.
 */
export const COMPLETION_CAPABILITIES: readonly string[] = ['system_prompt', 'output_format', 'structured_output', 'turn_usage', 'account_identity', 'init_fingerprint'];

/**
 * `WebToolCapabilities`: what a sidecar must ALSO advertise before a completion with tools goes to it.
 * `tool_allow_list` is the kernel's exact check of a non-empty allow list plus the WebFetch private
 * address deny rules; `egress_restricted` is a claim that startup PROVED the process cannot reach
 * loopback, so it is present only when the process was started that way.
 */
export const WEB_TOOL_CAPABILITIES: readonly string[] = ['tool_allow_list', 'egress_restricted'];

/** The one major both clients send (`ClientProtocolMajor`). */
export const COMPLETION_CLIENT_PROTOCOL_MAJOR = 3;

/** The placeholders the golden requests carry. */
export const GOLDEN_CWD = '/work/run-1';
export const GOLDEN_SESSION_ID = 'S';
export const GOLDEN_SYSTEM_PROMPT = 'SYSTEM';
export const GOLDEN_INPUT = 'INPUT';
export const GOLDEN_FOLLOW_UP_INPUT = 'INPUT2';
export const GOLDEN_SCHEMA = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
export const GOLDEN_MODEL = 'sonnet';
export const GOLDEN_EFFORT = 'medium';

/** The web tools the completion client requests (`Tools: ["WebFetch","WebSearch"]`). */
export const WEB_COMPLETION_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];

/**
 * The carrier tool the CLI reports in system/init for a session with an output format: the CLI delivers
 * structured output through a synthetic tool call, and the sidecar's init check permits exactly it
 * beside the requested tools.
 */
export const STRUCTURED_OUTPUT_CARRIER = 'StructuredOutput';

/** `Classify`'s reading of a failed turn: the fields the error-class table keys on, all of them. */
export const CLASSIFY_READS_TURN_FIELDS: readonly string[] = ['outcome', 'isError', 'resultText', 'resultSubtype', 'terminalReason', 'apiErrorStatus', 'errors', 'structuredOutputJson'];

/** The gRPC status codes `decide` (the completion runner) looks at on a failed RPC: these two mean "the sidecar refused the session as malformed". */
export const RUNNER_MALFORMED_STATUS_CODES: readonly grpc.status[] = [grpc.status.INVALID_ARGUMENT, grpc.status.FAILED_PRECONDITION];

/** The error codes the sidecar must keep for the conditions the clients can reach, with the gRPC status each travels as. */
export const CLIENT_REACHABLE_ERRORS: ReadonlyArray<{ condition: string; code: ErrorCode; status: grpc.status }> = [
  { condition: 'an invalid session policy or output format (a refused CreateSession)', code: ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, status: grpc.status.INVALID_ARGUMENT },
  { condition: 'a call on a session that has been closed or never existed', code: ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, status: grpc.status.NOT_FOUND },
  { condition: 'a ResolvePermission for a request that is not pending', code: ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND, status: grpc.status.NOT_FOUND },
];

/** The golden requests, in file order: `name` -> bytes. See b3aa188/completion-client-requests.txt. */
export function completionGoldenRequests(): Map<string, Buffer> {
  const golden = new Map<string, Buffer>();
  for (const line of readFileSync(COMPLETION_GOLDEN_REQUESTS, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    const [name, hex] = line.split('\t');
    golden.set(name, Buffer.from(hex, 'hex'));
  }
  return golden;
}

/** `CompletionHostPolicy` + `RunCompletion`'s CreateSessionRequest. `tools` empty is the zero-tool session: an explicit EMPTY allow list, never unrestricted. */
export function completionCreate(tools: readonly string[], profile?: { model: string; effort: string }): CreateSessionRequest {
  return CreateSessionRequest.fromPartial({
    cwd: GOLDEN_CWD,
    policy: {
      configuration: ConfigurationProfile.CONFIGURATION_PROFILE_ISOLATED,
      permissions: PermissionMode.PERMISSION_MODE_BYPASS,
      persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      toolPolicy: { deny: [], unrestricted: false, allow: { tools: [...tools] } },
      settingSources: { sources: [] },
    },
    systemPrompt: GOLDEN_SYSTEM_PROMPT,
    outputFormat: { jsonSchemaJson: GOLDEN_SCHEMA },
    ...(profile !== undefined ? { model: profile.model, effort: profile.effort } : {}),
  });
}

/** `start()` under bypass (the pipeline client): NATIVE, BYPASS, ToolPolicy{unrestricted}, no setting sources, no output format; model and effort only when chosen. */
export function pipelineCreate(profile?: { model: string; effort: string }): CreateSessionRequest {
  return CreateSessionRequest.fromPartial({
    cwd: GOLDEN_CWD,
    policy: {
      configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
      permissions: PermissionMode.PERMISSION_MODE_BYPASS,
      persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      toolPolicy: { deny: [], unrestricted: true },
    },
    ...(profile !== undefined ? { model: profile.model, effort: profile.effort } : {}),
  });
}

/** The CreateSession requests the clients send, built with the FROZEN TypeScript client's types, by golden name. */
export const COMPLETION_CLIENT_CREATE_REQUESTS: Record<string, () => Uint8Array> = {
  completion_create_zero_tool: () => CreateSessionRequest.encode(completionCreate([], { model: GOLDEN_MODEL, effort: GOLDEN_EFFORT })).finish(),
  completion_create_zero_tool_default_model: () => CreateSessionRequest.encode(completionCreate([])).finish(),
  completion_create_web_tools: () => CreateSessionRequest.encode(completionCreate(WEB_COMPLETION_TOOLS, { model: GOLDEN_MODEL, effort: GOLDEN_EFFORT })).finish(),
  pipeline_create_bypass: () => CreateSessionRequest.encode(pipelineCreate()).finish(),
  pipeline_create_bypass_profile: () => CreateSessionRequest.encode(pipelineCreate({ model: GOLDEN_MODEL, effort: GOLDEN_EFFORT })).finish(),
};
