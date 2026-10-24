import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { SidecarError, toGrpcMetadata } from '../src/errorMapping.js';
import { startSidecar } from '../src/lifecycle.js';
import { validatePolicy, validateEffort, validateResumeRequest, validateSystemPrompt, validateOutputFormat } from '../src/runtimeServiceImpl.js';
import { replayRequestFromProto } from '../src/replayRequest.js';
import {
  ClaudeHostPolicy,
  CliPermissionMode,
  ConfigurationProfile,
  CreateSessionRequest,
  ErrorCode,
  ErrorDetail,
  ExecutableSource,
  InitCheck,
  PermissionMode,
  PersistenceMode,
  ReplayStart,
  RuntimeServiceClient,
  SettingSource,
  StreamingMode,
} from '../src/generated/verdandi/claude/runtime/v1/runtime.js';
import * as old from './compat/b3aa188/generated/runtime.js';
import { REPO_ROOT, SIDECAR_DIR } from './compat/paths.js';
import { makeFakeSession } from './fakeSession.js';

/**
 * `ErrorDetail.reason`: a stable name for which rule refused a request. Held three ways: each rule
 * really produces its reason (one row each, through the production validators), the reason survives the
 * wire to a client generated from the current proto while a client from the frozen proto still reads the
 * same code and message, and no refusal in the sources is left without one.
 */

