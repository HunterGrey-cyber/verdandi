import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRecording, fixtureRoot, type Line } from './replay/recording.js';
import { withoutLifecycle, c04c } from './replay/derive.js';
import { drive, remapUuids } from './replay/drive.js';
import { assertGapLedger, holdingGaps, gapPredicates } from './replay/gaps.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';
import { TaskOutputUnavailableError } from '../src/taskOutput.js';

const ledger: Record<string, string[]> = JSON.parse(readFileSync(new URL('gaps.json', fixtureRoot), 'utf8'));
const required = ['c01', 'c01c', 'c02b', 'c03_bg', 'c03_fg', 'c04a', 'c04b', 'c05', 'c05w', 'c07b', 'c15a', 'c15b', 'c16', 'c16w', 'c16w_stop.run2', 'c17',
  'c04d', 'c09', 'c10', 'c12', 'c13a', 'c13b', 'c14', 'c18',
  'h-clear', 'h-fallback', 'h-level-before-start', 'h-no-lifecycle', 'h-notices', 'h-peer', 'h-relabel', 'h-scheduled', 'h-wf1',
  'h19-subagent-stream', 'h20-partial-attempt'];
const recorded = readdirSync(fixtureRoot).filter(n => n.endsWith('.messages.json')).map(n => n.replace('.messages.json', ''));
const handbuiltRoot = new URL('handbuilt/', fixtureRoot);
const handbuilt = readdirSync(handbuiltRoot).filter(n => n.endsWith('.messages.json')).map(n => n.replace('.messages.json', ''));
for (const name of new Set([...required, ...recorded, ...handbuilt])) {
  const root = handbuilt.includes(name) ? handbuiltRoot : fixtureRoot;
  for (const variant of ['recorded', 'without-lifecycle', ...(name === 'c04a' ? ['c04c'] : [])]) {
    test(`CLI replay ${name} ${variant}`, async t => {
      if (!existsSync(new URL(`${name}.messages.json`, root))) {
        assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
        t.skip('fixture missing'); return;
      }
      const recording = loadRecording(name, root);
      try {
        if (!recording.manifest.stamped && variant !== 'without-lifecycle') { t.skip('unstamped: replay only without lifecycle'); return; }
        const messages = variant === 'without-lifecycle' ? withoutLifecycle(recording.messages) : variant === 'c04c' ? c04c(recording.messages) : recording.messages;
        const replay = await drive(messages, recording.directory);
        const key = `${name}${variant === 'recorded' ? '' : `.${variant}`}`;
        assert.ok(key in ledger, `${key}: missing ledger entry`);
        assertGapLedger(key, ledger[key], holdingGaps(replay));
      } finally { recording.cleanup(); }
    });
  }
}

for (const name of ['c03_fg', 'h-relabel', 'h19-subagent-stream', 'h20-partial-attempt']) {
  test(`streamed reply replay ${name}: each main message text is emitted exactly once`, async t => {
    const root = handbuilt.includes(name) ? handbuiltRoot : fixtureRoot;
    if (!existsSync(new URL(`${name}.messages.json`, root))) {
      assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
      t.skip('fixture missing'); return;
    }
    const recording = loadRecording(name, root);
    try {
      const replay = await drive(recording.messages, recording.directory);
      const expected = new Map<string, string>();
      for (const { from, message: m } of recording.messages) {
        if (from !== 'cli' || m.type !== 'assistant' || m.parent_tool_use_id) continue;
        const text = (m.message?.content ?? []).filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text).join('');
        if (text) expected.set(m.message.id, (expected.get(m.message.id) ?? '') + text);
      }
      assert.ok(expected.size > 0);
      for (const [id, text] of expected) {
        const actual = replay.events.flatMap(e => e.type === 'text_delta' && e.messageId === id ? [e.text] : []).join('');
        assert.equal(actual, text, `${name}: ${id}`);
      }
    } finally { recording.cleanup(); }
  });
}

/**
 * The recordings whose turns must all be accounted for, with the origin of each turn in order, for the
 * recorded stream and for the same stream without lifecycle frames (and, for c04a, without the
 * prompt's echo). In none of them did the host's message reach the CLI before a cycle of the CLI's own
 * began, so none may announce one.
 */
