import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { makeFakeQuery } from './fakeQuery.js';
import { createInteractionPort } from '../src/interactionPort.js';
import { TaskNotFoundError } from '../src/taskOutput.js';
import { buildSessionOptions, createSession, policyToBaseOptions, type QueryFn } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';

/** What every existing session shape built before the question and task seams existed: the options of
 * `sessionOptionsSnapshot.json`'s inputs, recorded from the kernel as it was without them. */
type Shape =
  | { name: string; kind: 'base'; input: { policy: ClaudeHostPolicy; cwd: string; overrides: Parameters<typeof policyToBaseOptions>[2] | null }; keys: string[]; options: unknown }
  | { name: string; kind: 'session'; input: { config: ClaudeSessionConfig }; keys: string[]; options: unknown };

const SNAPSHOT = JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/sessionOptionsSnapshot.json', import.meta.url)), 'utf8')) as Shape[];

/** Runs `body` with the process environment replaced by the one the snapshot was recorded under. */
function withSnapshotEnv<T>(body: () => T): T {
  const saved = process.env;
  process.env = { PATH: '/usr/bin', HOME: '/home/u' };
  try {
    return body();
  } finally {
    process.env = saved;
  }
}

function buildShape(shape: Shape, clientInteractions?: { questions: boolean }): Options {
  if (shape.kind === 'base') {
    const overrides = shape.input.overrides ?? {};
    return policyToBaseOptions(shape.input.policy, shape.input.cwd, clientInteractions === undefined ? shape.input.overrides ?? undefined : { ...overrides, clientInteractions });
  }
  return withSnapshotEnv(() => buildSessionOptions(clientInteractions === undefined ? shape.input.config : { ...shape.input.config, clientInteractions }));
}

function plain(options: Options): unknown {
  return JSON.parse(JSON.stringify(options));
}

/**
 * The snapshot's options with the changes made on purpose since it was recorded: the CLI's environment
 * always carries `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, on top of the environment the shape built
 * before (or, when it built none, the environment the SDK would have used by default); and a policy that
 * states `perTaskStop: true` now declares the per-task stop to the CLI (`perTaskStopAffordance`), which
 * the kernel could not offer when the snapshot was recorded. Every other key is as it was.
 */
