// The manifest `build:binary` leaves beside the artifact: dist-bin/manifest.json. It says what the
// file is without running it -- which file, for which platform, which version, which bytes, which Node
// inside, which npm packages bundled -- and `checkManifest` says whether the file beside it is still
// that one. See ../BUILD-INTERFACE.md for what a consumer may rely on.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * @param {{ distBin: string, file: string, platform: string, sidecarVersion: string,
 *           node: { version: string, tarballSha256: string }, buildStamp: string,
 *           packages: Array<{ name: string, version: string, license: string | null }> }} input
 *   `platform` is `<os>-<arch>`, the suffix of the artifact's file name.
 */
export function describeBuild({ distBin, file, platform, sidecarVersion, node, buildStamp, packages }) {
  const path = join(distBin, file);
  const [os, arch] = platform.split('-');
  return {
    v: 1,
    artifact: {
      file,
      platform: os,
      arch,
      sidecar_version: sidecarVersion,
      sha256: sha256Of(path),
      size_bytes: statSync(path).size,
    },
    node: { version: node.version, tarball_sha256: node.tarballSha256 },
    build_stamp: buildStamp,
    bundled_packages: packages,
  };
}

/** Problems found comparing `<distBin>/manifest.json` with the file it describes; empty means they agree. */
export function checkManifest(distBin) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(distBin, 'manifest.json'), 'utf8'));
  } catch (error) {
    return [`cannot read or parse manifest.json: ${error.message}`];
  }
  const { file, platform, arch, sidecar_version: version, sha256, size_bytes: size } = manifest.artifact ?? {};
  if (file !== `verdandi-claude-sidecar-${version}-${platform}-${arch}`) {
    problems.push(`artifact.file ${JSON.stringify(file)} is not verdandi-claude-sidecar-<version>-<platform>-<arch> for its own fields`);
  }
  const path = join(distBin, String(file));
  if (!existsSync(path)) {
    problems.push(`artifact ${file} is missing from ${distBin}`);
    return problems;
  }
  const actualSha = sha256Of(path);
  if (actualSha !== sha256) {
    problems.push(`artifact ${file}: sha256 ${actualSha} does not match the manifest's ${sha256}`);
  }
  if (statSync(path).size !== size) {
    problems.push(`artifact ${file}: size ${statSync(path).size} does not match the manifest's ${size}`);
  }
  return problems;
}

function licenseText(declared) {
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared)) {
    // The legacy `licenses: [{ type, url }]` form: one entry per licence.
    const types = declared.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter((type) => typeof type === 'string');
    return types.length > 0 ? types.join(' OR ') : null;
  }
  return typeof declared?.type === 'string' ? declared.type : null;
}

/**
 * The npm packages that ended up in the bundle, from esbuild's metafile (`--metafile`): every input
 * under a node_modules directory, collapsed to its package. Our own workspaces are not listed -- they
 * are this project's sources, not third-party ones, and esbuild reports them by their real path.
 * `license` is what the package's own package.json declares (null when it declares nothing); it is a
 * pointer for whoever collects licence texts, not the texts.
 */
export function bundledPackages(metafile, repoRoot) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0 || at + 1 >= parts.length) continue;
    const length = parts[at + 1].startsWith('@') ? 2 : 1;
    roots.add(parts.slice(0, at + 1 + length).join(sep));
  }
  const packages = [];
  for (const root of roots) {
    const json = JSON.parse(readFileSync(join(repoRoot, root, 'package.json'), 'utf8'));
    const declared = json.license ?? json.licenses;
    const license = licenseText(declared);
    packages.push({ name: json.name, version: json.version, license });
  }
  return packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
