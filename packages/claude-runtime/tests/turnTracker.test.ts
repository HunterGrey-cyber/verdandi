import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AUTONOMOUS_ORIGINS, NO_LIFECYCLE_FOR_SEND, NO_STATE_FRAMES, TurnTracker, type ResultFacts, type TrackerStep, type TurnFrame } from '../src/turnTracker.js';
import { turnFrameOf } from '../src/eventTranslation.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';

const WITH = { lifecycleReported: true };
const WITHOUT = { lifecycleReported: false };
const LIFECYCLE_CASES = [
  ['lifecycle present', WITH],
  ['lifecycle absent', WITHOUT],
] as const;

const AUTONOMOUS = ['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity'];
/** Origins that are the user's lane: the named ones, no origin at all, and a kind this code has never seen. */
const USER_LANE: (string | undefined)[] = ['auto-continuation', 'channel', 'unclassified', 'human', undefined, 'some-future-kind'];

function tracker(): TurnTracker {
  let next = 0;
  return new TurnTracker(() => `turn-${++next}`);
}

function result(extra: Partial<ResultFacts> = {}): ResultFacts {
  return { isError: false, names: [], numTurns: 1, ...extra };
}

const origin = (kind: string | undefined) => (kind === undefined ? {} : { originKind: kind });
const types = (step: TrackerStep) => [...step.before, ...step.after].map((event) => event.type);

/** A tracker with a CLI turn open (opened by an API request starting). */
function cliTurnOpen(): { t: TurnTracker; id: string } {
  const t = tracker();
  const step = t.frame({ kind: 'requesting' }, WITH);
  const started = step.before[0] as Extract<ClaudeRuntimeEvent, { type: 'turn_started' }>;
  return { t, id: started.turnId };
}

/** A tracker with a client turn open on message `u1`; `seen` records a `queued` frame for it. */
function clientTurnOpen(seen: boolean): { t: TurnTracker; id: string } {
  const t = tracker();
  t.pushed('u1');
  const { turnId } = t.openClient('u1', 'client-1');
  if (seen) {
    assert.deepEqual(types(t.lifecycle('u1', 'queued')), []);
  }
  return { t, id: turnId };
}

// ---- Opening a turn the CLI starts ----------------------------------------------------------------------

for (const frame of [{ kind: 'requesting' }, { kind: 'stream' }, { kind: 'content' }, { kind: 'lifecycle', uuid: 'fire-1', state: 'started' }] as TurnFrame[]) {
  test(`opening: ${JSON.stringify(frame)} opens a CLI turn ahead of its own events, with an unknown cause`, () => {
    const t = tracker();
    const step = t.frame(frame, WITH);
    assert.deepEqual(step.before, [{ type: 'turn_started', turnId: 'turn-1', origin: 'cli', cause: { kind: 'unknown' } }]);
    assert.equal(t.open?.origin, 'cli');
    // A second opener while it runs opens nothing.
    assert.deepEqual(types(t.frame(frame, WITH)), []);
  });
}

for (const frame of [
  { kind: 'other' },
  { kind: 'session_state', state: 'running' },
  { kind: 'task_started', taskId: 'b1', taskType: 'local_bash' },
  { kind: 'task_notification', taskId: 'b1', status: 'completed' },
  { kind: 'lifecycle', uuid: 'fire-1', state: 'queued' },
  { kind: 'user_echo', uuid: 'someone' },
] as TurnFrame[]) {
  test(`opening: ${JSON.stringify(frame)} opens nothing`, () => {
    const t = tracker();
    const step = frame.kind === 'session_state' ? t.sessionState(frame.state) : t.frame(frame, WITH);
    assert.deepEqual(types(step), []);
    assert.equal(t.open, undefined);
  });
}

test('opening: a lifecycle started for a message this session pushed opens nothing (its own turn is the session\'s business)', () => {
  const t = tracker();
  t.pushed('mine');
  assert.deepEqual(types(t.frame({ kind: 'lifecycle', uuid: 'mine', state: 'started' }, WITH)), []);
  assert.equal(t.open, undefined);
});

