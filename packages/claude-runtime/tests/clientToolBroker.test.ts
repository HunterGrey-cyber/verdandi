import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientToolCallNotFoundError, ClientToolCallSettledError, createClientToolPort, type ClientToolFailCause } from '../src/clientToolBroker.js';
import { CLIENT_TOOL_LIMITS, type ClientTools } from '../src/clientTools.js';
import type { ClaudeRuntimeEvent, ClientToolCallEvent, ClientToolCallOutcome } from '../src/types.js';

type Frame = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'object',
      properties: { path: { type: 'string', description: 'absolute path' }, range: { type: 'object', properties: { start: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
      required: ['path'],
      additionalProperties: false,
    },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
  additionalProperties: false,
};

const TOOLS: ClientTools = {
  serverName: 'eitri',
  timeoutMs: 5000,
  tools: [
    { name: 'open_file', description: 'Shows a file', inputSchemaJson: JSON.stringify(NESTED_SCHEMA), alwaysLoad: true },
    { name: 'read_buffer', description: 'Reads a buffer', inputSchemaJson: '{"type":"object"}', alwaysLoad: false },
  ],
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A port whose server is connected to a transport the test writes JSON-RPC frames into. */
async function connected(options: { clientTools?: ClientTools; now?: () => number } = {}) {
  const events: ClaudeRuntimeEvent[] = [];
  const port = createClientToolPort(options.clientTools ?? TOOLS, (event) => events.push(event), options.now === undefined ? undefined : { now: options.now });
  const sent: Frame[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    sent,
    async start(): Promise<void> {},
    async send(message: Frame): Promise<void> {
      sent.push(message);
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  };
  await (port.sdkServer().instance as unknown as { connect(transport: unknown): Promise<void> }).connect(transport);
  let nextId = 1;
  const request = async (method: string, params?: unknown): Promise<number> => {
    const id = nextId++;
    transport.onmessage!({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    await flush();
    return id;
  };
  const call = (tool: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<number> =>
    request('tools/call', { name: tool, ...(args === undefined ? {} : { arguments: args }), ...(meta === undefined ? {} : { _meta: meta }) });
  const cancel = async (requestId: number, reason: string): Promise<void> => {
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } });
    await flush();
  };
  const replies = (id: number): Frame[] => sent.filter((frame) => frame.id === id);
  const result = (id: number): ToolResult => {
    const [reply, ...more] = replies(id);
    assert.equal(more.length, 0, 'one response per request');
    assert.ok(reply?.result, `request ${id} has a result`);
    return reply.result as unknown as ToolResult;
  };
  const calls = (): ClientToolCallEvent[] => events.filter((event): event is ClientToolCallEvent => event.type === 'client_tool_call');
  const settled = () => events.filter((event) => event.type === 'client_tool_call_settled');
  return { port, events, sent, transport, request, call, cancel, replies, result, calls, settled };
}

const toolUse = (id: unknown): Record<string, unknown> => ({ 'claudecode/toolUseId': id });

test('initialize answers the tools capability, and an unknown request such as server/discover answers -32601 with its id', async () => {
  const h = await connected();
  const init = await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } });
  const [reply] = h.replies(init);
  assert.deepEqual((reply.result as { capabilities: unknown }).capabilities, { tools: {} });
  const discover = await h.request('server/discover', {});
  assert.equal(h.replies(discover)[0].error?.code, -32601);
});

test('tools/list serves each schema as declared, with alwaysLoad only on the tools that ask', async () => {
  const h = await connected();
  const id = await h.request('tools/list', {});
  const { tools } = h.replies(id)[0].result as { tools: Array<Record<string, unknown>> };
  assert.deepEqual(tools, [
    { name: 'open_file', description: 'Shows a file', inputSchema: NESTED_SCHEMA, _meta: { 'anthropic/alwaysLoad': true } },
    { name: 'read_buffer', description: 'Reads a buffer', inputSchema: { type: 'object' } },
  ]);
});

test('a tools/call emits client_tool_call with a fresh id, the tool_use_id from _meta and the arguments as JSON text', async () => {
  const h = await connected();
  await h.call('open_file', { target: { path: '/a' } }, toolUse('toolu_1'));
  await h.call('open_file', { mode: 'b' }, toolUse('toolu_2'));
  const [first, second] = h.calls();
  assert.deepEqual({ ...first, callId: '' }, { type: 'client_tool_call', callId: '', toolUseId: 'toolu_1', tool: 'open_file', argumentsJson: '{"target":{"path":"/a"}}' });
  assert.deepEqual({ ...second, callId: '' }, { type: 'client_tool_call', callId: '', toolUseId: 'toolu_2', tool: 'open_file', argumentsJson: '{"mode":"b"}' });
  assert.notEqual(first.callId, second.callId);
  assert.match(first.callId, /^[0-9a-f-]{36}$/, 'random, so no caller can guess another call');
});

