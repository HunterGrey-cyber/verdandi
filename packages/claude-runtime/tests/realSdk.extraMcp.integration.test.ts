import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.js';
import { EXTRA_MCP_SERVERS_VARIABLE, resolveExtraMcpServers } from '../src/extraMcpServers.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent } from '../src/types.js';
import { REAL, realSessionConfig } from './realConfig.js';

/**
 * the design note's test d (§6): a stub stdio server
 * from VERDANDI_CLAUDE_EXTRA_MCP_SERVERS, whose tool call produces `permission_requested` named
 * `mcp__<server>__<tool>` BEFORE the server sees it; an allow lets it run, a deny means the server never
 * sees it. Through the real CLI, because the order is the CLI's. The session is the shape a completion
 * caller with MCP servers uses -- ISOLATED, an explicit empty allow list, verified -- except that it is gated, so the same run
 * also proves the init check passes a real session with an extra server.
 *
 * Billed: runs only with RUN_REAL_CLAUDE_TESTS=1, on the account realConfig.ts pins.
 */

const SERVER = 'verdandi_stub';
const TOOL = `mcp__${SERVER}__echo`;
const MODEL = process.env.VERDANDI_REAL_TEST_MODEL?.trim() || 'haiku';

/** A newline-delimited JSON-RPC MCP server on stdio: one tool, `echo`; each call is appended to $STUB_CALLS. */
const STUB = `
const { appendFileSync } = require('node:fs');
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
    else if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text back, prefixed with stub-echo:', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    else if (m.method === 'tools/call') { appendFileSync(process.env.STUB_CALLS, JSON.stringify(m.params) + '\\n'); result = { content: [{ type: 'text', text: 'stub-echo:' + m.params.arguments.text }] }; }
    else if (m.method === 'ping') result = {};
    const reply = result === undefined ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } } : { jsonrpc: '2.0', id: m.id, result };
    process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`;

const POLICY: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'interactive',
  persistence: 'ephemeral',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};

async function runOnce(allow: boolean): Promise<{ events: ClaudeRuntimeEvent[]; callsAtRequest: boolean[]; calls: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), `claude-runtime-real-extra-mcp-${allow ? 'allow' : 'deny'}-`));
  const stubPath = join(dir, 'stub.cjs');
  const callsPath = join(dir, 'calls.jsonl');
  writeFileSync(stubPath, STUB);
  const extraMcpServers = resolveExtraMcpServers({
    [EXTRA_MCP_SERVERS_VARIABLE]: JSON.stringify({ [SERVER]: { type: 'stdio', command: process.execPath, args: [stubPath], env: { STUB_CALLS: callsPath } } }),
  });
  let session: ReturnType<typeof createSession> | undefined;
  const events: ClaudeRuntimeEvent[] = [];
  const callsAtRequest: boolean[] = [];
  try {
    session = createSession({ ...realSessionConfig(dir, POLICY), model: MODEL, extraMcpServers });
    session.sendTurn(`Call the tool ${TOOL} once with text "d", then reply with exactly what it returned.`);
    const deadline = Date.now() + 120_000;
    let done = false;
    while (Date.now() < deadline && !done) {
      for (const event of await session.pump()) {
        events.push(event);
        if (event.type === 'permission_requested') {
          // The order under test: the server has not been called when the host is asked.
          callsAtRequest.push(existsSync(callsPath));
          const ours = event.toolName === TOOL;
          session.resolvePermission(event.permissionId, ours && !allow ? { allow: false, reason: 'verdandi test: denied' } : { allow: true });
        }
        if (event.type === 'turn_completed' || event.type === 'session_closed') {
          done = true;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(done, 'no turn_completed within 120s');
    const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { events, callsAtRequest, calls };
  } finally {
    session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function requested(events: ClaudeRuntimeEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'permission_requested' ? [event.toolName] : []));
}

test('real SDK, design-note test d (allow): an extra server\'s tool is asked about as mcp__<server>__<tool> before it runs, and runs after an allow', { skip: !REAL }, async () => {
  const { events, callsAtRequest, calls } = await runOnce(true);
  const ready = events.find((event) => event.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual(ready.initFingerprint?.mcpServers, [{ name: SERVER, status: 'connected' }], 'the verified session saw exactly the extra server, connected');
  assert.equal(events.some((event) => event.type === 'session_closed'), false, `the init check closed a session it should pass: ${JSON.stringify(ready.initFingerprint)}`);
  assert.ok(requested(events).includes(TOOL), `no permission_requested for ${TOOL}: ${JSON.stringify(requested(events))}`);
  assert.ok(callsAtRequest.every((called) => !called), 'the server was called before the host was asked');
  assert.equal(calls.length, 1, 'the allowed call reached the server once');
});

test('real SDK, design-note test d (deny): a denied extra-server tool call never reaches the server', { skip: !REAL }, async () => {
  const { events, calls } = await runOnce(false);
  assert.ok(requested(events).includes(TOOL), `no permission_requested for ${TOOL}: ${JSON.stringify(requested(events))}`);
  assert.deepEqual(calls, [], 'the server saw a call the host denied');
});
