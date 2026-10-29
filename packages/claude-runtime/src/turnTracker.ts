import type { ClaudeRuntimeEvent, SteerDropReason, TurnCause, TurnOrigin } from './types.js';
import { BackgroundTasks } from './backgroundTasks.js';

/**
 * Who has the floor in a Claude session, read from the CLI's own frames: which turn is open, who
 * opened it, whether the CLI has taken the turn's own message in yet, and which result ends it.
 *
 * A pure state machine: it is told what the session sent and what each CLI frame was (`TurnFrame`,
 * built by `turnFrameOf`), and answers with the events that frame adds and the lines worth logging.
 * It never reads the clock, the network or the SDK, and it makes up no id except through the
 * `newTurnId` it is given.
 *
 * The rules, in short:
 * - A turn the CLI starts by itself opens on its first main-thread frame that shows work: an API
 *   request starting (`system/status: requesting`), a stream event, an assistant message, a tool
 *   result, or a lifecycle `started` for a message this session never sent (a scheduled prompt). A
 *   `system/init` alone does not open one: the CLI also sends it ahead of a coalesced notification
 *   that it then answers with an empty placeholder result, and a turn opened there would never close.
 * - A result closes the open turn unless it plainly belongs to something else: a placeholder never
 *   closes anything; while the open turn's own message is still waiting in the CLI, a result that does
 *   not name it ended a cycle the CLI ran first; without lifecycle reports, an autonomous result (the
 *   CLI's own origins) does not close a client turn. Every other origin, an unknown one included, is
 *   treated as the user's, because a user's result filed under the wrong turn would leave that turn
 *   open with nothing to say why.
 * - `session_state_changed: idle` closes a turn that never got a result, but only an idle the CLI
 *   owes no earlier result: `idle` trails each result and can arrive after the next turn opened.
 */
export class TurnTracker {
  private openTurn: OpenTurn | undefined;
  /** Idles still owed for results already seen. Never reset per turn; see `sessionState`. */
  private owedIdles = 0;
  private lastState: string | undefined;
  private stateFramesSeen = false;
  /** The newest task notification since the last result: the likeliest reason the CLI woke. */
  private notification: { taskId: string; status?: string; summary?: string } | undefined;
  /** Every message this session pushed (sends and steers) and whether the CLI reported on it yet. */
  private readonly messages = new Map<string, { seen: boolean }>();
  private readonly logged = new Set<string>();

  constructor(private readonly newTurnId: () => string, private readonly tasks = new BackgroundTasks()) {}

  /** The turn that is open now, if any. */
  get open(): Readonly<OpenTurnView> | undefined {
    const turn = this.openTurn;
    return turn === undefined ? undefined : { id: turn.id, origin: turn.origin, ownState: ownState(turn), cycleRunning: turn.cycleRunning };
  }

  /** Records a message the session handed the CLI, so lifecycle frames naming it can be told apart. */
  pushed(uuid: string): void {
    this.messages.set(uuid, { seen: false });
    if (this.messages.size > MAX_TRACKED) {
      this.messages.delete(this.messages.keys().next().value!);
    }
  }

  /** Opens the turn of a client send whose message went (or will go) to the CLI as `uuid`. */
  openClient(uuid: string, clientMessageId: string | undefined): TurnStartedEvent {
    return this.openLane('client', [uuid], clientMessageId);
  }

  /** Opens the turn steered messages run in after the turn they were steered into ended. */
  openFollowUp(uuids: string[]): TurnStartedEvent {
    return this.openLane('follow_up', uuids, undefined);
  }

  /** Counts a message steered into a follow-up turn the CLI has not started as one of its own. */
  addOwn(uuid: string): void {
    const turn = this.openTurn;
    if (turn !== undefined && turn.origin === 'follow_up' && ownState(turn) === 'pending') {
      turn.own.set(uuid, 'pending');
    }
  }

  /** Ends the open turn without a result (interrupt of a message never delivered, the session's end, a
   * follow-up whose every message was dropped). Returns the turn that was open. */
  close(): string | undefined {
    const id = this.openTurn?.id;
    this.openTurn = undefined;
    return id;
  }

