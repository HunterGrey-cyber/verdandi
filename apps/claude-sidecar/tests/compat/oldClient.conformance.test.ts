import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as old from './b3aa188/generated/runtime.js';
import { MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE, MIN_SUPPORTED_CLI_VERSION, classifyCliVersion, compareVersions, parseVersion } from '../../src/cliCompatibility.js';
import { ALLOWED_UNDECODABLE_EVENT_ARMS, EITRI_020_CAPABILITIES, EITRI_020_PERMISSION_MODES, EITRI_READS_CAPABILITIES, classifyCliMode, eitriCodeOf, eitriCreate, goldenRequests, undecodableArms } from './eitri.js';
import { HOST_CLI_PATH, errorOf, withHarness, type Harness, type Watcher } from './harness.js';

/**
 * (b) The old-client conformance test: Eitri 0.2.0 plays against the sidecar of this checkout.
 *
 * "Eitri 0.2.0" here is the TypeScript client generated from the FROZEN proto (Verdandi b3aa188's
 * runtime.proto, the one Eitri links), sending Eitri's exact requests -- the golden bytes that
 * prost produces for them, replayed raw -- to the real sidecar (`startSidecar`, the real kernel,
 * the production session mapping) over a real unix socket, with only the Claude SDK replaced by a
 * scripted fake (fakeSdk.ts; nothing billed, nothing spawned). What it then asserts is what Eitri's
 * own code reads:
 *
 *   - handshake: client major 3 is answered with 3; the capabilities Eitri reads; `interactive`;
 *     `executable_*` last
 *   - CreateSession accepts exactly Eitri's request, and what the SDK is told is what Eitri's
 *     SETTING_SOURCES_NOTE and gating promise
 *   - SessionReady.permission_mode is `default`; envelope vs provider session ids
 *   - event semantics: AFTER_SEQUENCE replay, gapless sequence, EVENT_GAP, message_id splits,
 *     permission origins, ResolvePermission, outcomes, ResumeOutcome once, usage cumulative
 *   - errors: ErrorDetail in the status trailer, same condition -> same code (idempotency conflicts too)
 *   - the PreToolUse gate is matcher "*", and loss (interrupt, close, provider death, timeout) denies
 *   - the CLI gate does not tighten
 *   - no event reaches an old-client session that Eitri would drop silently (every scenario runs through
 *     `withHarness`, which checks the raw bytes of every event it watched)
 *
 * The proto itself is protoBreaking.test.ts; the real entry point's text, timing, environment and the
 * arguments the real CLI is started with are oldClient.process.test.ts.
 */

const golden = goldenRequests();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function watchRequest(sessionId: string, cursor: bigint): old.WatchSessionEventsRequest {
  return old.WatchSessionEventsRequest.fromPartial({ sessionId, start: old.ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: cursor });
}

/** What `SessionEvent.event` holds, by arm, in arrival order. */
function kinds(watch: Watcher): string[] {
  return watch.events.map(kindsOf);
}

function json(text: string): unknown {
  return JSON.parse(text);
}

/** Drives one gated tool call: the CLI asks the hook, the test waits for the request to reach the watcher. */
async function waitForRequest(watch: Watcher, count = 1): Promise<old.PermissionRequested> {
  assert.ok(await watch.until(() => watch.of('permissionRequested').length >= count), 'no PermissionRequested reached the watcher');
  return watch.of('permissionRequested')[count - 1];
}

/** Opens a session with Eitri's golden request, a watch from cursor 0 (AFTER_SEQUENCE, presence of zero), and starts a turn the CLI is now in. */
async function startTurn(h: Harness, text = 'hello'): Promise<{ sid: string; watch: Watcher; turnId: string }> {
  const sid = await h.createGolden('create_session_fresh_partial');
  const watch = h.watch(watchRequest(sid, 0n));
  const { turnId } = await h.sendTurn(sid, text);
  assert.equal(await h.sdk.last.nextUserMessage(), text, 'the turn text reaches the CLI verbatim');
  h.sdk.last.init();
  return { sid, watch, turnId };
}

// ---- The handshake -----------------------------------------------------------------

for (const [build, sdkBundledAvailable] of [
  ['packaged (what a public install meets)', false],
  ['checkout (a development machine)', true],
] as const) {
  test(`handshake, ${build}: client major 3 is answered with major 3, and every capability and mode Eitri 0.2.0 saw is still there`, async () => {
    await withHarness({ sdkBundledAvailable }, async (h) => {
      const response = await h.handshake(3);
      assert.equal(response.protocolMajor, 3, 'Eitri refuses any other answer (CLIENT_PROTOCOL_MAJOR)');
      // Displayed by Eitri, never compared: free to change, but they must still be there to show.
      assert.equal(typeof response.protocolMinor, 'number');
      assert.ok(response.sidecarVersion.length > 0, 'sidecar_version is shown in the panel');

      // Eitri only asks whether a capability is present, never where it sits in the list, so presence is
      // what is frozen; the relative order of the 24 is not (the `executable_*` entries below are the one
      // positional rule, because the packaged-runtime test depends on it).
      const missing = EITRI_020_CAPABILITIES.filter((capability) => !response.capabilities.includes(capability));
      assert.deepEqual(missing, [], `a capability Eitri 0.2.0 saw was removed.\n  frozen:  ${EITRI_020_CAPABILITIES.join(' ')}\n  current: ${response.capabilities.join(' ')}`);
      const firstExecutable = response.capabilities.findIndex((capability) => capability.startsWith('executable_'));
      assert.ok(firstExecutable >= 0, 'an executable_* capability is advertised');
      assert.ok(response.capabilities.slice(firstExecutable).every((capability) => capability.startsWith('executable_')), 'the executable_* entries stay last');
      assert.ok(response.capabilities.includes('executable_host_cli'));
      assert.equal(response.capabilities.includes('executable_sdk_bundled'), sdkBundledAvailable);

      for (const mode of EITRI_020_PERMISSION_MODES) {
        assert.ok(response.permissionModes.includes(mode), `permission mode ${mode} is gone`);
      }
      // `require_interactive`: Eitri starts no session on a sidecar without it.
      assert.ok(response.permissionModes.includes('interactive'));

      // Eitri's `capabilities_from_handshake` and `provider_prompts_from_handshake`, as booleans.
      for (const capability of EITRI_READS_CAPABILITIES) {
        assert.ok(response.capabilities.includes(capability), `Eitri reads ${capability}`);
      }
    });
  });
}

