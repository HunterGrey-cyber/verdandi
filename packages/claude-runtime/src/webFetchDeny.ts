import type { ClaudeHostPolicy } from './types.js';

/**
 * WebFetch deny rules every session gets whose explicit allow list names WebFetch (consumer client
 * spec §9.1: 「WebFetch 的域名拒绝规则作纵深防御」). They are the SECOND line: the first is the
 * network itself -- a tool-bearing completion runs in a sidecar whose cgroup cannot reach RFC1918,
 * loopback, link-local or a proxy's own TUN gateway (a systemd slice with `IPAddressDeny=`,
 * see egress.ts). These rules stop the obvious attempts before a packet is sent, and they are
 * what still holds on a host where that slice is missing.
 *
 * Rule syntax is Claude Code's (`WebFetch(domain:...)`, code.claude.com/docs/en/permissions,
 * wildcards from CLI 2.1.172): matched case-insensitively against the URL's hostname; a leading
 * `*.` matches any subdomain depth; any other `*` matches exactly one dot-separated label, which is
 * what lets `192.168.*.*` cover every IPv4 literal in that range. Deny rules are evaluated before
 * the permission mode, so BYPASS does not skip them.
 *
 * What they cannot cover: an arbitrary public name whose DNS answer is a private address. That is
 * the network layer's job (a fake-ip proxy that does not route into the LAN, for example).
 * The rebinding services listed below are denied anyway, because they are the easy way to try.
 *
 * Frozen for the same reason CONSERVATIVE_BYPASS_DENY is: it is exported, and an array emptied in
 * process would leave sessions unprotected while every reader of the constant believed otherwise.
 */
export const WEBFETCH_PRIVATE_DENY: readonly string[] = Object.freeze([
  'WebFetch(domain:localhost)',
  'WebFetch(domain:*.localhost)',
  'WebFetch(domain:0.0.0.0)',
  'WebFetch(domain:10.*.*.*)',
  'WebFetch(domain:100.*.*.*)',
  'WebFetch(domain:127.*.*.*)',
  'WebFetch(domain:169.254.*.*)',
  'WebFetch(domain:172.*.*.*)',
  'WebFetch(domain:192.168.*.*)',
  'WebFetch(domain:198.18.*.*)',
  'WebFetch(domain:198.19.*.*)',
  'WebFetch(domain:*.lan)',
  'WebFetch(domain:*.local)',
  'WebFetch(domain:*.internal)',
  'WebFetch(domain:*.home.arpa)',
  // `owner.example` stands for the operator's own domain; replace it with yours.
  'WebFetch(domain:owner.example)',
  'WebFetch(domain:*.owner.example)',
  'WebFetch(domain:*.nip.io)',
  'WebFetch(domain:*.sslip.io)',
  'WebFetch(domain:*.localtest.me)',
  'WebFetch(domain:*.traefik.me)',
]);

/**
 * The deny rules `policy` adds to `Options.disallowedTools`: WEBFETCH_PRIVATE_DENY when its explicit
 * allow list names WebFetch, otherwise none. An absent allow list (the investigator's
 * `unrestricted`, Neovibe's sessions) is never touched: those sessions are not tool-bearing
 * completions and keep the network they always had.
 */
export function webFetchDenyFor(policy: Pick<ClaudeHostPolicy, 'toolPolicy'>): readonly string[] {
  return policy.toolPolicy?.allow?.includes('WebFetch') === true ? WEBFETCH_PRIVATE_DENY : [];
}
