import type { AccountInfo, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The subset of the real SDK's `Query` interface (sdk.d.ts:2522) this package's code actually
 * calls. Kept narrow deliberately: widen it only when a later task's code needs a method this
 * type doesn't yet have, at which point also widen `tests/fakeQuery.ts`'s fake to match.
 */
export type MinimalQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Widened for the account-identity gate (muninn spec §6.3 P2): a session asks once, before its
   * first turn reaches the provider, which account the CLI authenticated as. The real `Query` has
   * had it all along (sdk.d.ts `accountInfo(): Promise<AccountInfo>`). */
  accountInfo(): Promise<AccountInfo>;
  /** Widened for SetPermissionMode (2026-09-26): the real `Query` has it (sdk.d.ts
   * `setPermissionMode(mode: PermissionMode): Promise<void>`, a `set_permission_mode` control
   * request; streaming input only, which is the only mode this package uses). Rejects with the CLI's
   * own reason when the CLI refuses the mode. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
};
