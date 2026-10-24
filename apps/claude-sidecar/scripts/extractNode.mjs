// Unpacks the base Node from the tarball buildBinary.mjs has just checked against the pin, and returns
// the path of its `bin/node`. Always from the tarball, always into a directory removed first: an
// extraction left by an earlier run was never checked against anything, and copying it into the
// artifact would put unverified bytes under a manifest that claims the pinned tarball's provenance.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** `tarballPath` must already be verified; the tarball unpacks to `node-<version>-<platform>/` inside `cacheDir`. */
export function extractVerifiedNode({ tarballPath, cacheDir, version, platform }) {
  const extractedDir = join(cacheDir, `node-${version}-${platform}`);
  rmSync(extractedDir, { recursive: true, force: true });
  execFileSync('tar', ['xf', tarballPath, '-C', cacheDir], { stdio: 'inherit' });
  return join(extractedDir, 'bin', 'node');
}
