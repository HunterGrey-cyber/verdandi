import type { TurnCause } from './types.js';

/** Session-local tool facts. Missing or ambiguous facts never become an inferred job identity. */
export class ScheduleLedger {
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly wakeups = new Map<number, string | undefined>();
  private readonly jobs = new Map<string, { humanSchedule: string; prompt?: string }>();

  /** Reads complete tool blocks only; streaming fragments cannot establish successful scheduling. */
  observe(value: unknown): number {
    const message = record(value);
    if (message.parent_tool_use_id) return 0;
    const content = record(message.message).content;
    if (!Array.isArray(content)) return 0;
    let dropped = 0;
    for (const value of content) {
      const block = record(value);
      if (block.type === 'tool_use' && typeof block.name === 'string' && ['ScheduleWakeup', 'CronCreate', 'CronDelete'].includes(block.name)) {
        if (typeof block.id !== 'string' || !isRecord(block.input)) { dropped++; continue; }
        const input = block.input;
        if ((block.name === 'ScheduleWakeup' && input.reason !== undefined && typeof input.reason !== 'string') ||
            (block.name === 'CronCreate' && input.prompt !== undefined && typeof input.prompt !== 'string')) { dropped++; continue; }
        put(this.calls, block.id, { name: block.name, input });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = this.calls.get(block.tool_use_id);
        if (!call) continue;
        this.calls.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        const result = record(message.tool_use_result);
        if (call.name === 'ScheduleWakeup') {
          if (!finite(result.scheduledFor)) { dropped++; continue; }
          put(this.wakeups, result.scheduledFor, typeof call.input.reason === 'string' ? call.input.reason : undefined);
        } else if (call.name === 'CronCreate') {
          if (typeof result.id !== 'string' || typeof result.humanSchedule !== 'string') { dropped++; continue; }
          put(this.jobs, result.id, { humanSchedule: result.humanSchedule, ...(typeof call.input.prompt === 'string' ? { prompt: call.input.prompt } : {}) });
        } else if (typeof call.input.id === 'string') {
          this.jobs.delete(call.input.id);
        } else dropped++;
      }
    }
    return dropped;
  }

  fire(value: unknown): TurnCause {
    const raw = record(value);
    if (typeof raw.wakeup_source !== 'string') return { kind: 'unknown' };
    const source = raw.wakeup_source;
    const cause: TurnCause = { kind: 'scheduled', wakeupSource: source };
    if (finite(raw.scheduled_for)) cause.scheduledForMs = raw.scheduled_for;
    if (source === 'loop_wakeup' && finite(raw.scheduled_for)) {
      const reason = this.wakeups.get(raw.scheduled_for);
      if (reason !== undefined) cause.scheduleReason = reason;
      this.wakeups.delete(raw.scheduled_for);
    } else if (source === 'schedule_wakeup' && this.jobs.size === 1) {
      const [id, job] = this.jobs.entries().next().value!;
      cause.cronId = id;
      if (job.prompt !== undefined) cause.prompt = job.prompt;
    }
    return cause;
  }
}

function put<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 64) map.delete(map.keys().next().value!);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
