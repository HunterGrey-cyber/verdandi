import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRuntimeEvent, InitFingerprint } from './types.js';

/**
 * system/init's tools, MCP servers and API key source, read defensively: present only when the
 * message carries a `tools` array, with every entry type-checked. A drifted CLI yields a missing
 * fingerprint -- which the zero-tools invariant treats as unverifiable -- never an invented one.
 */
function initFingerprintOf(message: SDKMessage): { initFingerprint?: InitFingerprint } {
  const raw = message as unknown as Record<string, unknown>;
  if (!Array.isArray(raw.tools) || !raw.tools.every((tool): tool is string => typeof tool === 'string')) {
    return {};
  }
  const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  return {
    initFingerprint: {
      tools: raw.tools,
      mcpServers: servers.flatMap((server: unknown) => {
        const entry = server as { name?: unknown; status?: unknown } | null;
        return entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
          ? [{ name: entry.name, status: typeof entry.status === 'string' ? entry.status : '' }]
          : [];
      }),
      apiKeySource: typeof raw.apiKeySource === 'string' ? raw.apiKeySource : null,
    },
  };
}

export type TranslationContext = {
  /** The turnId this package's session actor assigned to the turn currently in flight, or
   * `undefined` if no turn is in flight (a `system`/`init` message can arrive before any turn is
   * sent). Task 3 owns assigning and clearing this as turns start and finish. */
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
   * Whether any text/thinking delta was actually emitted from a `stream_event` since the last
   * `assistant` message. Maintained by the session actor, which already sees every event this
   * function returns.
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
   * complete blocks are emitted instead. It cannot double: it fires only when zero deltas were seen.
   */
  streamedSinceLastAssistant?: boolean;
  /**
   * The API message id (`msg_...`) of the partial-streaming message currently being produced, taken
   * from its `message_start` stream event -- the only stream event that carries it; the
   * `content_block_delta`s that follow do not. Maintained by the session actor (keyed by
   * `parent_tool_use_id`, so a subagent's stream cannot relabel the main thread's), because this
   * function stays a pure function of one message. `undefined` leaves `messageId` off the deltas.
   */
  streamMessageId?: string;
};

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
      return [{ type: 'provider_notice', kind: 'system', subtype: message.subtype, raw: message }];
    }
    case 'assistant': {
      const turnId = ctx.currentTurnId;
      if (turnId === undefined) {
        // An assistant message with no turn in flight is unexpected but must never throw --
        // surface it as a notice rather than crash the session actor's read loop.
        return [{ type: 'provider_notice', kind: 'assistant', subtype: 'no_turn_in_progress', raw: message }];
      }
      // Suppress the complete text/thinking blocks ONLY when the deltas that replace them actually
      // arrived. Under partial streaming they normally did, and re-emitting would double every
      // reply; when they did not, this message is once again the only source of the reply, and
      // dropping it loses the answer entirely while every other signal says the turn succeeded.
      const suppressCompleteText = ctx.partialStreaming === true && ctx.streamedSinceLastAssistant === true;
      // One API message may arrive as several SDK assistant messages (one per content block); they
      // share `message.id`, which is exactly what lets a consumer tell "same reply, next block" from
      // "a new reply".
      const messageId = messageIdOf((message.message as { id?: unknown }).id);
      const events: ClaudeRuntimeEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === 'text') {
          if (!suppressCompleteText) {
            events.push({ type: 'text_delta', turnId, text: block.text, ...messageId });
          }
        } else if (block.type === 'thinking') {
          if (!suppressCompleteText) {
            events.push({ type: 'thinking_delta', turnId, text: block.thinking, ...messageId });
          }
        } else if (block.type === 'tool_use') {
          events.push({ type: 'tool_call_started', turnId, toolUseId: block.id, name: block.name, input: block.input });
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
      const turnId = ctx.currentTurnId;
      if (turnId === undefined) {
        return [];
      }
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
        return [{ type: 'text_delta', turnId, text: delta.text, ...messageId }];
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return [{ type: 'thinking_delta', turnId, text: delta.thinking, ...messageId }];
      }
      return [];
    }
    case 'user': {
      const turnId = ctx.currentTurnId;
      const content = message.message.content;
      if (turnId === undefined || typeof content === 'string') {
        return [];
      }
      const events: ClaudeRuntimeEvent[] = [];
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const toolResult = block as { tool_use_id: string; content: unknown; is_error?: boolean };
          events.push({
            type: 'tool_call_completed',
            turnId,
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content,
            isError: toolResult.is_error ?? false,
          });
        }
      }
      return events;
    }
    default:
      return [{ type: 'provider_notice', kind: message.type, subtype: null, raw: message }];
  }
}
