import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as grpc from '@grpc/grpc-js';
import { buildSessionOptions, PROVIDER_PROMPT_TOOL_DENY, type ClaudeRuntimeEvent } from '@verdandi/claude-runtime';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { createRuntimeServiceImpl, buildKernelSessionConfig, mapClaudeHostPolicy, validatePolicy } from '../src/runtimeServiceImpl.js';
import { translateEvent } from '../src/eventTranslation.js';
import { makeFakeSession } from './fakeSession.js';
import {
  ConfigurationProfile,
  ErrorCode,
  ExecutableSource,
  PermissionMode,
  PermissionOrigin,
  PermissionRequested,
  PersistenceMode,
  SessionEvent,
  StreamingMode,
  type ClaudeHostPolicy as ClaudeHostPolicyProto,
  InitCheck,
  CliPermissionMode,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';

/**
 * ClaudeHostPolicy.provider_permission_prompts (tag 9) and PermissionRequested.origin /
 * provider_reason / provider_description (tags 5-7), capability 'provider_permission_prompts'. The
 * kernel half -- canUseTool, its answers, the three tools -- is tested in
 * packages/claude-runtime/tests/providerPermissionPrompts.test.ts; this file tests the wire.
 */

function protoPolicy(extra: Partial<ClaudeHostPolicyProto> = {}): ClaudeHostPolicyProto {
  return {
    configuration: ConfigurationProfile.CONFIGURATION_PROFILE_NATIVE,
    permissions: PermissionMode.PERMISSION_MODE_INTERACTIVE,
    persistence: PersistenceMode.PERSISTENCE_MODE_EPHEMERAL,
    executable: ExecutableSource.EXECUTABLE_SOURCE_HOST_CLI,
    streaming: StreamingMode.STREAMING_MODE_COMPLETE,
    toolPolicy: undefined,
    settingSources: undefined,
    permissionModeSwitchable: false,
    providerPermissionPrompts: false,
    cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_UNSPECIFIED,
    ...extra,
  };
}

function callResult<T>(fn: (call: { request: any }, cb: (err: grpc.ServiceError | null, res?: any) => void) => void, req: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fn({ request: req }, (err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

test('handshake advertises provider_permission_prompts, ahead of the executable pair that stays last', async () => {
  const impl = createRuntimeServiceImpl(new SessionRegistry(), () => makeFakeSession().session, { sdkDeclared: 'fake', hostCli: 'fake' });
  const { capabilities } = await callResult<{ capabilities: string[] }>(impl.handshake.bind(impl), { clientProtocolMajor: 3 });
  assert.ok(capabilities.includes('provider_permission_prompts'), JSON.stringify(capabilities));
  assert.ok(capabilities.indexOf('provider_permission_prompts') < capabilities.indexOf('executable_host_cli'));
});

test('mapClaudeHostPolicy: only true is forwarded; false leaves the kernel policy exactly as before the field', () => {
  assert.equal(mapClaudeHostPolicy(protoPolicy({ providerPermissionPrompts: true })).providerPermissionPrompts, true);
  const off = mapClaudeHostPolicy(protoPolicy());
  assert.equal(Object.hasOwn(off, 'providerPermissionPrompts'), false);
  const { providerPermissionPrompts: _ignored, ...withoutField } = protoPolicy();
  assert.deepEqual(off, mapClaudeHostPolicy(withoutField as ClaudeHostPolicyProto));
});

test('CreateSession mapping: the flag removes the three prompt tools for INTERACTIVE (and UNSPECIFIED, read as INTERACTIVE) only', () => {
  const disallowed = (policy: ClaudeHostPolicyProto): string[] =>
    buildSessionOptions(buildKernelSessionConfig({ cwd: '/p', policy }, { hostCliPath: 'claude' })).disallowedTools ?? [];
  for (const permissions of [PermissionMode.PERMISSION_MODE_INTERACTIVE, PermissionMode.PERMISSION_MODE_UNSPECIFIED]) {
    assert.deepEqual(disallowed(protoPolicy({ permissions, providerPermissionPrompts: true })), [...PROVIDER_PROMPT_TOOL_DENY], PermissionMode[permissions]);
    assert.deepEqual(disallowed(protoPolicy({ permissions })), [], PermissionMode[permissions]);
  }
  assert.deepEqual(disallowed(protoPolicy({ permissions: PermissionMode.PERMISSION_MODE_VERDANDI_RULES, providerPermissionPrompts: true })), []);
  const bypass = disallowed(protoPolicy({ permissions: PermissionMode.PERMISSION_MODE_BYPASS, providerPermissionPrompts: true }));
  for (const tool of PROVIDER_PROMPT_TOOL_DENY) {
    assert.ok(!bypass.includes(tool), `bypass ignores the flag, but ${tool} was disallowed`);
  }
});

test('validatePolicy: an allow list naming a prompt tool the flag removes is invalid_configuration', () => {
  for (const tool of PROVIDER_PROMPT_TOOL_DENY) {
    for (const permissions of [PermissionMode.PERMISSION_MODE_INTERACTIVE, PermissionMode.PERMISSION_MODE_UNSPECIFIED]) {
      assert.throws(
        () => validatePolicy(protoPolicy({ permissions, providerPermissionPrompts: true, toolPolicy: { unrestricted: false, deny: [], allow: { tools: ['Read', tool], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } })),
        (err: unknown) => (err as { code: number }).code === ErrorCode.ERROR_CODE_INVALID_CONFIGURATION && (err as Error).message.includes(tool),
        `${tool} under ${PermissionMode[permissions]}`,
      );
    }
  }
});

test('validatePolicy: the same allow list is accepted where the flag does not apply, and an allow list without them is accepted with it', () => {
  const allow = { unrestricted: false, deny: [], allow: { tools: ['Read', 'AskUserQuestion'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } };
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ toolPolicy: allow })));
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ permissions: PermissionMode.PERMISSION_MODE_VERDANDI_RULES, providerPermissionPrompts: true, toolPolicy: allow })));
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ permissions: PermissionMode.PERMISSION_MODE_BYPASS, providerPermissionPrompts: true, toolPolicy: allow })));
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ providerPermissionPrompts: true, toolPolicy: { unrestricted: false, deny: ['AskUserQuestion'], allow: { tools: ['Read'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } })));
  assert.doesNotThrow(() => validatePolicy(protoPolicy({ providerPermissionPrompts: true })));
});

