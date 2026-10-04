import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONSERVATIVE_BYPASS_DENY, WEBFETCH_PRIVATE_DENY } from '@verdandi/claude-runtime';
import * as old from './b3aa188/generated/runtime.js';
import {
  CLASSIFY_READS_TURN_FIELDS,
  CLIENT_REACHABLE_ERRORS,
  COMPLETION_CAPABILITIES,
  COMPLETION_CLIENT_CREATE_REQUESTS,
  COMPLETION_CLIENT_PROTOCOL_MAJOR,
  GOLDEN_EFFORT,
  GOLDEN_FOLLOW_UP_INPUT,
  GOLDEN_INPUT,
  GOLDEN_MODEL,
  GOLDEN_SCHEMA,
  GOLDEN_SESSION_ID,
  GOLDEN_SYSTEM_PROMPT,
  RUNNER_MALFORMED_STATUS_CODES,
  STRUCTURED_OUTPUT_CARRIER,
  WEB_COMPLETION_TOOLS,
  WEB_TOOL_CAPABILITIES,
  completionGoldenRequests,
} from './completionClient.js';
import { HOST_CLI_PATH, errorOf, withHarness, type Harness, type Watcher } from './harness.js';
import { COMPLETION_GOLDEN_REQUESTS } from './paths.js';

/**
 * (c) The completion client and the pipeline client play against the sidecar of this checkout.
 *
 * Verdandi's two Go clients are the ones most exposed to a sidecar change that "only removes an
 * implicit default", because each leans on one: the completion client relies on the sidecar adding the
 * WebFetch deny rules itself, on it holding a completion's first turn until the account is known, and on
 * its check of the init tool list; the pipeline client relies on the absence of a bypass floor. This is
 * the suite that holds those, the way oldClient.conformance.test.ts holds Eitri's.
 *
 * The requests are the golden bytes of b3aa188's clients (b3aa188/completion-client-requests.txt),
 * produced by the clients' real request construction, decoded and replayed here with the FROZEN
 * TypeScript client against the real sidecar (`startSidecar`, the real kernel, the production session
 * mapping) over a real unix socket, with only the Claude SDK replaced by a scripted fake (fakeSdk.ts;
 * nothing billed, nothing spawned). Every scenario runs through `withHarness`, so the rule that no event
 * an old client cannot decode reaches it holds here too.
 *
 *   - the golden file, and that the frozen client and completionClient.ts encode the same bytes
 *   - handshake: the capabilities each client requires, `egress_restricted` only when started restricted,
 *     account binding
 *   - the zero-tool completion: what the SDK is told, the first-turn hold against a late accountInfo(),
 *     SessionReady's identity and fingerprint, TurnCompleted's structured output, usage and subtype, and
 *     the failure fields the error-class table reads
 *   - the web completion: every WEBFETCH_PRIVATE_DENY entry, and the init check in both directions
 *   - the pipeline: no bypass floor, no policy notice, no gate, no hold, a follow-up turn
 *   - the errors the clients map
 */

const golden = completionGoldenRequests();

const GOLDEN_NAMES = [
  'handshake',
  'completion_create_zero_tool',
  'completion_create_zero_tool_default_model',
  'completion_create_web_tools',
  'pipeline_create_bypass',
  'pipeline_create_bypass_profile',
  'watch_available_history',
  'completion_send_turn',
  'pipeline_send_turn',
  'pipeline_send_turn_followup',
  'resolve_permission_deny',
  'close_session',
];

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * What ts-proto's encoder does that Go's does not: a PRESENT, EMPTY packed repeated field is written as a
 * zero-length entry (`0a00` inside the `setting_sources` message), where the Go client writes the message
 * with no content (`3a00`). Both mean "present, no sources" to every decoder -- the sidecar reads presence,
 * not bytes -- so for a request that has an empty source list a TypeScript re-encode is held to the golden
 * request's MEANING (decode, encode, decode is the identity) and the sidecar is always sent the golden bytes
 * themselves. Every other request must re-encode to the identical bytes.
 */
function hasEmptySourceList(bytes: Uint8Array): boolean {
  return old.CreateSessionRequest.decode(bytes).policy?.settingSources?.sources.length === 0;
}

function golden_(name: string): Buffer {
  const bytes = golden.get(name);
  if (bytes === undefined) {
    throw new Error(`no golden request named ${name}`);
  }
  return bytes;
}

// ---- Replaying a golden request ---------------------------------------------------------------

/** CreateSession with the golden bytes, sent raw, or with `edit` applied to the decoded request first. */
async function create(h: Harness, name: string, edit?: (request: old.CreateSessionRequest) => void): Promise<string> {
  let bytes: Uint8Array = golden_(name);
  if (edit !== undefined) {
    const request = old.CreateSessionRequest.decode(bytes);
    edit(request);
    bytes = old.CreateSessionRequest.encode(request).finish();
  }
  return old.CreateSessionResponse.decode(await h.raw('CreateSession', Buffer.from(bytes))).sessionId;
}

/** A session-addressed golden request names the placeholder session `S`; the real sidecar minted another id, so only that is substituted. */
function watchGolden(h: Harness, sessionId: string): Watcher {
  const request = old.WatchSessionEventsRequest.decode(golden_('watch_available_history'));
  assert.equal(request.sessionId, GOLDEN_SESSION_ID);
  request.sessionId = sessionId;
  return h.watch(request);
}

