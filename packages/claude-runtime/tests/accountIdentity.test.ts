import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FAKE_ACCOUNT_INFO, makeFakeQuery, type FakeQueryOptions } from './fakeQuery.js';
import { readM1Fixture } from './m1FixtureFiles.js';
import { accountIdentityFromInfo, probeAccountIdentity } from '../src/accountIdentity.js';
import { createSession, holdsFirstTurnForAccount, type ClaudeRuntimeSession } from '../src/session.js';
import type { ClaudeHostPolicy, ClaudeRuntimeEvent, ClaudeSessionConfig } from '../src/types.js';

const COMPLETION: ClaudeHostPolicy = {
  configuration: 'isolated',
  permissions: 'bypass',
  persistence: 'host_cli',
  executable: 'host_cli',
  settingSources: [],
  toolPolicy: { allow: [] },
};

/** The investigator chain's shape: it sends `unrestricted: true`, never an allow list. */
const UNRESTRICTED: ClaudeHostPolicy = { ...COMPLETION, configuration: 'native', toolPolicy: { unrestricted: true } };

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp/project', permissionMode: 'bypassPermissions' };

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A session whose input stream the test can read: `delivered()` is the provider's view of what
 * the session delivered. Completion-shaped (so it holds its first turn) unless `shape` says otherwise. */
function harness(
  options: FakeQueryOptions = {},
  accountInfoTimeoutMs?: number,
  shape: Pick<ClaudeSessionConfig, 'policy' | 'outputFormat'> = { policy: COMPLETION },
) {
  const fake = makeFakeQuery(options);
  let input: AsyncIterator<SDKUserMessage> | undefined;
  const session = createSession({ cwd: '/tmp/project', ...shape, accountInfoTimeoutMs }, (params) => {
    input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return fake.query;
  });
  const pendingInput = input!.next();
  /** Resolves 'delivered' if the provider has received a message within `ms`, else 'held'. */
  const delivered = (ms: number) =>
    Promise.race([pendingInput.then(() => 'delivered' as const), new Promise<'held'>((r) => setTimeout(() => r('held'), ms))]);
  return { session, fake, delivered, pendingInput };
}

async function pumpUntil(session: ClaudeRuntimeSession, done: (events: ClaudeRuntimeEvent[]) => boolean): Promise<ClaudeRuntimeEvent[]> {
  const events: ClaudeRuntimeEvent[] = [];
  for (let i = 0; i < 200 && !done(events); i += 1) {
    events.push(...(await session.pump()));
    await new Promise((r) => setTimeout(r, 1));
  }
  return events;
}

test('accountIdentityFromInfo: fields verbatim, missing or empty ones null', () => {
  assert.deepEqual(accountIdentityFromInfo({ email: 'a@example.invalid', subscriptionType: 'pro', organization: '' }), {
    status: 'answered',
    email: 'a@example.invalid',
    organization: null,
    subscriptionType: 'pro',
    tokenSource: null,
  });
  assert.deepEqual(accountIdentityFromInfo(undefined), { status: 'answered', email: null, organization: null, subscriptionType: null, tokenSource: null });
});

test('probeAccountIdentity: an answer, a rejection and a silence each settle, and none of them throws', async () => {
  const answered = makeFakeQuery();
  assert.deepEqual(await probeAccountIdentity(answered.query, 1_000).identity, accountIdentityFromInfo(FAKE_ACCOUNT_INFO));
  assert.equal(answered.controller.accountInfoCalls, 1);

  const failing = makeFakeQuery({ accountInfo: () => Promise.reject(new Error('Claude Code process exited with code 1')) });
  assert.deepEqual(await probeAccountIdentity(failing.query, 1_000).identity, {
    status: 'unavailable',
    error: 'accountInfo() failed: Claude Code process exited with code 1',
  });

  const silent = makeFakeQuery({ accountInfo: () => new Promise<AccountInfo>(() => undefined) });
  assert.deepEqual(await probeAccountIdentity(silent.query, 20).identity, { status: 'unavailable', error: 'accountInfo() did not answer within 20ms' });

  const cancelled = probeAccountIdentity(silent.query, 60_000);
  cancelled.cancel('the session ended before accountInfo() answered');
  assert.deepEqual(await cancelled.identity, { status: 'unavailable', error: 'the session ended before accountInfo() answered' });
});

test('the first turn reaches the provider only after accountInfo() has answered', async () => {
  const gate = deferred<AccountInfo>();
  const { session, fake, delivered } = harness({ accountInfo: () => gate.promise });
  session.sendTurn('score these candidates');
  assert.equal(await delivered(30), 'held', 'the provider must see no input before the account is known');
  assert.equal(fake.controller.accountInfoCalls, 1, 'asked exactly once, by the session itself');
  gate.resolve({ email: 'work@example.invalid' });
  assert.equal(await delivered(1_000), 'delivered');
  session.close();
});

test('session_ready carries the identity accountInfo() gave', async () => {
  const { session, fake } = harness({ accountInfo: async () => ({ email: 'work@example.invalid', subscriptionType: 'pro' }) });
  session.sendTurn('go');
  await session.accountIdentity();
  fake.controller.emit(INIT as never);
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'session_ready'));
  const ready = events.find((e) => e.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual(ready.accountIdentity, { status: 'answered', email: 'work@example.invalid', organization: null, subscriptionType: 'pro', tokenSource: null });
  session.close();
});

test('an accountInfo() that never answers delays the first turn by the timeout, then reports unavailable', async () => {
  const { session, fake, delivered } = harness({ accountInfo: () => new Promise<AccountInfo>(() => undefined) }, 40);
  session.sendTurn('go');
  assert.equal(await delivered(10), 'held');
  assert.equal(await delivered(1_000), 'delivered', 'held for the timeout, not forever');
  fake.controller.emit(INIT as never);
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'session_ready'));
  const ready = events.find((e) => e.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual(ready.accountIdentity, { status: 'unavailable', error: 'accountInfo() did not answer within 40ms' });
  session.close();
});

