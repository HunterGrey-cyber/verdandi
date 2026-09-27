import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query as realQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { createSession, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

/**
 * A repository's own settings cannot choose a GATED session's starting permission mode.
 *
 * ### The threat
 *
 * The CLI takes the first mode it finds: `--permission-mode`, then `permissions.defaultMode` from
 * the loaded settings tiers. `project` (`.claude/settings.json`) and `local`
 * (`.claude/settings.local.json`) are files inside the repository being worked on, and a gated
 * session loads both -- neovibe asks for exactly `[project, local]`, which is what this file uses.
 * The feared consequence: a PreToolUse hook that never answers (timeout) falls through to THAT
 * mode, and `acceptEdits` writes the file where `default` refuses an ungranted write.
 *
 * ### What each test proves
 *
 * - The three production cases: with the kernel's options untouched, `session_ready` reports
 *   `default` whatever the repo's settings say, the Write reaches the host's hook, the hook is left
 *   unanswered until the CLI's own timeout expires it, and the file is NOT written.
 * - The control: the same session with `--permission-mode` removed from argv. Without it the
 *   A/B would prove nothing -- if the CLI simply ignored `defaultMode` in these tiers, the
 *   production cases would pass for a reason that has nothing to do with the kernel. Removing the
 *   flag needs the SDK's undocumented `resolvePermissionModeInCli`, because SDK 0.3.252 substitutes
 *   `default` for an unset `permissionMode` itself (claude-agent-sdk/sdk.mjs:162); if a later SDK
 *   drops that option the control fails loudly on the mode assertion rather than passing vacuously.
 *
 * ### What the control measured (CLI 2.1.283, 2026-09-27), and what it did NOT
 *
 * The repo's `acceptEdits` DID become the session's mode -- so the settings tier reaches a gated
 * session whenever nothing states a mode, and the explicit `default` is what stops it. But the
 * feared fall-through did NOT reproduce: the timed-out Write was refused in `acceptEdits` too, with
 * the tool result "PreToolUse hook did not respond before its timeout (host client may be
 * unreachable). The tool call was not executed". On this build a hook timeout fails closed in any
 * mode; the control asserts that too, so a CLI that starts falling through turns it red and says
 * the explicit mode has become load-bearing rather than defensive. A hook that ABSTAINS (returns
 * no decision) does leave the call to the mode -- the gate only abstains in bypass today.
 *
 * Why not `bypassPermissions` in the control: CLI 2.1.283 already ignores it from project/local
 * ("only policy/user/flag settings may grant bypass mode"), so the mode would not change. It is
 * still one of the production cases, because that CLI behaviour is not something this package
 * controls.
 *
 * Cost: one short haiku turn per test, four in all. Run under the TEST profile:
 *
 *   VERDANDI_CLAUDE_ACCOUNT=test bash -c 'cd packages/claude-runtime && npm run build && \
 *     RUN_REAL_CLAUDE_TESTS=1 node --test dist/tests/realSdk.defaultMode.integration.test.js'
 *
 * Scratch projects go under `$XDG_CACHE_HOME` (else `~/.cache`), not `/tmp`, and are removed after.
 */

const GATED_POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
  settingSources: ['project', 'local'],
};

const HOOK_TIMEOUT_SECONDS = 8;
const TARGET = 'probe.txt';
const PROMPT =
  `Use the Write tool exactly once to create the file ${TARGET} in the current directory, containing the single word: probe. ` +
  'Do not use any other tool. If the Write fails, do not retry and do not try another way; reply with the single word: failed.';

type Observed = {
  permissionMode: string | undefined;
  requestedTools: string[];
  resolvedOutcomes: string[];
  /** Each tool result, truncated -- what the CLI told the model after the hook timed out. */
  toolResults: Array<{ isError: boolean; content: string }>;
  turnCompleted: boolean;
  fileWritten: boolean;
  seen: string[];
};

function scratchRoot(): string {
  const cache = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(join(cache, 'verdandi-default-mode-'));
}

