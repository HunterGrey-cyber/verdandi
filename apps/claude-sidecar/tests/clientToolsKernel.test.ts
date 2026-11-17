import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { createSession, type ClientTools } from '@verdandi/claude-runtime';
import { classifyCliVersion } from '../src/cliCompatibility.js';
import { startSidecar } from '../src/lifecycle.js';
import { buildKernelSessionConfig, type ClaudeSessionConfigLike } from '../src/runtimeServiceImpl.js';
import {
  AnswerClientToolCallRequest,
  ClientToolCallOutcome,
  ConfigurationProfile,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  ExecutableSource,
  GetClientToolCallStateRequest,
  PermissionMode,
  PersistenceMode,
  ReplayStart,
  RuntimeServiceClient,
  SettingSource,
  StreamingMode,
  WatchSessionEventsRequest,
  type GetClientToolCallStateResponse,
  type SessionEvent,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import { FakeSdk } from './compat/fakeSdk.js';
import { fakeMcpTransport, toolsCallParams, type McpResponse } from './fakeSession.js';

/**
 * The real kernel behind the real sidecar over a real socket, with only the SDK's `query()` substituted:
 * the client-tool path from the MCP server the kernel hands the SDK to the host's stream and back, wired
 * the way src/index.ts wires it. The generated client is the current one, since this is the path a host
 * of this protocol takes.
 */

const SERVER = 'editor';

const TOOLS: ClientTools = {
  serverName: SERVER,
  timeoutMs: 60_000,
  tools: [{ name: 'open_file', description: 'Shows a file', inputSchemaJson: '{"type":"object"}', alwaysLoad: false }],
};

function promisify<Res>(fn: (req: any, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => (err ? reject(err) : resolve(res as Res)));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function withKernel(body: (rig: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'client-tools-kernel-'));
  const socketPath = join(dir, 'sidecar.sock');
  const sdk = new FakeSdk();
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: (config: ClaudeSessionConfigLike) => createSession(buildKernelSessionConfig(config, { hostCliPath: '/opt/fake/claude' }), sdk.queryFn),
    getClaudeCodeVersions: () => ({ sdkDeclared: '2.1.252', hostCli: '2.1.283' }),
    classifyCliVersion: (version) => classifyCliVersion(version),
    sdkBundledAvailable: false,
    parentWatch: 'none',
    onDiagnostic: () => undefined,
    runtime: { sdkBundledAvailable: false },
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    await body(await open(client, sdk));
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function open(client: RuntimeServiceClient, sdk: FakeSdk) {
  const request = CreateSessionRequest.fromPartial({
    cwd: '/tmp',
    policy: {
      configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
      permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
      persistence: PersistenceMode.PERSISTENCE_MODE_HOST_CLI,
      executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
      streaming: StreamingMode.STREAMING_MODE_PARTIAL,
      settingSources: { sources: [SettingSource.SETTING_SOURCE_PROJECT, SettingSource.SETTING_SOURCE_LOCAL] },
      toolPolicy: { deny: [], unrestricted: true },
      providerPermissionPrompts: true,
    },
    clientTools: TOOLS,
  });
  const { sessionId } = await promisify<{ sessionId: string }>(client.createSession.bind(client), request);
  // The in-process server the kernel handed the SDK, connected as the SDK connects it.
  const server = sdk.last.options.mcpServers?.[SERVER] as unknown as { instance: { connect(transport: unknown): Promise<void> } };
  assert.ok(server !== undefined, 'the kernel put the declared server into options.mcpServers');
  const responses: McpResponse[] = [];
  const transport = fakeMcpTransport(responses);
  await server.instance.connect(transport);

  const call = client.watchSessionEvents(WatchSessionEventsRequest.fromPartial({ sessionId, start: ReplayStart.REPLAY_START_AVAILABLE_HISTORY }));
  const events: SessionEvent[] = [];
  // Rejects when the stream fails, so a test that awaits it also proves the stream ended cleanly.
  const ended = new Promise<void>((resolve, reject) => {
    call.on('end', () => resolve());
    call.on('error', reject);
  });
  ended.catch(() => undefined);
  call.on('data', (event: SessionEvent) => events.push(event));

  return {
    client,
    sdk,
    sessionId,
    responses,
    events,
    ended,
    /** Plays the CLI calling the tool, and waits for the watcher to hold the call. */
    async callTool(id: number): Promise<string> {
      await transport.deliver('tools/call', toolsCallParams('open_file', { path: 'src/main.rs' }, `toolu_${id}`), id);
      await until(() => events.some((e) => e.clientToolCall?.toolUseId === `toolu_${id}`), 'the ClientToolCall event');
      return events.find((e) => e.clientToolCall?.toolUseId === `toolu_${id}`)!.clientToolCall!.callId;
    },
    answer(commandId: string, callId: string) {
      return promisify<unknown>(client.answerClientToolCall.bind(client), AnswerClientToolCallRequest.fromPartial({ sessionId, commandId, callId, content: [{ text: 'shown' }] }));
    },
    state() {
      return promisify<GetClientToolCallStateResponse>(client.getClientToolCallState.bind(client), GetClientToolCallStateRequest.fromPartial({ sessionId }));
    },
    settled(callId: string) {
      return events.filter((e) => e.clientToolCallSettled?.callId === callId);
    },
  };
}

test('a client_tools session: a tools/call reaches the watcher as ClientToolCall, and AnswerClientToolCall reaches the transport as one result, with ClientToolCallSettled ANSWERED on the stream', async () => {
  await withKernel(async (rig) => {
    const callId = await rig.callTool(1);
    const shown = rig.events.find((e) => e.clientToolCall !== undefined)!;
    assert.deepEqual(shown.clientToolCall, { callId, toolUseId: 'toolu_1', tool: 'open_file', argumentsJson: '{"path":"src/main.rs"}' });
    assert.equal(rig.responses.length, 0, 'the CLI is still waiting');

    assert.deepEqual(await rig.answer('c1', callId), {});
    await until(() => rig.settled(callId).length === 1, 'the settled event');
    await flush();
    assert.equal(rig.settled(callId)[0].clientToolCallSettled?.outcome, ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_ANSWERED);
    assert.equal(rig.responses.length, 1);
    assert.equal(rig.responses[0].id, 1);
    assert.deepEqual(rig.responses[0].result?.content, [{ type: 'text', text: 'shown' }]);
  });
});

test('CloseSession with a call open: the watcher gets the settled event, then SessionClosed, and the stream ends', async () => {
  await withKernel(async (rig) => {
    const callId = await rig.callTool(1);
    await promisify(rig.client.closeSession.bind(rig.client), { sessionId: rig.sessionId, commandId: 'close' });
    await rig.ended;
    const settledAt = rig.events.findIndex((e) => e.clientToolCallSettled?.callId === callId);
    const closedAt = rig.events.findIndex((e) => e.sessionClosed !== undefined);
    assert.ok(settledAt >= 0, 'the settled event arrived');
    assert.equal(rig.events[settledAt].clientToolCallSettled?.outcome, ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_SESSION_CLOSED);
    assert.ok(settledAt < closedAt, `settled at ${settledAt}, closed at ${closedAt}`);
    assert.equal(closedAt, rig.events.length - 1, 'nothing follows SessionClosed');
    await flush();
    assert.equal(rig.responses[0].result?.isError, true, 'the CLI got an error result, not silence');
  });
});

test('InterruptTurn with a call open settles it INTERRUPTED, and a later answer is ALREADY_ANSWERED with reason interrupted', async () => {
  await withKernel(async (rig) => {
    const callId = await rig.callTool(1);
    await promisify(rig.client.interruptTurn.bind(rig.client), { sessionId: rig.sessionId, commandId: 'stop' });
    assert.equal(rig.sdk.last.interruptCalls, 1);
    await until(() => rig.settled(callId).length === 1, 'the settled event');
    assert.equal(rig.settled(callId)[0].clientToolCallSettled?.outcome, ClientToolCallOutcome.CLIENT_TOOL_CALL_OUTCOME_INTERRUPTED);
    await assert.rejects(rig.answer('late', callId), (err: grpc.ServiceError) => {
      assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
      const detail = ErrorDetail.decode(err.metadata.get('grpc-status-details-bin')[0] as Buffer);
      assert.equal(detail.code, ErrorCode.ERROR_CODE_CLIENT_TOOL_CALL_ALREADY_ANSWERED);
      assert.equal(detail.reason, 'interrupted');
      return true;
    });
  });
});

test('GetClientToolCallState over the wire lists an open call with the event\'s sequence at or below through_sequence', async () => {
  await withKernel(async (rig) => {
    const callId = await rig.callTool(1);
    const { throughSequence, open } = await rig.state();
    assert.deepEqual(open, [{ callId, toolUseId: 'toolu_1', tool: 'open_file' }]);
    const event = rig.events.find((e) => e.clientToolCall?.callId === callId)!;
    assert.ok(event.sequence <= throughSequence, `the event at ${event.sequence}, the snapshot at ${throughSequence}`);
  });
});
