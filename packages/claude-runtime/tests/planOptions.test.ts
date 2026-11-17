import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { applyPlanOptIn, planAllowAnswer, planDeferral, planGateAbstains, planOffered, planOptInProblem } from '../src/planOptions.js';
import { buildSessionOptions, policyToBaseOptions, PROVIDER_PROMPT_TOOL_DENY } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeSessionConfig, ClientInteractions } from '../src/types.js';

/**
 * Plan mode's options: a session that opts in (and can) is offered `EnterPlanMode` and `ExitPlanMode`;
 * every other session's options are exactly what they were.
 */

const INTERACTIVE: ClaudeHostPolicy = { configuration: 'native', permissions: 'interactive', persistence: 'host_cli', executable: 'host_cli' };
const PROMPTING: ClaudeHostPolicy = { ...INTERACTIVE, providerPermissionPrompts: true };
const AUTO: ClaudeHostPolicy = { ...PROMPTING, cliPermissionMode: 'auto' };
const DEFAULT: ClaudeHostPolicy = { ...PROMPTING, cliPermissionMode: 'default' };
const PLAN: ClientInteractions = { questions: false, planMode: true };
const BASE_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u' };

function build(policy: ClaudeHostPolicy, clientInteractions?: ClientInteractions): Options {
  return policyToBaseOptions(policy, '/p', { baseEnv: BASE_ENV, ...(clientInteractions === undefined ? {} : { clientInteractions }) });
}

test('a plan session offers both plan tools and a caller deny still wins', () => {
  for (const policy of [AUTO, DEFAULT]) {
    assert.deepEqual(build(policy, PLAN).disallowedTools, ['AskUserQuestion'], policy.cliPermissionMode);
    // With questions too, nothing of the three is left.
    assert.deepEqual(build(policy, { questions: true, planMode: true }).disallowedTools, []);
  }
  const denying: ClaudeHostPolicy = { ...AUTO, toolPolicy: { deny: ['Bash', 'ExitPlanMode'] } };
  assert.deepEqual(build(denying, PLAN).disallowedTools, ['Bash', 'ExitPlanMode', 'AskUserQuestion']);
  const denyingEnter: ClaudeHostPolicy = { ...AUTO, toolPolicy: { deny: ['EnterPlanMode'] } };
  assert.deepEqual(build(denyingEnter, PLAN).disallowedTools, ['EnterPlanMode', 'AskUserQuestion']);
  // Nothing else of the options moves: the plan-mode instructions stay the CLI's own.
  const without = build(AUTO);
  const with_ = build(AUTO, PLAN);
  assert.equal('planModeInstructions' in with_, false);
  assert.deepEqual({ ...with_, disallowedTools: undefined }, { ...without, disallowedTools: undefined });
  // `applyPlanOptIn` on its own, on options that have no deny list yet, leaves an empty one.
  const bare: Options = {};
  applyPlanOptIn(bare, { policy: AUTO, clientInteractions: PLAN });
  assert.deepEqual(bare.disallowedTools, []);
});

/** What every session shape built before plan mode existed (see seams322.test.ts for the shapes). */
type Shape =
  | { name: string; kind: 'base'; input: { policy: ClaudeHostPolicy; cwd: string; overrides: Parameters<typeof policyToBaseOptions>[2] | null }; keys: string[]; options: unknown }
  | { name: string; kind: 'session'; input: { config: ClaudeSessionConfig }; keys: string[]; options: unknown };

const SNAPSHOT = JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/sessionOptionsSnapshot.json', import.meta.url)), 'utf8')) as Shape[];

function plain(options: Options): unknown {
  return JSON.parse(JSON.stringify(options));
}

function buildShape(shape: Shape, clientInteractions?: ClientInteractions): Options {
  if (shape.kind === 'base') {
    const overrides = shape.input.overrides ?? {};
    return policyToBaseOptions(shape.input.policy, shape.input.cwd, clientInteractions === undefined ? shape.input.overrides ?? undefined : { ...overrides, clientInteractions });
  }
  const saved = process.env;
  process.env = { PATH: '/usr/bin', HOME: '/home/u' };
  try {
    return buildSessionOptions(clientInteractions === undefined ? shape.input.config : { ...shape.input.config, clientInteractions });
  } finally {
    process.env = saved;
  }
}

