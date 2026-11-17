import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { HookCallback, McpSdkServerConfigWithInstance, Options, SDKMessage, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ClientToolPort } from '../src/clientToolBroker.js';
import type { ClientTools } from '../src/clientTools.js';
import { CONNECTOR_SWITCH_ENV, type ExtraMcpServers } from '../src/extraMcpServers.js';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';
import { makeFakeQuery, type FakeQueryController, type FakeQueryOptions } from './fakeQuery.js';

type Frame = { id?: number; result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } };

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const ISOLATED: ClaudeHostPolicy = { ...POLICY, configuration: 'isolated' };
const TOOLS: ClientTools = { serverName: 'eitri', timeoutMs: 900000, tools: [{ name: 'open_file', description: 'd', inputSchemaJson: '{"type":"object"}', alwaysLoad: true }] };
const GATED_TOOL = 'mcp__eitri__open_file';

const BACKGROUND_AGENT = [
  { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'bg', run_id: 'r1' }] },
  { type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', description: 'bg', run_id: 'r1', tool_use_id: 'toolu_agent' },
];

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function feed(session: ReturnType<typeof createSession>, controller: FakeQueryController, frames: Array<Record<string, unknown>> = []): Promise<ClaudeRuntimeEvent[]> {
  for (const frame of frames) controller.emit(frame as unknown as SDKMessage);
  const events: ClaudeRuntimeEvent[] = [];
  for (let quiet = 0; quiet < 3; ) {
    const got = await session.pump();
    events.push(...got);
    quiet = got.length === 0 ? quiet + 1 : 0;
    await flush();
  }
  return events;
}

/** What `query()` would be handed, and the session's server connected to a transport the test writes into. */
async function start(config: Partial<ClaudeSessionConfig> = {}, fake: FakeQueryOptions = {}) {
  const { query, controller } = makeFakeQuery(fake);
  let options: Options | undefined;
  const session = createSession(
    { cwd: tmpdir(), policy: POLICY, clientTools: TOOLS, ...config },
    (params) => {
      options = params.options;
      return query;
    },
    { onDiagnostic: () => {} },
  );
  const sent: Frame[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    async start(): Promise<void> {},
    async send(message: Frame): Promise<void> {
      sent.push(message);
    },
    async close(): Promise<void> {},
  };
  const name = (config.clientTools ?? TOOLS).serverName;
  const server = options!.mcpServers?.[name] as McpSdkServerConfigWithInstance | undefined;
  await (server?.instance as unknown as { connect(transport: unknown): Promise<void> } | undefined)?.connect(transport);
  let nextId = 1;
  const request = async (method: string, params: unknown): Promise<number> => {
    const id = nextId++;
    transport.onmessage!({ jsonrpc: '2.0', id, method, params });
    await flush();
    return id;
  };
  const call = (toolUseId?: string): Promise<number> =>
    request('tools/call', { name: 'open_file', arguments: {}, ...(toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId } }) });
  return { session, controller, options: options!, sent, request, call, port: session.clientTools() as ClientToolPort };
}

type Harness = Awaited<ReturnType<typeof start>>;

function gatedCall(options: Options, toolUseId: string, agentId?: string): Promise<unknown> {
  const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
  const input = { hook_event_name: 'PreToolUse', tool_name: GATED_TOOL, tool_input: {}, tool_use_id: toolUseId, session_id: 's', transcript_path: '', cwd: '/p', ...(agentId === undefined ? {} : { agent_id: agentId }) };
  return hook(input as never, toolUseId, { signal: new AbortController().signal });
}

