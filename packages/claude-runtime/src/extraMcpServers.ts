import { isAbsolute } from 'node:path';
import type { McpHttpServerConfig, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { ACCOUNT_ENV_VARS, IDENTITY_SEED_ENV_VARS } from './account.js';

/**
 * MCP servers the process that starts the sidecar declares for every session it runs (the extra-MCP-servers
 * design note, extended with `type: "http"`).
 *
 * An environment variable of a process the host itself starts, never a field a remote client could
 * send, the same as the sidecar's account variable. Read once per process, before the socket is bound,
 * and a value that is set but unusable refuses to start rather than being ignored.
 */
export const EXTRA_MCP_SERVERS_VARIABLE = 'VERDANDI_CLAUDE_EXTRA_MCP_SERVERS';

/** At most this many servers. Each one is a connection every session opens at startup. */
export const MAX_EXTRA_MCP_SERVERS = 8;

/**
 * A server's name. The CLI names its tools `mcp__<server>__<tool>`, and the session's init check
 * reads the server part of a tool's name as everything before the first `__` after `mcp__`
 * (`mcpToolServer`). A name may not contain `__` (`a__b`'s tool `mcp__a__b__x` reads as `a`'s) or end
 * in `_` (`a_`'s tool `mcp__a___x` does too). With both refused, every tool of `s` reads as `s`'s and
 * no other server's tool does.
 */
const SERVER_NAME = /^[a-z][a-z0-9_]{0,40}$/;

function serverNameProblem(name: string): boolean {
  return !SERVER_NAME.test(name) || name.includes('__') || name.endsWith('_');
}

/** The connector switch an ISOLATED session with extra servers sets in its own environment. */
export const CONNECTOR_SWITCH_ENV = 'ENABLE_CLAUDEAI_MCP_SERVERS';

/**
 * Variables a session's environment deletes or overwrites (`applyAccountEnv`, the ISOLATED overlay in
 * `policyToBaseOptions`, the SDK's spawn). A header taken from one would pass the startup check here and then reach the
 * CLI empty or changed, so none of them may be a header's source.
 */
const SESSION_REWRITTEN_ENV: ReadonlySet<string> = new Set([
  ...ACCOUNT_ENV_VARS,
  ...IDENTITY_SEED_ENV_VARS,
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  CONNECTOR_SWITCH_ENV,
  // The SDK's own, before it spawns the CLI (sdk.mjs 0.3.252): it deletes NODE_OPTIONS, and deletes
  // DEBUG or sets it to "1".
  'NODE_OPTIONS',
  'DEBUG',
]);

/** An HTTP header field name (RFC 9110 `token`). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** A variable the CLI's `${VAR}` expansion recognises without ambiguity. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a session's `options.mcpServers` receives for one extra server. */
export type ExtraMcpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** The resolved variable: server name to the SDK config, frozen, shared by every session of the process. */
export type ExtraMcpServers = Readonly<Record<string, Readonly<ExtraMcpServerConfig>>>;

const STDIO_KEYS = new Set(['type', 'command', 'args', 'env', 'timeout']);
const HTTP_KEYS = new Set(['type', 'url', 'headers_from_env', 'alwaysLoad', 'timeout']);

function refuse(detail: string): never {
  throw new Error(`${EXTRA_MCP_SERVERS_VARIABLE}: ${detail}`);
}

/** A NUL byte passes a type check, then Node refuses the spawn (ERR_INVALID_ARG_VALUE) in every session. */
function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `timeout`, when present: an integer of at least 1000. The SDK silently ignores a smaller one
 * (sdk.d.ts, `McpStdioServerConfig.timeout`), so accepting it would accept a value that does nothing. */
function timeoutOf(name: string, entry: Record<string, unknown>): { timeout?: number } {
  if (!('timeout' in entry)) {
    return {};
  }
  const timeout = entry.timeout;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1000) {
    refuse(`server "${name}": timeout must be an integer of at least 1000 (milliseconds); the SDK ignores smaller values`);
  }
  return { timeout };
}

function unknownKeys(name: string, entry: Record<string, unknown>, allowed: Set<string>, type: string): void {
  const extra = Object.keys(entry).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    refuse(`server "${name}": ${JSON.stringify(extra)} not allowed for type "${type}" (allowed: ${JSON.stringify([...allowed])})`);
  }
}

