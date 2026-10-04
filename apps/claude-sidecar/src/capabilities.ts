import { CAPABILITY_TABLE, type CapabilityCondition } from './generated/protocolConstants.js';

/**
 * What decides whether a conditional capability is advertised. Both are facts of THIS process or
 * build, never configuration a client can ask for: a claim without the fact behind it is the failure
 * the capability list exists to prevent.
 *
 * - `egressRestricted`: startup proved this process cannot reach loopback (egress.ts), so
 *   `egress_restricted` may be claimed.
 * - `sdkBundledAvailable`: this build can spawn the CLI inside the agent SDK's npm package, which a
 *   packaged single-file build cannot, so `executable_sdk_bundled` may be claimed.
 */
export type CapabilityFacts = {
  egressRestricted: boolean;
  sdkBundledAvailable: boolean;
};

const CONDITION_OF: Record<CapabilityCondition, (facts: CapabilityFacts) => boolean> = {
  egress_restricted: (facts) => facts.egressRestricted,
  sdk_bundled: (facts) => facts.sdkBundledAvailable,
};

/**
 * The handshake's `capabilities`, in the order crates/claude-runtime-protocol/capabilities.json lists
 * them. That order is part of the contract: the `executable_*` pair stays last, so a packaged build's
 * list is a checkout's minus its final entry, and a client that compares against a frozen list finds
 * its entries in the order it saw them.
 *
 * The file is the one source for which strings exist and what introduced them (COMPATIBILITY.md beside
 * it). Adding a capability means adding a row there, in the same change that wires it through --
 * advertising before implementing is what this list must never do.
 */
export function handshakeCapabilities(facts: CapabilityFacts): string[] {
  return CAPABILITY_TABLE.filter((entry) => entry.when === undefined || CONDITION_OF[entry.when](facts)).map((entry) => entry.name);
}
