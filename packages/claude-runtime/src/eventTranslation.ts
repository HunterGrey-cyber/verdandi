import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionNoticeOf } from './sessionNotices.js';
import { resultAttribution } from './resultDetail.js';
import { BackgroundTasks } from './backgroundTasks.js';
import type { TurnFrame } from './turnTracker.js';
import type { ClaudeRuntimeEvent, InitFingerprint } from './types.js';

/**
 * system/init's tools, MCP servers and API key source, read defensively: present only when the
 * message carries a `tools` array, with every entry type-checked. A drifted CLI yields a missing
 * fingerprint -- which the zero-tools invariant treats as unverifiable -- never an invented one.
 *
 * The server list keeps the entries it can read, and says so when it could not read all of them
 * (`mcpServersUnreadable`): a missing or non-array `mcp_servers`, or an entry without a string name,
 * is not the same as "no servers", and a verified session's server check fails on it rather than
 * passing an empty set.
 */
function initFingerprintOf(message: SDKMessage): { initFingerprint?: InitFingerprint } {
  const raw = message as unknown as Record<string, unknown>;
  if (!Array.isArray(raw.tools) || !raw.tools.every((tool): tool is string => typeof tool === 'string')) {
    return {};
  }
  const servers: unknown[] = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  const readable = servers.flatMap((server: unknown) => {
    const entry = server as { name?: unknown; status?: unknown } | null;
    return entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
      ? [{ name: entry.name, status: typeof entry.status === 'string' ? entry.status : '' }]
      : [];
  });
  return {
    initFingerprint: {
      tools: raw.tools,
      mcpServers: readable,
      ...(!Array.isArray(raw.mcp_servers) || readable.length !== servers.length ? { mcpServersUnreadable: true as const } : {}),
      apiKeySource: typeof raw.apiKeySource === 'string' ? raw.apiKeySource : null,
    },
  };
}

export type TranslationContext = {
  /** Shared with the turn tracker so task edges, rosters and causes use the same launching tool. */
  backgroundTasks?: BackgroundTasks;
  /** One counted diagnostic for malformed task or notice fields in this frame. */
  onDiagnostic?: (line: string) => void;
  /** The turn selected for this frame. For a child this is the parent's recorded turn, falling back
   * to the open turn or an empty id. Main-thread work always has a turn opened by the session. */
  currentTurnId: string | undefined;
  /** True when the session asked the SDK for `includePartialMessages`.
   *
   * Load-bearing for correctness, not just a feature flag. With partials on the SDK emits BOTH the
   * incremental `stream_event`s AND, at the end, the complete `assistant` message carrying the same
   * text. Translating both would emit every character twice. So this flag switches which of the two
   * is the source of assistant TEXT -- the stream events -- while the `assistant` message stays the
   * source of tool_use blocks, whose complete input JSON is only reliable there. */
  partialStreaming?: boolean;
  /**
   * Whether a main-thread stream emitted text/thinking since its last complete assistant message,
   * with its start observed in the current turn. Maintained by the session actor, which already
   * sees every event this function returns.
   *
   * It exists because the suppression described above rests on an assumption nobody was checking:
   * that the deltas really came. `includePartialMessages` is a REQUEST, and whether it is honoured
   * is a property of the CLI version on the host, not of this code. A CLI that accepts the option
   * and emits no `stream_event` turns the suppression into total loss -- the turn completes, the
   * permission round trip works, and the reply is empty with nothing reporting a problem.
   *
   * **This is a hardening, not a fix for an observed failure, and the difference is recorded on
   * purpose.** It was written on 2026-09-18 against a downstream report of exactly that symptom
   * against CLI 2.1.272. That attribution was RETRACTED the same day: the real cause was in the
   * consumer's own test, which answered one permission request and waited, while 2.1.272 defers
   * tools and raised a second. So nothing here is validated by a measurement -- no CLI is known to
   * accept `includePartialMessages` and emit no `stream_event`, and none can be made to on demand.
   *
   * It is kept anyway because of the direction it fails in: silently, totally, and while every other
   * signal reports success. A reader deciding whether to simplify this away should weigh that, not
   * an incident that turned out to be someone else's.
   *
   * Absent (or false) with `partialStreaming` on means "nothing streamed for this message", and the
   * complete blocks are emitted instead. A matching stream message id is also required so an
   * abandoned attempt cannot suppress the reply that replaces it.
   */
  streamedSinceLastAssistant?: boolean;
  /**
   * The API message id (`msg_...`) of the partial-streaming message currently being produced, taken
   * from its `message_start` stream event -- the only stream event that carries it; the
   * `content_block_delta`s that follow do not. Maintained by the session actor (keyed by
   * `parent_tool_use_id`, so a subagent's stream cannot relabel the main thread's).
   * `undefined` leaves `messageId` off the deltas.
   */
  streamMessageId?: string;
  /**
   * Translate `system/permission_denied` into a `permission_denied` event. Absent or false: it stays
   * the `provider_notice` it always was. Set by the session from its policy (see session.ts's
   * `permissionDeniedEventsFor`), never by the message: whether a caller can take the event is a
   * property of the caller.
   */
  permissionDeniedEvents?: boolean;
};

