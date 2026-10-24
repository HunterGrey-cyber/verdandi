import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from './generated/protocolConstants.js';
import { SIDECAR_VERSION } from './generated/sdkVersions.js';

/**
 * The machine-readable half of startup: what the process tells a host that spawned it, beside the
 * stderr text a person reads.
 *
 * A host that starts this process learns how it went from three things today -- the exit code, a
 * stderr tail it pattern-matches, and a socket it polls for. This adds a fourth, opt-in one. When
 * `VERDANDI_CLAUDE_SIDECAR_REPORT_FILE` names a file, every startup outcome is also written there as
 * one JSON object per line:
 *
 *   {"v":1,"kind":"ready"|"refused"|"diagnostic","code":"...","message":"...","details":{...}}
 *
 * - `ready`: written once, after the socket is listening and not a moment earlier, so a host that
 *   reads it may connect at once instead of polling.
 * - `refused`: the process is about to exit 1 before binding anything; `code` is the stable name of
 *   why (`REFUSAL_CODES`), `message` is the very text printed to stderr.
 * - `diagnostic`: something the host should know that did not stop the start (`CLI_UNTESTED`, and
 *   `CLI_LEFT_TO_HOST` when `VERDANDI_CLAUDE_SIDECAR_CLI_GATE=report` let a refused or unreadable CLI through).
 *
 * The stderr text is never changed by any of this: a host that matches it keeps working, and a host
 * that reads the file gets the same words under a code that will not be reworded.
 *
 * Rules the module keeps, each pinned by a test:
 * - **It never throws.** A path that cannot be written costs one stderr line, once, and the exit (or
 *   the start) goes on exactly as it would have without the variable.
 * - **Variable unset, no work.** The reporter is then a set of empty functions: no file is touched
 *   and nothing is computed, so the default path to `bind` is exactly as long as it was.
 * - **The file is 0600**, created by this process even when the host pre-created it wider.
 * - **No secret reaches it, and never the CLI's own output.** What the probed `claude` printed can carry
 *   whatever a launcher prints, so a message that would embed it is written with a marker in its place
 *   (`omittedCliOutput`), built from the parts, not scrubbed afterwards. Everything else written is a
 *   path, a version, an enum or the sidecar's own sentence; the values of the variables that carry a
 *   credential are masked in every string as a last line of defence.
 * - **Only a regular file.** A FIFO, a device or a link is refused with the one warning line; opening
 *   never blocks.
 *
 * The host creates the directory and chooses a fresh path per spawn; records are appended, so a path
 * reused across spawns would mix two runs.
 */

export const REPORT_FILE_VARIABLE = 'VERDANDI_CLAUDE_SIDECAR_REPORT_FILE';