  /**
   * One CLI frame other than a result or a session-state frame. `lifecycleReported`: the latest
   * `system/init` listed the CLI's message-lifecycle capability.
   */
  frame(frame: TurnFrame, context: { lifecycleReported: boolean }): TrackerStep {
    const step = emptyStep();
    switch (frame.kind) {
      case 'task_started':
        this.tasks.started({ task_id: frame.taskId, description: frame.description, task_type: frame.taskType, tool_use_id: frame.toolUseId, run_id: frame.runId });
        return step;
      case 'task_notification':
        this.notification = { taskId: frame.taskId, status: frame.status, summary: frame.summary };
        return step;
      case 'scheduled':
        this.openCliIfIdle(step, frame.cause);
        if (this.openTurn !== undefined && this.openTurn.origin !== 'cli') this.openTurn.cycleCause = frame.cause;
        return step;
      case 'lifecycle':
        if (frame.state === 'started' && !this.messages.has(frame.uuid)) {
          this.openCliIfIdle(step);
        }
        return step;
      case 'user_echo':
        return this.lifecycle(frame.uuid, 'started');
      case 'requesting':
      case 'stream':
        this.openCliIfIdle(step);
        return step;
      case 'content': {
        this.openCliIfIdle(step);
        const turn = this.openTurn!;
        if (turn.origin !== 'cli' && ownState(turn) === 'pending' && !turn.cycleRunning) {
          // The CLI produced output while this turn's own message still waits in its queue: the output
          // is a cycle of the CLI's own (a notification it was already answering, a scheduled prompt),
          // and the message runs after it.
          turn.cycleRunning = true;
          if (context.lifecycleReported) {
            turn.cycleAnnounced = true;
            step.before.push({ type: 'cli_cycle_started', turnId: turn.id, cause: turn.cycleCause ?? this.openingCause() });
          }
        }
        return step;
      }
      default:
        return step;
    }
  }

  /**
   * A `command_lifecycle` frame (or an echo) naming a message this session pushed. Events for the
   * open client turn's own message; nothing for any other message, whose fate the session reports.
   */
  lifecycle(uuid: string, state: string): TrackerStep {
    const step = emptyStep();
    const message = this.messages.get(uuid);
    if (message !== undefined) {
      message.seen = true;
    }
    const turn = this.openTurn;
    const current = turn?.own.get(uuid);
    if (turn === undefined || current !== 'pending') {
      return step;
    }
    if (state === 'started' || state === 'completed') {
      turn.own.set(uuid, 'started');
      if (turn.origin === 'client' && turn.cycleAnnounced && turn.clientMessageId !== undefined) {
        step.after.push({ type: 'user_message_delivered', clientMessageId: turn.clientMessageId, turnId: turn.id, intoRunningTurn: true });
      }
    } else if (DROP_STATES.has(state)) {
      turn.own.set(uuid, 'dropped');
      if (turn.origin !== 'client') {
        return step;
      }
      if (turn.clientMessageId !== undefined) {
        step.after.push({ type: 'user_message_dropped', clientMessageId: turn.clientMessageId, reason: state as SteerDropReason });
      }
      if (!turn.cycleRunning) {
        // Nothing is running, so no result will come for this turn: it ends here, without a reply.
        this.openTurn = undefined;
        step.after.push({ type: 'turn_completed', turnId: turn.id, outcome: 'completed', resultText: '', isError: false, stopReason: null });
      }
    }
    return step;
  }

  /** `system/session_state_changed`. Consumed here; nothing about it is forwarded. */
  sessionState(state: string): TrackerStep {
    const step = emptyStep();
    this.stateFramesSeen = true;
    const previous = this.lastState;
    this.lastState = state;
    if (state === 'running' && previous !== 'running') {
      // The idle period before this ended, so any idle still owed will never come (the CLI withholds
      // idle while background agents run).
      this.owedIdles = 0;
      if (this.openTurn !== undefined) {
        this.openTurn.runningSinceOpen = true;
      }
      return step;
    }
    if (state !== 'idle') {
      return step;
    }
    if (this.owedIdles > 0) {
      this.owedIdles -= 1;
      return step;
    }
    const turn = this.openTurn;
    if (turn === undefined) {
      return step;
    }
    // Before the CLI took a client turn's message in, an idle belongs to the time before that message
    // reached it.
    if (turn.origin !== 'cli' && ownState(turn) !== 'started' && !turn.runningSinceOpen) {
      return step;
    }
    this.openTurn = undefined;
    step.after.push({
      type: 'turn_completed',
      turnId: turn.id,
      outcome: 'failed',
      resultText: '',
      isError: true,
      stopReason: null,
      terminalReason: NO_RESULT,
    });
    return step;
  }

