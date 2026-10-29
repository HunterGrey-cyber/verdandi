import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { EXTRA_MCP_SERVERS_VARIABLE, describeExtraMcpServers, resolveExtraMcpServers, type ExtraMcpServers } from '../src/extraMcpServers.js';
import { buildSessionOptions, policyToBaseOptions } from '../src/session.js';
import type { ClaudeHostPolicy } from '../src/types.js';

/**
 * VERDANDI_CLAUDE_EXTRA_MCP_SERVERS (the design note's §6 tests a, c, e; plus the http type's own rules). Test b (does NATIVE merge with a project's .mcp.json)
 * needs the real CLI and was measured instead: docs/measurements/2026-10-08-c0-extra-mcp-servers.md §3.
 * Test d is realSdk.extraMcp.integration.test.ts plus the broker's unit test; f is the sidecar's
 * handshake list.
 */

const HOST_EXAMPLE = {
  host_ab12cd: {
    type: 'stdio',
    command: '/usr/lib/host/host-mcp',
    args: [],
    env: { HOST_TOOL_SOCKET: '/run/user/1000/host-x/host-ht-0123.sock' },
  },
};
const SECRET = 'Bearer s3cret-value-that-must-never-be-printed';
const REMOTE = { remote: { type: 'http', url: 'http://127.0.0.1:8930/mcp', headers_from_env: { Authorization: 'REMOTE_MCP_AUTHORIZATION' }, alwaysLoad: true } };

function envWith(value: unknown, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [EXTRA_MCP_SERVERS_VARIABLE]: typeof value === 'string' ? value : JSON.stringify(value), ...extra };
}

const ISOLATED: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};
const NATIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const BASE_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u', REMOTE_MCP_AUTHORIZATION: SECRET };

// ---- the variable ---------------------------------------------------------------------------------

test('unset or blank means nothing is configured', () => {
  assert.equal(resolveExtraMcpServers({}), undefined);
  assert.equal(resolveExtraMcpServers({ [EXTRA_MCP_SERVERS_VARIABLE]: '' }), undefined);
  assert.equal(resolveExtraMcpServers({ [EXTRA_MCP_SERVERS_VARIABLE]: '  \n ' }), undefined);
});

test('a stdio server passes through as written, frozen', () => {
  const servers = resolveExtraMcpServers(envWith(HOST_EXAMPLE));
  assert.deepEqual(servers, HOST_EXAMPLE);
  assert.ok(Object.isFrozen(servers) && Object.isFrozen(servers?.host_ab12cd));
  assert.deepEqual(resolveExtraMcpServers(envWith({ s: { command: '/bin/x', timeout: 1000 } })), { s: { command: '/bin/x', timeout: 1000 } }, 'an absent type stays absent');
});

test('an http server carries ${VAR} for each header, never the value', () => {
  const servers = resolveExtraMcpServers(envWith(REMOTE, { REMOTE_MCP_AUTHORIZATION: SECRET }));
  assert.deepEqual(servers, {
    remote: { type: 'http', url: 'http://127.0.0.1:8930/mcp', headers: { Authorization: '${REMOTE_MCP_AUTHORIZATION}' }, alwaysLoad: true },
  });
  assert.equal(JSON.stringify(servers).includes(SECRET), false);
  assert.deepEqual(
    resolveExtraMcpServers(envWith({ plain: { type: 'http', url: 'https://example.test/mcp', timeout: 5000 } })),
    { plain: { type: 'http', url: 'https://example.test/mcp', timeout: 5000 } },
    'headers_from_env is optional',
  );
});

test('a header named __proto__ is kept as a header, not swallowed as a prototype', () => {
  const servers = resolveExtraMcpServers(envWith('{"s":{"type":"http","url":"http://x/","headers_from_env":{"__proto__":"AUTH"}}}', { AUTH: 'v' }));
  const headers = (servers?.s as { headers: Record<string, string> }).headers;
  assert.deepEqual(Object.keys(headers), ['__proto__']);
  assert.equal(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value, '${AUTH}');
});

