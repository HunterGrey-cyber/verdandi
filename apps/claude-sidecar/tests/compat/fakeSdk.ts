import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '@verdandi/claude-runtime';

/**
 * A scripted stand-in for the Claude Agent SDK, for the old-client conformance suite.
 *
 * Nothing billed runs: the REAL kernel (`createSession` in @verdandi/claude-runtime) and the REAL
 * sidecar sit on top of it, and only the SDK's `query()` -- the thing that would spawn `claude` -- is
 * replaced by this. It is deliberately a different thing from packages/claude-runtime/tests/fakeQuery.ts:
 * that fake answers a kernel unit test's pushes; this one is driven turn by turn by a test that plays
 * the CLI, and it records what the SDK was told (`options`), which is half of what Eitri depends on.
 *
 * It reports what the real CLI reports: `system/init` carries the permission mode the SDK was
 * started in, verbatim (SessionReady.permission_mode's own documentation: "what the provider is
 * ACTUALLY running under"), so a sidecar that started an INTERACTIVE session in any mode but `default`
 * is seen here exactly as Eitri would see it.
 */

type SdkQuery = ReturnType<QueryFn>;
type Waiter = { resolve: (value: IteratorResult<SDKMessage, void>) => void; reject: (error: unknown) => void };

export type HookOutput = {
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
};
type HookCallback = (input: unknown, toolUseId: string | undefined, context: { signal: AbortSignal }) => Promise<HookOutput>;

export type Ask<T> = { result: Promise<T>; abort(): void };

export type ProviderPromptExtras = {
  decisionReason?: string;
  description?: string;
  blockedPath?: string;
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
};

/** One `query()` call: one session's Claude process, from the SDK's side. */
export class FakeProvider {
  /** What the sidecar told the SDK. Captured at construction, before any turn. */
  readonly options: Options;
  readonly userMessages: string[] = [];
  interruptCalls = 0;
  closed = false;

  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private ended = false;
  private failure: { error: unknown } | undefined;
  private messageArrived: Array<(text: string) => void> = [];
  private interruptWaiters: Array<() => void> = [];
  private consumed = 0;

