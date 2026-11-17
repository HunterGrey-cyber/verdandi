import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ClientTools } from '../src/clientTools.js';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';

const stub = fileURLToPath(new URL('../../tests/fixtures/mcpControlStub.mjs', import.meta.url));

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'host_cli' };
const SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const TOOLS: ClientTools = {
  serverName: 'eitri',
  timeoutMs: 900000,
  tools: [{ name: 'open_file', description: 'Open a file in the editor', inputSchemaJson: JSON.stringify(SCHEMA), alwaysLoad: true }],
};

type Frame = Record<string, any>;

/** The frames the stub has written so far, in order; the first entry is its own argv. */
async function readCapture(path: string): Promise<Frame[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line !== '').flatMap((line) => {
    try {
      return [JSON.parse(line) as Frame];
    } catch {
      // A line still being appended.
      return [];
    }
  });
}

async function waitFor<T>(what: string, find: () => Promise<T | undefined>, diagnostics: () => string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (true) {
    const found = await find();
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, `${what} never arrived; ${diagnostics()}`);
    await delay(20);
  }
}

/** The JSON-RPC answer the SDK sent the stub for the frame the stub numbered `n` (`stub-<n>`). */
const rpcAnswer = (frames: Frame[], n: number): Frame | undefined =>
  frames.find((frame) => frame.type === 'control_response' && frame.response?.request_id === `stub-${n}`)?.response?.response?.mcp_response;

