import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientToolCallSettledError } from '../src/clientToolBroker.js';
import type { ClientToolDeclaration, ClientTools } from '../src/clientTools.js';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';

/**
 * The pinned CLI against Verdandi's own client-tools path, answered by a scripted model on 127.0.0.1.
 * These tests run only inside `fixtures/scriptedCliSandbox.sh`, which gives them no network, no
 * account and a private home, and sets VERDANDI_SCRIPTED_CLI (the binary under test) and
 * VERDANDI_SCRIPTED_RUN (the run directory). Without them every test here is skipped, as the
 * real-account files are. With them, a guard fails the run, never skips it, when the process is not
 * where the script puts it: a real CLI never starts outside that sandbox.
 */
const CLI = process.env.VERDANDI_SCRIPTED_CLI;
const RUN = process.env.VERDANDI_SCRIPTED_RUN ?? '';
const SCRIPTED = CLI !== undefined;
const MODEL_PORT = 4141;
const LOG_DIR = join(RUN, 'log');
const REQUEST_LOG = join(LOG_DIR, 'model-requests.jsonl');
const MODEL_SCRIPT = fileURLToPath(new URL('../../tests/fixtures/scriptedModel.mjs', import.meta.url));

function assertSandbox(): void {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'the process sees a network beyond loopback: it is not in the sandbox');
  assert.ok(RUN !== '' && (process.env.HOME ?? '').startsWith(`${RUN}/`), `HOME ${process.env.HOME} is not under the run directory ${RUN}`);
  assert.match(process.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'ANTHROPIC_BASE_URL does not point at 127.0.0.1');
}

let model: ChildProcess | undefined;

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await sleep(50);
  }
  throw new Error(`the scripted model did not listen on ${port}`);
}

before(async () => {
  if (!SCRIPTED) return;
  assertSandbox();
  mkdirSync(LOG_DIR, { recursive: true });
  model = spawn(process.execPath, [MODEL_SCRIPT, String(MODEL_PORT), LOG_DIR], { stdio: 'inherit' });
  await waitForPort(MODEL_PORT);
});

after(() => {
  model?.kill();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ModelRecord = {
  path: string;
  reply?: { kind: 'text'; text: string } | { kind: 'tool'; id: string; name: string; input: unknown };
  body?: { tools?: Array<{ name: string; input_schema?: unknown }>; messages?: Array<{ role: string; content: unknown }> };
};

function modelRequests(): ModelRecord[] {
  if (!existsSync(REQUEST_LOG)) return [];
  return readFileSync(REQUEST_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ModelRecord);
}

/** The requests that carry the conversation (the model is offered `Read`), as opposed to titles and side queries. */
const conversation = (records: ModelRecord[]): ModelRecord[] =>
  records.filter((record) => record.path.split('?')[0].endsWith('/v1/messages') && (record.body?.tools ?? []).some((tool) => tool.name === 'Read'));

/** The `tool_result` blocks the model was handed back, in order, from the conversation requests among `records`. */
function toolResults(records: ModelRecord[]): Array<{ toolUseId: string; isError: boolean | undefined; text: string }> {
  const found: Array<{ toolUseId: string; isError: boolean | undefined; text: string }> = [];
  for (const record of conversation(records)) {
    const messages = record.body?.messages ?? [];
    const last = [...messages].reverse().find((message) => message.role === 'user');
    if (last === undefined || !Array.isArray(last.content)) continue;
    for (const block of last.content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
      if (block.type !== 'tool_result' || !String(block.tool_use_id).startsWith('toolu_pc_')) continue;
      const content = Array.isArray(block.content) ? block.content.map((part: { text?: string }) => part.text ?? '').join(' ') : String(block.content);
      found.push({ toolUseId: String(block.tool_use_id), isError: block.is_error, text: content });
    }
  }
  return found;
}

const SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, count: { type: 'integer' } },
  required: ['text'],
  additionalProperties: false,
};

const declaration = (name: string, alwaysLoad: boolean): ClientToolDeclaration => ({
  name,
  description: `A scripted-model probe tool, ${name}.`,
  inputSchemaJson: JSON.stringify(SCHEMA),
  alwaysLoad,
});