test('interrupting a held first turn ends it as interrupted; the provider never sees it and is not interrupted', async () => {
  const gate = deferred<AccountInfo>();
  const { session, fake, delivered } = harness({ accountInfo: () => gate.promise });
  const { turnId } = session.sendTurn('go');
  await session.interrupt();
  gate.resolve(FAKE_ACCOUNT_INFO);
  assert.equal(await delivered(50), 'held', 'an interrupted held turn is dropped, not delivered late');
  assert.equal(fake.controller.interruptCalls, 0, 'nothing reached the provider, so there is nothing to interrupt there');
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'turn_completed'));
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.turnId, turnId);
  assert.equal(completed.outcome, 'interrupted');
  assert.doesNotThrow(() => session.sendTurn('next'), 'the session accepts a new turn afterwards');
  session.close();
});

test('closing a session with a held first turn reports it failed and never delivers it', async () => {
  const gate = deferred<AccountInfo>();
  const { session, pendingInput } = harness({ accountInfo: () => gate.promise });
  const { turnId } = session.sendTurn('go');
  session.close();
  gate.resolve(FAKE_ACCOUNT_INFO);
  // Closing ends the input stream, so the provider's next() now reports done -- with no message.
  assert.deepEqual(await pendingInput, { value: undefined, done: true });
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'session_closed'));
  const completed = events.find((e) => e.type === 'turn_completed');
  assert.ok(completed?.type === 'turn_completed');
  assert.equal(completed.turnId, turnId);
  assert.equal(completed.outcome, 'failed');
});

test('only the first turn is held: once the identity is known, later turns go straight through', async () => {
  const { session, fake } = harness();
  await session.accountIdentity();
  session.sendTurn('first');
  fake.controller.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: null } as never);
  await pumpUntil(session, (e) => e.some((x) => x.type === 'turn_completed'));
  assert.doesNotThrow(() => session.sendTurn('second'));
  session.close();
});

test('M1 recording: the recorded AccountInfo maps to an answered identity with its (redacted) email', () => {
  const info = readM1Fixture('success_account_info') as AccountInfo;
  const identity = accountIdentityFromInfo(info);
  assert.equal(identity.status, 'answered');
  assert.equal(identity.status === 'answered' ? identity.email : null, info.email ?? null);
  assert.notEqual(identity.status === 'answered' ? identity.email : null, null, 'the recorded work login reports an email');
});

test('the identity is what accountInfo() says, never the pinned account name: a wrong login in the pinned dir shows', async () => {
  const fake = makeFakeQuery({ accountInfo: async () => ({ email: 'someone-else@example.invalid', subscriptionType: 'max' }) });
  const session = createSession(
    {
      cwd: '/tmp/project',
      policy: COMPLETION,
      account: { name: 'work', configDir: '/home/probe/.claude-work', anthropicConfigDir: '/home/probe/.config/anthropic-work' },
    },
    () => fake.query,
  );
  session.sendTurn('go');
  await session.accountIdentity();
  fake.controller.emit(INIT as never);
  const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'session_ready'));
  const ready = events.find((e) => e.type === 'session_ready');
  assert.ok(ready?.type === 'session_ready');
  assert.deepEqual(ready.accountIdentity, { status: 'answered', email: 'someone-else@example.invalid', organization: null, subscriptionType: 'max', tokenSource: null });
  session.close();
});

test('holdsFirstTurnForAccount: only a completion-shaped session holds its first turn', () => {
  assert.equal(holdsFirstTurnForAccount({ policy: COMPLETION }), true, 'an explicit empty allow list');
  assert.equal(holdsFirstTurnForAccount({ policy: UNRESTRICTED, outputFormat: { type: 'json_schema', schema: { type: 'object' } } }), true, 'an output format');
  assert.equal(holdsFirstTurnForAccount({ policy: UNRESTRICTED }), false, 'the investigator chain: unrestricted');
  assert.equal(holdsFirstTurnForAccount({ policy: { ...COMPLETION, toolPolicy: undefined } }), false, 'no tool policy (Neovibe)');
  assert.equal(holdsFirstTurnForAccount({ policy: { ...COMPLETION, toolPolicy: { allow: ['Read'] } } }), false, 'a non-empty allow list');
});

test('an unrestricted session never waits for accountInfo(): one that never answers does not delay its first turn', async () => {
  // Spec §6.3 keeps the investigator chain's behaviour unchanged, so a slow or hung accountInfo()
  // must cost its sessions nothing. The deadline is long on purpose: any wait on it would show.
  const { session, fake, delivered } = harness({ accountInfo: () => new Promise<AccountInfo>(() => undefined) }, 60_000, { policy: UNRESTRICTED });
  try {
    session.sendTurn('go');
    assert.equal(await delivered(30), 'delivered', 'the provider has the first turn at once, not after the probe deadline');
    assert.equal(fake.controller.accountInfoCalls, 1, 'still asked, once, alongside the turn');
    fake.controller.emit(INIT as never);
    const events = await pumpUntil(session, (e) => e.some((x) => x.type === 'session_ready'));
    const ready = events.find((e) => e.type === 'session_ready');
    assert.ok(ready?.type === 'session_ready');
    assert.deepEqual(
      ready.accountIdentity,
      { status: 'unavailable', error: 'accountInfo() had not answered when system/init arrived' },
      'reported as not known yet -- never left out, never invented',
    );
  } finally {
    // Cancels the probe, so its 60 s deadline timer cannot keep this test file alive.
    session.close();
  }
});
