#!/bin/sh
# The old-client compatibility suite, both halves, in one command:
#
#   apps/claude-sidecar/tests/compat/run.sh
#
# What it holds is the set of things Eitri 0.2.0 (built against Verdandi b3aa188's runtime.proto), and
# Verdandi's own completion and pipeline clients at that revision, rely on, so that every later change to the protocol, the handshake or the sidecar's startup has to
# keep them true:
#
#   TypeScript (node --test, dist/tests/compat/):
#     protoBreaking      the live runtime.proto against the frozen b3aa188 copy (no removal, renumbering,
#                        retyping, rename; additions allowed and listed), and the checker against 30 mutations
#     frozenProto        the frozen proto, its generated client and the golden request bytes are what they claim
#     oldClient.conformance   the frozen client replays Eitri's exact requests against the real sidecar (real
#                        kernel, scripted fake SDK): handshake, CreateSession, turn, permission round trip,
#                        interrupt, close, resume, replay, errors
#     oldClient.process  the real entry point: the four stderr texts, --version, bind within 3 s, exit within
#                        6 s of stdin closing, stale socket, environment variables
#     completionClient.conformance   the completion client's and the pipeline client's b3aa188 requests (golden
#                        bytes from their real request construction) replayed against the real sidecar: the
#                        capabilities each requires (egress_restricted only when proven), the zero-tool completion
#                        (SDK options, the first turn held for accountInfo(), SessionReady identity and fingerprint,
#                        TurnCompleted), the web completion (every WebFetch deny rule, the init check both ways),
#                        the pipeline (no bypass floor, no policy notice), and the error codes both clients map
#   Rust (cargo test, rust-client/):
#     the types Eitri links (prost, from the frozen proto): its requests encode to the golden bytes, and an
#     unknown error code / event arm / field decodes the way Eitri depends on
#
# The TypeScript half is also part of `npm test` (the sidecar's own glob picks it up); this script is for
# running just this suite, with the Rust half. Nothing here reaches a model or runs the real `claude`.
#
# Needs: Node and `npm ci` done (the TypeScript half then runs offline); for the Rust half a Rust
# toolchain, `protoc` on PATH (prost-build), and crates.io or a populated cargo cache (`--locked`). The
# Rust half only matters when the frozen proto, the golden request bytes or the Rust client change; for
# any other edit the TypeScript half is the whole suite, and
#   (cd apps/claude-sidecar && node --test 'dist/tests/compat/**/*.test.js')
# after `npm run build:claude` runs it alone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sidecar=$(cd "$here/../.." && pwd)
root=$(cd "$sidecar/../.." && pwd)

# A built runtime package and sidecar: the sidecar's tests consume the runtime's dist, never its src.
(cd "$root" && npm run build:claude)
(cd "$sidecar" && node --test --test-timeout=90000 'dist/tests/compat/**/*.test.js')
cargo test --locked --manifest-path "$here/rust-client/Cargo.toml"