test('handshake: a client of a foreign major is refused with INCOMPATIBLE_PROTOCOL in the ErrorDetail trailer', async () => {
  await withHarness({}, async (h) => {
    await assert.rejects(h.handshake(1000), (error) => {
      const { detail } = errorOf(error);
      assert.equal(detail?.code, old.ErrorCode.ERROR_CODE_INCOMPATIBLE_PROTOCOL);
      assert.ok((detail?.message ?? '').length > 0);
      return true;
    });
  });
});

// ---- Eitri's exact request ---------------------------------------------------------------------

/** Eitri's requests, built with the FROZEN TypeScript client's types. */
const eitriRequests: Record<string, () => Uint8Array> = {
  handshake: () => old.HandshakeRequest.encode(old.HandshakeRequest.fromPartial({ clientProtocolMajor: 3 })).finish(),
  create_session_fresh_partial: () => old.CreateSessionRequest.encode(eitriCreate('/tmp/p', old.StreamingMode.STREAMING_MODE_PARTIAL)).finish(),
  create_session_fresh_complete: () => old.CreateSessionRequest.encode(eitriCreate('/tmp/p', old.StreamingMode.STREAMING_MODE_COMPLETE)).finish(),
  create_session_resume_partial: () => old.CreateSessionRequest.encode(eitriCreate('/tmp/p', old.StreamingMode.STREAMING_MODE_PARTIAL, 'claude-id')).finish(),
  watch_after_sequence_0: () => old.WatchSessionEventsRequest.encode(watchRequest('S', 0n)).finish(),
  watch_after_sequence_5: () => old.WatchSessionEventsRequest.encode(watchRequest('S', 5n)).finish(),
  send_turn: () => old.SendTurnRequest.encode(old.SendTurnRequest.fromPartial({ sessionId: 'S', commandId: 'c1', text: 'hello' })).finish(),
  interrupt_turn: () => old.InterruptTurnRequest.encode(old.InterruptTurnRequest.fromPartial({ sessionId: 'S', commandId: 'c1' })).finish(),
  resolve_permission_allow: () => old.ResolvePermissionRequest.encode(old.ResolvePermissionRequest.fromPartial({ sessionId: 'S', commandId: 'c1', permissionId: 'p1', allow: true })).finish(),
  resolve_permission_deny: () =>
    old.ResolvePermissionRequest.encode(old.ResolvePermissionRequest.fromPartial({ sessionId: 'S', commandId: 'c1', permissionId: 'p1', allow: false, reason: 'not now' })).finish(),
  close_session: () => old.CloseSessionRequest.encode(old.CloseSessionRequest.fromPartial({ sessionId: 'S', commandId: 'c1' })).finish(),
};

test('the golden bytes are what the frozen TypeScript client encodes too: prost and ts-proto agree on every request Eitri sends', () => {
  assert.deepEqual([...Object.keys(eitriRequests)], [...golden.keys()]);
  for (const [name, bytes] of golden) {
    assert.equal(hex(eitriRequests[name]()), hex(bytes), `${name}`);
  }
});

test('Eitri\'s golden handshake and CreateSession bytes are accepted by the real sidecar, raw, and answered with what Eitri decodes', async () => {
  await withHarness({}, async (h) => {
    const handshake = old.HandshakeResponse.decode(await h.raw('Handshake', golden.get('handshake')!));
    assert.equal(handshake.protocolMajor, 3);
    for (const name of ['create_session_fresh_partial', 'create_session_fresh_complete', 'create_session_resume_partial']) {
      const sessionId = await h.createGolden(name);
      assert.ok(sessionId.length > 0, `${name}: CreateSession answered with a session id`);
    }
  });
});

test('what the SDK is told for Eitri\'s request: gated, project+local settings, partial streaming, no tool denied by name, no bypass switch', async () => {
  await withHarness({}, async (h) => {
    const sid = await h.createGolden('create_session_fresh_partial');
    const { options } = h.sdk.last;
    assert.notEqual(sid, 'claude-session-1', 'the session id CreateSession returns is the sidecar\'s own, not Claude\'s');

    // Why `default` is reported: INTERACTIVE is started in `default`, stated, so no settings tier can choose it.
    assert.equal(options.permissionMode, 'default');
    // SETTING_SOURCES_NOTE: what the panel tells the user every session loads.
    assert.deepEqual(options.settingSources, ['project', 'local']);
    assert.equal(options.includePartialMessages, true);
    assert.equal(options.persistSession, true, 'HOST_CLI persistence: the CLI keeps its own transcript');
    assert.equal(options.pathToClaudeCodeExecutable, HOST_CLI_PATH, 'HOST_CLI executable');
    assert.equal(options.cwd, '/tmp/p');

    // The gate is a PreToolUse hook whose matcher is "*", and there is exactly one of it.
    const preToolUse = options.hooks?.PreToolUse as Array<{ matcher?: string; hooks: unknown[] }> | undefined;
    assert.equal(preToolUse?.length, 1);
    assert.equal(preToolUse?.[0].matcher, '*');
    assert.equal(preToolUse?.[0].hooks.length, 1);
    assert.equal((preToolUse?.[0] as { timeout?: number }).timeout, undefined, 'no hook timeout is set: the CLI\'s own applies, and a timed-out call is refused');
    // permission_mode_switchable=false: the CLI is never launched able to be switched to bypass.
    assert.equal(options.allowDangerouslySkipPermissions, undefined);
    // provider_permission_prompts=true: the CLI's own asks reach the host.
    assert.equal(typeof options.canUseTool, 'function');

    // The second half of the gate, and `unrestricted`: the three tools Eitri has no card for stay removed
    // (a model that could call them would hang a turn), and nothing Eitri relies on is denied.
    const denied = options.disallowedTools ?? [];
    for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      assert.ok(denied.includes(tool), `${tool} must stay removed from a prompt-routed session`);
    }
    for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      assert.ok(!denied.includes(tool), `${tool} must not be denied: Eitri states tool_policy.unrestricted`);
    }
    assert.equal(options.tools, undefined, 'tool_policy.allow is absent, which is not the empty allow list');

    // Absent on the wire means absent at the SDK.
    assert.equal(options.model, undefined);
    assert.equal(options.effort, undefined);
    assert.equal(options.systemPrompt, undefined);
    assert.equal(options.outputFormat, undefined);
    assert.equal(options.resume, undefined);
    assert.equal(options.forkSession, undefined);
    // NATIVE leaves MCP and memory alone, and no account is pinned, so the SDK's own environment stands.
    assert.equal(options.strictMcpConfig, undefined);
    assert.equal(options.mcpServers, undefined);
    assert.equal(options.settings, undefined);
    assert.equal(options.env, undefined);
  });
});