async function sendGolden(h: Harness, name: string, sessionId: string): Promise<old.SendTurnResponse> {
  const request = old.SendTurnRequest.decode(golden_(name));
  request.sessionId = sessionId;
  return old.SendTurnResponse.decode(await h.raw('SendTurn', Buffer.from(old.SendTurnRequest.encode(request).finish())));
}

async function closeGolden(h: Harness, sessionId: string): Promise<void> {
  const request = old.CloseSessionRequest.decode(golden_('close_session'));
  request.sessionId = sessionId;
  await h.raw('CloseSession', Buffer.from(old.CloseSessionRequest.encode(request).finish()));
}

async function resolveGolden(h: Harness, sessionId: string): Promise<Buffer> {
  const request = old.ResolvePermissionRequest.decode(golden_('resolve_permission_deny'));
  request.sessionId = sessionId;
  return h.raw('ResolvePermission', Buffer.from(old.ResolvePermissionRequest.encode(request).finish()));
}

/** What `SessionEvent.event` holds, by arm, in arrival order. */
function arms(watch: Watcher): string[] {
  return watch.events.map((event) => (['sessionReady', 'turnStarted', 'turnCompleted', 'sessionClosed', 'permissionRequested', 'providerNotice'] as const).find((arm) => event[arm] !== undefined) ?? 'other');
}

/**
 * Every WebFetch deny rule b3aa188's sidecar added for a session that allows WebFetch, written out so that a rule
 * deleted from the runtime package's constant is noticed (the live-constant check below cannot see that). Two
 * entries of the original list name the owner's own domain; that is private text the public export rewrites, so
 * they are left out here and only the live-constant check holds them.
 */
const WEBFETCH_DENY_B3AA188_PUBLIC: readonly string[] = [
  'WebFetch(domain:localhost)',
  'WebFetch(domain:*.localhost)',
  'WebFetch(domain:0.0.0.0)',
  'WebFetch(domain:10.*.*.*)',
  'WebFetch(domain:100.*.*.*)',
  'WebFetch(domain:127.*.*.*)',
  'WebFetch(domain:169.254.*.*)',
  'WebFetch(domain:172.*.*.*)',
  'WebFetch(domain:192.168.*.*)',
  'WebFetch(domain:198.18.*.*)',
  'WebFetch(domain:198.19.*.*)',
  'WebFetch(domain:*.lan)',
  'WebFetch(domain:*.local)',
  'WebFetch(domain:*.internal)',
  'WebFetch(domain:*.home.arpa)',
  'WebFetch(domain:*.nip.io)',
  'WebFetch(domain:*.sslip.io)',
  'WebFetch(domain:*.localtest.me)',
  'WebFetch(domain:*.traefik.me)',
];

/** Lets the sidecar's pump (a 20 ms poll) and every promise it is waiting on run, so "nothing happened" can be asserted. */
const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MODEL_USAGE = { 'claude-fake-model': { inputTokens: 2, outputTokens: 900, cacheReadInputTokens: 23128, cacheCreationInputTokens: 31262, costUSD: 0.0612 } };

// ---- The golden file -----------------------------------------------------------------------------

test('the golden file lists each request of the completion and pipeline clients once, as hex, and says it is b3aa188\'s', () => {
  const text = readFileSync(COMPLETION_GOLDEN_REQUESTS, 'utf8');
  assert.match(text, /DO NOT REGENERATE THIS FILE FROM A LATER TREE/);
  const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
  assert.deepEqual(
    lines.map((line) => line.split('\t')[0]),
    GOLDEN_NAMES,
  );
  for (const line of lines) {
    assert.match(line.split('\t')[1] ?? '', /^([0-9a-f]{2})+$/, line);
  }
});