/** A real session over the real SDK, whose CLI is the stub; the test acts while the stub's frames flow. */
async function withStub(body: (h: {
  session: ReturnType<typeof createSession>;
  capturePath: string;
  capture: () => Promise<Frame[]>;
  answerOf: (n: number) => Promise<Frame>;
  pumpUntil: (done: (events: ClaudeRuntimeEvent[]) => boolean) => Promise<ClaudeRuntimeEvent[]>;
}) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'verdandi-mcp-control-'));
  const capturePath = join(scratch, 'capture.jsonl');
  const saved = { capture: process.env.VERDANDI_TEST_MCP_CAPTURE, server: process.env.VERDANDI_TEST_MCP_SERVER };
  process.env.VERDANDI_TEST_MCP_CAPTURE = capturePath;
  process.env.VERDANDI_TEST_MCP_SERVER = TOOLS.serverName;
  const diagnostics: string[] = [];
  let session: ReturnType<typeof createSession> | undefined;
  try {
    session = createSession(
      { cwd: scratch, policy: POLICY, hostCliPath: stub, clientTools: TOOLS },
      undefined,
      { onDiagnostic: (line) => diagnostics.push(line) },
    );
    const live = session;
    const capture = () => readCapture(capturePath);
    const why = () => `diagnostics: ${diagnostics.join(' | ') || 'none'}`;
    await body({
      session: live,
      capturePath,
      capture,
      answerOf: (n) => waitFor(`the SDK's answer to stub frame ${n}`, async () => rpcAnswer(await capture(), n), why),
      pumpUntil: async (done) => {
        const seen: ClaudeRuntimeEvent[] = [];
        return waitFor('the awaited event', async () => {
          seen.push(...(await live.pump()));
          return done(seen) ? seen : undefined;
        }, why);
      },
    });
  } finally {
    session?.close();
    // Let the SDK end the child before the scratch directory goes.
    await delay(200);
    for (const [key, value] of [['VERDANDI_TEST_MCP_CAPTURE', saved.capture], ['VERDANDI_TEST_MCP_SERVER', saved.server]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

test('the SDK connects the server: initialize names it in sdkMcpServers with its timeout in sdkMcpServerConfigs', { timeout: 30_000 }, async () => {
  await withStub(async ({ capture, answerOf }) => {
    // The stub only speaks to a server the SDK registered; an answer to its initialize proves the
    // SDK called connect on the instance it was handed.
    const init = await answerOf(2);
    assert.equal(init.result?.serverInfo?.name, 'eitri');
    const request = (await capture()).find((frame) => frame.type === 'control_request' && frame.request?.subtype === 'initialize')?.request;
    assert.ok(request, 'the SDK sent an initialize control request');
    assert.deepEqual(request.sdkMcpServers, ['eitri']);
    assert.deepEqual(request.sdkMcpServerConfigs, { eitri: { timeout: 900000 } });
  });
});

test('server/discover gets -32601 and the SDK does not hang', { timeout: 30_000 }, async () => {
  await withStub(async ({ answerOf }) => {
    const discover = await answerOf(1);
    assert.equal(discover.error?.code, -32601);
    // The frames after it arrive: the initialize answer exists.
    assert.ok((await answerOf(2)).result, 'initialize was answered after the discover refusal');
  });
});

test('tools/list reaches the CLI with the declared schema and the always-load mark', { timeout: 30_000 }, async () => {
  await withStub(async ({ answerOf }) => {
    const listed = await answerOf(4);
    assert.equal(listed.id, 3);
    assert.deepEqual(listed.result.tools, [
      {
        name: 'open_file',
        description: 'Open a file in the editor',
        inputSchema: SCHEMA,
        _meta: { 'anthropic/alwaysLoad': true },
      },
    ]);
  });
});

test('a tools/call reaches the host as client_tool_call with its tool_use_id, and the answer reaches the CLI', { timeout: 30_000 }, async () => {
  await withStub(async ({ session, capture, pumpUntil }) => {
    const events = await pumpUntil((seen) => seen.some((event) => event.type === 'client_tool_call'));
    const call = events.find((event) => event.type === 'client_tool_call');
    assert.ok(call && call.type === 'client_tool_call');
    assert.equal(call.toolUseId, 'toolu_stub1');
    assert.equal(call.tool, 'open_file');
    assert.deepEqual(JSON.parse(call.argumentsJson), {});
    const port = session.clientTools()!;
    assert.equal(port.pending().length, 1);
    const settled = port.answer(call.callId, { content: [{ type: 'text', text: 'opened' }], isError: false });
    assert.equal(settled.outcome, 'answered');
    const result = await waitFor('the tools/call result', async () => rpcAnswer(await capture(), 5), () => 'no answer to stub frame 5');
    assert.equal(result.id, 4);
    assert.deepEqual(result.result.content, [{ type: 'text', text: 'opened' }]);
    assert.notEqual(result.result.isError, true);
  });
});

test('no argv of the CLI carries the server', { timeout: 30_000 }, async () => {
  await withStub(async ({ capture, answerOf }) => {
    await answerOf(2);
    const argv: string[] = (await capture())[0].argv;
    assert.ok(Array.isArray(argv), 'the stub recorded its argv first');
    const at = argv.indexOf('--mcp-config');
    if (at !== -1) {
      assert.ok(!argv.slice(at + 1).join(' ').includes(TOOLS.serverName), `--mcp-config names the server: ${argv.join(' ')}`);
    }
    assert.ok(!argv.some((arg) => arg.includes('"eitri"')), `an argument carries the server: ${argv.join(' ')}`);
  });
});

test('closing the session with a call open settles it, and the stub sees stdin end', { timeout: 30_000 }, async () => {
  await withStub(async ({ session, capture, pumpUntil }) => {
    const events = await pumpUntil((seen) => seen.some((event) => event.type === 'client_tool_call'));
    const call = events.find((event) => event.type === 'client_tool_call');
    assert.ok(call && call.type === 'client_tool_call');
    session.close();
    const after = await pumpUntil((seen) => seen.some((event) => event.type === 'client_tool_call_settled'));
    const settled = after.find((event) => event.type === 'client_tool_call_settled');
    assert.ok(settled && settled.type === 'client_tool_call_settled');
    assert.equal(settled.callId, call.callId);
    assert.equal(settled.outcome, 'session_closed');
    assert.equal(session.clientTools()!.pending().length, 0);
    await waitFor('the end of the stub\'s stdin', async () => ((await capture()).some((frame) => frame.stdin === 'end') ? true : undefined), () => 'stdin never ended');
  });
});
