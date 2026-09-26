import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBroker } from '../src/permissionBroker.js';
import type { ClaudeRuntimeEvent } from '../src/types.js';

function makeBroker(): { broker: PermissionBroker; events: ClaudeRuntimeEvent[] } {
  const events: ClaudeRuntimeEvent[] = [];
  return { broker: new PermissionBroker((e) => events.push(e)), events };
}

test('buildHookMatcher: matcher is the literal "*", matching every tool', () => {
  const { broker } = makeBroker();
  const matcher = broker.buildHookMatcher();
  assert.equal(matcher.matcher, '*');
  assert.equal(matcher.hooks.length, 1);
});

test('the hook callback suspends until resolve() is called, then returns an allow decision', async () => {
  const { broker, events } = makeBroker();
  const matcher = broker.buildHookMatcher();
  const callback = matcher.hooks[0];

  const outputPromise = callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'permission_requested');
  const permissionId = (events[0] as { permissionId: string }).permissionId;

  const resolved = broker.resolve(permissionId, { allow: true });
  assert.equal(resolved, true);

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(events[1].type, 'permission_resolved');
  assert.equal((events[1] as { outcome: string }).outcome, 'allowed');
});

test('the hook callback returns a deny decision with the given reason', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];

  const outputPromise = callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_1', session_id: 's', transcript_path: '', cwd: '' } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  );
  const permissionId = (events[0] as { permissionId: string }).permissionId;
  broker.resolve(permissionId, { allow: false, reason: 'policy denies Bash' });

  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((output as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason, 'policy denies Bash');
});

test('two concurrent permission requests are both retained and independently resolvable in either order', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];

  const first = callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never, 'a', { signal: new AbortController().signal });
  const second = callback({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'b', session_id: 's', transcript_path: '', cwd: '' } as never, 'b', { signal: new AbortController().signal });

  assert.equal(broker.pendingCount(), 2);
  const requestedEvents = events.filter((e) => e.type === 'permission_requested') as Array<{ permissionId: string; toolUseId: string }>;
  const secondId = requestedEvents.find((e) => e.toolUseId === 'b')!.permissionId;
  const firstId = requestedEvents.find((e) => e.toolUseId === 'a')!.permissionId;

  // Resolve the SECOND request first -- proves order-independence, not just that two can coexist.
  broker.resolve(secondId, { allow: true });
  assert.equal(broker.pendingCount(), 1);
  broker.resolve(firstId, { allow: false, reason: 'no' });
  assert.equal(broker.pendingCount(), 0);

  const secondOutput = await second;
  const firstOutput = await first;
  assert.equal((secondOutput as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal((firstOutput as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
});

test('resolve() on an unknown or already-resolved id returns false, a harmless no-op', () => {
  const { broker } = makeBroker();
  assert.equal(broker.resolve('does-not-exist', { allow: true }), false);
});

test('failAllPending denies and clears every pending request with the given outcome', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];
  const outputPromise = callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never, 'a', { signal: new AbortController().signal });

  broker.failAllPending('cancelled_by_interrupt');

  assert.equal(broker.pendingCount(), 0);
  const output = await outputPromise;
  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
  const resolvedEvent = events.find((e) => e.type === 'permission_resolved') as { outcome: string };
  assert.equal(resolvedEvent.outcome, 'cancelled_by_interrupt');
});

// --- Third whole-branch review round: AbortSignal handling ---------------------------------

test('an aborted hook call resolves to deny, emits permission_resolved with outcome expired, and clears the pending entry', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];
  const controller = new AbortController();

  const outputPromise = callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never,
    'a',
    { signal: controller.signal },
  );

  assert.equal(broker.pendingCount(), 1);
  const permissionId = (events[0] as { permissionId: string }).permissionId;

  controller.abort();

  const output = await outputPromise;
  assert.equal(
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    'deny',
    'the CLI-facing hook call must still settle (to deny), not hang forever, once its own timeout aborts it',
  );
  assert.equal(broker.pendingCount(), 0);

  const resolvedEvent = events.find((e) => e.type === 'permission_resolved') as { outcome: string } | undefined;
  assert.equal(resolvedEvent?.outcome, 'expired');

  // A later resolvePermission() call on the same (now-expired) id must be a harmless no-op, not a
  // false permission_resolved: allowed/denied written for a request the CLI already gave up on --
  // this is the actual audit-trail-lie the finding is about.
  const resolvedAgain = broker.resolve(permissionId, { allow: true });
  assert.equal(resolvedAgain, false);
  assert.equal(events.filter((e) => e.type === 'permission_resolved').length, 1);
});

test('a hook call whose signal is already aborted resolves to deny immediately, without ever registering a pending request or emitting permission_requested', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];
  const controller = new AbortController();
  controller.abort();

  const output = await callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never,
    'a',
    { signal: controller.signal },
  );

  assert.equal((output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(broker.pendingCount(), 0);
  assert.equal(events.length, 0, 'an already-aborted call never had a live request to announce');
});

test('resolving normally before the signal later aborts leaves the abort listener inert -- no double-resolve, no extra event', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];
  const controller = new AbortController();

  const outputPromise = callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never,
    'a',
    { signal: controller.signal },
  );
  const permissionId = (events[0] as { permissionId: string }).permissionId;

  broker.resolve(permissionId, { allow: true });
  await outputPromise;

  controller.abort(); // fires AFTER the normal resolution -- must be inert, since resolve() removed the listener

  const resolvedEvents = events.filter((e) => e.type === 'permission_resolved');
  assert.equal(resolvedEvents.length, 1, 'the abort firing after a normal resolve() must not add a second permission_resolved event');
  assert.equal((resolvedEvents[0] as { outcome: string }).outcome, 'allowed');
});

test('an abort after failAllPending is also inert -- no double-resolve, no extra event', async () => {
  const { broker, events } = makeBroker();
  const callback = broker.buildHookMatcher().hooks[0];
  const controller = new AbortController();

  const outputPromise = callback(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'a', session_id: 's', transcript_path: '', cwd: '' } as never,
    'a',
    { signal: controller.signal },
  );

  broker.failAllPending('cancelled_by_interrupt');
  await outputPromise;

  controller.abort();

  const resolvedEvents = events.filter((e) => e.type === 'permission_resolved');
  assert.equal(resolvedEvents.length, 1);
  assert.equal((resolvedEvents[0] as { outcome: string }).outcome, 'cancelled_by_interrupt');
});
