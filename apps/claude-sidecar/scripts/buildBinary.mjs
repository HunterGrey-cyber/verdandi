// Builds the shipped artifact: one self-contained executable, no Node on the host, no npm on a
// user's machine. `npm run build:binary -w @verdandi/claude-sidecar`.
//
// WHY A SINGLE EXECUTABLE. The consumer (Neovibe) ships as a distro package of statically linked
// binaries with no Node runtime dependency at all, and a packaged install cannot reach a source
// checkout. Of the four distribution shapes weighed (npm bin, JS bundle, SEA, distro package), this is the only one that costs the
// consumer nothing: the output drops into /usr/lib/<consumer>/ beside its other binaries.
//
// WHY NODE SEA AND NOT `bun build --compile`. Measured 2026-09-18: a bun-compiled build compiles and
// then throws `node:http2 createServer is not yet implemented in Bun` from grpc-js's server bind
// path. This process IS a gRPC server, so that is not a corner case. Node SEA also keeps the exact
// runtime every real-CLI certification ran on, embedded, rather than handing that choice to a distro.
//
// WHY THE BUILD FETCHES ITS OWN NODE. Two reasons, and the first is not a preference:
//
//   1. A distro Node cannot serve as the base. Arch's /usr/bin/node + postject produces a binary
//      that segfaults immediately (exit 139). Control: a hello-world SEA built the same way
//      segfaults identically, so it is the base binary, not the payload. The official nodejs.org
//      tarball of the IDENTICAL version works first try.
//   2. Pinning version + checksum is what makes "the exact runtime every certification ran on" true
//      across rebuilds, and what lets anyone answer, for an artifact already in a mirror, which Node
//      is inside it. The artifact answers that itself through `--version`; this is the other half.
//
// The three source-level things a bundle needs are NOT here, because hiding them in a release script
// would mean the shipped artifact runs code the test suite never does. They are in the source:
// build-time version constants (scripts/generateSdkVersions.mjs), an async main() instead of a
// top-level await (src/index.ts), and refusing sdk_bundled (src/runtimeServiceImpl.ts). The only
// bundle-only concession is the --define below.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..');
const repoRoot = join(workspaceRoot, '..', '..');

/**
 * The Node the artifact carries. Bumping this is a deliberate act with a consequence: the shipped
 * runtime changes, and every certification recorded against the old one is about a different
 * program. Update the checksums from https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt in the same
 * edit -- a version without its checksum is a pin that does not pin anything.
 */
const NODE_VERSION = 'v22.23.2';
const NODE_TARBALL_SHA256 = {
  'linux-x64': 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307',
  'linux-arm64': 'fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8',
};

/** postject's own sentinel, fixed by Node's SEA format. Not a value to invent. */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const platform = `${process.platform}-${process.arch}`;
const expectedSha = NODE_TARBALL_SHA256[platform];
if (expectedSha === undefined) {
  throw new Error(`buildBinary: no pinned Node tarball for ${platform} -- add its checksum from https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt rather than building against an unpinned runtime`);
}

const buildDir = join(workspaceRoot, 'build');
const outDir = join(workspaceRoot, 'dist-bin');
const cacheDir = join(buildDir, 'node-cache');
for (const dir of [buildDir, outDir, cacheDir]) {
  mkdirSync(dir, { recursive: true });
}

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...options });
const step = (message) => console.error(`[build-binary] ${message}`);

// 1. Compile TypeScript -- BOTH workspaces, via the root fan-out, regenerating the build-time
//    version constants on the way.
//
//    `npm run build -w @verdandi/claude-sidecar` is NOT enough and this used to use it. The SEA
//    bundles packages/claude-runtime, a sidecar build consumes that package's DIST rather than its
//    src, and nothing in the sidecar workspace rebuilds it -- the trap the root package.json's own
//    `//test` note is written about, one level up. The consequence here is a release binary quietly
//    assembled around a stale runtime, which is exactly what happened downstream on 2026-09-18: a
//    conformance run failed against the artifact and passed against a checkout, looking precisely
//    like a packaging defect, because the artifact predated a fix in the runtime package.
step('building TypeScript (both workspaces)');
run('npm', ['run', 'build:claude']);

const { version: sidecarVersion } = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'));

// 1b. The build stamp: a hash of the compiled sources this artifact actually bundles, both
//     workspaces. It answers "which build is this?" for a binary already vendored into someone
//     else's package, where the alternative is diffing behaviour against another copy. Hashing the
//     emitted JS rather than git state is deliberate -- a revision says nothing about whether the
//     dist beside it was rebuilt, which is the failure this exists for, and a dirty tree makes a
//     revision lie.
function hashCompiledSources() {
  const hash = createHash('sha256');
  const roots = [join(workspaceRoot, 'dist', 'src'), join(repoRoot, 'packages', 'claude-runtime', 'dist', 'src')];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith('.js')) {
        // Path and content both: a file moved without being edited is a different build.
        hash.update(rel).update('\0').update(readFileSync(full)).update('\0');
      }
    }
  };
  for (const root of roots) {
    walk(root, root === roots[0] ? 'sidecar' : 'runtime');
  }
  return hash.digest('hex').slice(0, 16);
}
const buildStamp = hashCompiledSources();
step(`build stamp ${buildStamp}`);