test('the other two golden CreateSession shapes: COMPLETE streaming, and a resume that asks the CLI to resume exactly that id', async () => {
  await withHarness({}, async (h) => {
    await h.createGolden('create_session_fresh_complete');
    assert.equal(h.sdk.last.options.includePartialMessages, false);
    assert.equal(h.sdk.last.options.permissionMode, 'default');
    await h.createGolden('create_session_resume_partial');
    assert.equal(h.sdk.last.options.resume, 'claude-id');
    assert.equal(h.sdk.last.options.forkSession, undefined, 'fork is false');
    assert.equal(h.sdk.last.options.permissionMode, 'default', 'a resumed session is gated like any other');
    assert.deepEqual(h.sdk.last.options.settingSources, ['project', 'local']);
  });
});

// ---- A turn, the way Eitri reads it ---------------------------------------------------

test('a turn with a permission round trip: gapless events, the ids Eitri keys on, permission_mode `default`, message ids, usage', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch, turnId } = await startTurn(h);
    const provider = h.sdk.last;

    provider.streamStart('msg_A');
    provider.streamThinking('Which file first? ');
    provider.systemNotice('status', { status: 'requesting' });
    provider.streamText('Let me ');
    provider.streamText('look.');
    provider.assistant('msg_A', [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/p/a.txt' } },
    ]);
    const ask = provider.ask('Read', { file_path: '/p/a.txt' }, 'toolu_1');
    const requested = await waitForRequest(watch);
    assert.ok(requested.permissionId.length > 0);
    assert.equal(requested.origin, old.PermissionOrigin.PERMISSION_ORIGIN_HOOK, 'the gate\'s own request');
    assert.equal(requested.toolUseId, 'toolu_1', 'the card is linked to its tool call by id');
    assert.equal(requested.toolName, 'Read');
    assert.deepEqual(json(requested.inputJson), { file_path: '/p/a.txt' }, 'input_json parses: Eitri drops the event when it does not');
    assert.equal(requested.providerReason, undefined, 'provider_* fields are absent for a hook request');

    await h.resolve(sid, requested.permissionId, true);
    const answer = await ask.result;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'allow');

    provider.toolResult('toolu_1', 'file contents');
    provider.streamStart('msg_B');
    provider.streamText('All done.');
    provider.assistant('msg_B', [{ type: 'text', text: 'All done.' }]);
    const usage = { 'claude-fake-model': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.5 } };
    provider.result({ text: 'All done.', modelUsage: usage });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1), `the turn never completed; saw ${kinds(watch).join(', ')}`);

    // Gapless, monotonic, starting at 1: Eitri's SequenceTracker treats anything else as loss.
    assert.deepEqual(
      watch.events.map((event) => event.sequence),
      watch.events.map((_, index) => BigInt(index + 1)),
    );
    // Every event carries the SIDECAR's session id in the envelope (what Eitri addresses RPCs with).
    assert.ok(watch.events.every((event) => event.sessionId === sid));

    const [started] = watch.of('turnStarted');
    assert.equal(started.turnId, turnId, 'SendTurn\'s turn id is the one TurnStarted carries');

    const [ready] = watch.of('sessionReady');
    assert.equal(ready.providerSessionId, 'claude-session-1', 'provider_session_id is Claude\'s');
    assert.equal(ready.permissionMode, 'default', 'an INTERACTIVE session reports `default`');
    assert.equal(classifyCliMode(ready.permissionMode), 'default', 'Eitri\'s D12 tripwire stays quiet');

    // TextDelta.message_id splits messages: two API messages, two ids, each on its own deltas.
    const deltas = watch.of('textDelta');
    assert.deepEqual(
      deltas.map((delta) => [delta.messageId, delta.text]),
      [
        ['msg_A', 'Let me '],
        ['msg_A', 'look.'],
        ['msg_B', 'All done.'],
      ],
    );
    assert.ok(deltas.every((delta) => delta.turnId === turnId));

    // ThinkingDelta is its own arm (Eitri shows it as reasoning, and it never splits a message), and a
    // `system` message that is not init reaches Eitri as a ProviderNotice it only logs.
    assert.deepEqual(
      watch.of('thinkingDelta').map((delta) => [delta.turnId, delta.text, delta.messageId]),
      [[turnId, 'Which file first? ', 'msg_A']],
    );
    assert.deepEqual(
      watch.of('providerNotice').map((notice) => [notice.kind, notice.subtype]),
      [['system', 'status']],
    );

    const [call] = watch.of('toolCallStarted');
    assert.equal(call.toolUseId, 'toolu_1');
    assert.equal(call.name, 'Read');
    assert.deepEqual(json(call.inputJson), { file_path: '/p/a.txt' });
    const [result] = watch.of('toolCallCompleted');
    assert.equal(result.toolUseId, 'toolu_1');
    assert.equal(result.contentJson, JSON.stringify('file contents'), 'content_json parses too');
    assert.equal(result.isError, false);

    const [resolved] = watch.of('permissionResolved');
    assert.equal(resolved.permissionId, requested.permissionId);
    assert.equal(resolved.outcome, old.PermissionOutcome.PERMISSION_OUTCOME_ALLOWED);

    const [completed] = watch.of('turnCompleted');
    assert.equal(completed.outcome, old.TurnOutcome.TURN_OUTCOME_COMPLETED);
    assert.equal(completed.resultText, 'All done.');
    assert.deepEqual(
      { ...completed.usage },
      { inputTokens: 10n, outputTokens: 20n, cacheCreationInputTokens: 40n, cacheReadInputTokens: 30n, totalCostUsd: 0.5, model: 'claude-fake-model' },
    );

    // The order Eitri's projection depends on: the card exists before it is resolved, both before the turn ends.
    const order = kinds(watch);
    assert.ok(order.indexOf('permissionRequested') < order.indexOf('permissionResolved'));
    assert.ok(order.indexOf('permissionResolved') < order.indexOf('turnCompleted'));
    assert.ok(order.indexOf('toolCallStarted') < order.indexOf('toolCallCompleted'));

    // TurnUsage is CUMULATIVE for the session: a second turn reports the SDK's new running total, never a difference.
    await h.sendTurn(sid, 'again');
    assert.equal(await provider.nextUserMessage(), 'again');
    provider.init();
    provider.streamStart('msg_C');
    provider.streamText('More.');
    provider.assistant('msg_C', [{ type: 'text', text: 'More.' }]);
    provider.result({ text: 'More.', modelUsage: { 'claude-fake-model': { inputTokens: 15, outputTokens: 28, cacheReadInputTokens: 60, cacheCreationInputTokens: 40, costUSD: 0.75 } } });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 2));
    const second = watch.of('turnCompleted')[1];
    assert.equal(second.usage?.inputTokens, 15n);
    assert.equal(second.usage?.cacheReadInputTokens, 60n);
    assert.equal(second.usage?.totalCostUsd, 0.75);
    // system/init is re-sent every turn, and every one says `default`.
    assert.deepEqual(
      watch.of('sessionReady').map((each) => each.permissionMode),
      ['default', 'default'],
    );
    watch.cancel();
  });
});