const TURN_REPLAYS: Record<string, Record<string, string[]>> = {
  c01: { recorded: ['client', 'cli', 'client', 'client'], 'without-lifecycle': ['client', 'cli', 'client', 'client'] },
  c01c: { recorded: ['client', 'cli'], 'without-lifecycle': ['client', 'cli'] },
  c02b: { recorded: ['client', 'cli', 'cli'], 'without-lifecycle': ['client', 'cli', 'cli'] },
  c03_bg: { recorded: ['client', 'cli'], 'without-lifecycle': ['client', 'cli'] },
  c03_fg: { recorded: ['client'], 'without-lifecycle': ['client'] },
  // The host's message arrived after the woken cycle began, so it steers into that turn and, held past
  // its result, runs as the follow-up; without lifecycle reports it cannot be steered and is held back,
  // and the CLI's run of it is a turn of the CLI's.
  c04a: { recorded: ['client', 'cli', 'follow_up'], 'without-lifecycle': ['client', 'cli', 'cli'], c04c: ['client', 'cli', 'follow_up'] },
  c04b: { recorded: ['client', 'client'], 'without-lifecycle': ['client', 'client'] },
  c04d: { recorded: ['client', 'cli', 'follow_up'], 'without-lifecycle': ['client', 'cli', 'cli'] },
  c05: { recorded: ['client'], 'without-lifecycle': ['client'] },
  c05w: { recorded: ['client', 'cli'], 'without-lifecycle': ['client', 'cli'] },
  c15a: { recorded: ['client', 'cli'], 'without-lifecycle': ['client', 'cli'] },
};

/** Every turn_completed names a turn that started and is still open, at most one turn is open at a time,
 * and none is left open. */
function assertBalanced(name: string, events: ClaudeRuntimeEvent[]): void {
  let open: string | undefined;
  for (const event of events) {
    if (event.type === 'turn_started') {
      assert.equal(open, undefined, `${name}: turn ${event.turnId} opened while ${open} was open`);
      open = event.turnId;
    } else if (event.type === 'turn_completed') {
      assert.equal(event.turnId, open, `${name}: turn_completed for ${event.turnId}, open was ${open}`);
      open = undefined;
    }
  }
  assert.equal(open, undefined, `${name}: turn ${open} never completed`);
}

for (const [name, variants] of Object.entries(TURN_REPLAYS)) {
  for (const [variant, origins] of Object.entries(variants)) {
    test(`CLI turns ${name} ${variant}: every main-thread frame on a turn, balanced turns, origins ${origins.join(' ')}`, async t => {
      if (!existsSync(new URL(`${name}.messages.json`, fixtureRoot))) {
        assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
        t.skip('fixture missing'); return;
      }
      const recording = loadRecording(name, fixtureRoot);
      try {
        const messages = variant === 'without-lifecycle' ? withoutLifecycle(recording.messages) : variant === 'c04c' ? c04c(recording.messages) : recording.messages;
        const replay = await drive(messages, recording.directory);
        assert.equal(replay.events.some(e => e.type === 'turn_completed' && e.turnId === 'unknown-turn'), false, 'unknown-turn');
        const noTurnNotices = replay.steps.filter(s => s.line.from === 'cli' &&
          s.events.some(e => e.type === 'provider_notice' && e.subtype === 'no_turn_in_progress'));
        assert.deepEqual(noTurnNotices.map(s => s.line.i), [], 'frames reported with no turn in progress');
        assertBalanced(`${name} ${variant}`, replay.events);
        assert.deepEqual(replay.events.flatMap(e => e.type === 'turn_started' ? [e.origin] : []), origins);
        assert.deepEqual(replay.events.filter(e => e.type === 'cli_cycle_started'), []);
        // A CLI turn's frames carry its id; nothing produced while it ran is labelled with another turn.
        let open: string | undefined;
        for (const event of replay.events) {
          if (event.type === 'turn_started') open = event.turnId;
          else if (event.type === 'turn_completed') open = undefined;
          else if ('turnId' in event && event.type !== 'user_message_delivered' && !('parentToolUseId' in event)) assert.equal(event.turnId, open, `${event.type} labelled ${event.turnId} while ${open} was open`);
        }
      } finally { recording.cleanup(); }
    });
  }
}