/** Every `refused` code. A host may rely on each name and on `details` keys listed in COMPATIBILITY.md. */
export const REFUSAL_CODES = [
  'SOCKET_ENV_MISSING',
  'SOCKET_PATH_TOO_LONG',
  'SOCKET_IN_USE',
  'CLI_NOT_FOUND',
  'CLI_PROBE_FAILED',
  'CLI_VERSION_UNPARSEABLE',
  'CLI_OUT_OF_RANGE',
  'EGRESS_MODE_INVALID',
  'EGRESS_PROOF_FAILED',
  'ACCOUNT_INVALID_NAME',
  'ACCOUNT_NO_HOME',
  'ACCOUNT_RELATIVE_OVERRIDE',
  'ACCOUNT_DEFAULT_CONFLICT',
  'ACCOUNT_DIR_MISSING',
  'ACCOUNT_NOT_LOGGED_IN',
  'ACCOUNT_DEFAULT_LOCATION_SYMLINK',
  'ACCOUNT_NO_RECORDED_IDENTITY',
  'ENV_INVALID',
  'STARTUP_FAILED',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const DIAGNOSTIC_CODES = ['CLI_UNTESTED', 'CLI_LEFT_TO_HOST'] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type ReportDetails = Record<string, unknown>;

/**
 * A startup failure that knows its own code. Thrown where the cause is known (and where the existing
 * text must stay exactly as it was: `message` is what is printed), and turned into a record by
 * `exitRefused`. Any other error that reaches `exitRefused` is `STARTUP_FAILED`.
 */
export class StartupRefusal extends Error {
  readonly code: RefusalCode;
  readonly details: ReportDetails;
  /** The text for the report file, when it must differ from the printed `message` (the CLI's output left out). */
  readonly recordMessage: string;

  constructor(code: RefusalCode, message: string, details: ReportDetails = {}, recordMessage: string = message) {
    super(message);
    this.code = code;
    this.details = details;
    this.recordMessage = recordMessage;
  }
}

/** What stands in the report file for output the probed CLI printed. */
export function omittedCliOutput(output: string): string {
  return `[CLI output omitted: ${Buffer.byteLength(output)} bytes]`;
}

/**
 * `text` with the version the CLI printed replaced by what is safe to record: its leading
 * `major.minor.patch` when it has one, else the omitted marker. The version is the first word of the
 * CLI's stdout, so it is the CLI's own output too.
 */
export function withoutCliVersion(text: string, raw: string): { text: string; version: string } {
  const leading = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  const version = leading !== null ? `${leading[1]}.${leading[2]}.${leading[3]}` : omittedCliOutput(raw);
  if (raw === '') {
    return { text, version };
  }
  let out = text;
  for (const form of new Set([JSON.stringify(raw).slice(1, -1), raw])) {
    out = out.split(form).join(version);
  }
  return { text: out, version };
}

/** A record's message is capped, so no refusal can write an unbounded line. */
const MAX_MESSAGE_BYTES = 8 * 1024;

export type ReadyDetails = {
  socket: string;
};

export type StartupReporter = {
  /** Whether a report file is configured. False means every method below does nothing. */
  readonly enabled: boolean;
  /** The process is listening. Call it after the socket accepts connections, never before. */
  ready(details: ReadyDetails): void;
  refused(code: RefusalCode, message: string, details?: ReportDetails): void;
  diagnostic(code: DiagnosticCode, message: string, details?: ReportDetails): void;
};

/** The variables whose values are credentials. A value of at least this many characters is masked. */
const CREDENTIAL_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const MIN_MASKED_LENGTH = 8;
const MASK = '[redacted]';

/** The reporter for a process with no report file: nothing to open, nothing to compute. */
export const NO_REPORT: StartupReporter = {
  enabled: false,
  ready: () => undefined,
  refused: () => undefined,
  diagnostic: () => undefined,
};

/** Masks the credential values in one string. Applied to values before they are serialised: masking the JSON text would let a value that is also a key name, or holds a quote, corrupt the record. */
function maskString(text: string, env: NodeJS.ProcessEnv): string {
  let masked = text;
  for (const name of CREDENTIAL_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value.length >= MIN_MASKED_LENGTH) {
      // A message may quote the value as JSON (a parser that names the bad input with JSON.stringify), so
      // the escaped spelling is masked as well as the raw one.
      for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) {
        masked = masked.split(form).join(MASK);
      }
    }
  }
  return masked;
}

function maskValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return maskString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((each) => maskValue(each, env));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, maskValue(each, env)]));
  }
  return value;
}

function capMessage(message: string): string {
  const bytes = Buffer.from(message);
  if (bytes.length <= MAX_MESSAGE_BYTES) {
    return message;
  }
  return `${bytes.subarray(0, MAX_MESSAGE_BYTES).toString()}[truncated: ${bytes.length - MAX_MESSAGE_BYTES} more bytes]`;
}

/**
 * The reporter `VERDANDI_CLAUDE_SIDECAR_REPORT_FILE` asks for. `warn` receives the one line said when
 * the file cannot be written (default: stderr).
 *
 * Reading the variable is all that happens up front; the file is first touched when the first record is
 * written, so nothing is spent before then.
 */
/** The two file operations whose failure the reporter must survive, injectable so a short write and a refused chmod can be tested. */
export type ReportIo = { write: (fd: number, line: Buffer) => number; fchmod: (fd: number, mode: number) => void };

