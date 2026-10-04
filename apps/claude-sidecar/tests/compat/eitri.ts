import { readFileSync } from 'node:fs';
import { ConfigurationProfile, CreateSessionRequest, ErrorCode, ExecutableSource, PermissionMode, PersistenceMode, SettingSource, type ErrorDetail, type StreamingMode } from './b3aa188/generated/runtime.js';
import { GOLDEN_REQUESTS } from './paths.js';

/**
 * What Eitri 0.2.0 believes about a sidecar, written down as data and as the few rules it applies.
 * Every item cites the Eitri source it was read from (Eitri's own repository, at its 0.2.0 release
 * line). Nothing in here is Verdandi's opinion; it is Eitri's, frozen.
 */

/**
 * The capability list Eitri's own test fixture records for the PACKAGED sidecar it meets on a public
 * install (`real_handshake_today`, agent/src/providers/claude_sidecar/mod.rs), in b3aa188's order.
 * A checkout build adds `executable_sdk_bundled` after the last entry, and a process that proved
 * egress adds `egress_restricted` between `tool_allow_list` and `set_permission_mode`.
 *
 * Eitri reads four of these (`interrupt_turn`, `resume_session`, `text_delta_message_id`,
 * `provider_permission_prompts`) and never refuses on the others, and it only ever asks whether a
 * capability is PRESENT (`contains`), never where. So what is frozen is: none of them goes away, and
 * `executable_*` stays last (tests/packagedRuntime.test.ts's rule). Their order is informational.
 */
export const EITRI_020_CAPABILITIES: readonly string[] = [
  'handshake',
  'create_session',
  'send_turn',
  'watch_session_events',
  'interrupt_turn',
  'resolve_permission',
  'close_session',
  'resume_session',
  'fork_session',
  'setting_sources',
  'tool_policy',
  'session_model',
  'session_effort',
  'system_prompt',
  'output_format',
  'structured_output',
  'turn_usage',
  'account_identity',
  'init_fingerprint',
  'tool_allow_list',
  'set_permission_mode',
  'text_delta_message_id',
  'provider_permission_prompts',
  'executable_host_cli',
];

/** The four Eitri actually reads (`capabilities_from_handshake`, `CAP_TEXT_DELTA_MESSAGE_ID`,
 * `provider_prompts_from_handshake`). */
export const EITRI_READS_CAPABILITIES: readonly string[] = ['interrupt_turn', 'resume_session', 'text_delta_message_id', 'provider_permission_prompts'];

/** `permission_modes`: Eitri reads `interactive` (and refuses a session without it, `require_interactive`)
 * and `bypass` (`bypass_permission_mode`). */
export const EITRI_020_PERMISSION_MODES: readonly string[] = ['interactive', 'verdandi_rules', 'bypass'];

/**
 * The arms of `SessionEvent.event` that Eitri 0.2.0's proto knows (field numbers 10-22 of the frozen
 * runtime.proto), and the envelope fields 1-4 beside them. Eitri's translation drops an arm it cannot
 * decode without a word (`event.event?`), so an event outside these is invisible to it.
 */
export const EITRI_020_EVENT_ARM_FIELDS: ReadonlySet<number> = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
const SESSION_EVENT_ENVELOPE_FIELDS: ReadonlySet<number> = new Set([1, 2, 3, 4]);

/**
 * The field numbers of event arms that an old client's session may be sent although Eitri 0.2.0 cannot
 * decode them -- EMPTY, and an entry has to earn its place.
 *
 * Eitri drops an unknown arm silently, so whatever such an event says never reaches the user. An entry
 * here is therefore only acceptable when it can be argued, in the `reason`, that NOTHING a human or a
 * safety rule needs lives only in that event: every fail-closed behaviour it reports (a denial, a
 * kill, a downgrade, a refusal) must also be visible to the old client through a field it already
 * reads -- the sidecar acts on its own, or an existing event carries the same fact. Name the event,
 * say what an old client misses by not seeing it, and say where the old client gets the safety
 * information from instead. "It is only informational" is not a reason by itself; say what it informs.
 */
export const ALLOWED_UNDECODABLE_EVENT_ARMS: ReadonlyMap<number, { name: string; reason: string }> = new Map();

