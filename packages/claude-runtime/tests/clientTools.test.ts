import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import { makeFakeQuery } from './fakeQuery.js';
import { CLIENT_TOOL_LIMITS, clientToolsProblem, type ClientTools, type ClientToolsRefusal } from '../src/clientTools.js';

/**
 * The refusals a host's `client_tools` declaration can meet before any session exists. Each row starts from
 * one valid declaration and changes one thing, so a check that is missing, or that answers under another
 * name, fails its own row: hosts and the docs key on the reason.
 */

const SCHEMA = '{"type":"object","properties":{"path":{"type":"string"}}}';

function valid(): ClientTools {
  return {
    serverName: 'editor',
    timeoutMs: 60_000,
    tools: [{ name: 'open_file', description: 'Open a file', inputSchemaJson: SCHEMA, alwaysLoad: false }],
  };
}

function tool(name: string, inputSchemaJson = SCHEMA) {
  return { name, description: '', inputSchemaJson, alwaysLoad: false };
}

function withTools(tools: ClientTools['tools'], serverName = 'editor'): ClientTools {
  return { ...valid(), serverName, tools };
}

const ROWS: Array<[reason: ClientToolsRefusal, declaration: ClientTools, extraServers?: string[]]> = [
  ['client_tools_server_name', { ...valid(), serverName: 'Editor' }],
  ['client_tools_server_name', { ...valid(), serverName: '' }],
  ['client_tools_server_reserved', { ...valid(), serverName: 'ide' }],
  ['client_tools_server_taken', valid(), ['remote', 'editor']],
  ['client_tools_no_tools', withTools([])],
  ['client_tools_too_many', withTools(Array.from({ length: CLIENT_TOOL_LIMITS.tools + 1 }, (_, i) => tool(`t${i}`)))],
  ['client_tools_tool_name', withTools([tool('has space')])],
  ['client_tools_tool_name', withTools([tool('')])],
  ['client_tools_tool_duplicate', withTools([tool('a'), tool('b'), tool('a')])],
  ['client_tools_schema_too_large', withTools([tool('a', `{"type":"object","d":"${'x'.repeat(CLIENT_TOOL_LIMITS.schemaBytes)}"}`)])],
  ['client_tools_schema_invalid', withTools([tool('a', '{')])],
  ['client_tools_timeout_too_small', { ...valid(), timeoutMs: 999 }],
  ['client_tools_timeout_too_small', { ...valid(), timeoutMs: 1500.5 }],
  ['client_tools_timeout_too_small', { ...valid(), timeoutMs: 0 }],
];

test('a valid declaration is accepted', () => {
  assert.equal(clientToolsProblem(valid(), []), null);
  assert.equal(clientToolsProblem(valid(), ['remote']), null);
});

for (const [reason, declaration, extra] of ROWS) {
  test(`${reason}: ${JSON.stringify(declaration).slice(0, 60)}`, () => {
    const problem = clientToolsProblem(declaration, extra ?? []);
    assert.equal(problem?.reason, reason);
    assert.notEqual(problem?.message, '');
  });
}

test('the reserved name says why the CLI makes it unusable', () => {
  assert.match(clientToolsProblem({ ...valid(), serverName: 'ide' }, [])?.message ?? '', /hides that server's tools from the model/);
});

test('a server name that passes the regex but holds __ or ends in _ is refused', () => {
  for (const serverName of ['a__b', 'a_', 'ed__itor_']) {
    assert.equal(clientToolsProblem({ ...valid(), serverName }, [])?.reason, 'client_tools_server_name', serverName);
  }
});

test('exactly 32 tools and a schema of exactly 16 KiB pass, one more of either is refused', () => {
  const many = (n: number) => withTools(Array.from({ length: n }, (_, i) => tool(`t${i}`)));
  assert.equal(clientToolsProblem(many(CLIENT_TOOL_LIMITS.tools), []), null);
  assert.equal(clientToolsProblem(many(CLIENT_TOOL_LIMITS.tools + 1), [])?.reason, 'client_tools_too_many');
  const sized = (bytes: number) => {
    const head = '{"type":"object","d":"';
    const tail = '"}';
    return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
  };
  assert.equal(clientToolsProblem(withTools([tool('a', sized(CLIENT_TOOL_LIMITS.schemaBytes))]), []), null);
  assert.equal(clientToolsProblem(withTools([tool('a', sized(CLIENT_TOOL_LIMITS.schemaBytes + 1))]), [])?.reason, 'client_tools_schema_too_large');
});

test('a schema of 16 KiB in characters but more in UTF-8 bytes is refused', () => {
  const head = '{"type":"object","d":"';
  const tail = '"}';
  const text = head + 'é'.repeat(CLIENT_TOOL_LIMITS.schemaBytes - head.length - tail.length) + tail;
  assert.equal(text.length, CLIENT_TOOL_LIMITS.schemaBytes);
  assert.equal(clientToolsProblem(withTools([tool('a', text)]), [])?.reason, 'client_tools_schema_too_large');
});

test('a schema that is an array, null, a string, or an object without type "object" is refused', () => {
  for (const schema of ['[]', 'null', '"object"', '42', '{}', '{"type":"string"}', '{"type":["object"]}', '']) {
    assert.equal(clientToolsProblem(withTools([tool('a', schema)]), [])?.reason, 'client_tools_schema_invalid', schema);
  }
});

test('a tool name that makes mcp__<server>__<tool> 65 characters long is refused, and 64 passes', () => {
  const room = CLIENT_TOOL_LIMITS.toolNameChars - 'mcp__editor__'.length;
  assert.equal(clientToolsProblem(withTools([tool('a'.repeat(room))]), []), null);
  assert.equal(clientToolsProblem(withTools([tool('a'.repeat(room + 1))]), [])?.reason, 'client_tools_tool_name');
});

test('the name of an extra server is refused, and the same name with no extra servers passes', () => {
  assert.equal(clientToolsProblem(valid(), ['editor'])?.reason, 'client_tools_server_taken');
  assert.equal(clientToolsProblem(valid(), []), null);
});

test('the checks run in the order the declaration lists them, and the first failure answers', () => {
  const broken: ClientTools = { serverName: 'ide', timeoutMs: 1, tools: [] };
  assert.equal(clientToolsProblem(broken, ['ide'])?.reason, 'client_tools_server_reserved');
  assert.equal(clientToolsProblem({ ...broken, serverName: 'editor' }, [])?.reason, 'client_tools_no_tools');
  assert.equal(clientToolsProblem({ ...broken, serverName: 'editor', tools: [tool('a', '{')] }, [])?.reason, 'client_tools_schema_invalid');
  assert.equal(clientToolsProblem({ ...broken, serverName: 'editor', tools: [tool('a')] }, [])?.reason, 'client_tools_timeout_too_small');
});

test('createSession refuses a declaration the sidecar would have refused, before it builds anything', () => {
  const policy: ClaudeHostPolicy = { configuration: 'native', permissions: 'bypass', persistence: 'host_cli', executable: 'host_cli', toolPolicy: { unrestricted: true } };
  let queries = 0;
  const query = () => {
    queries += 1;
    return makeFakeQuery().query;
  };
  assert.throws(() => createSession({ cwd: '/tmp/project', policy, clientTools: { ...valid(), serverName: 'ide' } }, query), /reserved/);
  assert.throws(
    () => createSession({ cwd: '/tmp/project', policy, extraMcpServers: { editor: { command: '/bin/e' } }, clientTools: valid() }, query),
    /already the name of an MCP server/,
  );
  assert.equal(queries, 0);
});