const REAL_IO: ReportIo = { write: (fd, line) => writeSync(fd, line), fchmod: (fd, mode) => fchmodSync(fd, mode) };

export function startupReporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => console.error(line),
  io: ReportIo = REAL_IO,
): StartupReporter {
  const raw = env[REPORT_FILE_VARIABLE];
  const path = raw?.trim() ?? '';
  if (path === '') {
    return NO_REPORT;
  }
  let warned = false;
  const say = (problem: string): void => {
    if (warned) {
      return;
    }
    warned = true;
    try {
      warn(`claude-sidecar: cannot write the startup report to ${JSON.stringify(path)}: ${problem}. The report is off; startup carries on as it would without it.`);
    } catch {
      // Saying so is best effort too: this module never throws.
    }
  };
  let broken = false;
  if (!isAbsolute(path)) {
    broken = true;
    say(`${REPORT_FILE_VARIABLE} must be an absolute path`);
  }

  const write = (kind: 'ready' | 'refused' | 'diagnostic', code: string, message: string, details: ReportDetails): void => {
    if (broken) {
      return;
    }
    try {
      const line = Buffer.from(
        JSON.stringify({ v: 1, kind, code, message: capMessage(maskString(message, env)), details: maskValue({ ...details, pid: process.pid }, env) }) + '\n',
      );
      // O_NOFOLLOW: the directory is the host's, but a path in a shared one must not be a link to somewhere else.
      // O_NONBLOCK: opening a FIFO nobody reads would otherwise wait for a reader, and startup with it.
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!fstatSync(fd).isFile()) {
          throw new Error('it is not a regular file');
        }
        try {
          // The mode argument above applies only to a file this call created; one the host made wider is narrowed.
          // A failure to narrow is not a reason to lose the record.
          io.fchmod(fd, 0o600);
        } catch {
          // Written anyway.
        }
        const written = io.write(fd, line);
        if (written !== line.length) {
          throw new Error(`short write (${written} of ${line.length} bytes)`);
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      broken = true;
      say(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    enabled: true,
    ready: (details) =>
      write('ready', 'READY', 'the sidecar is listening', {
        socket: details.socket,
        pid: process.pid,
        sidecar_version: SIDECAR_VERSION,
        protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      }),
    refused: (code, message, details = {}) => write('refused', code, message, details),
    diagnostic: (code, message, details = {}) => write('diagnostic', code, message, details),
  };
}

/** The refusal for anything thrown on the way to bind: its own, or `STARTUP_FAILED` for an error nobody classified. */
export function refusalFor(error: unknown): StartupRefusal {
  if (error instanceof StartupRefusal) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const details: ReportDetails = {};
  if (error instanceof Error) {
    if (error.name !== 'Error') {
      details.error_name = error.name;
    }
    const errno = (error as NodeJS.ErrnoException).code;
    if (typeof errno === 'string') {
      // `ENOTDIR`, `EACCES`: the system's own name for what failed, which the message may only imply.
      details.error_code = errno;
    }
  }
  return new StartupRefusal('STARTUP_FAILED', message, details);
}

/**
 * The one way out of a startup that cannot go on: prints the refusal's text on stderr exactly as the
 * process always has, records it, and exits 1. Every exit before the socket is bound goes through here,
 * so there is no refusal a host could see on stderr and not in the file.
 */
export function exitRefused(reporter: StartupReporter, error: unknown, exit: (code: number) => never = (code) => process.exit(code)): never {
  const refusal = refusalFor(error);
  console.error(refusal.message);
  reporter.refused(refusal.code, refusal.recordMessage, refusal.details);
  return exit(1);
}

/** Runs the parser of one of the sidecar's configuration variables; a throw becomes `ENV_INVALID` naming it. The text is the parser's own. */
export function parseEnvVariable<T>(variable: string, parse: () => T, code: 'ENV_INVALID' | 'EGRESS_MODE_INVALID' = 'ENV_INVALID'): T {
  try {
    return parse();
  } catch (error) {
    throw new StartupRefusal(code, error instanceof Error ? error.message : String(error), { variable });
  }
}