test('the golden bytes are what the frozen TypeScript client decodes and re-encodes, and what completionClient.ts builds', () => {
  const codecs: Record<string, { decode(bytes: Uint8Array): unknown; encode(message: never): { finish(): Uint8Array } }> = {
    handshake: old.HandshakeRequest as never,
    watch_available_history: old.WatchSessionEventsRequest as never,
    completion_send_turn: old.SendTurnRequest as never,
    pipeline_send_turn: old.SendTurnRequest as never,
    pipeline_send_turn_followup: old.SendTurnRequest as never,
    resolve_permission_deny: old.ResolvePermissionRequest as never,
    close_session: old.CloseSessionRequest as never,
  };
  for (const name of GOLDEN_NAMES) {
    const codec = codecs[name] ?? (old.CreateSessionRequest as never);
    const decoded = codec.decode(golden_(name));
    const again = codec.encode(decoded as never).finish();
    if (!(name.includes('_create_') && hasEmptySourceList(golden_(name)))) {
      assert.equal(hex(again), hex(golden_(name)), `${name}: decode then encode`);
    }
    // Whatever the bytes, the decoded request survives its own re-encoding unchanged.
    assert.deepEqual(codec.decode(again), decoded, `${name}: decode, encode, decode`);
  }
  // The requests, written down as data (completionClient.ts), encode to the same bytes the clients' own code produced.
  assert.deepEqual(Object.keys(COMPLETION_CLIENT_CREATE_REQUESTS), GOLDEN_NAMES.filter((name) => name.includes('_create_')));
  for (const [name, build] of Object.entries(COMPLETION_CLIENT_CREATE_REQUESTS)) {
    const frozen = old.CreateSessionRequest.encode(old.CreateSessionRequest.decode(golden_(name))).finish();
    assert.equal(hex(build()), hex(frozen), `${name}: the same bytes the frozen client writes for the golden request`);
    if (!hasEmptySourceList(golden_(name))) {
      assert.equal(hex(build()), hex(golden_(name)), name);
    }
    assert.deepEqual(old.CreateSessionRequest.decode(build()), old.CreateSessionRequest.decode(golden_(name)), `${name}: the same request`);
  }
  // And the small ones say what they are for.
  assert.equal(old.HandshakeRequest.decode(golden_('handshake')).clientProtocolMajor, COMPLETION_CLIENT_PROTOCOL_MAJOR);
  const watch = old.WatchSessionEventsRequest.decode(golden_('watch_available_history'));
  assert.equal(watch.start, old.ReplayStart.REPLAY_START_AVAILABLE_HISTORY, 'neither client holds a cursor');
  assert.equal(watch.sessionId, GOLDEN_SESSION_ID);
  assert.deepEqual(
    [GOLDEN_INPUT, GOLDEN_FOLLOW_UP_INPUT],
    [old.SendTurnRequest.decode(golden_('completion_send_turn')).text, old.SendTurnRequest.decode(golden_('pipeline_send_turn_followup')).text],
  );
  assert.deepEqual(
    [`turn-${GOLDEN_SESSION_ID}`, `turn-${GOLDEN_SESSION_ID}`, `turn-2-${GOLDEN_SESSION_ID}`, `close-${GOLDEN_SESSION_ID}`],
    ['completion_send_turn', 'pipeline_send_turn', 'pipeline_send_turn_followup'].map((name) => old.SendTurnRequest.decode(golden_(name)).commandId).concat(old.CloseSessionRequest.decode(golden_('close_session')).commandId),
  );
  const deny = old.ResolvePermissionRequest.decode(golden_('resolve_permission_deny'));
  assert.equal(deny.allow, false);
  assert.ok(deny.reason.length > 0);
});

// ---- The handshake -------------------------------------------------------------------------------

for (const [egressRestricted, label] of [
  [undefined, 'started without egress proof'],
  [false, 'started with egress explicitly unproven'],
  [true, 'started egress-restricted'],
] as const) {
  test(`handshake, ${label}: major 3, the capabilities the completion client requires, and egress_restricted only when the process proved it`, async () => {
    await withHarness({ egressRestricted }, async (h) => {
      const response = old.HandshakeResponse.decode(await h.raw('Handshake', golden_('handshake')));
      assert.equal(response.protocolMajor, COMPLETION_CLIENT_PROTOCOL_MAJOR, 'a client of major 3 is answered with major 3');
      // `MissingCapabilities(CompletionCapabilities)`: a sidecar missing one is never routed a completion.
      assert.deepEqual(
        COMPLETION_CAPABILITIES.filter((capability) => !response.capabilities.includes(capability)),
        [],
        `current: ${response.capabilities.join(' ')}`,
      );
      // `MissingCapabilities(WebToolCapabilities)`: tool_allow_list always, egress_restricted only on proof.
      assert.deepEqual(
        WEB_TOOL_CAPABILITIES.filter((capability) => !response.capabilities.includes(capability)),
        egressRestricted === true ? [] : ['egress_restricted'],
      );
      assert.equal(response.capabilities.includes('egress_restricted'), egressRestricted === true);
      // `Identity().CLIVersion` and `SidecarVersion` are shown, never compared.
      assert.equal(response.actualClaudeCodeVersion, '2.1.283');
      assert.ok(response.sidecarVersion.length > 0);
    });
  });
}

test('handshake, account binding: unpinned shows empty strings, pinned shows the account name and config directory', async () => {
  await withHarness({}, async (h) => {
    const response = await h.handshake(3);
    assert.equal(response.accountBinding, old.AccountBinding.ACCOUNT_BINDING_UNPINNED);
    assert.equal(response.accountName, '');
    assert.equal(response.accountConfigDir, '');
  });
  const account = { name: 'acct-one', configDir: '/fake/accounts/acct-one', anthropicConfigDir: '' };
  await withHarness({ account }, async (h) => {
    const response = await h.handshake(3);
    assert.equal(response.accountBinding, old.AccountBinding.ACCOUNT_BINDING_PINNED);
    assert.equal(response.accountName, account.name);
    assert.equal(response.accountConfigDir, account.configDir);
  });
});

// ---- Zero-tool completion ------------------------------------------------------------------------

