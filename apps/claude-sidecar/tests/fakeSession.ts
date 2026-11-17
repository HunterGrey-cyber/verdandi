import { createClientToolPort, createInteractionPort, TaskNotFoundError, type AccountIdentity, type AppliedSettings, type ModelOption, type OutputRange, type ClaudeRuntimeEvent, type ClientToolPort, type ClientTools, type InteractionPort, type PermissionAnswer, type SendTurnOptions, type SessionCloseReason, type SteerTurnOptions, type TaskOutputResult } from '@verdandi/claude-runtime';
import type { MinimalKernelSession } from '../src/sessionRegistry.js';

/** One JSON-RPC response of the in-process MCP server, as the CLI would read it. */
export type McpResponse = { id?: number; result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: { code: number; message: string } };

/** A transport the CLI's end of the in-process MCP server is played through. */
export function fakeMcpTransport(responses: McpResponse[]) {
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    async start(): Promise<void> {},
    async send(message: McpResponse): Promise<void> {
      responses.push(message);
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
    /** Sends one frame and lets the server's handler run. */
    async deliver(method: string, params: unknown, id?: number): Promise<void> {
      transport.onmessage!({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return transport;
}

/** The `tools/call` parameters the CLI sends, with the model's id where the CLI puts it. */
export function toolsCallParams(tool: string, args: Record<string, unknown>, toolUseId?: string): Record<string, unknown> {
  return { name: tool, arguments: args, ...(toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId } }) };
}

export type FakeSessionController = {
  /** Makes the fake's pump() return this event on the next call (queued, drained in order). */
  emit(event: ClaudeRuntimeEvent): void;
  /** Every text passed to sendTurn(), in call order. */
  readonly sentTurns: string[];
  /** The options passed with each of those texts, in the same order (`undefined` when none were). */
  readonly sentTurnOptions: Array<SendTurnOptions | undefined>;
  /** Every steerTurn() call the fake accepted, in call order. */
  readonly steeredTurns: Array<{ expectedTurnId: string; clientMessageId: string; text: string }>;
  /** The options passed with each of those calls, in the same order (`undefined` when none were). */
  readonly steeredTurnOptions: Array<SteerTurnOptions | undefined>;
  /** Makes the NEXT steerTurn() throw this error (e.g. the kernel's SteerError). */
  makeNextSteerTurnThrow(err: unknown): void;
  /** Every (permissionId, decision) pair passed to resolvePermission(), in call order. */
  readonly resolvePermissionCalls: Array<{ permissionId: string; decision: PermissionAnswer }>;
  readonly interruptCalls: number;
  readonly closeCalls: number;
  /** Every mode passed to setPermissionMode(), in call order. */
  readonly setPermissionModeCalls: string[];
  /** Makes the NEXT setPermissionMode() reject with this error (e.g. the kernel's PermissionModeError). */
  makeNextSetPermissionModeReject(err: unknown): void;
  /** Makes the NEXT setPermissionMode() wait until the returned function is called. */
  holdNextSetPermissionMode(): () => void;
  /** Makes the NEXT call to sendTurn() throw an Error with this message instead of succeeding, then
   * reverts to normal behavior for any call after that -- mirrors the real kernel's own plain-Error
   * throw for "a turn is already in progress on this session" for exactly one call, so a test can
   * exercise a caller's error-wrapping logic around sendTurn() without this fake needing to implement
   * full turn-in-progress tracking of its own. */
  makeNextSendTurnThrow(message: string): void;
  /** Makes the NEXT call to interrupt() reject with an Error carrying this message instead of
   * succeeding, then reverts to normal behavior after that -- unlike makeNextSendTurnThrow, this has
   * no real-kernel throw condition to mirror (the kernel's own interrupt() doesn't throw plain Errors
   * for any documented condition); it exists purely so a test can exercise a handler's generic
   * catch-all error-wrapping path (final whole-branch review, Finding 6: a non-SidecarError throw
   * must still reach the client as a real SidecarError/ErrorCode, never an unmapped UNKNOWN) against
   * some concrete throw, without inventing a fake failure mode the real kernel doesn't have. */
  makeNextInterruptThrow(message: string): void;
  /** How many times accountIdentity() was called: zero proves a CreateSession did not wait on it. */
  readonly accountIdentityCalls: number;
  /** Settles the promise accountIdentity() returns. Until then it is pending, like a probe the CLI has
   * not answered yet. */
  settleAccountIdentity(identity: AccountIdentity | undefined): void;
  /** Ends the session the way the kernel does when its provider goes away: closeReason() reports
   * `reason` from now on and pump() delivers the session_closed. */
  endSession(reason: SessionCloseReason): void;
  /** Makes the NEXT accountIdentity() call return a rejected promise (the kernel's never rejects). */
  makeNextAccountIdentityReject(err: unknown): void;
  /** Makes the NEXT pump() reject with this error, as a pump that met an SDK message it could not
   * translate would. */
  makeNextPumpThrow(err: unknown): void;
  /** The session's interaction port: the kernel's own, for a fake made with `questions: true`, whose
   * events come out of this fake's pump(); `undefined` otherwise. A test asks it questions with
   * `route('AskUserQuestion', input, options)`, as the kernel's `canUseTool` does. */
  readonly interactions: InteractionPort | undefined;
  /** The session's client tool port: the kernel's own, for a fake made with `clientTools`, whose events
   * come out of this fake's pump(); `undefined` otherwise. */
  readonly clientTools: ClientToolPort | undefined;
  /** Plays the CLI calling one declared tool, through a fake transport connected to the port's MCP
   * server as the Agent SDK connects one. Resolves once the server's handler has run; the call's
   * result, when there is one, lands in `mcpResponses`. */
  callClientTool(tool: string, args: Record<string, unknown>, call: { id: number; toolUseId?: string }): Promise<void>;
  /** Plays the CLI giving up on the request with this JSON-RPC id (`notifications/cancelled`). */
  cancelClientTool(id: number): Promise<void>;
  /** What the CLI got back from the MCP server, in order. */
  readonly mcpResponses: McpResponse[];
  /** Every task id passed to stopTask(), in call order, refused ones included. */
  readonly stopTaskCalls: string[];
  /** Replaces what stopTask() answers (by default it resolves), e.g. with the kernel's
   * TaskNotFoundError or a promise the test settles later. */
  answerStopTask(answer: (taskId: string) => Promise<void>): void;
  /** Every task id passed to taskOutput(), in call order. */
  readonly taskOutputCalls: string[];
  /** The range passed with each taskOutput() call, `undefined` for a tail. */
  readonly taskOutputRanges: Array<OutputRange | undefined>;
  /** Replaces what taskOutput() answers (by default the kernel's TaskNotFoundError). */
  answerTaskOutput(answer: (taskId: string, range?: OutputRange) => Promise<TaskOutputResult>): void;
  /** Every id passed to setModel(), in call order, refused ones included. */
  readonly setModelCalls: string[];
  answerSetModel(answer: (model: string) => Promise<AppliedSettings>): void;
  /** Every level passed to applyEffort(), in call order, refused ones included. */
  readonly applyEffortCalls: string[];
  answerApplyEffort(answer: (effort: string) => Promise<AppliedSettings>): void;
  answerListModels(answer: () => Promise<{ models: ModelOption[]; applied: AppliedSettings }>): void;
};

/**
 * Builds a fake MinimalKernelSession plus the controller a test uses to drive it. Unlike the kernel's
 * own fakeQuery.ts (which models a real async generator's queueing semantics because MinimalQuery is
 * one), pump() here is deliberately simple: it drains and returns whatever's been queued via emit()
 * since the last call, synchronously available, no waiting-for-more-input behavior — PumpDriver
 * (Task 5) is the one polling in a loop, so the fake doesn't need to simulate blocking.
 */
export function makeFakeSession(options: { questions?: boolean; clientTools?: ClientTools; clientToolClock?: () => number } = {}): { session: MinimalKernelSession; controller: FakeSessionController } {
  const pending: ClaudeRuntimeEvent[] = [];
  const interactions =
    options.questions === true
      ? createInteractionPort(
          {
            policy: { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli', providerPermissionPrompts: true },
            clientInteractions: { questions: true },
          },
          (event) => pending.push(event),
        )
      : undefined;
  const clientTools =
    options.clientTools === undefined
      ? undefined
      : createClientToolPort(options.clientTools, (event) => pending.push(event), options.clientToolClock === undefined ? undefined : { now: options.clientToolClock });
  const mcpResponses: McpResponse[] = [];
  const mcpTransport = fakeMcpTransport(mcpResponses);
  let mcpConnected: Promise<void> | undefined;
  const connectedTransport = async () => {
    if (clientTools === undefined) {
      throw new Error('this fake was made without clientTools');
    }
    mcpConnected ??= (clientTools.sdkServer().instance as unknown as { connect(transport: unknown): Promise<void> }).connect(mcpTransport);
    await mcpConnected;
    return mcpTransport;
  };
  const sentTurns: string[] = [];
  const sentTurnOptions: FakeSessionController['sentTurnOptions'] = [];
  const steeredTurns: FakeSessionController['steeredTurns'] = [];
  const steeredTurnOptions: FakeSessionController['steeredTurnOptions'] = [];
  let nextSteerTurnError: { err: unknown } | undefined;
  const resolvePermissionCalls: FakeSessionController['resolvePermissionCalls'] = [];
  let interruptCalls = 0;
  let closeCalls = 0;
  let nextSendTurnError: string | undefined;
  let nextInterruptError: string | undefined;
  const setPermissionModeCalls: string[] = [];
  let nextSetPermissionModeError: { err: unknown } | undefined;
  let nextSetPermissionModeHold: Promise<void> | undefined;
  let accountIdentityCalls = 0;
  let closeReason: SessionCloseReason | undefined;
  let nextAccountIdentityError: { err: unknown } | undefined;
  let nextPumpError: { err: unknown } | undefined;
  let settleIdentity!: (identity: AccountIdentity | undefined) => void;
  const identity = new Promise<AccountIdentity | undefined>((resolve) => (settleIdentity = resolve));
  const stopTaskCalls: string[] = [];
  let stopTaskAnswer = (_taskId: string): Promise<void> => Promise.resolve();
  const taskOutputCalls: string[] = [];
  const taskOutputRanges: Array<OutputRange | undefined> = [];
  let taskOutputAnswer = (taskId: string, _range?: OutputRange): Promise<TaskOutputResult> => Promise.reject(new TaskNotFoundError(taskId));
  const setModelCalls: string[] = [];
  let setModelAnswer = (model: string): Promise<AppliedSettings> => Promise.resolve({ model, effort: 'medium' });
  const applyEffortCalls: string[] = [];
  let applyEffortAnswer = (effort: string): Promise<AppliedSettings> => Promise.resolve({ model: 'm', effort });
  let listModelsAnswer = (): Promise<{ models: ModelOption[]; applied: AppliedSettings }> => Promise.resolve({ models: [], applied: { model: '', effort: '' } });

  const session: MinimalKernelSession = {
    async pump() {
      if (nextPumpError !== undefined) {
        const { err } = nextPumpError;
        nextPumpError = undefined;
        throw err;
      }
      return pending.splice(0);
    },
    sendTurn(text: string, options?: SendTurnOptions) {
      if (nextSendTurnError !== undefined) {
        const message = nextSendTurnError;
        nextSendTurnError = undefined;
        throw new Error(message);
      }
      sentTurns.push(text);
      sentTurnOptions.push(options);
      return { turnId: `fake-turn-${sentTurns.length}` };
    },
    steerTurn(expectedTurnId: string, clientMessageId: string, text: string, options?: SteerTurnOptions) {
      if (nextSteerTurnError !== undefined) {
        const { err } = nextSteerTurnError;
        nextSteerTurnError = undefined;
        throw err;
      }
      steeredTurns.push({ expectedTurnId, clientMessageId, text });
      steeredTurnOptions.push(options);
      return { turnId: expectedTurnId };
    },
    async interrupt() {
      if (nextInterruptError !== undefined) {
        const message = nextInterruptError;
        nextInterruptError = undefined;
        throw new Error(message);
      }
      interruptCalls += 1;
    },
    close() {
      closeCalls += 1;
      closeReason ??= 'closed_by_host';
      // Mirrors the real kernel's own close(), which provably drives a `session_closed` event
      // through a subsequent pump() call -- without this, PumpDriver's interval for any session this
      // fake backs would never observe a terminal event and would never self-stop (final whole-branch
      // review, "make the fake session's close() emit session_closed").
      pending.push({ type: 'session_closed', reason: 'closed_by_host' });
    },
    resolvePermission(permissionId: string, decision: PermissionAnswer) {
      resolvePermissionCalls.push({ permissionId, decision });
      return true;
    },
    async setPermissionMode(mode) {
      setPermissionModeCalls.push(mode);
      if (nextSetPermissionModeHold !== undefined) {
        const hold = nextSetPermissionModeHold;
        nextSetPermissionModeHold = undefined;
        await hold;
      }
      if (nextSetPermissionModeError !== undefined) {
        const { err } = nextSetPermissionModeError;
        nextSetPermissionModeError = undefined;
        throw err;
      }
      const permissionMode = mode === 'bypass' ? 'bypassPermissions' : 'default';
      // As the real kernel: the change is announced through pump() for every watcher.
      pending.push({ type: 'permission_mode_changed', permissions: mode, permissionMode, bypassDefaultDenyApplied: false });
      return { permissionMode, bypassDefaultDenyApplied: false };
    },
    accountIdentity() {
      accountIdentityCalls += 1;
      if (nextAccountIdentityError !== undefined) {
        const { err } = nextAccountIdentityError;
        nextAccountIdentityError = undefined;
        return Promise.reject(err);
      }
      return identity;
    },
    closeReason() {
      return closeReason;
    },
    stopTask(taskId: string) {
      stopTaskCalls.push(taskId);
      return stopTaskAnswer(taskId);
    },
    setModel(model: string) {
      setModelCalls.push(model);
      return setModelAnswer(model);
    },
    listModels() {
      return listModelsAnswer();
    },
    applyEffort(effort: string) {
      applyEffortCalls.push(effort);
      return applyEffortAnswer(effort);
    },
    taskOutput(taskId: string, range?: OutputRange) {
      taskOutputCalls.push(taskId);
      taskOutputRanges.push(range);
      return taskOutputAnswer(taskId, range);
    },
    interactions() {
      return interactions;
    },
    clientTools() {
      return clientTools;
    },
  };

  return {
    session,
    controller: {
      emit: (event) => pending.push(event),
      sentTurns,
      sentTurnOptions,
      steeredTurns,
      steeredTurnOptions,
      makeNextSteerTurnThrow: (err: unknown) => {
        nextSteerTurnError = { err };
      },
      resolvePermissionCalls,
      get interruptCalls() {
        return interruptCalls;
      },
      get closeCalls() {
        return closeCalls;
      },
      makeNextSendTurnThrow: (message: string) => {
        nextSendTurnError = message;
      },
      makeNextInterruptThrow: (message: string) => {
        nextInterruptError = message;
      },
      setPermissionModeCalls,
      makeNextSetPermissionModeReject: (err: unknown) => {
        nextSetPermissionModeError = { err };
      },
      get accountIdentityCalls() {
        return accountIdentityCalls;
      },
      settleAccountIdentity: (value) => settleIdentity(value),
      endSession: (reason) => {
        closeReason ??= reason;
        pending.push({ type: 'session_closed', reason });
      },
      makeNextAccountIdentityReject: (err) => {
        nextAccountIdentityError = { err };
      },
      makeNextPumpThrow: (err) => {
        nextPumpError = { err };
      },
      interactions,
      clientTools,
      callClientTool: async (tool, args, call) => {
        await (await connectedTransport()).deliver('tools/call', toolsCallParams(tool, args, call.toolUseId), call.id);
      },
      cancelClientTool: async (id) => {
        await (await connectedTransport()).deliver('notifications/cancelled', { requestId: id });
      },
      mcpResponses,
      stopTaskCalls,
      answerStopTask: (answer) => {
        stopTaskAnswer = answer;
      },
      taskOutputCalls,
      taskOutputRanges,
      setModelCalls,
      answerSetModel: (answer) => {
        setModelAnswer = answer;
      },
      applyEffortCalls,
      answerApplyEffort: (answer) => {
        applyEffortAnswer = answer;
      },
      answerListModels: (answer) => {
        listModelsAnswer = answer;
      },
      answerTaskOutput: (answer) => {
        taskOutputAnswer = answer;
      },
      holdNextSetPermissionMode: () => {
        let release!: () => void;
        nextSetPermissionModeHold = new Promise<void>((r) => (release = r));
        return release;
      },
    },
  };
}
