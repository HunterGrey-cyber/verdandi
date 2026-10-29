import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleLedger } from '../src/scheduleLedger.js';

function tool(ledger: ScheduleLedger, name: string, input: object, result: object, id = 'call') {
  ledger.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  ledger.observe({ type: 'user', tool_use_result: result, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
}
const wake = (scheduled_for: number) => ({ wakeup_source: 'loop_wakeup', scheduled_for });

test('wakeups retain the latest 64 results, join by timestamp, and are consumed by a fire', () => {
  const ledger = new ScheduleLedger();
  for (let i = 0; i < 65; i++) tool(ledger, 'ScheduleWakeup', { reason: `reason ${i}` }, { scheduledFor: i });
  assert.equal(ledger.fire(wake(0)).scheduleReason, undefined);
  assert.deepEqual(ledger.fire(wake(1)), { kind: 'scheduled', wakeupSource: 'loop_wakeup', scheduledForMs: 1, scheduleReason: 'reason 1' });
  assert.equal(ledger.fire(wake(1)).scheduleReason, undefined);
  assert.equal(ledger.fire(wake(64)).scheduleReason, 'reason 64');
});

test('cron joins require exactly one live job, and successful deletion removes its id', () => {
  const ledger = new ScheduleLedger();
  const fire = { wakeup_source: 'schedule_wakeup' };
  assert.deepEqual(ledger.fire(fire), { kind: 'scheduled', wakeupSource: 'schedule_wakeup' });
  tool(ledger, 'CronCreate', { prompt: 'first' }, { id: 'one', humanSchedule: '* * * * *' });
  assert.deepEqual(ledger.fire(fire), { kind: 'scheduled', wakeupSource: 'schedule_wakeup', cronId: 'one', prompt: 'first' });
  tool(ledger, 'CronCreate', { prompt: 'second' }, { id: 'two', humanSchedule: '* * * * *' });
  assert.equal(ledger.fire(fire).cronId, undefined);
  tool(ledger, 'CronDelete', { id: 'two' }, { id: 'two' });
  assert.equal(ledger.fire(fire).cronId, 'one');
});

test('cron results are bounded to 64 live jobs', () => {
  const ledger = new ScheduleLedger();
  for (let i = 0; i < 65; i++) tool(ledger, 'CronCreate', { prompt: String(i) }, { id: String(i), humanSchedule: 'daily' });
  for (let i = 1; i < 64; i++) tool(ledger, 'CronDelete', { id: String(i) }, { id: String(i) });
  assert.equal(ledger.fire({ wakeup_source: 'schedule_wakeup' }).cronId, '64');
});

test('missing source is unknown and malformed or failed tool results cannot establish facts', () => {
  const ledger = new ScheduleLedger();
  assert.deepEqual(ledger.fire({ scheduled_for: 1 }), { kind: 'unknown' });
  assert.deepEqual(ledger.fire({ wakeup_source: 42 }), { kind: 'unknown' });
  ledger.observe({ message: { content: [{ type: 'tool_use', id: 'a', name: 'ScheduleWakeup', input: { reason: 'bad' } }] } });
  assert.equal(ledger.observe({ tool_use_result: { scheduledFor: '1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }), 1);
  assert.equal(ledger.fire(wake(1)).scheduleReason, undefined);
  ledger.observe({ message: { content: [{ type: 'tool_use', id: 'a', name: 'ScheduleWakeup', input: { reason: 'failed' } }] } });
  ledger.observe({ tool_use_result: { scheduledFor: 1 }, message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } });
  assert.equal(ledger.fire(wake(1)).scheduleReason, undefined);
});
