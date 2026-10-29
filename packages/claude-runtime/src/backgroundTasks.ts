import type { BackgroundTask, ClaudeRuntimeEvent, TaskKind, TaskStatus, TaskUsage, TurnCause } from './types.js';
import { parseWorkflowProgress } from './workflowProgress.js';
import { outputPathRefusal, taskDirectoryOf } from './taskOutput.js';

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const statuses: ReadonlySet<string> = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'killed']);
const status = (value: unknown): TaskStatus | undefined => typeof value === 'string' && statuses.has(value) ? value as TaskStatus : undefined;
const ENDED: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'stopped', 'killed']);
/** The first line of a background Bash call's result, as the CLI words it: the task's id and the file
 * its output goes to. A path is one run of non-space characters ending before the sentence's full stop.
 * The sentence ends with no delimiter after the path, so a path with a space in it cannot be told apart
 * from a shorter path followed by more words; see `LAUNCH_TEMPLATE_REST`. */
const LAUNCH_TEMPLATE = /^Command running in background with ID: (\S+)\. Output is being written to: (\S+)\.(?=\s|$)/;
/** What follows the path on the template's line is the CLI's prose, which names no path. A slash there
 * means the path had a space in it and the capture holds only its first part (which may be another file
 * entirely), so the template gives no path at all. */
const LAUNCH_TEMPLATE_REST = /^[^\n/]*(?:\n|$)/;

/** What StopTask and GetTaskOutput need to know about one task id. */
export type TaskControlView = { kind: TaskKind; ended: boolean };

/** One process's task identities and launching tools. Raw ids stay intact for joins; the sidecar
 * bounds the wire fields. Only selected scalars are retained, never prompts or transcript data. */
export class BackgroundTasks {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly tools = new Map<string, string>();
  /** The latest roster, so a task listed before its start is still one the host can stop. */
  private roster = new Map<string, BackgroundTask>();
  /** Ids whose latest run reported an ending status, with that run's id when the CLI named one; a new
   * start of the id clears it. */
  private readonly ended = new Map<string, string | undefined>();
  /** Accepted output files, by task id: only a shell's or a Monitor's, only from the CLI's own frames. */
  private readonly outputPaths = new Map<string, string>();
  /** Launch templates seen in a call's result before any task started from that call, by call id. */
  private readonly launchTemplates = new Map<string, { taskId: string; path: string }>();
  /** The directory of the first accepted output path: the CLI's task directory for this session. */
  private taskDirectory: string | undefined;
  /** The workflow task each workflow agent ran under, by agent id, from the workflow's progress. */
  private readonly agentOwners = new Map<string, string>();

  tool(id: string, name: string): void {
    this.tools.delete(id);
    this.tools.set(id, name);
    if (this.tools.size > 1024) this.tools.delete(this.tools.keys().next().value!);
  }

  started(raw: Raw): BackgroundTask {
    const previous = typeof raw.task_id === 'string' ? this.tasks.get(raw.task_id) : undefined;
    const task = this.task(raw, false);
    // A start is a new run unless both starts name the same run. The previous run's file is not this
    // run's output, so it stops answering until this run names its own.
    if (previous?.runId === undefined || previous.runId !== task.runId) this.outputPaths.delete(task.taskId);
    // Delete first so a task seen again moves to the newest end.
    this.tasks.delete(task.taskId);
    this.tasks.set(task.taskId, task);
    if (this.tasks.size > 256) this.tasks.delete(this.evictable());
    return this.join(task);
  }

  /** The identity to drop when the cache is full: the one seen longest ago among the tasks that have
   * ended and are not in the latest roster. A task still running keeps its kind and its progress
   * however many short tasks start and end around it; only when every entry may still be running is
   * the one seen longest ago dropped, so the cache stays bounded. */
  private evictable(): string {
    for (const id of this.tasks.keys()) if (this.ended.has(id) && !this.roster.has(id)) return id;
    return this.tasks.keys().next().value!;
  }

  private join(task: BackgroundTask): BackgroundTask {
    const tool = task.toolUseId === undefined ? undefined : this.tools.get(task.toolUseId);
    const kind: TaskKind = tool === 'Monitor' ? 'monitor' : tool === 'Bash' || tool === 'PowerShell' ? 'shell'
      : task.taskType === 'local_agent' ? 'local_agent' : task.taskType === 'local_bash' ? 'shell'
      : task.taskType === 'local_workflow' ? 'workflow' : 'other';
    return { ...task, kind };
  }

