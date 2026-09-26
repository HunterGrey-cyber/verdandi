import { STRUCTURED_OUTPUT_CARRIER_TOOLS } from '../../src/toolInvariant.js';
import { WEBFETCH_PRIVATE_DENY } from '../../src/webFetchDeny.js';
import { WEB_TOOLS } from './cases.js';
import { resultShapeReasons, turnOutcome } from './analyze.js';
import type { CaseRecord } from './runner.js';
import { bool, isObj, num, str, strings, type Json } from './json.js';

/**
 * The analysis behind the two web cases (muninn client spec §9.1 「M1 式探针新增用例」). Every
 * verdict here comes from what the CLI and the tools reported -- system/init, tool_use and
 * tool_result blocks, the result's permission_denials and modelUsage -- never from the model's own
 * account of what happened: the model's output is untrusted, the tool results are measurements.
 */

/** One WebFetch call and what came back for it. */
export type WebFetchAttempt = {
  toolUseId: string;
  url: string;
  /** `content`: a tool_result that is not an error. `error`: an error tool_result. `missing`: no
   * tool_result arrived for it (the turn ended first), which proves nothing either way. */
  result: 'content' | 'error' | 'missing';
  /** Listed in the result message's permission_denials: a deny rule refused it. */
  deniedByRule: boolean;
};

/** How one LAN URL of the `web-lan` case ended. `rule`: every WebFetch call on it failed AND is
 * listed in permission_denials, i.e. a deny rule refused it before any packet was sent. `error`:
 * it failed, but not by a rule (the network, TLS, anything). `not_blocked`: content came back.
 * `not_attempted`: no call on it produced a tool_result. */
export type LanOutcome = { url: string; blocked_by: 'rule' | 'error' | 'not_blocked' | 'not_attempted' };

/** What the web cases measured, for report.json, the appendix and the baseline. */
export type WebAnswers = {
  /** system/init tools of the `web-tools` case, as reported; null when that case did not run. */
  init_tools: string[] | null;
  /** modelUsage keys naming a Haiku model that used tokens in the `web-tools` case. */
  haiku_models: string[];
  /** A WebFetch call of the `web-tools` case returned content. */
  fetched_public: boolean;
  lan: LanOutcome[];
};

function contentBlocks(m: Json): unknown[] {
  const inner = isObj(m.message) ? m.message.content : undefined;
  return Array.isArray(inner) ? inner : [];
}

/** Every WebFetch tool_use in `messages`, paired with its tool_result and the result's denials. */
export function webFetchAttempts(messages: readonly unknown[], result: Json | null): WebFetchAttempt[] {
  const denied = new Set<string>();
  if (result !== null && Array.isArray(result.permission_denials)) {
    for (const d of result.permission_denials) {
      if (isObj(d) && d.tool_name === 'WebFetch') {
        const id = str(d.tool_use_id);
        if (id !== null) {
          denied.add(id);
        }
      }
    }
  }
  const attempts: WebFetchAttempt[] = [];
  const byId = new Map<string, WebFetchAttempt>();
  for (const m of messages) {
    if (!isObj(m)) {
      continue;
    }
    if (m.type === 'assistant') {
      for (const b of contentBlocks(m)) {
        if (isObj(b) && b.type === 'tool_use' && b.name === 'WebFetch') {
          const id = str(b.id) ?? '';
          const attempt: WebFetchAttempt = { toolUseId: id, url: isObj(b.input) ? (str(b.input.url) ?? '') : '', result: 'missing', deniedByRule: denied.has(id) };
          attempts.push(attempt);
          byId.set(id, attempt);
        }
      }
    } else if (m.type === 'user') {
      for (const b of contentBlocks(m)) {
        if (isObj(b) && b.type === 'tool_result') {
          const attempt = byId.get(str(b.tool_use_id) ?? '');
          if (attempt !== undefined) {
            attempt.result = bool(b.is_error) === true ? 'error' : 'content';
          }
        }
      }
    }
  }
  return attempts;
}

/** modelUsage keys that name a Haiku model and used any tokens, sorted. WebFetch's own
 * summarising call is the only Haiku use a web-tools turn has. */