test('a tools/call with no _meta, or a _meta id that is not a string, has an empty tool_use_id', async () => {
  const h = await connected();
  await h.call('read_buffer', {});
  await h.call('read_buffer', {}, toolUse(7));
  assert.deepEqual(h.calls().map((call) => call.toolUseId), ['', '']);
});

test('a tools/call with no arguments has arguments_json "{}"', async () => {
  const h = await connected();
  await h.call('read_buffer');
  assert.equal(h.calls()[0].argumentsJson, '{}');
});

test('arguments the schema forbids pass through unchanged', async () => {
  const h = await connected();
  await h.call('open_file', { bogus: 1 });
  assert.equal(h.calls()[0].argumentsJson, '{"bogus":1}', 'the host, which knows what the tool means, validates');
});

test('a tools/call of an undeclared tool answers an error result and emits nothing', async () => {
  const h = await connected();
  const id = await h.call('not_declared', {});
  assert.equal(h.result(id).isError, true);
  assert.match(h.result(id).content[0].text, /not_declared/);
  assert.deepEqual(h.events, []);
});

test('arguments over 1 MiB answer an error result and emit nothing, and exactly 1 MiB passes', async () => {
  const h = await connected();
  const envelope = Buffer.byteLength(JSON.stringify({ text: '' }));
  const exact = await h.call('read_buffer', { text: 'x'.repeat(CLIENT_TOOL_LIMITS.argumentsBytes - envelope) });
  assert.equal(h.replies(exact).length, 0, 'still open');
  assert.equal(h.calls().length, 1);
  const over = await h.call('read_buffer', { text: 'x'.repeat(CLIENT_TOOL_LIMITS.argumentsBytes - envelope + 1) });
  assert.equal(h.result(over).isError, true);
  assert.match(h.result(over).content[0].text, /1048576/);
  // UTF-8 bytes, which is what the event costs on the wire: this many characters would fit.
  const wide = await h.call('read_buffer', { text: 'é'.repeat(CLIENT_TOOL_LIMITS.argumentsBytes / 2 + 1) });
  assert.equal(h.result(wide).isError, true);
  assert.equal(h.calls().length, 1);
});

test('a tool_use_id over 128 bytes answers an error result and emits nothing, and exactly 128 passes', async () => {
  const h = await connected();
  const longest = 'x'.repeat(CLIENT_TOOL_LIMITS.toolUseIdBytes);
  const exact = await h.call('read_buffer', {}, toolUse(longest));
  assert.equal(h.replies(exact).length, 0, 'still open');
  assert.equal(h.calls()[0].toolUseId, longest, 'never cut: a cut id would match no tool_use the host saw');
  const over = await h.call('read_buffer', {}, toolUse(`${longest}x`));
  assert.equal(h.result(over).isError, true);
  assert.match(h.result(over).content[0].text, /128/);
  // UTF-8 bytes, which is what the snapshot costs on the wire: this many characters would fit.
  const wide = await h.call('read_buffer', {}, toolUse('é'.repeat(CLIENT_TOOL_LIMITS.toolUseIdBytes / 2 + 1)));
  assert.equal(h.result(wide).isError, true);
  assert.equal(h.calls().length, 1);
  assert.equal(h.port.pending().length, 1);
});

test('a 65th open call answers an error result and emits nothing, and settling one makes room', async () => {
  const h = await connected();
  for (let index = 0; index < CLIENT_TOOL_LIMITS.liveCalls; index += 1) {
    await h.call('read_buffer', {});
  }
  assert.equal(h.port.pending().length, CLIENT_TOOL_LIMITS.liveCalls);
  const refused = await h.call('read_buffer', {});
  assert.equal(h.result(refused).isError, true);
  assert.match(h.result(refused).content[0].text, /64/);
  assert.equal(h.calls().length, CLIENT_TOOL_LIMITS.liveCalls);
  h.port.answer(h.calls()[0].callId, { content: [], isError: false });
  const next = await h.call('read_buffer', {});
  assert.equal(h.replies(next).length, 0);
  assert.equal(h.calls().length, CLIENT_TOOL_LIMITS.liveCalls + 1);
});

test('a signal already aborted on entry emits nothing and leaves nothing open', async () => {
  const h = await connected();
  const handlers = (h.port.sdkServer().instance as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResult>> })._requestHandlers;
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  const result = await handlers.get('tools/call')!({ method: 'tools/call', params: { name: 'read_buffer', arguments: {} } }, { signal: controller.signal });
  assert.equal(result.isError, true);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.port.pending(), []);
});