test('COMPLETE streaming (the other golden shape): a reply arrives as whole messages, and TextDelta.message_id still splits them', async () => {
  await withHarness({}, async (h) => {
    const sid = await h.createGolden('create_session_fresh_complete');
    const watch = h.watch(watchRequest(sid, 0n));
    const { turnId } = await h.sendTurn(sid, 'hello');
    const provider = h.sdk.last;
    await provider.nextUserMessage();
    provider.init();
    provider.assistant('msg_X', [{ type: 'text', text: 'First message.' }]);
    provider.assistant('msg_Y', [{ type: 'text', text: 'Second message.' }]);
    provider.result({ text: 'Second message.' });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    assert.deepEqual(
      watch.of('textDelta').map((delta) => [delta.messageId, delta.text, delta.turnId]),
      [
        ['msg_X', 'First message.', turnId],
        ['msg_Y', 'Second message.', turnId],
      ],
    );
    watch.cancel();
  });
});

test('ResolvePermission{allow:false, reason}: the CLI is told to deny with the host\'s reason, and the outcome is DENIED', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const ask = h.sdk.last.ask('Bash', { command: 'rm -rf /' }, 'toolu_9');
    const requested = await waitForRequest(watch);
    await h.resolve(sid, requested.permissionId, false, 'not now');
    const answer = await ask.result;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(answer.hookSpecificOutput?.permissionDecisionReason, 'not now');
    assert.ok(await watch.until(() => watch.of('permissionResolved').length === 1));
    assert.equal(watch.of('permissionResolved')[0].outcome, old.PermissionOutcome.PERMISSION_OUTCOME_DENIED);
    // Answering twice is one condition with one code: there is nothing pending any more.
    await assert.rejects(h.resolve(sid, requested.permissionId, true), (error) => errorOf(error).detail?.code === old.ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND);
    watch.cancel();
  });
});

test('the CLI\'s own prompt arrives as PROVIDER_PROMPT with the CLI\'s words; allow runs the call unchanged, deny fails it with the host\'s reason', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    const input = { file_path: '/p/.git/probe', content: 'x' };
    const prompt = provider.prompt('Write', input, 'toolu_2', {
      decisionReason: 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.',
      description: '.git/probe',
      blockedPath: '/p/.git/probe',
      matchedAskRule: { source: 'projectSettings', toolName: 'Write', ruleContent: '.git/**' },
    });
    const requested = await waitForRequest(watch);
    assert.equal(requested.origin, old.PermissionOrigin.PERMISSION_ORIGIN_PROVIDER_PROMPT);
    assert.equal(requested.toolUseId, 'toolu_2');
    assert.equal(requested.providerReason, 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.');
    assert.equal(requested.providerDescription, '.git/probe');
    assert.equal(requested.providerBlockedPath, '/p/.git/probe');
    assert.deepEqual({ ...requested.providerMatchedAskRule }, { source: 'projectSettings', toolName: 'Write', ruleContent: '.git/**' });

    await h.resolve(sid, requested.permissionId, true);
    // Exactly `allow` with the CLI's own input: never the CLI's suggestions, never updatedPermissions.
    assert.deepEqual(await prompt.result, { behavior: 'allow', updatedInput: input });

    const second = provider.prompt('Write', input, 'toolu_3', { decisionReason: 'again' });
    const again = await waitForRequest(watch, 2);
    await h.resolve(sid, again.permissionId, false, 'sensitive files are off limits');
    assert.deepEqual(await second.result, { behavior: 'deny', message: 'sensitive files are off limits' });
    assert.ok(await watch.until(() => watch.of('permissionResolved').length === 2));
    assert.deepEqual(
      watch.of('permissionResolved').map((each) => each.outcome),
      [old.PermissionOutcome.PERMISSION_OUTCOME_ALLOWED, old.PermissionOutcome.PERMISSION_OUTCOME_DENIED],
    );
    watch.cancel();
  });
});