for (const name of ['c03_bg', 'c03_fg']) {
  for (const variant of ['recorded', 'without-lifecycle']) {
    test(`subagent replay ${name} ${variant}: every child keeps its parent and the parent's turn`, async () => {
      const recording = loadRecording(name);
      try {
        const replay = await drive(variant === 'recorded' ? recording.messages : withoutLifecycle(recording.messages), recording.directory);
        const parents = new Map<string, string>();
        let children = 0;
        let afterParentTurn = 0;
        for (const step of replay.steps) {
          const m = step.line.message;
          if (step.line.from !== 'cli') continue;
          if (typeof m.parent_tool_use_id === 'string') {
            assert.equal(step.events.some(e => e.type === 'turn_started' || e.type === 'turn_completed' || e.type === 'provider_notice'), false, `child frame ${step.line.i}`);
            const parentTurn = parents.get(m.parent_tool_use_id);
            assert.ok(parentTurn, `parent ${m.parent_tool_use_id} was observed`);
            // A child's initial prompt is input, not produced content. Tool calls/results and deltas
            // must survive, including the background calls that arrive after the parent turn ended.
            const blocks = m.message?.content;
            if (m.type === 'assistant' && Array.isArray(blocks)) assert.ok(step.events.length >= blocks.length);
            if (m.type === 'user' && Array.isArray(blocks)) assert.equal(step.events.length, blocks.filter((b: { type: string }) => b.type === 'tool_result').length);
            for (const event of step.events) {
              assert.ok('parentToolUseId' in event && 'turnId' in event);
              assert.equal(event.parentToolUseId, m.parent_tool_use_id);
              assert.equal(event.turnId, parentTurn);
              children++;
              if (step.activeTurn !== parentTurn) afterParentTurn++;
            }
          } else {
            for (const event of step.events) assert.equal('parentToolUseId' in event, false);
          }
          for (const event of step.events) {
            if (event.type === 'tool_call_started' && ['Agent', 'Task'].includes(event.name)) parents.set(event.toolUseId, event.turnId);
          }
        }
        assert.ok(children > 0);
        assert.equal(replay.events.some(e => e.type === 'provider_notice' && e.subtype === 'no_turn_in_progress'), false);
        if (name === 'c03_bg') {
          assert.ok(afterParentTurn > 0);
          const handback = replay.events.find(e => e.type === 'turn_completed' && e.originKind === 'peer');
          assert.ok(handback && handback.type === 'turn_completed');
          assert.ok(replay.events.some(e => e.type === 'turn_started' && e.turnId === handback.turnId && e.origin === 'cli'));
        }
        assertBalanced(`${name} ${variant}`, replay.events);
      } finally { recording.cleanup(); }
    });
  }
}

test('gap ratchet rejects a fixed gap and an unlisted gap', () => {
  assert.throws(() => assertGapLedger('sample', ['coverage-warnings-dropped'], []), /fixed: delete coverage-warnings-dropped/);
  assert.throws(() => assertGapLedger('sample', [], ['coverage-warnings-dropped']), /unlisted gap/);
  assert.throws(() => assertGapLedger('sample', ['coverage-result-identity-not-read'], []), /unknown gap/);
});

test('the warnings predicate sees a dropped notification and ignores a background-task frame', () => {
  const only = (message: Line['message']) => ({ steps: [{ line: { from: 'cli' as const, message }, events: [] }], events: [], pushed: [], skippedStopTasks: 0, skippedSteers: 0, log: [] });
  assert.equal(gapPredicates['coverage-warnings-dropped'](only({ type: 'system', subtype: 'notification', key: 'k', text: 't', priority: 'low' })), true);
  assert.equal(gapPredicates['coverage-warnings-dropped'](only({ type: 'system', subtype: 'model_refusal_fallback', scope: 'local' })), true);
  assert.equal(gapPredicates['coverage-warnings-dropped'](only({ type: 'system', subtype: 'task_notification', task_id: 't' })), false);
});

