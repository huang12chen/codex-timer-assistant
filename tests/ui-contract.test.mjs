import test from 'node:test';
import assert from 'node:assert/strict';
let guard, time;
try { guard = await import('../src/ipc-guard.cjs'); } catch {}
try { time = await import('../ui/time.mjs'); } catch {}
const ipc = () => { assert.ok(guard, 'IPC validation is not implemented'); return guard.default; };
const dates = () => { assert.ok(time, 'Time-zone handling is not implemented'); return time; };

test('renderer cannot invoke arbitrary privileged actions', () => {
  assert.throws(() => ipc().validateCall('exec', {}, 'main'), /不支持/);
  assert.throws(() => ipc().validateCall('createTask', {}, 'orb'), /权限/);
  assert.equal(ipc().validateCall('snapshot', null, 'orb'), 'snapshot');
});
test('IPC rejects oversized payloads and invalid identifiers', () => {
  assert.throws(() => ipc().validateCall('createTask', { message: 'x'.repeat(300000) }, 'main'), /过大/);
  assert.throws(() => ipc().validateCall('taskAction', { id: '../x', action: 'delete' }, 'main'), /任务/);
  const id='11111111-1111-4111-8111-111111111111',intentId='22222222-2222-4222-8222-222222222222';
  assert.equal(ipc().validateCall('taskAction',{id,action:'confirmDelivered',intentId},'main'),'taskAction');
  assert.throws(()=>ipc().validateCall('taskAction',{id,action:'confirmDelivered',intentId:'bad'},'main'),/标识/);
  assert.throws(()=>ipc().validateCall('taskAction',{id,action:'confirmDelivered',intentId},'orb'),/权限/);
});
test('only the main renderer can request clearing logs, without a payload', () => {
  assert.equal(ipc().validateCall('clearLogs', null, 'main'), 'clearLogs');
  assert.equal(ipc().validateCall('clearLogs', undefined, 'main'), 'clearLogs');
  for (const payload of [{}, [], '', false, 0, { all: true }]) {
    assert.throws(() => ipc().validateCall('clearLogs', payload, 'main'), /请求/);
  }
  for (const role of ['orb', 'other', null]) {
    assert.throws(() => ipc().validateCall('clearLogs', null, role), /权限/);
  }
});
test('Halifax local schedule is converted without relying on machine timezone', () => {
  const value = dates().parseLocalInput('2026-10-27T08:00', 'America/Halifax');
  assert.equal(new Date(value).toISOString(), '2026-10-27T11:00:00.000Z');
  assert.equal(dates().toLocalInput(value, 'America/Halifax'), '2026-10-27T08:00');
});
test('nonexistent daylight-saving time is rejected', () => {
  assert.throws(() => dates().parseLocalInput('2026-03-08T02:30', 'America/Halifax'), /不存在/);
});
test('countdown clamps expired values and keeps hour display', () => {
  assert.equal(dates().formatDuration(-1000), '00:00:00');
  assert.equal(dates().formatDuration(3661000), '01:01:01');
});
test('future watch countdown uses its start time rather than its eight-hour cutoff', () => {
  const now = Date.now();
  const next = dates().upcoming([{id:'watch',enabled:true,state:'watching',kind:'watch',scheduledAt:now+120000,cutoffAt:now+28800000},{id:'once',enabled:true,state:'scheduled',kind:'once',scheduledAt:now+180000}],now);
  assert.equal(next.task.id,'watch');
  assert.equal(next.due,now+120000);
});