const sdk = (message: Record<string, unknown>) => message as unknown as SDKMessage;

test('opening: system/init, a status other than requesting and every frame with a parent tool call are not openers', () => {
  assert.deepEqual(turnFrameOf(sdk({ type: 'system', subtype: 'init', session_id: 's' })), { kind: 'other' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'system', subtype: 'status', status: 'compacting' })), { kind: 'other' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'system', subtype: 'status', status: 'requesting' })), { kind: 'requesting' });
  for (const child of [
    { type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: [] } },
    { type: 'stream_event', parent_tool_use_id: 'toolu_agent', event: { type: 'content_block_delta' } },
    { type: 'user', parent_tool_use_id: 'toolu_agent', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
    { type: 'system', subtype: 'status', status: 'requesting', parent_tool_use_id: 'toolu_agent' },
  ]) {
    assert.deepEqual(turnFrameOf(sdk(child)), { kind: 'other' }, JSON.stringify(child));
  }
  // The same frames on the main thread.
  assert.deepEqual(turnFrameOf(sdk({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } })), { kind: 'content' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta' } })), { kind: 'content' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })), { kind: 'stream' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })), { kind: 'content' });
  assert.deepEqual(turnFrameOf(sdk({ type: 'user', parent_tool_use_id: null, uuid: 'u1', message: { content: 'text' } })), { kind: 'user_echo', uuid: 'u1' });
});

test('opening: a subagent\'s frame never opens or closes a turn: it is `other`, and `other` changes nothing', () => {
  const { t, id } = cliTurnOpen();
  assert.deepEqual(types(t.frame({ kind: 'other' }, WITH)), []);
  assert.equal(t.open?.id, id);
  const idle = tracker();
  assert.deepEqual(types(idle.frame({ kind: 'other' }, WITH)), []);
  assert.equal(idle.open, undefined);
});

test('turnFrameOf reads a result\'s origin, num_turns and every uuid it names, defensively', () => {
  assert.deepEqual(
    turnFrameOf(sdk({ type: 'result', is_error: false, origin: { kind: 'peer', name: 'p' }, num_turns: 2, user_message_uuid: 'a', user_message_uuids: ['a', 'b', 7] })),
    { kind: 'result', originKind: 'peer', numTurns: 2, isError: false, names: ['a', 'b'] },
  );
  assert.deepEqual(turnFrameOf(sdk({ type: 'result', is_error: true, origin: null, num_turns: 'x' })), { kind: 'result', isError: true, names: [] });
});

// ---- The cause ---------------------------------------------------------------------------------------------

test('cause: a CLI turn opened after a task notification is caused by that task, described from its task_started', () => {
  const t = tracker();
  t.frame({ kind: 'task_started', taskId: 'b1', taskType: 'local_bash', description: 'sleep 1', toolUseId: 'toolu_1' }, WITH);
  t.frame({ kind: 'task_notification', taskId: 'b1', status: 'completed', summary: 'Background command "sleep 1" completed' }, WITH);
  const step = t.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(step.before, [
    {
      type: 'turn_started',
      turnId: 'turn-1',
      origin: 'cli',
      cause: { kind: 'task', taskId: 'b1', taskKind: 'shell', taskStatus: 'completed', description: 'sleep 1', summary: 'Background command "sleep 1" completed' },
    },
  ]);
  // The result consumes the notification: the next turn the CLI starts says nothing about b1.
  t.result(result({ originKind: 'task-notification' }), WITH);
  assert.deepEqual((t.frame({ kind: 'requesting' }, WITH).before[0] as { cause: unknown }).cause, { kind: 'unknown' });
});

