import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo, HookCallbackMatcher, HookInput, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, type ClaudeRuntimeSession, type QueryFn } from '../../src/session.js';
import { webFetchDenyFor } from '../../src/webFetchDeny.js';
import type { ClaudeAccount } from '../../src/account.js';
import type { ClaudeRuntimeEvent } from '../../src/types.js';
import type { MinimalQuery } from '../../src/queryTypes.js';
import { checkChildOptions } from './guard.js';
import type { CaseDef, CaseName } from './cases.js';
import { describeError, isObj, str, type Json } from './json.js';

/** The real SDK `Query` is a superset of this; `accountInfo()` is the one extra method M1 needs. */
export type ProbeQuery = MinimalQuery & { accountInfo(): Promise<AccountInfo> };
export type ProbeQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => ProbeQuery;

export type TimedMessage = { t_ms: number; message: unknown };

export type AccountInfoProbe = { ok: true; ms: number; info: AccountInfo } | { ok: false; ms: number; error: string };

export type CaseRecord = {
  case: CaseName;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  cwd: string;
  account: { name: string; configDir: string };
  /** What was actually handed to the SDK, minus env values other than the account tuple. */
  options_summary: Json | null;
  guard_violations: string[];
  /** Every raw SDK message the kernel pulled, in order, as received. */
  messages: TimedMessage[];
  /** The provider's own words when its message stream rejected (the kernel keeps them only for resumes). */
  next_rejection: string | null;
  kernel_events: ClaudeRuntimeEvent[];
  permission_requests: Array<{ permission_id: string; tool_name: string; decision: 'allow' | 'deny' }>;
  hook_observations: Array<{ t_ms: number; event: string; input: unknown }>;
  account_info_before_turn: AccountInfoProbe | null;
  account_info_after_turn: AccountInfoProbe | null;
  transcript: { path: string; entries: unknown[] } | null;
  timed_out: boolean;
  runner_error: string | null;
};

export type RunContext = {
  pinnedAccount: ClaudeAccount;
  cliPath: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** The only tool name the `interactive` case approves. */
  carrierHint: string;
  underlying: ProbeQueryFn;
  pollMs: number;
  settleMs: number;
  accountInfoTimeoutMs: number;
};

export type AccountInventory = {
  settings_hook_events: string[];
  enabled_plugins: string[];
  user_mcp_servers: string[];
  skill_dirs: string[];
  claude_md_present: boolean;
  claude_json_projects: number | null;
};

function readJson(path: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What the account's config dir COULD leak into a session -- the control for M1 Q4. An empty
 * observation means "closed" only when this says there was something to leak.
 */
export function inventoryAccount(configDir: string, claudeJsonPath: string = join(configDir, '.claude.json')): AccountInventory {
  const settings = readJson(join(configDir, 'settings.json'));
  // Passed in rather than derived: an account at the CLI's default location keeps it in $HOME, not
  // under the config dir (`accountGlobalConfigPath`).
  const claudeJson = readJson(claudeJsonPath);
  const hooks = settings?.hooks;
  const plugins = settings?.enabledPlugins;
  const mcp = claudeJson?.mcpServers;
  const projects = claudeJson?.projects;
  const skillsDir = join(configDir, 'skills');
  return {
    settings_hook_events: isObj(hooks) ? Object.keys(hooks).sort() : [],
    enabled_plugins: isObj(plugins) ? Object.entries(plugins).filter(([, on]) => on === true).map(([name]) => name).sort() : [],
    user_mcp_servers: isObj(mcp) ? Object.keys(mcp).sort() : [],
    skill_dirs: existsSync(skillsDir) ? readdirSync(skillsDir).sort() : [],
    claude_md_present: existsSync(join(configDir, 'CLAUDE.md')),
    claude_json_projects: isObj(projects) ? Object.keys(projects).length : null,
  };
}

export function readTranscript(configDir: string, sessionId: string | null): CaseRecord['transcript'] {
  const projects = join(configDir, 'projects');
  if (sessionId === null || !existsSync(projects)) {
    return null;
  }
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) {
      const entries = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line): unknown => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { unparsed: line };
          }
        });
      return { path, entries };
    }
  }
  return null;
}

