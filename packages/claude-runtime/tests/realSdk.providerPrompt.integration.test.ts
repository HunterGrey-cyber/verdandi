import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, PROVIDER_PROMPT_TOOL_DENY } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

/**
 * ClaudeHostPolicy.providerPermissionPrompts against the real CLI: the sensitive-file safety check
 * that a PreToolUse allow cannot silence reaches the host as a `provider_prompt`; the host's allow
 * really writes the file, its deny fails that call with the host's reason, and an interrupt with the
 * prompt unanswered ends the turn at once and fails the prompt closed. Without the flag the same Write
 * is refused with nobody asked (neovibe's O3 spike, CLI 2.1.283; that half is not re-run here).
 *
 * The policy is neovibe's product shape -- interactive, settingSources project+local -- because that
 * is the client this exists for. The scratch project is a fresh `git init`, so `.git/` is a real
 * repository directory. Run through the TEST profile only:
 *
 *   VERDANDI_CLAUDE_CONFIG_DIR=<a test login's dir> VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR=<its anthropic dir> \
 *     npm run test:real -w @verdandi/claude-runtime
 *
 * (or `RUN_REAL_CLAUDE_TESTS=1 node --test dist/tests/realSdk.providerPrompt.integration.test.js`
 * with VERDANDI_CLAUDE_CONFIG_DIR and VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR naming a test login). The model defaults to `haiku` to keep the cost down; the check being
 * exercised is the CLI's, not the model's. VERDANDI_REAL_TEST_MODEL overrides it.
 */

const POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
  settingSources: ['project', 'local'],
  providerPermissionPrompts: true,
};

type Requested = Extract<ClaudeRuntimeEvent, { type: 'permission_requested' }>;

