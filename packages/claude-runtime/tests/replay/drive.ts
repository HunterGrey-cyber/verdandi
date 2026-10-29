import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession, type ClaudeRuntimeSession } from '../../src/session.js';
import { TaskNotFoundError } from '../../src/taskOutput.js';
import type { ClaudeRuntimeEvent } from '../../src/types.js';
import { makeFakeQuery, type FakeQueryController } from '../fakeQuery.js';
import { mapStrings, type Line, type Wire } from './recording.js';

export type Step = { line: Line; events: ClaudeRuntimeEvent[]; activeTurn?: string; pushedUuid?: string };
export type Replay = { steps: Step[]; events: ClaudeRuntimeEvent[]; pushed: SDKUserMessage[]; skippedStopTasks: number; skippedSteers: number; log: string[] };
export function remapUuids<T>(value: T, uuids: Map<string, string>): T {
  return mapStrings(value, text => uuids.get(text) ?? text);
}
/** Lets a test act on the live session: after each step (its index in `messages`), and once more after
 * the last one, before the session is closed. */
export type DriveHooks = {
  afterStep?: (index: number, session: ClaudeRuntimeSession, fake: FakeQueryController) => Promise<void>;
  beforeClose?: (session: ClaudeRuntimeSession, fake: FakeQueryController) => Promise<void>;
};
export async function drive(messages: Line[], cwd: string, hooks: DriveHooks = {}): Promise<Replay> {
  const { query, controller: fake } = makeFakeQuery();
  const log: string[] = [];
  const session = createSession({ cwd, policy: {
    configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled', streaming: 'partial',
  } }, params => {
    fake.captureInput(params.prompt as AsyncIterable<SDKUserMessage>);
    return query;
  }, { onDiagnostic: line => log.push(line) });
  const uuids = new Map<string, string>();
  const steps: Step[] = [];
  const events: ClaudeRuntimeEvent[] = [];
  let activeTurn: string | undefined;
  let skippedStopTasks = 0;
  let skippedSteers = 0;
  try {
    for (const line of messages) {
      const m = line.message;
      const step: Step = { line, events: [], activeTurn };
      if (line.from === 'host') {
        if (m.type === 'user') {
          const content = m.message?.content;
          const text = typeof content === 'string' ? content : (content ?? []).filter((b: Wire) => b.type === 'text').map((b: Wire) => b.text).join('\n');
          const options = m.origin?.kind === 'human' ? { typedByPerson: true } : undefined;
          const before = fake.pushed.length;
          let sent;
          // A host that sees a turn running (one the CLI started by itself included) steers into it, as the
          // recorded host's newer self does; a send is refused while any turn runs.
          if (activeTurn) {
            try { sent = session.steerTurn(activeTurn ?? '', m.uuid ?? `recorded-${steps.length}`, text, options); }
            catch (error) {
              // A CLI that reports no message lifecycle cannot be steered: the text is held back (counted).
              if ((error as { reason?: string }).reason !== 'cli_lifecycle_not_reported') throw error;
              skippedSteers++;
            }
          } else sent = session.sendTurn(text, options); // a steer with no turn running is a plain send
          if (sent) {
            activeTurn = sent.turnId;
            await Promise.resolve();
            await Promise.resolve();
            const pushed = fake.pushed[before];
            if (!pushed) throw new Error('host message was not pushed');
            step.pushedUuid = pushed.uuid;
            if (typeof m.uuid === 'string' && pushed.uuid) uuids.set(m.uuid, pushed.uuid);
          }
        } else if (m.request?.subtype === 'interrupt') {
          await session.interrupt();
        } else if (m.request?.subtype === 'stop_task') {
          // A recorded stop names a task of the recorded run; one this replay never saw start is counted.
          try { await session.stopTask(m.request.task_id); }
          catch (error) {
            if (!(error instanceof TaskNotFoundError)) throw error;
            skippedStopTasks++;
          }
        }
      } else {
        fake.emit(remapUuids(m, uuids) as SDKMessage);
      }
      // pump is poll-only; yield once so its pending iterator read can settle.
      step.events.push(...await session.pump());
      await Promise.resolve();
      step.events.push(...await session.pump());
      for (const event of step.events) {
        if (event.type === 'turn_started') activeTurn = event.turnId;
        if (event.type === 'turn_completed' && event.turnId === activeTurn) activeTurn = undefined;
      }
      steps.push(step);
      events.push(...step.events);
      await hooks.afterStep?.(steps.length - 1, session, fake);
    }
    await hooks.beforeClose?.(session, fake);
    return { steps, events, pushed: fake.pushed, skippedStopTasks, skippedSteers, log };
  } finally { session.close(); }
}
