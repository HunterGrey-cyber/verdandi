/**
 * How this process notices that whoever is responsible for it has gone away.
 *
 * `stdin` (the default) is the stand-in for the Rust host's future parent-death protocol (design
 * spec §6): a host that spawns this process holds its stdin open, and EOF means the host died or let
 * go, so the sidecar shuts down instead of lingering as an orphan that still owns its socket.
 *
 * `none` is for a service manager. systemd starts a unit with stdin on /dev/null, which reads as EOF
 * at once, so under `stdin` the sidecar would announce "stdin reached EOF" and exit 0 the moment it
 * started -- and `Restart=on-failure` never restarts a clean exit. The service manager is the parent
 * there, and it stops the process with SIGTERM, which is handled either way. Found deploying the
 * host-b units (2026-09-25): the trial run had been holding stdin open with `tail -f /dev/null |`,
 * and the units written from it had no equivalent.
 *
 * Read through a pure, injectable helper like `ringCapacityFromEnv` (replayConfig.ts): a value that is
 * neither refuses to boot rather than quietly picking one, because either silent choice is wrong for
 * somebody -- a misspelt `none` that fell back to `stdin` is exactly the exit-0-on-start this exists
 * to prevent.
 */
export type ParentWatch = 'stdin' | 'none';

export function parentWatchFromEnv(env: NodeJS.ProcessEnv = process.env): ParentWatch {
  const raw = env.VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH;
  if (raw === undefined || raw.trim() === '') {
    return 'stdin';
  }
  const value = raw.trim();
  if (value === 'stdin' || value === 'none') {
    return value;
  }
  throw new Error(`VERDANDI_CLAUDE_SIDECAR_PARENT_WATCH: expected "stdin" or "none", got ${JSON.stringify(raw)}`);
}
