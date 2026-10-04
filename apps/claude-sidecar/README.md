# claude-sidecar

A gRPC server (`verdandi.claude.runtime.v1.RuntimeService`, over a unix socket) that runs Claude Code
sessions for a host: sessions, turns, a gapless replayable event stream, and a permission round trip the
host answers. The host decides policy; the sidecar executes and reports. What a host may rely on, version by
version, is in [`crates/claude-runtime-protocol/COMPATIBILITY.md`](../../crates/claude-runtime-protocol/COMPATIBILITY.md);
the numbers and capability strings are in `capabilities.json` beside it.

```sh
npm run build:claude                         # from the repository root: the runtime package, then this one
VERDANDI_CLAUDE_SIDECAR_SOCKET=/run/user/1000/claude-sidecar.sock node apps/claude-sidecar/dist/src/index.js
node apps/claude-sidecar/dist/src/index.js --version     # no socket needed; prints the version and what the build serves
npm run build:binary -w @verdandi/claude-sidecar         # one self-contained executable in dist-bin/
npm test -w @verdandi/claude-sidecar
```

The process exits when its stdin closes (the host went away) unless `VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH`
says otherwise. Startup refusals (no socket variable, an unusable account, a `claude` outside the supported
range) are one line on stderr and exit code 1, before anything is bound.

## Environment variables

Every `VERDANDI_CLAUDE_*` variable this sidecar and the runtime package it embeds read. A value that is set
but invalid refuses to start rather than being corrected silently. (`tests/protocolDocs.test.ts` fails if this
table and the sources disagree about the `VERDANDI_CLAUDE_*` names; the test-only `VERDANDI_REAL_TEST_*`
variables below are not in the table or the check.)

| Variable | Values | Effect |
|---|---|---|
| `VERDANDI_CLAUDE_SIDECAR_SOCKET` | absolute path (required) | Where the socket is bound, mode 0600. A stale socket file is removed. Unset: `VERDANDI_CLAUDE_SIDECAR_SOCKET must be set`, exit 1 |
| `VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH` | `stdin` (default), `none` | `stdin`: end of input on stdin means the host is gone and the sidecar shuts down. `none` is for a service manager (systemd starts a unit with stdin on `/dev/null`); stop the process with SIGTERM |
| `VERDANDI_CLAUDE_SIDECAR_EGRESS` | `open` (default), `restricted` | `restricted` makes startup prove this process cannot reach loopback (and refuses to start if it can), and only then advertises `egress_restricted` |
| `VERDANDI_CLAUDE_SIDECAR_RING_CAPACITY` | positive integer, default 1000 | Events each session keeps for replay. Past it, a reconnect can no longer be repaired by replay and is told so (`EVENT_GAP`) |
| `VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION` | `1` or `true` (any case) | Refuse to start on a `claude` version that is inside the supported range but not in the tested set. Anything else, including empty, is off |
| `VERDANDI_CLAUDE_CLI_PATH` | path to a `claude` executable, default `claude` from `PATH` | The CLI an `executable: host_cli` session runs and the startup version check probes. The only way to pin which CLI is spawned: changing `PATH` does not |
| `VERDANDI_CLAUDE_ACCOUNT` | a name matching `[A-Za-z0-9][A-Za-z0-9._-]*`; `default` is reserved | Pins the local Claude account every session authenticates as: `$HOME/.claude-<name>` and `$HOME/.config/anthropic-<name>`. `default` is the CLI's own location, `$HOME/.claude`. Unset: nothing is pinned. A pinned account that is missing or not logged in refuses to start |
| `VERDANDI_CLAUDE_CONFIG_DIR` | absolute path, or `default` | With an account name, replaces its config directory whole. `default` (or the path `$HOME/.claude`) means the CLI's own location |
| `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` | absolute path | With an account name, replaces its Anthropic config directory. Refused for an account at the CLI's own location |
| `VERDANDI_CLAUDE_SIDECAR_WRITE_QUEUE_STATS_MS` | positive integer | Diagnostic: every n ms, one stderr line with how many events the transport holds per live watcher. Off (no timer) when unset |
| `VERDANDI_CLAUDE_SIDECAR_FAULT_DROP_WATCH_AFTER` | positive integer | Test seam: break each session's first watch stream after n live events, to exercise replay. Never set in production |

Two more, named `VERDANDI_REAL_TEST_*`, are read only by the real-CLI tests, which are billed and run only with `RUN_REAL_CLAUDE_TESTS=1`:
`VERDANDI_REAL_TEST_EXECUTABLE` (`host_cli`, the default, or `sdk_bundled`: which executable source the run
certifies) and `VERDANDI_REAL_TEST_MODEL` (the model the provider-prompt test uses, default `haiku`). The
sidecar never reads them.

## Releases and tags

A release has a semantic version, `apps/claude-sidecar/package.json`'s `version`. It is what the handshake
reports as `sidecar_version` and what `--version` prints first, so a host can tell builds apart and pin one.
A release that raises `protocol.minor` in `capabilities.json` raises this version's minor at least; a fix
that changes neither raises its patch.

To cut release `X.Y.Z` (this creates the tag; nothing creates one automatically):

1. Set `version` to `X.Y.Z` in `apps/claude-sidecar/package.json` and in the `apps/claude-sidecar` entry of
   the root `package-lock.json` (`npm install --package-lock-only` does both), in one commit.
2. Freeze the current protocol minor (the newest `minors` entry in
   `crates/claude-runtime-protocol/capabilities.json`) unless it is already frozen by an earlier release --
   whether or not it changed the wire, because an unmarked minor can still be changed: run
   `npm run proto:fingerprint -w @verdandi/claude-sidecar` and write its output into that entry as
   `"wire_fingerprint"`, with `"released": "claude-sidecar-vX.Y.Z"` (the tag of step 4), in the same commit as
   the version. From then on `tests/protocolMinorLedger.test.ts` fails any change to the wire while that entry
   is the current minor: the next wire change must raise `protocol.minor` and add a new entry. A minor that
   changed no wire records its predecessor's fingerprint, which pins it the same way.
3. On that commit, run the compat suite (`apps/claude-sidecar/tests/compat/run.sh`), `npm test` for this
   workspace and the runtime package, and `cargo test --locked` in `crates/claude-runtime-protocol`.
   All must pass.
4. Tag that commit `claude-sidecar-vX.Y.Z` (annotated). A tag is never moved or deleted; a fix is a new
   version. Where this tree is published as a mirror, tag the mirror's corresponding commit with the same
   name, so a host that pins the tag gets the same tree either way.
5. A host pins the tag (and, for the Rust crate, the same revision), not a bare commit. Its compatibility
   check is the protocol major, the capabilities it needs and `sidecar_version`, in that order of weight.
