import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSession } from '../src/session.js';
import { outputPathRefusal, readOutputTail, TASK_OUTPUT_TAIL_BYTES, TaskNotFoundError, TaskOutputUnavailableError, type TaskOutputUnavailableReason } from '../src/taskOutput.js';
import type { ClaudeHostPolicy } from '../src/types.js';
import { makeFakeQuery } from './fakeQuery.js';

/** The builtin's own object, whose methods `syncBuiltinESMExports` copies into every ESM import of it. */
const fsPromises = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');

const POLICY: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'ephemeral', executable: 'sdk_bundled' };

/** A session over a fake CLI, a scratch task directory, and the session's log. */
async function withSession(body: (s: {
  dir: string;
  tasks: string;
  log: string[];
  feed: (...frames: Array<Record<string, unknown>>) => Promise<void>;
  session: ReturnType<typeof createSession>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'task-output-'));
  const tasks = join(dir, 'tasks');
  mkdirSync(tasks);
  const { query, controller } = makeFakeQuery();
  const log: string[] = [];
  const session = createSession({ cwd: dir, policy: POLICY }, () => query, { onDiagnostic: (line) => log.push(line) });
  const feed = async (...frames: Array<Record<string, unknown>>) => {
    for (const frame of frames) controller.emit(frame as unknown as SDKMessage);
    for (let quiet = 0; quiet < 3; ) {
      quiet = (await session.pump()).length === 0 ? quiet + 1 : 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  try {
    await body({ dir, tasks, log, feed, session });
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const started = (taskId: string, toolUseId: string, taskType = 'local_bash') => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: taskType, description: taskId });
const notified = (taskId: string, outputFile: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status, output_file: outputFile });
const template = (taskId: string, path: string) => `Command running in background with ID: ${taskId}. Output is being written to: ${path}. You will be notified when it completes.`;
const result = (toolUseId: string, content: unknown) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
/** A background shell: its call, its start, and (unless told otherwise) nothing naming a path. */
const shell = (taskId: string, toolUseId: string, tool = 'Bash') => [call(toolUseId, tool), started(taskId, toolUseId)];

function unavailable(reason: TaskOutputUnavailableReason) {
  return (error: unknown) => error instanceof TaskOutputUnavailableError && error.reason === reason;
}

test('the last 8192 bytes of a 20000-byte file, with the whole size and the cut', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    const path = join(tasks, 'b1.output');
    const bytes = Buffer.from(Array.from({ length: 20000 }, (_, i) => i % 251));
    writeFileSync(path, bytes);
    await feed(...shell('b1', 'toolu_b'), notified('b1', path));
    const read = await session.taskOutput('b1');
    assert.equal(TASK_OUTPUT_TAIL_BYTES, 8192);
    assert.equal(read.totalBytes, 20000);
    assert.equal(read.truncated, true);
    assert.deepEqual(Buffer.from(read.output), bytes.subarray(20000 - 8192));
  });
});

test('a 100-byte file whole, from the launch template in the launching call\'s result', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    const path = join(tasks, 'b1.output');
    writeFileSync(path, 'x'.repeat(99) + '\n');
    await feed(...shell('b1', 'toolu_b'), result('toolu_b', template('b1', path)));
    const read = await session.taskOutput('b1');
    assert.deepEqual(read, { output: new Uint8Array(Buffer.from('x'.repeat(99) + '\n')), totalBytes: 100, truncated: false });
  });
});

test('the launch template is read from a text block too, and from a result that arrives before the task\'s start', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    const path = join(tasks, 'm1.output');
    writeFileSync(path, 'tick\n');
    await feed(call('toolu_m', 'Monitor'), result('toolu_m', [{ type: 'text', text: template('m1', path) }]), started('m1', 'toolu_m'));
    assert.equal(Buffer.from((await session.taskOutput('m1')).output).toString(), 'tick\n');
  });
});

test('a symbolic link is refused', async () => {
  await withSession(async ({ dir, tasks, feed, session, log }) => {
    const target = join(dir, 'secret');
    writeFileSync(target, 'not for the host');
    const path = join(tasks, 'b1.output');
    symlinkSync(target, path);
    await feed(...shell('b1', 'toolu_b'), notified('b1', path));
    await assert.rejects(session.taskOutput('b1'), unavailable('symlink'));
    assert.ok(log.some((line) => line.includes('(symlink)')), JSON.stringify(log));
    assert.ok(!log.some((line) => line.includes('not for the host')), 'no content in the log');
  });
});

