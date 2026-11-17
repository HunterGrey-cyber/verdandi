#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

const capturePath = process.env.VERDANDI_TEST_MCP_CAPTURE;
const serverName = process.env.VERDANDI_TEST_MCP_SERVER;
if (!capturePath || !isAbsolute(capturePath)) {
  throw new Error('VERDANDI_TEST_MCP_CAPTURE must be an absolute scratch path');
}
if (!serverName) {
  throw new Error('VERDANDI_TEST_MCP_SERVER must name the SDK MCP server to talk to');
}

// This executable speaks only the CLI's side of the control protocol over stdio: it has no model
// client and no network. Every line it receives is appended to the capture, one frame per line, so a
// test can poll the file while the process is still running.
const record = (entry) => appendFileSync(capturePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
record({ argv: process.argv.slice(2) });

const mcpFrames = [
  { jsonrpc: '2.0', id: 1, method: 'server/discover' },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-control-stub', version: '0.0.0' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'open_file', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_stub1' } },
  },
];

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

let nextFrame = 0;
let waitingFor = null;
function sendNext() {
  if (nextFrame >= mcpFrames.length) return;
  const requestId = `stub-${nextFrame + 1}`;
  const message = mcpFrames[nextFrame];
  nextFrame += 1;
  waitingFor = requestId;
  send({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: serverName, message } });
}

const lines = createInterface({ input: process.stdin });
let initialized = false;
lines.on('line', (line) => {
  if (line.trim() === '') return;
  const frame = JSON.parse(line);
  record(frame);
  if (frame.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    if (frame.request?.subtype === 'initialize' && !initialized) {
      initialized = true;
      sendNext();
    }
    return;
  }
  // The answer to the frame sent last releases the next one; the tools/call answer is the last.
  if (frame.type === 'control_response' && frame.response?.request_id === waitingFor) {
    waitingFor = null;
    sendNext();
  }
});
lines.on('close', () => {
  record({ stdin: 'end' });
  process.exit(0);
});
