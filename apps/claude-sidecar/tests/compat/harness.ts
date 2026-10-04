import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { createSession, type ClaudeAccount } from '@verdandi/claude-runtime';
import { classifyCliVersion } from '../../src/cliCompatibility.js';
import { startSidecar } from '../../src/lifecycle.js';
import { buildKernelSessionConfig, type ClaudeSessionConfigLike } from '../../src/runtimeServiceImpl.js';
import * as old from './b3aa188/generated/runtime.js';
import { ALLOWED_UNDECODABLE_EVENT_ARMS, goldenRequests, undecodableArms } from './eitri.js';
import { FakeSdk, type FakeSdkOptions } from './fakeSdk.js';

/**
 * The sidecar, in this process, with the fake SDK underneath, and the FROZEN client -- the one
 * generated from Verdandi b3aa188's runtime.proto, i.e. the types Eitri 0.2.0 links -- on the other end
 * of a real unix socket.
 *
 * It is assembled the way src/index.ts assembles the real thing: `startSidecar` with the production
 * session mapping (`buildKernelSessionConfig`) and the production kernel (`createSession`). The only
 * substitution is the SDK's `query()`; see fakeSdk.ts.
 */

export const HOST_CLI_PATH = '/opt/fake/claude';

export type HarnessOptions = {
  sdk?: FakeSdk | FakeSdkOptions;
  /** A small ring makes EVENT_GAP reachable. */
  ringBufferCapacity?: number;
  /** false is a packaged build (what a public install meets); true is a checkout. */
  sdkBundledAvailable?: boolean;
  /** VERDANDI_CLAUDE_ACCOUNT, already resolved (index.ts resolves it once and hands the same value to both halves). */
  account?: ClaudeAccount;
  /** The process proved at startup that it cannot reach loopback (what VERDANDI_CLAUDE_SIDECAR_EGRESS=restricted yields); the handshake then adds `egress_restricted`. */
  egressRestricted?: boolean;
  /** How long the kernel's accountInfo() probe may take before the identity is reported unavailable; absent keeps the kernel's own default. */
  accountInfoTimeoutMs?: number;
};

export type Harness = {
  readonly client: old.RuntimeServiceClient;
  readonly sdk: FakeSdk;
  readonly diagnostics: string[];
  handshake(clientProtocolMajor?: number): Promise<old.HandshakeResponse>;
  /** CreateSession with Eitri's exact request (the golden bytes), sent raw. */
  createGolden(name: string): Promise<string>;
  /** Typed calls through the frozen client, each with a fresh command id (as Eitri mints one per call). */
  sendTurn(sessionId: string, text: string, commandId?: string): Promise<old.SendTurnResponse>;
  interrupt(sessionId: string): Promise<old.InterruptTurnResponse>;
  resolve(sessionId: string, permissionId: string, allow: boolean, reason?: string, commandId?: string): Promise<old.ResolvePermissionResponse>;
  close(sessionId: string): Promise<old.CloseSessionResponse>;
  /** A raw unary call: `bytes` go on the wire untouched. */
  raw(method: string, bytes: Buffer): Promise<Buffer>;
  watch(request: old.WatchSessionEventsRequest): Watcher;
  watchRaw(bytes: Buffer): Watcher;
  /**
   * Throws when any event any watcher of this harness received carries an arm Eitri 0.2.0 cannot
   * decode (or none) and that arm is not in `ALLOWED_UNDECODABLE_EVENT_ARMS`: Eitri would drop it
   * without a word, so a safety signal that exists only there would never reach its user.
   * `withHarness` runs this after every scenario.
   */
  assertNoSilentEvents(): void;
  stop(): Promise<void>;
};

/** One WatchSessionEvents stream, as Eitri's watch loop sees it. */
export class Watcher {
  readonly events: old.SessionEvent[] = [];
  error: grpc.ServiceError | undefined;
  ended = false;
  private listeners: Array<() => void> = [];

  /** `encoded` holds the wire bytes of each event in `events`, same order: what the frozen decoder was handed. */
  constructor(
    readonly call: grpc.ClientReadableStream<old.SessionEvent>,
    readonly encoded: Buffer[] = [],
  ) {
    call.on('data', (event: old.SessionEvent) => {
      this.events.push(event);
      this.notify();
    });
    call.on('error', (error: grpc.ServiceError) => {
      // A deliberate cancel() is not a failure.
      if (error.code !== grpc.status.CANCELLED) {
        this.error = error;
      }
      this.ended = true;
      this.notify();
    });
    call.on('end', () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    for (const listener of this.listeners.splice(0)) {
      listener();
    }
  }

  /** Waits until `done(events)` holds, the stream ends, or the timeout passes; returns whether it held. */
  async until(done: (events: old.SessionEvent[]) => boolean, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.events)) {
      if (this.ended || Date.now() >= deadline) {
        return done(this.events);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now())));
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  /** Every event of one kind, in arrival order. */
  of<K extends Exclude<keyof old.SessionEvent, 'sessionId' | 'sequence' | 'occurredAt' | 'turnId'>>(kind: K): Array<NonNullable<old.SessionEvent[K]>> {
    return this.events.flatMap((event) => (event[kind] !== undefined ? [event[kind] as NonNullable<old.SessionEvent[K]>] : []));
  }

  cancel(): void {
    this.call.cancel();
  }
}

