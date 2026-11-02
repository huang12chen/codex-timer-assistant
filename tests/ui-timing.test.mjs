import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from '../ui/time.mjs';
const now=Date.parse('2026-10-28T11:45:00Z');
const reset=Date.parse('2026-10-28T11:51:42Z');
const connection=(primary={usedPercent:100,resetAt:reset},secondary={usedPercent:16,resetAt:reset+86400000})=>({connected:true,capabilities:{readQuota:true},quota:{readAt:now,stale:false,primary,secondary}});

test('quota countdown uses exact reset seconds and marks a passed reset for verification',()=>{
  assert.equal(typeof timing.quotaResetInfo,'function');
  assert.deepEqual(timing.quotaResetInfo(connection(),'primary',now),{status:'countdown',resetAt:reset,remainingMs:402000});
  const current=connection();current.quota.readAt=reset+1000;
  assert.equal(timing.quotaResetInfo(current,'primary',reset+1000).status,'checking');
});
test('stale or failed quota data cannot supply a countdown or a scheduling shortcut',()=>{
  assert.equal(typeof timing.quotaScheduleAt,'function');
  for(const broken of [{...connection(),connected:false},{...connection(),quota:{...connection().quota,stale:true}},{...connection(),quota:{...connection().quota,readAt:now-46000}}]){
    assert.equal(timing.quotaResetInfo(broken,'primary',now).status,'unknown');
    assert.equal(timing.quotaScheduleAt(broken,{now}),null);
  }
});
test('reset scheduling defaults to one extra minute without dropping its seconds',()=>{
  assert.equal(typeof timing.quotaScheduleAt,'function');
  assert.equal(timing.quotaScheduleAt(connection(),{now}),reset+60000);
  assert.equal(timing.quotaScheduleAt(connection(),{now,bufferMinutes:0}),reset);
  assert.equal(timing.toLocalInput(reset+60000,'America/Halifax',true),'2026-10-28T08:52:42');
  assert.equal(timing.parseLocalInput('2026-10-28T08:52:42','America/Halifax'),reset+60000);
});
test('both exhausted windows require the later reset, and unknown blocker times stay manual',()=>{
  assert.equal(typeof timing.quotaScheduleAt,'function');
  const blocked=connection(undefined,{usedPercent:100,resetAt:reset+86400000});
  assert.equal(timing.quotaScheduleAt(blocked,{now}),reset+86400000+60000);
  blocked.quota.secondary.resetAt=null;assert.equal(timing.quotaScheduleAt(blocked,{now}),null);
});
test('weekly exhaustion alone schedules the weekly reset, with optional one-minute buffer',()=>{
  const current=connection({usedPercent:30,resetAt:reset},{usedPercent:100,resetAt:reset+86400000});
  assert.equal(timing.quotaScheduleAt(current,{now}),reset+86400000+60000);
  assert.equal(timing.quotaScheduleAt(current,{now,bufferMinutes:0}),reset+86400000);
});
test('an expired reset and buffer cannot create a task scheduled in the past',()=>{
  assert.equal(typeof timing.quotaScheduleAt,'function');
  const current=connection();current.quota.readAt=reset+61000;
  assert.equal(timing.quotaScheduleAt(current,{now:reset+61000}),null);
});
test('once delivery and watched goal completion have distinct user-facing labels',()=>{
  assert.equal(typeof timing.taskStatusLabel,'function');
  assert.equal(timing.taskStatusLabel({kind:'once',state:'completed'}),'已发送');
  assert.equal(timing.taskStatusLabel({kind:'watch',state:'completed'}),'目标完成');
  assert.equal(timing.taskStatusLabel({kind:'watch',state:'watching',enabled:true,scheduledAt:now+60000},now),'待开始');
});
test('only enabled plans contribute a countdown and active work is not timed against the cutoff',()=>{
  assert.equal(timing.upcoming([{id:'paused',state:'paused',enabled:false,scheduledAt:now+60000}],now),null);
  const active=timing.upcoming([{id:'running',state:'running',enabled:true,kind:'watch',scheduledAt:now-1000,cutoffAt:now+28800000}],now);
  assert.equal(active.due,null);assert.equal(active.phase,'running');
  const queued=timing.upcoming([{id:'queued',state:'queued',enabled:true,kind:'once',scheduledAt:now-1000}],now);
  assert.equal(queued.phase,'confirmation');assert.equal(queued.due,null);
});
test('a future send takes countdown priority over an ongoing unlimited watch',()=>{
  const next=timing.upcoming([{id:'watch',kind:'watch',state:'running',enabled:true,scheduledAt:now-1000,cutoffAt:null},{id:'send',kind:'once',state:'scheduled',enabled:true,scheduledAt:now+60000}],now);
  assert.equal(next.task.id,'send');assert.equal(next.due,now+60000);assert.equal(next.phase,'start');
});