/**
 * A stdio server, as the design note's §3.1 states it. `alwaysLoad` is refused: the tools stay deferred.
 * `args` and `env` values travel literally in the CLI's `--mcp-config` argument, visible in `ps`: no secrets.
 */
function stdioServer(name: string, entry: Record<string, unknown>): McpStdioServerConfig {
  unknownKeys(name, entry, STDIO_KEYS, 'stdio');
  const { command, args, env } = entry;
  if (typeof command !== 'string' || !isAbsolute(command)) {
    refuse(`server "${name}": command must be an absolute path`);
  }
  if (hasNul(command)) {
    refuse(`server "${name}": command must not contain a NUL byte`);
  }
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) {
    refuse(`server "${name}": args must be an array of strings`);
  }
  if ((args as string[] | undefined)?.some(hasNul)) {
    refuse(`server "${name}": args must not contain a NUL byte`);
  }
  if (env !== undefined && !(isPlainObject(env) && Object.values(env).every((value) => typeof value === 'string'))) {
    refuse(`server "${name}": env must map strings to strings`);
  }
  if (env !== undefined && Object.entries(env as Record<string, string>).some(([key, value]) => hasNul(key) || hasNul(value))) {
    refuse(`server "${name}": env must not contain a NUL byte in a name or value`);
  }
  return {
    ...('type' in entry ? { type: 'stdio' as const } : {}),
    command,
    ...(args !== undefined ? { args: [...(args as string[])] } : {}),
    ...(env !== undefined ? { env: { ...(env as Record<string, string>) } } : {}),
    ...timeoutOf(name, entry),
  };
}

/**
 * An http server. Header values never appear in the variable: `headers_from_env`
 * names, per header, the variable of THIS process's environment that holds the value. The value is
 * checked here and written into the SDK config as `${VAR}`, which the CLI expands from its own
 * environment -- the one it inherits from this process. The SDK hands `mcpServers` to the CLI as a
 * command-line argument (`--mcp-config <json>`), so a resolved value would be readable by any local
 * user through `ps`; the reference is all that ever reaches an argv (measured on CLI 2.1.288:
 * docs/measurements/2026-10-08-c0-extra-mcp-servers.md §5). The value itself stays in this process's
 * environment, which every session's subprocesses inherit (a Bash tool, hooks, stdio servers): such a
 * server belongs on a sidecar whose sessions cannot run commands, e.g. sessions with no built-in tools.
 */
function httpServer(name: string, entry: Record<string, unknown>, env: NodeJS.ProcessEnv): McpHttpServerConfig {
  unknownKeys(name, entry, HTTP_KEYS, 'http');
  const { url, headers_from_env: headersFromEnv, alwaysLoad } = entry;
  if (typeof url !== 'string') {
    refuse(`server "${name}": url must be a string`);
  }
  if (hasNul(url)) {
    refuse(`server "${name}": url must not contain a NUL byte`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse(`server "${name}": url is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    refuse(`server "${name}": url must be http or https, not ${JSON.stringify(parsed.protocol)}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    refuse(`server "${name}": url must not carry credentials; put them in a header through headers_from_env`);
  }
  // The CLI expands ${VAR} in an MCP server's url too. Only the headers written below are meant to
  // be expanded, from variables checked here.
  if (url.includes('${')) {
    refuse(`server "${name}": url must not contain "\${": the CLI would expand it from its environment`);
  }
  if (alwaysLoad !== undefined && typeof alwaysLoad !== 'boolean') {
    refuse(`server "${name}": alwaysLoad must be a boolean`);
  }
  let headers: Record<string, string> | undefined;
  if (headersFromEnv !== undefined) {
    if (!isPlainObject(headersFromEnv) || Object.keys(headersFromEnv).length === 0) {
      refuse(`server "${name}": headers_from_env must map at least one header name to a variable name`);
    }
    // Pairs first, then Object.fromEntries: assigning a header named `__proto__` onto `{}` would set
    // the object's prototype instead of a header, and the header would vanish without a word.
    const pairs: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const [header, variable] of Object.entries(headersFromEnv)) {
      if (hasNul(header) || !HEADER_NAME.test(header)) {
        refuse(`server "${name}": ${JSON.stringify(header)} is not an HTTP header name`);
      }
      if (seen.has(header.toLowerCase())) {
        refuse(`server "${name}": header ${JSON.stringify(header)} is listed twice`);
      }
      seen.add(header.toLowerCase());
      if (typeof variable !== 'string' || hasNul(variable) || !ENV_NAME.test(variable)) {
        refuse(`server "${name}": header ${JSON.stringify(header)} must name an environment variable (${ENV_NAME})`);
      }
      if (SESSION_REWRITTEN_ENV.has(variable)) {
        refuse(`server "${name}": header ${JSON.stringify(header)} cannot come from ${variable}, which a session's environment removes or overwrites`);
      }
      // Never the value itself, in this message or any other: only that it is missing or unusable.
      const value = env[variable];
      if (value === undefined || value.trim() === '') {
        refuse(`server "${name}": header ${JSON.stringify(header)} comes from ${variable}, which is not set or empty in this process's environment`);
      }
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        refuse(`server "${name}": header ${JSON.stringify(header)} comes from ${variable}, whose value contains a control character`);
      }
      pairs.push([header, `\${${variable}}`]);
    }
    headers = Object.fromEntries(pairs);
  }
  return {
    type: 'http',
    url,
    ...(headers !== undefined ? { headers } : {}),
    ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    ...timeoutOf(name, entry),
  };
}

