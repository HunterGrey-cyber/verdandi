import type { WorkflowAgent, WorkflowProgress } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const UINT32_MAX = 0xffff_ffff;
const MAX_PHASES = 64;
const MAX_AGENTS = 256;

/** Reads the entry shapes the CLI sends (`workflow_phase`, `workflow_agent`, camelCase keys); any other shape is
 * dropped. Copy only public progress scalars. `prompt`, `promptPreview`, `resultPreview`, `workflow_log`
 * and transcript data never enter the projection. The encoder bounds strings on character
 * boundaries; these caps bound lists. */
export function parseWorkflowProgress(value: unknown): { progress?: WorkflowProgress; dropped: number } {
  if (value === undefined) return { dropped: 0 };
  if (!Array.isArray(value)) return { dropped: 1 };
  const progress: WorkflowProgress = { phases: [], agents: [] };
  let dropped = 0;
  for (const entry of value) {
    if (!object(entry)) { dropped++; continue; }
    if (entry.type === 'workflow_phase') {
      if (!uint(entry.index, UINT32_MAX) || typeof entry.title !== 'string' || (entry.kind !== undefined && typeof entry.kind !== 'string')) { dropped++; continue; }
      // The CLI can omit kind; an empty string preserves that absence without inventing a label.
      if (progress.phases.length < MAX_PHASES) progress.phases.push({ index: entry.index, title: entry.title, kind: entry.kind ?? '' });
    } else if (entry.type === 'workflow_agent') {
      const phaseIndex = entry.phaseIndex;
      if (!uint(entry.index, UINT32_MAX) || typeof entry.label !== 'string' || !uint(phaseIndex, UINT32_MAX) || typeof entry.state !== 'string') { dropped++; continue; }
      const agent: WorkflowAgent = { index: entry.index, label: entry.label, phaseIndex, state: entry.state };
      let valid = true;
      for (const [source, target] of [
        ['model', 'model'], ['agentType', 'agentType'], ['error', 'error'],
      ] as const) {
        if (entry[source] === undefined) continue;
        if (typeof entry[source] !== 'string') { valid = false; break; }
        agent[target] = entry[source];
      }
      for (const [source, target, max] of [
        ['tokens', 'tokens', Number.MAX_SAFE_INTEGER],
        ['toolCalls', 'toolCalls', UINT32_MAX],
        ['durationMs', 'durationMs', Number.MAX_SAFE_INTEGER],
      ] as const) {
        if (entry[source] === undefined) continue;
        if (!uint(entry[source], max)) { valid = false; break; }
        agent[target] = entry[source];
      }
      if (!valid) { dropped++; continue; }
      if (progress.agents.length < MAX_AGENTS) progress.agents.push(agent);
    } else dropped++;
  }
  return { progress, dropped };
}
