import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CLI_PLAN_REJECT_FEEDBACK_OPENING, CLI_PLAN_REJECT_TEXT } from '../src/planBroker.js';
import type { InteractionResult } from '../src/interactionPort.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, InteractionRequestedEvent, InteractionResolvedEvent } from '../src/types.js';
import { drive } from './replay/drive.js';
import { fixtureRoot, loadRecording, type Line, type Wire } from './replay/recording.js';

/**
 * Plan mode against recordings of the kernel driving the pinned CLI (CLI 2.1.311, scripted model, no account; the
 * recording harness's `probe.mjs --kernel`). The recorded CLI frames are fed to a session that opted into plan mode;
 * the recorded `can_use_tool` request for `ExitPlanMode` is made to the session's callback at the point of the
 * recording where the CLI made it, and the plan interaction is settled the way the recorded host answered.
 */

type Controls = {
  exchanges: Line[];
  tool_results: Record<string, Wire>;
};

function policy(mode: 'auto' | 'default'): ClaudeHostPolicy {
  return {
    configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled',
    providerPermissionPrompts: true, cliPermissionMode: mode,
  };
}

function load(name: string): { controls: Controls; skip: boolean } {
  const present = existsSync(new URL(`${name}.core.control.json`, fixtureRoot)) && existsSync(new URL(`${name}.core.messages.json`, fixtureRoot));
  if (!present) assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: missing fixture`);
  return { controls: present ? JSON.parse(readFileSync(new URL(`${name}.core.control.json`, fixtureRoot), 'utf8')) : { exchanges: [], tool_results: {} }, skip: !present };
}

type Settled = { events: ClaudeRuntimeEvent[]; request: Wire; response: Wire; result: unknown };

/** Replays one recording with the plan callback made where the CLI made it and answered with `answer`. */
async function replayPlan(name: string, mode: 'auto' | 'default', controls: Controls, answer: (plan: string, sha: string) => InteractionResult): Promise<Settled> {
  const recording = loadRecording(`${name}.core`);
  try {
    const ask = controls.exchanges.find(l => l.from === 'cli' && l.message.request?.tool_name === 'ExitPlanMode');
    assert.ok(ask, `${name}: the recording holds the CLI's ExitPlanMode callback`);
    const request = ask.message.request;
    assert.equal(request.subtype, 'can_use_tool');
    const response = controls.exchanges.find(l => l.from === 'host' && l.message.response?.request_id === ask.message.request_id)?.message.response.response;
    assert.ok(response, `${name}: the recording holds the host's answer`);
    let options!: Options;
    let result: unknown;
    let done = false;
    const lines = recording.messages;
    const replay = await drive(lines, recording.directory, {
      config: { policy: policy(mode), clientInteractions: { questions: true, planMode: true } },
      onOptions: o => { options = o; },
      afterStep: async (index, session) => {
        // The callback comes at the recorded position: after the last frame the CLI sent before it, ahead of the next.
        if (done || !((lines[index].i ?? -1) < ask.i! && (lines[index + 1]?.i ?? Infinity) > ask.i!)) return;
        done = true;
        const pending = options.canUseTool!(request.tool_name, request.input, {
          requestId: ask.message.request_id, signal: new AbortController().signal, toolUseID: request.tool_use_id, suggestions: [],
        });
        await Promise.resolve();
        const open = session.interactions()!.pending();
        assert.equal(open.length, 1, `${name}: the callback opened one interaction`);
        assert.equal(open[0].kind, 'plan_approval');
        session.interactions()!.resolve(open[0].interactionId, answer(open[0].plan!.plan, open[0].plan!.planSha256));
        result = await pending;
      },
    });
    assert.ok(done, `${name}: the callback position was reached`);
    return { events: replay.events, request, response, result };
  } finally { recording.cleanup(); }
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const only = <T extends ClaudeRuntimeEvent['type']>(events: ClaudeRuntimeEvent[], type: T) =>
  events.filter((e): e is Extract<ClaudeRuntimeEvent, { type: T }> => e.type === type);
const reports = (events: ClaudeRuntimeEvent[]) => only(events, 'cli_mode_reported').map(e => e.permissionMode);

