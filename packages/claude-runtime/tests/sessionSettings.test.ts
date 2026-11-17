import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, SessionSettingsError } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled' };

const init = (permissionMode: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'system', subtype: 'init', session_id: 'c1', model: 'claude-opus-5-5', cwd: '/w', permissionMode, tools: [], mcp_servers: [], ...extra }) as unknown as SDKMessage;
const status = (permissionMode: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: 'u', session_id: 'c1', ...extra }) as unknown as SDKMessage;
const result = () =>
  ({ type: 'result', subtype: 'success', result: 'ok', is_error: false, stop_reason: 'end_turn', num_turns: 1, session_id: 'c1', usage: {}, modelUsage: {}, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, uuid: 'r' }) as unknown as SDKMessage;

function setup(options: FakeQueryOptions = {}) {
  const { query, controller } = makeFakeQuery(options);
  const session = createSession({ cwd: '/w', policy: POLICY }, () => query, { onDiagnostic: () => {} });
  const feed = async (...frames: SDKMessage[]): Promise<ClaudeRuntimeEvent[]> => {
    for (const frame of frames) controller.emit(frame);
    const out: ClaudeRuntimeEvent[] = [];
    for (let quiet = 0; quiet < 3; ) {
      const events = await session.pump();
      out.push(...events);
      quiet = events.length === 0 ? quiet + 1 : 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return out;
  };
  return { session, feed };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const reported = (events: ClaudeRuntimeEvent[]) => events.filter((event) => event.type === 'cli_mode_reported');
const ready = (events: ClaudeRuntimeEvent[]) => events.find((event) => event.type === 'session_ready');

test('setModel asks the CLI, then reads back what it will use', async () => {
  const asked: Array<string | undefined> = [];
  const { session } = setup({
    setModel: async (model) => {
      asked.push(model);
    },
    getSettings: async () => ({ applied: { model: 'claude-sonnet-5-5', effort: 'high' } }),
  });
  assert.deepEqual(await session.setModel('sonnet'), { model: 'claude-sonnet-5-5', effort: 'high' });
  assert.deepEqual(asked, ['sonnet']);
});

test('the CLI refusing an id rejects with its own words and asks nothing more', async () => {
  let reads = 0;
  const { session } = setup({
    setModel: async () => {
      throw new Error("Model 'x' not found");
    },
    getSettings: async () => {
      reads += 1;
      return { applied: {} };
    },
  });
  await settle();
  const before = reads;
  await assert.rejects(session.setModel('x'), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'provider_refused' && error.message.includes("Model 'x' not found"));
  assert.equal(reads, before);
});

test('an id that cannot be one is refused ahead of the CLI', async () => {
  const asked: Array<string | undefined> = [];
  const { session } = setup({
    setModel: async (model) => {
      asked.push(model);
    },
  });
  for (const bad of ['', 'two words', 'line\nbreak', 'x'.repeat(257), 'nul\u0000']) {
    await assert.rejects(session.setModel(bad), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'refused', JSON.stringify(bad));
  }
  assert.deepEqual(asked, []);
});

test('a change without a settings read still succeeds, and says nothing it does not know', async () => {
  const { session } = setup();
  assert.deepEqual(await session.setModel('sonnet'), { model: '', effort: '' });
});

test('a settings read that fails or never answers says nothing and does not fail the change', async () => {
  const { session } = setup({
    getSettings: async () => {
      throw new Error('no');
    },
  });
  assert.deepEqual(await session.setModel('sonnet'), { model: '', effort: '' });
});

test('overlapping changes reach the CLI in call order', async () => {
  const order: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const { session } = setup({
    setModel: async (model) => {
      order.push(`start ${model}`);
      if (model === 'a') await held;
      order.push(`end ${model}`);
    },
  });
  const first = session.setModel('a');
  const second = session.setModel('b');
  await settle();
  assert.deepEqual(order, ['start a']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
});

test('applyEffort sets the flag, clears it with an empty level, and refuses a word the CLI would swallow', async () => {
  const flags: Array<string | null> = [];
  const { session } = setup({
    applyFlagSettings: async (settings) => {
      flags.push(settings.effortLevel);
    },
    getSettings: async () => ({ applied: { model: 'm', effort: 'low' } }),
  });
  assert.deepEqual(await session.applyEffort('low'), { model: 'm', effort: 'low' });
  await session.applyEffort('max');
  await session.applyEffort('');
  await assert.rejects(session.applyEffort('no-such-level'), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'refused');
  assert.deepEqual(flags, ['low', 'max', null]);
});

test('listModels gives the CLI\'s rows in its order, with what it will use', async () => {
  const models = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'max'], supportsAutoMode: true },
    { value: 'old', displayName: 'Old', description: 'o' },
  ] as unknown as ModelInfo[];
  const { session } = setup({ supportedModels: async () => models, getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: null } }) });
  assert.deepEqual(await session.listModels(), {
    models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'max'], supportsAutoMode: true },
      { value: 'old', resolvedModel: '', displayName: 'Old', description: 'o', supportsEffort: false, supportedEffortLevels: [], supportsAutoMode: false },
    ],
    applied: { model: 'claude-opus-5-5', effort: '' },
  });
});