function refusal(run: () => void): SidecarError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SidecarError, `expected a SidecarError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a refusal');
}

const policy = (partial: Partial<ClaudeHostPolicy>): ClaudeHostPolicy => ClaudeHostPolicy.fromPartial(partial);

const POLICY_ROWS: Array<[reason: string, run: () => void]> = [
  ['configuration_unknown', () => validatePolicy(policy({ configuration: 99 as ConfigurationProfile }))],
  ['permissions_unknown', () => validatePolicy(policy({ permissions: 99 as PermissionMode }))],
  ['persistence_unknown', () => validatePolicy(policy({ persistence: 99 as PersistenceMode }))],
  ['executable_unknown', () => validatePolicy(policy({ executable: 99 as ExecutableSource }))],
  ['streaming_unknown', () => validatePolicy(policy({ streaming: 99 as StreamingMode }))],
  ['executable_unavailable', () => validatePolicy(policy({ executable: ExecutableSource.EXECUTABLE_SOURCE_SDK_BUNDLED }), { sdkBundledAvailable: false })],
  ['setting_source_unknown', () => validatePolicy(policy({ settingSources: { sources: [SettingSource.SETTING_SOURCE_UNSPECIFIED] } }))],
  ['cli_permission_mode_unknown', () => validatePolicy(policy({ cliPermissionMode: 99 as CliPermissionMode }))],
  ['cli_auto_needs_interactive', () => validatePolicy(policy({ cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_AUTO, permissions: PermissionMode.PERMISSION_MODE_BYPASS }))],
  ['cli_auto_with_switchable', () => validatePolicy(policy({ cliPermissionMode: CliPermissionMode.CLI_PERMISSION_MODE_AUTO, permissionModeSwitchable: true }))],
  ['init_check_unknown', () => validatePolicy(policy({ toolPolicy: { deny: [], unrestricted: false, allow: { tools: ['Read'], initCheck: 99 as InitCheck } } }))],
  ['tool_policy_unrestricted_with_restriction', () => validatePolicy(policy({ toolPolicy: { deny: ['Bash'], unrestricted: true, allow: undefined } }))],
  ['tool_policy_empty_name', () => validatePolicy(policy({ toolPolicy: { deny: [' '], unrestricted: false, allow: undefined } }))],
  ['tool_policy_deny_allow_overlap', () => validatePolicy(policy({ toolPolicy: { deny: ['Bash'], unrestricted: false, allow: { tools: ['Bash'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }))],
  [
    'tool_policy_allow_provider_prompt_tool',
    () =>
      validatePolicy(
        policy({ providerPermissionPrompts: true, toolPolicy: { deny: [], unrestricted: false, allow: { tools: ['AskUserQuestion'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }),
      ),
  ],
  ['effort_unknown', () => validateEffort({ cwd: '/', policy: undefined, effort: 'enormous' })],
  ['system_prompt_blank', () => validateSystemPrompt({ cwd: '/', policy: undefined, systemPrompt: '  ' })],
  ['output_schema_not_json', () => validateOutputFormat({ cwd: '/', policy: undefined, outputFormat: { jsonSchemaJson: '{' } })],
  ['output_schema_not_object', () => validateOutputFormat({ cwd: '/', policy: undefined, outputFormat: { jsonSchemaJson: '[1]' } })],
  ['resume_id_empty', () => validateResumeRequest({ cwd: '/', policy: undefined, resumeProviderSessionId: ' ' })],
  ['fork_without_resume', () => validateResumeRequest({ cwd: '/', policy: undefined, fork: true })],
  ['replay_cursor_missing', () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_AFTER_SEQUENCE, afterSequence: undefined })],
  ['replay_start_unrecognized', () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_UNSPECIFIED, afterSequence: undefined })],
  ['replay_cursor_unexpected', () => replayRequestFromProto({ start: ReplayStart.REPLAY_START_FROM_NOW, afterSequence: 5n })],
];

for (const [reason, run] of POLICY_ROWS) {
  test(`reason: ${reason} is what the rule that refuses says, and it is an INVALID_CONFIGURATION`, () => {
    const error = refusal(run);
    assert.equal(error.code, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
    assert.equal(error.reason, reason);
    assert.notEqual(error.message, '');
  });
}

test('reason: each of the five older policy enums refuses -1 and any other undeclared number, and accepts every declared one', () => {
  const fields = {
    configuration: ConfigurationProfile,
    permissions: PermissionMode,
    persistence: PersistenceMode,
    executable: ExecutableSource,
    streaming: StreamingMode,
  } as const;
  for (const [field, values] of Object.entries(fields)) {
    for (const undeclared of [-1, 99, 2 ** 31 - 1]) {
      const error = refusal(() => validatePolicy(policy({ [field]: undeclared })));
      assert.equal(error.code, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, `${field}=${undeclared}`);
      assert.equal(error.reason, `${field}_unknown`, `${field}=${undeclared}`);
    }
    const declared = Object.values(values).filter((v): v is number => typeof v === 'number' && v !== -1);
    assert.ok(declared.includes(0), `${field}: UNSPECIFIED is declared`);
    for (const value of declared) {
      assert.doesNotThrow(() => validatePolicy(policy({ [field]: value }), { sdkBundledAvailable: true }), `${field}=${value}`);
    }
  }
});

test('reason: a request every rule accepts raises nothing, and an old policy is not refused for the new field', () => {
  assert.doesNotThrow(() => validatePolicy(policy({})));
  assert.doesNotThrow(() => validatePolicy(undefined));
});

test('reason: the frozen client reads the same code and message from a refusal that carries a reason, and ignores the reason', () => {
  const error = new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'tool_policy names Bash in both deny and allow', 'tool_policy_deny_allow_overlap');
  const bytes = toGrpcMetadata(error).get('grpc-status-details-bin')[0] as Buffer;
  const frozen = old.ErrorDetail.decode(bytes);
  assert.equal(frozen.code, old.ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
  assert.equal(frozen.message, 'tool_policy names Bash in both deny and allow');
  assert.equal(ErrorDetail.decode(bytes).reason, 'tool_policy_deny_allow_overlap');
  // No reason: the field is not on the wire at all, byte for byte what a sidecar without it sends.
  const bare = toGrpcMetadata(new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, 'x')).get('grpc-status-details-bin')[0] as Buffer;
  assert.deepEqual(bare, Buffer.from(old.ErrorDetail.encode({ code: old.ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, message: 'x' }).finish()));
});

test('reason: over a real socket the current client reads the reason out of the refusal, the frozen client does not need it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-wire-'));
  const socketPath = join(dir, 's.sock');
  const sidecar = await startSidecar({
    socketPath,
    sessionFactory: () => makeFakeSession().session,
    getClaudeCodeVersions: () => ({ sdkDeclared: 'fake', hostCli: 'fake' }),
    classifyCliVersion: () => ({ kind: 'supported' }),
  });
  const client = new RuntimeServiceClient(`unix://${socketPath}`, grpc.credentials.createInsecure());
  try {
    const failure = await new Promise<grpc.ServiceError>((resolve, reject) =>
      client.createSession(
        CreateSessionRequest.fromPartial({ cwd: '/tmp', policy: policy({ toolPolicy: { deny: ['Bash'], unrestricted: false, allow: { tools: ['Bash'], initCheck: InitCheck.INIT_CHECK_UNSPECIFIED } } }) }),
        (error) => (error === null ? reject(new Error('the request was accepted')) : resolve(error)),
      ),
    );
    assert.equal(failure.code, grpc.status.INVALID_ARGUMENT);
    const bytes = failure.metadata.get('grpc-status-details-bin')[0] as Buffer;
    const detail = ErrorDetail.decode(bytes);
    assert.equal(detail.code, ErrorCode.ERROR_CODE_INVALID_CONFIGURATION);
    assert.equal(detail.reason, 'tool_policy_deny_allow_overlap');
    assert.equal(old.ErrorDetail.decode(bytes).message, detail.message);
  } finally {
    client.close();
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- No refusal without a reason ------------------------------------------------------------------------

/** The text of each `new SidecarError(...)` call's argument list, read with strings, templates and comments skipped. */
function sidecarErrorArguments(source: string): string[] {
  const found: string[] = [];
  for (const start of source.matchAll(/new SidecarError\(/g)) {
    let depth = 1;
    let at = start.index + start[0].length;
    const open = at;
    while (at < source.length && depth > 0) {
      const char = source[at];
      if (char === "'" || char === '"') {
        at += 1;
        while (source[at] !== char) {
          at += source[at] === '\\' ? 2 : 1;
        }
      } else if (char === '`') {
        // A template literal: skip to its end, recursing into `${ ... }` by counting braces.
        at += 1;
        let braces = 0;
        while (!(source[at] === '`' && braces === 0)) {
          if (source[at] === '\\') {
            at += 2;
            continue;
          }
          if (source[at] === '$' && source[at + 1] === '{') {
            braces += 1;
            at += 2;
            continue;
          }
          if (braces > 0 && source[at] === '}') {
            braces -= 1;
          }
          at += 1;
        }
      } else if (char === '/' && source[at + 1] === '/') {
        while (source[at] !== '\n') {
          at += 1;
        }
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      at += 1;
    }
    found.push(source.slice(open, at - 1));
  }
  return found;
}

/** An argument list split at its top-level commas, with strings, templates and comments skipped over. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < args.length; at += 1) {
    const char = args[at];
    if (char === "'" || char === '"') {
      at += 1;
      while (args[at] !== char) {
        at += args[at] === '\\' ? 2 : 1;
      }
    } else if (char === '`') {
      at += 1;
      let braces = 0;
      while (!(args[at] === '`' && braces === 0)) {
        if (args[at] === '\\') {
          at += 2;
          continue;
        }
        if (args[at] === '$' && args[at + 1] === '{') {
          braces += 1;
          at += 2;
          continue;
        }
        if (braces > 0 && args[at] === '}') {
          braces -= 1;
        }
        at += 1;
      }
    } else if (char === '/' && args[at + 1] === '/') {
      while (args[at] !== '\n' && at < args.length) {
        at += 1;
      }
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(args.slice(from, at).trim());
      from = at + 1;
    }
  }
  const last = args.slice(from).trim();
  return last === '' ? parts : [...parts, last];
}

test('reason: every INVALID_CONFIGURATION a sidecar source can throw carries a reason', () => {
  let seen = 0;
  for (const file of ['runtimeServiceImpl.ts', 'replayRequest.ts', 'lifecycle.ts', 'eventTranslation.ts', 'pumpDriver.ts', 'sessionRegistry.ts']) {
    const source = readFileSync(join(SIDECAR_DIR, 'src', file), 'utf8');
    for (const args of sidecarErrorArguments(source)) {
      if (!args.includes('ERROR_CODE_INVALID_CONFIGURATION')) {
        continue;
      }
      seen += 1;
      assert.ok(splitArguments(args).length >= 3, `an INVALID_CONFIGURATION in ${file} has no reason:\n${args.slice(0, 300)}`);
    }
  }
  assert.ok(seen >= 20, `found only ${seen} INVALID_CONFIGURATION sites: the scan lost them`);
});

test('reason: COMPATIBILITY.md documents exactly the reasons the sources can produce', () => {
  const produced = new Set<string>();
  for (const file of ['runtimeServiceImpl.ts', 'replayRequest.ts']) {
    const source = readFileSync(join(SIDECAR_DIR, 'src', file), 'utf8');
    for (const args of sidecarErrorArguments(source)) {
      if (!args.includes('ERROR_CODE_INVALID_CONFIGURATION')) {
        continue;
      }
      const reason = splitArguments(args)[2] ?? '';
      const literal = /^'([a-z][a-z_]+)'$/.exec(reason);
      if (literal !== null) {
        produced.add(literal[1]);
      }
      // `cli_auto_*` is a ternary of two literals.
      for (const match of reason.matchAll(/\? '([a-z_]+)' : '([a-z_]+)'/g)) {
        produced.add(match[1]);
        produced.add(match[2]);
      }
    }
  }
  // The ones that are not literals: the kernel's own `kind` (defer_not_allowed, contradictory_answer),
  // permission_mode_<kind>, and <field>_unknown for the five policy enums. Their spelling is held by
  // types (the kernel's, and declaredValue's field union), so they are named here.
  for (const reason of [
    'defer_not_allowed',
    'contradictory_answer',
    'permission_mode_refused',
    'permission_mode_provider_refused',
    'configuration_unknown',
    'permissions_unknown',
    'persistence_unknown',
    'executable_unknown',
    'streaming_unknown',
    // SteerTurn's: the kernel's `SteerRefusalReason`, passed through (INVALID_CONFIGURATION and
    // STEER_UNAVAILABLE).
    'steer_client_message_id_missing',
    'steer_expected_turn_id_missing',
    'steer_text_empty',
    'steer_client_message_id_reused',
    'cli_lifecycle_not_reported',
    'first_turn_held',
  ]) {
    produced.add(reason);
  }
  const compat = readFileSync(join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'COMPATIBILITY.md'), 'utf8');
  const heading = compat.indexOf('### `ErrorDetail.reason`');
  assert.ok(heading >= 0, 'no ErrorDetail.reason section');
  const body = compat.slice(heading, compat.indexOf('\n## ', heading) >= 0 ? compat.indexOf('\n## ', heading) : undefined);
  const documented = new Set([...body.matchAll(/^\| `([a-z][a-z_]+)` \|/gm)].map((match) => match[1]));
  assert.deepEqual([...documented].sort(), [...produced].sort(), 'the reasons in COMPATIBILITY.md and in the sources disagree');
});