const decision = (output: unknown) => (output as SyncHookJSONOutput & { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

/** The PreToolUse hook sees the call, and the host answers its permission request. */
async function answerHook(h: Harness, toolUseId: string, agentId: string | undefined, answer: { allow: boolean; defer?: boolean }): Promise<unknown> {
  const hooked = gatedCall(h.options, toolUseId, agentId);
  const events = await feed(h.session, h.controller);
  const asked = events.find((event) => event.type === 'permission_requested' && event.toolUseId === toolUseId);
  assert.ok(asked && asked.type === 'permission_requested', 'the call asked for permission');
  assert.equal(h.session.resolvePermission(asked.permissionId, answer), true);
  return hooked;
}

const outcomes = (events: ClaudeRuntimeEvent[]) => events.flatMap((event) => (event.type === 'client_tool_call_settled' ? [event.outcome] : []));

function optionsOf(config: ClaudeSessionConfig): Options {
  const { query } = makeFakeQuery();
  let options: Options | undefined;
  createSession(
    config,
    (params) => {
      options = params.options;
      return query;
    },
    { onDiagnostic: () => {} },
  ).close();
  return options!;
}

test('without client_tools the options are byte-identical to a build without the field', () => {
  for (const policy of [POLICY, ISOLATED]) {
    const absent = optionsOf({ cwd: tmpdir(), policy });
    const stated = optionsOf({ cwd: tmpdir(), policy, clientTools: undefined });
    assert.equal(JSON.stringify(stated), JSON.stringify(absent));
    assert.deepEqual(stated.mcpServers, policy === ISOLATED ? {} : undefined, 'no server appears');
    assert.deepEqual(stated.settings, policy === ISOLATED ? { autoMemoryEnabled: false } : undefined, 'and no connector switch');
    assert.equal(stated.env?.[CONNECTOR_SWITCH_ENV], process.env[CONNECTOR_SWITCH_ENV]);
  }
});

test('the server is an sdk entry with the session\'s timeout, beside extra servers, and an extra server\'s copy is untouched', async () => {
  const extraMcpServers: ExtraMcpServers = Object.freeze({ docs: Object.freeze({ type: 'stdio', command: '/bin/true', args: ['x'] }) }) as ExtraMcpServers;
  const h = await start({ extraMcpServers });
  const servers = h.options.mcpServers!;
  assert.deepEqual(Object.keys(servers).sort(), ['docs', 'eitri']);
  const server = servers.eitri as McpSdkServerConfigWithInstance;
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'eitri');
  assert.equal(server.timeout, 900000);
  assert.ok(server.instance, 'the live server, which a structured clone could not carry');
  assert.deepEqual(servers.docs, extraMcpServers.docs);
  assert.notEqual(servers.docs, extraMcpServers.docs, 'a session never holds the process\'s own object');
  h.session.close();
});

test('ISOLATED with client tools keeps strict and turns the connectors off through settings and env', async () => {
  const h = await start({ policy: ISOLATED });
  assert.equal(h.options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(h.options.mcpServers!), ['eitri']);
  assert.deepEqual(h.options.settings, { autoMemoryEnabled: false, disableClaudeAiConnectors: true });
  assert.equal(h.options.env?.[CONNECTOR_SWITCH_ENV], 'false');
  h.session.close();
});

test('interrupt settles an open call before the CLI hears of it, and a call that arrives during the interrupt too', async () => {
  const seen: ClaudeRuntimeEvent[] = [];
  const h: Harness = await start({}, {
    interrupt: async () => {
      seen.push(...(await h.session.pump()));
      assert.deepEqual(outcomes(seen), ['interrupted'], 'settled before the CLI could abort it');
      await h.call('toolu_during');
    },
  });
  await h.call('toolu_open');
  await h.session.interrupt();
  seen.push(...(await feed(h.session, h.controller)));
  assert.deepEqual(outcomes(seen), ['interrupted', 'interrupted']);
  assert.deepEqual(h.port.pending(), []);
  await flush();
  assert.equal(h.sent.filter((frame) => frame.id === 2)[0]?.result?.isError, true);
  h.session.close();
});

test('with per_task_stop an Esc spares a background agent\'s gated call and fails the foreground\'s', async () => {
  const h = await start({ policy: { ...POLICY, perTaskStop: true } });
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  assert.equal(decision(await answerHook(h, 'toolu_bg', 'a1', { allow: true })), 'allow');
  assert.equal(decision(await answerHook(h, 'toolu_fg', undefined, { allow: true })), 'allow');
  const background = await h.call('toolu_bg');
  const foreground = await h.call('toolu_fg');
  const called = await feed(h.session, h.controller);
  const callIdOf = (toolUseId: string): string => {
    const event = called.find((candidate) => candidate.type === 'client_tool_call' && candidate.toolUseId === toolUseId);
    assert.ok(event && event.type === 'client_tool_call');
    return event.callId;
  };
  await h.session.interrupt();
  const settled = await feed(h.session, h.controller);
  assert.deepEqual(settled.filter((event) => event.type === 'client_tool_call_settled'), [{ type: 'client_tool_call_settled', callId: callIdOf('toolu_fg'), outcome: 'interrupted' }]);
  assert.deepEqual(h.port.pending().map((call) => call.toolUseId), ['toolu_bg']);
  h.port.answer(callIdOf('toolu_bg'), { content: [{ type: 'text', text: 'shown' }], isError: false });
  await flush();
  assert.deepEqual(h.sent.find((frame) => frame.id === background)?.result, { content: [{ type: 'text', text: 'shown' }] });
  assert.equal(h.sent.find((frame) => frame.id === foreground)?.result?.isError, true);
  h.session.close();
});

test('a call the host deferred to the CLI\'s mode is placed like an allowed one', async () => {
  const h = await start({ policy: { ...POLICY, perTaskStop: true } });
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  assert.equal(decision(await answerHook(h, 'toolu_bg', 'a1', { allow: false, defer: true })), undefined, 'no decision, so the CLI decides');
  await h.call('toolu_bg');
  await h.session.interrupt();
  assert.deepEqual(h.port.pending().map((call) => call.toolUseId), ['toolu_bg']);
  h.session.close();
});

test('without per_task_stop an interrupt settles both', async () => {
  const h = await start();
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  assert.equal(decision(await answerHook(h, 'toolu_bg', 'a1', { allow: true })), 'allow');
  await answerHook(h, 'toolu_fg', undefined, { allow: true });
  await h.call('toolu_bg');
  await h.call('toolu_fg');
  await h.session.interrupt();
  assert.deepEqual(outcomes(await feed(h.session, h.controller)), ['interrupted', 'interrupted']);
  assert.deepEqual(h.port.pending(), []);
  h.session.close();
});

test('an id the hook never saw, an agent not running in the background, and a denied call all settle on an interrupt', async () => {
  const h = await start({ policy: { ...POLICY, perTaskStop: true } });
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  await answerHook(h, 'toolu_other_agent', 'a_foreground', { allow: true });
  assert.equal(decision(await answerHook(h, 'toolu_denied', 'a1', { allow: false })), 'deny');
  await h.call('toolu_unseen');
  await h.call('toolu_other_agent');
  await h.call('toolu_denied');
  await h.call();
  await h.session.interrupt();
  assert.deepEqual(outcomes(await feed(h.session, h.controller)), ['interrupted', 'interrupted', 'interrupted', 'interrupted']);
  assert.deepEqual(h.port.pending(), [], 'nothing is left open with nobody to end it');
  h.session.close();
});

test('a bypass session has no hook, and an interrupt settles its call', async () => {
  const h = await start({ policy: { ...POLICY, permissions: 'bypass', perTaskStop: true } });
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  assert.equal(h.options.hooks, undefined);
  await h.call('toolu_bg');
  await h.session.interrupt();
  assert.deepEqual(outcomes(await feed(h.session, h.controller)), ['interrupted']);
  h.session.close();
});

test('a spared call settles session_closed when the session closes', async () => {
  const h = await start({ policy: { ...POLICY, perTaskStop: true } });
  await feed(h.session, h.controller, BACKGROUND_AGENT);
  await answerHook(h, 'toolu_bg', 'a1', { allow: true });
  await h.call('toolu_bg');
  await h.session.interrupt();
  assert.equal(h.port.pending().length, 1);
  h.session.close();
  assert.deepEqual(outcomes(await feed(h.session, h.controller)), ['session_closed']);
});

test('close: the settled event comes before session_closed in what pump returns', async () => {
  const h = await start();
  await h.call('toolu_open');
  await feed(h.session, h.controller);
  h.session.close();
  const events = await h.session.pump();
  const settled = events.findIndex((event) => event.type === 'client_tool_call_settled');
  const closed = events.findIndex((event) => event.type === 'session_closed');
  assert.ok(settled >= 0 && closed > settled, `settled at ${settled}, closed at ${closed}`);
});

test('a provider failure settles provider_failed; a clean provider exit settles provider_failed; a host close settles session_closed', async () => {
  const paths: Array<[(h: Harness) => void, string, string]> = [
    [(h) => h.controller.rejectNext(new Error('the CLI died')), 'provider_failed', 'provider_failed'],
    [(h) => h.controller.end(), 'provider_failed', 'provider_exited'],
    [(h) => h.session.close(), 'session_closed', 'closed_by_host'],
  ];
  for (const [end, outcome, reason] of paths) {
    const h = await start();
    const id = await h.call('toolu_open');
    end(h);
    const events = await feed(h.session, h.controller);
    assert.deepEqual(outcomes(events), [outcome]);
    assert.deepEqual(events.filter((event) => event.type === 'session_closed'), [{ type: 'session_closed', reason }]);
    await flush();
    assert.equal(h.sent.find((frame) => frame.id === id)?.result?.isError, true);
    const late = await h.call('toolu_late');
    assert.equal(h.sent.find((frame) => frame.id === late)?.result?.isError, true, 'a closed port opens nothing more');
    assert.deepEqual(outcomes(await feed(h.session, h.controller)), []);
  }
});

test('the session offers the port through clientTools(), and undefined without client_tools', async () => {
  const withTools = await start();
  assert.ok(withTools.session.clientTools());
  assert.deepEqual(Object.keys(withTools.session.clientTools()!.sdkServer()).sort(), ['instance', 'name', 'timeout', 'type']);
  const without = await start({ clientTools: undefined });
  assert.equal(without.session.clientTools(), undefined);
  withTools.session.close();
  without.session.close();
});

test('a resumed session serves the list its own config states', async () => {
  const resume = { providerSessionId: 'sess-1' };
  const first = await start({ clientTools: TOOLS, resume });
  const second = await start({ clientTools: { ...TOOLS, tools: [{ name: 'other_tool', description: 'd', inputSchemaJson: '{"type":"object"}', alwaysLoad: false }] }, resume });
  const listed = async (h: Harness): Promise<string[]> => {
    const id = await h.request('tools/list', {});
    return (h.sent.find((frame) => frame.id === id)?.result?.tools ?? []).map((tool) => tool.name);
  };
  assert.deepEqual(await listed(first), ['open_file']);
  assert.deepEqual(await listed(second), ['other_tool']);
  first.session.close();
  second.session.close();
});
