import { connect, createServer, type AddressInfo } from 'node:net';

/**
 * Whether this sidecar claims to run with restricted network egress (consumer client spec §9.1: a
 * tool-bearing completion's sidecar cannot reach RFC1918, loopback or link-local addresses).
 *
 * The restriction itself is not this process's to impose: it is the cgroup's, a system-level
 * systemd slice with `IPAddressDeny=` (for example a `verdandi-web.slice`).
 * What this process CAN do is refuse to claim it without evidence. `restricted` makes startup
 * prove it -- see `loopbackReachability` -- and only then is `egress_restricted` advertised in the
 * Handshake, the capability the controlplane requires before it routes a run with tools here.
 *
 * Why the evidence matters: `IPAddressDeny=` in a systemd `--user` unit is silently ignored. The
 * user manager logs "unit configures an IP firewall, but not running as root" once and lets every
 * packet through -- measured 2026-09-25 on host-a and on host-b (systemd 261). A unit file that
 * says "restricted" proves nothing; a connection that does not complete does.
 *
 * Read like `parentWatchFromEnv`: a value that is neither refuses to boot.
 */
export type EgressMode = 'open' | 'restricted';

export function egressModeFromEnv(env: NodeJS.ProcessEnv = process.env): EgressMode {
  const raw = env.VERDANDI_CLAUDE_SIDECAR_EGRESS;
  if (raw === undefined || raw.trim() === '') {
    return 'open';
  }
  const value = raw.trim();
  if (value === 'open' || value === 'restricted') {
    return value;
  }
  throw new Error(`VERDANDI_CLAUDE_SIDECAR_EGRESS: expected "open" or "restricted", got ${JSON.stringify(raw)}`);
}

/** How long the loopback probe waits. A cgroup IP filter DROPS the SYN (measured: curl times out,
 * it is not refused), so "blocked" is observed as a connect that does not finish in time; loopback
 * itself answers in well under a millisecond. */
export const EGRESS_PROBE_TIMEOUT_MS = 1_500;

/**
 * Opens a TCP listener on 127.0.0.1 inside this process and connects to it. `reachable` means the
 * connection completed: nothing filters this process's loopback traffic, so nothing restricts its
 * egress either. `blocked` means it errored or did not complete within `timeoutMs`.
 *
 * Self-contained on purpose: it depends on no other service being up, so a stopped controlplane or
 * a restarted proxy cannot make an unrestricted sidecar look restricted.
 */
export async function loopbackReachability(timeoutMs: number = EGRESS_PROBE_TIMEOUT_MS): Promise<'reachable' | 'blocked'> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<'reachable' | 'blocked'>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve('blocked');
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve('reachable');
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve('blocked');
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Startup check for `restricted`: resolves when loopback is unreachable from this process, throws
 * (so the sidecar refuses to start) when it is reachable. `probe` is injectable for tests.
 */
export async function assertEgressRestricted(probe: () => Promise<'reachable' | 'blocked'> = () => loopbackReachability()): Promise<void> {
  if ((await probe()) === 'reachable') {
    throw new Error(
      'VERDANDI_CLAUDE_SIDECAR_EGRESS=restricted, but this process reached a listener on 127.0.0.1: no IP filter applies to it. ' +
        'Run the sidecar as a SYSTEM unit in verdandi-web.slice (IPAddressDeny= is ignored in systemd --user units), or unset the variable.',
    );
  }
}
