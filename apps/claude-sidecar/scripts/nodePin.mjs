// Reads node-pin.json, the one place that says which Node the packaged artifact carries and which
// tarball checksum proves it. scripts/buildBinary.mjs reads it; nothing else may hold a copy.
//
// Refused, not interpreted, when malformed -- a version without a well-formed checksum is a pin that
// does not pin anything, and a build must stop on it rather than fall back to something looser.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** @returns {{ version: string, tarballSha256: Record<string, string> }} */
export function loadNodePin(workspaceRoot) {
  const path = join(workspaceRoot, 'node-pin.json');
  const fail = (message) => {
    throw new Error(`node-pin: ${path}: ${message}`);
  };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read or parse it: ${error.message}`);
  }
  if (typeof doc?.version !== 'string' || !VERSION.test(doc.version)) {
    fail(`version must look like v22.23.2, got ${JSON.stringify(doc?.version)}`);
  }
  const sums = doc.tarball_sha256;
  if (typeof sums !== 'object' || sums === null || Array.isArray(sums) || Object.keys(sums).length === 0) {
    fail('tarball_sha256 must map each <platform>-<arch> to a checksum');
  }
  for (const [platform, sha] of Object.entries(sums)) {
    if (typeof sha !== 'string' || !SHA256.test(sha)) {
      fail(`tarball_sha256[${JSON.stringify(platform)}] must be 64 lowercase hex digits, got ${JSON.stringify(sha)}`);
    }
  }
  return { version: doc.version, tarballSha256: sums };
}