test('every TurnOutcome Eitri maps: COMPLETED, INTERRUPTED, FAILED and LIMIT_REACHED each come from the CLI\'s own terminal reason', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    const outcomes: old.TurnOutcome[] = [];
    for (const [terminalReason, subtype, expected] of [
      ['completed', 'success', old.TurnOutcome.TURN_OUTCOME_COMPLETED],
      ['aborted_streaming', 'error_during_execution', old.TurnOutcome.TURN_OUTCOME_INTERRUPTED],
      ['max_turns', 'error_max_turns', old.TurnOutcome.TURN_OUTCOME_LIMIT_REACHED],
      ['api_error', 'error_during_execution', old.TurnOutcome.TURN_OUTCOME_FAILED],
    ] as const) {
      if (outcomes.length > 0) {
        await h.sendTurn(sid, `again ${outcomes.length}`);
        await provider.nextUserMessage();
        provider.init();
      }
      provider.result({ subtype, terminalReason, isError: terminalReason !== 'completed' });
      const want = outcomes.length + 1;
      assert.ok(await watch.until(() => watch.of('turnCompleted').length === want), `no TurnCompleted for ${terminalReason}`);
      const got = watch.of('turnCompleted')[want - 1];
      assert.equal(got.outcome, expected, terminalReason);
      assert.equal(got.resultSubtype, subtype, 'the CLI\'s own words ride along');
      assert.equal(got.terminalReason, terminalReason);
      outcomes.push(got.outcome);
    }
    watch.cancel();
  });
});

// ---- Loss denies --------------------------------------------------------------------------------

test('InterruptTurn with a request pending: denied, CANCELLED_BY_INTERRUPT, the turn ends INTERRUPTED, and the session is still usable', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    const ask = provider.ask('Bash', { command: 'sleep 100' }, 'toolu_3');
    await waitForRequest(watch);
    const interrupted = provider.interrupted();
    await h.interrupt(sid);
    await interrupted;
    const answer = await ask.result;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'deny', 'the call the CLI was waiting on is refused');
    // The CLI ends the turn the way it ends an interrupted one.
    provider.result({ subtype: 'error_during_execution', terminalReason: 'aborted_tools', isError: true });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    assert.equal(watch.of('permissionResolved')[0].outcome, old.PermissionOutcome.PERMISSION_OUTCOME_CANCELLED_BY_INTERRUPT);
    assert.equal(watch.of('turnCompleted')[0].outcome, old.TurnOutcome.TURN_OUTCOME_INTERRUPTED);
    // Interrupt does not close the session.
    const next = await h.sendTurn(sid, 'and then');
    assert.ok(next.turnId.length > 0);
    watch.cancel();
  });
});

test('CloseSession with a request pending: denied, CANCELLED_BY_SESSION_CLOSE, SessionClosed CLOSED_BY_HOST, the stream ends, later calls say SESSION_NOT_FOUND', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const ask = h.sdk.last.ask('Bash', { command: 'make' }, 'toolu_4');
    await waitForRequest(watch);
    await h.close(sid);
    assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(await watch.until(() => watch.ended), 'the watch stream is completed after SessionClosed');
    assert.equal(watch.error, undefined, 'a clean end, not an error');
    assert.equal(watch.of('permissionResolved')[0].outcome, old.PermissionOutcome.PERMISSION_OUTCOME_CANCELLED_BY_SESSION_CLOSE);
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_CLOSED_BY_HOST);
    assert.equal(kinds(watch).at(-1), 'sessionClosed', 'SessionClosed is the last event');
    await assert.rejects(h.sendTurn(sid, 'too late'), (error) => errorOf(error).detail?.code === old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND);
  });
});

test('the provider dying with a request pending: denied, PROVIDER_FAILED, the turn FAILED, SessionClosed PROVIDER_FAILED', async () => {
  await withHarness({}, async (h) => {
    const { watch } = await startTurn(h);
    const provider = h.sdk.last;
    const ask = provider.ask('Bash', { command: 'make' }, 'toolu_5');
    await waitForRequest(watch);
    provider.fail(new Error('the claude process was killed'));
    assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(await watch.until(() => watch.ended));
    assert.equal(watch.of('permissionResolved')[0].outcome, old.PermissionOutcome.PERMISSION_OUTCOME_PROVIDER_FAILED);
    assert.equal(watch.of('turnCompleted')[0].outcome, old.TurnOutcome.TURN_OUTCOME_FAILED);
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_FAILED);
  });
});

test('the CLI giving up on a request (its hook timeout): denied and recorded EXPIRED, so a late answer cannot be recorded as allowed', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const ask = h.sdk.last.ask('Bash', { command: 'make' }, 'toolu_6');
    const requested = await waitForRequest(watch);
    ask.abort();
    assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(await watch.until(() => watch.of('permissionResolved').length === 1));
    assert.equal(watch.of('permissionResolved')[0].outcome, old.PermissionOutcome.PERMISSION_OUTCOME_EXPIRED);
    await assert.rejects(h.resolve(sid, requested.permissionId, true), (error) => errorOf(error).detail?.code === old.ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND);
    watch.cancel();
  });
});

// ---- Errors ------------------------------------------------------------------------------------