for (const [name, profiled] of [
  ['completion_create_zero_tool', true],
  ['completion_create_zero_tool_default_model', false],
] as const) {
  test(`zero-tool completion (${name}): what the SDK is told -- no built-in tools, no settings tiers, bypass, no gate, the prompt and the schema`, async () => {
    await withHarness({}, async (h) => {
      const sid = await create(h, name);
      assert.ok(sid.length > 0);
      const { options } = h.sdk.last;
      assert.deepEqual(options.tools, [], 'an explicit EMPTY allow list reaches the SDK as `[]` ("disable all built-in tools"), never as absent');
      assert.deepEqual(options.settingSources, [], 'an explicit empty source list loads no settings tier');
      assert.equal(options.permissionMode, 'bypassPermissions');
      assert.equal(options.persistSession, true, 'HOST_CLI persistence: the run\'s transcript lands where the billing meters read it');
      assert.equal(options.pathToClaudeCodeExecutable, HOST_CLI_PATH);
      assert.equal(options.cwd, '/work/run-1');
      assert.equal(options.systemPrompt, GOLDEN_SYSTEM_PROMPT, 'the prompt replaces Claude Code\'s own');
      assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: JSON.parse(GOLDEN_SCHEMA) });
      assert.equal(options.model, profiled ? GOLDEN_MODEL : undefined, 'an absent model is absent at the SDK');
      assert.equal(options.effort, profiled ? GOLDEN_EFFORT : undefined);
      // ISOLATED means no MCP connector can reach a completion run: strict config with an empty server map.
      assert.equal(options.strictMcpConfig, true);
      assert.deepEqual(options.mcpServers, {});
      // BYPASS installs no gate at all: the client's refusal of every PermissionRequested is for a request that cannot come.
      assert.equal(options.hooks, undefined);
      assert.equal(options.canUseTool, undefined);
      // No tool is allowed, so the WebFetch rules have nothing to protect and are not added.
      const denied = options.disallowedTools ?? [];
      assert.deepEqual(
        WEBFETCH_PRIVATE_DENY.filter((rule) => denied.includes(rule)),
        [],
      );
    });
  });
}

test('zero-tool completion: a whole turn -- SessionReady carries the identity and the init fingerprint, TurnCompleted the structured output, the usage and the subtype', async () => {
  await withHarness({}, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    const watch = watchGolden(h, sid);
    const { turnId } = await sendGolden(h, 'completion_send_turn', sid);
    assert.ok(turnId.length > 0);
    const provider = h.sdk.last;
    assert.equal(await provider.nextUserMessage(), GOLDEN_INPUT, 'the one user message reaches the CLI verbatim');

    provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER] });
    provider.assistant('msg_A', [{ type: 'tool_use', id: 'toolu_1', name: STRUCTURED_OUTPUT_CARRIER, input: { ok: true } }]);
    provider.result({ subtype: 'success', text: '', structuredOutput: { ok: true }, modelUsage: MODEL_USAGE });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `the turn never completed; saw ${arms(watch).join(', ')}`);

    const [ready] = watch.of('sessionReady');
    assert.equal(ready.permissionMode, 'bypassPermissions', 'what the provider is ACTUALLY running under');
    // Both are recorded with the run's result.
    assert.equal(ready.model, 'claude-fake-model');
    assert.ok(ready.providerSessionId.length > 0 && ready.providerSessionId !== sid, 'the provider\'s own session id, not the sidecar\'s');
    assert.equal(ready.accountIdentity?.email, 'fake-account@example.invalid', 'the proof of the account: accountInfo()\'s answer');
    assert.equal(ready.accountIdentity?.subscriptionType, 'pro');
    assert.equal(ready.accountIdentity?.error, undefined, 'an answered probe carries no error');
    assert.deepEqual(ready.initFingerprint?.tools, [STRUCTURED_OUTPUT_CARRIER]);
    assert.deepEqual(ready.initFingerprint?.mcpServers, []);
    assert.equal(ready.initFingerprint?.apiKeySource, 'none', 'billed to the login itself, which is what the account proof also requires');

    const [completed] = watch.of('turnCompleted');
    assert.equal(completed.turnId, turnId);
    assert.equal(completed.outcome, old.TurnOutcome.TURN_OUTCOME_COMPLETED);
    assert.equal(completed.isError, false);
    assert.equal(completed.resultSubtype, 'success');
    assert.equal(completed.terminalReason, 'completed');
    assert.equal(completed.structuredOutputJson, '{"ok":true}', 'structured output is JSON text, present');
    assert.deepEqual(
      { ...completed.usage },
      { inputTokens: 2n, outputTokens: 900n, cacheCreationInputTokens: 31262n, cacheReadInputTokens: 23128n, totalCostUsd: 0.0612, model: 'claude-fake-model' },
    );
    // The client refuses a turn that completed without a SessionReady, so it comes first; nothing here asks for a permission.
    const order = arms(watch);
    assert.ok(order.indexOf('sessionReady') >= 0 && order.indexOf('sessionReady') < order.indexOf('turnCompleted'), order.join(', '));
    assert.equal(watch.of('permissionRequested').length, 0);
    assert.equal(watch.of('sessionClosed').length, 0, 'a clean turn closes nothing: the client\'s own CloseSession does');

    // The close every run ends with, and the answer it never needs (the client ignores the reply).
    await closeGolden(h, sid);
    assert.ok(await watch.until(() => watch.of('sessionClosed').length === 1));
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_CLOSED_BY_HOST);
    watch.cancel();
  });
});

