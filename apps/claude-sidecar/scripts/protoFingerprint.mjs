// Prints the wire fingerprint of the live runtime.proto: a sha256 of what the proto MEANS (packages,
// services, rpcs, messages with their tags, types and labels, enums, reservations), not of its bytes, so
// comments and formatting do not move it. Whoever cuts a release that carries a new protocol minor writes
// it into that minor's entry in crates/claude-runtime-protocol/capabilities.json, next to `"released": "<tag>"`;
// tests/protocolMinorLedger.test.ts then refuses any later wire change under that minor.
//
//   npm run proto:fingerprint -w @verdandi/claude-sidecar
//
// stdout is the fingerprint alone; the rest goes to stderr. It uses the compiled test helpers
// (dist/tests/compat), which the npm script builds first.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compat = join(here, '..', 'dist', 'tests', 'compat');
if (!existsSync(join(compat, 'protoModel.js'))) {
  console.error('protoFingerprint: dist/tests/compat is not built; run `npm run build -w @verdandi/claude-sidecar` (or `npm run proto:fingerprint`, which does)');
  process.exit(1);
}
const { compileProto, fingerprint, modelOf } = await import(join(compat, 'protoModel.js'));
const { CURRENT_PROTO, REPO_ROOT } = await import(join(compat, 'paths.js'));

const sourcePath = join(REPO_ROOT, 'crates', 'claude-runtime-protocol', 'capabilities.json');
let minor;
try {
  minor = JSON.parse(readFileSync(sourcePath, 'utf8')).protocol.minor;
} catch (error) {
  console.error(`protoFingerprint: cannot read the protocol minor from ${sourcePath}: ${error.message}`);
  process.exit(1);
}
console.error(`runtime.proto fingerprint at protocol.minor ${minor}; write it as wire_fingerprint in that minor's ledger entry, with "released": "<tag>":`);
console.log(fingerprint(modelOf(compileProto(CURRENT_PROTO))));