test('errors travel as ErrorDetail in grpc-status-details-bin, and each condition keeps its code', async () => {
  await withHarness({}, async (h) => {
    const code = (error: unknown): old.ErrorCode | undefined => errorOf(error).detail?.code;
    const sid = await h.createGolden('create_session_fresh_partial');

    // An id the sidecar never minted: every RPC that names a session says SESSION_NOT_FOUND.
    const missing = 'no-such-session';
    for (const [rpc, call] of [
      ['SendTurn', () => h.sendTurn(missing, 'x')],
      ['InterruptTurn', () => h.interrupt(missing)],
      ['ResolvePermission', () => h.resolve(missing, 'p', true)],
      ['CloseSession', () => h.close(missing)],
    ] as const) {
      await assert.rejects(call(), (error) => {
        assert.equal(code(error), old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, rpc);
        assert.ok((errorOf(error).detail?.message ?? '').length > 0, `${rpc}: the message is kept`);
        return true;
      });
    }
    const gone = h.watch(watchRequest(missing, 0n));
    assert.ok(await gone.until(() => gone.ended));
    assert.equal(code(gone.error), old.ErrorCode.ERROR_CODE_SESSION_NOT_FOUND, 'WatchSessionEvents');

    // A permission that is not pending.
    await assert.rejects(h.resolve(sid, 'no-such-permission', true), (error) => code(error) === old.ErrorCode.ERROR_CODE_PERMISSION_NOT_FOUND);

    // A second turn while one is in flight.
    await h.sendTurn(sid, 'first');
    await assert.rejects(h.sendTurn(sid, 'second'), (error) => code(error) === old.ErrorCode.ERROR_CODE_TURN_ALREADY_ACTIVE);

    // A cursor beyond anything the session ever emitted cannot have come from this stream.
    const future = h.watch(watchRequest(sid, 99_999n));
    assert.ok(await future.until(() => future.ended));
    assert.equal(code(future.error), old.ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'a future cursor');
  });
});

test('IDEMPOTENCY_CONFLICT: a command id reused with a different payload is refused with that code, on SendTurn and on ResolvePermission; the same payload replays the first answer', async () => {
  await withHarness({}, async (h) => {
    const code = (error: unknown): old.ErrorCode | undefined => errorOf(error).detail?.code;
    const sid = await h.createGolden('create_session_fresh_partial');

    // SendTurn: the first call starts a turn; the same id and text is the first call's answer again (no second turn)...
    const first = await h.sendTurn(sid, 'one', 'reused-turn-command');
    assert.deepEqual(await h.sendTurn(sid, 'one', 'reused-turn-command'), first, 'a retry of the same command is answered, not run twice');
    // ...and the same id with other text is a conflict -- and not TURN_ALREADY_ACTIVE, although a turn is in flight:
    // the idempotency check comes first.
    await assert.rejects(h.sendTurn(sid, 'two', 'reused-turn-command'), (error) => {
      assert.equal(code(error), old.ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
      assert.ok((errorOf(error).detail?.message ?? '').length > 0, 'the message is kept');
      return true;
    });

    // ResolvePermission: answered once under an id; the same answer again replays (it does not say PERMISSION_NOT_FOUND
    // although nothing is pending any more); the opposite answer under that id is the conflict.
    const watch = h.watch(watchRequest(sid, 0n));
    assert.equal(await h.sdk.last.nextUserMessage(), 'one');
    h.sdk.last.init();
    const ask = h.sdk.last.ask('Bash', { command: 'make' }, 'toolu_idem');
    const requested = await waitForRequest(watch);
    await h.resolve(sid, requested.permissionId, true, '', 'reused-answer-command');
    assert.equal((await ask.result).hookSpecificOutput?.permissionDecision, 'allow');
    await h.resolve(sid, requested.permissionId, true, '', 'reused-answer-command');
    await assert.rejects(h.resolve(sid, requested.permissionId, false, 'changed my mind', 'reused-answer-command'), (error) => {
      assert.equal(code(error), old.ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT);
      assert.ok((errorOf(error).detail?.message ?? '').length > 0, 'the message is kept');
      return true;
    });
    watch.cancel();
  });
});

test('InterruptTurn on a session with no turn in flight (after TurnCompleted, and before any turn) is answered OK, as it was, and leaves the session usable', async () => {
  // Eitri treats a provider error as survivable only for TurnAlreadyActive, NoActiveTurn, PermissionNotFound,
  // PermissionAlreadyResolved and IdempotencyConflict (`ProviderErrorCode::is_benign`); anything else tears the session down.
  // b3aa188 answers this call with success, never an error, so the call must keep being harmless.
  await withHarness({}, async (h) => {
    const fresh = await h.createGolden('create_session_fresh_partial');
    await h.interrupt(fresh);

    const { sid, watch } = await startTurn(h);
    h.sdk.last.result({ text: 'done' });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    await h.interrupt(sid);
    assert.equal(watch.of('turnCompleted').length, 1, 'an interrupt with nothing to interrupt ends nothing');
    const next = await h.sendTurn(sid, 'and then');
    assert.ok(next.turnId.length > 0, 'the session still takes a turn');
    watch.cancel();
  });
});

test('EVENT_GAP: a cursor older than the ring still holds is refused with EVENT_GAP, never silently skipped', async () => {
  await withHarness({ ringBufferCapacity: 4 }, async (h) => {
    const { sid } = await startTurn(h);
    const provider = h.sdk.last;
    provider.streamStart('msg_A');
    for (let i = 0; i < 12; i += 1) {
      provider.streamText(`chunk ${i} `);
    }
    // Let the pump drain them into the ring, then ask from the very beginning.
    const probe = h.watch(old.WatchSessionEventsRequest.fromPartial({ sessionId: sid, start: old.ReplayStart.REPLAY_START_AVAILABLE_HISTORY }));
    assert.ok(await probe.until((events) => events.length > 0 && events.at(-1)!.sequence >= 14n), 'the deltas were produced');
    probe.cancel();
    const lost = h.watch(watchRequest(sid, 0n));
    assert.ok(await lost.until(() => lost.ended));
    assert.equal(errorOf(lost.error).detail?.code, old.ErrorCode.ERROR_CODE_EVENT_GAP);
    assert.equal(lost.events.length, 0, 'no events are delivered across a hole');
  });
});

// ---- Replay --------------------------------------------------------------------------------------

test('AFTER_SEQUENCE: a watch from cursor k replays exactly the events after k, then goes live; a reconnect from the last delivered sequence loses nothing', async () => {
  await withHarness({}, async (h) => {
    const { sid, watch } = await startTurn(h);
    const provider = h.sdk.last;
    provider.streamStart('msg_A');
    provider.streamText('one ');
    provider.streamText('two ');
    provider.assistant('msg_A', [{ type: 'text', text: 'one two ' }]);
    provider.result({ text: 'one two ' });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    const all = watch.events.map((event) => event.sequence);
    assert.deepEqual(all, all.map((_, index) => BigInt(index + 1)), 'dense from 1');
    assert.ok(all.length >= 5);

    // Reconnect from the middle: exactly the tail, same events, same order.
    const cursor = all[2];
    const tail = h.watch(watchRequest(sid, cursor));
    assert.ok(await tail.until((events) => events.length === all.length - 3));
    assert.deepEqual(
      tail.events.map((event) => event.sequence),
      all.slice(3),
    );
    // Same events, not merely the same sizes: every field of every replayed event equals the live one
    // (the wire bytes, and the decoded values behind them).
    assert.deepEqual(
      tail.encoded.map((bytes) => bytes.toString('hex')),
      watch.encoded.slice(3).map((bytes) => bytes.toString('hex')),
    );
    assert.deepEqual(tail.events, watch.events.slice(3));

    // From the last delivered sequence: nothing replayed, and the next live event arrives.
    const live = h.watch(watchRequest(sid, all.at(-1)!));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(live.events.length, 0, 'nothing is replayed past the cursor');
    await h.sendTurn(sid, 'more');
    assert.ok(await live.until((events) => events.length >= 1));
    assert.equal(live.events[0].sequence, all.at(-1)! + 1n, 'the stream continues exactly where the cursor said');
    assert.ok(live.of('turnStarted').length === 1);
    for (const each of [watch, tail, live]) {
      each.cancel();
    }
  });
});

// ---- Resume --------------------------------------------------------------------------------------

test('resume, attached: ResumeOutcome ATTACHED carries the requested id, is sent once, and the sidecar\'s own session id is not Claude\'s', async () => {
  await withHarness({}, async (h) => {
    const sid = await h.createGolden('create_session_resume_partial');
    const watch = h.watch(watchRequest(sid, 0n));
    await h.sendTurn(sid, 'continue');
    await h.sdk.last.nextUserMessage();
    h.sdk.last.init();
    h.sdk.last.result({ text: 'ok' });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 1));
    await h.sendTurn(sid, 'and again');
    await h.sdk.last.nextUserMessage();
    h.sdk.last.init();
    h.sdk.last.result({ text: 'ok' });
    assert.ok(await watch.until(() => watch.of('turnCompleted').length === 2));

    const outcomes = watch.of('resumeOutcome');
    assert.equal(outcomes.length, 1, 'ResumeOutcome is emitted exactly once');
    assert.equal(outcomes[0].status, old.ResumeStatus.RESUME_STATUS_ATTACHED);
    assert.equal(outcomes[0].requestedProviderSessionId, 'claude-id');
    assert.equal(outcomes[0].attachedProviderSessionId, 'claude-id', 'equal means the requested session really continued');
    assert.equal(outcomes[0].forked, false);
    const [ready] = watch.of('sessionReady');
    assert.equal(ready.providerSessionId, 'claude-id');
    assert.notEqual(sid, 'claude-id', 'the sidecar mints its own session id for a resumed session');
    assert.ok(watch.events.every((event) => event.sessionId === sid));
    watch.cancel();
  });
});