  private task(raw: Raw, level: boolean): BackgroundTask {
    const taskId = text(raw.task_id) ?? '';
    const known = this.tasks.get(taskId);
    // A new run cannot inherit the previous run's launching call. Before its start is seen the
    // roster has no launching tool, so even a Monitor is provisionally a shell.
    const started = known !== undefined && (raw.run_id === undefined || raw.run_id === known.runId) ? known : undefined;
    const out: BackgroundTask = {
      taskId, kind: 'shell', taskType: text(raw.task_type) ?? started?.taskType ?? '',
      description: text(raw.description) ?? started?.description ?? '', ambient: raw.ambient === true,
    };
    for (const [key, value] of [
      ['runId', raw.run_id], ['subagentType', raw.subagent_type],
      ['parentTaskId', raw.parent_task_id], ['toolUseId', raw.tool_use_id],
      ['workflowName', raw.workflow_name],
    ] as const) {
      const readable = text(value);
      if (readable !== undefined) out[key] = readable;
    }
    if (!level) return out;
    if (started === undefined) return out;
    return this.join({ ...started, ...out });
  }

  /** Whether `listed` (the roster's entry for `taskId`) is a newer run than the one the session saw. The
   * roster can list a new run of an id before that run's start arrives; a listed run other than the
   * one that ended (or, if none ended, the one that started) is live, whatever the earlier run's start
   * and end said. */
  private relisted(taskId: string, listed: BackgroundTask | undefined): boolean {
    return listed?.runId !== undefined && listed.runId !== (this.ended.has(taskId) ? this.ended.get(taskId) : this.tasks.get(taskId)?.runId);
  }

  /** Whether the session has seen `taskId` (started, or listed in the latest roster) and whether it
   * has ended; `undefined` for an id it never saw or has evicted. */
  control(taskId: string): TaskControlView | undefined {
    const listed = this.roster.get(taskId);
    const relisted = this.relisted(taskId, listed);
    const known = relisted ? listed : this.tasks.get(taskId) ?? listed;
    const ended = this.ended.has(taskId) && !relisted;
    if (known === undefined && !ended) return undefined;
    return { kind: known === undefined ? 'other' : this.join(known).kind, ended };
  }