test('cause: an unknown cause is refined at the close by the result\'s origin, before the close', () => {
  for (const [kind, cause] of [
    ['task-notification', { kind: 'task' }],
    ['coordinator', { kind: 'other' }],
    ['observer', { kind: 'other' }],
    ['peer', { kind: 'peer' }],
  ] as const) {
    const { t, id } = cliTurnOpen();
    const step = t.result(result({ originKind: kind }), WITH);
    assert.deepEqual(step.before, [{ type: 'turn_cause_updated', turnId: id, cause }], kind);
    assert.equal(step.closes, id);
  }
  // A known cause, or an origin that says nothing new, is not touched.
  const { t } = cliTurnOpen();
  assert.deepEqual(t.result(result({ originKind: 'human' }), WITH).before, []);
  const known = tracker();
  known.frame({ kind: 'task_notification', taskId: 'b1' }, WITH);
  known.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(known.result(result({ originKind: 'task-notification' }), WITH).before, []);
});

// ---- Which result closes which turn -----------------------------------------------------------------------

for (const [label, context] of LIFECYCLE_CASES) {
  test(`closing, placeholder (${label}): a placeholder closes nothing and emits nothing, whatever is open`, () => {
    const placeholder = result({ originKind: 'task-notification', numTurns: 0 });
    const none = tracker();
    assert.deepEqual(none.result(placeholder, context), { before: [], after: [], log: [NO_STATE_FRAMES] });
    const { t: cli, id } = cliTurnOpen();
    assert.equal(cli.result(placeholder, context).closes, undefined);
    assert.equal(cli.open?.id, id);
    for (const seen of [true, false]) {
      const { t: client, id: clientId } = clientTurnOpen(seen);
      const step = client.result(placeholder, context);
      assert.deepEqual([step.closes, types(step)], [undefined, []]);
      assert.equal(client.open?.id, clientId);
    }
    // An error is never a placeholder, nor is a result that names the open turn's message.
    const { t: errored, id: erroredId } = cliTurnOpen();
    assert.equal(errored.result({ ...placeholder, isError: true }, context).closes, erroredId);
    const { t: named, id: namedId } = clientTurnOpen(true);
    assert.equal(named.result({ ...placeholder, names: ['u1'] }, context).closes, namedId);
  });

  test(`closing, CLI turn (${label}): an open CLI turn is closed by any other result, whatever its origin`, () => {
    for (const kind of [...AUTONOMOUS, ...USER_LANE]) {
      const { t, id } = cliTurnOpen();
      const step = t.result(result(origin(kind)), context);
      assert.equal(step.closes, id, String(kind));
      assert.equal(t.open, undefined);
    }
  });

  test(`closing, nothing open (${label}): a result with no turn open is reported as a CLI turn opened and closed, never unknown-turn`, () => {
    const t = tracker();
    const step = t.result(result({ originKind: 'task-notification' }), context);
    assert.deepEqual(step.before, [{ type: 'turn_started', turnId: 'turn-1', origin: 'cli', cause: { kind: 'task' } }]);
    assert.equal(step.closes, 'turn-1');
    assert.equal(t.open, undefined);
    const plain = tracker().result(result(), context);
    assert.deepEqual(plain.before, [{ type: 'turn_started', turnId: 'turn-1', origin: 'cli', cause: { kind: 'unknown' } }]);
  });
}

test('closing, message waiting (lifecycle present): with the message still waiting, a result that does not name it ends a cycle, never the turn', () => {
  for (const kind of [...AUTONOMOUS, ...USER_LANE]) {
    const { t, id } = clientTurnOpen(true);
    const step = t.result(result(origin(kind)), WITH);
    assert.deepEqual([step.closes, types(step)], [undefined, []], String(kind));
    assert.equal(t.open?.id, id);
  }
});

test('closing, message waiting (lifecycle present): with the message still waiting, a result that names it closes the turn', () => {
  for (const names of [['u1'], ['other', 'u1']]) {
    const { t, id } = clientTurnOpen(true);
    assert.equal(t.result(result({ originKind: 'task-notification', names }), WITH).closes, id);
  }
});