  constructor(
    options: Options,
    prompt: AsyncIterable<unknown>,
    private readonly identity: { providerSessionId: string; model: string; tools: string[]; accountInfo?: () => Promise<Record<string, unknown>> },
  ) {
    this.options = options;
    // The SDK reads the host's user messages from `prompt`; so does this.
    void (async () => {
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const content = message.message.content;
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        this.userMessages.push(text);
        this.messageArrived.shift()?.(text);
      }
    })();
  }

  /** Resolves with the text of the next user message the kernel sends this provider. */
  nextUserMessage(): Promise<string> {
    const already = this.userMessages[this.consumed];
    if (already !== undefined) {
      this.consumed += 1;
      return Promise.resolve(already);
    }
    return new Promise((resolve) => {
      this.messageArrived.push((text) => {
        this.consumed += 1;
        resolve(text);
      });
    });
  }

  /** Resolves the next time the host interrupts this provider (Query.interrupt()). */
  interrupted(): Promise<void> {
    return new Promise((resolve) => this.interruptWaiters.push(resolve));
  }

  // ---- What the CLI emits --------------------------------------------------------------------

  emit(message: Record<string, unknown>): void {
    const sdkMessage = { session_id: this.identity.providerSessionId, uuid: `uuid-${this.queue.length}`, ...message } as unknown as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: sdkMessage, done: false });
    } else {
      this.queue.push(sdkMessage);
    }
  }

  /** `system/init`, as the CLI sends it at the start of every turn. */
  init(overrides: Record<string, unknown> = {}): void {
    this.emit({
      type: 'system',
      subtype: 'init',
      // A resumed session reports the id it attached to.
      session_id: this.options.resume ?? this.identity.providerSessionId,
      model: this.identity.model,
      cwd: this.options.cwd ?? '',
      permissionMode: this.options.permissionMode,
      tools: this.identity.tools,
      mcp_servers: [],
      apiKeySource: 'none',
      ...overrides,
    });
  }

  streamStart(messageId: string): void {
    this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId } } });
  }

  streamText(text: string): void {
    this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  }

  /** A chunk of the model's reasoning, as the CLI streams it (`thinking_delta`). */
  streamThinking(thinking: string): void {
    this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } });
  }

  /** A `system` message that is not `init` (a status line, a compaction note ...): the sidecar relays it as a ProviderNotice. */
  systemNotice(subtype: string, detail: Record<string, unknown> = {}): void {
    this.emit({ type: 'system', subtype, ...detail });
  }

  /** The complete assistant message; under partial streaming it carries the tool_use blocks. */
  assistant(messageId: string, content: Array<Record<string, unknown>>): void {
    this.emit({ type: 'assistant', parent_tool_use_id: null, message: { id: messageId, role: 'assistant', content } });
  }

  toolResult(toolUseId: string, content: unknown, isError = false): void {
    this.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    });
  }

  /** The turn's `result` message. `modelUsage` is cumulative for the session, as the SDK reports it. */
  result(detail: { subtype?: string; terminalReason?: string; text?: string; isError?: boolean; modelUsage?: Record<string, unknown>; structuredOutput?: unknown; extra?: Record<string, unknown> } = {}): void {
    this.emit({
      type: 'result',
      subtype: detail.subtype ?? 'success',
      is_error: detail.isError ?? false,
      result: detail.text ?? '',
      stop_reason: 'end_turn',
      terminal_reason: detail.terminalReason ?? 'completed',
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      ...(detail.modelUsage !== undefined ? { modelUsage: detail.modelUsage } : {}),
      ...(detail.structuredOutput !== undefined ? { structured_output: detail.structuredOutput } : {}),
      // Whatever else the CLI's result carries (`errors`, `api_error_status`, ...), last so it can override a default above.
      ...(detail.extra ?? {}),
    });
  }

  /** The stream ends: the CLI process exited on its own. */
  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** The provider dies: the SDK's next read rejects. */
  fail(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
    } else {
      this.failure = { error };
    }
  }

  // ---- What the CLI asks the host ---------------------------------------------------------------

  /** The PreToolUse hook the sidecar installed: the CLI calls it before every tool call. */
  ask(toolName: string, input: unknown, toolUseId: string): Ask<HookOutput> {
    const matchers = this.options.hooks?.PreToolUse as Array<{ matcher?: string; hooks: HookCallback[] }> | undefined;
    const hook = matchers?.[0]?.hooks[0];
    if (hook === undefined) {
      throw new Error('the sidecar installed no PreToolUse hook on this session');
    }
    const controller = new AbortController();
    const result = hook(
      { hook_event_name: 'PreToolUse', session_id: this.identity.providerSessionId, cwd: this.options.cwd, tool_name: toolName, tool_input: input, tool_use_id: toolUseId },
      toolUseId,
      { signal: controller.signal },
    );
    return { result, abort: () => controller.abort() };
  }

  /** The CLI's own permission prompt (Agent SDK `canUseTool`), raised after the hook allowed a call. */
  prompt(toolName: string, input: Record<string, unknown>, toolUseId: string, extras: ProviderPromptExtras = {}): Ask<PermissionResult | null> {
    const canUseTool = this.options.canUseTool as CanUseTool | undefined;
    if (canUseTool === undefined) {
      throw new Error('the sidecar installed no canUseTool callback on this session');
    }
    const controller = new AbortController();
    const result = canUseTool(toolName, input, {
      signal: controller.signal,
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseID: toolUseId,
      requestId: `req-${toolUseId}`,
      ...extras,
    } as Parameters<CanUseTool>[2]);
    return { result, abort: () => controller.abort() };
  }

  // ---- What the SDK's Query object offers the kernel ---------------------------------------------

  readonly query: SdkQuery = (() => {
    const self = this;
    const query = {
      async next(): Promise<IteratorResult<SDKMessage, void>> {
        if (self.failure !== undefined) {
          const { error } = self.failure;
          self.failure = undefined;
          throw error;
        }
        const queued = self.queue.shift();
        if (queued !== undefined) {
          return { value: queued, done: false };
        }
        if (self.ended) {
          return { value: undefined, done: true };
        }
        return new Promise((resolve, reject) => self.waiters.push({ resolve, reject }));
      },
      async return(): Promise<IteratorResult<SDKMessage, void>> {
        self.end();
        return { value: undefined, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
        self.end();
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt(): Promise<unknown> {
        self.interruptCalls += 1;
        for (const resolve of self.interruptWaiters.splice(0)) {
          resolve();
        }
        return undefined;
      },
      close(): void {
        self.closed = true;
        self.end();
      },
      async accountInfo() {
        // A test that needs the answer late (or never) supplies its own; otherwise it is immediate.
        return self.identity.accountInfo !== undefined
          ? self.identity.accountInfo()
          : { email: 'fake-account@example.invalid', organization: 'Fake Organization', subscriptionType: 'pro', tokenSource: 'fake' };
      },
      async setPermissionMode(): Promise<void> {},
    };
    return query as unknown as SdkQuery;
  })();
}

export type FakeSdkOptions = {
  /** The Claude session id a fresh session reports (a resumed one reports the id it resumed). */
  providerSessionId?: string;
  model?: string;
  /** What system/init lists; the default is a plausible subset without the three prompt tools, with one MCP-named tool (`mcp__<server>__<tool>`), as a project's own MCP servers show up. */
  tools?: string[];
  /** A resumed session is refused, the way the CLI refuses an id it has no transcript for. */
  rejectResume?: boolean;
  /** What `Query.accountInfo()` answers, called once per session when the sidecar asks. Absent: an
   * immediate answer carrying `fake-account@example.invalid`. A test that holds the returned promise
   * open plays a CLI that answers late. */
  accountInfo?: () => Promise<Record<string, unknown>>;
};

/** The SDK, as the sidecar's session factory sees it. */
export class FakeSdk {
  readonly providers: FakeProvider[] = [];
  readonly queryFn: QueryFn;

  constructor(private readonly config: FakeSdkOptions = {}) {
    this.queryFn = (params) => {
      const provider = new FakeProvider(params.options ?? {}, params.prompt as AsyncIterable<unknown>, {
        providerSessionId: this.config.providerSessionId ?? `claude-session-${this.providers.length + 1}`,
        model: this.config.model ?? 'claude-fake-model',
        tools: this.config.tools ?? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'mcp__x__y'],
        ...(this.config.accountInfo !== undefined ? { accountInfo: this.config.accountInfo } : {}),
      });
      this.providers.push(provider);
      if (params.options?.resume !== undefined && this.config.rejectResume === true) {
        // The CLI says so within ~2 s of starting, before any turn: the SDK's first read rejects with
        // the CLI's own error result.
        provider.fail(new Error(`Claude Code returned an error result: No conversation found with session ID: ${params.options.resume}`));
      }
      return provider.query;
    };
  }

  /** The provider of the most recent session. */
  get last(): FakeProvider {
    const provider = this.providers[this.providers.length - 1];
    if (provider === undefined) {
      throw new Error('no session has been created yet');
    }
    return provider;
  }
}