test('a status frame that moves the CLI\'s mode is reported once, and only then', async () => {
  const { feed } = setup();
  assert.deepEqual(reported(await feed(init('auto'))), []);
  assert.deepEqual(reported(await feed(status('auto'))), [], 'the mode the last init said');
  assert.deepEqual(reported(await feed(status('default'))), [{ type: 'cli_mode_reported', permissionMode: 'default' }]);
  assert.deepEqual(reported(await feed(status('default'))), [], 'the same mode again');
});

test('ahead of any init, a status frame is judged against the mode the session was created to run', async () => {
  const { feed } = setup();
  assert.deepEqual(reported(await feed({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'u', session_id: 'c1' } as unknown as SDKMessage)), []);
  assert.deepEqual(reported(await feed(status('default'))), [], 'the mode it was created in has not moved');
  assert.deepEqual(reported(await feed(status('plan'))), [{ type: 'cli_mode_reported', permissionMode: 'plan' }]);
});

test('an auto session reports its move before any init', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/w', policy: { ...POLICY, cliPermissionMode: 'auto' } }, () => query, { onDiagnostic: () => {} });
  controller.emit(status('default'));
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(...(await session.pump()));
    await settle();
  }
  assert.deepEqual(reported(events), [{ type: 'cli_mode_reported', permissionMode: 'default' }]);
});

test('the host\'s own SetPermissionMode gives no report of the CLI moving by itself', async () => {
  const { query, controller } = makeFakeQuery();
  const session = createSession({ cwd: '/w', policy: { ...POLICY, permissionModeSwitchable: true } }, () => query, { onDiagnostic: () => {} });
  await session.setPermissionMode('bypass');
  controller.emit(status('bypassPermissions'));
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(...(await session.pump()));
    await settle();
  }
  assert.deepEqual(reported(events), []);
  assert.ok(events.some((event) => event.type === 'permission_mode_changed'));
});