test('zero-tool completion: the first user message is HELD until accountInfo() settles, and SessionReady then carries the late answer', async () => {
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  const log: string[] = [];
  const accountInfo = async (): Promise<Record<string, unknown>> => {
    await answered;
    log.push('accountInfo answered');
    return { email: 'late@example.invalid', organization: 'Late Organization', subscriptionType: 'max', tokenSource: 'fake' };
  };
  await withHarness({ sdk: { accountInfo } }, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    const watch = watchGolden(h, sid);
    const { turnId } = await sendGolden(h, 'completion_send_turn', sid);
    const provider = h.sdk.last;
    const arrived = provider.nextUserMessage().then((text) => {
      log.push('first message reached the SDK');
      return text;
    });

    // SendTurn has returned a turn id, and the CLI has seen nothing: nothing is spent before the account is known.
    await settle();
    assert.deepEqual(provider.userMessages, [], 'the provider saw input before accountInfo() answered');
    assert.deepEqual(log, []);

    release();
    assert.equal(await arrived, GOLDEN_INPUT);
    assert.deepEqual(log, ['accountInfo answered', 'first message reached the SDK'], 'the answer comes first, then the message');

    provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER] });
    provider.result({ subtype: 'success', text: '', structuredOutput: { ok: true }, modelUsage: MODEL_USAGE });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    assert.equal(watch.of('turnCompleted')[0].turnId, turnId);
    assert.equal(watch.of('sessionReady')[0].accountIdentity?.email, 'late@example.invalid');
    watch.cancel();
    await closeGolden(h, sid);
  });
});

for (const [label, harnessOptions] of [
  ['accountInfo() rejects', { sdk: { accountInfo: () => Promise.reject(new Error('the CLI could not say')) } }],
  ['accountInfo() never answers within the probe\'s timeout', { sdk: { accountInfo: () => new Promise<Record<string, unknown>>(() => undefined) }, accountInfoTimeoutMs: 100 }],
] as const) {
  test(`zero-tool completion: when ${label}, the held message is still delivered and SessionReady reports the identity as unavailable (an error, no email)`, async () => {
    await withHarness(harnessOptions, async (h) => {
      const sid = await create(h, 'completion_create_zero_tool');
      const watch = watchGolden(h, sid);
      await sendGolden(h, 'completion_send_turn', sid);
      const provider = h.sdk.last;
      assert.equal(await provider.nextUserMessage(), GOLDEN_INPUT);
      provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER] });
      provider.result({ subtype: 'success', text: '', structuredOutput: { ok: true }, modelUsage: MODEL_USAGE });
      assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `saw ${arms(watch).join(', ')}`);
      // `checkIdentity` turns this into an unproven account; the client must be told, not left to read an absent identity.
      const identity = watch.of('sessionReady')[0].accountIdentity;
      assert.ok(identity !== undefined, 'an identity message is present');
      assert.ok((identity.error ?? '').length > 0, 'the error says why');
      assert.equal(identity.email, undefined);
      watch.cancel();
      await closeGolden(h, sid);
    });
  });
}

test('zero-tool completion: a tool beyond the carrier in system/init closes the session with TOOL_POLICY_VIOLATION, the failed turn first', async () => {
  await withHarness({}, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    const watch = watchGolden(h, sid);
    const { turnId } = await sendGolden(h, 'completion_send_turn', sid);
    const provider = h.sdk.last;
    assert.equal(await provider.nextUserMessage(), GOLDEN_INPUT);
    provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER, 'Bash'] });
    assert.ok(await watch.until(() => watch.of('sessionClosed').length === 1), `saw ${arms(watch).join(', ')}`);

    const order = arms(watch);
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_TOOL_POLICY_VIOLATION);
    // `RunCompletion` pairs the failed turn with the close that follows it, so that a violation is reported as one.
    assert.ok(watch.of('turnCompleted').length >= 1, `no failed turn before the close; saw ${order.join(', ')}`);
    assert.ok(order.indexOf('turnCompleted') < order.indexOf('sessionClosed'), order.join(', '));
    const failed = watch.of('turnCompleted')[0];
    assert.equal(failed.turnId, turnId);
    assert.equal(failed.outcome, old.TurnOutcome.TURN_OUTCOME_FAILED);
    assert.equal(failed.isError, true);
    watch.cancel();
  });
});