test('loader expands one absolute RUN directory, preserves other placeholders and refuses an untested CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-test-'));
  const root = pathToFileURL(`${directory}/`);
  const manifest = { cli_version: '2.1.311', stamped: true };
  const lines = [{ from: 'cli', message: { path: '$RUN/tasks/task.output', other: ['$RUN', '$USER', '$HOST', '$KEY'] } }];
  writeFileSync(join(directory, 'sample.messages.json'), JSON.stringify({ manifest, lines }));
  try {
    const r = loadRecording('sample', root);
    try {
      assert.ok(r.directory.startsWith('/'));
      assert.equal(r.messages[0].message.path, `${r.directory}/tasks/task.output`);
      assert.deepEqual(r.messages[0].message.other, [r.directory, '$USER', '$HOST', '$KEY']);
    } finally { r.cleanup(); }
    writeFileSync(join(directory, 'sample.messages.json'), JSON.stringify({ manifest: { ...manifest, cli_version: '9.0.0' }, lines }));
    assert.throws(() => loadRecording('sample', root), /fixture recorded on CLI 9.0.0: re-record/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('driver maps recorded uuids into all later frames and detects steers', async () => {
  const messages: Line[] = [
    { from: 'host', message: { type: 'user', uuid: 'recorded', message: { content: 'hello' }, origin: { kind: 'human' } } },
    { from: 'cli', message: { type: 'system', subtype: 'init', tools: [], capabilities: ['msg_lifecycle_v1'] } },
    { from: 'host', message: { type: 'user', uuid: 'steered', priority: 'next', message: { content: 'also this' } } },
    { from: 'cli', message: { type: 'command_lifecycle', command_uuid: 'steered', state: 'started' } },
    { from: 'cli', message: { type: 'result', subtype: 'success', result: '', is_error: false, user_message_uuid: 'recorded' } },
    { from: 'host', message: { type: 'control_request', request: { subtype: 'stop_task', task_id: 'task' } } },
  ];
  const replay = await drive(messages, tmpdir());
  assert.equal(replay.pushed.length, 2);
  assert.equal((replay.pushed[1] as unknown as { priority: string }).priority, 'next');
  assert.notEqual(replay.pushed[0].uuid, 'recorded');
  assert.ok(replay.events.some(e => e.type === 'user_message_delivered'));
  assert.equal(replay.skippedStopTasks, 1);
  assert.deepEqual(remapUuids({ nested: ['recorded'], command_uuid: 'recorded' }, new Map([['recorded', 'actual']])), { nested: ['actual'], command_uuid: 'actual' });
  const derived = withoutLifecycle(messages);
  assert.equal(derived.some(l => l.message.type === 'command_lifecycle'), false);
  assert.deepEqual(derived[1].message.capabilities, []);
  assert.deepEqual(messages[1].message.capabilities, ['msg_lifecycle_v1']);
  assert.equal(c04c(messages).at(-2)?.message.user_message_uuid, 'recorded');
  assert.equal(c04c([{ from: 'host', message: { type: 'user', uuid: 'last' } }, { from: 'cli', message: { type: 'result', user_message_uuid: 'last' } }])[1].message.user_message_uuid, undefined);
});

test('a steer to a CLI that reports no lifecycle is held back while a turn runs; with no turn running it is a plain send', async () => {
  const user = (uuid: string, priority?: string): Line => ({ from: 'host', message: { type: 'user', uuid, ...(priority ? { priority } : {}), message: { content: uuid } } });
  const init: Line = { from: 'cli', message: { type: 'system', subtype: 'init', tools: [], capabilities: [] } };
  const result: Line = { from: 'cli', message: { type: 'result', subtype: 'success', result: '', is_error: false } };
  const busy = await drive([user('first'), init, user('second', 'next')], tmpdir());
  assert.equal(busy.skippedSteers, 1);
  assert.equal(busy.pushed.length, 1);
  const idle = await drive([user('first'), init, result, user('second', 'next')], tmpdir());
  assert.equal(idle.skippedSteers, 0);
  assert.equal(idle.pushed.length, 2);
});

test('import merges directions, routes question controls and rejects unsafe staging', async () => {
  const moduleUrl = new URL('../../tests/replay/import.mjs', import.meta.url).href;
  const { convert, importRuns } = await import(moduleUrl);
  const directory = mkdtempSync(join(tmpdir(), 'import-test-'));
  const staging = join(directory, 'staging');
  const run = join(staging, 'sample'); mkdirSync(run, { recursive: true });
  const tap = (index: number, message: object, time = index) => JSON.stringify({ index, time, line: JSON.stringify(message) });
  const host = { type: 'user', uuid: 'host-uuid', priority: 'next', origin: { kind: 'human' }, message: { content: 'hello' } };
  const initialize = { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } };
  const stdin = [tap(0, initialize), tap(10, host), tap(13, { type: 'control_response', response: { request_id: 'q' } }), tap(14, { type: 'control_request', request: { subtype: 'interrupt' } }), tap(15, { type: 'control_request', request: { subtype: 'stop_task', task_id: 'task' } })].join('\n');
  const stdout = [tap(11, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-q', name: 'AskUserQuestion' }] } }), tap(12, { type: 'control_request', request_id: 'q', request: { tool_name: 'AskUserQuestion', tool_use_id: 'tool-q' } }), tap(16, { type: 'control_response', response: { request_id: 'other' } })].join('\n');
  const manifest = { scenario: 'sample', cli_version: '2.1.311', files: ['cli-stdin.jsonl', 'cli-stdout.jsonl', 'body_1.json', 'body_2.json'] };
  const write = (dir = run, extra: object = {}) => {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...extra }));
    writeFileSync(join(dir, 'cli-stdin.jsonl'), stdin); writeFileSync(join(dir, 'cli-stdout.jsonl'), stdout);
    writeFileSync(join(dir, 'body_2.json'), JSON.stringify({ messages: [{ content: [{ type: 'tool_result', tool_use_id: 'tool-q', content: 'later answer' }] }] }));
    writeFileSync(join(dir, 'body_1.json'), JSON.stringify({ messages: [{ content: [{ type: 'tool_result', tool_use_id: 'tool-q', content: 'answer' }] }] }));
  };
  const scan = join(directory, 'scan.sh');
  try {
    write();
    const result = convert(run);
    assert.deepEqual(result.messages.lines.map((l: Line) => l.from), ['host', 'cli', 'host', 'host']);
    assert.deepEqual(result.messages.lines.map((l: Line) => l.i), [10, 11, 14, 15]);
    assert.deepEqual(result.messages.lines[0].message, host);
    assert.equal(result.messages.manifest.stamped, true);
    assert.equal(result.control.exchanges.length, 2);
    assert.equal(result.control.initialize.message.request.subtype, 'initialize');
    assert.equal(result.control.tool_results['tool-q'].content, 'answer');
    assert.equal(result.control.dropped_controls, 1);
    // Per-direction indices overlap; monotonic timestamps retain the same arrival order.
    writeFileSync(join(run, 'cli-stdout.jsonl'), stdout.split('\n').map((line, i) => JSON.stringify({ ...JSON.parse(line), index: i })).join('\n'));
    assert.deepEqual(convert(run).messages.lines.map((l: Line) => l.message), result.messages.lines.map((l: Line) => l.message));
    writeFileSync(join(run, 'cli-stdout.jsonl'), tap(1, { type: 'assistant', text: '/home/private' }));
    assert.throws(() => convert(run), /unscrubbed home path/);
    write(); writeFileSync(join(run, 'extra.txt'), 'unexpected');
    assert.throws(() => convert(run), /unlisted staged file/);
    rmSync(join(run, 'extra.txt'));

    // A run part keeps its path in its name and its run in the manifest; a variant never overwrites another.
    const part = join(staging, 'many', 'run2'); mkdirSync(part, { recursive: true });
    write(part, { scenario: 'many', run: 'run2' });
    const broken = join(staging, 'broken'); mkdirSync(broken);
    writeFileSync(join(broken, 'manifest.json'), '{ not json');
    writeFileSync(scan, '#!/bin/sh\ntest -f "$1/many.run2.messages.json"\n');
    importRuns({ from: staging, out: join(directory, 'selective'), scan, only: ['many.run2'] });
    const imported = JSON.parse(readFileSync(join(directory, 'selective', 'many.run2.messages.json'), 'utf8'));
    assert.equal(imported.manifest.run, 'run2');
    assert.equal(existsSync(join(directory, 'selective', 'sample.messages.json')), false);
    importRuns({ from: staging, out: join(directory, 'selective'), scan, only: ['many'], variant: 'core' });
    assert.ok(existsSync(join(directory, 'selective', 'many.run2.core.messages.json')));
    assert.ok(existsSync(join(directory, 'selective', 'many.run2.control.json')));
    rmSync(broken, { recursive: true });
    importRuns({ from: staging, out: join(directory, 'output'), scan });
    assert.throws(() => importRuns({ from: run, out: join(directory, 'run-root'), scan }), /staging root/);
    // A run with no AskUserQuestion traffic gets no control file.
    const quiet = join(staging, 'quiet'); mkdirSync(quiet);
    write(quiet, { scenario: 'quiet' });
    writeFileSync(join(quiet, 'cli-stdin.jsonl'), tap(0, host)); writeFileSync(join(quiet, 'cli-stdout.jsonl'), tap(1, { type: 'result' }));
    writeFileSync(scan, '#!/bin/sh\nexit 0\n');
    importRuns({ from: staging, out: join(directory, 'quiet-out'), scan, only: ['quiet'] });
    assert.ok(existsSync(join(directory, 'quiet-out', 'quiet.messages.json')));
    assert.equal(existsSync(join(directory, 'quiet-out', 'quiet.control.json')), false);
    writeFileSync(scan, '#!/bin/sh\nexit 1\n');
    assert.throws(() => importRuns({ from: staging, out: join(directory, 'quiet-out'), scan, only: ['quiet'] }), /scan failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, fields] of Object.entries({
  c15a: { wakeupSource: 'loop_wakeup', scheduledForMs: 1793147100000, scheduleReason: 'C15A-REASON' },
  c15b: { wakeupSource: 'schedule_wakeup', cronId: 'e7fb55bf', prompt: 'C15B-FIRE' },
  c04d: { wakeupSource: 'loop_wakeup', scheduledForMs: 1793146080000, scheduleReason: 'C04D-REASON' },
})) {
  test(`scheduled replay ${name}: the recorded fire joins its tool facts`, async t => {
    if (!existsSync(new URL(`${name}.messages.json`, fixtureRoot))) {
      assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
      t.skip('fixture missing'); return;
    }
    const recording = loadRecording(name, fixtureRoot);
    try {
      const replay = await drive(recording.messages, recording.directory);
      const causes = replay.events.flatMap(e => (e.type === 'turn_started' || e.type === 'cli_cycle_started' || e.type === 'turn_cause_updated') && e.cause?.kind === 'scheduled' ? [e.cause] : []);
      assert.deepEqual(causes, [{ kind: 'scheduled', ...fields }]);
      assertBalanced(name, replay.events);
    } finally { recording.cleanup(); }
  });
}

/** The recording's task ids by the CLI's task type, from its `task_started` frames. */
function recordedTasks(messages: Line[]): Map<string, string> {
  const tasks = new Map<string, string>();
  for (const { from, message: m } of messages) {
    if (from === 'cli' && m.type === 'system' && m.subtype === 'task_started') tasks.set(m.task_id, m.task_type);
  }
  return tasks;
}

/** The output file the recording names for each task, from its notification or its launch template. */
function recordedOutputFiles(messages: Line[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const { from, message: m } of messages) {
    if (from !== 'cli') continue;
    if (m.type === 'system' && m.subtype === 'task_notification' && typeof m.output_file === 'string') files.set(m.task_id, m.output_file);
    for (const block of m.type === 'user' && Array.isArray(m.message?.content) ? m.message.content : []) {
      const text = typeof block.content === 'string' ? block.content : '';
      const launch = /^Command running in background with ID: (\S+)\. Output is being written to: (\S+)\.(?:\s|$)/.exec(text);
      if (launch) files.set(launch[1], launch[2]);
    }
  }
  return files;
}

/** Each task's ending edges as the replay emitted them: [task id, edge, status]. */
function endings(events: ClaudeRuntimeEvent[]): Array<[string, string, string | undefined]> {
  return events.flatMap(e => e.type === 'task_event' && (e.edge === 'updated' || e.edge === 'notified') && e.status !== undefined ? [[e.taskId, e.edge, e.status] as [string, string, string | undefined]] : []);
}

function fixtureOrSkip(name: string, t: { skip(message: string): void }): boolean {
  if (existsSync(new URL(`${name}.messages.json`, fixtureRoot))) return true;
  assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
  t.skip('fixture missing');
  return false;
}

const withoutOutputFile = (messages: Line[]): Line[] => messages.map(line => line.from === 'cli' && line.message.subtype === 'task_notification'
  ? { ...line, message: Object.fromEntries(Object.entries(line.message).filter(([key]) => key !== 'output_file')) } : line);
const withoutLaunchTemplate = (messages: Line[]): Line[] => messages.map(line => line.from === 'cli' && line.message.type === 'user' && Array.isArray(line.message.message?.content)
  ? { ...line, message: { ...line.message, message: { ...line.message.message, content: line.message.message.content.map((block: Record<string, unknown>) =>
    block.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith('Command running in background') ? { ...block, content: 'started' } : block) } } } : line);

for (const [variant, derive] of [['recorded', (m: Line[]) => m], ['launch template only', withoutOutputFile], ['output_file only', withoutLaunchTemplate]] as const) {
  test(`task output replay c16 ${variant}: each recorded shell's file is accepted and its tail read`, async t => {
    if (!fixtureOrSkip('c16', t)) return;
    const recording = loadRecording('c16', fixtureRoot);
    try {
      const shells = [...recordedTasks(recording.messages)].filter(([, type]) => type === 'local_bash').map(([id]) => id);
      const files = recordedOutputFiles(recording.messages);
      assert.equal(shells.length, 2);
      const read = new Map<string, string>();
      await drive(derive(recording.messages), recording.directory, {
        beforeClose: async session => {
          for (const id of shells) {
            const file = files.get(id)!;
            assert.ok(file.startsWith(`${recording.directory}/`), 'the recorded path is under the replay directory');
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `${id} output\n`);
            read.set(id, Buffer.from((await session.taskOutput(id)).output).toString());
          }
        },
      });
      assert.deepEqual([...read], shells.map(id => [id, `${id} output\n`]));
    } finally { recording.cleanup(); }
  });
}

test('task control replay c07b: an interrupt without the per-task stop kills the agent and leaves the shell running, as recorded', async t => {
  if (!fixtureOrSkip('c07b', t)) return;
  const recording = loadRecording('c07b', fixtureRoot);
  try {
    const tasks = [...recordedTasks(recording.messages)];
    const shell = tasks.find(([, type]) => type === 'local_bash')![0];
    const agent = tasks.find(([, type]) => type === 'local_agent')![0];
    const shellFile = recordedOutputFiles(recording.messages).get(shell)!;
    const replay = await drive(recording.messages, recording.directory, {
      beforeClose: async (session, fake) => {
        // Both have ended: a stop answers at once and the CLI hears nothing.
        await session.stopTask(agent);
        await session.stopTask(shell);
        assert.deepEqual(fake.stopTaskCalls, []);
        await assert.rejects(session.taskOutput(agent), (error: unknown) => error instanceof TaskOutputUnavailableError && error.reason === 'task_kind_has_no_output');
        mkdirSync(dirname(shellFile), { recursive: true });
        writeFileSync(shellFile, 'K1\n');
        assert.equal(Buffer.from((await session.taskOutput(shell)).output).toString(), 'K1\n');
      },
    });
    assert.deepEqual(endings(replay.events), [[agent, 'updated', 'killed'], [agent, 'notified', 'stopped'], [shell, 'updated', 'completed'], [shell, 'notified', 'completed']]);
  } finally { recording.cleanup(); }
});

test('task control replay c16w_stop.run2: a stop on the running workflow reaches the CLI with its id; after the recorded kill it answers at once', async t => {
  if (!fixtureOrSkip('c16w_stop.run2', t)) return;
  const recording = loadRecording('c16w_stop.run2', fixtureRoot);
  try {
    const workflow = [...recordedTasks(recording.messages)].find(([, type]) => type === 'local_workflow')![0];
    const interrupt = recording.messages.findIndex(line => line.from === 'host' && line.message.request?.subtype === 'interrupt');
    assert.ok(interrupt > 0);
    let before: string[] = [];
    const replay = await drive(recording.messages, recording.directory, {
      afterStep: async (index, session, fake) => {
        if (index !== interrupt - 1) return;
        await session.stopTask(workflow);
        before = [...fake.stopTaskCalls];
      },
      beforeClose: async (session, fake) => {
        await session.stopTask(workflow);
        assert.deepEqual(fake.stopTaskCalls, [workflow], 'the ended workflow is not stopped again');
        await assert.rejects(session.taskOutput(workflow), (error: unknown) => error instanceof TaskOutputUnavailableError && error.reason === 'task_kind_has_no_output');
      },
    });
    assert.deepEqual(before, [workflow]);
    assert.deepEqual(endings(replay.events), [[workflow, 'updated', 'killed'], [workflow, 'notified', 'stopped']]);
  } finally { recording.cleanup(); }
});