test('the log line names servers and types only', () => {
  const servers = resolveExtraMcpServers(envWith({ ...HOST_EXAMPLE, ...REMOTE }, { REMOTE_MCP_AUTHORIZATION: SECRET })) as ExtraMcpServers;
  assert.equal(describeExtraMcpServers(servers), 'host_ab12cd (stdio), remote (http)');
});

/** One case per rule (the design note's §3.1, and the http type's). Every message starts with the variable's name. */
const REFUSALS: Array<[string, unknown, RegExp, NodeJS.ProcessEnv?]> = [
  ['not JSON', '{nope', /not valid JSON/],
  ['an array', '[]', /must be a JSON object/],
  ['a string', '"x"', /must be a JSON object/],
  ['no servers', {}, /1 to 8 servers, got 0/],
  ['nine servers', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { command: '/bin/x' }])), /1 to 8 servers, got 9/],
  ['an upper-case name', { Remote: { command: '/bin/x' } }, /server name "Remote" must match/],
  ['a name starting with a digit', { '1s': { command: '/bin/x' } }, /server name "1s"/],
  ['a 42-character name', { ['a'.repeat(42)]: { command: '/bin/x' } }, /must match/],
  ['a name with "__"', { a__b: { command: '/bin/x' } }, /must not contain "__"/],
  ['a name ending in "_"', { a: { command: '/bin/a' }, a_: { command: '/bin/b' } }, /server name "a_" .*must not end in "_"/],
  ['an entry that is not an object', { s: 'x' }, /server "s": must be an object/],
  ['type sse', { s: { type: 'sse', url: 'http://x/' } }, /type must be "stdio" \(or absent\) or "http", not "sse"/],
  ['type sdk', { s: { type: 'sdk', name: 'x' } }, /not "sdk"/],
  ['a relative command', { s: { command: 'host-mcp' } }, /command must be an absolute path/],
  ['no command', { s: { args: [] } }, /command must be an absolute path/],
  ['args with a number', { s: { command: '/bin/x', args: ['a', 1] } }, /args must be an array of strings/],
  ['env with a number', { s: { command: '/bin/x', env: { A: 1 } } }, /env must map strings to strings/],
  ['a stdio timeout of 500', { s: { command: '/bin/x', timeout: 500 } }, /timeout must be an integer of at least 1000/],
  ['a fractional timeout', { s: { command: '/bin/x', timeout: 1500.5 } }, /timeout must be an integer/],
  ['alwaysLoad on stdio', { s: { command: '/bin/x', alwaysLoad: true } }, /\["alwaysLoad"\] not allowed for type "stdio"/],
  ['a NUL byte in the command', { s: { command: '/bin/x\u0000y' } }, /command must not contain a NUL byte/],
  ['a NUL byte in an arg', { s: { command: '/bin/x', args: ['ok', 'a\u0000b'] } }, /args must not contain a NUL byte/],
  ['a NUL byte in an env value', { s: { command: '/bin/x', env: { A: 'v\u0000' } } }, /env must not contain a NUL byte/],
  ['a NUL byte in an env name', { s: { command: '/bin/x', env: { 'A\u0000B': 'v' } } }, /env must not contain a NUL byte/],
  ['a NUL byte in an http url', { s: { type: 'http', url: 'http://x/a\u0000b' } }, /url must not contain a NUL byte/],
  ['a NUL byte in a header name', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X-A\u0000': 'A' } } }, /is not an HTTP header name/, { A: 'v' }],
  ['a NUL byte in a header variable name', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X-A': 'A\u0000' } } }, /must name an environment variable/, { A: 'v' }],
  ['a valid server next to one with a NUL byte', { good: { command: '/bin/good', args: ['--ok'] }, bad: { command: '/bin/bad', args: ['a\u0000b'] } }, /server "bad": args must not contain a NUL byte/],
  ['an unknown stdio key', { s: { command: '/bin/x', cwd: '/tmp' } }, /\["cwd"\] not allowed/],
  ['http without a url', { s: { type: 'http' } }, /url must be a string/],
  ['an http url that is not a URL', { s: { type: 'http', url: 'not a url' } }, /url is not a URL/],
  ['an ftp url', { s: { type: 'http', url: 'ftp://x/' } }, /url must be http or https/],
  ['a url with credentials', { s: { type: 'http', url: 'http://user:pw@x/' } }, /must not carry credentials/],
  ['a url with ${', { s: { type: 'http', url: 'http://x/${HOME}' } }, /must not contain "\$\{"/],
  ['plaintext headers', { s: { type: 'http', url: 'http://x/', headers: { Authorization: 'Bearer t' } } }, /\["headers"\] not allowed for type "http"/],
  ['an empty headers_from_env', { s: { type: 'http', url: 'http://x/', headers_from_env: {} } }, /at least one header/],
  ['a header name with a space', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X Auth': 'A' } } }, /is not an HTTP header name/, { A: 'v' }],
  ['a header listed twice', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'A', authorization: 'A' } } }, /listed twice/, { A: 'v' }],
  ['a variable name with a dash', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'MY-VAR' } } }, /must name an environment variable/],
  ['an unset header variable', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'NOPE' } } }, /header "Authorization" comes from NOPE, which is not set or empty/],
  ['a header from an account variable', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X-User': 'CLAUDE_CODE_USER_EMAIL' } } }, /cannot come from CLAUDE_CODE_USER_EMAIL, which a session's environment removes or overwrites/, { CLAUDE_CODE_USER_EMAIL: 'u@example.invalid' }],
  ['a header from the connector switch', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X-A': 'ENABLE_CLAUDEAI_MCP_SERVERS' } } }, /cannot come from ENABLE_CLAUDEAI_MCP_SERVERS/, { ENABLE_CLAUDEAI_MCP_SERVERS: '1' }],
  ['a header from DEBUG, which the SDK removes', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'DEBUG' } } }, /cannot come from DEBUG/, { DEBUG: 'Bearer t' }],
  ['a header from NODE_OPTIONS, which the SDK removes', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'NODE_OPTIONS' } } }, /cannot come from NODE_OPTIONS/, { NODE_OPTIONS: 'Bearer t' }],
  ['a header from the config directory', { s: { type: 'http', url: 'http://x/', headers_from_env: { 'X-A': 'CLAUDE_CONFIG_DIR' } } }, /cannot come from CLAUDE_CONFIG_DIR/, { CLAUDE_CONFIG_DIR: '/home/u/.claude' }],
  ['an empty header variable', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'EMPTY' } } }, /comes from EMPTY, which is not set or empty/, { EMPTY: ' ' }],
  ['a header value with a newline', { s: { type: 'http', url: 'http://x/', headers_from_env: { Authorization: 'NL' } } }, /comes from NL, whose value contains a control character/, { NL: `${SECRET}\r\nX-Injected: 1` }],
  ['alwaysLoad that is not a boolean', { s: { type: 'http', url: 'http://x/', alwaysLoad: 'yes' } }, /alwaysLoad must be a boolean/],
  ['an http timeout of 500', { s: { type: 'http', url: 'http://x/', timeout: 500 } }, /timeout must be an integer of at least 1000/],
];