test('failed completion turns: every field the error-class table reads (subtype, terminal reason, API status, errors, outcome, structured output presence) reaches the client', async () => {
  const cases: Array<{ label: string; result: Parameters<Harness['sdk']['last']['result']>[0]; expect: Partial<Record<(typeof CLASSIFY_READS_TURN_FIELDS)[number], unknown>> }> = [
    {
      label: 'the schema was never satisfied',
      result: { subtype: 'error_max_structured_output_retries', terminalReason: 'structured_output_retry_exhausted', isError: true, extra: { errors: ['schema not satisfied'] } },
      // An error result carries its words in `errors`; `result_text` is the success subtype's alone.
      expect: { outcome: old.TurnOutcome.TURN_OUTCOME_FAILED, isError: true, resultText: '', resultSubtype: 'error_max_structured_output_retries', terminalReason: 'structured_output_retry_exhausted', errors: ['schema not satisfied'] },
    },
    {
      label: 'the login was refused (HTTP 401)',
      result: { subtype: 'error_during_execution', terminalReason: 'model_error', isError: true, extra: { api_error_status: 401, errors: ['Invalid API key: please run /login'] } },
      expect: { outcome: old.TurnOutcome.TURN_OUTCOME_FAILED, isError: true, resultSubtype: 'error_during_execution', terminalReason: 'model_error', apiErrorStatus: 401, errors: ['Invalid API key: please run /login'] },
    },
    {
      label: 'a usage window is exhausted',
      result: { subtype: 'error_during_execution', terminalReason: 'blocking_limit', isError: true, extra: { errors: ['usage limit reached'] } },
      expect: { outcome: old.TurnOutcome.TURN_OUTCOME_LIMIT_REACHED, isError: true, terminalReason: 'blocking_limit', errors: ['usage limit reached'] },
    },
    {
      label: 'a success without structured output (presence is what the client reads)',
      result: { subtype: 'success', text: 'plain words' },
      expect: { outcome: old.TurnOutcome.TURN_OUTCOME_COMPLETED, isError: false, resultText: 'plain words', resultSubtype: 'success', structuredOutputJson: undefined },
    },
  ];
  for (const { label, result, expect } of cases) {
    await withHarness({}, async (h) => {
      const sid = await create(h, 'completion_create_zero_tool');
      const watch = watchGolden(h, sid);
      await sendGolden(h, 'completion_send_turn', sid);
      const provider = h.sdk.last;
      await provider.nextUserMessage();
      provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER] });
      provider.result(result);
      assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `${label}: no TurnCompleted; saw ${arms(watch).join(', ')}`);
      const completed = watch.of('turnCompleted')[0] as unknown as Record<string, unknown>;
      for (const field of CLASSIFY_READS_TURN_FIELDS) {
        if (field in expect) {
          assert.deepEqual(completed[field], (expect as Record<string, unknown>)[field], `${label}: ${field}`);
        }
      }
      watch.cancel();
      await closeGolden(h, sid);
    });
  }
});

// ---- Web completion ------------------------------------------------------------------------------

test('web completion: the SDK gets the two tools, and every WEBFETCH_PRIVATE_DENY rule the sidecar adds on its own', async () => {
  await withHarness({ egressRestricted: true }, async (h) => {
    await create(h, 'completion_create_web_tools');
    const { options } = h.sdk.last;
    assert.deepEqual(options.tools, [...WEB_COMPLETION_TOOLS]);
    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.deepEqual(options.settingSources, []);
    // The client sends no deny rules of its own: these are the sidecar's. The constant is the runtime package's live one, never a copy,
    // so a rule added to it later is held here too and the private domain in it stays out of this file.
    assert.ok(WEBFETCH_PRIVATE_DENY.length > 0);
    const denied = options.disallowedTools ?? [];
    assert.deepEqual(
      WEBFETCH_DENY_B3AA188_PUBLIC.filter((rule) => !denied.includes(rule)),
      [],
      'a deny rule b3aa188 added is missing from the SDK\'s disallowedTools',
    );
    assert.deepEqual(
      WEBFETCH_PRIVATE_DENY.filter((rule) => !denied.includes(rule)),
      [],
      'a WebFetch deny rule is missing from the SDK\'s disallowedTools',
    );
    assert.ok(!denied.includes('WebFetch'), 'the tool itself stays available: only the matching fetches are refused');
    assert.equal(old.CreateSessionRequest.decode(golden_('completion_create_web_tools')).policy?.toolPolicy?.deny.length, 0, 'the client sent no deny rules');
  });
});

test('web completion: system/init reporting exactly the carrier and the two requested tools runs the turn to completion', async () => {
  await withHarness({ egressRestricted: true }, async (h) => {
    const sid = await create(h, 'completion_create_web_tools');
    const watch = watchGolden(h, sid);
    await sendGolden(h, 'completion_send_turn', sid);
    const provider = h.sdk.last;
    await provider.nextUserMessage();
    provider.init({ tools: [STRUCTURED_OUTPUT_CARRIER, 'WebFetch', 'WebSearch'] });
    provider.result({ subtype: 'success', text: '', structuredOutput: { ok: true }, modelUsage: MODEL_USAGE });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `saw ${arms(watch).join(', ')}`);
    assert.equal(watch.of('sessionClosed').length, 0);
    assert.deepEqual(watch.of('sessionReady')[0].initFingerprint?.tools, [STRUCTURED_OUTPUT_CARRIER, 'WebFetch', 'WebSearch']);
    assert.equal(watch.of('turnCompleted')[0].outcome, old.TurnOutcome.TURN_OUTCOME_COMPLETED);
    watch.cancel();
    await closeGolden(h, sid);
  });
});

for (const [label, tools] of [
  ['an extra tool', [STRUCTURED_OUTPUT_CARRIER, 'WebFetch', 'WebSearch', 'Bash']],
  ['WebFetch missing', [STRUCTURED_OUTPUT_CARRIER, 'WebSearch']],
  ['an empty tool list', []],
] as const) {
  test(`web completion: system/init with ${label} closes the session with TOOL_POLICY_VIOLATION`, async () => {
    await withHarness({ egressRestricted: true }, async (h) => {
      const sid = await create(h, 'completion_create_web_tools');
      const watch = watchGolden(h, sid);
      await sendGolden(h, 'completion_send_turn', sid);
      const provider = h.sdk.last;
      await provider.nextUserMessage();
      provider.init({ tools: [...tools] });
      assert.ok(await watch.until(() => watch.of('sessionClosed').length === 1), `the session was not closed; saw ${arms(watch).join(', ')}`);
      assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_TOOL_POLICY_VIOLATION);
      watch.cancel();
    });
  });
}