const LOADED = declaration('probe_loaded', true);
const DEFERRED = declaration('probe_deferred', false);
const SERVER = 'eitri';
const LOADED_TOOL = `mcp__${SERVER}__probe_loaded`;
const DEFERRED_TOOL = `mcp__${SERVER}__probe_deferred`;

const clientTools = (timeoutMs = 900_000, tools: ClientToolDeclaration[] = [LOADED, DEFERRED]): ClientTools => ({ serverName: SERVER, timeoutMs, tools });

const POLICY: ClaudeHostPolicy = {
  configuration: 'native',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
  settingSources: [],
};

type Session = ReturnType<typeof createSession>;

let projectCount = 0;
function freshProject(): string {
  mkdirSync(join(RUN, 'project'), { recursive: true });
  projectCount += 1;
  return mkdtempSync(join(RUN, 'project', `t${projectCount}-`));
}

function open(options: { policy?: Partial<ClaudeHostPolicy>; tools?: ClientTools; cwd?: string; resume?: string } = {}): Session {
  assert.ok(CLI !== undefined);
  return createSession({
    cwd: options.cwd ?? freshProject(),
    policy: { ...POLICY, ...options.policy },
    hostCliPath: CLI,
    clientTools: options.tools ?? clientTools(),
    ...(options.resume === undefined ? {} : { resume: { providerSessionId: options.resume } }),
  });
}

/** Pumps `session` until `done` holds over everything seen so far; `onEvent` sees each event once, as it arrives. */
async function drive(
  session: Session,
  events: ClaudeRuntimeEvent[],
  done: (events: ClaudeRuntimeEvent[]) => boolean,
  options: { ms?: number; onEvent?: (event: ClaudeRuntimeEvent) => void } = {},
): Promise<void> {
  const deadline = Date.now() + (options.ms ?? 100_000);
  while (!done(events)) {
    assert.ok(Date.now() < deadline, `not reached in time; events so far: ${events.map((event) => event.type).join(', ')}`);
    for (const event of await session.pump()) {
      events.push(event);
      options.onEvent?.(event);
    }
    await sleep(50);
  }
}

const turnDone = (events: ClaudeRuntimeEvent[]): boolean => events.some((event) => event.type === 'turn_completed');
const calls = (events: ClaudeRuntimeEvent[]) => events.flatMap((event) => (event.type === 'client_tool_call' ? [event] : []));
const settled = (events: ClaudeRuntimeEvent[]) => events.flatMap((event) => (event.type === 'client_tool_call_settled' ? [event] : []));
const requests = (events: ClaudeRuntimeEvent[]) => events.flatMap((event) => (event.type === 'permission_requested' ? [event] : []));

/** The gate's own request for each call is the host's to allow; everything else is left for the test. */
const allowHook = (session: Session) => (event: ClaudeRuntimeEvent) => {
  if (event.type === 'permission_requested' && event.origin === 'hook') {
    assert.equal(session.resolvePermission(event.permissionId, { allow: true }), true);
  }
};

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

let tag = 0;
/** A turn whose model reply is one call of `tool`. The tag makes the call's id unique to the turn. */
function callTurn(session: Session, tool: string, args: unknown): void {
  tag += 1;
  session.sendTurn(`PROBE-CALL ${tool} ${JSON.stringify(args)}\nturn ${tag}`);
}