/** A string the SDK message really carried, or nothing: a drifted CLI that sends a non-string yields
 * an absent field, never one the wire encoder would throw on. */
function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === 'string' ? { [key]: value } : {}) as { [P in K]?: string };
}

/** SDK `system/permission_denied`, verbatim. `tool_use_id`/`tool_name` are required in the SDK's type
 * but come from the CLI unvalidated, so a missing one becomes `''` rather than `undefined`. */
function permissionDeniedOf(message: SDKMessage): ClaudeRuntimeEvent {
  const raw = message as unknown as Record<string, unknown>;
  return {
    type: 'permission_denied',
    toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
    toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
    ...optionalString('reasonType', raw.decision_reason_type),
    ...optionalString('reason', raw.decision_reason),
  };
}

/** A string id, or nothing: a drifted SDK that stops sending one yields no `messageId`, never a
 * made-up or non-string one. */
function messageIdOf(value: unknown): { messageId?: string } {
  return typeof value === 'string' && value !== '' ? { messageId: value } : {};
}

/**
 * Translates one real SDK message into zero or more `ClaudeRuntimeEvent`s. Returns an array (not
 * a single event) because one `SDKAssistantMessage` can carry multiple content blocks (text,
 * thinking, tool_use in the same message) that each become their own event -- and because a
 * message this function does not recognize still needs to produce exactly one `provider_notice`,
 * never zero.
 *
 * Deliberately does NOT handle `SDKResultMessage` (turn-completion) or permission-related hook
 * output -- those need the session actor's own turn-tracking state (Task 3) and the permission
 * broker's own pending-request table (Task 4) respectively, neither of which this pure function
 * has access to. Task 3 calls this function for every message its read loop sees and separately
 * handles `message.type === 'result'` itself.
 */
export function translateMessage(message: SDKMessage, ctx: TranslationContext): ClaudeRuntimeEvent[] {
  const background = (ctx.backgroundTasks ?? new BackgroundTasks()).translate(message as unknown as Record<string, unknown>, ctx.onDiagnostic);
  if (background !== undefined) return background;
  const notices = sessionNoticeOf(message as unknown as Record<string, unknown>, ctx.onDiagnostic);
  if (notices !== undefined) return notices;
  const parent = optionalString('parentToolUseId', (message as { parent_tool_use_id?: unknown }).parent_tool_use_id);
  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        return [
          {
            type: 'session_ready',
            sessionId: message.session_id,
            providerSessionId: message.session_id,
            model: message.model,
            cwd: message.cwd,
            // Required (not optional) on the SDK's own init variant, and passed through unmapped:
            // this field exists to report the mode the provider ACTUALLY took, so translating it
            // into the requested-mode vocabulary would fold the two back together and delete the
            // only signal that they can differ.
            permissionMode: message.permissionMode,
            ...initFingerprintOf(message),
          },
        ];
      }
      if (message.subtype === 'permission_denied' && ctx.permissionDeniedEvents === true) {
        return [permissionDeniedOf(message)];
      }
      return [{ type: 'provider_notice', kind: 'system', subtype: message.subtype, raw: message }];
    }
    case 'assistant': {
      const turnId = ctx.currentTurnId ?? '';
      // A complete reply replaces an abandoned or unobserved stream. Only suppress text when
      // the main stream started in this turn and actually emitted deltas for this same message.
      const messageId = messageIdOf((message.message as { id?: unknown }).id);
      const suppressCompleteText = ctx.partialStreaming === true && ctx.streamedSinceLastAssistant === true &&
        messageId.messageId !== undefined && messageId.messageId === ctx.streamMessageId;
      const events: ClaudeRuntimeEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === 'text') {
          if (!suppressCompleteText) {
            events.push({ type: 'text_delta', turnId, text: block.text, ...messageId, ...parent });
          }
        } else if (block.type === 'thinking') {
          if (!suppressCompleteText) {
            events.push({ type: 'thinking_delta', turnId, text: block.thinking, ...messageId, ...parent });
          }
        } else if (block.type === 'tool_use') {
          ctx.backgroundTasks?.tool(block.id, block.name);
          events.push({ type: 'tool_call_started', turnId, toolUseId: block.id, name: block.name, input: block.input, ...parent });
        } else {
          events.push({ type: 'provider_notice', kind: 'assistant_content_block', subtype: block.type, raw: block });
        }
      }
      return events;
    }
    case 'stream_event': {
      // One Anthropic Messages API streaming event. Only meaningful with partial streaming on; if
      // it somehow arrives otherwise, ignoring it is right -- the complete `assistant` message is
      // still coming and carries the same text.
      if (ctx.partialStreaming !== true) {
        return [];
      }
      const turnId = ctx.currentTurnId ?? '';
      // `content_block_delta` is the only variant that carries produced content. message_start /
      // content_block_start / content_block_stop / message_delta / message_stop are framing, and
      // `input_json_delta` is a tool's arguments being assembled -- the complete, parseable input
      // arrives on the `assistant` message's tool_use block, so accumulating it here would only
      // risk emitting a half-built object.
      const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
      if (event?.type !== 'content_block_delta') {
        return [];
      }
      const delta = event.delta;
      const messageId = messageIdOf(ctx.streamMessageId);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return [{ type: 'text_delta', turnId, text: delta.text, ...messageId, ...parent }];
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return [{ type: 'thinking_delta', turnId, text: delta.thinking, ...messageId, ...parent }];
      }
      return [];
    }
    case 'user': {
      const turnId = ctx.currentTurnId ?? '';
      const content = message.message.content;
      if (typeof content === 'string') {
        return [];
      }
      const events: ClaudeRuntimeEvent[] = [];
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const toolResult = block as { tool_use_id: string; content: unknown; is_error?: boolean };
          // A background launch's result names the task's output file; the task table decides whether
          // it is that task's launch.
          if (typeof toolResult.tool_use_id === 'string') ctx.backgroundTasks?.toolResult(toolResult.tool_use_id, toolResult.content, ctx.onDiagnostic);
          events.push({
            type: 'tool_call_completed',
            turnId,
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content,
            isError: toolResult.is_error ?? false,
            ...parent,
          });
        }
      }
      return events;
    }
    default:
      return [{ type: 'provider_notice', kind: message.type, subtype: null, raw: message }];
  }
}

