# Build interface

What a host, installer or packager may rely on when it builds this sidecar or reads its build outputs.
Everything on this page is a stable surface: **a change to any of it is a minor-or-major event** for the
sidecar (and is announced in `crates/claude-runtime-protocol/COMPATIBILITY.md`'s terms if it touches the
protocol), never a quiet edit. Anything not on this page (the intermediate `build/` directory, the order of
build steps, the esbuild flags, the helper scripts under `scripts/`) may change at any time.

`tests/compat/buildInterface.test.ts` holds the names; `tests/nodePin.test.ts` and
`tests/buildManifest.test.ts` hold the pin and the manifest.

## The three scripts

Run from the repository root.

| Command | What it does | Output |
|---|---|---|
| `npm run build` | Compiles everything the root builds, including this sidecar and the runtime package it embeds. | `apps/claude-sidecar/dist/src/index.js` |
| `npm run build:claude` | The runtime package, then this sidecar (and nothing else). | `apps/claude-sidecar/dist/src/index.js` |
| `npm run build:binary -w @verdandi/claude-sidecar` | Rebuilds both of the above, then packs one self-contained executable (a Node SEA). Downloads the pinned Node the first time. Linux x64 and arm64 only. | `apps/claude-sidecar/dist-bin/` |

The names of these three scripts do not change.

## The two output paths

- **Run from a checkout:** `apps/claude-sidecar/dist/src/index.js`, started with `node`. It is also the
  `main` of the package.
- **Packaged:** `apps/claude-sidecar/dist-bin/verdandi-claude-sidecar-<version>-<platform>-<arch>`, where
  `<version>` is the sidecar's `package.json` version, `<platform>` is `process.platform` and `<arch>` is
  `process.arch` of the machine that built it (today `linux-x64` or `linux-arm64`). The pattern does not
  change; a glob on `verdandi-claude-sidecar-*` finds artifacts and never finds `manifest.json`.

A packaged build serves `executable: host_cli` only. It needs no Node and no `npm` on the machine that runs it.

## `dist-bin/manifest.json`

Written by `build:binary` after the artifact has passed its own smoke tests, and read back against the file
before the build is allowed to succeed. It describes the artifact built **last**; older files left in
`dist-bin/` are not described. Every run deletes the previous `manifest.json` first, so one that is present
comes from a build that finished: a failed rebuild leaves none, never the last good one beside a different file.

```json
{
  "v": 1,
  "artifact": {
    "file": "verdandi-claude-sidecar-0.2.0-linux-x64",
    "platform": "linux",
    "arch": "x64",
    "sidecar_version": "0.2.0",
    "sha256": "<hex>",
    "size_bytes": 110299968
  },
  "node": { "version": "v22.23.2", "tarball_sha256": "<hex>" },
  "build_stamp": "<16 hex digits>",
  "bundled_packages": [{ "name": "@grpc/grpc-js", "version": "1.14.4", "license": "Apache-2.0" }]
}
```

- `artifact.sha256` is the SHA-256 of the file named by `artifact.file`, in the same directory.
- `node.version` and `node.tarball_sha256` are the pinned Node the executable was built around (below).
- `build_stamp` is the value the artifact itself prints in `--version`.
- `bundled_packages` lists the third-party npm packages in the bundle with the licence each declares in its own
  `package.json` (`null` when it declares none; the legacy `licenses` array is joined with ` OR `). It is a pointer for whoever collects licence texts, not the
  texts. This repository's own workspaces are not listed.

New keys may be added in a minor release; existing keys keep their meaning, and `v` changes only for a
breaking change to this file.

## `node-pin.json`

`apps/claude-sidecar/node-pin.json` holds the Node version the packaged build carries and the SHA-256 of the
official tarball for each supported platform. It is the single source: `build:binary` reads it and nothing
else holds a copy. The build refuses to proceed (before compiling anything) if the downloaded or cached
tarball does not match, and removes a mismatching cached copy. Bumping the pin changes the runtime that ships,
so it is a deliberate edit that takes the new checksums from the Node release's `SHASUMS256.txt`.

## `--version` and `--version --json`

`--version` needs no socket, no account and no `claude` CLI, and works on an artifact nobody has configured.

- Text (unchanged): four lines. Line 1 is
  `verdandi-claude-sidecar <version> (protocol <major>, node <vX.Y.Z>, build <stamp|dev>)` and line 4 is
  `executable sources served: host_cli` for a packaged build (`host_cli, sdk_bundled` from a checkout). An
  installer may compare these lines.
- `--version --json` (additive): the same facts as one JSON line, plus the rest of what is statically known:

| Field | Meaning |
|---|---|
| `v` | Schema version of this report (`1`). |
| `sidecar_version` | The sidecar's version. |
| `protocol` | `{ "major", "minor" }`, from `crates/claude-runtime-protocol/capabilities.json`. |
| `node` | The Node runtime executing (for a packaged build, the one inside it). |
| `build_stamp` | Hash of the compiled sources bundled, or `dev` outside a release build. |
| `sdk_version`, `sdk_bundled_cli` | The agent SDK version and the Claude Code version that SDK declares. |
| `supported_cli_range` | `{ "min", "max_exclusive" }` for the host `claude` CLI. |
| `tested_cli_versions` | CLI versions a real-CLI run has exercised, in numeric version order. |
| `executables` | The executable sources this build serves. |
| `capabilities` | The handshake capability list for this build, in wire order, from the same source. `egress_restricted` is never listed here: it is proven by a running process, not by a build. |

The text and the JSON are produced from one set of facts, and a test compares them field by field.