test('closing, message taken in or dropped (lifecycle present): once the message started, any result closes the turn, an autonomous one naming nothing included', () => {
  for (const kind of [...AUTONOMOUS, ...USER_LANE]) {
    const { t, id } = clientTurnOpen(true);
    t.lifecycle('u1', 'started');
    assert.equal(t.result(result(origin(kind)), WITH).closes, id, String(kind));
  }
});

test('closing, message taken in or dropped (lifecycle present): a message dropped while a cycle runs ends the turn at that cycle\'s result', () => {
  const { t, id } = clientTurnOpen(true);
  t.frame({ kind: 'content' }, WITH);
  const drop = t.lifecycle('u1', 'cancelled');
  assert.deepEqual(drop.after, [{ type: 'user_message_dropped', clientMessageId: 'client-1', reason: 'cancelled' }]);
  assert.equal(t.open?.id, id);
  assert.equal(t.result(result({ originKind: 'task-notification' }), WITH).closes, id);
});

test('closing: a message dropped while no cycle runs ends its turn at the drop, completed with no reply', () => {
  const { t, id } = clientTurnOpen(true);
  const drop = t.lifecycle('u1', 'refused');
  assert.deepEqual(drop.after, [
    { type: 'user_message_dropped', clientMessageId: 'client-1', reason: 'refused' },
    { type: 'turn_completed', turnId: id, outcome: 'completed', resultText: '', isError: false, stopReason: null },
  ]);
  assert.equal(t.open, undefined);
});

for (const [label, context] of LIFECYCLE_CASES) {
  test(`closing, origin rule (${label}, no frame for the message): an autonomous result naming nothing closes nothing`, () => {
    for (const kind of AUTONOMOUS) {
      const { t, id } = clientTurnOpen(false);
      const step = t.result(result({ originKind: kind }), context);
      assert.equal(step.closes, undefined, kind);
      assert.equal(t.open?.id, id);
    }
  });

  test(`closing, origin rule (${label}, no frame for the message): every user-lane result closes the turn`, () => {
    for (const kind of USER_LANE) {
      const { t, id } = clientTurnOpen(false);
      assert.equal(t.result(result(origin(kind)), context).closes, id, String(kind));
    }
    // An autonomous origin that names the message is the turn's own answer.
    const { t, id } = clientTurnOpen(false);
    assert.equal(t.result(result({ originKind: 'task-notification', names: ['u1'] }), context).closes, id);
  });
}

test('the never-reported send: lifecycle listed but no frame for the message, the result is judged by its origin and the session logs it once', () => {
  const { t, id } = clientTurnOpen(false);
  t.sessionState('running');
  const autonomous = t.result(result({ originKind: 'task-notification' }), WITH);
  assert.deepEqual([autonomous.closes, autonomous.log], [undefined, [NO_LIFECYCLE_FOR_SEND]]);
  const user = t.result(result(), WITH);
  assert.equal(user.closes, id);
  assert.deepEqual(user.log, [], 'logged once per session');
  // Without the capability listed, the origin rule is the normal path and nothing is logged.
  const { t: plain } = clientTurnOpen(false);
  plain.sessionState('running');
  assert.deepEqual(plain.result(result(), WITHOUT).log, []);
});