  /**
   * A result frame. `closes` names the turn it ends, which the session completes with the result's own
   * details; `before` holds what must precede that completion.
   */
  result(result: ResultFacts, context: { lifecycleReported: boolean }): TrackerStep {
    const step = emptyStep();
    this.owedIdles += 1;
    if (!this.stateFramesSeen) {
      this.logOnce(step, NO_STATE_FRAMES);
    }
    const turn = this.openTurn;
    const namesOwn = turn !== undefined && result.names.some((uuid) => turn.own.has(uuid));
    const scheduledCycle = turn?.cycleCause?.kind === 'scheduled';
    const autonomous = (scheduledCycle || (result.originKind !== undefined && AUTONOMOUS_ORIGINS.has(result.originKind))) && !namesOwn;
    const placeholder = autonomous && result.numTurns === 0 && !result.isError;
    const cause = this.openingCause();
    this.notification = undefined;
    if (placeholder) {
      return step;
    }
    if (turn === undefined) {
      // Every frame that shows work opens a turn, so this is a result with nothing before it. It is still
      // reported as the CLI's turn, opened and closed, so no completion ever names a turn nobody started.
      const id = this.newTurnId();
      const refined = refinedCause(cause, result);
      step.before.push({ type: 'turn_started', turnId: id, origin: 'cli', cause: result.originKind === 'peer' ? cause : refined ?? cause });
      if (result.originKind === 'peer' && refined !== undefined) {
        step.before.push({ type: 'turn_cause_updated', turnId: id, cause: refined });
      }
      step.closes = id;
      return step;
    }
    if (turn.origin === 'cli') {
      const refined = turn.cause === undefined ? undefined : refinedCause(turn.cause, result);
      if (refined !== undefined) {
        step.before.push({ type: 'turn_cause_updated', turnId: turn.id, cause: refined });
      }
      return this.closeAt(step, turn);
    }
    const state = ownState(turn);
    if (state === 'pending') {
      const seen = [...turn.own.keys()].some((uuid) => this.messages.get(uuid)?.seen === true);
      if (!seen && context.lifecycleReported) {
        // The CLI never said anything about this message (a local slash command, a CLI that skipped the
        // frame).
        this.logOnce(step, NO_LIFECYCLE_FOR_SEND);
      }
      if (namesOwn) {
        return this.closeTakenIn(step, turn);
      }
      if (seen || autonomous) {
        // A cycle the CLI ran before taking this turn's message in: the result is that cycle's. With no
        // report about the message, only an autonomous origin says so.
        turn.cycleRunning = false;
        turn.cycleCause = undefined;
        return step;
      }
      // No report about the message and a result of the user's lane: judged by its origin alone, as for a
      // CLI that reports no lifecycle, this result is the turn's own answer.
      return this.closeTakenIn(step, turn);
    }
    // The message started (it drained into whatever cycle was running, which is this turn's now) or
    // was dropped while a cycle ran: either way this result ends the turn.
    return this.closeAt(step, turn);
  }

  /**
   * Ends a turn whose own message was still pending, at a result that answered it. When a cycle ahead of
   * the message was announced, the message's take-in is reported first: a client that set it aside for
   * that cycle would otherwise never learn it ran.
   */
  private closeTakenIn(step: TrackerStep, turn: OpenTurn): TrackerStep {
    if (turn.origin === 'client' && turn.cycleAnnounced && turn.clientMessageId !== undefined) {
      step.before.push({ type: 'user_message_delivered', clientMessageId: turn.clientMessageId, turnId: turn.id, intoRunningTurn: true });
    }
    return this.closeAt(step, turn);
  }

  private closeAt(step: TrackerStep, turn: OpenTurn): TrackerStep {
    this.openTurn = undefined;
    step.closes = turn.id;
    return step;
  }

  private openLane(origin: 'client' | 'follow_up', uuids: string[], clientMessageId: string | undefined): TurnStartedEvent {
    const id = this.newTurnId();
    this.openTurn = {
      id,
      origin,
      own: new Map(uuids.map((uuid) => [uuid, 'pending'])),
      clientMessageId,
      runningSinceOpen: false,
      cycleRunning: false,
      cycleAnnounced: false,
    };
    return { type: 'turn_started', turnId: id, origin };
  }

  private openCliIfIdle(step: TrackerStep, openingCause?: TurnCause): void {
    if (this.openTurn !== undefined) {
      return;
    }
    const cause = openingCause ?? this.openingCause();
    this.openTurn = { id: this.newTurnId(), origin: 'cli', cause, own: new Map(), runningSinceOpen: false, cycleRunning: false, cycleAnnounced: false };
    step.before.push({ type: 'turn_started', turnId: this.openTurn.id, origin: 'cli', cause });
  }

  /** Why the CLI is working on its own now: the newest task notification since the last result. */
  private openingCause(): TurnCause {
    const notification = this.notification;
    if (notification === undefined) {
      return { kind: 'unknown' };
    }
    return this.tasks.cause(notification);
  }

  private logOnce(step: TrackerStep, line: string): void {
    if (!this.logged.has(line)) {
      this.logged.add(line);
      step.log.push(line);
    }
  }
}

export type TurnStartedEvent = Extract<ClaudeRuntimeEvent, { type: 'turn_started' }>;

