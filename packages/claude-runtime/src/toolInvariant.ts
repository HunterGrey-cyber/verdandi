import type { ClaudeSessionConfig, InitFingerprint } from './types.js';

/**
 * The tool name(s) a session with `outputFormat` may report in system/init even under an explicit
 * empty allow list: the CLI delivers structured output through a synthetic "carrier" tool call.
 *
 * Measured, not assumed: the M1 recording (tests/fixtures/m1/manifest.json, CLI 2.1.281 with SDK
 * 0.3.252) saw exactly this in system/init under an empty allow list, as `init_tools` and
 * `carrier_tool`, and tests/toolInvariant.test.ts pins the constant to it. Hosts read it from the
 * handshake's `structured_output_tools` rather than hard-coding it. If a CLI release renames the
 * carrier, every verified session with an output format closes with tool_policy_violation -- loud,
 * and the fix is a new recording plus this constant, never a looser check.
 */
export const STRUCTURED_OUTPUT_CARRIER_TOOLS: readonly string[] = Object.freeze(['StructuredOutput']);

/**
 * Whether this session closes over a system/init that breaks its allow list: every explicit allow
 * list is verified unless it says `initCheck: 'report_only'`. An absent `initCheck` verifies, which
 * keeps every caller that predates the field exactly where it was. `undefined` when there is no allow
 * list, and so nothing to check.
 */
export function verifiesInitTools(config: Pick<ClaudeSessionConfig, 'policy'>): boolean | undefined {
  const toolPolicy = config.policy.toolPolicy;
  if (toolPolicy?.allow === undefined) {
    return undefined;
  }
  return toolPolicy.initCheck !== 'report_only';
}

/**
 * Why this policy's `initCheck` cannot be honoured, or `null`. It describes what to do with an allow
 * list, so stating it without one is a caller that believes something is being checked when nothing
 * is.
 */
export function initCheckProblem(config: Pick<ClaudeSessionConfig, 'policy'>): string | null {
  const toolPolicy = config.policy.toolPolicy;
  if (toolPolicy?.initCheck !== undefined && toolPolicy.allow === undefined) {
    return `toolPolicy.initCheck is ${JSON.stringify(toolPolicy.initCheck)} but there is no toolPolicy.allow to check system/init against`;
  }
  return null;
}

/**
 * The tools system/init may report for this session, or `undefined` when the session is not
 * checked at all. Every EXPLICIT allow list is checked (unless it says `report_only`, see
 * `verifiesInitTools`): the carrier (when the session has an output format) plus exactly the tools
 * the list names. An absent allow list means "do not touch the base
 * tool set", so every session that states none -- the investigator's `unrestricted`, Neovibe's
 * interactive sessions -- is unaffected.
 *
 * Until the consumer client spec (§9.1) only an explicit EMPTY list was checked; a non-empty one had
 * no user. The web-tool completion (`allow: ['WebFetch', 'WebSearch']`) is the first, and a check
 * that stopped at "empty" would let it run with whatever else the CLI decided to hand it.
 */
export function permittedInitTools(config: Pick<ClaudeSessionConfig, 'policy' | 'outputFormat'>): readonly string[] | undefined {
  const allow = config.policy.toolPolicy?.allow;
  if (allow === undefined) {
    return undefined;
  }
  const carrier = config.outputFormat !== undefined ? STRUCTURED_OUTPUT_CARRIER_TOOLS : [];
  return Object.freeze([...carrier, ...allow.filter((tool) => !carrier.includes(tool))]);
}

/**
 * The tools system/init MUST report: every tool the explicit allow list names. A requested tool
 * that is missing (the CLI dropped it, or renamed it) is a violation too -- "actual = carrier +
 * requested" (spec §9.1), not "actual within" -- because a deep-read that silently ran without
 * WebFetch would publish a confident article built on nothing. The carrier stays permitted-only, as
 * it always was: the zero-tool check never required it, and this does not start to.
 */
export function requiredInitTools(config: Pick<ClaudeSessionConfig, 'policy'>): readonly string[] {
  return Object.freeze([...(config.policy.toolPolicy?.allow ?? [])]);
}

/**
 * Why this system/init breaks the explicit allow list, or `null` when it does not. A missing
 * fingerprint (no `tools` array) is a violation: an allow list that cannot be verified must not be
 * treated as honoured.
 */
export function initToolViolation(init: InitFingerprint | undefined, permitted: readonly string[], required: readonly string[] = []): string | null {
  if (init === undefined) {
    return required.length === 0
      ? 'system/init reported no tools list, so the explicit empty allow list cannot be verified'
      : 'system/init reported no tools list, so the explicit allow list cannot be verified';
  }
  const extra = init.tools.filter((tool) => !permitted.includes(tool));
  if (extra.length > 0) {
    return `system/init reported ${JSON.stringify(extra)} beyond the permitted ${JSON.stringify([...permitted])}`;
  }
  const missing = required.filter((tool) => !init.tools.includes(tool));
  if (missing.length > 0) {
    return `system/init did not report ${JSON.stringify(missing)}, which the allow list requested`;
  }
  return null;
}
