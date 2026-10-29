import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { TaskOutputResult } from './types.js';

/** How much of a task's output one read returns: its last bytes, which is what a person looking at a
 * running or finished command wants to see. */
export const TASK_OUTPUT_TAIL_BYTES = 8192;

/**
 * The SDK has no request for a task's output, so the output is read from the file the CLI writes it
 * to, which the CLI names in the session's own frames. Reading a file a frame names is reading a path a
 * model-driven process put on the wire, so a path is taken only when it looks like the CLI's task
 * directory and nothing else can stand in for it: absolute, no `..` component, and in the directory the
 * session's first accepted path was in. A rule a path breaks is named in the log, never the path.
 */
export type OutputPathRefusal = 'not_absolute' | 'parent_component' | 'other_directory';

export function outputPathRefusal(path: string, taskDirectory: string | undefined): OutputPathRefusal | undefined {
  if (!isAbsolute(path)) return 'not_absolute';
  if (path.split('/').includes('..')) return 'parent_component';
  if (taskDirectory !== undefined && dirname(path) !== taskDirectory) return 'other_directory';
  return undefined;
}

/** The directory an accepted path fixes for the session's later ones. */
export function taskDirectoryOf(path: string): string {
  return dirname(path);
}

/**
 * Whether this process can read an output file the way the rules below require: refuse a symbolic
 * link at the last component (`O_NOFOLLOW`) and compare the file's owner with its own uid. A platform
 * without either cannot make those checks, so it reads nothing and the capability is not advertised.
 */
export function taskOutputReadable(): boolean {
  return typeof constants.O_NOFOLLOW === 'number' && typeof process.getuid === 'function';
}

/** Why an accepted path still gave no output when it was opened. */
export type OutputReadRefusal = 'unsupported' | 'symlink' | 'unopenable' | 'not_regular_file' | 'foreign_owner' | 'unreadable';

/**
 * The tail of the file at `path`: at most `TASK_OUTPUT_TAIL_BYTES`, read from `max(0, size - limit)`,
 * with the size `fstat` reported. The file is opened without following a symbolic link at its last
 * component and without blocking (a FIFO planted at the path would otherwise hold the call forever),
 * then must be a regular file owned by `ownerUid` (this process's uid unless a caller states another).
 * A file that shrinks between `fstat` and the read gives the bytes that were there.
 */
export async function readOutputTail(path: string, ownerUid?: number): Promise<TaskOutputResult | { refused: OutputReadRefusal }> {
  if (!taskOutputReadable()) return { refused: 'unsupported' };
  const uid = ownerUid ?? process.getuid!();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return { refused: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'symlink' : 'unopenable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { refused: 'not_regular_file' };
    if (stat.uid !== uid) return { refused: 'foreign_owner' };
    const size = stat.size;
    const start = Math.max(0, size - TASK_OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { output: new Uint8Array(buffer.subarray(0, filled)), totalBytes: size, truncated: size > TASK_OUTPUT_TAIL_BYTES };
  } catch {
    return { refused: 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** StopTask and GetTaskOutput for a task id the session has never seen (or has long forgotten). */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`no background task ${taskId} on this session`);
    this.name = 'TaskNotFoundError';
  }
}

/** Why a known task has no output to read. Logged and carried for the caller; never file content. */
export type TaskOutputUnavailableReason = 'task_kind_has_no_output' | 'no_output_path' | OutputReadRefusal;

/** GetTaskOutput for a task whose output this session cannot read. */
export class TaskOutputUnavailableError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: TaskOutputUnavailableReason,
  ) {
    super(`no readable output for background task ${taskId}`);
    this.name = 'TaskOutputUnavailableError';
  }
}