/** The stream's deserializer: the frozen client's own decoder, keeping the bytes it decoded. */
function recordingDecoder(sink: Buffer[]): (value: Buffer) => old.SessionEvent {
  return (value) => {
    sink.push(value);
    return old.SessionEvent.decode(value);
  };
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'v1c-'));
  const socketPath = join(dir, 's.sock');
  const sdk = options.sdk instanceof FakeSdk ? options.sdk : new FakeSdk(options.sdk);
  const diagnostics: string[] = [];
  const sdkBundledAvailable = options.sdkBundledAvailable ?? false;

  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: (config: ClaudeSessionConfigLike) => createSession(
        {
          ...buildKernelSessionConfig(config, { account: options.account, hostCliPath: HOST_CLI_PATH }),
          ...(options.accountInfoTimeoutMs !== undefined ? { accountInfoTimeoutMs: options.accountInfoTimeoutMs } : {}),
        },
        sdk.queryFn,
      ),
    // 2.1.283 is the build in daily use; whichever verdict it gets, the sidecar starts.
    getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.252', hostCli: '2.1.283' }),
    classifyCliVersion: (version) => classifyCliVersion(version),
    sdkBundledAvailable,
    // Not stdin: this process is the test runner.
    parentWatch: 'none',
    onDiagnostic: (message) => diagnostics.push(message),
    runtime: { sdkBundledAvailable, account: options.account, ...(options.egressRestricted !== undefined ? { egressRestricted: options.egressRestricted } : {}), ...(options.ringBufferCapacity !== undefined ? { ringBufferCapacity: options.ringBufferCapacity } : {}) },
  });
  const client = new old.RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());

  let commands = 0;
  const commandId = (): string => `cmd-${(commands += 1)}`;
  const watchers: Watcher[] = [];
  const track = (bytes: Buffer): Watcher => {
    const encoded: Buffer[] = [];
    const call = client.makeServerStreamRequest(
      '/verdandi.claude.runtime.v1.RuntimeService/WatchSessionEvents',
      (value: Buffer) => value,
      recordingDecoder(encoded),
      bytes,
    ) as grpc.ClientReadableStream<old.SessionEvent>;
    const watcher = new Watcher(call, encoded);
    watchers.push(watcher);
    return watcher;
  };

  const raw = (method: string, bytes: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        `/verdandi.claude.runtime.v1.RuntimeService/${method}`,
        (value: Buffer) => value,
        (value: Buffer) => value,
        bytes,
        (error: grpc.ServiceError | null, response?: Buffer) => (error ? reject(error) : resolve(response as Buffer)),
      );
    });

  return {
    client,
    sdk,
    diagnostics,
    handshake: (clientProtocolMajor = 3) =>
      new Promise((resolve, reject) => {
        client.handshake(old.HandshakeRequest.fromPartial({ clientProtocolMajor }), (error, response) => (error ? reject(error) : resolve(response)));
      }),
    async createGolden(name) {
      const bytes = goldenRequests().get(name);
      if (bytes === undefined) {
        throw new Error(`no golden request named ${name}`);
      }
      return old.CreateSessionResponse.decode(await raw('CreateSession', bytes)).sessionId;
    },
    sendTurn: (sessionId, text, explicitCommandId) =>
      new Promise((resolve, reject) => {
        client.sendTurn(old.SendTurnRequest.fromPartial({ sessionId, commandId: explicitCommandId ?? commandId(), text }), (error, response) => (error ? reject(error) : resolve(response)));
      }),
    interrupt: (sessionId) =>
      new Promise((resolve, reject) => {
        client.interruptTurn(old.InterruptTurnRequest.fromPartial({ sessionId, commandId: commandId() }), (error, response) => (error ? reject(error) : resolve(response)));
      }),
    resolve: (sessionId, permissionId, allow, reason = '', explicitCommandId) =>
      new Promise((resolve, reject) => {
        client.resolvePermission(old.ResolvePermissionRequest.fromPartial({ sessionId, commandId: explicitCommandId ?? commandId(), permissionId, allow, reason }), (error, response) =>
          error ? reject(error) : resolve(response),
        );
      }),
    close: (sessionId) =>
      new Promise((resolve, reject) => {
        client.closeSession(old.CloseSessionRequest.fromPartial({ sessionId, commandId: commandId() }), (error, response) => (error ? reject(error) : resolve(response)));
      }),
    raw,
    watch: (request) => track(Buffer.from(old.WatchSessionEventsRequest.encode(request).finish())),
    watchRaw: (bytes) => track(bytes),
    assertNoSilentEvents() {
      for (const watcher of watchers) {
        watcher.encoded.forEach((bytes, index) => {
          const silent = undecodableArms(bytes, ALLOWED_UNDECODABLE_EVENT_ARMS);
          if (silent.length > 0) {
            throw new Error(
              `event #${index + 1} of a watch has ${silent.includes(0) ? 'no event arm Eitri 0.2.0 can read' : `arm field(s) ${silent.join(', ')} that Eitri 0.2.0 cannot decode`}; it drops such an event silently, so nothing may exist only there. ` +
                `Add the arm to ALLOWED_UNDECODABLE_EVENT_ARMS (tests/compat/eitri.ts) only with a written reason.`,
            );
          }
        });
      }
    },
    async stop() {
      client.close();
      try {
        await sidecar.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The ErrorDetail an Eitri `map_status` would read out of a failed call, plus the gRPC status. */
export function errorOf(error: unknown): { grpc: grpc.status; detail: old.ErrorDetail | undefined; message: string } {
  const serviceError = error as grpc.ServiceError;
  const bytes = serviceError.metadata?.get('grpc-status-details-bin')[0];
  return {
    grpc: serviceError.code,
    detail: bytes === undefined ? undefined : old.ErrorDetail.decode(bytes as Buffer),
    message: serviceError.details ?? serviceError.message,
  };
}

/** Runs `body` against a started harness and always stops it. */
export async function withHarness(options: HarnessOptions, body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness(options);
  try {
    await body(harness);
    harness.assertNoSilentEvents();
  } finally {
    await harness.stop();
  }
}
