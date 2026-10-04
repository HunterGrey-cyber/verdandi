import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as old from './b3aa188/generated/runtime.js';
import { eitriCreate } from './eitri.js';
import { SIDECAR_ENTRY } from './paths.js';

/**
 * The REAL entry point (dist/src/index.js) as a host starts it: a child process with an environment
 * and a pipe for stdin, and a stub standing in for `claude` (it answers `--version`, which is all the
 * startup gate asks of it). Nothing here runs a model; no real `claude` is ever executed.
 *
 * Used for what only a process can show: what it says on stderr when it refuses to start, how fast it
 * binds, how it reacts to stdin closing.
 */

/**
 * How long the stub takes to answer `--version`. A real `claude` needs a few hundred milliseconds to
 * start and say its version, and the sidecar asks for it BEFORE it binds its socket, so a stub that
 * answers instantly would hide how much of Eitri's 3 s connect window the probe really uses.
 */
export const STUB_VERSION_SECONDS = 0.5;

/** A `claude` that reports `version` and, for anything else (a session's own spawn), does `rest`. */
export function stubCliScript(version: string, rest = 'exit 0', versionSeconds = STUB_VERSION_SECONDS): string {
  return ['#!/bin/sh', `if [ "$1" = "--version" ]; then sleep ${versionSeconds}; echo "${version} (Claude Code)"; exit 0; fi`, rest, ''].join('\n');
}

export type Spawned = {
  child: ChildProcess;
  dir: string;
  home: string;
  socketPath: string;
  stubCli: string;
  spawnedAt: number;
  stderr(): string;
  /** The exit code within `ms`, or 'running'. */
  exited(ms: number): Promise<number | null | 'running'>;
  stop(): void;
};

export type SpawnOptions = {
  /** The body of the stub `claude`. Default: reports 2.1.999 (inside the range, never in the tested set). */
  stub?: string;
  /** Use this path as VERDANDI_CLAUDE_CLI_PATH instead of the stub. */
  cliPath?: string;
  /** Set (string) or remove (undefined) environment variables after the defaults. */
  env?: Record<string, string | undefined>;
  args?: string[];
  /** Runs before the process starts, with the paths it will see (to put an account directory or a stale socket in place). */
  prepare?: (paths: { dir: string; home: string; socketPath: string }) => void;
};

/** Variables that would change what the sidecar does, removed so a test starts from nothing pinned. */
const SCRUBBED = /^(VERDANDI_CLAUDE_|CLAUDE_PROFILE$|CLAUDE_CONFIG_DIR$|CLAUDE_SECURESTORAGE_CONFIG_DIR$|ANTHROPIC_CONFIG_DIR$|ANTHROPIC_API_KEY$|RUN_REAL_CLAUDE_TESTS$)/;

export function spawnSidecar(options: SpawnOptions = {}): Spawned {
  const dir = mkdtempSync(join(tmpdir(), 'v1p-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const socketPath = join(dir, 's.sock');
  const stubCli = join(dir, 'claude');
  writeFileSync(stubCli, options.stub ?? stubCliScript('2.1.999'));
  chmodSync(stubCli, 0o755);
  options.prepare?.({ dir, home, socketPath });

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SCRUBBED.test(name)) {
      env[name] = value;
    }
  }
  Object.assign(env, { HOME: home, VERDANDI_CLAUDE_SIDECAR_SOCKET: socketPath, VERDANDI_CLAUDE_CLI_PATH: options.cliPath ?? stubCli });
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }

  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [SIDECAR_ENTRY, ...(options.args ?? [])], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    child,
    dir,
    home,
    socketPath,
    stubCli,
    spawnedAt,
    stderr: () => stderr,
    exited: (ms) => {
      if (child.exitCode !== null) {
        return Promise.resolve(child.exitCode);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('running'), ms);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
    stop: () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Eitri's bind wait (agent/src/providers/claude_sidecar/spawn.rs): connect to the socket every 50 ms
 * for at most 60 attempts (3 s), giving up early when the child has already died. Returns the
 * milliseconds since `since` at which a connect succeeded, or undefined.
 */
export async function waitForBind(spawned: Spawned, attempts = 60): Promise<number | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(spawned.socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) {
      return Date.now() - spawned.spawnedAt;
    }
    if (spawned.child.exitCode !== null) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/** Running, not merely not-yet-reaped: a zombie answers kill(pid, 0) until something waits on it. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}

/** A sidecar with one session open, whose CLI is a stub that records how it was started and then idles. */
export type CliSession = {
  sidecar: Spawned;
  /** The arguments the real SDK started the stub CLI with, one per element. */
  argv: string[];
  cliPid: number;
  /** The directory the session was opened in (it exists, so the SDK can start the CLI there). */
  cwd: string;
  /** Always safe to call, however far `startCliSession` got: stops the sidecar, the client and the CLI. */
  close(): void;
};

/**
 * Starts the real entry point, binds, and opens ONE session with Eitri's own CreateSession over a real
 * socket, so that the real SDK starts the stub CLI the way it would start `claude`. The stub writes its
 * pid and its arguments (pid last, atomically), optionally ignores SIGTERM, and idles for as long as a
 * marker file exists -- so even a test that dies half-way leaves no process behind: `close()` removes the
 * marker and the stub exits on its own within 50 ms, whether or not its pid was ever read.
 */
export async function startCliSession(options: { ignoreSigterm?: boolean; env?: SpawnOptions['env'] } = {}): Promise<CliSession> {
  const cwd = mkdtempSync(join(tmpdir(), 'v1p-session-'));
  const pidFile = join(cwd, 'cli.pid');
  const argvFile = join(cwd, 'cli.argv');
  const aliveFile = join(cwd, 'cli.alive');
  writeFileSync(aliveFile, '');
  const body = [
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'`,
    ...(options.ignoreSigterm === true ? ["trap '' TERM"] : []),
    `while [ -e '${aliveFile}' ]; do sleep 0.05; done`,
  ].join('\n');
  const sidecar = spawnSidecar({ stub: stubCliScript('2.1.999', body), env: options.env });
  const client = new old.RuntimeServiceClient(`unix://${sidecar.socketPath}`, grpc.credentials.createInsecure());
  let cliPid: number | undefined;
  const close = (): void => {
    client.close();
    rmSync(aliveFile, { force: true });
    if (cliPid === undefined && existsSync(pidFile)) {
      cliPid = Number(readFileSync(pidFile, 'utf8').trim());
    }
    try {
      if (cliPid !== undefined && Number.isInteger(cliPid) && cliPid > 1 && alive(cliPid)) {
        // The stub may exit between the check and the kill (its marker is gone); ESRCH then is success.
        process.kill(cliPid, 'SIGKILL');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    } finally {
      sidecar.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  try {
    if ((await waitForBind(sidecar)) === undefined) {
      throw new Error(`the sidecar never bound; stderr:\n${sidecar.stderr()}`);
    }
    await new Promise<void>((resolve, reject) => {
      client.createSession(eitriCreate(cwd, old.StreamingMode.STREAMING_MODE_PARTIAL), (error) => (error ? reject(error) : resolve()));
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!existsSync(pidFile)) {
      throw new Error(`the session's CLI never started; stderr:\n${sidecar.stderr()}`);
    }
    cliPid = Number(readFileSync(pidFile, 'utf8').trim());
    return { sidecar, argv: readFileSync(argvFile, 'utf8').split('\n').slice(0, -1), cliPid, cwd, close };
  } catch (error) {
    close();
    throw error;
  }
}
