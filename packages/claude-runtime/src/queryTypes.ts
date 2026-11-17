import type { AccountInfo, EffortLevel, ModelInfo, PermissionMode, SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

/**
 * The subset of the real SDK's `Query` interface (sdk.d.ts:2522) this package's code actually
 * calls. Kept narrow deliberately: widen it only when a later task's code needs a method this
 * type doesn't yet have, at which point also widen `tests/fakeQuery.ts`'s fake to match.
 */
export type MinimalQuery = AsyncGenerator<SDKMessage, void> & {
  /** On a CLI that advertises `interrupt_receipt_v1` the real `Query` resolves with the receipt
   * (`{ still_queued: string[] }`: the uuids of queued user messages that will still run); older ones
   * resolve `undefined`. Typed `unknown`; the session does not read it (a steered message the CLI
   * still holds is already pending there). */
  interrupt(): Promise<unknown>;
  close(): void;
  /** Widened for the account-identity gate (consumer spec §6.3 P2): a session asks once, before its
   * first turn reaches the provider, which account the CLI authenticated as. The real `Query` has
   * had it all along (sdk.d.ts `accountInfo(): Promise<AccountInfo>`). */
  accountInfo(): Promise<AccountInfo>;
  /** Widened for SetPermissionMode (2026-09-26): the real `Query` has it (sdk.d.ts
   * `setPermissionMode(mode: PermissionMode): Promise<void>`, a `set_permission_mode` control
   * request; streaming input only, which is the only mode this package uses). Rejects with the CLI's
   * own reason when the CLI refuses the mode. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Widened for the `commands_updated` event (2026-10-13): the session's slash commands, from the
   * CLI's answer to the SDK's initialize request, replaced by the latest `system/commands_changed`
   * push when one came (sdk.d.ts `supportedCommands(): Promise<SlashCommand[]>`). Waits for
   * initialize, which needs no turn. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Widened for StopTask: the real `Query` has it (sdk.d.ts `stopTask(taskId: string):
   * Promise<void>`, a `stop_task` control request). The CLI then reports the task's end itself, as a
   * `task_notification` with status `stopped`. A workflow's id stops the whole run. */
  stopTask(taskId: string): Promise<void>;
  /** Widened for SetModel: a `set_model` control request. Rejects with the CLI's own words for an id
   * it does not know; an id it does not list costs it one small API request to check. */
  setModel(model?: string): Promise<void>;
  /** Widened for ListModels: from the CLI's answer to initialize, which needs no turn. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Widened for ApplyEffort: only the one key this package sets. The CLI accepts any word. */
  applyFlagSettings(settings: { effortLevel: EffortLevel | null }): Promise<void>;
  /** What the CLI says it will use. The real `Query` has it, though its type does not list it (a
   * `get_settings` control request, which the SDK's control types do list), so it may go away:
   * callers check for it. `applied.effort` is `null` for a model that takes no level. */
  getSettings?(): Promise<{ applied?: { model?: string | null; effort?: string | null } }>;
};
