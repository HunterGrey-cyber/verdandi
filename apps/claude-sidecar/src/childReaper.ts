import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Ends this process's own child processes -- in practice the `claude` CLIs the Agent SDK spawned for
 * its sessions -- and waits for them to be gone, so the sidecar never exits ahead of them.
 *
 * ## Why this exists
 *
 * Measured downstream (neovibe, session-tab sandbox pass, 2026-09-25): closing the window while a turn
 * was running, the sidecar exited in 0.14 s and its `claude` child was reparented to init and lived
 * about 2.4 s more. Nothing was left behind in the end, but the order was backwards: the host watches
 * the sidecar, not its grandchildren, so for those 2.4 s a live, billing CLI existed that no process
 * responsible for it could see or stop.
 *
 * The cause is in the SDK, not here. `Query.close()` -> `ProcessTransport.close()` ends the child's
 * stdin and arms a timer that sends SIGTERM after 2 s and SIGKILL 5 s after that -- and both timers
 * are `unref()`'d (read out of the installed sdk.mjs, 0.3.252). So the SDK never holds the process open
 * for its child, and a sidecar that exits straight after closing its sessions takes the timers with it:
 * the child only ever got stdin EOF, and finished (or abandoned) its turn on its own schedule.
 *
 * ## Why the process table and not the SDK's handle
 *
 * The `ChildProcess` is private to the SDK's transport. The one public way to hold it,
 * `Options.spawnClaudeCodeProcess`, replaces the SDK's own spawn wholesale -- and with it the stderr
 * drain and the stderr tail the SDK folds into exit errors (a custom spawner that forgets to read
 * stderr can wedge the CLI on a full pipe). That is a larger behaviour change to every session than
 * this problem warrants. Asking the OS which processes have this pid as their parent touches nothing
 * the SDK does, and it covers every session at once, including one whose kernel object is already gone.
 *
 * The sidecar starts no other long-lived child (its only other spawn is the synchronous
 * `claude --version` probe at startup, finished long before this can run), so "my children" and "my
 * `claude` CLIs" are the same set.
 *
 * ## Limits, stated rather than implied
 *
 * - Direct children only. A CLI ended by SIGTERM cleans up its own tool subprocesses; one that has to
 *   be SIGKILLed cannot, and anything IT spawned is reparented as before. The SDK spawns the CLI in
 *   this process's own process group, so there is no group of its own to signal.
 * - A SIGKILL of the sidecar itself runs none of this. Only the shutdown paths do: SIGTERM, SIGINT,
 *   stdin EOF.
 */

/** How long each phase may take. Defaults sum to at most ~4.25 s. */
export type ChildShutdownTimings = {
  /** Time given for the children to exit on their own after the sessions were closed (the SDK has
   * already ended their stdin), before anyone is signalled. */
  naturalExitMs: number;
  /** After SIGTERM, how long before SIGKILL. */
  termGraceMs: number;
  /** After SIGKILL, how long to keep checking before giving up and reporting survivors. */
  killGraceMs: number;
  /** Poll interval for all three phases. */
  pollMs: number;
};

export const DEFAULT_CHILD_SHUTDOWN_TIMINGS: ChildShutdownTimings = Object.freeze({
  naturalExitMs: 250,
  termGraceMs: 3000,
  killGraceMs: 1000,
  pollMs: 25,
});

export type ChildShutdownDeps = {
  /** The pids of `parentPid`'s live children. Injectable for tests; defaults to `listChildPids`. */
  listChildren?: (parentPid: number) => number[];
  /** Sends a signal. Defaults to `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Where each step is reported. */
  onDiagnostic?: (line: string) => void;
};

export type ChildShutdownReport = {
  /** Children found when shutdown began. */
  found: number[];
  /** Those that had to be sent SIGTERM (still alive after `naturalExitMs`). */
  terminated: number[];
  /** Those that had to be sent SIGKILL (still alive after `termGraceMs`). */
  killed: number[];
  /** Still alive after `killGraceMs`. Empty unless something is badly wrong (an uninterruptible
   * sleep, say); reported rather than waited on forever. */
  survivors: number[];
};

/**
 * The live children of `parentPid`, by pid. A zombie -- exited but not yet reaped -- is NOT live and is
 * not returned: it holds no resources and cannot do anything, and Node reaps it as soon as its event
 * loop turns.
 *
 * Linux reads /proc (no subprocess, no dependency on `ps` being installed); anywhere else it asks
 * `ps`, which macOS and the BSDs all have.
 */
