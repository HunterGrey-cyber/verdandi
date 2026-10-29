/**
 * The limits on what a new event may carry, and the one way a longer value is shortened. Every string
 * and list the CLI controls is cut here before it reaches the wire; a client re-checks the same
 * limits on receipt and cuts again rather than trust them. Lengths count characters (code points),
 * and a value is never split inside one.
 */

/** Ids and names: task, run, parent, subagent, workflow, peer, model and conversation ids. */
export const ID_MAX_CHARS = 128;
/** Type words the CLI names: `task_type`, `trigger`, `origin_kind`, `last_tool_name`, `wakeup_source`, a retry's error kind and a fallback's scope. */
export const WORD_MAX_CHARS = 64;
/** `description` and `schedule_reason`, and one workflow agent's `error`. */
export const DESCRIPTION_MAX_CHARS = 500;
/** `summary`, `text`, `content`, `error`, `prompt`, a peer body, a task's `reason` and the reason text an interaction carries. */
export const TEXT_MAX_CHARS = 2000;
/** `output_file`: a path. */
export const PATH_MAX_CHARS = 1024;
/** The tail of a task's output, in bytes. */
export const TASK_OUTPUT_MAX_BYTES = 8192;

/** Tasks in one `BackgroundTasksChanged`. */
export const MAX_TASKS_PER_LEVEL = 256;
/** Phases in one `WorkflowProgress`. */
export const MAX_WORKFLOW_PHASES = 64;
/** Agents in one `WorkflowProgress`. */
export const MAX_WORKFLOW_AGENTS = 256;

/** A workflow phase's `title` and `kind`, and a workflow agent's `label`, `state`, `model` and `agent_type`. */
export const WORKFLOW_LABEL_MAX_CHARS = 128;
/** A workflow agent's `error`. */
export const WORKFLOW_ERROR_MAX_CHARS = DESCRIPTION_MAX_CHARS;

const ELLIPSIS = '…';

/**
 * `text` as it is when it has at most `max` characters; otherwise its first `max - 1` characters
 * followed by `…`, so the result is never longer than `max` and cutting it again changes nothing.
 * A character outside the Basic Multilingual Plane counts once and is kept whole or dropped whole.
 */
export function cut(text: string, max: number): string {
  // A string's code points never outnumber its UTF-16 units, so a short one needs no counting.
  if (text.length <= max) {
    return text;
  }
  if (max < 1) {
    return '';
  }
  const keep = max - 1;
  let count = 0;
  let offset = 0;
  let keepEnd = 0;
  for (const char of text) {
    if (count === keep) {
      keepEnd = offset;
    }
    count += 1;
    if (count > max) {
      return text.slice(0, keepEnd) + ELLIPSIS;
    }
    offset += char.length;
  }
  return text;
}
