import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { applyQuestionOptIn, gateAbstains, interactionOptInProblem, questionsOffered } from '../src/questionOptions.js';
import { buildSessionOptions, policyToBaseOptions, PROVIDER_PROMPT_TOOL_DENY } from '../src/session.js';
import type { ClaudeAccount } from '../src/account.js';
import type { ClaudeHostPolicy, ClientInteractions } from '../src/types.js';

const INTERACTIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const OFFERING: ClaudeHostPolicy = { ...INTERACTIVE, providerPermissionPrompts: true };
const RULES: ClaudeHostPolicy = { ...OFFERING, permissions: 'verdandi_rules' };
const BYPASS: ClaudeHostPolicy = { ...OFFERING, permissions: 'bypass' };
const ASKING: ClientInteractions = { questions: true };
const QUESTION_ENV = {
  CLAUDE_CODE_QUESTION_EXTENDED: '1',
  CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS: '1',
  CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html',
};
const BASE_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u', ...QUESTION_ENV };
const ACCOUNT: ClaudeAccount = { name: 'work', configDir: '/home/u/.claude-work', anthropicConfigDir: '/home/u/.config/anthropic-work' };
const DEFAULT_ACCOUNT: ClaudeAccount = { name: 'default', configDir: '/home/u/.claude', anthropicConfigDir: '', defaultLocation: true };

function build(policy: ClaudeHostPolicy, clientInteractions?: ClientInteractions, extra: { account?: ClaudeAccount; baseEnv?: NodeJS.ProcessEnv } = {}): Options {
  return policyToBaseOptions(policy, '/p', { baseEnv: BASE_ENV, ...extra, ...(clientInteractions === undefined ? {} : { clientInteractions }) });
}

