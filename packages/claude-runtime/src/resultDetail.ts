import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnResultDetail, TurnUsage } from './types.js';

/** At most this many `errors` entries reach a turn_completed; see `boundErrors`. */
export const MAX_RESULT_ERRORS = 8;
/** Each `errors` entry is cut to this many characters (plus a marker); see `boundErrors`. */
export const MAX_RESULT_ERROR_CHARS = 2000;

/**
 * Reads the parts of an SDK result message that `outcome`/`resultText` do not carry: its own
 * subtype, terminal reason, API error status, error list and structured output (muninn spec §6.3
 * P2). A pure function of one message.
 *
 * Read through a plain record rather than the SDK's union types on purpose. `api_error_status`
 * exists only on the success variant, `errors` only on the error variant, and a CLI on another
 * host may add or drop fields; every read here checks the runtime type and leaves a field ABSENT
 * rather than guessing, so a shape this code does not recognise becomes a missing field -- which a
 * consumer treats as "not proven" -- never a wrong value.
 */
export function resultDetail(message: Extract<SDKMessage, { type: 'result' }>): TurnResultDetail {
  const raw = message as unknown as Record<string, unknown>;
  const detail: TurnResultDetail = {};
  if (typeof raw.subtype === 'string') {
    detail.resultSubtype = raw.subtype;
  }
  if (typeof raw.terminal_reason === 'string') {
    detail.terminalReason = raw.terminal_reason;
  }
  // `null` is a real value on the success variant ("no API error"), and so is absence.
  if (typeof raw.api_error_status === 'number' && Number.isInteger(raw.api_error_status)) {
    detail.apiErrorStatus = raw.api_error_status;
  }
  if (Array.isArray(raw.errors)) {
    detail.errors = boundErrors(raw.errors);
  }
  // `undefined` is "not requested / not delivered"; anything else -- including `null` -- is what
  // the provider produced and is passed through for the caller's own validation.
  if (raw.structured_output !== undefined) {
    detail.structuredOutput = raw.structured_output;
  }
  const usage = usageFromModelUsage(raw.modelUsage);
  if (usage !== undefined) {
    detail.usage = usage;
  }
  return detail;
}

/**
 * Sums the SDK's per-model `modelUsage` into one `TurnUsage`. `modelUsage`, not the result's
 * `usage`: the SDK documents `usage` as "MAIN AGENT LOOP ONLY" and `modelUsage` as the field for
 * token/cost accounting (muninn spec review: an input check built on `usage.input_tokens` fails on
 * every real run, because the cached part of the prompt is not in it).
 *
 * Returns `undefined` -- never a zero-filled object -- when there is no object with at least one
 * entry to sum, so "no accounting" can never be mistaken for "free". A counter that is missing or
 * not a finite non-negative number counts as 0 within an entry that exists. Entries are visited in
 * key order so the result, including which model wins a tie, is deterministic.
 */
export function usageFromModelUsage(modelUsage: unknown): TurnUsage | undefined {
  if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) {
    return undefined;
  }
  const entries = Object.entries(modelUsage as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === 'object' && entry[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    return undefined;
  }
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0, model: '' };
  let heaviest = -1;
  for (const [model, entry] of entries) {
    const input = count(entry.inputTokens);
    const output = count(entry.outputTokens);
    const creation = count(entry.cacheCreationInputTokens);
    const read = count(entry.cacheReadInputTokens);
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.cacheCreationInputTokens += creation;
    usage.cacheReadInputTokens += read;
    usage.totalCostUsd += count(entry.costUSD);
    const weight = input + output + creation + read;
    if (weight > heaviest) {
      heaviest = weight;
      usage.model = model;
    }
  }
  return usage;
}

/**
 * Bounds a provider error list for the wire: at most MAX_RESULT_ERRORS entries, each at most
 * MAX_RESULT_ERROR_CHARS characters plus a marker. On overflow the last kept entry says how many
 * were dropped, so a reader never mistakes a truncated list for a complete one.
 */
export function boundErrors(errors: readonly unknown[]): string[] {
  const texts = errors.map(errorText);
  if (texts.length <= MAX_RESULT_ERRORS) {
    return texts;
  }
  const kept = texts.slice(0, MAX_RESULT_ERRORS - 1);
  kept.push(`(${texts.length - kept.length} more errors not shown)`);
  return kept;
}

function errorText(error: unknown): string {
  const text = typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
  return text.length > MAX_RESULT_ERROR_CHARS ? `${text.slice(0, MAX_RESULT_ERROR_CHARS)} [truncated]` : text;
}