function tap(real: ProbeQuery, sink: { messages: TimedMessage[]; rejection: string | null }, t0: number): MinimalQuery {
  return {
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      try {
        const result = await real.next();
        if (!result.done) {
          sink.messages.push({ t_ms: Date.now() - t0, message: result.value });
        }
        return result;
      } catch (err) {
        sink.rejection = describeError(err);
        throw err;
      }
    },
    async return(): Promise<IteratorResult<SDKMessage, void>> {
      return real.return(undefined);
    },
    async throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
      return real.throw(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    interrupt: () => real.interrupt(),
    close: () => real.close(),
    // The kernel asks this itself since P2 (the account-identity gate); forwarded, so the probe
    // measures the kernel's real behaviour rather than a query that cannot answer.
    accountInfo: () => real.accountInfo(),
    // Widened with MinimalQuery for SetPermissionMode; the probe never switches modes, forwarded so
    // the tap stays a faithful stand-in for the query it wraps.
    setPermissionMode: (mode) => real.setPermissionMode(mode),
  };
}

function observer(sink: CaseRecord['hook_observations'], t0: number): HookCallbackMatcher {
  return {
    hooks: [
      async (input: HookInput) => {
        sink.push({ t_ms: Date.now() - t0, event: input.hook_event_name, input });
        return {};
      },
    ],
  };
}

/**
 * Adds the probe's OBSERVERS (and the two emulations the proto lacks) at the one seam the kernel
 * offers -- the `Options` object `createSession` hands to `queryFn`. `systemPrompt` and
 * `outputFormat` are no longer patched here: since P2 they are kernel config fields
 * (`ClaudeSessionConfig.systemPrompt` / `.outputFormat`, set in `runCase`), so the probe measures
 * the kernel's own wiring -- including the zero-tools invariant, which only knows the structured
 * output carrier is permitted when the kernel itself was asked for an output format.
 */
function patchOptions(def: CaseDef, kernelOptions: Options, record: CaseRecord, t0: number): Options {
  const options: Options = { ...kernelOptions, includeHookEvents: true };
  options.hooks = { ...(kernelOptions.hooks ?? {}), InstructionsLoaded: [observer(record.hook_observations, t0)] };
  if (def.permissionModeOverride !== null) {
    options.permissionMode = def.permissionModeOverride;
  }
  if (Object.keys(def.extraEnv).length > 0) {
    options.env = { ...(kernelOptions.env ?? {}), ...def.extraEnv };
  }
  return options;
}

function summarize(options: Options, def: CaseDef): Json {
  const env = options.env ?? {};
  return {
    tools: options.tools ?? null,
    disallowedTools: options.disallowedTools ?? null,
    settingSources: options.settingSources ?? null,
    strictMcpConfig: options.strictMcpConfig ?? null,
    mcpServers: Object.keys(options.mcpServers ?? {}),
    permissionMode: options.permissionMode ?? null,
    persistSession: options.persistSession ?? null,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    systemPrompt_chars: typeof options.systemPrompt === 'string' ? options.systemPrompt.length : null,
    outputFormat: options.outputFormat !== undefined,
    includeHookEvents: options.includeHookEvents ?? null,
    hook_events: Object.keys(options.hooks ?? {}),
    env_account: {
      CLAUDE_PROFILE: env.CLAUDE_PROFILE ?? null,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,
      ANTHROPIC_CONFIG_DIR: env.ANTHROPIC_CONFIG_DIR ?? null,
    },
    env_extra_keys: Object.keys(def.extraEnv),
  };
}

