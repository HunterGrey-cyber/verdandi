# verdandi

A Claude Code runtime and a gRPC sidecar that exposes it. This is the agent backend
[Eitri](https://github.com/HunterGrey-cyber/eitri) uses: Eitri starts the sidecar as a child
process and talks to it over a Unix domain socket.

It is a subset of a larger private repository, published as-is. Expect it to move with Eitri's
needs rather than to offer a stable general-purpose API.

## What is here

| path | what |
|---|---|
| `proto/verdandi/claude/runtime/v1/runtime.proto` | the wire contract: `RuntimeService` (`Handshake`, `CreateSession`, `SendTurn`, `WatchSessionEvents`, `InterruptTurn`, `ResolvePermission`, `CloseSession`, `SetPermissionMode`) |
| `packages/claude-runtime/` | `@verdandi/claude-runtime`: sessions over the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- account selection, the permission broker (a `PreToolUse` hook answered by the host), event translation, tool policy |
| `apps/claude-sidecar/` | `@verdandi/claude-sidecar`: the gRPC server over that runtime, with replay by sequence number, idempotent requests and parent-process watching; `npm run build:binary -w @verdandi/claude-sidecar` builds a self-contained Node SEA executable |
| `crates/claude-runtime-protocol/` | Rust client types generated from the proto (tonic/prost), for hosts written in Rust |

## Requirements

- Node.js 22 or newer, npm
- For the Rust crate: a Rust toolchain and a system `protoc` (the build script calls it)
- To run real sessions: an installed and logged-in `claude` CLI. The Agent SDK itself is
  Anthropic's software under its own licence; it is an npm dependency, not part of this repository.

## Build and test

```sh
npm ci
npm run build       # both packages (generates the TypeScript gRPC stubs first)
npm test            # builds, then runs both packages' unit tests
npm run typecheck

cd crates/claude-runtime-protocol && cargo build
```

The unit tests use fakes and never start a real `claude`. The integration tests
(`npm run test:real -w @verdandi/claude-runtime`, `npm run test:real -w @verdandi/claude-sidecar`)
do, and they **bill real usage to whichever Claude account the environment resolves to**. Set
`VERDANDI_CLAUDE_ACCOUNT` deliberately before running them.

## Running the sidecar

```sh
VERDANDI_CLAUDE_SIDECAR_SOCKET=/run/user/$UID/verdandi.sock \
  node apps/claude-sidecar/dist/src/index.js
```

Relevant environment variables:

| variable | meaning |
|---|---|
| `VERDANDI_CLAUDE_SIDECAR_SOCKET` | required; the Unix socket path to listen on |
| `VERDANDI_CLAUDE_CLI_PATH` | the `claude` binary sessions run (default: resolved from `PATH`) |
| `VERDANDI_CLAUDE_ACCOUNT` | pin a local account: `<name>` means `$HOME/.claude-<name>` and `$HOME/.config/anthropic-<name>`; `default` means the CLI's own default location |
| `VERDANDI_CLAUDE_CONFIG_DIR`, `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` | override those directories (absolute paths) |
| `VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH` | `stdin` (default): exit when stdin reaches end-of-file, i.e. the parent that holds its write end is gone; `none` disables that |
| `VERDANDI_CLAUDE_SIDECAR_EGRESS` | `open` (default) or `restricted`; `restricted` refuses to start unless loopback egress is actually blocked |

`node apps/claude-sidecar/dist/src/index.js --version` reports the Node, Agent SDK and supported CLI
versions without needing any configuration.

## Licence

MIT, see `LICENSE`.
