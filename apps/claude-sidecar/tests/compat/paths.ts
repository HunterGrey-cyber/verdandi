import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Where things are, from a compiled test (`dist/tests/compat/*.js`) back to the source tree. The
 * frozen proto, the golden bytes and the Rust client are source files that `tsc` does not copy, and
 * the live proto sits outside this package; every compat test finds them through here.
 */
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** apps/claude-sidecar */
export const SIDECAR_DIR = here('../../../');
/** apps/claude-sidecar/tests/compat (the SOURCE directory, not dist) */
export const COMPAT_DIR = join(SIDECAR_DIR, 'tests', 'compat');
/** The repository (or the public export's) root. */
export const REPO_ROOT = here('../../../../../');

export const FROZEN_DIR = join(COMPAT_DIR, 'b3aa188');
export const FROZEN_PROTO = join(FROZEN_DIR, 'runtime.proto');
export const GOLDEN_REQUESTS = join(FROZEN_DIR, 'eitri-0.2.0-requests.txt');
export const COMPLETION_GOLDEN_REQUESTS = join(FROZEN_DIR, 'completion-client-requests.txt');
export const FROZEN_GENERATED = join(FROZEN_DIR, 'generated', 'runtime.ts');
export const RUST_CLIENT_DIR = join(COMPAT_DIR, 'rust-client');

/** The live proto: what every later step edits. */
export const CURRENT_PROTO = join(REPO_ROOT, 'proto', 'verdandi', 'claude', 'runtime', 'v1', 'runtime.proto');

/** The compiled sidecar entry point, for the tests that start the real process. */
export const SIDECAR_ENTRY = here('../../src/index.js');