export function haikuModels(result: Json | null): string[] {
  if (result === null || !isObj(result.modelUsage)) {
    return [];
  }
  return Object.entries(result.modelUsage)
    .filter(([model, v]) => {
      if (!/haiku/i.test(model) || !isObj(v)) {
        return false;
      }
      const tokens = (num(v.inputTokens) ?? 0) + (num(v.outputTokens) ?? 0) + (num(v.cacheReadInputTokens) ?? 0) + (num(v.cacheCreationInputTokens) ?? 0);
      return tokens > 0;
    })
    .map(([model]) => model)
    .sort();
}

/** Same resource: compared after URL normalisation (a model that adds a trailing slash still
 * fetched the URL it was given). Unparseable strings compare as they are. */
export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** The init tools a web session must report: the carrier plus the two web tools, sorted. */
export function expectedWebInitTools(): string[] {
  return [...new Set([...STRUCTURED_OUTPUT_CARRIER_TOOLS, ...WEB_TOOLS])].sort();
}

function missingDenyRules(record: CaseRecord): string[] {
  const summary = record.options_summary;
  const disallowed = isObj(summary) ? strings(summary.disallowedTools) : [];
  return WEBFETCH_PRIVATE_DENY.filter((rule) => !disallowed.includes(rule));
}

/** options.disallowedTools missing a WebFetch deny rule, or a permission prompt reaching a
 * bypass-permissions session -- either means the kernel did not enforce this policy. Shared by
 * both web cases: `web-tools` proves the rules are set even though its own fetch is allowed,
 * `web-lan` proves they fire. Empty = as expected. */
function webPolicyReasons(record: CaseRecord): string[] {
  const reasons: string[] = [];
  const missing = missingDenyRules(record);
  if (missing.length > 0) {
    reasons.push(`options.disallowedTools lacks ${JSON.stringify(missing)}: the kernel did not apply the WebFetch deny rules`);
  }
  if (record.permission_requests.length > 0) {
    reasons.push(`${record.permission_requests.length} permission requests under bypass`);
  }
  return reasons;
}

/** Why a `web-tools` record is not what a working tool-bearing completion looks like. Empty = as expected. */
export function webToolsReasons(record: CaseRecord, messages: readonly unknown[], init: Json | null, result: Json | null): string[] {
  const reasons: string[] = [...resultShapeReasons(record, result)];
  if (result !== null) {
    const out = result.structured_output;
    if (!isObj(out) || typeof out.title !== 'string' || out.title.trim() === '') {
      reasons.push('structured_output has no non-empty title');
    }
  }
  const want = expectedWebInitTools();
  if (init === null) {
    reasons.push('no system/init message');
  } else {
    if (init.permissionMode !== 'bypassPermissions') {
      reasons.push(`init.permissionMode is ${JSON.stringify(init.permissionMode)}, expected "bypassPermissions"`);
    }
    const got = [...strings(init.tools)].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      reasons.push(`init.tools is ${JSON.stringify(got)}, expected exactly ${JSON.stringify(want)}`);
    }
  }
  if (!webFetchAttempts(messages, result).some((a) => a.result === 'content')) {
    reasons.push(`no WebFetch call returned content: the public fetch of this case did not happen`);
  }
  if (haikuModels(result).length === 0) {
    reasons.push("modelUsage has no Haiku model with tokens: WebFetch's own model call is not visible in this session's usage, so nothing shows it was billed to the proven account");
  }
  reasons.push(...webPolicyReasons(record));
  const outcome = turnOutcome(record);
  if (outcome !== 'completed') {
    reasons.push(`kernel turn_completed outcome is ${JSON.stringify(outcome)}`);
  }
  return reasons;
}

/**
 * The WEBFETCH_PRIVATE_DENY rule that covers `url`'s host, or null. Matching follows what
 * webFetchDeny.ts documents for Claude Code's `WebFetch(domain:...)`: case-insensitive against
 * the hostname; a leading `*.` stands for one or more labels in front of the rest (so it does not
 * cover the bare domain, which is why the list names `owner.example` separately); any other `*`
 * stands for exactly one label.
 *
 * A mistake here fails in the safe direction. Claiming that a rule covers a URL the CLI does not
 * deny makes `web-lan` red, never green. The opposite mistake could only hide a dead rule for a
 * URL outside this list's plain shapes (an IPv6 literal, say), and those are the network's job anyway.
 */
