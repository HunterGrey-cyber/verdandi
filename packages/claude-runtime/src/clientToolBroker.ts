import { randomUUID } from 'node:crypto';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CLIENT_TOOL_LIMITS, type ClientTools } from './clientTools.js';
import { mcpToolServer } from './toolInvariant.js';
import type { ClaudeRuntimeEvent, ClientToolCallEvent, ClientToolCallOutcome, ClientToolCallSettledEvent } from './types.js';

/** Why every open call is being settled at once. */
export type ClientToolFailCause = 'interrupted' | 'session_closed' | 'provider_failed';

/** What the host answered to one call. */
export type ClientToolAnswer = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

/** `answer()` was given an id this session has no record of: never one of its calls, or one that left
 * the settled history. Nothing changed. */
export class ClientToolCallNotFoundError extends Error {
  constructor(readonly callId: string) {
    super(`no client tool call ${callId} on this session`);
    this.name = 'ClientToolCallNotFoundError';
  }
}

/** The call has settled; `outcome` says how. Nothing changed. */
export class ClientToolCallSettledError extends Error {
  constructor(
    readonly callId: string,
    readonly outcome: ClientToolCallOutcome,
  ) {
    super(`client tool call ${callId} has settled: ${outcome}`);
    this.name = 'ClientToolCallSettledError';
  }
}

export interface ClientToolPort {
  /** What goes under the server's name in `options.mcpServers`. */
  sdkServer(): McpSdkServerConfigWithInstance;
  /** The calls still open, oldest first. */
  pending(): ClientToolCallEvent[];
  /** Answers one open call: the CLI gets one result, the host's stream one settled event. Throws
   * `ClientToolCallSettledError` or `ClientToolCallNotFoundError` for an id that is not open. */
  answer(callId: string, answer: ClientToolAnswer): ClientToolCallSettledEvent;
  /** Settles every open call but those of an agent `spares` names (an interrupt that leaves background
   * tasks running passes it). `session_closed` and `provider_failed` also close the port for good. */
  failAll(cause: ClientToolFailCause, spares?: (agentId: string) => boolean): void;
  /** The PreToolUse hook let this call through: remembers which agent it belongs to. Ignored for a tool of
   * another server, an empty id or no agent. */
  noteAgent(toolName: string, toolUseId: string, agentId: string | undefined): void;
}

/** Where the CLI puts the model's `tool_use` id on a `tools/call` (CLI 2.1.311). The hook sees the same id. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

/** On a `tools/list` entry: keeps that tool out of ToolSearch, in the model's list from the first request. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

const FAIL_TEXT: Record<ClientToolFailCause, string> = {
  interrupted: 'The host did not answer this tool call: the turn was interrupted.',
  session_closed: 'The host did not answer this tool call: the session closed.',
  provider_failed: 'The host did not answer this tool call: the provider failed.',
};

const ABORTED_TEXT = 'The host did not answer this tool call: the CLI stopped waiting for it.';

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Records in a map kept in insertion order, past the limit dropping the oldest entry. */
function recordBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size > CLIENT_TOOL_LIMITS.settledHistory) {
    map.delete(map.keys().next().value as string);
  }
}

type OpenCall = {
  event: ClientToolCallEvent;
  /** The subagent that made the call, when the hook named one. */
  agentId?: string;
  /** Resolves the MCP handler's promise. */
  finish: (result: CallToolResult) => void;
  /** Removes this call's abort listener. */
  cleanupAbortListener: () => void;
};