function expected(shape: Shape): { options: unknown; keys: string[] } {
  const options = structuredClone(shape.options) as Record<string, unknown>;
  const fallback = shape.kind === 'base' ? (shape.input.overrides?.baseEnv ?? process.env) : { PATH: '/usr/bin', HOME: '/home/u' };
  options.env = { ...((options.env as Record<string, string> | undefined) ?? fallback), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  const keys = [...shape.keys, 'env'];
  const policy = shape.kind === 'base' ? shape.input.policy : shape.input.config.policy;
  if (policy.perTaskStop === true) {
    options.perTaskStopAffordance = true;
    keys.push('perTaskStopAffordance');
  }
  return { options: plain(options as Options), keys: [...new Set(keys)].sort() };
}

test('the snapshot covers every shape the corpus names', () => {
  assert.ok(SNAPSHOT.length >= 20, `only ${SNAPSHOT.length} shapes recorded`);
  assert.ok(SNAPSHOT.some((s) => s.kind === 'base') && SNAPSHOT.some((s) => s.kind === 'session'));
});

for (const shape of SNAPSHOT) {
  test(`options: ${shape.name} builds the options it built before the seams, with and without an interaction request`, () => {
    // A session that can be opted in changes on purpose when it is (questionOptions.test.ts); every other
    // shape is untouched by the request.
    const asks = shape.kind === 'base' ? shape.input.policy : shape.input.config.policy;
    const canOptIn = asks.permissions === 'interactive' && asks.providerPermissionPrompts === true;
    for (const optIn of canOptIn ? [undefined, { questions: false }] : [undefined, { questions: false }, { questions: true }]) {
      const options = buildShape(shape, optIn);
      const before = expected(shape);
      assert.deepEqual(plain(options), before.options, `opt-in ${JSON.stringify(optIn)}`);
      assert.deepEqual(Object.keys(options).sort(), before.keys, `opt-in ${JSON.stringify(optIn)}: the same keys`);
    }
  });
}

const INTERACTIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const BYPASS: ClaudeHostPolicy = { configuration: 'native', permissions: 'bypass', persistence: 'host_cli', executable: 'host_cli' };

function capture(config: ClaudeSessionConfig): { session: ReturnType<typeof createSession>; options: Options } {
  let seen: Options | undefined;
  const { query } = makeFakeQuery();
  const queryFn: QueryFn = (params) => {
    seen = params.options;
    return query;
  };
  const session = createSession(config, queryFn);
  return { session, options: seen! };
}

test('createInteractionPort offers no port yet, whatever the session asked for', () => {
  const emitted: ClaudeRuntimeEvent[] = [];
  for (const clientInteractions of [undefined, { questions: false }, { questions: true }]) {
    assert.equal(createInteractionPort({ policy: INTERACTIVE, clientInteractions }, (event) => emitted.push(event)), undefined);
  }
  assert.deepEqual(emitted, []);
});

test('a session has no interactions, and stopTask and taskOutput reject a task it never saw as not found', async () => {
  for (const clientInteractions of [undefined, { questions: true }]) {
    const { session } = capture({ cwd: '/p', policy: INTERACTIVE, clientInteractions });
    assert.equal(session.interactions(), undefined);
    for (const call of [() => session.stopTask('task-1'), () => session.taskOutput('task-1')]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof TaskNotFoundError);
        assert.equal(error.taskId, 'task-1');
        return true;
      });
    }
    session.close();
  }
});

test('createSession hands the SDK the same options whether or not a session that cannot be opted in asked for questions', () => {
  for (const policy of [INTERACTIVE, BYPASS]) {
    const without = capture({ cwd: '/p', policy });
    const asked = capture({ cwd: '/p', policy, clientInteractions: { questions: true } });
    const strip = ({ hooks, canUseTool, ...rest }: Options) => ({ rest: plain(rest), hooks: hooks?.PreToolUse?.length, canUseTool: typeof canUseTool });
    assert.deepEqual(strip(asked.options), strip(without.options));
    without.session.close();
    asked.session.close();
  }
});

test('the permission gate decides as it did: an interactive session asks, a bypass session installs no hook', async () => {
  const { session, options } = capture({ cwd: '/p', policy: INTERACTIVE, clientInteractions: { questions: true } });
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook, 'an interactive session installs its PreToolUse gate');
  const ac = new AbortController();
  const pending = hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_use_id: 'toolu_q', session_id: 's', transcript_path: '', cwd: '/p' }, 'toolu_q', { signal: ac.signal });
  const events = await session.pump();
  const requested = events.filter((event) => event.type === 'permission_requested');
  assert.equal(requested.length, 1, 'the gate still asks the host about the question tool');
  ac.abort();
  await pending;
  session.close();
  assert.equal(capture({ cwd: '/p', policy: BYPASS, clientInteractions: { questions: true } }).options.hooks, undefined);
});

test('a session produces the same events with and without the questions opt-in', async () => {
  const run = async (clientInteractions?: { questions: boolean }): Promise<ClaudeRuntimeEvent[]> => {
    const { session } = capture({ cwd: '/p', policy: BYPASS, clientInteractions });
    const events = [...(await session.pump())];
    session.close();
    events.push(...(await session.pump()));
    return events;
  };
  const baseline = await run();
  assert.ok(baseline.some((event) => event.type === 'provider_notice'), 'the default-deny notice is part of the stream');
  assert.ok(baseline.some((event) => event.type === 'session_closed'));
  assert.deepEqual(await run({ questions: true }), baseline);
});