test('plan replay m40_exit: one plan interaction, plain allow, the mode after', async t => {
  for (const [name, mode, approvedInto] of [['m40_exit.plain', 'auto', 'auto'], ['m40_exit.default', 'default', 'manual']] as const) {
    const { controls, skip } = load(name);
    if (skip) { t.diagnostic(`${name}: fixture missing`); continue; }
    const settled = await replayPlan(name, mode, controls, (_plan, planSha256) => ({ kind: 'plan_approve', mode: approvedInto, planSha256 }));
    const { events, request, response, result } = settled;

    const requested = events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
    assert.equal(requested.length, 1, `${name}: one plan interaction`);
    assert.equal(requested[0].kind, 'plan_approval');
    assert.equal(requested[0].toolUseId, request.tool_use_id);
    assert.deepEqual(requested[0].plan, { plan: request.input.plan, planSha256: sha(request.input.plan), allowedPrompts: [] });
    assert.equal(only(events, 'permission_requested').length, 0, `${name}: a plan is settled on the plan, never as a permission ask`);

    const resolved = events.filter((e): e is InteractionResolvedEvent => e.type === 'interaction_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, 'approved');
    assert.equal(resolved[0].modeAfter, approvedInto);

    // A plain allow: no updatedInput, so the CLI never marks the plan edited. The recorded host sent exactly this.
    const { toolUseID, ...recorded } = response;
    assert.equal(toolUseID, request.tool_use_id);
    assert.deepEqual(result, recorded);
    assert.deepEqual(result, { behavior: 'allow' });

    // The mode after: the CLI went into plan once and came back to the mode the session was created in, whatever
    // "approve into" the host's label said, and the next init agrees.
    assert.deepEqual(reports(events), ['plan', mode], `${name}: the CLI's own reports`);
    const modes = only(events, 'session_ready').map(e => e.permissionMode);
    assert.equal(modes.at(-1), mode, `${name}: the next init is in the creation mode`);
    const index = (pred: (e: ClaudeRuntimeEvent) => boolean) => events.findIndex(pred);
    const approved = index(e => e.type === 'interaction_resolved');
    const back = index(e => e.type === 'cli_mode_reported' && e.permissionMode === mode);
    const toolResult = index(e => e.type === 'tool_call_completed' && e.toolUseId === request.tool_use_id);
    assert.ok(approved >= 0 && approved < back && back < toolResult, `${name}: approval, the mode report, then the model's result`);

    const seen = controls.tool_results[request.tool_use_id];
    assert.ok(seen, `${name}: the model's next request carries the CLI's result`);
    assert.notEqual(seen.is_error, true);
    assert.match(String(seen.content), /^User has approved your plan\./);
  }
});

test('plan replay m40_keep: the rejection text reaches the model', async t => {
  const FEEDBACK = 'PROBE-FEEDBACK: also update README.md';
  for (const [name, feedback, text] of [
    ['m40_keep.feedback', FEEDBACK, CLI_PLAN_REJECT_FEEDBACK_OPENING + FEEDBACK],
    ['m40_keep.empty', '', CLI_PLAN_REJECT_TEXT],
  ] as const) {
    const { controls, skip } = load(name);
    if (skip) { t.diagnostic(`${name}: fixture missing`); continue; }
    const { events, request, response, result } = await replayPlan(name, 'auto', controls, () => ({ kind: 'plan_keep', feedback }));

    const resolved = events.filter((e): e is InteractionResolvedEvent => e.type === 'interaction_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, 'kept_planning');
    assert.equal(resolved[0].feedback, feedback);

    // What the kernel answered the CLI is what the recorded host answered, and it is the terminal's own words.
    const { toolUseID, ...recorded } = response;
    assert.equal(toolUseID, request.tool_use_id);
    assert.deepEqual(result, recorded);
    assert.deepEqual(result, { behavior: 'deny', message: text });

    // The model read exactly that, as an error result: the CLI adds nothing to a host's deny message.
    const seen = controls.tool_results[request.tool_use_id];
    assert.ok(seen, `${name}: the model's next request carries a result for the plan call`);
    assert.equal(seen.is_error, true);
    assert.equal(seen.content, text);

    // Keeping the plan leaves the CLI in plan mode: it reports entering once and never leaving, and the next turn's
    // init still says plan.
    assert.deepEqual(reports(events), ['plan'], `${name}: the CLI's own reports`);
    assert.equal(only(events, 'session_ready').at(-1)?.permissionMode, 'plan');
  }
});

test('plan replay m40_enter: entry is reported once', async t => {
  const name = 'm40_enter.auto';
  const { controls, skip } = load(name);
  if (skip) { t.skip('fixture missing'); return; }
  const recording = loadRecording(`${name}.core`);
  try {
    const replay = await drive(recording.messages, recording.directory, {
      config: { policy: policy('auto'), clientInteractions: { questions: true, planMode: true } },
    });
    const { events } = replay;

    // The CLI never asks the host about EnterPlanMode (only its hook fires, and the gate abstains): no callback in the
    // recording, no interaction, no permission ask in the replay.
    assert.equal(controls.exchanges.some(l => l.message.request?.tool_name === 'EnterPlanMode'), false);
    assert.equal(only(events, 'interaction_requested').length, 0);
    assert.equal(only(events, 'permission_requested').length, 0);

    // One report of plan, from the status frame the CLI sends after the call: the next turn's init says plan again
    // and is not a second report. The report comes between the call starting and its result.
    assert.deepEqual(reports(events), ['plan']);
    assert.deepEqual(only(events, 'session_ready').map(e => e.permissionMode), ['auto', 'plan']);
    const index = (pred: (e: ClaudeRuntimeEvent) => boolean) => events.findIndex(pred);
    const started = index(e => e.type === 'tool_call_started' && e.name === 'EnterPlanMode');
    const reported = index(e => e.type === 'cli_mode_reported');
    const completed = index(e => e.type === 'tool_call_completed' && e.content !== undefined && String(e.content).startsWith('Entered plan mode.'));
    assert.ok(started >= 0 && started < reported && reported < completed, 'call started, mode reported, result');
    const seen = Object.values(controls.tool_results)[0];
    assert.ok(seen && seen.is_error !== true, 'the model was told it entered plan mode');
    assert.equal(replay.log.length, 0, `no diagnostics: ${replay.log.join('; ')}`);
  } finally { recording.cleanup(); }
});