test('answer sends one result under the request\'s id, with isError only when set, and emits answered', async () => {
  const h = await connected();
  const plain = await h.call('read_buffer', {});
  const failed = await h.call('read_buffer', {});
  const [first, second] = h.calls();
  const settled = h.port.answer(first.callId, { content: [{ type: 'text', text: 'done' }], isError: false });
  assert.deepEqual(settled, { type: 'client_tool_call_settled', callId: first.callId, outcome: 'answered' });
  h.port.answer(second.callId, { content: [{ type: 'text', text: 'broke' }], isError: true });
  await flush();
  assert.deepEqual(h.result(plain), { content: [{ type: 'text', text: 'done' }] });
  assert.deepEqual(h.result(failed), { content: [{ type: 'text', text: 'broke' }], isError: true });
  assert.deepEqual(h.settled().map((event) => event.type === 'client_tool_call_settled' && event.outcome), ['answered', 'answered']);
});

test('a second answer throws ClientToolCallSettledError(answered), sends nothing and emits nothing', async () => {
  const h = await connected();
  const id = await h.call('read_buffer', {});
  const { callId } = h.calls()[0];
  h.port.answer(callId, { content: [{ type: 'text', text: 'first' }], isError: false });
  await flush();
  assert.throws(
    () => h.port.answer(callId, { content: [{ type: 'text', text: 'second' }], isError: false }),
    (error: unknown) => error instanceof ClientToolCallSettledError && error.callId === callId && error.outcome === 'answered',
  );
  await flush();
  assert.equal(h.replies(id).length, 1);
  assert.equal(h.settled().length, 1);
});

test('an unknown call id throws ClientToolCallNotFoundError and changes nothing', async () => {
  const h = await connected();
  await h.call('read_buffer', {});
  assert.throws(
    () => h.port.answer('no-such-call', { content: [], isError: false }),
    (error: unknown) => error instanceof ClientToolCallNotFoundError && error.callId === 'no-such-call',
  );
  assert.equal(h.port.pending().length, 1);
  assert.equal(h.settled().length, 0);
});

const CAUSE_TEXT: Array<[ClientToolFailCause, string]> = [
  ['interrupted', 'The host did not answer this tool call: the turn was interrupted.'],
  ['session_closed', 'The host did not answer this tool call: the session closed.'],
  ['provider_failed', 'The host did not answer this tool call: the provider failed.'],
];

for (const [cause, text] of CAUSE_TEXT) {
  test(`failAll settles each open call once with an error result, and a late cancel or answer finds it settled: ${cause}`, async () => {
    const h = await connected();
    const first = await h.call('read_buffer', {});
    const second = await h.call('read_buffer', {});
    const [{ callId }] = h.calls();
    h.port.failAll(cause);
    await flush();
    for (const id of [first, second]) {
      assert.deepEqual(h.result(id), { content: [{ type: 'text', text }], isError: true });
    }
    await h.cancel(first, 'too late');
    h.port.failAll(cause);
    assert.throws(
      () => h.port.answer(callId, { content: [], isError: false }),
      (error: unknown) => error instanceof ClientToolCallSettledError && error.outcome === cause,
    );
    await flush();
    assert.deepEqual(h.settled().map((event) => event.type === 'client_tool_call_settled' && event.outcome), [cause, cause]);
    assert.equal(h.replies(first).length, 1);
  });
}

test('failAll(\'interrupted\') leaves the port open; session_closed and provider_failed close it, and a later tools/call answers an error and emits nothing', async () => {
  const interrupted = await connected();
  interrupted.port.failAll('interrupted');
  await interrupted.call('read_buffer', {});
  assert.equal(interrupted.calls().length, 1);
  for (const cause of ['session_closed', 'provider_failed'] as const) {
    const h = await connected();
    h.port.failAll(cause);
    const id = await h.call('read_buffer', {});
    assert.equal(h.result(id).isError, true);
    assert.deepEqual(h.events, []);
  }
});

// Both reasons a real abort has been seen with, at both kinds of elapsed time: the label comes from the
// clock alone, because the words are other programs'.
for (const reason of ['SdkError: Request timed out', 'AbortError: remote-cancel']) {
  const rows: Array<[number, number, ClientToolCallOutcome]> = [
    [5000, 3999, 'withdrawn'],
    [5000, 4000, 'timed_out'],
    [1000, 499, 'withdrawn'],
    [1000, 500, 'timed_out'],
    [1000, 1000, 'timed_out'],
  ];
  for (const [timeoutMs, elapsed, outcome] of rows) {
    test(`notifications/cancelled before the limit settles withdrawn and sends nothing; at the limit, timed_out: ${timeoutMs} ms, after ${elapsed}, ${reason}`, async () => {
      let clock = 100;
      const h = await connected({ clientTools: { ...TOOLS, timeoutMs }, now: () => clock });
      const id = await h.call('read_buffer', {});
      clock += elapsed;
      await h.cancel(id, reason);
      assert.deepEqual(h.settled(), [{ type: 'client_tool_call_settled', callId: h.calls()[0].callId, outcome }]);
      assert.deepEqual(h.port.pending(), []);
      assert.equal(h.replies(id).length, 0, 'an aborted request gets no response');
    });
  }
}