test('a file owned by another uid is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-output-'));
  try {
    const path = join(dir, 'b1.output');
    writeFileSync(path, 'output');
    // The owner rule itself, against a uid this file is not owned by.
    assert.deepEqual(await readOutputTail(path, process.getuid!() + 1), { refused: 'foreign_owner' });
    assert.ok('output' in (await readOutputTail(path)), 'the same file, against its real owner, is read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real file owned by another uid is refused', async (t) => {
  if (process.getuid!() === 0) {
    t.skip('refuses to run as root: a root test process could chown files outside its scratch directory');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'task-output-'));
  try {
    const path = join(dir, 'b1.output');
    writeFileSync(path, 'output');
    try {
      chownSync(path, process.getuid!() + 1, process.getgid!());
    } catch {
      t.skip('cannot create a file owned by another uid without privilege');
      return;
    }
    assert.deepEqual(await readOutputTail(path), { refused: 'foreign_owner' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory is refused', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    const path = join(tasks, 'b1.output');
    mkdirSync(path);
    await feed(...shell('b1', 'toolu_b'), notified('b1', path));
    await assert.rejects(session.taskOutput('b1'), unavailable('not_regular_file'));
  });
});

test('a template whose id is not the task\'s is refused', async () => {
  await withSession(async ({ tasks, feed, session, log }) => {
    const path = join(tasks, 'other.output');
    writeFileSync(path, 'other');
    await feed(...shell('b1', 'toolu_b'), result('toolu_b', template('other', path)));
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    assert.ok(log.some((line) => line.includes('template_id_mismatch')), JSON.stringify(log));
  });
});

test('a template naming a real task, planted in a foreground Bash call\'s result, is ignored', async () => {
  for (const order of ['after the task started', 'before the task started']) {
    await withSession(async ({ tasks, feed, session }) => {
      const planted = join(tasks, 'planted.output');
      writeFileSync(planted, 'planted');
      const plant = [call('toolu_fg', 'Bash'), result('toolu_fg', template('b1', planted))];
      await feed(...(order === 'after the task started' ? [...shell('b1', 'toolu_b'), ...plant] : [...plant, ...shell('b1', 'toolu_b')]));
      await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'), order);
      // The task's own launch still names its file.
      const own = join(tasks, 'b1.output');
      writeFileSync(own, 'own');
      await feed(result('toolu_b', template('b1', own)));
      assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'own', order);
    });
  }
});

test('a local agent\'s output_file arriving first neither answers nor fixes the directory; a later shell path elsewhere is accepted', async () => {
  await withSession(async ({ dir, feed, session }) => {
    const agentDir = join(dir, 'agents');
    const shellDir = join(dir, 'shells');
    mkdirSync(agentDir);
    mkdirSync(shellDir);
    writeFileSync(join(agentDir, 'a1.output'), 'transcript');
    writeFileSync(join(shellDir, 'b1.output'), 'shell');
    await feed(call('toolu_a', 'Agent'), started('a1', 'toolu_a', 'local_agent'), notified('a1', join(agentDir, 'a1.output')));
    await assert.rejects(session.taskOutput('a1'), unavailable('task_kind_has_no_output'));
    await feed(...shell('b1', 'toolu_b'), notified('b1', join(shellDir, 'b1.output')));
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'shell');
  });
});

test('a path with a .. component is refused', async () => {
  await withSession(async ({ tasks, feed, session, log }) => {
    writeFileSync(join(tasks, 'b1.output'), 'x');
    await feed(...shell('b1', 'toolu_b'), notified('b1', `${tasks}/../tasks/b1.output`));
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    assert.ok(log.some((line) => line.includes('parent_component')), JSON.stringify(log));
  });
});

test('a template path with a space before a slash gives no path, not the part before the space', async () => {
  await withSession(async ({ tasks, feed, session, log }) => {
    // The part before the space is a real file this process owns, so taking it would read it.
    writeFileSync(join(tasks, 'secret'), 'not the task output');
    writeFileSync(join(tasks, 'b1.output'), 'x');
    await feed(...shell('b1', 'toolu_b'), result('toolu_b', template('b1', `${tasks}/secret. directory/../tasks/b1.output`)));
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    assert.ok(log.some((line) => line.includes('template_path_ambiguous')), JSON.stringify(log));
    assert.ok(!log.some((line) => line.includes(tasks)), 'the log names the rule, never the path');
  });
});

test('a delayed notification from an older run does not replace the current run\'s path', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    writeFileSync(join(tasks, 'old.output'), 'run one');
    writeFileSync(join(tasks, 'new.output'), 'run two');
    await feed(
      call('toolu_1', 'Bash'), { ...started('b1', 'toolu_1'), run_id: 'r1' },
      call('toolu_2', 'Bash'), { ...started('b1', 'toolu_2'), run_id: 'r2' },
      result('toolu_2', template('b1', join(tasks, 'new.output'))),
      { ...notified('b1', join(tasks, 'old.output')), run_id: 'r1' },
    );
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'run two');
    await feed({ ...notified('b1', join(tasks, 'new.output')), run_id: 'r2' });
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'run two', 'the current run\'s own notification is still taken');
  });
});