/** Field numbers present at the top level of a protobuf message, in wire order. Throws on a malformed buffer. */
export function topLevelFieldNumbers(bytes: Uint8Array): number[] {
  const numbers: number[] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= bytes.length) {
        throw new Error('truncated varint');
      }
      const byte = bytes[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    numbers.push(Math.floor(tag / 8));
    switch (tag % 8) {
      case 0:
        varint();
        break;
      case 1:
        at += 8;
        break;
      case 2: {
        const length = varint();
        at += length;
        break;
      }
      case 5:
        at += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${tag % 8}`);
    }
  }
  return numbers;
}

/**
 * The event arms on the wire that Eitri 0.2.0 cannot decode and that are not allowlisted: what it
 * would drop silently. A session event that carries NO arm at all is reported too (as field 0).
 */
export function undecodableArms(encodedEvent: Uint8Array, allowed: ReadonlyMap<number, unknown> = ALLOWED_UNDECODABLE_EVENT_ARMS): number[] {
  const arms = topLevelFieldNumbers(encodedEvent).filter((field) => !SESSION_EVENT_ENVELOPE_FIELDS.has(field));
  const unknown = arms.filter((field) => !EITRI_020_EVENT_ARM_FIELDS.has(field) && !allowed.has(field));
  return arms.length === 0 ? [0] : unknown;
}

/**
 * `classify_cli_mode` (agent/src/process.rs): what Eitri does with `SessionReady.permission_mode`.
 * Anything but `default`, `plan`, `dontAsk` or empty closes the session (D12).
 */
export function classifyCliMode(reported: string): 'default' | 'stricter' | 'unreported' | 'ungated' {
  switch (reported) {
    case 'default':
      return 'default';
    case 'plan':
    case 'dontAsk':
      return 'stricter';
    case '':
      return 'unreported';
    default:
      return 'ungated';
  }
}

const KNOWN_ERROR_CODES = new Set<number>([
  ErrorCode.ERROR_CODE_UNSPECIFIED,
  ErrorCode.ERROR_CODE_INCOMPATIBLE_PROTOCOL,
  ErrorCode.ERROR_CODE_UNSUPPORTED_CLI_VERSION,
  ErrorCode.ERROR_CODE_SESSION_NOT_FOUND,
  ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE,
  ErrorCode.ERROR_CODE_NO_ACTIVE_TURN,
  ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND,
  ErrorCode.ERROR_CODE_PERMISSION_ALREADY_RESOLVED,
  ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT,
  ErrorCode.ERROR_CODE_EVENT_GAP,
  ErrorCode.ERROR_CODE_INVALID_CONFIGURATION,
  ErrorCode.ERROR_CODE_PROVIDER_UNAVAILABLE,
  ErrorCode.ERROR_CODE_PROVIDER_PROTOCOL_ERROR,
  ErrorCode.ERROR_CODE_DEADLINE_EXCEEDED,
]);

/** prost's `detail.code()`: a value the client's proto has no name for reads as Unspecified. */
export function eitriCodeOf(detail: ErrorDetail): ErrorCode {
  return KNOWN_ERROR_CODES.has(detail.code) ? detail.code : ErrorCode.ERROR_CODE_UNSPECIFIED;
}

/** Eitri 0.2.0's exact requests, as prost encodes them: `name` -> bytes. See eitri-0.2.0-requests.txt. */
export function goldenRequests(): Map<string, Buffer> {
  const golden = new Map<string, Buffer>();
  for (const line of readFileSync(GOLDEN_REQUESTS, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    const [name, hex] = line.split('\t');
    golden.set(name, Buffer.from(hex, 'hex'));
  }
  return golden;
}

/** `build_create_request` (agent/src/providers/claude_sidecar/mod.rs): the ONE request both a fresh session and a resume go through. */
export function eitriCreate(cwd: string, streaming: StreamingMode, resume?: string): CreateSessionRequest {
  return CreateSessionRequest.fromPartial({
    cwd,
    policy: {
      configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
      permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
      persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      streaming,
      settingSources: { sources: [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL] },
      toolPolicy: { deny: [], unrestricted: true },
      permissionModeSwitchable: false,
      providerPermissionPrompts: true,
    },
    ...(resume !== undefined ? { resumeProviderSessionId: resume } : {}),
  });
}