test('not opted in, the three prompt tools are denied exactly as before', () => {
  for (const clientInteractions of [undefined, { questions: false }]) {
    const options = build(OFFERING, clientInteractions);
    assert.deepEqual(options.disallowedTools, [...PROVIDER_PROMPT_TOOL_DENY]);
    assert.equal(options.toolConfig, undefined);
    // The environment every session gets: the base one plus the session-state switch, question variables kept.
    assert.deepEqual(options.env, { ...BASE_ENV, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
  }
});

test('opted in, AskUserQuestion is offered and the plan tools stay denied', () => {
  const options = build(OFFERING, ASKING);
  assert.deepEqual(options.disallowedTools, ['EnterPlanMode', 'ExitPlanMode']);
});

test('opted in, a caller deny of AskUserQuestion still wins, in the caller position', () => {
  const policy: ClaudeHostPolicy = { ...OFFERING, toolPolicy: { deny: ['Bash', 'AskUserQuestion'] } };
  assert.deepEqual(build(policy, ASKING).disallowedTools, ['Bash', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
});

test('opted in, a caller deny of a plan tool is not duplicated and the plan tools stay denied', () => {
  const policy: ClaudeHostPolicy = { ...OFFERING, toolPolicy: { deny: ['ExitPlanMode'] } };
  assert.deepEqual(build(policy, ASKING).disallowedTools, ['ExitPlanMode', 'EnterPlanMode']);
});

test('toolConfig is set to markdown previews only for an opted-in session', () => {
  assert.deepEqual(build(OFFERING, ASKING).toolConfig, { askUserQuestion: { previewFormat: 'markdown' } });
  for (const [policy, clientInteractions] of [
    [OFFERING, undefined],
    [OFFERING, { questions: false }],
    [INTERACTIVE, ASKING],
    [RULES, ASKING],
    [BYPASS, ASKING],
  ] as const) {
    assert.equal('toolConfig' in build(policy, clientInteractions), false, `${policy.permissions} ${JSON.stringify(clientInteractions)}`);
  }
});

test('the three question variables leave the session environment and never the process environment', () => {
  const saved = process.env;
  const processEnv = { PATH: '/usr/bin', ...QUESTION_ENV };
  process.env = processEnv;
  const before = structuredClone(processEnv);
  try {
    // No base environment given: the copy is made from the process environment.
    const fromProcess = policyToBaseOptions(OFFERING, '/p', { clientInteractions: ASKING });
    assert.deepEqual(fromProcess.env, { PATH: '/usr/bin', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    assert.deepEqual(process.env, before);
    assert.notEqual(fromProcess.env, process.env);
    // A base environment given: that one is copied, and left as it was.
    const baseEnv = { ...BASE_ENV };
    const fromBase = policyToBaseOptions(OFFERING, '/p', { baseEnv, clientInteractions: ASKING });
    assert.deepEqual(fromBase.env, { PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    assert.deepEqual(baseEnv, BASE_ENV);
    assert.deepEqual(process.env, before);
    // An account binding builds the environment first; the variables go after it.
    const bound = policyToBaseOptions(OFFERING, '/p', { baseEnv, account: ACCOUNT, clientInteractions: ASKING });
    for (const name of Object.keys(QUESTION_ENV)) {
      assert.equal(name in (bound.env ?? {}), false, name);
    }
    assert.equal(bound.env?.PATH, '/usr/bin');
    assert.equal(bound.env?.CLAUDE_CONFIG_DIR, ACCOUNT.configDir);
    assert.deepEqual(baseEnv, BASE_ENV);
    assert.deepEqual(process.env, before);
    const atDefault = policyToBaseOptions(OFFERING, '/p', { baseEnv: { ...BASE_ENV, CLAUDE_CONFIG_DIR: '/x' }, account: DEFAULT_ACCOUNT, clientInteractions: ASKING });
    assert.equal(atDefault.env?.CLAUDE_CONFIG_DIR, undefined);
    assert.equal('CLAUDE_CODE_QUESTION_PREVIEW_FORMAT' in (atDefault.env ?? {}), false);
    // The isolated profile's overlay is kept.
    const isolated = policyToBaseOptions({ ...OFFERING, configuration: 'isolated' }, '/p', { baseEnv, clientInteractions: ASKING });
    assert.equal(isolated.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal('CLAUDE_CODE_QUESTION_EXTENDED' in (isolated.env ?? {}), false);
  } finally {
    process.env = saved;
  }
});

test('a session that is not opted in keeps the question variables it inherited', () => {
  const account = build(OFFERING, undefined, { account: ACCOUNT });
  assert.equal(account.env?.CLAUDE_CODE_QUESTION_EXTENDED, '1');
  const isolated = build({ ...OFFERING, configuration: 'isolated' }, { questions: false });
  assert.equal(isolated.env?.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT, 'html');
});

test('a request outside an interactive session with provider prompts changes no option', () => {
  for (const policy of [INTERACTIVE, RULES, BYPASS]) {
    assert.deepEqual(build(policy, ASKING), build(policy, undefined), policy.permissions);
  }
});

test('buildSessionOptions applies the opt-in the same way', () => {
  const options = buildSessionOptions({ cwd: '/p', policy: OFFERING, clientInteractions: ASKING });
  assert.deepEqual(options.disallowedTools, ['EnterPlanMode', 'ExitPlanMode']);
  assert.deepEqual(options.toolConfig, { askUserQuestion: { previewFormat: 'markdown' } });
});

test('applyQuestionOptIn on options it is handed leaves a not-opted-in session untouched', () => {
  const options: Options = { cwd: '/p', env: { ...BASE_ENV }, disallowedTools: ['Bash'] };
  const before = structuredClone(options);
  for (const clientInteractions of [undefined, { questions: false }]) {
    applyQuestionOptIn(options, { policy: OFFERING, clientInteractions, baseEnv: BASE_ENV });
    assert.deepEqual(options, before);
  }
});

test('the opt-in is refused without INTERACTIVE and provider prompts, and taken with them', () => {
  for (const policy of [INTERACTIVE, RULES, BYPASS]) {
    assert.equal(interactionOptInProblem({ policy, clientInteractions: ASKING }), 'client_interactions_needs_provider_prompts', policy.permissions);
    assert.equal(questionsOffered({ policy, clientInteractions: ASKING }), false, policy.permissions);
  }
  assert.equal(interactionOptInProblem({ policy: OFFERING, clientInteractions: ASKING }), null);
  assert.equal(questionsOffered({ policy: OFFERING, clientInteractions: ASKING }), true);
  assert.equal(interactionOptInProblem({ policy: { ...OFFERING, providerPermissionPrompts: false }, clientInteractions: ASKING }), 'client_interactions_needs_provider_prompts');
  for (const policy of [INTERACTIVE, OFFERING, RULES, BYPASS]) {
    assert.equal(interactionOptInProblem({ policy, clientInteractions: undefined }), null);
    assert.equal(interactionOptInProblem({ policy, clientInteractions: { questions: false } }), null);
  }
});

test('gateAbstains is true for AskUserQuestion of an opted-in session and for nothing else', () => {
  const tools = ['Bash', 'Read', 'Write', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'TaskStop', 'Agent', 'mcp__docs__AskUserQuestion', 'askuserquestion', 'SomeFutureTool', ''];
  for (const tool of tools) {
    assert.equal(gateAbstains({ policy: OFFERING, clientInteractions: ASKING }, tool), false, tool);
  }
  assert.equal(gateAbstains({ policy: OFFERING, clientInteractions: ASKING }, 'AskUserQuestion'), true);
  for (const [policy, clientInteractions] of [
    [OFFERING, undefined],
    [OFFERING, { questions: false }],
    [INTERACTIVE, ASKING],
    [RULES, ASKING],
    [BYPASS, ASKING],
  ] as const) {
    assert.equal(gateAbstains({ policy, clientInteractions }, 'AskUserQuestion'), false, `${policy.permissions} ${JSON.stringify(clientInteractions)}`);
  }
});
