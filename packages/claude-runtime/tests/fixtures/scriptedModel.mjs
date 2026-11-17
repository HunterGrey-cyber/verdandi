// A scripted stand-in for the Anthropic Messages API, standard library only.
//
// usage: node scriptedModel.mjs <port> <log dir>
//
// Every request is logged whole to <log dir>/model-requests.jsonl, one JSON object per line. A
// conversation request (its `tools` hold `Read`) is answered from the last user message:
//
//   PROBE-CALL <tool name> <json arguments>   -> one tool_use of that tool, id `toolu_pc_<8 hex of a hash>`
//   a tool_result of such a call              -> the text `PC-DONE err=<is_error>: <content>`
//   anything else                             -> the text `PLAIN`
//
// Any other request (titles, side queries) gets the text `side`. Nothing here reads a credential or
// reaches past 127.0.0.1.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const logDir = process.argv[3];
if (!Number.isInteger(port) || !logDir) {
  process.stderr.write('usage: scriptedModel.mjs <port> <log dir>\n');
  process.exit(2);
}
const logPath = join(logDir, 'model-requests.jsonl');
let counter = 0;

function log(record) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function blocks(message) {
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content ?? [];
}

const textOf = (message) =>
  blocks(message)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i];
  }
  return undefined;
}

function decide(body) {
  const tools = (body.tools ?? []).map((tool) => tool.name);
  if (!tools.includes('Read')) return { kind: 'text', text: 'side' };
  const message = lastUser(body.messages ?? []);
  if (message === undefined) return { kind: 'text', text: 'PLAIN' };
  for (const block of blocks(message)) {
    if (block.type !== 'tool_result' || !String(block.tool_use_id ?? '').startsWith('toolu_pc_')) continue;
    let content = block.content;
    if (Array.isArray(content)) content = content.map((part) => (part && typeof part === 'object' ? (part.text ?? '') : '')).join(' ');
    return { kind: 'text', text: `PC-DONE err=${block.is_error}: ${String(content).slice(0, 300)}` };
  }
  const text = textOf(message);
  const marker = text.indexOf('PROBE-CALL ');
  if (marker >= 0) {
    const rest = text.slice(marker + 'PROBE-CALL '.length).trim();
    const space = rest.indexOf(' ');
    const name = space < 0 ? rest : rest.slice(0, space);
    const json = (space < 0 ? '' : rest.slice(space + 1).trim().split('\n')[0]) || '{}';
    let input = {};
    try {
      input = JSON.parse(json);
    } catch {
      input = {};
    }
    const id = `toolu_pc_${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
    return { kind: 'tool', id, name, input };
  }
  return { kind: 'text', text: 'PLAIN' };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function send(res, code, object) {
  const data = JSON.stringify(object);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function answer(res, body, reply, n) {
  const model = body.model ?? 'claude-scripted';
  const content = reply.kind === 'text' ? [{ type: 'text', text: reply.text }] : [{ type: 'tool_use', id: reply.id, name: reply.name, input: reply.input }];
  const stop = reply.kind === 'text' ? 'end_turn' : 'tool_use';
  const id = `msg_scripted_${n}`;
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) {
    send(res, 200, { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  let out = sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    out += sse('content_block_stop', { type: 'content_block_stop', index });
  });
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  out += sse('message_stop', { type: 'message_stop' });
  res.end(out);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    counter += 1;
    const n = counter;
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      log({ n, t: Date.now() / 1000, method: 'GET', path: req.url });
      send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'scripted' } });
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      body = { _raw: Buffer.concat(chunks).toString('utf8') };
    }
    if (path.endsWith('/count_tokens')) {
      log({ n, t: Date.now() / 1000, path: req.url, kind: 'count_tokens' });
      send(res, 200, { input_tokens: 100 });
      return;
    }
    if (!path.endsWith('/v1/messages')) {
      log({ n, t: Date.now() / 1000, path: req.url, body });
      send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'scripted' } });
      return;
    }
    const reply = decide(body);
    log({ n, t: Date.now() / 1000, path: req.url, reply, body });
    answer(res, body, reply, n);
  });
});

server.listen(port, '127.0.0.1');