test('translateEvent: a hook request states origin HOOK and carries no provider fields', () => {
  const event: ClaudeRuntimeEvent = { type: 'permission_requested', permissionId: 'p1', toolUseId: 'tu1', toolName: 'Bash', input: { command: 'ls' }, origin: 'hook' };
  assert.deepEqual(translateEvent(event), {
    permissionRequested: {
      permissionId: 'p1',
      toolUseId: 'tu1',
      toolName: 'Bash',
      inputJson: '{"command":"ls"}',
      origin: PermissionOrigin.PERMISSION_ORIGIN_HOOK,
      providerMatchedAskRule: undefined,
    },
  });
});

test('translateEvent: a provider prompt states origin PROVIDER_PROMPT with the CLI reason and description verbatim', () => {
  const event: ClaudeRuntimeEvent = {
    type: 'permission_requested',
    permissionId: 'p2',
    toolUseId: 'tu1',
    toolName: 'Write',
    input: { file_path: '/p/.git/probe', content: 'x' },
    origin: 'provider_prompt',
    providerReason: 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.',
    providerDescription: '.git/probe',
  };
  assert.deepEqual(translateEvent(event), {
    permissionRequested: {
      permissionId: 'p2',
      toolUseId: 'tu1',
      toolName: 'Write',
      inputJson: '{"file_path":"/p/.git/probe","content":"x"}',
      origin: PermissionOrigin.PERMISSION_ORIGIN_PROVIDER_PROMPT,
      providerReason: 'Claude requested permissions to edit /p/.git/probe which is a sensitive file.',
      providerDescription: '.git/probe',
      providerMatchedAskRule: undefined,
    },
  });
});

