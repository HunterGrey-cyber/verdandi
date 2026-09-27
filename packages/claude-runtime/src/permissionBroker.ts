import { randomUUID } from 'node:crypto';
import type { HookCallback, HookCallbackMatcher, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRuntimeEvent, PermissionOutcome } from './types.js';

type PendingPermission = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (decision: { allow: boolean; reason?: string }) => void;
  /** Removes this request's `AbortSignal` 'abort' listener. Called whenever this entry is
   * resolved through any path OTHER than that same signal aborting (`resolve()`,
   * `failAllPending()`) -- without this, a listener left attached after its promise has already
   * settled would still be sitting on the signal for no reason, and (more importantly) an abort
   * firing afterward would find its own `pending.delete()` a no-op (the entry is already gone) so
   * it wouldn't misfire a stray `expired` event, but there is no reason to leave the listener
   * attached once it can never do anything useful. */
  cleanupAbortListener: () => void;
};

/**
 * Owns every currently-unanswered permission request for one session. `emit` is how this class
 * hands `PermissionRequested`/`PermissionResolved` events back to the session actor that owns it
 * (Task 3's `ClaudeRuntimeSession`) without this class needing to know that class's internals --
 * matches the same "push events out, don't reach into the caller's state" shape `translateMessage`
 * (Task 2) already uses.
 *
 * ## The delivery mechanism is a downstream contract, not an implementation detail
 *
 * This broker installs its `PreToolUse` hook as an **in-process SDK callback**
 * (`Options.hooks.PreToolUse = [buildHookMatcher()]`). It must never be "simplified" into a CLI
 * argument -- not `--settings '<hook JSON>'`, not `--settings <file>`, not a written
 * `.claude/settings.local.json`. Neovibe depends on this property, and it is why it is switching
 * its Agent pane to the sidecar (packaging handoff, 2026-09-18).
 *
 * Its measurements, so nobody has to re-derive them:
 *
 * - `--settings` is **last-wins**, measured with two `--settings` flags each installing a
 *   `PreToolUse` hook touching a different marker file: the second fired, the first did not. A host
 *   whose `claude` on PATH is a wrapper that already owns `--settings` (a multi-account launcher,
 *   say) therefore cannot be handed a gate through argv at all -- either the wrapper's payload or
 *   the caller's is silently deleted, and the wrapper here correctly refuses to exec instead.
 * - The policy tier is **not** an escape hatch. On CLI 2.1.272, `--managed-settings <inline JSON>`,
 *   `--managed-settings <file>` and `CLAUDE_CODE_MANAGED_SETTINGS_PATH` were each accepted -- exit
 *   0, session runs, tools execute -- and each ran **no** `PreToolUse` hook. Delivering a gate that
 *   way produces a permission gate that is silently absent. Do not propose it again.
 * - `<project>/.claude/settings.local.json` was already removed for a different reason: the CLI
 *   re-reads it per tool invocation, so one conversation's shutdown removed the gate from another
 *   conversation running in the same directory.
 *
 * An in-process callback has none of these failure modes: it collides with nothing on argv, it is
 * not a file another process can rewrite, and it cannot be accepted-but-ignored. That is the
 * property, and it is load-bearing for a consumer outside this repository.
 *
 * ### What a lost hook actually does, which depends on the mode
 *
 * The reason delivery has to be this reliable is that in a non-interactive session there is no human
 * at the CLI to prompt, so this hook is the only thing that can turn a tool call into a question.
 * What happens WITHOUT it is not one behaviour, and the difference decides what a person debugging
 * it will be looking for. Both measured downstream on CLI 2.1.272, 2026-09-19, `--print`, no hook:
 *
 * - `--permission-mode auto`: `Bash`, `Read` and `Write` all ran, no prompt, the file was really
 *   created. No hook means **no gate**, and the session looks entirely healthy.
 * - **No `--permission-mode` flag at all**, and no settings tier naming a mode, which the CLI
 *   resolves to `default` -- the mode this package passes explicitly for `interactive` and
 *   `verdandi_rules` (see `policyToBaseOptions` for why it must be explicit) -- reports
 *   `permissionMode: 'default'` at init, and the gate keeps CLASSIFYING rather than shutting. The
 *   decisive measurement is an A/B inside one session, same tool, only the path differing:
 *
 *   ```
 *   Read  <workdir>/inside.txt      -> succeeded
 *   Read  /tmp/<other>/outside.txt  -> DENIED  "you haven't granted it yet"
 *   Write <workdir>/written.txt     -> DENIED  "you haven't granted it yet"   (file not created)
 *   ```
 *
 *   So the classification is **per invocation, on the input** -- not per tool name, and not "deny
 *   everything that is not a read". One `Read` allowed and another denied in the same run is the
 *   strongest available refutation of "the door is unmanned": an unmanned door cannot tell two
 *   `Read`s apart. The working directory is the boundary it is deciding on.
 *
 * That "yet" is the tell, and it is the part worth understanding rather than memorising. The door is
 * not unmanned -- what a headless session lacks is the INTERACTIVE PATH TO A GRANT. The grant itself
 * can still come from a `permissions.allow` rule or from a `PreToolUse` hook returning `allow`; with
 * neither present, anything not pre-granted is refused. **That is precisely why this broker works at
 * all:** its `allow` is the grant the interactive prompt would otherwise have been. If a headless
 * session really had nothing that could open the door, no host could gate anything headlessly and
 * this design would be impossible.
 *
 * So for the modes this package actually uses, a missing hook does not remove the door -- it removes
 * the only thing that could open it. Reads keep working, writes keep failing, and the turn completes
 * looking successful while the agent quietly cannot edit anything. That is the safe direction, and
 * it is still a bug worth the delivery constraint; the reason to write it down is that the symptom
 * points the wrong way. Someone meeting it will hunt for a permissions bug, not for a hook that
 * never installed.
 *
 * Boundaries, so nobody widens them: no hook, no settings rules, cwd a fresh temp directory, CLI
 * 2.1.272. Still UNMEASURED, and not to be assumed either way -- whether a grant is remembered
 * within a session, and anything at all about how `Bash` is classified.
 *
 * (An earlier version of this comment asserted the opposite, as a labelled inference from the `auto`
 * measurement. The inference was wrong. Both halves argue for the same constraint -- under `auto` a
 * lost hook is a silently removed gate, under the default a silently jammed one -- which is why the
 * correction changes the debugging advice rather than the rule.)
 *
 * The one place this package deliberately runs with no hook is `bypass`, which compensates with
 * `CONSERVATIVE_BYPASS_DENY` on `disallowedTools` (see session.ts, including why that array is
 * frozen).
 *
 * One technique falls out of the second measurement, for anyone who later writes rules about which
 * calls need a human: under `default` with no hook, the CLI is an oracle for its own classification
 * -- what it allows needs no human, what it denies does. A table copied out of documentation drifts
 * silently; a test against the binary does not.
 *
 * ## One turn can raise MORE THAN ONE permission request
 *
 * `pending` is a map, not a slot, and that is not defensive programming -- it is the shape of a
 * real turn. A consumer that answers one request and then waits for `turn_completed` will hang
 * behind the second, and what it observes is not a permission error: the turn stalls until its own
 * deadline, and the assistant text is empty because the model never got far enough to produce any.
 *
 * Measured downstream 2026-09-18, and it cost a day before an event dump named it. On CLI 2.1.272
 * tools are DEFERRED: the model cannot call `Bash` directly, it must `ToolSearch` for it first, and
 * that search is itself a tool call with its own `PreToolUse` gate. A test written when `Bash` was
 * in the initial tool set therefore answers the search's permission, never answers the shell's, and
 * times out looking like a streaming or translation failure.
 *
 * So: resolve every `permission_requested` you are handed, by its own `permissionId`, for as long as
 * the turn is in flight. Do not assume a count, and do not assume which tool the first one is for.
 */
