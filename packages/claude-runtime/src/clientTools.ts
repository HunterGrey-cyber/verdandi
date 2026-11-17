import { serverNameProblem } from './extraMcpServers.js';

/** One tool a host answers itself: its name without the `mcp__<server>__` prefix, and its JSON Schema as JSON text. */
export type ClientToolDeclaration = { name: string; description: string; inputSchemaJson: string; alwaysLoad: boolean };

/**
 * Tools a session's host declares and answers on its own session. They are served to the CLI as one
 * in-process MCP server named `serverName`; nothing is started and no connection is opened.
 */
export type ClientTools = { serverName: string; timeoutMs: number; tools: ClientToolDeclaration[] };

export const CLIENT_TOOL_LIMITS = Object.freeze({
  tools: 32,
  schemaBytes: 16 * 1024,
  /** The whole `mcp__<server>__<tool>`: the CLI refuses a longer tool name. */
  toolNameChars: 64,
  minTimeoutMs: 1000,
  argumentsBytes: 1024 * 1024,
  /** The model's `tool_use` id in UTF-8 bytes, the size the wire's other ids stop at. The open calls are
   * reported in one message, so an unbounded id could take that message past what a host can read. */
  toolUseIdBytes: 128,
  liveCalls: 64,
  settledHistory: 1024,
});

export type ClientToolsRefusal =
  | 'client_tools_server_name'
  | 'client_tools_server_reserved'
  | 'client_tools_server_taken'
  | 'client_tools_no_tools'
  | 'client_tools_too_many'
  | 'client_tools_tool_name'
  | 'client_tools_tool_duplicate'
  | 'client_tools_schema_too_large'
  | 'client_tools_schema_invalid'
  | 'client_tools_timeout_too_small';

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** The CLI hides the tools of a server called `ide` from the model, so a tool declared there would never be offered. */
const RESERVED_SERVER = 'ide';

function schemaIsObjectSchema(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  // The CLI's MCP client rejects a tool list holding any other schema, which would lose every tool of the server.
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { type?: unknown }).type === 'object';
}

/**
 * Why this declaration cannot be served, or `null`. Checks run in a fixed order, each across every tool
 * before the next, and the first failure answers. `extraServerNames` are the servers the sidecar's own
 * process declared; a client server may not share a name with one.
 */
export function clientToolsProblem(
  clientTools: ClientTools,
  extraServerNames: readonly string[],
): { reason: ClientToolsRefusal; message: string } | null {
  const { serverName, tools } = clientTools;
  if (serverNameProblem(serverName)) {
    return {
      reason: 'client_tools_server_name',
      message: `client_tools.server_name ${JSON.stringify(serverName)} must match ^[a-z][a-z0-9_]{0,40}$ and hold no "__" and no trailing "_"`,
    };
  }
  if (serverName === RESERVED_SERVER) {
    return {
      reason: 'client_tools_server_reserved',
      message: `client_tools.server_name "${RESERVED_SERVER}" is reserved: the CLI hides that server's tools from the model`,
    };
  }
  if (extraServerNames.includes(serverName)) {
    return {
      reason: 'client_tools_server_taken',
      message: `client_tools.server_name ${JSON.stringify(serverName)} is already the name of an MCP server this sidecar declares`,
    };
  }
  if (tools.length === 0) {
    return { reason: 'client_tools_no_tools', message: 'client_tools.tools is empty: declare at least one tool' };
  }
  if (tools.length > CLIENT_TOOL_LIMITS.tools) {
    return {
      reason: 'client_tools_too_many',
      message: `client_tools.tools has ${tools.length} entries, at most ${CLIENT_TOOL_LIMITS.tools} are allowed`,
    };
  }
  for (const tool of tools) {
    const full = `mcp__${serverName}__${tool.name}`;
    if (!TOOL_NAME.test(tool.name) || full.length > CLIENT_TOOL_LIMITS.toolNameChars) {
      return {
        reason: 'client_tools_tool_name',
        message: `client_tools tool name ${JSON.stringify(tool.name)} must match ^[A-Za-z0-9_-]+$ and make ${JSON.stringify(`mcp__${serverName}__<name>`)} at most ${CLIENT_TOOL_LIMITS.toolNameChars} characters`,
      };
    }
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      return { reason: 'client_tools_tool_duplicate', message: `client_tools declares the tool ${JSON.stringify(tool.name)} more than once` };
    }
    seen.add(tool.name);
  }
  for (const tool of tools) {
    if (Buffer.byteLength(tool.inputSchemaJson, 'utf8') > CLIENT_TOOL_LIMITS.schemaBytes) {
      return {
        reason: 'client_tools_schema_too_large',
        message: `client_tools tool ${JSON.stringify(tool.name)}: input_schema_json is longer than ${CLIENT_TOOL_LIMITS.schemaBytes} bytes`,
      };
    }
  }
  for (const tool of tools) {
    if (!schemaIsObjectSchema(tool.inputSchemaJson)) {
      return {
        reason: 'client_tools_schema_invalid',
        message: `client_tools tool ${JSON.stringify(tool.name)}: input_schema_json must be a JSON object whose "type" is "object"`,
      };
    }
  }
  if (!Number.isInteger(clientTools.timeoutMs) || clientTools.timeoutMs < CLIENT_TOOL_LIMITS.minTimeoutMs) {
    return {
      reason: 'client_tools_timeout_too_small',
      message: `client_tools.timeout_ms must be an integer of at least ${CLIENT_TOOL_LIMITS.minTimeoutMs}: the CLI ignores a smaller limit and the session would run with none`,
    };
  }
  return null;
}