test('the never-reported send after an announced cycle: the result that closes the turn reports the message taken in first', () => {
  const delivered = (id: string) => [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId: id, intoRunningTurn: true }];
  // A result naming the message, though no lifecycle frame ever named it.
  {
    const { t, id } = clientTurnOpen(false);
    assert.equal(t.frame({ kind: 'content' }, WITH).before[0]?.type, 'cli_cycle_started');
    const step = t.result(result({ names: ['u1'] }), WITH);
    assert.deepEqual([step.before, step.closes], [delivered(id), id]);
  }
  // A user-lane result naming nothing, judged the turn's own answer by its origin.
  {
    const { t, id } = clientTurnOpen(false);
    t.frame({ kind: 'content' }, WITH);
    assert.equal(t.result(result({ originKind: 'task-notification' }), WITH).closes, undefined, 'the cycle\'s own result');
    t.frame({ kind: 'content' }, WITH);
    const step = t.result(result(), WITH);
    assert.deepEqual([step.before, step.closes], [delivered(id), id]);
  }
  // Without lifecycle no cycle was announced, so nothing is reported about the message.
  {
    const { t, id } = clientTurnOpen(false);
    t.frame({ kind: 'content' }, WITHOUT);
    const step = t.result(result({ names: ['u1'] }), WITHOUT);
    assert.deepEqual([step.before, step.closes], [[], id]);
  }
});

test('a follow-up turn is judged like a client turn by its steered messages', () => {
  const t = tracker();
  t.pushed('s1');
  t.lifecycle('s1', 'queued');
  const { turnId } = t.openFollowUp(['s1']);
  assert.equal(t.result(result({ originKind: 'task-notification' }), WITH).closes, undefined, 'a cycle ahead of the steered message');
  t.lifecycle('s1', 'started');
  assert.equal(t.result(result({ originKind: 'task-notification' }), WITH).closes, turnId);
});

// ---- Idle --------------------------------------------------------------------------------------------------

test('idle: an idle the CLI owes no result ends the open turn with failed / no_result', () => {
  const { t, id } = cliTurnOpen();
  const step = t.sessionState('idle');
  assert.deepEqual(step.after, [
    { type: 'turn_completed', turnId: id, outcome: 'failed', resultText: '', isError: true, stopReason: null, terminalReason: 'no_result' },
  ]);
  assert.equal(t.open, undefined);
});

test('idle: the idle trailing a result, arriving after the next SendTurn was accepted, is absorbed and the new turn stays open', () => {
  const { t } = clientTurnOpen(true);
  t.lifecycle('u1', 'started');
  assert.ok(t.result(result({ names: ['u1'] }), WITH).closes);
  t.pushed('u2');
  const { turnId } = t.openClient('u2', 'client-2');
  t.lifecycle('u2', 'started');
  assert.deepEqual(types(t.sessionState('idle')), []);
  assert.equal(t.open?.id, turnId);
  // The next idle is owed nothing.
  assert.deepEqual(types(t.sessionState('idle')), ['turn_completed']);
});

test('idle: a transition into running clears the debt; a repeated running does not', () => {
  const { t } = cliTurnOpen();
  t.result(result(), WITH); // owes one idle
  t.sessionState('running');
  t.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(types(t.sessionState('idle')), ['turn_completed'], 'the debt was cleared by the transition');

  const repeated = cliTurnOpen().t;
  repeated.sessionState('running');
  repeated.result(result(), WITH); // owes one idle
  repeated.sessionState('running'); // not a transition
  repeated.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(types(repeated.sessionState('idle')), [], 'still owed');
  assert.ok(repeated.open !== undefined);

  const fromRequiresAction = cliTurnOpen().t;
  fromRequiresAction.result(result(), WITH);
  fromRequiresAction.sessionState('requires_action');
  fromRequiresAction.sessionState('running');
  fromRequiresAction.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(types(fromRequiresAction.sessionState('idle')), ['turn_completed']);
});

test('idle: placeholders owe an idle too', () => {
  const { t, id } = cliTurnOpen();
  t.result(result({ originKind: 'task-notification', numTurns: 0 }), WITH);
  assert.deepEqual(types(t.sessionState('idle')), []);
  assert.equal(t.open?.id, id);
});

