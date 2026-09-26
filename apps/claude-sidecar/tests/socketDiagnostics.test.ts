import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertBindableSocketPath, chmodBoundSocket, makeShutdownTriggers, SUN_PATH_LIMIT } from '../src/lifecycle.js';

/**
 * Two startup failures that were real and unreadable, both found by the consumer running the
 * packaged artifact for the first time (2026-09-18). Neither was a wrong behaviour -- each was a
 * correct behaviour that said nothing, or said something that pointed at the wrong thing.
 */

// --- 1. A socket path longer than sockaddr_un.sun_path ------------------------------------------
//
// What happened: a 114-byte socket path. The bind produced no socket, and this process then died at
// chmodSync with `ENOENT: no such file or directory, chmod '<path>'` and a raw Node stack. The real
// cause -- path too long -- is named nowhere, and the message sends the reader at the filesystem.
// A packaged product handed a long TMPDIR hits exactly this.

test('assertBindableSocketPath: a path longer than sun_path is refused, naming the length and the limit', () => {
  const tooLong = `/tmp/${'x'.repeat(SUN_PATH_LIMIT)}/sidecar.sock`;
  assert.throws(
    () => assertBindableSocketPath(tooLong),
    (err: unknown) => {
      const message = (err as Error).message;
      return message.includes(String(Buffer.byteLength(tooLong))) && message.includes(String(SUN_PATH_LIMIT));
    },
  );
});

test('assertBindableSocketPath: a path at the limit is accepted, so the check cannot be off by one against a working path', () => {
  const atLimit = `/tmp/${'x'.repeat(SUN_PATH_LIMIT - '/tmp/'.length)}`;
  assert.equal(Buffer.byteLength(atLimit), SUN_PATH_LIMIT);
  assertBindableSocketPath(atLimit);
});

/** Measured in bytes, not characters: sun_path is a byte buffer, and a path of 60 multi-byte
 * characters can exceed it while looking short. */
test('assertBindableSocketPath: the limit is counted in bytes, not characters', () => {
  const multibyte = `/tmp/${'字'.repeat(SUN_PATH_LIMIT)}`;
  assert.ok(multibyte.length < Buffer.byteLength(multibyte));
  assert.throws(() => assertBindableSocketPath(multibyte), /byte/);
});

// --- 2. bindAsync reported success and there is no socket ---------------------------------------
//
// The backstop that does not depend on getting the number above right. grpc-js's bindAsync can
// report success for a bind that produced nothing, and the next statement -- a chmod to 0600 -- then
// fails with a bare ENOENT about a path that is correct. Whatever the cause (a too-long path, a
// directory that vanished, a sandbox), "bind said it worked and there is no socket" must be reported
// as itself.

test('chmodBoundSocket: a missing socket after a successful bind is reported as that, not as a chmod error', () => {
  assert.throws(
    () => chmodBoundSocket(join('/tmp', `verdandi-absent-${process.pid}.sock`)),
    (err: unknown) => {
      const message = (err as Error).message;
      return message.includes('reported success') && !message.startsWith('ENOENT');
    },
  );
});

// --- 3. A silent exit 0 on stdin EOF ------------------------------------------------------------
//
// The sidecar shuts down when stdin reaches EOF -- correct, and what a host holding stdin open
// relies on. But it exited 0 in silence, which is indistinguishable from a successful start that
// then vanished; the consumer spent an hour with "packaging regression" as its leading hypothesis
// before a control killed it.

test('makeShutdownTriggers: stdin EOF announces itself before shutting down', async () => {
  const diagnostics: string[] = [];
  const exits: number[] = [];
  let shutdownCalls = 0;
  const triggers = makeShutdownTriggers({
    shutdown: async () => {
      shutdownCalls += 1;
    },
    emitDiagnostic: (message) => diagnostics.push(message),
    exit: (code) => exits.push(code),
  });

  await triggers.onStdinEnd();

  assert.equal(shutdownCalls, 1);
  assert.deepEqual(exits, [0]);
  assert.match(diagnostics.join('\n'), /stdin/);
});

test('makeShutdownTriggers: each signal names itself, so three causes are not one message', async () => {
  const diagnostics: string[] = [];
  const triggers = makeShutdownTriggers({
    shutdown: async () => {},
    emitDiagnostic: (message) => diagnostics.push(message),
    exit: () => {},
  });

  await triggers.onSigterm();
  await triggers.onSigint();
  await triggers.onStdinEnd();

  assert.equal(diagnostics.length, 3);
  assert.equal(new Set(diagnostics).size, 3, `expected three distinct messages, got ${JSON.stringify(diagnostics)}`);
  assert.match(diagnostics[0], /SIGTERM/);
  assert.match(diagnostics[1], /SIGINT/);
});

/** The announcement must precede the shutdown, not follow it: a shutdown that hangs is exactly when
 * the reader most needs to know what asked for it. */
test('makeShutdownTriggers: the reason is emitted before shutdown begins', async () => {
  const order: string[] = [];
  const triggers = makeShutdownTriggers({
    shutdown: async () => {
      order.push('shutdown');
    },
    emitDiagnostic: () => order.push('diagnostic'),
    exit: () => order.push('exit'),
  });

  await triggers.onStdinEnd();

  assert.deepEqual(order, ['diagnostic', 'shutdown', 'exit']);
});