/**
 * The servers `VERDANDI_CLAUDE_EXTRA_MCP_SERVERS` declares, or `undefined` when it is unset or empty
 * after trimming -- which leaves every session's options byte-identical to a build without this.
 * Pure: everything it reads is `env`, which is also where `headers_from_env` variables are checked.
 *
 * Throws, with a message that starts with the variable's name and never contains a header value,
 * when the value is set and unusable:
 * - a JSON object of 1 to 8 entries, each name matching `^[a-z][a-z0-9_]{0,40}$`, without `__` and
 *   not ending in `_`;
 * - `type` absent or `"stdio"`: `command` an absolute path, `args` strings, `env` string to string,
 *   `timeout` an integer of at least 1000; nothing else, `alwaysLoad` included;
 * - `type` `"http"`: `url` http(s) without credentials, `headers_from_env` header name to the name of
 *   a set, non-empty variable that sessions do not rewrite, `alwaysLoad` a boolean, `timeout` as above;
 *   nothing else, a plaintext `headers` included;
 * - any other `type` (`sse`, `sdk`, ...).
 */
export function resolveExtraMcpServers(env: NodeJS.ProcessEnv = process.env): ExtraMcpServers | undefined {
  const raw = env[EXTRA_MCP_SERVERS_VARIABLE];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    refuse('not valid JSON');
  }
  if (!isPlainObject(value)) {
    refuse('must be a JSON object mapping server names to server configs');
  }
  const names = Object.keys(value);
  if (names.length < 1 || names.length > MAX_EXTRA_MCP_SERVERS) {
    refuse(`must declare 1 to ${MAX_EXTRA_MCP_SERVERS} servers, got ${names.length}`);
  }
  const servers: Record<string, Readonly<ExtraMcpServerConfig>> = {};
  for (const name of names) {
    if (serverNameProblem(name)) {
      refuse(`server name ${JSON.stringify(name)} must match ${SERVER_NAME}, must not contain "__" and must not end in "_"`);
    }
    const entry = value[name];
    if (!isPlainObject(entry)) {
      refuse(`server "${name}": must be an object`);
    }
    const type = entry.type;
    let server: ExtraMcpServerConfig;
    if (type === undefined || type === 'stdio') {
      server = stdioServer(name, entry);
    } else if (type === 'http') {
      server = httpServer(name, entry, env);
    } else {
      refuse(`server "${name}": type must be "stdio" (or absent) or "http", not ${JSON.stringify(type)}`);
    }
    servers[name] = deepFreeze(server);
  }
  return Object.freeze(servers);
}

/** One line for a log: names and types, never a command, URL or header. */
export function describeExtraMcpServers(servers: ExtraMcpServers): string {
  return Object.entries(servers)
    .map(([name, server]) => `${name} (${server.type ?? 'stdio'})`)
    .join(', ');
}

/** A per-session copy: the SDK and CLI get objects no other session shares. */
export function copyExtraMcpServers(servers: ExtraMcpServers): Record<string, ExtraMcpServerConfig> {
  return structuredClone(servers) as Record<string, ExtraMcpServerConfig>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}