test('a late answer after the signal aborted is ClientToolCallSettledError with that outcome, and sends nothing', async () => {
  let clock = 0;
  const h = await connected({ now: () => clock });
  const id = await h.call('read_buffer', {});
  clock = 5000;
  await h.cancel(id, 'AbortError: remote-cancel');
  assert.throws(
    () => h.port.answer(h.calls()[0].callId, { content: [{ type: 'text', text: 'late' }], isError: false }),
    (error: unknown) => error instanceof ClientToolCallSettledError && error.outcome === 'timed_out',
  );
  await flush();
  assert.equal(h.replies(id).length, 0);
  assert.equal(h.settled().length, 1);
});

test('a closed transport aborts the open call: it settles once, and a later failAll finds nothing', async () => {
  const h = await connected();
  await h.call('read_buffer', {});
  await h.transport.close();
  await flush();
  assert.equal(h.settled().length, 1);
  assert.deepEqual(h.port.pending(), []);
  h.port.failAll('provider_failed');
  assert.equal(h.settled().length, 1);
});

test('pending lists open calls oldest first, and a settled call leaves it', async () => {
  const h = await connected();
  await h.call('read_buffer', {}, toolUse('toolu_1'));
  await h.call('open_file', {}, toolUse('toolu_2'));
  await h.call('read_buffer', {}, toolUse('toolu_3'));
  const [first, second, third] = h.calls();
  assert.deepEqual(h.port.pending(), [first, second, third]);
  h.port.answer(second.callId, { content: [], isError: false });
  assert.deepEqual(h.port.pending(), [first, third]);
});

test('the settled history is bounded: the oldest id reads as not found', async () => {
  const h = await connected();
  for (let index = 0; index <= CLIENT_TOOL_LIMITS.settledHistory; index += 1) {
    await h.call('read_buffer', {});
    h.port.answer(h.calls()[index].callId, { content: [], isError: false });
  }
  const answer = { content: [], isError: false };
  assert.throws(() => h.port.answer(h.calls()[0].callId, answer), ClientToolCallNotFoundError);
  assert.throws(() => h.port.answer(h.calls()[1].callId, answer), ClientToolCallSettledError);
});

test('noteAgent ignores another server\'s tool, an empty id and a missing agent, and its record is bounded', async () => {
  const h = await connected();
  const spares = (): boolean => true;
  h.port.noteAgent('mcp__other__open_file', 'toolu_other', 'a1');
  h.port.noteAgent('Bash', 'toolu_bash', 'a1');
  h.port.noteAgent('mcp__eitri__open_file', '', 'a1');
  h.port.noteAgent('mcp__eitri__open_file', 'toolu_main', undefined);
  await h.call('open_file', {}, toolUse('toolu_other'));
  await h.call('open_file', {}, toolUse('toolu_bash'));
  await h.call('open_file', {});
  await h.call('open_file', {}, toolUse('toolu_main'));
  h.port.failAll('interrupted', spares);
  assert.deepEqual(h.port.pending(), [], 'none of them has an agent, so none is spared');

  const history = CLIENT_TOOL_LIMITS.settledHistory;
  for (let index = 0; index <= history; index += 1) {
    h.port.noteAgent('mcp__eitri__open_file', `toolu_${index}`, 'a1');
  }
  await h.call('open_file', {}, toolUse('toolu_0'));
  await h.call('open_file', {}, toolUse('toolu_1'));
  h.port.failAll('interrupted', spares);
  assert.deepEqual(h.port.pending().map((call) => call.toolUseId), ['toolu_1'], 'the oldest record aged out');
});

test('failAll with spares leaves a noted agent\'s call open, and settles a call with no agent', async () => {
  const h = await connected();
  h.port.noteAgent('mcp__eitri__open_file', 'toolu_bg', 'a1');
  h.port.noteAgent('mcp__eitri__open_file', 'toolu_fg', 'a2');
  await h.call('open_file', {}, toolUse('toolu_bg'));
  await h.call('open_file', {}, toolUse('toolu_fg'));
  await h.call('open_file', {}, toolUse('toolu_main'));
  h.port.failAll('interrupted', (agentId) => agentId === 'a1');
  assert.deepEqual(h.port.pending().map((call) => call.toolUseId), ['toolu_bg']);
  assert.equal(h.settled().length, 2);
  h.port.failAll('interrupted');
  assert.deepEqual(h.port.pending(), [], 'without spares nothing is left');
});
