import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAccount } from '../../src/account.js';

/**
 * Variables that move authentication or billing away from the pinned account's stored login. With
 * any of them set, a green probe run says nothing about the account under test -- and nothing in
 * the run's output would show it.
 */
export const AUTH_REROUTING_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/**
 * Markers a parent Claude Code session leaves in its children's environment. The production
 * sidecar runs under systemd without any of them, so a probe that inherits them measures a
 * different program state. `run-m1-probe.sh` starts the probe under `env -i` for this reason.
 */
export function isNestedSessionVar(name: string): boolean {
  return name === 'CLAUDECODE' || name === 'CLAUDE_EFFORT' || name === 'CLAUDE_PID' || name.startsWith('CLAUDE_CODE_');
}

/** Refusals for the probe's own environment, checked before anything is spawned. */
export function checkParentEnv(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if ((env.VERDANDI_CLAUDE_ACCOUNT ?? '').trim() === '') {
    problems.push('VERDANDI_CLAUDE_ACCOUNT is not set: the probe must pin an account (run-m1-probe.sh pins work)');
  }
  for (const name of AUTH_REROUTING_VARS) {
    if ((env[name] ?? '') !== '') {
      problems.push(`${name} is set: it re-routes authentication away from the pinned account`);
    }
  }
  for (const name of Object.keys(env).sort()) {
    if (AUTH_REROUTING_VARS.includes(name)) {
      continue;
    }
    if (isNestedSessionVar(name) && (env[name] ?? '') !== '') {
      problems.push(`${name} is set: start the probe through run-m1-probe.sh so it runs in a production-like environment`);
    }
  }
  return problems;
}

export type ChildExpectation = {
  account: ClaudeAccount;
  cliPath: string;
  /** What the KERNEL must have set -- before the probe applies any override of its own. */
  permissionMode: 'bypassPermissions' | 'default';
  settingSources: string[];
  /** `Options.tools` the kernel must have set; absent means `[]` (the zero-tool completion). */
  tools?: readonly string[];
  /** `Options.disallowedTools` the kernel must have set; absent means it must be unset. */
  disallowedTools?: readonly string[];
};

/**
 * Checks the `Options` the kernel built, at the last point before a process is spawned. This is
 * the layer the account binding actually happens at (`policyToBaseOptions` -> `options.env`), so
 * it is the layer where "all four account variables are set and nothing re-routes auth" is proven
 * rather than assumed.
 */
export function checkChildOptions(options: Options, expect: ChildExpectation): string[] {
  const problems: string[] = [];
  const env = options.env ?? {};
  if (options.env === undefined) {
    problems.push('options.env is unset: the account overlay did not happen');
  }
  // An account at the CLI's default location is bound by the tuple being absent (applyAccountEnv);
  // every other account by all four being set to it.
  const wanted: Record<string, string | undefined> =
    expect.account.defaultLocation === true
      ? { CLAUDE_PROFILE: undefined, CLAUDE_CONFIG_DIR: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, ANTHROPIC_CONFIG_DIR: undefined }
      : {
          CLAUDE_PROFILE: expect.account.name,
          CLAUDE_CONFIG_DIR: expect.account.configDir,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: expect.account.configDir,
          ANTHROPIC_CONFIG_DIR: expect.account.anthropicConfigDir,
        };
  for (const [name, value] of Object.entries(wanted)) {
    if (env[name] !== value) {
      problems.push(`options.env.${name} is ${JSON.stringify(env[name])}, expected ${value === undefined ? 'unset' : JSON.stringify(value)}`);
    }
  }
  for (const name of AUTH_REROUTING_VARS) {
    if ((env[name] ?? '') !== '') {
      problems.push(`options.env.${name} is set`);
    }
  }
  const wantTools = expect.tools ?? [];
  if (!Array.isArray(options.tools) || JSON.stringify(options.tools) !== JSON.stringify(wantTools)) {
    problems.push(`options.tools is ${JSON.stringify(options.tools)}, expected ${JSON.stringify(wantTools)}`);
  }
  if (JSON.stringify(options.settingSources) !== JSON.stringify(expect.settingSources)) {
    problems.push(`options.settingSources is ${JSON.stringify(options.settingSources)}, expected ${JSON.stringify(expect.settingSources)}`);
  }
  if (options.strictMcpConfig !== true) {
    problems.push('options.strictMcpConfig is not true');
  }
  if (JSON.stringify(options.mcpServers) !== '{}') {
    problems.push(`options.mcpServers is ${JSON.stringify(options.mcpServers)}, expected {}`);
  }
  if (options.permissionMode !== expect.permissionMode) {
    problems.push(`options.permissionMode is ${JSON.stringify(options.permissionMode)}, expected ${JSON.stringify(expect.permissionMode)}`);
  }
  if (options.pathToClaudeCodeExecutable !== expect.cliPath) {
    problems.push(`options.pathToClaudeCodeExecutable is ${JSON.stringify(options.pathToClaudeCodeExecutable)}, expected ${JSON.stringify(expect.cliPath)}`);
  }
  if (options.persistSession !== true) {
    problems.push('options.persistSession is not true (production keeps a transcript per run)');
  }
  if (expect.disallowedTools === undefined) {
    if (options.disallowedTools !== undefined) {
      problems.push(`options.disallowedTools is ${JSON.stringify(options.disallowedTools)}: an explicit empty allow list must take the bypass floor off`);
    }
  } else if (JSON.stringify(options.disallowedTools) !== JSON.stringify(expect.disallowedTools)) {
    problems.push(`options.disallowedTools is ${JSON.stringify(options.disallowedTools)}, expected ${JSON.stringify(expect.disallowedTools)}`);
  }
  return problems;
}

/** `claude --version` prints `2.1.280 (Claude Code)`. Anything else is not the CLI. */
export function parseCliVersion(output: string): string | null {
  const match = /^(\d+\.\d+\.\d+)\b/.exec(output.trim());
  return match === null ? null : (match[1] ?? null);
}

/**
 * True for a shell-script launcher (for example the per-profile `claude` shim this host puts on
 * PATH inside account sessions). Such a launcher can re-pin the account the probe pinned, so
 * the probe refuses it and asks for the real binary. A node-script CLI (`#!/usr/bin/env node`) is
 * the CLI itself and passes.
 */
export function isShellWrapper(head: string): boolean {
  const firstLine = head.split('\n', 1)[0] ?? '';
  return /^#!.*\b(ba|z|da|k)?sh\b/.test(firstLine);
}