/** The snapshot's options with the changes made on purpose since it was recorded (as seams322.test.ts). */
function expected(shape: Shape): unknown {
  const options = structuredClone(shape.options) as Record<string, unknown>;
  const fallback = shape.kind === 'base' ? (shape.input.overrides?.baseEnv ?? process.env) : { PATH: '/usr/bin', HOME: '/home/u' };
  options.env = { ...((options.env as Record<string, string> | undefined) ?? fallback), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  const policy = shape.kind === 'base' ? shape.input.policy : shape.input.config.policy;
  if (policy.perTaskStop === true) {
    options.perTaskStopAffordance = true;
  }
  return plain(options as Options);
}

test('a session without the opt-in keeps all three denials byte-identical', () => {
  assert.ok(SNAPSHOT.length >= 20, `only ${SNAPSHOT.length} shapes recorded`);
  let denying = 0;
  for (const shape of SNAPSHOT) {
    const policy = shape.kind === 'base' ? shape.input.policy : shape.input.config.policy;
    const canOptIn = planOffered({ policy, clientInteractions: PLAN });
    const requests: (ClientInteractions | undefined)[] = [undefined, { questions: false, planMode: false }, ...(canOptIn ? [] : [PLAN])];
    for (const request of requests) {
      const options = buildShape(shape, request);
      assert.deepEqual(plain(options), expected(shape), `${shape.name}, request ${JSON.stringify(request)}`);
    }
    if (PROVIDER_PROMPT_TOOL_DENY.every((tool) => (buildShape(shape).disallowedTools ?? []).includes(tool))) {
      denying += 1;
    }
  }
  assert.ok(denying > 0, 'at least one recorded shape denies the three prompt tools');
});

test('plan needs provider prompts and a stated CLI mode', () => {
  assert.equal(planOptInProblem({ policy: INTERACTIVE, clientInteractions: PLAN }), 'client_interactions_needs_provider_prompts');
  assert.equal(planOptInProblem({ policy: { ...AUTO, permissions: 'verdandi_rules' }, clientInteractions: PLAN }), 'client_interactions_needs_provider_prompts');
  assert.equal(planOptInProblem({ policy: { ...AUTO, permissions: 'bypass', cliPermissionMode: undefined }, clientInteractions: PLAN }), 'client_interactions_needs_provider_prompts');
  assert.equal(planOptInProblem({ policy: PROMPTING, clientInteractions: PLAN }), 'client_interactions_plan_needs_cli_mode');
  // A plan session never switches its permission mode, so a policy that asks to be switchable (and would
  // launch the CLI able to enter bypass) is refused, and offers nothing.
  assert.equal(planOptInProblem({ policy: { ...DEFAULT, permissionModeSwitchable: true }, clientInteractions: PLAN }), 'client_interactions_plan_with_switchable');
  assert.equal(planOffered({ policy: { ...DEFAULT, permissionModeSwitchable: true }, clientInteractions: PLAN }), false);
  assert.deepEqual(build({ ...DEFAULT, permissionModeSwitchable: true }, PLAN).disallowedTools, [...PROVIDER_PROMPT_TOOL_DENY]);
  assert.equal(planOptInProblem({ policy: { ...DEFAULT, permissionModeSwitchable: false }, clientInteractions: PLAN }), null);
  assert.equal(planOptInProblem({ policy: AUTO, clientInteractions: PLAN }), null);
  assert.equal(planOptInProblem({ policy: DEFAULT, clientInteractions: PLAN }), null);
  // Not asking is never refused, whatever the policy.
  for (const clientInteractions of [undefined, { questions: true }, { questions: false, planMode: false }]) {
    assert.equal(planOptInProblem({ policy: INTERACTIVE, clientInteractions }), null);
  }
  // And a request that cannot be honoured offers nothing.
  assert.equal(planOffered({ policy: INTERACTIVE, clientInteractions: PLAN }), false);
  assert.equal(planOffered({ policy: PROMPTING, clientInteractions: PLAN }), false);
  assert.equal(planOffered({ policy: AUTO, clientInteractions: PLAN }), true);
  assert.deepEqual(build(PROMPTING, PLAN).disallowedTools, [...PROVIDER_PROMPT_TOOL_DENY]);
});

test('the gate abstains only for the two plan tools on a plan session', () => {
  const plan = { policy: AUTO, clientInteractions: PLAN };
  assert.equal(planGateAbstains(plan, 'EnterPlanMode'), true);
  assert.equal(planGateAbstains(plan, 'ExitPlanMode'), true);
  for (const tool of ['AskUserQuestion', 'Write', 'Bash', 'exitplanmode', 'ExitPlanMode ']) {
    assert.equal(planGateAbstains(plan, tool), false, tool);
  }
  for (const config of [{ policy: AUTO }, { policy: AUTO, clientInteractions: { questions: true } }, { policy: PROMPTING, clientInteractions: PLAN }]) {
    assert.equal(planGateAbstains(config, 'ExitPlanMode'), false, JSON.stringify(config));
    assert.equal(planGateAbstains(config, 'EnterPlanMode'), false, JSON.stringify(config));
  }
});

test('planDeferral holds only the four effectful tools and only in plan', () => {
  const plan = { policy: AUTO, clientInteractions: PLAN };
  // Writes get no decision, a command gets an ask; outside plan everything is the allow.
  assert.deepEqual(
    ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Read'].map((tool) => planAllowAnswer(plan, tool, 'plan')),
    ['abstain', 'abstain', 'abstain', 'ask', 'allow'],
  );
  assert.equal(planAllowAnswer(plan, 'Bash', 'auto'), 'allow');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash']) {
    assert.equal(planDeferral(plan, tool, 'plan'), true, tool);
    for (const mode of ['auto', 'default', undefined, 'acceptEdits', 'bypassPermissions']) {
      assert.equal(planDeferral(plan, tool, mode), false, `${tool} in ${mode}`);
    }
    assert.equal(planDeferral({ policy: AUTO }, tool, 'plan'), false, `${tool} on a session without plan mode`);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'ExitPlanMode', 'EnterPlanMode', 'WebFetch', 'bash']) {
    assert.equal(planDeferral(plan, tool, 'plan'), false, tool);
  }
});