// 2. Bundle to CommonJS. Node's SEA format takes a CommonJS main, which is also why src/index.ts
//    wraps its startup in an async main() -- esbuild refuses top-level await under --format=cjs.
//
//    The --define is the one bundle-only concession. The agent SDK's own sdk.mjs calls
//    createRequire(import.meta.url) at top level, and import.meta is empty in CommonJS output, so
//    without this the binary dies at module load with ERR_INVALID_ARG_VALUE. Giving it the
//    artifact's own path is safe precisely because this build serves host_cli only: the sidecar
//    always passes pathToClaudeCodeExecutable, and the SDK's resolver is inside the branch that
//    takes when it is unset.
// WHAT ENDS UP INSIDE, AND WHY THAT IS A DISTRIBUTION QUESTION RATHER THAN A BUILD ONE. There is no
// `--external:` here, so `@anthropic-ai/claude-agent-sdk`'s `sdk.mjs` is bundled into the artifact
// in full. That package's LICENSE.md reads "© Anthropic PBC. All rights reserved" and points at
// Anthropic's legal terms -- it is not an open-source licence. Verified 2026-09-19: the SDK's own
// "Native CLI binary for" string is present in the emitted bundle.
//
// This constrains PUBLISHING a prebuilt binary, not building one. Building here, and handing the
// result to another of the same owner's projects, is not third-party redistribution.
//
// What is NOT inside, and must stay that way: the Claude Code CLI itself. Anthropic's terms require
// that the binary not be modified and that Claude Code be installed and run as published. A packaged
// build serves `host_cli` only and refuses `sdk_bundled` (see sdkBundledAvailable in
// runtimeServiceImpl.ts), so the user runs the CLI they installed, unmodified, and the SDK's 205 MB
// native package is never vendored. That decision was taken for artifact size; it also happens to be
// the load-bearing one here, which is the reason not to "helpfully" vendor the CLI back in later.
//
// Publishing this artifact anywhere public is the owner's call, not a build-time one. The options
// were worked out when the SEA build was introduced.
step('bundling to CommonJS');
const bundlePath = join(buildDir, 'sidecar.cjs');
run('npx', [
  'esbuild',
  join(workspaceRoot, 'dist', 'src', 'index.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--define:import.meta.url="file:///verdandi-claude-sidecar"`,
  `--define:__VERDANDI_BUILD_STAMP__="${buildStamp}"`,
  `--outfile=${bundlePath}`,
]);

// 3. Node's SEA preparation blob.
step('preparing the SEA blob');
const seaConfigPath = join(buildDir, 'sea-config.json');
const blobPath = join(buildDir, 'sea-prep.blob');
writeFileSync(seaConfigPath, JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// 4. The base Node: pinned, checksum-verified, cached.
const tarballName = `node-${NODE_VERSION}-${platform}.tar.xz`;
const tarballPath = join(cacheDir, tarballName);
if (!existsSync(tarballPath)) {
  step(`downloading ${tarballName}`);
  run('curl', ['-fsSL', '-o', tarballPath, `https://nodejs.org/dist/${NODE_VERSION}/${tarballName}`]);
}
const actualSha = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
if (actualSha !== expectedSha) {
  rmSync(tarballPath, { force: true });
  throw new Error(`buildBinary: ${tarballName} sha256 ${actualSha} does not match the pinned ${expectedSha} -- refusing to build an artifact around an unverified runtime (the cached copy has been removed)`);
}
step(`verified ${tarballName} against its pinned checksum`);

const extractedNode = join(cacheDir, `node-${NODE_VERSION}-${platform}`, 'bin', 'node');
if (!existsSync(extractedNode)) {
  run('tar', ['xf', tarballPath, '-C', cacheDir]);
}

// 5. Inject. Strip first, not after: stripping a binary that already carries the blob risks removing
//    the section it was injected into.
step('injecting the blob');
const outPath = join(outDir, `verdandi-claude-sidecar-${sidecarVersion}-${platform}`);
copyFileSync(extractedNode, outPath);
chmodSync(outPath, 0o755);
try {
  run('strip', [outPath]);
} catch {
  step('strip unavailable -- shipping an unstripped binary (larger, otherwise identical)');
}
run('npx', ['postject', outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE]);

// 6. Smoke test. A build that produces an unrunnable binary and reports success is the failure this
//    whole exercise is about: the bundle BUILDS clean and dies on first run. Both checks run against
//    the artifact itself, and neither spawns a Claude CLI or costs a turn.
step('smoke-testing the artifact');
const report = execFileSync(outPath, ['--version'], { encoding: 'utf8' });
if (!report.includes(`verdandi-claude-sidecar ${sidecarVersion}`) || !report.includes(NODE_VERSION)) {
  throw new Error(`buildBinary: the artifact's own --version does not report this build:\n${report}`);
}
// A released artifact that says "build dev" cannot be told apart from any other, which defeats the
// whole point of the stamp -- so a --define that silently failed to land must fail the build.
if (!report.includes(`build ${buildStamp}`)) {
  throw new Error(`buildBinary: the artifact does not carry build stamp ${buildStamp} -- the --define did not reach buildStamp.ts:\n${report}`);
}
if (!/executable sources served: host_cli\s*$/m.test(report)) {
  throw new Error(`buildBinary: a packaged artifact must serve host_cli only, but it reports:\n${report}`);
}
// The startup-refusal path, which is what proves the async main()'s catch survived bundling: an
// unhandled rejection used to be what turned a refusal into a nonzero exit with the reason on
// stderr, and a host waiting on the socket has nothing else to read.
const noSocketEnv = { ...process.env };
delete noSocketEnv.VERDANDI_CLAUDE_SIDECAR_SOCKET;
const refusal = spawnSync(outPath, [], { encoding: 'utf8', env: noSocketEnv });
if (refusal.status !== 1 || !refusal.stderr.includes('VERDANDI_CLAUDE_SIDECAR_SOCKET must be set')) {
  throw new Error(`buildBinary: the artifact does not refuse a missing socket path correctly -- exit ${refusal.status}, stderr:\n${refusal.stderr}`);
}

console.error(`\n${report}`);
console.error(`[build-binary] ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MiB)`);