test('a new run of a task does not answer with the previous run\'s file until it names its own', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    writeFileSync(join(tasks, 'old.output'), 'run one');
    writeFileSync(join(tasks, 'new.output'), 'run two');
    await feed(call('toolu_1', 'Bash'), { ...started('b1', 'toolu_1'), run_id: 'r1' }, { ...notified('b1', join(tasks, 'old.output')), run_id: 'r1' });
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'run one');
    await feed(call('toolu_2', 'Bash'), { ...started('b1', 'toolu_2'), run_id: 'r2' });
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    await feed({ ...notified('b1', join(tasks, 'new.output')), run_id: 'r2' });
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'run two');
  });
});

test('the same run announced again keeps its file', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    writeFileSync(join(tasks, 'b1.output'), 'run one');
    await feed(call('toolu_1', 'Bash'), { ...started('b1', 'toolu_1'), run_id: 'r1' }, result('toolu_1', template('b1', join(tasks, 'b1.output'))));
    await feed({ ...started('b1', 'toolu_1'), run_id: 'r1' });
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'run one');
  });
});

test('a relative path is refused', async () => {
  await withSession(async ({ feed, session, log }) => {
    await feed(...shell('b1', 'toolu_b'), notified('b1', 'tasks/b1.output'));
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    assert.ok(log.some((line) => line.includes('not_absolute')), JSON.stringify(log));
  });
});

test('a path in another directory than the first accepted one is refused', async () => {
  await withSession(async ({ dir, tasks, feed, session, log }) => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(tasks, 'b1.output'), 'first');
    writeFileSync(join(elsewhere, 'b2.output'), 'second');
    await feed(...shell('b1', 'toolu_b1'), notified('b1', join(tasks, 'b1.output')), ...shell('b2', 'toolu_b2'), notified('b2', join(elsewhere, 'b2.output')));
    assert.equal(Buffer.from((await session.taskOutput('b1')).output).toString(), 'first');
    await assert.rejects(session.taskOutput('b2'), unavailable('no_output_path'));
    assert.ok(log.some((line) => line.includes('other_directory')), JSON.stringify(log));
  });
});

test('a shell with no path named, and a task never seen', async () => {
  await withSession(async ({ feed, session }) => {
    await feed(...shell('b1', 'toolu_b'));
    await assert.rejects(session.taskOutput('b1'), unavailable('no_output_path'));
    await assert.rejects(session.taskOutput('nope'), (error: unknown) => error instanceof TaskNotFoundError);
  });
});

test('a workflow and a local agent are unavailable without any file being opened', async () => {
  await withSession(async ({ tasks, feed, session }) => {
    const shellPath = join(tasks, 'b1.output');
    writeFileSync(shellPath, 'shell');
    writeFileSync(join(tasks, 'w1.output'), 'workflow');
    writeFileSync(join(tasks, 'a1.output'), 'agent');
    await feed(
      ...shell('b1', 'toolu_b'), notified('b1', shellPath),
      call('toolu_w', 'Workflow'), started('w1', 'toolu_w', 'local_workflow'), notified('w1', join(tasks, 'w1.output'), 'stopped'),
      call('toolu_a', 'Agent'), started('a1', 'toolu_a', 'local_agent'), notified('a1', join(tasks, 'a1.output')),
    );
    const open = mock.method(fsPromises, 'open');
    syncBuiltinESMExports();
    try {
      for (const taskId of ['w1', 'a1']) await assert.rejects(session.taskOutput(taskId), unavailable('task_kind_has_no_output'), taskId);
      assert.equal(open.mock.callCount(), 0);
      // The spy sees a read that does open a file, so the zero above is not the spy missing calls.
      await session.taskOutput('b1');
      assert.equal(open.mock.callCount(), 1);
    } finally {
      open.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('the path rules by name', () => {
  assert.equal(outputPathRefusal('/t/tasks/b.output', undefined), undefined);
  assert.equal(outputPathRefusal('/t/tasks/b.output', '/t/tasks'), undefined);
  assert.equal(outputPathRefusal('t/tasks/b.output', undefined), 'not_absolute');
  assert.equal(outputPathRefusal('/t/tasks/../b.output', undefined), 'parent_component');
  assert.equal(outputPathRefusal('/t/tasks/..', undefined), 'parent_component');
  assert.equal(outputPathRefusal('/t/other/b.output', '/t/tasks'), 'other_directory');
  assert.equal(outputPathRefusal('/t/tasks/sub/b.output', '/t/tasks'), 'other_directory');
  // `..` inside a name is not a component.
  assert.equal(outputPathRefusal('/t/tasks/b..output', '/t/tasks'), undefined);
});
