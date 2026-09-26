#!/usr/bin/env bash
# M1 probe launcher (spec 2026-09-23-muninn-daily-digest-design.md §6.3 P1).
#
# Runs the probe through the kernel's createSession path under the work account, in an
# environment scrubbed with `env -i` so that nothing from the calling shell -- a parent Claude
# Code session's CLAUDE_CODE_* markers, another account's CLAUDE_CONFIG_DIR, an ANTHROPIC_API_KEY
# -- reaches the measured CLI. Real turns are billed to that account.
#
#   run-m1-probe.sh run --dry-run                      # preflight only, no session, no spend
#   run-m1-probe.sh run                                # the default four cases
#   run-m1-probe.sh run --cases interactive,dontask    # the optional permission modes
#   run-m1-probe.sh run --baseline <fixtures>/manifest.json --expect-email <work email>
#                                                      # rerun on another host (host-b) and
#                                                      # compare against the recorded baseline
#
# Build first: npm run build -w @verdandi/claude-runtime (from the repository root).
# VERDANDI_CLAUDE_CLI_PATH selects the CLI binary; it must be the real binary, not a launcher.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/../.." && pwd)"
main="$pkg/dist/probes/m1/main.js"
if [[ ! -f "$main" ]]; then
  echo "run-m1-probe: $main is missing; run: npm run build -w @verdandi/claude-runtime" >&2
  exit 2
fi

cli="${VERDANDI_CLAUDE_CLI_PATH:-$HOME/.local/bin/claude}"
passthru=()
# VERDANDI_CLAUDE_CONFIG_DIR / _ANTHROPIC_CONFIG_DIR: where work lives when it is not at the
# ~/.claude-work convention -- e.g. VERDANDI_CLAUDE_CONFIG_DIR=default on a host whose work
# login is the CLI default ~/.claude (host-b). Same meaning as in the sidecar unit.
for name in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy TMPDIR VERDANDI_CLAUDE_CONFIG_DIR VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR; do
  if [[ -n "${!name:-}" ]]; then
    passthru+=("$name=${!name}")
  fi
done

exec env -i \
  HOME="$HOME" \
  USER="${USER:-$(id -un)}" \
  PATH="$PATH" \
  LANG="${LANG:-C.UTF-8}" \
  "${passthru[@]}" \
  VERDANDI_CLAUDE_ACCOUNT=work \
  VERDANDI_CLAUDE_CLI_PATH="$cli" \
  node "$main" "$@"