test('translateEvent: a rule-forced provider prompt carries the blocked path and the matched ask rule', () => {
  const event: ClaudeRuntimeEvent = {
    type: 'permission_requested',
    permissionId: 'p3',
    toolUseId: 'tu3',
    toolName: 'Bash',
    input: { command: 'cat /etc/passwd' },
    origin: 'provider_prompt',
    providerBlockedPath: '/etc/passwd',
    providerMatchedAskRule: { source: 'projectSettings', toolName: 'Bash', ruleContent: 'cat:*' },
  };
  const out = translateEvent(event) as { permissionRequested: PermissionRequested };
  assert.equal(out.permissionRequested.providerBlockedPath, '/etc/passwd');
  assert.deepEqual(out.permissionRequested.providerMatchedAskRule, { source: 'projectSettings', toolName: 'Bash', ruleContent: 'cat:*' });
  assert.equal(Object.hasOwn(out.permissionRequested, 'providerReason'), false);

  const bare = translateEvent({ ...event, providerMatchedAskRule: { source: 'localSettings', toolName: 'Write' } }) as { permissionRequested: PermissionRequested };
  assert.deepEqual(bare.permissionRequested.providerMatchedAskRule, { source: 'localSettings', toolName: 'Write' });
});

test('wire: PermissionRequested round-trips its new fields, keeps absent provider fields absent, and an old sidecar reads as UNSPECIFIED', () => {
  const prompt: SessionEvent = {
    sessionId: 's',
    sequence: 3n,
    occurredAt: 0n,
    permissionRequested: {
      permissionId: 'p',
      toolUseId: 'tu',
      toolName: 'Write',
      inputJson: '{}',
      origin: PermissionOrigin.PERMISSION_ORIGIN_PROVIDER_PROMPT,
      providerReason: 'why',
      providerDescription: '.git/probe',
      providerBlockedPath: '/p/.git/probe',
      providerMatchedAskRule: { source: 'projectSettings', toolName: 'Write', ruleContent: '.git/**' },
    },
  };
  assert.deepEqual(SessionEvent.decode(SessionEvent.encode(prompt).finish()).permissionRequested, prompt.permissionRequested);

  const hook = SessionEvent.decode(
    SessionEvent.encode({ ...prompt, permissionRequested: { permissionId: 'p', toolUseId: 'tu', toolName: 'Bash', inputJson: '{}', origin: PermissionOrigin.PERMISSION_ORIGIN_HOOK, providerMatchedAskRule: undefined } }).finish(),
  ).permissionRequested!;
  assert.equal(hook.origin, PermissionOrigin.PERMISSION_ORIGIN_HOOK);
  assert.equal(hook.providerReason, undefined);
  assert.equal(hook.providerDescription, undefined);
  assert.equal(hook.providerBlockedPath, undefined);
  assert.equal(hook.providerMatchedAskRule, undefined);

  // What a sidecar that predates tags 5-9 puts on the wire: fields 1-4 only.
  const old = PermissionRequested.decode(PermissionRequested.encode({ permissionId: 'p', toolUseId: 'tu', toolName: 'Bash', inputJson: '{}', origin: PermissionOrigin.PERMISSION_ORIGIN_UNSPECIFIED, providerMatchedAskRule: undefined }).finish());
  assert.equal(old.origin, PermissionOrigin.PERMISSION_ORIGIN_UNSPECIFIED);
  assert.equal(PermissionOrigin.PERMISSION_ORIGIN_UNSPECIFIED, 0);
});