/**
 * Owns the calls one session's model has made to the tools its host declared and the host has not
 * answered yet, and serves those tools to the CLI as an in-process MCP server.
 *
 * The server is the MCP SDK's low-level `Server` rather than the Agent SDK's `createSdkMcpServer`, which
 * takes zod shapes where a host declares JSON Schema. `Server` answers `initialize`, `ping` and every
 * unknown method by itself, aborts a handler's `extra.signal` on `notifications/cancelled` and when the
 * transport closes, and sends no response for an aborted request.
 *
 * Arguments are not checked against the declared schema: the CLI does not, and the tool's meaning is the
 * host's. There is no timer and no default here either: the CLI's limit on the server (`timeoutMs`) is
 * the bound, and it fires the signal.
 *
 * A call ends exactly once, by the first of: the host's answer, `failAll`, or the signal aborting. Every
 * end goes through `settle`, whose removal from `open` is what makes it once. Events go out through
 * `emit`, the same out-of-band channel the permission and question brokers use: one `client_tool_call`
 * and then exactly one `client_tool_call_settled` per call shown. A call refused before it is shown
 * announces nothing, so no settled event is owed for it.
 *
 * The outcome of an abort is read from elapsed time alone, since the reasons on the signal are other
 * programs' words. It is a best-effort label and no host may branch on it: a CLI cancel in the last
 * second reads `timed_out`, a provider dying late in the limit too, and a call that arrives between
 * `interrupt()`'s first `failAll` and the CLI's abort reads `withdrawn`. When the provider dies and the
 * SDK closes its transport before the session notices, the same path settles the call with one of the
 * two labels rather than `provider_failed`.
 */
class ClientToolBroker implements ClientToolPort {
  private readonly open = new Map<string, OpenCall>();
  /** How each call ended, for refusing a late answer. Oldest first, bounded. */
  private readonly settled = new Map<string, ClientToolCallOutcome>();
  /** `tool_use` id to agent, as the hook saw them, until the call claims its entry. An entry a call
   * never claims ages out; the CLI does not reuse a `tool_use` id. Oldest first, bounded. */
  private readonly agents = new Map<string, string>();
  private readonly server: Server;
  private readonly serverName: string;
  private readonly timeoutMs: number;
  private readonly toolNames: ReadonlySet<string>;
  private readonly now: () => number;
  private closed = false;