export function listChildPids(parentPid: number): number[] {
  if (process.platform === 'linux') {
    return listChildPidsFromProc(parentPid, '/proc');
  }
  const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat='], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return [];
  }
  // `ps` is itself a child of this process while it runs, so it lists itself. Excluded by the pid
  // spawnSync reports, or shutdown would wait on (and signal) a process that has already exited --
  // or, after pid reuse, an unrelated one.
  return parsePsOutput(result.stdout, parentPid, result.pid);
}

/** Exported for testing against a fixture tree. */
export function listChildPidsFromProc(parentPid: number, procRoot: string): number[] {
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${name}/stat`, 'utf8');
    } catch {
      continue; // exited between readdir and read
    }
    const parsed = parseProcStat(stat);
    if (parsed !== undefined && parsed.ppid === parentPid && parsed.state !== 'Z' && parsed.state !== 'X') {
      out.push(Number(name));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * `pid (comm) state ppid ...`. `comm` can itself contain spaces and parentheses, so the fields are
 * read after the LAST `)` rather than by splitting the whole line.
 */
export function parseProcStat(stat: string): { state: string; ppid: number } | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return fields[0] === undefined || !Number.isInteger(ppid) ? undefined : { state: fields[0], ppid };
}

/** Exported for testing. `ps -o pid=,ppid=,stat=` lines; `excludePid` is the `ps` process itself. */
export function parsePsOutput(stdout: string, parentPid: number, excludePid?: number): number[] {
  const out: number[] = [];
  for (const line of stdout.split('\n')) {
    const [pid, ppid, stat] = line.trim().split(/\s+/);
    if (Number(ppid) === parentPid && stat !== undefined && !stat.startsWith('Z') && Number.isInteger(Number(pid)) && Number(pid) !== excludePid) {
      out.push(Number(pid));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Waits for `pids` to leave the live set, for at most `ms`. Returns those still live at the end. The
 * wait yields to the event loop between checks, which is also what lets Node reap a child that exits.
 */
async function waitGone(pids: number[], ms: number, pollMs: number, listChildren: (parent: number) => number[]): Promise<number[]> {
  const deadline = Date.now() + ms;
  let alive = pids;
  for (;;) {
    const live = new Set(listChildren(process.pid));
    alive = alive.filter((pid) => live.has(pid));
    if (alive.length === 0 || Date.now() >= deadline) {
      return alive;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Ends every live child of this process: a short grace to exit on its own, then SIGTERM, then SIGKILL
 * after `termGraceMs`. Resolves once none is left or the last grace ran out; never throws.
 */
export async function endChildProcesses(
  timings: ChildShutdownTimings = DEFAULT_CHILD_SHUTDOWN_TIMINGS,
  deps: ChildShutdownDeps = {},
): Promise<ChildShutdownReport> {
  const listChildren = deps.listChildren ?? listChildPids;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const say = deps.onDiagnostic ?? (() => undefined);
  const signal = (pids: number[], sig: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        kill(pid, sig);
      } catch {
        // ESRCH: it exited between the check and the signal, which is the outcome being waited for.
      }
    }
  };

  const found = listChildren(process.pid);
  const report: ChildShutdownReport = { found, terminated: [], killed: [], survivors: [] };
  if (found.length === 0) {
    return report;
  }
  let alive = await waitGone(found, timings.naturalExitMs, timings.pollMs, listChildren);
  if (alive.length === 0) {
    say(`claude-sidecar: ${found.length} child process(es) exited on their own before shutdown continued`);
    return report;
  }
  report.terminated = alive;
  say(`claude-sidecar: sending SIGTERM to ${alive.length} child process(es) still running (${alive.join(', ')}) and waiting for them before exiting`);
  signal(alive, 'SIGTERM');
  alive = await waitGone(alive, timings.termGraceMs, timings.pollMs, listChildren);
  if (alive.length === 0) {
    return report;
  }
  report.killed = alive;
  say(`claude-sidecar: ${alive.length} child process(es) ignored SIGTERM for ${timings.termGraceMs} ms (${alive.join(', ')}); sending SIGKILL`);
  signal(alive, 'SIGKILL');
  alive = await waitGone(alive, timings.killGraceMs, timings.pollMs, listChildren);
  report.survivors = alive;
  if (alive.length > 0) {
    say(`claude-sidecar: ${alive.length} child process(es) still present ${timings.killGraceMs} ms after SIGKILL (${alive.join(', ')}); exiting anyway`);
  }
  return report;
}
