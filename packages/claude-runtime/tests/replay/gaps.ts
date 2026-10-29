import type { Replay, Step } from './drive.js';
import type { Wire } from './recording.js';

const output = (step: Step): Wire[] => step.events;
const isContent = (m: Wire) => m.type === 'assistant' || (m.type === 'stream_event' && m.event?.type === 'content_block_delta');
const main = (m: Wire) => !m.parent_tool_use_id;
const notice = (step: Step) => output(step).some(e => e.type === 'provider_notice');
const taskFrame = (m: Wire) => m.type === 'system' && ['task_started', 'task_updated', 'task_progress', 'task_notification', 'background_tasks_changed'].includes(m.subtype);
const childContent = (m: Wire) => isContent(m) || m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some((b: Wire) => b.type === 'tool_result');
const taskOut = (step: Step) => output(step).some(e => ['background_tasks_changed', 'task_event'].includes(e.type));
const peerHold = (m: Wire) => (m.type === 'peer_message_hold' || m.type === 'system' && m.subtype === 'peer_message_hold') && ['held', 'released', 'dropped'].includes(m.state);
const warningKinds = new Set(['informational', 'model_refusal_fallback', 'model_refusal_no_fallback', 'compact_boundary', 'notification', 'model_fallback']);

/** Compare the text delivered for a message against its complete recorded text. */
function textMismatches(replay: Replay): { index: number; childBetween: boolean; partialAttempt: boolean; relabeled: boolean }[] {
  const mismatches = [];
  for (const [index, step] of replay.steps.entries()) {
    const m = step.line.message;
    if (step.line.from !== 'cli' || m.type !== 'assistant') continue;
    const expected = (m.message?.content ?? []).filter((b: Wire) => b.type === 'text').map((b: Wire) => b.text).join('');
    if (!expected || !main(m)) continue;
    const id = m.message?.id;
    let start = index;
    while (start > 0) {
      const prev = replay.steps[start - 1].line.message;
      if (prev.type === 'stream_event' && prev.parent_tool_use_id === m.parent_tool_use_id && prev.event?.type === 'message_start') { start--; break; }
      if (prev.type === 'assistant' && prev.parent_tool_use_id === m.parent_tool_use_id && prev.message?.id !== id) break;
      start--;
    }
    const window = replay.steps.slice(start, index + 1);
    const emitted = window.flatMap(s => output(s)).filter(e => e.type === 'text_delta' && (id ? e.messageId === id : true));
    const actual = emitted.map(e => e.text).join('');
    // Completely invisible replies are accounted for by the turn/child predicates instead.
    if (actual === expected || emitted.length === 0 && notice(step)) continue;
    const streams = window.filter(s => s.line.message.type === 'stream_event' && s.line.message.event?.type === 'content_block_delta');
    const lastStart = window.find(s => s.line.message.event?.type === 'message_start')?.line.message.event?.message?.id;
    mismatches.push({ index,
      childBetween: main(m) && window.some(s => s.line.message.type === 'assistant' && !main(s.line.message)),
      partialAttempt: streams.length > 0 && typeof lastStart === 'string' && lastStart !== id,
      relabeled: new Set(emitted.map(e => e.turnId)).size > 1 || window.some((s, i) => s.line.from === 'host' && s.line.message.type === 'user' &&
        window.slice(0, i).some(p => p.line.message.type === 'stream_event' && p.line.message.event?.type === 'content_block_delta')),
    });
  }
  return mismatches;
}
export const gapPredicates: Record<string, (replay: Replay) => boolean> = {
  'unprompted-cli-turn-invisible': r => r.steps.some(s => s.line.from === 'cli' && main(s.line.message) && isContent(s.line.message) &&
    (output(s).some(e => e.type === 'provider_notice' && e.subtype === 'no_turn_in_progress') || output(s).length === 0 && !s.activeTurn)),
  'unprompted-unknown-turn-completion-folded': r => r.events.some(e => e.type === 'turn_completed' && e.turnId === 'unknown-turn'),
  'unprompted-sendturn-collides-with-cli-turn': r => r.steps.some((s, index) => {
    // Only a turn the host's send opened can be taken by the CLI's own result; a turn the CLI started
    // itself, or a follow-up, ending at that result is no collision.
    const origins = new Map(r.events.flatMap(e => e.type === 'turn_started' ? [[e.turnId, e.origin ?? 'client'] as const] : []));
    const m = s.line.message;
    if (s.line.from !== 'cli' || m.type !== 'result') return false;
    const completions = output(s).filter(e => e.type === 'turn_completed');
    const prior = r.steps.slice(0, index);
    const initIndex = prior.map(p => p.line.message.type === 'system' && p.line.message.subtype === 'init').lastIndexOf(true);
    // Every message the result says it answered: newer CLIs list them all, older ones name one.
    const names = new Set([m.user_message_uuid, ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])].filter(u => typeof u === 'string'));
    return completions.some(e => {
      if (m.origin && e.originKind === undefined) return true;
      if (origins.get(e.turnId) !== 'client' || !s.activeTurn) return false;
      // The host send that opened the completed turn (later host lines are steers into it or after it):
      // the result is the turn's own when it names that send's message.
      const opened = prior.findIndex(p => p.events.some(o => o.type === 'turn_started' && o.turnId === e.turnId));
      const hostIndex = prior.slice(0, opened + 1).map(p => p.line.from === 'host' && p.line.message.type === 'user').lastIndexOf(true);
      const host = prior[hostIndex];
      if (opened < 0 || !host || names.has(host.line.message.uuid)) return false;
      // An init preceding that send belongs to the CLI cycle already running when it went in.
      const overlapsCliCycle = initIndex >= 0 && initIndex < hostIndex;
      return Boolean(m.origin || overlapsCliCycle);
    });
  }),
  'unprompted-relabel-truncates-streamed-reply': r => textMismatches(r).some(m => m.relabeled),
  'coverage-subagent-resets-stream-flag': r => textMismatches(r).some(m => m.childBetween),
  'coverage-partial-attempt-suppresses-reply': r => textMismatches(r).some(m => m.partialAttempt),
  'coverage-subagent-flattened': r => r.steps.some(s => s.line.from === 'cli' && !main(s.line.message) && childContent(s.line.message) &&
    (output(s).length === 0 || output(s).some(e => e.type === 'provider_notice' && e.subtype === 'no_turn_in_progress') ||
      output(s).some(e => ['text_delta', 'thinking_delta', 'tool_call_started', 'tool_call_completed'].includes(e.type) && e.parentToolUseId !== s.line.message.parent_tool_use_id))),
  'unprompted-no-background-task-state': r => r.steps.some(s => taskFrame(s.line.message) && !taskOut(s)),
  'wf-2': r => {
    const workflow = r.steps.filter(s => s.line.message.task_type === 'local_workflow' || s.line.message.workflow_progress);
    const tasks = r.events.filter(e => ['background_tasks_changed', 'task_event'].includes(e.type));
    const containsWorkflow = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      const object = value as Wire;
      if (object.kind === 'workflow' || object.kind === 'WORKFLOW') return true;
      return Object.values(object).some(containsWorkflow);
    };
    return workflow.length > 0 && (!tasks.some(containsWorkflow) ||
      workflow.some(s => s.line.message.workflow_progress && !output(s).some(e => e.workflowProgress || e.workflow_progress)));
  },
  'wf-6': r => r.steps.some((s, i) => {
    const m = s.line.message;
    if (!(m.subtype === 'scheduled_task_fire' || m.wakeup_source || ['scheduled', 'scheduled-task', 'scheduled-wakeup'].includes(m.origin?.kind))) return false;
    return !r.steps.slice(i).flatMap(output).some(e => e.cause?.kind === 'SCHEDULED' || e.cause?.kind === 'scheduled');
  }),
  'coverage-warnings-dropped': r => r.steps.some(s => (warningKinds.has(s.line.message.subtype) || peerHold(s.line.message) || s.line.message.subtype === 'status' && s.line.message.status === 'compacting') && (notice(s) || output(s).length === 0)),
  'coverage-api-retry-invisible': r => r.steps.some(s => s.line.message.subtype === 'api_retry' && (notice(s) || output(s).length === 0)),
  'coverage-rate-limit-event-dropped': r => r.steps.some(s => s.line.message.type === 'rate_limit_event' && (notice(s) || output(s).length === 0)),
  'coverage-clear-reset-dropped': r => r.steps.some(s => (s.line.message.type === 'conversation_reset' || s.line.message.subtype === 'conversation_reset') && (notice(s) || output(s).length === 0)),
};
export function holdingGaps(replay: Replay): string[] {
  return Object.entries(gapPredicates).filter(([, holds]) => holds(replay)).map(([id]) => id).sort();
}
export function assertGapLedger(name: string, listed: string[], holding: string[]): void {
  for (const id of listed) {
    if (!(id in gapPredicates)) throw new Error(`${name}: unknown gap ${id}`);
    if (!holding.includes(id)) throw new Error(`${name}: fixed: delete ${id}`);
  }
  for (const id of holding) if (!listed.includes(id)) throw new Error(`${name}: unlisted gap ${id}`);
  if (new Set(listed).size !== listed.length) throw new Error(`${name}: duplicate gap`);
}