test('idle: an un-owed idle before a client turn\'s message started is ignored; after it started, or after a running transition, it ends the turn', () => {
  const { t, id } = clientTurnOpen(true);
  assert.deepEqual(types(t.sessionState('idle')), []);
  assert.equal(t.open?.id, id);
  t.lifecycle('u1', 'started');
  assert.deepEqual(t.sessionState('idle').after.map((event) => [event.type, (event as { terminalReason?: string }).terminalReason]), [['turn_completed', 'no_result']]);

  const running = clientTurnOpen(false).t;
  running.sessionState('running');
  assert.deepEqual(types(running.sessionState('idle')), ['turn_completed']);
});

test('idle: a CLI that sends no state frames leaves turns to results, and the session logs that once', () => {
  const { t } = cliTurnOpen();
  assert.deepEqual(t.result(result(), WITH).log, [NO_STATE_FRAMES]);
  t.frame({ kind: 'requesting' }, WITH);
  assert.deepEqual(t.result(result(), WITH).log, []);
  const reporting = cliTurnOpen().t;
  reporting.sessionState('running');
  assert.deepEqual(reporting.result(result(), WITH).log, []);
});

// ---- A cycle ahead of a client turn's message -------------------------------------------------------------

test('a cycle ahead of the message, with lifecycle: output while the message waits announces a cycle once; its take-in is delivered into the turn', () => {
  const t = tracker();
  t.frame({ kind: 'task_started', taskId: 'b1', taskType: 'local_agent', description: 'explore' }, WITH);
  t.frame({ kind: 'task_notification', taskId: 'b1', status: 'completed' }, WITH);
  t.pushed('u1');
  const { turnId } = t.openClient('u1', 'client-1');
  t.lifecycle('u1', 'queued');
  assert.deepEqual(types(t.frame({ kind: 'stream' }, WITH)), [], 'framing is not output');
  assert.deepEqual(t.frame({ kind: 'content' }, WITH).before, [
    { type: 'cli_cycle_started', turnId, cause: { kind: 'task', taskId: 'b1', taskKind: 'local_agent', taskStatus: 'completed', description: 'explore' } },
  ]);
  assert.deepEqual(types(t.frame({ kind: 'content' }, WITH)), [], 'once per cycle');
  assert.equal(t.result(result({ originKind: 'task-notification' }), WITH).closes, undefined);
  assert.deepEqual(t.lifecycle('u1', 'started').after, [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId, intoRunningTurn: true }]);
  assert.deepEqual(types(t.frame({ kind: 'content' }, WITH)), [], 'the turn\'s own output');
  assert.equal(t.result(result({ names: ['u1'] }), WITH).closes, turnId);
});

test('a cycle ahead of the message: a result naming the waiting message delivers it into the turn and closes it', () => {
  const { t, id } = clientTurnOpen(true);
  t.frame({ kind: 'content' }, WITH);
  const step = t.result(result({ names: ['u1'] }), WITH);
  assert.deepEqual(step.before, [{ type: 'user_message_delivered', clientMessageId: 'client-1', turnId: id, intoRunningTurn: true }]);
  assert.equal(step.closes, id);
});

test('a cycle ahead of the message, without lifecycle: no cycle is announced, and only the origin rule keeps the cycle\'s result from closing the turn', () => {
  const { t, id } = clientTurnOpen(false);
  assert.deepEqual(types(t.frame({ kind: 'content' }, WITHOUT)), []);
  assert.equal(t.result(result({ originKind: 'task-notification' }), WITHOUT).closes, undefined);
  assert.equal(t.result(result(), WITHOUT).closes, id);
});

test('cycles: an ordinary send whose message the CLI takes in first never announces a cycle', () => {
  const { t, id } = clientTurnOpen(true);
  assert.deepEqual(types(t.lifecycle('u1', 'started')), []);
  assert.deepEqual(types(t.frame({ kind: 'content' }, WITH)), []);
  assert.equal(t.result(result({ names: ['u1'] }), WITH).closes, id);
});

test('the autonomous origins are exactly the five the CLI gives turns nobody typed', () => {
  assert.deepEqual([...AUTONOMOUS_ORIGINS].sort(), [...AUTONOMOUS].sort());
});