  constructor(
    clientTools: ClientTools,
    private readonly emit: (event: ClaudeRuntimeEvent) => void,
    now: (() => number) | undefined,
  ) {
    this.serverName = clientTools.serverName;
    this.timeoutMs = clientTools.timeoutMs;
    this.toolNames = new Set(clientTools.tools.map((tool) => tool.name));
    // A monotonic clock, so a clock step or a suspend cannot move a call past its limit.
    this.now = now ?? (() => performance.now());
    const tools: Tool[] = clientTools.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(tool.inputSchemaJson) as Tool['inputSchema'],
      ...(tool.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
    }));
    this.server = new Server({ name: clientTools.serverName, version: '1.0.0' }, { capabilities: { tools: {} } });
    // A response sent after the SDK closed its transport fails with nowhere to report to.
    this.server.onerror = () => undefined;
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.call(request, extra.signal));
  }

  sdkServer(): McpSdkServerConfigWithInstance {
    // The type names the high-level `McpServer`; the Agent SDK only calls `connect`, which both have.
    return { type: 'sdk', name: this.serverName, timeout: this.timeoutMs, instance: this.server as unknown as McpSdkServerConfigWithInstance['instance'] };
  }

  pending(): ClientToolCallEvent[] {
    return [...this.open.values()].map((entry) => ({ ...entry.event }));
  }

  answer(callId: string, answer: ClientToolAnswer): ClientToolCallSettledEvent {
    const settled = this.settle(callId, 'answered', { content: answer.content, ...(answer.isError ? { isError: true } : {}) });
    if (settled !== undefined) {
      return settled;
    }
    const outcome = this.settled.get(callId);
    throw outcome === undefined ? new ClientToolCallNotFoundError(callId) : new ClientToolCallSettledError(callId, outcome);
  }

  failAll(cause: ClientToolFailCause, spares?: (agentId: string) => boolean): void {
    if (cause !== 'interrupted') {
      this.closed = true;
    }
    for (const [callId, entry] of this.open) {
      if (entry.agentId !== undefined && spares?.(entry.agentId) === true) {
        continue;
      }
      this.settle(callId, cause, errorResult(FAIL_TEXT[cause]));
    }
  }

  noteAgent(toolName: string, toolUseId: string, agentId: string | undefined): void {
    if (mcpToolServer(toolName) === this.serverName && toolUseId !== '' && agentId !== undefined) {
      recordBounded(this.agents, toolUseId, agentId);
    }
  }

  private refusal(request: CallToolRequest, argumentsJson: string, toolUseId: string, signal: AbortSignal): string | undefined {
    const { name } = request.params;
    if (signal.aborted) {
      // The CLI stopped waiting before the call could be registered, and an abort listener added now
      // would never fire. `Server` drops this result.
      return 'The CLI stopped waiting for this tool call before it reached the host.';
    }
    if (!this.toolNames.has(name)) {
      return `${name} is not a tool of this server.`;
    }
    if (this.closed) {
      return 'The session is closing: this tool call did not reach the host.';
    }
    if (Buffer.byteLength(argumentsJson, 'utf8') > CLIENT_TOOL_LIMITS.argumentsBytes) {
      return `The arguments of this tool call are longer than ${CLIENT_TOOL_LIMITS.argumentsBytes} bytes: it did not reach the host.`;
    }
    // Refused rather than cut: the host joins this id to the model's tool_use, and a cut one joins nothing.
    if (Buffer.byteLength(toolUseId, 'utf8') > CLIENT_TOOL_LIMITS.toolUseIdBytes) {
      return `The tool_use id of this tool call is longer than ${CLIENT_TOOL_LIMITS.toolUseIdBytes} bytes: it did not reach the host.`;
    }
    if (this.open.size >= CLIENT_TOOL_LIMITS.liveCalls) {
      return `${CLIENT_TOOL_LIMITS.liveCalls} tool calls are already waiting for the host on this session: this one did not reach it.`;
    }
    return undefined;
  }

  private call(request: CallToolRequest, signal: AbortSignal): CallToolResult | Promise<CallToolResult> {
    const argumentsJson = JSON.stringify(request.params.arguments ?? {});
    const metaId = request.params._meta?.[TOOL_USE_ID_META];
    const toolUseId = typeof metaId === 'string' ? metaId : '';
    const refusal = this.refusal(request, argumentsJson, toolUseId, signal);
    if (refusal !== undefined) {
      return errorResult(refusal);
    }
    const agentId = this.agents.get(toolUseId);
    this.agents.delete(toolUseId);
    const callId = randomUUID();
    const startedAt = this.now();
    const event: ClientToolCallEvent = { type: 'client_tool_call', callId, toolUseId, tool: request.params.name, argumentsJson };
    return new Promise<CallToolResult>((finish) => {
      const onAbort = (): void => {
        this.settle(callId, this.abortOutcome(startedAt), errorResult(ABORTED_TEXT));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.open.set(callId, {
        event,
        ...(agentId === undefined ? {} : { agentId }),
        finish,
        cleanupAbortListener: () => signal.removeEventListener('abort', onAbort),
      });
      this.emit(event);
    });
  }

  private abortOutcome(startedAt: number): ClientToolCallOutcome {
    return this.now() - startedAt >= Math.max(this.timeoutMs - 1000, this.timeoutMs / 2) ? 'timed_out' : 'withdrawn';
  }

  /** Ends an open call; `undefined`, with nothing changed, for one that is not open. */
  private settle(callId: string, outcome: ClientToolCallOutcome, result: CallToolResult): ClientToolCallSettledEvent | undefined {
    const entry = this.open.get(callId);
    if (entry === undefined) {
      return undefined;
    }
    this.open.delete(callId);
    entry.cleanupAbortListener();
    recordBounded(this.settled, callId, outcome);
    entry.finish(result);
    const settled: ClientToolCallSettledEvent = { type: 'client_tool_call_settled', callId, outcome };
    this.emit(settled);
    return settled;
  }
}

/**
 * The port one session's client tools go through. `options.now` is a test seam; the default is
 * `performance.now`.
 */
export function createClientToolPort(clientTools: ClientTools, emit: (event: ClaudeRuntimeEvent) => void, options?: { now?: () => number }): ClientToolPort {
  return new ClientToolBroker(clientTools, emit, options?.now);
}