/** What the tracker reads from one CLI frame; see `turnFrameOf`. */
export type TurnFrame =
  /** `system/status: requesting`, on the main thread: an API request is starting. */
  | { kind: 'requesting' }
  /** A main-thread stream event that carries no content (message start, block framing). */
  | { kind: 'stream' }
  /** Main-thread output: an assistant message, a stream content delta, a tool result. */
  | { kind: 'content' }
  /** A main-thread user frame that is not a tool result and carries a uuid. */
  | { kind: 'user_echo'; uuid: string }
  /** A `command_lifecycle` frame. */
  | { kind: 'lifecycle'; uuid: string; state: string }
  | { kind: 'session_state'; state: string }
  | { kind: 'task_started'; taskId: string; description?: string; taskType?: string; toolUseId?: string; runId?: string }
  | { kind: 'task_notification'; taskId: string; status?: string; summary?: string }
  | ({ kind: 'result' } & ResultFacts)
  | { kind: 'scheduled'; cause: TurnCause }
  /** Anything else. All frames with a parent tool call are classified here before reading their
   * type, so a child's result, lifecycle or idle cannot open or close the main thread's turn. */
  | { kind: 'other' };

/** What a result says about whose it is. */
export type ResultFacts = {
  /** `origin.kind`, verbatim; absent when the result had no origin. */
  originKind?: string;
  peerName?: string;
  peerBody?: string;
  numTurns?: number;
  isError: boolean;
  /** The pushed messages it answered (`user_message_uuids`, and `user_message_uuid` from older CLIs). */
  names: string[];
};

export type TrackerStep = {
  /** Events that go ahead of the frame's own. */
  before: ClaudeRuntimeEvent[];
  /** Events that go after the frame's own. */
  after: ClaudeRuntimeEvent[];
  /** The turn a result ends; the session completes it with the result's details. */
  closes?: string;
  /** Lines for the session's log, each at most once per session. */
  log: string[];
};

export type OpenTurnView = {
  id: string;
  origin: TurnOrigin;
  /** The state of the turn's own messages; `none` for a turn the CLI started. */
  ownState: OwnState | 'none';
  cycleRunning: boolean;
};

type OwnState = 'pending' | 'started' | 'dropped';

type OpenTurn = {
  id: string;
  origin: TurnOrigin;
  cause?: TurnCause;
  /** The turn's own messages: a client turn's one, a follow-up's steered ones. Empty for a CLI turn. */
  own: Map<string, OwnState>;
  clientMessageId?: string;
  runningSinceOpen: boolean;
  /** Output came while the own message still waited: the CLI is running a cycle of its own first. */
  cycleRunning: boolean;
  cycleCause?: TurnCause;
  /** A `cli_cycle_started` went out for this turn, so the take-in of its message is reported too. */
  cycleAnnounced: boolean;
};

function ownState(turn: OpenTurn): OwnState | 'none' {
  if (turn.own.size === 0) {
    return 'none';
  }
  const states = [...turn.own.values()];
  if (states.includes('started')) {
    return 'started';
  }
  return states.every((state) => state === 'dropped') ? 'dropped' : 'pending';
}

function emptyStep(): TrackerStep {
  return { before: [], after: [], log: [] };
}

/** A cause read at the close, for a turn whose cause said nothing more specific. */
function refinedCause(cause: TurnCause, result: ResultFacts): TurnCause | undefined {
  const originKind = result.originKind;
  if (cause.kind === 'scheduled') return undefined;
  if (originKind === 'peer') {
    return { kind: 'peer', ...(result.peerName === undefined ? {} : { peerName: result.peerName }), ...(result.peerBody === undefined ? {} : { text: boundPeer(result.peerBody) }) };
  }
  if (cause.kind !== 'unknown') {
    return undefined;
  }
  if (originKind === 'task-notification') {
    return { kind: 'task' };
  }
  if (originKind === 'coordinator' || originKind === 'observer') {
    return { kind: 'other' };
  }
  return undefined;
}

/** The result origins the CLI gives turns nobody typed. Every other origin, absent and unknown ones
 * included, is the user's. */
export const AUTONOMOUS_ORIGINS: ReadonlySet<string> = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity']);

/** `terminal_reason` of a turn the CLI went idle on without a result. */
export const NO_RESULT = 'no_result';
export const NO_STATE_FRAMES = 'no session state frames from this CLI';
export const NO_LIFECYCLE_FOR_SEND = 'no lifecycle frames for a stamped send';

const DROP_STATES: ReadonlySet<string> = new Set(['cancelled', 'discarded', 'refused']);
const MAX_TRACKED = 256;

function boundPeer(text: string): string {
  const characters = Array.from(text);
  return characters.length > 2000 ? `${characters.slice(0, 2000).join('')}…` : text;
}