test('resume, refused: ResumeOutcome REJECTED with a message, and the session closes PROVIDER_FAILED', async () => {
  await withHarness({ sdk: { rejectResume: true } }, async (h) => {
    const sid = await h.createGolden('create_session_resume_partial');
    const watch = h.watch(watchRequest(sid, 0n));
    assert.ok(await watch.until(() => watch.ended), `the stream never ended; saw ${kinds(watch).join(', ')}`);
    const [outcome] = watch.of('resumeOutcome');
    assert.equal(outcome.status, old.ResumeStatus.RESUME_STATUS_REJECTED);
    assert.equal(outcome.requestedProviderSessionId, 'claude-id');
    assert.equal(outcome.attachedProviderSessionId, '');
    assert.ok(outcome.detail.includes('No conversation found'), `the CLI's words reach the user: ${outcome.detail}`);
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_FAILED);
  });
});

test('resume, provider gone before it attached: ResumeOutcome INITIALIZATION_FAILED (never ATTACHED), and the session closes PROVIDER_EXITED', async () => {
  await withHarness({}, async (h) => {
    const sid = await h.createGolden('create_session_resume_partial');
    const watch = h.watch(watchRequest(sid, 0n));
    h.sdk.last.end();
    assert.ok(await watch.until(() => watch.ended), `the stream never ended; saw ${kinds(watch).join(', ')}`);
    const [outcome] = watch.of('resumeOutcome');
    assert.equal(outcome.status, old.ResumeStatus.RESUME_STATUS_INITIALIZATION_FAILED);
    assert.equal(outcome.attachedProviderSessionId, '');
    assert.equal(watch.of('sessionClosed')[0].reason, old.SessionCloseReason.SESSION_CLOSE_REASON_PROVIDER_EXITED);
  });
});

// ---- The CLI gate does not tighten ------------------------------------------------------------

/**
 * What b3aa188's `classifyCliVersion` (default policy: range >=2.1.252 <3.0.0, tested {2.1.252, 2.1.267,
 * 2.1.270}, nothing known-incompatible) answered, version by version, recorded by running it. Frozen as
 * data so that no later edit to the policy can move the verdicts under this test. `accepted` means "not
 * refused" (a diagnostic line on stderr is not a refusal).
 */