// ---- The pipeline client -------------------------------------------------------------------------

for (const [name, profiled] of [
  ['pipeline_create_bypass', false],
  ['pipeline_create_bypass_profile', true],
] as const) {
  test(`pipeline (${name}): bypass with ToolPolicy{unrestricted} -- no tool denied by the sidecar, no gate, the user's own settings, no web rules`, async () => {
    await withHarness({}, async (h) => {
      await create(h, name);
      const { options } = h.sdk.last;
      assert.equal(options.permissionMode, 'bypassPermissions');
      assert.equal(options.hooks, undefined, 'bypass installs no PreToolUse gate');
      assert.equal(options.canUseTool, undefined);
      // The conservative bypass floor is for a policy that says nothing about tools; this client states `unrestricted`, and an
      // investigator that cannot run a command is a failure no caller here can see.
      const denied = options.disallowedTools ?? [];
      assert.deepEqual(
        CONSERVATIVE_BYPASS_DENY.filter((tool) => denied.includes(tool)),
        [],
        'the bypass floor was applied to a session that stated `unrestricted`',
      );
      assert.deepEqual(
        WEBFETCH_PRIVATE_DENY.filter((rule) => denied.includes(rule)),
        [],
        'a session with no allow list keeps the network it always had',
      );
      assert.equal(options.tools, undefined, 'no allow list at all: the CLI\'s whole tool set');
      assert.deepEqual(options.settingSources, ['user', 'project', 'local'], 'NATIVE with no explicit sources defers to the operator\'s own settings');
      assert.equal(options.persistSession, true);
      assert.equal(options.pathToClaudeCodeExecutable, HOST_CLI_PATH);
      assert.equal(options.systemPrompt, undefined);
      assert.equal(options.outputFormat, undefined);
      assert.equal(options.model, profiled ? GOLDEN_MODEL : undefined);
      assert.equal(options.effort, profiled ? GOLDEN_EFFORT : undefined);
      assert.equal(options.strictMcpConfig, undefined);
    });
  });
}

test('pipeline: a first turn is not held for accountInfo(), SessionReady says bypassPermissions, no verdandi_policy notice is sent, and a follow-up turn on the same session works', async () => {
  const never = (): Promise<Record<string, unknown>> => new Promise(() => undefined);
  await withHarness({ sdk: { accountInfo: never } }, async (h) => {
    const sid = await create(h, 'pipeline_create_bypass');
    const watch = watchGolden(h, sid);
    const first = await sendGolden(h, 'pipeline_send_turn', sid);
    const provider = h.sdk.last;
    // An investigator's chain never waits on a CLI whose accountInfo() is slow or hangs: the message is at the SDK well inside
    // the probe's 20 s timeout, while the probe is still unanswered.
    await settle(300);
    assert.deepEqual(provider.userMessages, [GOLDEN_INPUT], 'the first turn was held for accountInfo()');
    assert.equal(await provider.nextUserMessage(), GOLDEN_INPUT);
    provider.init();
    provider.streamStart('msg_A');
    provider.streamText('found it');
    provider.assistant('msg_A', [{ type: 'text', text: 'found it' }]);
    provider.result({ subtype: 'success', text: 'found it', modelUsage: MODEL_USAGE });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `saw ${arms(watch).join(', ')}`);

    // The client rejects a successful bypass turn that had no SessionReady before it.
    const order = arms(watch);
    assert.ok(order.indexOf('sessionReady') >= 0 && order.indexOf('sessionReady') < order.indexOf('turnCompleted'), order.join(', '));
    const [ready] = watch.of('sessionReady');
    assert.equal(ready.permissionMode, 'bypassPermissions', 'the one place the effective mode is stated; the client refuses anything else');
    const [completed] = watch.of('turnCompleted');
    assert.equal(completed.turnId, first.turnId);
    assert.equal(completed.outcome, old.TurnOutcome.TURN_OUTCOME_COMPLETED);
    assert.equal(completed.resultText, 'found it');
    assert.equal(completed.isError, false);

    // The second turn (the retry the investigator path asks for): a fresh command id, the same session, a second system/init.
    const second = await sendGolden(h, 'pipeline_send_turn_followup', sid);
    assert.notEqual(second.turnId, first.turnId);
    assert.equal(await provider.nextUserMessage(), GOLDEN_FOLLOW_UP_INPUT);
    provider.init();
    provider.result({ subtype: 'success', text: 'again', modelUsage: MODEL_USAGE });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 2), `saw ${arms(watch).join(', ')}`);
    assert.equal(watch.of('turnCompleted')[1].turnId, second.turnId);
    assert.deepEqual(
      watch.of('sessionReady').map((each) => each.permissionMode),
      ['bypassPermissions', 'bypassPermissions'],
      'a second SessionReady is held to the same check',
    );

    // Nothing in the stream says a floor was applied: that announcement belongs to a bypass policy that stated nothing.
    const notices = watch.of('providerNotice').filter((notice) => notice.kind === 'verdandi_policy');
    assert.deepEqual(notices, []);
    await closeGolden(h, sid);
    assert.ok(await watch.until(() => watch.of('sessionClosed').length === 1));
    watch.cancel();
  });
});

