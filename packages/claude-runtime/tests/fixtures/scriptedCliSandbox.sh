#!/bin/bash
# Runs scriptedCli.clientTools.test.js, which starts a real `claude` against a scripted model, inside a
# sandbox with no account, no network and no view of the host's home, run, mnt or tmp.
#
# usage, from the checkout after `npm run build:claude`:
#   scriptedCliSandbox.sh <cli path> <cli sha256> <run root>
#
# <cli path>    the exact binary under test, an absolute path; it is bound read-only
# <cli sha256>  its digest; the script refuses to start when the file's differs
# <run root>    a directory on the host that may be written; each run takes a fresh subdirectory
#
# A pass removes that subdirectory; a failure leaves it and prints its path.
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <cli path> <cli sha256> <run root>" >&2
  exit 2
fi
CLI=$1
WANT=$2
ROOT=$3
case "$CLI" in /*) ;; *) echo "the cli path must be absolute: $CLI" >&2; exit 2 ;; esac
case "$ROOT" in /*) ;; *) echo "the run root must be absolute: $ROOT" >&2; exit 2 ;; esac
[ -f "$CLI" ] || { echo "no such file: $CLI" >&2; exit 2; }
GOT=$(sha256sum "$CLI" | cut -d' ' -f1)
if [ "$GOT" != "$WANT" ]; then
  echo "the cli's sha256 is $GOT, expected $WANT" >&2
  exit 2
fi
TEST=packages/claude-runtime/dist/tests/scriptedCli.clientTools.test.js
[ -f "$TEST" ] || { echo "run from the checkout after the build: $TEST is missing" >&2; exit 2; }
for tool in bwrap systemd-run node; do
  command -v "$tool" >/dev/null || { echo "needs $tool on PATH" >&2; exit 2; }
done

UID_=$(id -u)
GID_=$(id -g)
USER_=$(id -un)
RUN=$ROOT/$(date +%Y%m%dT%H%M%S)-$$
mkdir -p "$RUN"/home "$RUN"/claude "$RUN"/tmp "$RUN"/log "$RUN"/project "$RUN"/r \
  "$RUN"/xdg/config "$RUN"/xdg/state "$RUN"/xdg/data "$RUN"/xdg/cache

# Hidden behind an empty tmpfs: other users' files, host daemons' sockets, other runs and remote mounts.
HIDE=()
for d in /home /root /tmp /var/tmp /run /mnt /media /nfs /smb /var/lib/gssproxy; do
  [ -e "$d" ] && HIDE+=(--tmpfs "$d")
done
[ -d /etc/claude-code ] && HIDE+=(--tmpfs /etc/claude-code)

set +e
XDG_RUNTIME_DIR=/run/user/$UID_ DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_/bus \
  systemd-run --user --scope -q -p MemoryMax=2G nice -n 10 \
  bwrap --die-with-parent --unshare-net --unshare-pid --unshare-ipc --unshare-user \
  --uid "$UID_" --gid "$GID_" --ro-bind / / --dev /dev --proc /proc "${HIDE[@]}" \
  --ro-bind "$PWD" "$PWD" --bind "$RUN" "$RUN" --ro-bind "$CLI" "$CLI" \
  -- env -i \
  PATH=/usr/bin:/bin HOME="$RUN/home" USER="$USER_" LANG=C.UTF-8 TERM=dumb TZ=UTC TMPDIR="$RUN/tmp" \
  XDG_CONFIG_HOME="$RUN/xdg/config" XDG_STATE_HOME="$RUN/xdg/state" XDG_DATA_HOME="$RUN/xdg/data" \
  XDG_CACHE_HOME="$RUN/xdg/cache" XDG_RUNTIME_DIR="$RUN/r" \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  ANTHROPIC_BASE_URL=http://127.0.0.1:4141 ANTHROPIC_API_KEY=scripted-no-credential \
  CLAUDE_CONFIG_DIR="$RUN/claude" CLAUDE_CODE_TMPDIR="$RUN/tmp" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
  DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 DISABLE_GROWTHBOOK=1 DO_NOT_TRACK=1 \
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0 CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1 \
  CLAUDE_CODE_GZIP_REQUEST_BODIES=0 CLAUDE_CODE_MAX_RETRIES=0 \
  ANTHROPIC_MODEL=claude-opus-5-5 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5 \
  VERDANDI_SCRIPTED_CLI="$CLI" VERDANDI_SCRIPTED_RUN="$RUN" \
  node --test --test-timeout=120000 "$PWD/$TEST"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  rm -rf -- "$RUN"
else
  echo "scripted CLI run failed (exit $STATUS); left in place: $RUN" >&2
fi
exit "$STATUS"