/** Whether the frame carries a string parent id: a subagent's frame. */
export function hasParent(raw: Record<string, unknown>): boolean {
  return typeof raw.parent_tool_use_id === 'string';
}

function optionalField<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === 'string' && value !== '' ? { [key]: value } : {}) as { [P in K]?: string };
}

/**
 * What one SDK message means for who has the floor (see `TurnTracker`). A pure function of the
 * message; every field is type-checked, and a frame that does not match what is expected is `other`.
 * A subagent's frame is always `other`: it never opens, closes or starts anything on the main thread.
 */
export function turnFrameOf(message: SDKMessage): TurnFrame {
  const raw = message as unknown as Record<string, unknown>;
  // Child lifecycle, idle and result frames are no more authoritative over the main turn than
  // child content. Classify them before looking at any frame-specific state.
  if (hasParent(raw)) return { kind: 'other' };
  switch (raw.type) {
    case 'result':
      return { kind: 'result', ...resultAttribution(message as Extract<SDKMessage, { type: 'result' }>) };
    case 'command_lifecycle':
      return typeof raw.command_uuid === 'string' && typeof raw.state === 'string' ? { kind: 'lifecycle', uuid: raw.command_uuid, state: raw.state } : { kind: 'other' };
    case 'assistant':
      return { kind: 'content' };
    case 'stream_event': {
      const event = raw.event as { type?: unknown } | undefined;
      return event?.type === 'content_block_delta' ? { kind: 'content' } : { kind: 'stream' };
    }
    case 'user': {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content) && content.some((block) => (block as { type?: unknown } | null)?.type === 'tool_result')) {
        return { kind: 'content' };
      }
      return typeof raw.uuid === 'string' && raw.uuid !== '' ? { kind: 'user_echo', uuid: raw.uuid } : { kind: 'other' };
    }
    case 'system':
      switch (raw.subtype) {
        case 'status':
          return raw.status === 'requesting' ? { kind: 'requesting' } : { kind: 'other' };
        case 'session_state_changed':
          return typeof raw.state === 'string' ? { kind: 'session_state', state: raw.state } : { kind: 'other' };
        case 'task_started':
          return typeof raw.task_id === 'string' && raw.task_id !== ''
            ? {
                kind: 'task_started',
                taskId: raw.task_id,
                ...optionalField('description', raw.description),
                ...optionalField('taskType', raw.task_type),
                ...optionalField('toolUseId', raw.tool_use_id),
                ...optionalField('runId', raw.run_id),
              }
            : { kind: 'other' };
        case 'task_notification':
          return typeof raw.task_id === 'string' && raw.task_id !== ''
            ? { kind: 'task_notification', taskId: raw.task_id, ...optionalField('status', raw.status), ...optionalField('summary', raw.summary) }
            : { kind: 'other' };
        default:
          return { kind: 'other' };
      }
    default:
      return { kind: 'other' };
  }
}