// ---- Errors the clients map ----------------------------------------------------------------------

test('a refused CreateSession: an invalid policy or output format is INVALID_CONFIGURATION, travelling as the gRPC status the completion runner calls "malformed"', async () => {
  const refusals: Array<{ label: string; golden: string; edit: (request: old.CreateSessionRequest) => void }> = [
    {
      label: 'an empty tool name in the allow list',
      golden: 'completion_create_web_tools',
      edit: (request) => (request.policy!.toolPolicy!.allow!.tools = ['WebFetch', ' ']),
    },
    {
      label: 'unrestricted together with an allow list',
      golden: 'completion_create_web_tools',
      edit: (request) => (request.policy!.toolPolicy!.unrestricted = true),
    },
    {
      label: 'a tool in both deny and allow',
      golden: 'completion_create_web_tools',
      edit: (request) => (request.policy!.toolPolicy!.deny = ['WebFetch']),
    },
    {
      label: 'an output schema that is not JSON',
      golden: 'completion_create_zero_tool',
      edit: (request) => (request.outputFormat!.jsonSchemaJson = 'not json'),
    },
    {
      label: 'an output schema that is not an object',
      golden: 'completion_create_zero_tool',
      edit: (request) => (request.outputFormat!.jsonSchemaJson = '[1]'),
    },
    {
      label: 'a blank system prompt',
      golden: 'completion_create_zero_tool',
      edit: (request) => (request.systemPrompt = '  '),
    },
    {
      label: 'an effort the SDK does not define',
      golden: 'completion_create_zero_tool',
      edit: (request) => (request.effort = 'extreme'),
    },
  ];
  for (const { label, golden: name, edit } of refusals) {
    await withHarness({}, async (h) => {
      await assert.rejects(create(h, name, edit), (error) => {
        const { grpc: status, detail } = errorOf(error);
        assert.equal(detail?.code, old.ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, label);
        assert.ok((detail?.message ?? '').length > 0, `${label}: the message is kept`);
        assert.ok(RUNNER_MALFORMED_STATUS_CODES.includes(status), `${label}: gRPC status ${status}`);
        return true;
      });
      assert.equal(h.sdk.providers.length, 0, `${label}: no session was started`);
    });
  }
  // Each condition keeps its code and its gRPC status.
  const invalid = CLIENT_REACHABLE_ERRORS.find((entry) => entry.code === old.ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
  assert.ok(invalid !== undefined && RUNNER_MALFORMED_STATUS_CODES.includes(invalid.status));
});

test('after CloseSession every call on the session says SESSION_NOT_FOUND (NOT_FOUND), and a close of a closed session is never anything else', async () => {
  await withHarness({}, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    await closeGolden(h, sid);
    // The registry keeps the entry for one pump tick after a close; the kernel says "session is closed" then and the sidecar maps
    // it to the same code, so this holds on either side of the eviction.
    const notFound = (error: unknown): boolean => {
      const { grpc: status, detail } = errorOf(error);
      assert.equal(detail?.code, old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND);
      assert.equal(status, CLIENT_REACHABLE_ERRORS.find((entry) => entry.code === old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND)?.status);
      return true;
    };
    await assert.rejects(sendGolden(h, 'completion_send_turn', sid), notFound);
    await settle(); // past the eviction
    await assert.rejects(sendGolden(h, 'completion_send_turn', sid), notFound);
    const gone = watchGolden(h, sid);
    assert.ok(await gone.until(() => gone.ended));
    assert.equal(errorOf(gone.error).detail?.code, old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, 'WatchSessionEvents');
    // The deferred close of a run whose session already closed itself: the client ignores the answer, but it must be an answer.
    await assert.rejects(closeGolden(h, sid), notFound);
  });
});

test('a session the kernel closed itself (a violation) still answers the client\'s own CloseSession with success or SESSION_NOT_FOUND, nothing else', async () => {
  await withHarness({}, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    const watch = watchGolden(h, sid);
    await sendGolden(h, 'completion_send_turn', sid);
    await h.sdk.last.nextUserMessage();
    h.sdk.last.init({ tools: [STRUCTURED_OUTPUT_CARRIER, 'Bash'] });
    assert.ok(await watch.until(() => watch.of('sessionClosed').length === 1));
    await closeGolden(h, sid).catch((error: unknown) => {
      assert.equal(errorOf(error).detail?.code, old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND);
    });
    watch.cancel();
  });
});

test('ResolvePermission{allow:false} for a request that is not pending (bypass never emits one) is PERMISSION_NOT_FOUND; the client ignores the answer', async () => {
  await withHarness({}, async (h) => {
    const sid = await create(h, 'completion_create_zero_tool');
    await assert.rejects(resolveGolden(h, sid), (error) => {
      const { grpc: status, detail } = errorOf(error);
      assert.equal(detail?.code, old.ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND);
      assert.equal(status, CLIENT_REACHABLE_ERRORS.find((entry) => entry.code === old.ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND)?.status);
      return true;
    });
    await closeGolden(h, sid);
  });
});