for (const [name, value, message, extraEnv] of REFUSALS) {
  test(`refused, naming the variable: ${name}`, () => {
    assert.throws(
      () => resolveExtraMcpServers(envWith(value, { REMOTE_MCP_AUTHORIZATION: SECRET, ...extraEnv })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.startsWith(`${EXTRA_MCP_SERVERS_VARIABLE}: `), error.message);
        assert.match(error.message, message);
        assert.equal(error.message.includes(SECRET), false, 'a header value must never reach a message');
        return true;
      },
    );
  });
}

// ---- the options a session gets ------------------------------------------------------------------------

const servers = resolveExtraMcpServers(envWith({ ...HOST_EXAMPLE, ...REMOTE }, { REMOTE_MCP_AUTHORIZATION: SECRET })) as ExtraMcpServers;

test('a: unset leaves the options byte-identical, NATIVE and ISOLATED', () => {
  for (const policy of [NATIVE, ISOLATED]) {
    const before = policyToBaseOptions(policy, '/tmp/p', { baseEnv: BASE_ENV });
    const after = policyToBaseOptions(policy, '/tmp/p', { baseEnv: BASE_ENV, extraMcpServers: undefined });
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    assert.equal(JSON.stringify(buildSessionOptions({ cwd: '/tmp/p', policy })), JSON.stringify(buildSessionOptions({ cwd: '/tmp/p', policy, extraMcpServers: undefined })));
  }
  // What "today's" means, pinned: ISOLATED states an empty server set and only the auto-memory
  // switches; NATIVE states no MCP option, and its environment is the base one plus the session-state
  // switch every session gets.
  const isolated = policyToBaseOptions(ISOLATED, '/tmp/p', { baseEnv: BASE_ENV });
  assert.deepEqual(isolated.mcpServers, {});
  assert.deepEqual(isolated.settings, { autoMemoryEnabled: false });
  assert.equal(isolated.env?.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  const native = policyToBaseOptions(NATIVE, '/tmp/p', { baseEnv: BASE_ENV });
  assert.equal('mcpServers' in native || 'strictMcpConfig' in native || 'settings' in native, false);
  assert.deepEqual(native.env, { ...BASE_ENV, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
});

test('c: ISOLATED with the variable sees exactly the extra servers, strict, with the connectors off', () => {
  const options = policyToBaseOptions(ISOLATED, '/tmp/p', { baseEnv: BASE_ENV, extraMcpServers: servers });
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, servers);
  assert.deepEqual(options.settings, { autoMemoryEnabled: false, disableClaudeAiConnectors: true });
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(options.env?.REMOTE_MCP_AUTHORIZATION, SECRET, 'the CLI inherits the variable its ${...} reference names');
});

test('NATIVE with the variable gets the servers, without strict and with its connectors and environment untouched', () => {
  const options = policyToBaseOptions(NATIVE, '/tmp/p', { baseEnv: { ...BASE_ENV, ENABLE_CLAUDEAI_MCP_SERVERS: '1' }, extraMcpServers: servers });
  assert.deepEqual(options.mcpServers, servers);
  assert.equal('strictMcpConfig' in options, false);
  assert.equal('settings' in options, false, 'no connector switch in a NATIVE session');
  assert.deepEqual(options.env, { ...BASE_ENV, ENABLE_CLAUDEAI_MCP_SERVERS: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, 'the environment untouched but for the session-state switch');
});

test('the switch is per session: an ISOLATED session with servers never changes what a NATIVE one is handed', () => {
  const env = { ...BASE_ENV };
  policyToBaseOptions(ISOLATED, '/tmp/p', { baseEnv: env, extraMcpServers: servers });
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined, 'the base environment is not written to');
  assert.equal(process.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
});

test('every session gets its own copy of the servers', () => {
  const first = policyToBaseOptions(ISOLATED, '/tmp/p', { baseEnv: BASE_ENV, extraMcpServers: servers });
  const second = policyToBaseOptions(ISOLATED, '/tmp/p', { baseEnv: BASE_ENV, extraMcpServers: servers });
  const firstHost = first.mcpServers?.host_ab12cd as { args: string[] };
  firstHost.args.push('--changed');
  assert.deepEqual((second.mcpServers?.host_ab12cd as { args: string[] }).args, []);
  assert.deepEqual(servers.host_ab12cd, HOST_EXAMPLE.host_ab12cd);
});

test('no header value is in what the SDK puts on the CLI command line', () => {
  // sdk.mjs 0.3.252: `if (mcpServers && Object.keys(mcpServers).length > 0) args.push("--mcp-config", JSON.stringify({ mcpServers }))`.
  const options: Options = buildSessionOptions({ cwd: '/tmp/p', policy: ISOLATED, extraMcpServers: servers });
  const argv = JSON.stringify({ mcpServers: options.mcpServers });
  assert.equal(argv.includes(SECRET), false);
  assert.match(argv, /"Authorization":"\$\{REMOTE_MCP_AUTHORIZATION\}"/);
});