test('real SDK: a provider prompt for a .git/ write reaches the host, and the host allow writes the file', { skip: !REAL, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-real-provider-prompt-'));
  execFileSync('git', ['init', '-q', dir]);
  const target = join(dir, '.git', 'probe');
  const CONTENT = 'provider prompt probe';
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession({ ...realSessionConfig(dir, POLICY), model: process.env.VERDANDI_REAL_TEST_MODEL?.trim() || 'haiku' });
    session.sendTurn(
      [
        'This is a permissions test harness. Use only the Write tool (load it with ToolSearch first if needed).',
        `Make exactly one Write call: file_path ${target}, content "${CONTENT}".`,
        'If it fails or is refused, do NOT retry and do not try another tool; reply with the exact error text.',
        'Otherwise reply with the single word written.',
      ].join('\n'),
    );

    const requests: Requested[] = [];
    const initTools: string[][] = [];
    const permissionModes: string[] = [];
    const toolResults: Array<{ toolUseId: string; isError: boolean; content: unknown }> = [];
    let completed: Extract<ClaudeRuntimeEvent, { type: 'turn_completed' }> | undefined;
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline && completed === undefined) {
      for (const event of await session.pump()) {
        if (event.type === 'permission_requested') {
          requests.push(event);
          session.resolvePermission(event.permissionId, { allow: true });
        } else if (event.type === 'session_ready') {
          permissionModes.push(event.permissionMode);
          if (event.initFingerprint !== undefined) {
            initTools.push(event.initFingerprint.tools);
          }
        } else if (event.type === 'tool_call_completed') {
          toolResults.push({ toolUseId: event.toolUseId, isError: event.isError, content: event.content });
        } else if (event.type === 'turn_completed') {
          completed = event;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const summary = {
      requests: requests.map((r) => ({ origin: r.origin, toolName: r.toolName, toolUseId: r.toolUseId, providerReason: r.providerReason, providerDescription: r.providerDescription })),
      permissionModes,
      initToolCount: initTools.map((t) => t.length),
      toolResults,
      resultText: completed?.resultText,
    };
    console.log(`[provider-prompt] ${JSON.stringify(summary)}`);

    assert.ok(completed, 'no turn_completed within 210s');
    assert.ok(permissionModes.length > 0 && permissionModes.every((m) => m === 'default'), `the session must run in default: ${JSON.stringify(permissionModes)}`);
    assert.ok(initTools.length > 0, 'system/init reported no tools list');
    for (const tools of initTools) {
      for (const tool of PROVIDER_PROMPT_TOOL_DENY) {
        assert.ok(!tools.includes(tool), `${tool} reached the model's tool set although the flag disallows it: ${JSON.stringify(tools)}`);
      }
    }

    const prompts = requests.filter((r) => r.origin === 'provider_prompt');
    assert.equal(prompts.length, 1, `expected exactly one provider prompt (the .git/ write): ${JSON.stringify(summary.requests)}`);
    const [prompt] = prompts;
    assert.equal(prompt.toolName, 'Write');
    assert.equal((prompt.input as { file_path?: string }).file_path, target);
    assert.ok(prompt.providerReason !== undefined && prompt.providerReason.trim() !== '', 'the CLI gave its reason');
    const hookForSameCall = requests.find((r) => r.origin === 'hook' && r.toolUseId === prompt.toolUseId);
    assert.ok(hookForSameCall, `the gate asked about that call first, under the same tool_use_id: ${JSON.stringify(summary.requests)}`);
    assert.ok(requests.indexOf(hookForSameCall) < requests.indexOf(prompt), 'the hook request comes before the provider prompt');

    assert.ok(existsSync(target), `${target} was not written`);
    assert.equal(readFileSync(target, 'utf8'), CONTENT);
  } finally {
    if (session) {
      session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch `git init` project, a session with the flag, and a turn asking for one Write to
 * `.git/probe`; every HOOK request is allowed, and what happens to the provider prompt is the test's. */
async function sensitiveWriteTurn(
  label: string,
  onProviderPrompt: (session: ReturnType<typeof createSession>, prompt: Requested) => Promise<void> | void,
): Promise<{ target: string; events: ClaudeRuntimeEvent[]; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `claude-runtime-real-provider-prompt-${label}-`));
  execFileSync('git', ['init', '-q', dir]);
  const target = join(dir, '.git', 'probe');
  const session = createSession({ ...realSessionConfig(dir, POLICY), model: process.env.VERDANDI_REAL_TEST_MODEL?.trim() || 'haiku' });
  session.sendTurn(
    [
      'This is a permissions test harness. Use only the Write tool (load it with ToolSearch first if needed).',
      `Make exactly one Write call: file_path ${target}, content "x".`,
      'If it fails or is refused, do NOT retry and do not try another tool; reply with the exact error text.',
    ].join('\n'),
  );
  const events: ClaudeRuntimeEvent[] = [];
  const deadline = Date.now() + 180_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    for (const event of await session.pump()) {
      events.push(event);
      if (event.type === 'permission_requested') {
        if (event.origin === 'hook') {
          session.resolvePermission(event.permissionId, { allow: true });
        } else {
          await onProviderPrompt(session, event);
        }
      } else if (event.type === 'turn_completed') {
        done = true;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // A few more polls, so a permission_resolved that trails turn_completed is seen too.
  for (let i = 0; i < 5; i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    target,
    events,
    cleanup: () => {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('real SDK: a host deny of the provider prompt fails that Write with the host reason, and the turn completes', { skip: !REAL, timeout: 240_000 }, async () => {
  const REASON = 'verdandi test host: sensitive files are off limits here';
  const run = await sensitiveWriteTurn('deny', (session, prompt) => {
    session.resolvePermission(prompt.permissionId, { allow: false, reason: REASON });
  });
  try {
    const prompts = run.events.filter((e): e is Requested => e.type === 'permission_requested' && e.origin === 'provider_prompt');
    const results = run.events.filter((e) => e.type === 'tool_call_completed') as Array<Extract<ClaudeRuntimeEvent, { type: 'tool_call_completed' }>>;
    const completed = run.events.find((e) => e.type === 'turn_completed') as Extract<ClaudeRuntimeEvent, { type: 'turn_completed' }> | undefined;
    console.log(`[provider-prompt deny] ${JSON.stringify({ prompts: prompts.length, results, outcome: completed?.outcome, resultText: completed?.resultText })}`);
    assert.ok(completed, 'no turn_completed');
    assert.equal(prompts.length, 1);
    const write = results.find((r) => r.toolUseId === prompts[0].toolUseId);
    assert.ok(write, 'the denied Write has a tool result');
    assert.equal(write.isError, true);
    assert.ok(JSON.stringify(write.content).includes(REASON), `the host reason reaches the tool result: ${JSON.stringify(write.content)}`);
    assert.equal(existsSync(run.target), false, 'a denied Write wrote nothing');
  } finally {
    run.cleanup();
  }
});

test('real SDK: interrupting with a provider prompt pending ends the turn promptly and fails the prompt closed', { skip: !REAL, timeout: 240_000 }, async () => {
  let interruptMs: number | undefined;
  const run = await sensitiveWriteTurn('interrupt', async (session) => {
    // The prompt is left unanswered; Stop is what the user presses instead.
    const started = Date.now();
    await session.interrupt();
    interruptMs = Date.now() - started;
  });
  try {
    const prompt = run.events.find((e): e is Requested => e.type === 'permission_requested' && e.origin === 'provider_prompt');
    const resolved = run.events.filter((e) => e.type === 'permission_resolved') as Array<Extract<ClaudeRuntimeEvent, { type: 'permission_resolved' }>>;
    const promptResolved = resolved.filter((r) => r.permissionId === prompt?.permissionId);
    const completed = run.events.find((e) => e.type === 'turn_completed') as Extract<ClaudeRuntimeEvent, { type: 'turn_completed' }> | undefined;
    console.log(`[provider-prompt interrupt] ${JSON.stringify({ interruptMs, promptResolved, outcome: completed?.outcome, terminalReason: completed?.terminalReason })}`);
    assert.ok(prompt, 'the provider prompt was raised');
    assert.ok(interruptMs !== undefined && interruptMs < 30_000, `interrupt() with a prompt pending took ${interruptMs} ms`);
    assert.equal(promptResolved.length, 1, `exactly one terminal state for the prompt: ${JSON.stringify(promptResolved)}`);
    assert.ok(['cancelled_by_interrupt', 'expired'].includes(promptResolved[0].outcome), promptResolved[0].outcome);
    assert.ok(completed, 'no turn_completed after the interrupt');
    assert.equal(completed.outcome, 'interrupted');
    assert.equal(existsSync(run.target), false, 'an interrupted, unanswered Write wrote nothing');
  } finally {
    run.cleanup();
  }
});