test('a change the CLI never answers is ended by the close, and so is what waits behind it', async () => {
  const flags: Array<string | null> = [];
  const { session } = setup({
    setModel: () => new Promise<void>(() => {}),
    applyFlagSettings: async (settings) => {
      flags.push(settings.effortLevel);
    },
  });
  const closed = (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed';
  const first = session.setModel('a');
  const second = session.applyEffort('low');
  await settle();
  await session.close();
  await assert.rejects(first, closed);
  await assert.rejects(second, closed);
  await assert.rejects(session.applyEffort('low'), closed);
  assert.deepEqual(flags, []);
});

test('an acknowledgement that arrives after the close is not a success', async () => {
  let acknowledge = () => {};
  const { session } = setup({ setModel: () => new Promise<void>((resolve) => (acknowledge = resolve)) });
  const change = session.setModel('sonnet');
  await settle();
  await session.close();
  acknowledge();
  await assert.rejects(change, (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed');
});

test('the SDK rejecting what is pending as the process goes reads as closed, not as the CLI refusing', async () => {
  const { session } = setup({
    setModel: async () => {
      throw new Error('Query closed before response received');
    },
  });
  await assert.rejects(session.setModel('sonnet'), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed');
});

test('an older read that arrives late does not replace what a change left', async () => {
  let answerStart: (value: { applied: { effort: string } }) => void = () => {};
  let reads = 0;
  const { session, feed } = setup({
    getSettings: () => {
      reads += 1;
      return reads === 1 ? new Promise((resolve) => (answerStart = resolve)) : Promise.resolve({ applied: { effort: 'low' } });
    },
  });
  await session.applyEffort('low');
  answerStart({ applied: { effort: 'medium' } });
  await settle();
  const event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'low');
});

test('a read that fails leaves the level that was known', async () => {
  let fail = false;
  const { session, feed } = setup({
    getSettings: async () => {
      if (fail) throw new Error('no');
      return { applied: { effort: 'high' } };
    },
  });
  await settle();
  fail = true;
  await session.applyEffort('low');
  const event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'high');
});

test('an init that says null says the model takes no level, whatever the last read was', async () => {
  const { feed } = setup({ getSettings: async () => ({ applied: { effort: 'medium' } }) });
  await settle();
  const event = ready(await feed(init('default', { effort: null })));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, '');
});

test('a subagent\'s status frame says nothing about the session', async () => {
  const { feed } = setup();
  await feed(init('auto'));
  assert.deepEqual(reported(await feed(status('default', { parent_tool_use_id: 'toolu_a' }))), []);
});

test('session_ready carries the effort the CLI\'s own init reports', async () => {
  const { feed } = setup({ getSettings: async () => ({ applied: { effort: 'medium' } }) });
  const event = ready(await feed(init('default', { effort: 'high' })));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'high');
});

test('session_ready falls back on the read made at the start', async () => {
  const { feed } = setup({ getSettings: async () => ({ applied: { effort: 'medium' } }) });
  await settle();
  const event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'medium');
});

test('session_ready states no effort when nothing said one', async () => {
  const { feed } = setup();
  const event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : 'present', undefined);
});

test('applyEffort is what the next session_ready says, and a model with no level clears it', async () => {
  let effort: string | null = 'medium';
  const { session, feed } = setup({
    applyFlagSettings: async (settings) => {
      effort = settings.effortLevel;
    },
    setModel: async () => {
      effort = null;
    },
    getSettings: async () => ({ applied: { effort } }),
  });
  await settle();
  await session.applyEffort('low');
  let event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'low');
  await session.setModel('old');
  event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : 'present', undefined);
});

test('a turn that opened with a slash command reads the effort again when it ends, and only that one', async () => {
  let reads = 0;
  let effort = 'medium';
  const { session, feed } = setup({
    getSettings: async () => {
      reads += 1;
      return { applied: { effort } };
    },
  });
  await settle();
  const start = reads;
  session.sendTurn('hello');
  await feed(init('default'), result());
  await settle();
  assert.equal(reads, start, 'a plain turn reads nothing');
  session.sendTurn('  /effort low');
  effort = 'low';
  await feed(init('default'), result());
  await settle();
  assert.equal(reads, start + 1);
  session.sendTurn('hello');
  const event = ready(await feed(init('default')));
  assert.equal(event?.type === 'session_ready' ? event.effort : null, 'low');
});

test('a closed session refuses a change', async () => {
  const { session } = setup();
  await session.close();
  await assert.rejects(session.setModel('sonnet'), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed');
  await assert.rejects(session.applyEffort('low'), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed');
  await assert.rejects(session.listModels(), (error: unknown) => error instanceof SessionSettingsError && error.kind === 'closed');
});