/**
 * What the gate does with one call before anyone is asked. `ask` is the only answer there was before
 * permission modes could change mid-session, and it is what a broker built without a `gate` gives.
 * See session.ts's `gateDecision` for when the others are returned.
 */
export type GateDecision = { kind: 'ask' } | { kind: 'abstain' } | { kind: 'deny'; reason: string };

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();

  /**
   * @param gate consulted per call, BEFORE a request is raised. Absent means "always ask", which is
   * byte-for-byte the behaviour this class had before it existed. An abstention or a gate denial
   * raises no `permission_requested` / `permission_resolved`: nobody was asked, so an event saying
   * someone answered would be false.
   */
  constructor(
    private readonly emit: (event: ClaudeRuntimeEvent) => void,
    private readonly gate?: (toolName: string) => GateDecision,
  ) {}

  /**
   * Builds the real SDK's `HookCallbackMatcher` (sdk.d.ts:865) this broker installs as
   * `Options.hooks.PreToolUse: [thisMatcher]` -- design doc §7.1/Global Constraint: `matcher`
   * MUST be `"*"`, matching every tool call, never a narrower pattern.
   *
   * ### Why `"*"`, and why a complaint about it is not a reason to narrow it
   *
   * `"*"` means *the host is told about every call*. It does not mean every call needs a human. The
   * policy of what deserves a prompt belongs to the product that HAS the human -- it is the only
   * layer that knows the user, the mode they chose, and what is already on screen. A runtime that
   * narrows the matcher makes that decision for every consumer at once, permanently, and silently:
   * the calls it filters out are not "auto-approved", they are calls the host was never offered and
   * cannot audit. Narrowing fails in the direction where nobody finds out.
   *
   * This is written down because it was nearly filed as a bug on 2026-09-19. A downstream user's
   * complaint was that Auto mode raised a permission card for every tool, reads included, and the
   * trail led here. The defect was that the consumer treated "the host was asked" as "the user must
   * answer" and forwarded all of it to a GUI; it was fixed there, with one classifier in front of
   * its own `respond_permission`, and nothing changed on this side. A future reader arriving with
   * the same complaint should reach for that classifier, not for this matcher.
   *
   * `timeoutSeconds` is forwarded verbatim as the matcher's `timeout`, which the SDK puts in the
   * `initialize` control payload and the CLI honours per matcher. Omitted -- the production default
   * -- the CLI's own timeout applies, exactly as before. Supplying it is how the abort path below
   * becomes testable in seconds instead of in whatever the CLI default turns out to be.
   */
  buildHookMatcher(timeoutSeconds?: number): HookCallbackMatcher {
    const callback: HookCallback = async (input, toolUseId, { signal }) => {
      const preToolUse = input as PreToolUseHookInput;
      const gated = this.gate?.(preToolUse.tool_name) ?? { kind: 'ask' };
      if (gated.kind === 'abstain') {
        // No decision at all: the CLI's own permission mode decides, as if no hook were installed.
        return {};
      }
      if (gated.kind === 'deny') {
        const denied: SyncHookJSONOutput = {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: gated.reason },
        };
        return denied;
      }
      const permissionId = randomUUID();
      const decision = await new Promise<{ allow: boolean; reason?: string }>((resolve) => {
        if (signal.aborted) {
          // Already aborted before this callback even got to register a pending entry -- there
          // is nothing in `pending` to remove (it was never added), so resolve this specific
          // promise directly instead of going through the pending-map/emit machinery below.
          resolve({ allow: false, reason: 'permission request expired (hook call already aborted)' });
          return;
        }
        const onAbort = (): void => {
          // The CLI's own hook timeout (spec §7.2's ~600s figure) or any other abort of this
          // specific call gave up waiting on a decision. Global Constraint: fail closed -- and
          // specifically, remove the entry so a LATER, stale `resolvePermission()`/`resolve()`
          // call on this id can't write a false `permission_resolved: allowed/denied` for a
          // request the CLI already gave up on (this package's whole purpose is that audit
          // trail). Resolve this callback's own promise to deny too, so its returned
          // `SyncHookJSONOutput` settles instead of hanging forever alongside the CLI's own
          // already-abandoned wait.
          if (this.pending.delete(permissionId)) {
            this.emit({ type: 'permission_resolved', permissionId, outcome: 'expired' });
          }
          resolve({ allow: false, reason: 'permission request expired (hook call aborted)' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.pending.set(permissionId, {
          toolUseId: toolUseId ?? preToolUse.tool_use_id,
          toolName: preToolUse.tool_name,
          input: preToolUse.tool_input,
          resolve,
          cleanupAbortListener: () => signal.removeEventListener('abort', onAbort),
        });
        this.emit({
          type: 'permission_requested',
          permissionId,
          toolUseId: toolUseId ?? preToolUse.tool_use_id,
          toolName: preToolUse.tool_name,
          input: preToolUse.tool_input,
        });
      });
      const output: SyncHookJSONOutput = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          permissionDecisionReason: decision.reason,
        },
      };
      return output;
    };
    // `timeout` is omitted entirely rather than set to `undefined` when the caller did not ask for
    // one, so the payload the SDK sends is byte-identical to what it sent before this seam existed.
    return timeoutSeconds === undefined
      ? { matcher: '*', hooks: [callback] }
      : { matcher: '*', hooks: [callback], timeout: timeoutSeconds };
  }

  /** Called by the session actor's own public `resolvePermission` method. Returns `false` (no
   * state changed) if the id is unknown or already resolved -- callers must treat that as a
   * benign no-op, matching the neovibe Rust sibling's own identical
   * already-resolved-is-a-no-op precedent. */
  resolve(permissionId: string, decision: { allow: boolean; reason?: string }): boolean {
    const entry = this.pending.get(permissionId);
    if (!entry) {
      return false;
    }
    this.pending.delete(permissionId);
    // Removes the abort listener BEFORE resolving -- this request is being resolved through a
    // normal decision, not through its own abort, so the listener must not linger (and must not
    // ever fire spuriously afterward and try to double-resolve/emit a stray `expired` event for
    // a request that's already settled).
    entry.cleanupAbortListener();
    entry.resolve(decision);
    this.emit({ type: 'permission_resolved', permissionId, outcome: decision.allow ? 'allowed' : 'denied' });
    return true;
  }

  /** Global Constraint: fail closed. Denies and clears every currently-pending request, emitting
   * `permission_resolved` for each so a caller's own event log/UI projection sees a genuine
   * terminal state rather than a card that silently stops updating. Called by the session actor
   * from both `interrupt()` and `close()`. */
  failAllPending(outcome: Extract<PermissionOutcome, 'cancelled_by_interrupt' | 'cancelled_by_session_close' | 'provider_failed'>): void {
    for (const [permissionId, entry] of this.pending) {
      this.pending.delete(permissionId);
      entry.cleanupAbortListener();
      entry.resolve({ allow: false, reason: `session ${outcome}` });
      this.emit({ type: 'permission_resolved', permissionId, outcome });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