async function probeAccountInfo(query: ProbeQuery, timeoutMs: number): Promise<AccountInfoProbe> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      query.accountInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`accountInfo() did not answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Date.now() - start, info };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: describeError(err) };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function providerSessionId(record: CaseRecord): string | null {
  for (const event of record.kernel_events) {
    if (event.type === 'session_ready') {
      return event.providerSessionId;
    }
  }
  for (const { message } of record.messages) {
    if (isObj(message) && str(message.session_id) !== null) {
      return str(message.session_id);
    }
  }
  return null;
}

function throwawayAccount(): { account: ClaudeAccount; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'm1-probe-throwaway-account-'));
  const account = { name: 'm1-throwaway', configDir: join(root, 'claude'), anthropicConfigDir: join(root, 'anthropic') };
  mkdirSync(account.configDir);
  mkdirSync(account.anthropicConfigDir);
  return { account, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function drive(session: ClaudeRuntimeSession, def: CaseDef, ctx: RunContext, record: CaseRecord, t0: number): Promise<void> {
  const { turnId } = session.sendTurn(def.userMessage);
  const deadline = t0 + def.timeoutMs;
  let settleUntil: number | null = null;
  while (true) {
    const now = Date.now();
    if (settleUntil !== null && now >= settleUntil) {
      return;
    }
    if (settleUntil === null && now >= deadline) {
      record.timed_out = true;
      await session.interrupt().catch(() => undefined);
      return;
    }
    for (const event of await session.pump()) {
      record.kernel_events.push(event);
      if (event.type === 'permission_requested') {
        // Every request, by id -- a turn can raise several (memory: one-turn-many-permission-requests).
        const allow = event.toolName === ctx.carrierHint;
        session.resolvePermission(event.permissionId, {
          allow,
          reason: allow ? 'm1 probe: the structured-output carrier' : 'm1 probe: only the carrier tool is allowed',
        });
        record.permission_requests.push({ permission_id: event.permissionId, tool_name: event.toolName, decision: allow ? 'allow' : 'deny' });
      }
      if ((event.type === 'turn_completed' && event.turnId === turnId) || event.type === 'session_closed') {
        settleUntil ??= Date.now() + ctx.settleMs;
      }
    }
    await sleep(ctx.pollMs);
  }
}

/**
 * Runs one case through the kernel's real `createSession` path. Never throws: every failure ends
 * up in the record, because a failed measurement is still a measurement.
 */
export async function runCase(def: CaseDef, ctx: RunContext): Promise<CaseRecord> {
  const t0 = Date.now();
  const cwd = mkdtempSync(join(tmpdir(), `m1-probe-${def.name}-`));
  const throwaway = def.account === 'throwaway' ? throwawayAccount() : null;
  const account = throwaway?.account ?? ctx.pinnedAccount;
  const record: CaseRecord = {
    case: def.name,
    started_at: new Date(t0).toISOString(),
    finished_at: '',
    duration_ms: 0,
    cwd,
    account: { name: account.name, configDir: account.configDir },
    options_summary: null,
    guard_violations: [],
    messages: [],
    next_rejection: null,
    kernel_events: [],
    permission_requests: [],
    hook_observations: [],
    account_info_before_turn: null,
    account_info_after_turn: null,
    transcript: null,
    timed_out: false,
    runner_error: null,
  };
  const sink = { messages: record.messages, rejection: null as string | null };
  const holder: { query?: ProbeQuery } = {};
  try {
    if (def.projectClaudeMd !== null) {
      writeFileSync(join(cwd, 'CLAUDE.md'), def.projectClaudeMd);
    }
    const queryFn: QueryFn = (params) => {
      const kernelOptions = params.options ?? {};
      const violations = checkChildOptions(kernelOptions, {
        account,
        cliPath: ctx.cliPath,
        permissionMode: def.policy.permissions === 'bypass' ? 'bypassPermissions' : undefined,
        settingSources: def.policy.settingSources ?? [],
        tools: def.policy.toolPolicy?.allow ?? [],
        disallowedTools: webFetchDenyFor(def.policy).length > 0 ? webFetchDenyFor(def.policy) : undefined,
      });
      if (violations.length > 0) {
        record.guard_violations.push(...violations);
        throw new Error(`probe guard refused to spawn: ${violations.join('; ')}`);
      }
      const options = patchOptions(def, kernelOptions, record, t0);
      record.options_summary = summarize(options, def);
      holder.query = ctx.underlying({ prompt: params.prompt, options });
      return tap(holder.query, sink, t0);
    };
    const session = createSession(
      {
        cwd,
        policy: def.policy,
        account,
        hostCliPath: ctx.cliPath,
        model: ctx.model,
        effort: ctx.effort,
        systemPrompt: def.systemPrompt,
        ...(def.outputSchema !== null ? { outputFormat: { type: 'json_schema' as const, schema: def.outputSchema } } : {}),
      },
      queryFn,
    );
    const query = holder.query;
    if (query === undefined) {
      throw new Error('createSession returned without calling queryFn');
    }
    // P2 wants the account proven BEFORE any turn is spent; whether the CLI answers this early is
    // itself one of the measurements.
    record.account_info_before_turn = await probeAccountInfo(query, ctx.accountInfoTimeoutMs);
    await drive(session, def, ctx, record, t0);
    record.account_info_after_turn = await probeAccountInfo(query, ctx.accountInfoTimeoutMs);
    session.close();
    for (let i = 0; i < 20; i += 1) {
      const events = await session.pump();
      record.kernel_events.push(...events);
      if (record.kernel_events.some((event) => event.type === 'session_closed')) {
        break;
      }
      await sleep(ctx.pollMs);
    }
    // The CLI flushes its transcript as it exits; give it the same settle window.
    await sleep(ctx.settleMs);
    record.transcript = readTranscript(account.configDir, providerSessionId(record));
  } catch (err) {
    record.runner_error = describeError(err);
  } finally {
    record.next_rejection = sink.rejection;
    record.finished_at = new Date().toISOString();
    record.duration_ms = Date.now() - t0;
    rmSync(cwd, { recursive: true, force: true });
    throwaway?.cleanup();
  }
  return record;
}