export function coveringDenyRule(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  const same = (pattern: readonly string[], got: readonly string[]): boolean =>
    pattern.length === got.length && pattern.every((p, i) => p === '*' || p === got[i]);
  for (const rule of WEBFETCH_PRIVATE_DENY) {
    const domain = /^WebFetch\(domain:(.+)\)$/.exec(rule)?.[1];
    if (domain === undefined) {
      continue;
    }
    const pattern = domain.toLowerCase().split('.');
    const covered =
      pattern[0] === '*' && pattern.length > 1
        ? labels.length > pattern.length - 1 && same(pattern.slice(1), labels.slice(labels.length - (pattern.length - 1)))
        : same(pattern, labels);
    if (covered) {
      return rule;
    }
  }
  return null;
}

/** How every LAN URL ended, from the tool results alone. */
export function lanOutcomes(lanUrls: readonly string[], messages: readonly unknown[], result: Json | null): LanOutcome[] {
  const attempts = webFetchAttempts(messages, result);
  return lanUrls.map((url): LanOutcome => {
    const mine = attempts.filter((a) => sameUrl(a.url, url));
    if (mine.some((a) => a.result === 'content')) {
      return { url, blocked_by: 'not_blocked' };
    }
    const answered = mine.filter((a) => a.result === 'error');
    if (answered.length === 0) {
      return { url, blocked_by: 'not_attempted' };
    }
    return { url, blocked_by: answered.every((a) => a.deniedByRule) ? 'rule' : 'error' };
  });
}

/**
 * Why a `web-lan` record does not show every private URL failing, each for the right reason. Empty
 * = as expected.
 *
 * A URL a WebFetch deny rule covers must end as `rule`. An `error` there does not count as blocked:
 * the rule is checked before any packet goes out, so on a working kernel nothing else gets the
 * chance to fail that fetch. An error means the rule did not fire, or the CLI stopped reporting it
 * in permission_denials, and the URL failed for some other reason. That reason can be TLS against a
 * plain-HTTP port, which fails with no protection at all. Only a URL no rule covers may end as
 * `error`: for that URL the network layer is all there is. A list with no rule-covered URL at all
 * cannot show the rules work, and the rules are required as defence in depth (muninn client spec
 * §9.1 「纵深防御」).
 */
export function lanBlockedReasons(lanUrls: readonly string[], record: CaseRecord, messages: readonly unknown[], result: Json | null): string[] {
  const reasons: string[] = [];
  if (lanUrls.length === 0) {
    reasons.push('no LAN URLs were given (--lan-urls), so this run measured nothing');
  } else if (lanUrls.every((url) => coveringDenyRule(url) === null)) {
    reasons.push('no --lan-urls URL is covered by a WebFetch deny rule, so this run cannot show that the rules fire');
  }
  if (result === null) {
    reasons.push('no result message: the turn did not finish, so the fetch outcomes are incomplete');
  }
  for (const outcome of lanOutcomes(lanUrls, messages, result)) {
    const rule = coveringDenyRule(outcome.url);
    if (outcome.blocked_by === 'not_blocked') {
      reasons.push(`${outcome.url}: WebFetch returned content -- ${rule === null ? 'a private address was reachable' : `${rule} did not stop it and neither did the network`}`);
    } else if (outcome.blocked_by === 'not_attempted') {
      reasons.push(`${outcome.url}: never fetched (or its tool result is missing), so this run says nothing about it`);
    } else if (outcome.blocked_by === 'error' && rule !== null) {
      reasons.push(
        `${outcome.url}: failed with an error, not refused by ${rule} -- the WebFetch deny rules did not fire (or this CLI no longer lists them in permission_denials), so this fetch failed for another reason and does not show the rule works`,
      );
    }
  }
  reasons.push(...webPolicyReasons(record));
  return reasons;
}