const CLI_VERDICTS_AT_B3AA188: ReadonlyArray<readonly [version: string, accepted: boolean]> = [
  ['0.0.1', false],
  ['1.9.9', false],
  ['2.0.0', false],
  ['2.0.999', false],
  ['2.1.0', false],
  ['2.1.251', false], // one below the floor
  ['2.1.252', true], // the floor itself, and the CLI bundled in the pinned SDK
  ['2.1.253', true],
  ['2.1.267', true],
  ['2.1.270', true],
  ['2.1.272', true],
  ['2.1.282', true],
  ['2.1.283', true], // the build in daily use
  ['2.1.999', true],
  ['2.2.0', true],
  ['2.10.0', true],
  ['2.99.99', true],
  ['2.100.0', true], // a ceiling below this would be a tightening
  ['2.999999.999999', true], // the largest 2.x there is: the ceiling is exclusive 3.0.0
  ['2.1.269-beta.1', true], // a suffix is ignored, as `claude --version` output is normalised before it gets here
  ['3.0.0', false], // the exclusive ceiling
  ['3.0.1', false],
  ['4.0.0', false],
  ['not-a-version', false],
  ['', false],
];

/** b3aa188's interval, written out independently of the policy's code: [2.1.252, 3.0.0). */
function acceptedByB3aa188Interval(major: number, minor: number, patch: number): boolean {
  return major === 2 && (minor > 1 || (minor === 1 && patch >= 252));
}

test('the CLI gate accepts at least everything b3aa188 accepted -- the supported range may widen, never shrink -- and the floor and the ceiling are held at their edges', () => {
  const widened: string[] = [];
  for (const [version, wasAccepted] of CLI_VERDICTS_AT_B3AA188) {
    const verdict = classifyCliVersion(version);
    if (wasAccepted) {
      assert.notEqual(verdict.kind, 'refused', `${version} was accepted at b3aa188 and must not be refused by default: ${verdict.kind === 'refused' ? verdict.diagnostic : ''}`);
    } else if (verdict.kind !== 'refused') {
      widened.push(version);
    }
  }
  // Widening is allowed; saying so keeps it a decision rather than an accident.
  if (widened.length > 0) {
    console.log(`note: the CLI gate now accepts versions b3aa188 refused: ${widened.join(', ')}`);
  }

  // The interval itself: the policy's own bounds must contain [2.1.252, 3.0.0). Samples alone cannot see a ceiling
  // moved to some version between them (2.1000000.0, say); the bounds can.
  const floor = parseVersion(MIN_SUPPORTED_CLI_VERSION);
  const ceiling = parseVersion(MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE);
  assert.ok(floor !== undefined && ceiling !== undefined, 'the policy bounds parse');
  assert.ok(compareVersions(floor, [2, 1, 252]) <= 0, `the floor ${MIN_SUPPORTED_CLI_VERSION} must not rise above 2.1.252`);
  assert.ok(compareVersions(ceiling, [3, 0, 0]) >= 0, `the exclusive ceiling ${MAX_SUPPORTED_CLI_VERSION_EXCLUSIVE} must not drop below 3.0.0`);

  // The interval, swept: every version inside [2.1.252, 3.0.0) is accepted, wherever a lower ceiling might have been put.
  for (const minor of [1, 2, 3, 5, 9, 10, 20, 50, 99, 100, 101, 150, 200, 500, 999, 1000, 10_000, 999_999]) {
    for (const patch of [0, 1, 251, 252, 253, 999, 999_999]) {
      if (acceptedByB3aa188Interval(2, minor, patch)) {
        const version = `2.${minor}.${patch}`;
        assert.notEqual(classifyCliVersion(version).kind, 'refused', `${version} is inside b3aa188's range`);
      }
    }
  }
});

// ---- Nothing that matters may live only in an event the old client cannot read ----------------------

test('the silent-event rule: an event arm outside Eitri 0.2.0\'s proto (or no arm at all) is reported unless it is allowlisted with a reason, and the allowlist is empty', () => {
  // Every scenario in this file runs through `withHarness`, which fails the scenario when a watch received such an
  // event (`assertNoSilentEvents`); this checks the rule itself, on events built by hand.
  const known = old.SessionEvent.encode(old.SessionEvent.fromPartial({ sessionId: 'S', sequence: 1n, turnStarted: { turnId: 't' } })).finish();
  assert.deepEqual(undecodableArms(known), []);
  // Field 23, length-delimited and empty: an arm a newer sidecar might add. The frozen decoder skips it...
  const futureArm = Uint8Array.from([...old.SessionEvent.encode(old.SessionEvent.fromPartial({ sessionId: 'S', sequence: 2n })).finish(), 0xba, 0x01, 0x00]);
  assert.equal(kindsOf(old.SessionEvent.decode(futureArm)), '(no arm)', 'the old client sees an event with no arm');
  // ...so only the wire bytes can say what it was, and it must be in the allowlist to be tolerated.
  assert.deepEqual(undecodableArms(futureArm), [23]);
  assert.deepEqual(undecodableArms(futureArm, new Map([[23, { name: 'PermissionAutoDenied', reason: 'written reason' }]])), []);
  assert.deepEqual(undecodableArms(old.SessionEvent.encode(old.SessionEvent.fromPartial({ sessionId: 'S', sequence: 3n })).finish()), [0], 'an event with no arm at all is reported too');
  assert.equal(ALLOWED_UNDECODABLE_EVENT_ARMS.size, 0, 'an entry needs a written reason; see eitri.ts');
});

function kindsOf(event: old.SessionEvent): string {
  return Object.keys(event).find((key) => !['sessionId', 'sequence', 'occurredAt', 'turnId'].includes(key) && (event as unknown as Record<string, unknown>)[key] !== undefined) ?? '(no arm)';
}

// ---- The decode rules Eitri leans on ----------------------------------------------------------

test('an ErrorCode no client knows reads as Unspecified by Eitri\'s rule, and every code it knows reads as itself', () => {
  const newer = old.ErrorDetail.decode(Uint8Array.from([0x08, 0x63, 0x12, 0x03, 0x6d, 0x73, 0x67])); // code = 99, message = "msg"
  assert.equal(newer.message, 'msg');
  assert.equal(eitriCodeOf(newer), old.ErrorCode.ERROR_CODE_UNSPECIFIED);
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    assert.equal(eitriCodeOf(old.ErrorDetail.fromPartial({ code: code as old.ErrorCode })), code);
  }
});