async function runCase(settingsFile: 'settings.json' | 'settings.local.json', defaultMode: string, queryFn?: QueryFn): Promise<Observed> {
  const dir = scratchRoot();
  let session: ReturnType<typeof createSession> | undefined;
  try {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', settingsFile), JSON.stringify({ permissions: { defaultMode } }));
    session = createSession(
      { ...realSessionConfig(dir, GATED_POLICY), model: 'haiku', permissionHookTimeoutSeconds: HOOK_TIMEOUT_SECONDS },
      queryFn,
    );
    session.sendTurn(PROMPT);

    const observed: Observed = { permissionMode: undefined, requestedTools: [], resolvedOutcomes: [], toolResults: [], turnCompleted: false, fileWritten: false, seen: [] };
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !observed.turnCompleted) {
      for (const event of (await session.pump()) as ClaudeRuntimeEvent[]) {
        observed.seen.push(event.type);
        if (event.type === 'session_ready' && observed.permissionMode === undefined) {
          observed.permissionMode = event.permissionMode;
        }
        if (event.type === 'permission_requested') {
          // DELIBERATELY NOT ANSWERED: the question is what the CLI does once the host's hook times out.
          observed.requestedTools.push(event.toolName);
        }
        if (event.type === 'permission_resolved') {
          observed.resolvedOutcomes.push(event.outcome);
        }
        if (event.type === 'tool_call_completed') {
          const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
          observed.toolResults.push({ isError: event.isError, content: content.slice(0, 400) });
        }
        if (event.type === 'turn_completed') {
          observed.turnCompleted = true;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    observed.fileWritten = existsSync(join(dir, TARGET));
    console.log(`[default-mode] ${settingsFile} defaultMode=${defaultMode} control=${queryFn !== undefined} -> ${JSON.stringify({ ...observed, seen: undefined })}`);
    return observed;
  } finally {
    session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertGatedDefault(o: Observed, what: string): void {
  assert.ok(o.turnCompleted, `${what}: no turn_completed within 180s. Saw: ${JSON.stringify(o.seen)}`);
  assert.equal(o.permissionMode, 'default', `${what}: the repo's settings chose the gated session's mode`);
  assert.ok(o.requestedTools.includes('Write'), `${what}: the Write never reached the host's hook, so nothing here is about the hook. Requested: ${JSON.stringify(o.requestedTools)}`);
  assert.ok(o.resolvedOutcomes.length > 0 && o.resolvedOutcomes.every((r) => r === 'expired'), `${what}: expected every request to expire unanswered, got ${JSON.stringify(o.resolvedOutcomes)}`);
  assert.equal(o.fileWritten, false, `${what}: the file was written after the hook timed out -- the timeout fell through to a permissive mode`);
}

test('real SDK: project settings defaultMode bypassPermissions does not choose a gated session\'s mode', { skip: !REAL }, async () => {
  assertGatedDefault(await runCase('settings.json', 'bypassPermissions'), 'project bypassPermissions');
});

test('real SDK: project settings defaultMode acceptEdits does not choose a gated session\'s mode', { skip: !REAL }, async () => {
  assertGatedDefault(await runCase('settings.json', 'acceptEdits'), 'project acceptEdits');
});

test('real SDK: local settings defaultMode acceptEdits does not choose a gated session\'s mode', { skip: !REAL }, async () => {
  assertGatedDefault(await runCase('settings.local.json', 'acceptEdits'), 'local acceptEdits');
});

test('real SDK CONTROL: with no --permission-mode on argv, project acceptEdits does choose a gated session\'s mode (and a timed-out hook still fails closed)', { skip: !REAL }, async () => {
  const withoutModeFlag: QueryFn = (params) => {
    const options = { ...(params.options ?? {}) } as Options & { resolvePermissionModeInCli?: boolean };
    delete options.permissionMode;
    options.resolvePermissionModeInCli = true;
    return (realQuery as unknown as QueryFn)({ ...params, options });
  };
  const o = await runCase('settings.json', 'acceptEdits', withoutModeFlag);
  assert.ok(o.turnCompleted, `control: no turn_completed within 180s. Saw: ${JSON.stringify(o.seen)}`);
  assert.equal(o.permissionMode, 'acceptEdits', 'control: without the flag the repo setting did not take effect, so the production cases above prove nothing about the flag');
  assert.ok(o.requestedTools.includes('Write'), `control: the Write never reached the hook. Requested: ${JSON.stringify(o.requestedTools)}`);
  // Measured on CLI 2.1.283: refused in acceptEdits too. If this turns red, a hook timeout now falls
  // through to the session's mode, and the explicit `default` in policyToBaseOptions has gone from
  // defensive to load-bearing -- record that, do not "fix" this assertion.
  assert.equal(o.fileWritten, false, 'control: a timed-out hook fell through to acceptEdits and the Write ran -- the CLI no longer fails a hook timeout closed');
  assert.ok(
    o.toolResults.some((r) => r.isError && r.content.includes('did not respond before its timeout')),
    `control: expected the CLI's hook-timeout refusal in a tool result, got ${JSON.stringify(o.toolResults)}`,
  );
});