function readyOf(events: ClaudeRuntimeEvent[]) {
  const ready = events.find((event) => event.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready', 'no session_ready');
  assert.ok(ready.initFingerprint, 'system/init carried no tools list');
  return { ready, init: ready.initFingerprint };
}

/** One plain turn with the default session, shared by the tests that only read system/init and the first request. */
let firstTurn: Promise<{ events: ClaudeRuntimeEvent[]; records: ModelRecord[] }> | undefined;
function plainTurn(): Promise<{ events: ClaudeRuntimeEvent[]; records: ModelRecord[] }> {
  firstTurn ??= (async () => {
    const mark = modelRequests().length;
    const session = open();
    const events: ClaudeRuntimeEvent[] = [];
    try {
      session.sendTurn('hello');
      await drive(session, events, turnDone);
    } finally {
      session.close();
    }
    return { events, records: modelRequests().slice(mark) };
  })();
  return firstTurn;
}

const TEST = { skip: !SCRIPTED, timeout: 150_000 };

test('the CLI accepts the server: system/init lists one eitri, connected, with source sdk, and its tools', TEST, async () => {
  const { events } = await plainTurn();
  const { init } = readyOf(events);
  assert.deepEqual(
    init.mcpServers.filter((server) => server.name === SERVER).map(({ name, status, source }) => ({ name, status, source })),
    [{ name: SERVER, status: 'connected', source: 'sdk' }],
  );
  assert.equal(init.mcpServers.length, 1, `no other server: ${JSON.stringify(init.mcpServers)}`);
  assert.ok(init.tools.includes(LOADED_TOOL), `${LOADED_TOOL} missing from ${JSON.stringify(init.tools)}`);
  assert.ok(init.tools.includes(DEFERRED_TOOL), `${DEFERRED_TOOL} missing from ${JSON.stringify(init.tools)}`);
});

test('alwaysLoad: probe_loaded is in the first request\'s tools and probe_deferred stays deferred', TEST, async () => {
  const { records } = await plainTurn();
  const first = conversation(records)[0];
  assert.ok(first, 'the model saw no conversation request');
  const names = (first.body?.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes(LOADED_TOOL), `${LOADED_TOOL} is not in the first request: ${JSON.stringify(names)}`);
  assert.ok(!names.includes(DEFERRED_TOOL), `${DEFERRED_TOOL} was offered up front: ${JSON.stringify(names)}`);
});

test('the schema reaches the model as declared', TEST, async () => {
  const { records } = await plainTurn();
  const tool = (conversation(records)[0]?.body?.tools ?? []).find((entry) => entry.name === LOADED_TOOL);
  assert.ok(tool, `${LOADED_TOOL} is not in the first request`);
  assert.deepEqual(tool.input_schema, SCHEMA);
});

test('a call reaches the host with the model\'s tool_use_id, after the host allowed the permission request, and no provider prompt follows', TEST, async () => {
  const mark = modelRequests().length;
  const session = open({ policy: { providerPermissionPrompts: true } });
  const events: ClaudeRuntimeEvent[] = [];
  const port = session.clientTools();
  assert.ok(port);
  try {
    callTurn(session, LOADED_TOOL, { text: 'hello' });
    const hook = allowHook(session);
    await drive(session, events, turnDone, {
      onEvent: (event) => {
        hook(event);
        if (event.type === 'client_tool_call') port.answer(event.callId, { ...text('the host says hi'), isError: false });
      },
    });
  } finally {
    session.close();
  }
  const asked = requests(events).filter((request) => request.toolName === LOADED_TOOL);
  assert.deepEqual(asked.map((request) => request.origin), ['hook'], 'one request for the call, from the gate, and no provider prompt');
  const [call] = calls(events);
  assert.ok(call, 'no client_tool_call');
  assert.ok(events.indexOf(asked[0]) < events.indexOf(call), 'the permission request comes before the call');
  assert.deepEqual(settled(events).map((event) => ({ callId: event.callId, outcome: event.outcome })), [{ callId: call.callId, outcome: 'answered' }]);
  assert.equal(call.tool, 'probe_loaded');
  assert.deepEqual(JSON.parse(call.argumentsJson), { text: 'hello' });
  const records = modelRequests().slice(mark);
  const chosen = records.find((record) => record.reply?.kind === 'tool');
  assert.ok(chosen?.reply?.kind === 'tool');
  assert.equal(call.toolUseId, chosen.reply.id, 'the call carries the id the model chose');
  const [result] = toolResults(records);
  assert.ok(result, 'the model was never handed a tool_result');
  assert.equal(result.toolUseId, chosen.reply.id);
  assert.ok(result.text.includes('the host says hi'), `the answer's text is not in the tool_result: ${result.text}`);
  assert.notEqual(result.isError, true);
});

test('arguments the schema forbids reach the host unchanged', TEST, async () => {
  const session = open();
  const events: ClaudeRuntimeEvent[] = [];
  const port = session.clientTools();
  assert.ok(port);
  const args = { text: 5, bogus: [1, { deep: null }], count: 'many' };
  try {
    callTurn(session, LOADED_TOOL, args);
    const hook = allowHook(session);
    await drive(session, events, turnDone, {
      onEvent: (event) => {
        hook(event);
        if (event.type === 'client_tool_call') port.answer(event.callId, { ...text('seen'), isError: false });
      },
    });
  } finally {
    session.close();
  }
  const [call] = calls(events);
  assert.ok(call, 'no client_tool_call');
  assert.deepEqual(JSON.parse(call.argumentsJson), args);
});

test('an answer with is_error reaches the model as an error', TEST, async () => {
  const mark = modelRequests().length;
  const session = open();
  const events: ClaudeRuntimeEvent[] = [];
  const port = session.clientTools();
  assert.ok(port);
  try {
    callTurn(session, LOADED_TOOL, { text: 'x' });
    const hook = allowHook(session);
    await drive(session, events, turnDone, {
      onEvent: (event) => {
        hook(event);
        if (event.type === 'client_tool_call') port.answer(event.callId, { ...text('no such file'), isError: true });
      },
    });
  } finally {
    session.close();
  }
  const [result] = toolResults(modelRequests().slice(mark));
  assert.ok(result, 'the model was never handed a tool_result');
  assert.equal(result.isError, true);
  assert.ok(result.text.includes('no such file'), result.text);
  const done = events.find((event) => event.type === 'turn_completed');
  assert.ok(done?.type === 'turn_completed' && done.resultText.startsWith('PC-DONE err=true'), `the model's reply: ${JSON.stringify(done)}`);
});

test('timeout: a call nobody answers fails to the model and settles timed_out; a late answer is ALREADY settled', TEST, async () => {
  const mark = modelRequests().length;
  const session = open({ tools: clientTools(3000) });
  const events: ClaudeRuntimeEvent[] = [];
  const port = session.clientTools();
  assert.ok(port);
  let callSeen = 0;
  try {
    callTurn(session, LOADED_TOOL, { text: 'slow' });
    const hook = allowHook(session);
    await drive(session, events, turnDone, {
      onEvent: (event) => {
        hook(event);
        if (event.type === 'client_tool_call') callSeen = Date.now();
      },
    });
    const [call] = calls(events);
    assert.ok(call, 'no client_tool_call');
    const [end] = settled(events);
    assert.ok(end, 'no client_tool_call_settled');
    assert.deepEqual({ callId: end.callId, outcome: end.outcome }, { callId: call.callId, outcome: 'timed_out' });
    assert.ok(Date.now() - callSeen < 10_000, 'the call took more than 10 s to settle after it was seen');
    const [result] = toolResults(modelRequests().slice(mark));
    assert.ok(result, 'the model was never handed a tool_result');
    assert.equal(result.isError, true);
    assert.match(result.text, /timed out after 3s/);
    assert.throws(
      () => port.answer(call.callId, { ...text('late'), isError: false }),
      (error: unknown) => error instanceof ClientToolCallSettledError && error.outcome === 'timed_out',
    );
  } finally {
    session.close();
  }
});

test('interrupt: an open call settles interrupted once, the turn ends interrupted, and a late answer is refused', TEST, async () => {
  const session = open();
  const events: ClaudeRuntimeEvent[] = [];
  const port = session.clientTools();
  assert.ok(port);
  try {
    callTurn(session, LOADED_TOOL, { text: 'wait' });
    await drive(session, events, (seen) => calls(seen).length > 0, { onEvent: allowHook(session) });
    await session.interrupt();
    await drive(session, events, turnDone, { onEvent: allowHook(session) });
    // Anything that would settle the call a second time has had time to arrive.
    await sleep(1500);
    events.push(...(await session.pump()));
    const [call] = calls(events);
    assert.deepEqual(settled(events).map((event) => ({ callId: event.callId, outcome: event.outcome })), [{ callId: call.callId, outcome: 'interrupted' }]);
    const done = events.find((event) => event.type === 'turn_completed');
    assert.ok(done?.type === 'turn_completed' && done.outcome === 'interrupted', `the turn: ${JSON.stringify(done)}`);
    assert.throws(
      () => port.answer(call.callId, { ...text('late'), isError: false }),
      (error: unknown) => error instanceof ClientToolCallSettledError && error.outcome === 'interrupted',
    );
  } finally {
    session.close();
  }
});

test('close: an open call settles session_closed before session_closed', TEST, async () => {
  const session = open();
  const events: ClaudeRuntimeEvent[] = [];
  try {
    callTurn(session, LOADED_TOOL, { text: 'wait' });
    await drive(session, events, (seen) => calls(seen).length > 0, { onEvent: allowHook(session) });
    session.close();
    await drive(session, events, (seen) => seen.some((event) => event.type === 'session_closed'));
  } finally {
    session.close();
  }
  const [call] = calls(events);
  const end = events.findIndex((event) => event.type === 'client_tool_call_settled');
  assert.ok(end >= 0, 'no client_tool_call_settled');
  const endEvent = events[end];
  assert.ok(endEvent.type === 'client_tool_call_settled' && endEvent.callId === call.callId && endEvent.outcome === 'session_closed', JSON.stringify(endEvent));
  assert.ok(end < events.findIndex((event) => event.type === 'session_closed'), 'the call settled after the session closed');
  assert.equal(settled(events).length, 1);
});

test('resume with another list: the resumed session\'s init lists the new tools', TEST, async () => {
  const cwd = freshProject();
  const first = open({ cwd, policy: { persistence: 'host_cli' }, tools: clientTools(900_000, [LOADED]) });
  const firstEvents: ClaudeRuntimeEvent[] = [];
  try {
    first.sendTurn('hello');
    await drive(first, firstEvents, turnDone);
  } finally {
    first.close();
  }
  const { ready, init } = readyOf(firstEvents);
  assert.ok(init.tools.includes(LOADED_TOOL) && !init.tools.includes(DEFERRED_TOOL), JSON.stringify(init.tools));
  const second = open({ cwd, policy: { persistence: 'host_cli' }, tools: clientTools(900_000, [LOADED, DEFERRED]), resume: ready.providerSessionId });
  const secondEvents: ClaudeRuntimeEvent[] = [];
  try {
    second.sendTurn('again');
    await drive(second, secondEvents, turnDone);
  } finally {
    second.close();
  }
  const resumed = readyOf(secondEvents);
  assert.ok(resumed.init.tools.includes(LOADED_TOOL) && resumed.init.tools.includes(DEFERRED_TOOL), JSON.stringify(resumed.init.tools));
  assert.deepEqual(
    resumed.init.mcpServers.map(({ name, status, source }) => ({ name, status, source })),
    [{ name: SERVER, status: 'connected', source: 'sdk' }],
  );
});

test('ISOLATED: strictMcpConfig keeps the server', TEST, async () => {
  const session = open({ policy: { configuration: 'isolated' } });
  const events: ClaudeRuntimeEvent[] = [];
  try {
    session.sendTurn('hello');
    await drive(session, events, turnDone);
  } finally {
    session.close();
  }
  const { init } = readyOf(events);
  assert.deepEqual(
    init.mcpServers.map(({ name, status, source }) => ({ name, status, source })),
    [{ name: SERVER, status: 'connected', source: 'sdk' }],
  );
  assert.ok(init.tools.includes(LOADED_TOOL));
});

/** A newline-delimited JSON-RPC MCP server on stdio with one tool, `stub_echo`. */
const STUB = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === '') continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result;
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'stub_echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'stub-echo' }] };
    else if (m.method === 'ping') result = {};
    const reply = result === undefined ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } } : { jsonrpc: '2.0', id: m.id, result };
    process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`;

test('a project server of the same name: one entry, source project, never sdk', TEST, async () => {
  const cwd = freshProject();
  writeFileSync(join(cwd, 'stub.cjs'), STUB);
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [join(cwd, 'stub.cjs')] } } }));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: [SERVER] }));
  const session = open({ cwd, policy: { settingSources: ['project', 'local'] } });
  const events: ClaudeRuntimeEvent[] = [];
  try {
    session.sendTurn('hello');
    await drive(session, events, turnDone);
  } finally {
    session.close();
  }
  const { init } = readyOf(events);
  assert.deepEqual(
    init.mcpServers.filter((server) => server.name === SERVER).map(({ name, status, source }) => ({ name, status, source })),
    [{ name: SERVER, status: 'connected', source: 'project' }],
    `one entry, never sdk: ${JSON.stringify(init.mcpServers)}`,
  );
  assert.ok(init.tools.includes(`mcp__${SERVER}__stub_echo`), `the project server's tool is missing: ${JSON.stringify(init.tools)}`);
  assert.ok(init.tools.includes(LOADED_TOOL), `the session's tool is missing: ${JSON.stringify(init.tools)}`);
});
