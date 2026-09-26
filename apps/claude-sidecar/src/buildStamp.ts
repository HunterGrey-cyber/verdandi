/**
 * Identifies which build an artifact is, without running it and comparing behaviour.
 *
 * A built artifact goes stale against a workspace dependency silently: the SEA bundles
 * `packages/claude-runtime`, and nothing about a binary says which revision of it went in. Measured
 * downstream 2026-09-18 -- a conformance run failed against the artifact and passed against a
 * checkout, which looks exactly like a packaging defect and was neither packaging nor the test: the
 * artifact simply predated a fix in the runtime package.
 *
 * The build script closes the hole (it rebuilds the whole claude fan-out, so a release cannot be
 * assembled from a stale dist). This closes the other half, for a binary already vendored into
 * someone else's package: `--version` names the build.
 *
 * The value is a hash of the compiled sources actually bundled -- both workspaces' `dist/src` --
 * injected by an esbuild `--define` at release time. `typeof` on an undeclared identifier is legal
 * and does not throw, so an unbundled checkout takes the other branch and says so. A checkout has no
 * honest value here, and a fabricated one would be worse than none: this is the field people will
 * compare.
 */
declare const __VERDANDI_BUILD_STAMP__: string;

export const BUILD_STAMP: string =
  typeof __VERDANDI_BUILD_STAMP__ === 'string' && __VERDANDI_BUILD_STAMP__ !== '' ? __VERDANDI_BUILD_STAMP__ : 'dev';
