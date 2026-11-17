import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { createSession } from '../src/session.js';
import type { InteractionQuestion, InteractionRequestedEvent } from '../src/types.js';
import type { InteractionResult } from '../src/interactionPort.js';
import { QUESTION_NOT_OFFERED_TEXT, CLI_REJECT_TEXT } from '../src/questionBroker.js';
import { makeFakeQuery } from './fakeQuery.js';
import { fixtureRoot, type Line, type Wire } from './replay/recording.js';

const rows = ['c20', 'c20_auto', 'c20_manual', 'c20b', 'c20c', 'c20d', 'c20e', 'c20f', 'c20g', 'c20w', 'c20s', 'c20x', 'c20_off'];
type Golden = { questions: InteractionQuestion[]; answer: InteractionResult | null; outcome: string | null; updatedInput: Record<string, unknown> | null };
for (const name of rows) {
  test(`question replay ${name}: callback event, scripted answer and independent golden`, async t => {
    const file = new URL(`${name}.core.control.json`, fixtureRoot);
    if (!existsSync(file)) {
      assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: missing control fixture`);
      t.skip('fixture missing'); return;
    }
    const controls: { exchanges: Line[]; tool_results: Record<string, Wire>;
      model_requests: { file: string; tools: string[]; tool_use_ids: string[] }[] } = JSON.parse(readFileSync(file, 'utf8'));
    const golden: Golden = JSON.parse(readFileSync(new URL(`questions/${name}.json`, fixtureRoot), 'utf8'));
    const { query } = makeFakeQuery();
    let options!: Options;
    const session = createSession({ cwd: '/tmp', policy: {
      configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled', providerPermissionPrompts: true,
    }, ...(name === 'c20_off' ? {} : { clientInteractions: { questions: true } }) }, params => { options = params.options!; return query; });
    try {
      const asks = controls.exchanges.filter(l => l.from === 'cli' && l.message.request?.tool_name === 'AskUserQuestion');
      if (name === 'c20s') {
        assert.equal(asks.length, 0);
        assert.ok(controls.model_requests.some(r => r.tools.includes('AskUserQuestion')), 'parent is offered questions');
        const subagent = controls.model_requests.filter(r => r.tools.includes('SubagentHandback'));
        assert.ok(subagent.length > 0, 'subagent model request was captured');
        for (const request of subagent) assert.equal(request.tools.includes('AskUserQuestion'), false);
        assert.equal((await session.pump()).some(e => e.type === 'interaction_requested'), false);
        return;
      }
      if (name === 'c20_off') {
        assert.equal(asks.length, 0);
        assert.equal(session.interactions(), undefined);
        assert.deepEqual(await options.canUseTool!('AskUserQuestion', { questions: golden.questions }, {
          requestId: 'off-check', signal: new AbortController().signal, toolUseID: 'off-check', suggestions: [],
        }), { behavior: 'deny', message: QUESTION_NOT_OFFERED_TEXT });
        assert.equal((await session.pump()).some(e => e.type === 'interaction_requested'), false);
        t.diagnostic('Recorded off run made no question attempt; denial is checked through the callback only.');
        return;
      }
      assert.equal(asks.length, 1, `${name}: a recorded question callback is required`);
      const ask = asks[0].message;
      const request = ask.request;
      assert.equal(request.subtype, 'can_use_tool');
      assert.equal(request.requires_user_interaction, true);
      const pending = options.canUseTool!(request.tool_name, request.input, {
        requestId: ask.request_id, signal: new AbortController().signal, toolUseID: request.tool_use_id, suggestions: [],
        ...(typeof request.agent_id === 'string' ? { agentID: request.agent_id } : {}),
      });
      const events = await session.pump();
      const requested = events.filter((e): e is InteractionRequestedEvent => e.type === 'interaction_requested');
      assert.equal(requested.length, 1);
      assert.deepEqual(requested[0], { type: 'interaction_requested', interactionId: requested[0].interactionId,
        toolUseId: request.tool_use_id, kind: 'question', questions: golden.questions });
      assert.equal(events.some(e => e.type === 'permission_requested'), false);
      assert.deepEqual(session.interactions()!.pending(), requested);
      assert.equal((await session.pump()).some(e => e.type === 'interaction_resolved'), false, 'approval sweeps never answer questions');
      if (golden.answer) session.interactions()!.resolve(requested[0].interactionId, golden.answer);
      else if (name === 'c20f') await session.interrupt();
      else if (name === 'c20g') session.close();
      else assert.fail(`${name}: no scripted settlement`);
      const result = await pending;
      assert.ok(result);
      assert.deepEqual(result.behavior === 'allow' ? result.updatedInput : null, golden.updatedInput);
      const settled = (await session.pump()).filter(e => e.type === 'interaction_resolved');
      assert.equal(settled.length, 1);
      assert.equal(settled[0].outcome, golden.outcome);
      const response = controls.exchanges.find(l => l.from === 'host' && l.message.response?.request_id === ask.request_id)?.message.response.response;
      if (name !== 'c20g') {
        assert.ok(response, 'recorded callback response exists');
        const { toolUseID: _id, ...recordedResult } = response;
        assert.deepEqual(result, recordedResult);
      } else assert.equal(response, undefined, 'close ended the control stream before a response');
      const external = controls.tool_results[request.tool_use_id];
      if (name === 'c20b') {
        assert.deepEqual(result, { behavior: 'deny', message: CLI_REJECT_TEXT, interrupt: true });
        assert.equal(external, undefined, 'cancel ends the turn before a model-visible tool_result');
        assert.equal(controls.model_requests.some(r => r.tool_use_ids.includes(request.tool_use_id)), false,
          'no further model request includes the cancelled call');
        const recording: { lines: Line[] } = JSON.parse(readFileSync(new URL(`${name}.core.messages.json`, fixtureRoot), 'utf8'));
        const terminal = recording.lines.filter(l => l.from === 'cli' && l.message.type === 'result').at(-1)!.message;
        assert.equal(terminal.subtype, 'error_during_execution');
        assert.equal(terminal.terminal_reason, 'aborted_tools');
        assert.ok(terminal.permission_denials.some((d: Wire) => d.tool_use_id === request.tool_use_id));
        return;
      }
      assert.ok(external, `${name}: next model request must contain the CLI tool_result`);
      assert.equal(external.type, 'tool_result');
      assert.equal(external.tool_use_id, request.tool_use_id);
      assert.equal(typeof external.content, 'string');
      if (result.behavior === 'allow') {
        for (const answer of Object.values(golden.updatedInput!.answers as Record<string, string>)) assert.ok(external.content.includes(answer), answer);
        for (const annotation of Object.values(golden.updatedInput!.annotations as Record<string, { preview?: string; notes?: string }>)) {
          if (annotation.preview) assert.ok(external.content.includes(annotation.preview));
          if (annotation.notes) assert.ok(external.content.includes(annotation.notes));
        }
        assert.notEqual(external.is_error, true);
      } else {
        assert.equal(external.is_error, true);
        assert.equal(external.content, name === 'c20g'
          ? 'Tool permission request failed: AbortError: Tool permission stream closed before response received'
          : name === 'c20f' ? CLI_REJECT_TEXT : result.message);
      }
    } finally { session.close(); }
  });
}