  /**
   * Whether calls made by subagent `agentId` come from a background task that is still running: the
   * agent is itself a listed task (a background agent's task id is its agent id), or a workflow's
   * progress named it as one of that workflow's agents, or its task's parent chain reaches one. An
   * agent the session cannot place -- a foreground agent, which the roster never lists, or a workflow
   * agent whose progress has not arrived yet -- is not one.
   */
  runsInBackground(agentId: string): boolean {
    let id: string | undefined = this.agentOwners.get(agentId) ?? agentId;
    const seen = new Set<string>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      if (this.roster.has(id) && this.control(id)?.ended === false) return true;
      id = this.tasks.get(id)?.parentTaskId;
    }
    return false;
  }

  /** The output file accepted for `taskId`, if any. */
  outputPath(taskId: string): string | undefined {
    return this.outputPaths.get(taskId);
  }

  /**
   * One tool result. When its first line is the CLI's launch template, the path in it is a candidate
   * output file for the task named in it, taken only if this result belongs to the call that task
   * was started from and names that same task. A result whose call started no task yet is held until
   * one does; a template anywhere else (another call's result, a model's text) is never taken.
   */
  toolResult(toolUseId: string, content: unknown, diagnostic: (line: string) => void = () => {}): void {
    const first = typeof content === 'string' ? content
      : Array.isArray(content) && object(content[0])?.type === 'text' ? text(object(content[0])!.text) : undefined;
    const match = first === undefined ? null : LAUNCH_TEMPLATE.exec(first);
    if (match === null) return;
    const [whole, taskId, path] = match;
    if (!LAUNCH_TEMPLATE_REST.test(first!.slice(whole.length))) {
      diagnostic(`background task ${taskId}: output path refused (template_path_ambiguous)`);
      return;
    }
    let launched: BackgroundTask | undefined;
    for (const task of this.tasks.values()) if (task.toolUseId === toolUseId) launched = task;
    if (launched !== undefined) {
      this.takeTemplate(launched, taskId, path, diagnostic);
      return;
    }
    const named = this.tasks.get(taskId);
    if (named !== undefined) {
      // The named task started from a different call: this result is not its launch.
      diagnostic(`background task ${taskId}: output path refused (template_not_in_launching_result)`);
      return;
    }
    this.launchTemplates.delete(toolUseId);
    this.launchTemplates.set(toolUseId, { taskId, path });
    if (this.launchTemplates.size > 64) this.launchTemplates.delete(this.launchTemplates.keys().next().value!);
  }

  private takeTemplate(task: BackgroundTask, taskId: string, path: string, diagnostic: (line: string) => void): void {
    if (taskId !== task.taskId) {
      diagnostic(`background task ${task.taskId}: output path refused (template_id_mismatch)`);
      return;
    }
    this.acceptOutputPath(task.taskId, path, diagnostic);
  }

  /** Records `path` for a shell or Monitor task when it passes the path rules (see taskOutput.ts). A
   * local agent's or a workflow's file is not output a person reads, so it is ignored, and it never
   * fixes the task directory. */
  private acceptOutputPath(taskId: string, path: string, diagnostic: (line: string) => void): void {
    const known = this.tasks.get(taskId);
    if (known === undefined) return;
    const kind = this.join(known).kind;
    if (kind !== 'shell' && kind !== 'monitor') return;
    const refusal = outputPathRefusal(path, this.taskDirectory);
    if (refusal !== undefined) {
      diagnostic(`background task ${taskId}: output path refused (${refusal})`);
      return;
    }
    this.taskDirectory ??= taskDirectoryOf(path);
    this.outputPaths.delete(taskId);
    this.outputPaths.set(taskId, path);
    if (this.outputPaths.size > 256) this.outputPaths.delete(this.outputPaths.keys().next().value!);
  }

  /** Records which workflow ran each agent its progress names. Only the agent id is read. */
  private ownAgents(taskId: string, progress: unknown): void {
    if (!Array.isArray(progress)) return;
    for (const entry of progress) {
      const agent = object(entry);
      const agentId = agent?.type === 'workflow_agent' ? text(agent.agentId) : undefined;
      if (agentId === undefined || agentId === '') continue;
      this.agentOwners.delete(agentId);
      this.agentOwners.set(agentId, taskId);
      if (this.agentOwners.size > 1024) this.agentOwners.delete(this.agentOwners.keys().next().value!);
    }
  }

  /** Whether a frame names a run of its task older than the one the session saw start last. */
  private olderRun(raw: Raw): boolean {
    const known = typeof raw.task_id === 'string' ? this.tasks.get(raw.task_id) : undefined;
    return known?.runId !== undefined && typeof raw.run_id === 'string' && raw.run_id !== known.runId;
  }

  /** An ending status for the run the session knows; a frame naming an older run ends nothing. */
  private markEnded(raw: Raw, taskStatus: TaskStatus | undefined): void {
    if (taskStatus === undefined || !ENDED.has(taskStatus) || typeof raw.task_id !== 'string') return;
    if (this.olderRun(raw)) return;
    const run = text(raw.run_id) ?? this.tasks.get(raw.task_id)?.runId;
    this.ended.delete(raw.task_id);
    this.ended.set(raw.task_id, run);
    if (this.ended.size > 1024) this.ended.delete(this.ended.keys().next().value!);
  }

  cause(notification: { taskId: string; status?: string; summary?: string }): TurnCause {
    const task = this.tasks.get(notification.taskId);
    const taskStatus = status(notification.status);
    return {
      kind: 'task', taskId: notification.taskId,
      ...(task === undefined ? {} : { taskKind: this.join(task).kind, description: task.description }),
      ...(taskStatus === undefined ? {} : { taskStatus }),
      ...(notification.summary === undefined ? {} : { summary: notification.summary }),
    };
  }

  /** Recognized frames always return an array, even when malformed. An absent result lets the
   * ordinary translator handle unrelated messages without exposing a task frame as a raw notice. */
  translate(raw: Raw, diagnostic: (line: string) => void = () => {}): ClaudeRuntimeEvent[] | undefined {
    if (raw.type !== 'system' || typeof raw.subtype !== 'string' || !['background_tasks_changed', 'task_started', 'task_progress', 'task_updated', 'task_notification'].includes(raw.subtype)) return undefined;
    let dropped = 0;
    const string = (value: unknown): string | undefined => {
      if (value !== undefined && typeof value !== 'string') dropped++;
      return text(value);
    };
    const boolean = (value: unknown): boolean | undefined => {
      if (value !== undefined && typeof value !== 'boolean') dropped++;
      return typeof value === 'boolean' ? value : undefined;
    };
    const readStatus = (value: unknown): TaskStatus | undefined => {
      const out = status(value);
      if (value !== undefined && out === undefined) dropped++;
      return out;
    };
    const usage = (value: unknown): TaskUsage | undefined => {
      if (value === undefined) return undefined;
      const raw = object(value);
      if (!raw || !number(raw.total_tokens) || !number(raw.tool_uses) || !number(raw.duration_ms)) { dropped++; return undefined; }
      return { totalTokens: raw.total_tokens, toolUses: raw.tool_uses, durationMs: raw.duration_ms };
    };
    const validateTask = (raw: Raw): void => {
      for (const key of ['task_type', 'description', 'subagent_type', 'parent_task_id', 'tool_use_id', 'workflow_name']) string(raw[key]);
      boolean(raw.ambient);
    };
    const events: ClaudeRuntimeEvent[] = [];
    if (raw.subtype === 'background_tasks_changed') {
      const tasks: BackgroundTask[] = [];
      if (!Array.isArray(raw.tasks)) dropped++;
      else for (const entry of raw.tasks) {
        const item = object(entry);
        if (!item || typeof item.task_id !== 'string' || item.task_id === '') { dropped++; continue; }
        validateTask(item);
        string(item.run_id);
        tasks.push(this.task(item, true));
      }
      this.roster = new Map(tasks.map((task) => [task.taskId, task]));
      // A listed newer run makes the earlier run's file stale: it is not this run's output, and the
      // new run's start (or its launch template) names the file that is.
      for (const task of tasks) if (this.relisted(task.taskId, task)) this.outputPaths.delete(task.taskId);
      events.push({ type: 'background_tasks_changed', tasks });
    } else if (typeof raw.task_id !== 'string' || raw.task_id === '') {
      dropped++;
    } else {
      const edge = raw.subtype === 'task_started' ? 'started' : raw.subtype === 'task_progress' ? 'progress' : raw.subtype === 'task_updated' ? 'updated' : 'notified';
      const event: Extract<ClaudeRuntimeEvent, { type: 'task_event' }> = { type: 'task_event', edge, taskId: raw.task_id };
      const runId = string(raw.run_id);
      const reason = string(raw.reason);
      if (runId !== undefined) event.runId = runId;
      if (reason !== undefined) event.reason = reason;
      if (edge === 'started') {
        validateTask(raw);
        event.task = this.started(raw);
        this.ended.delete(raw.task_id);
        const held = event.task.toolUseId === undefined ? undefined : this.launchTemplates.get(event.task.toolUseId);
        if (held !== undefined) {
          this.launchTemplates.delete(event.task.toolUseId!);
          this.takeTemplate(event.task, held.taskId, held.path, diagnostic);
        }
        const backgrounded = boolean(raw.is_backgrounded);
        if (backgrounded !== undefined) event.isBackgrounded = backgrounded;
      } else if (edge === 'updated') {
        const patch = object(raw.patch);
        if (!patch && raw.patch !== undefined) dropped++;
        if (patch) {
          event.status = readStatus(patch.status);
          this.markEnded(raw, event.status);
          event.error = string(patch.error);
          event.isBackgrounded = boolean(patch.is_backgrounded);
          if (number(patch.end_time)) event.endTimeMs = patch.end_time;
          else if (patch.end_time !== undefined) dropped++;
        }
      } else {
        event.summary = string(raw.summary);
        event.usage = usage(raw.usage);
        if (edge === 'progress') {
          event.lastToolName = string(raw.last_tool_name);
          const task = this.tasks.get(raw.task_id);
          if (task && this.join(task).kind === 'workflow' && (raw.run_id === undefined || raw.run_id === task.runId)) {
            const parsed = parseWorkflowProgress(raw.workflow_progress);
            dropped += parsed.dropped;
            this.ownAgents(raw.task_id, raw.workflow_progress);
            if (parsed.progress !== undefined) event.workflowProgress = parsed.progress;
          }
        } else {
          event.status = readStatus(raw.status);
          event.outputFile = string(raw.output_file);
          this.markEnded(raw, event.status);
          // An older run's file is not the output of the run the session now shows.
          if (event.outputFile !== undefined && !this.olderRun(raw)) this.acceptOutputPath(raw.task_id, event.outputFile, diagnostic);
        }
      }
      events.push(event);
    }
    if (dropped > 0) diagnostic(`dropped ${dropped} malformed background task entries`);
    return events;
  }
}
