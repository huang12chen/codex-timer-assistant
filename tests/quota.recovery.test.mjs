import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { TaskEngine, TaskStore } from '../src/core/index.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const TARGET = { type: 'fixed', threadId: THREAD, link: `codex://threads/${THREAD}` };
const NOW = 1793230000000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const quotaTurn = () => [event('task_started', { turn_id: 'quota-turn' }), event('error', { codex_error_info: 'usageLimitExceeded' }), event('task_complete', { turn_id: 'quota-turn' })];

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ctimer-quota-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = {
    now: NOW, records: quotaTurn(), allowance: false, quotaError: null, onRead: null,
    primary: { usedPercent: 100, resetsAt: (NOW + WEEK) / 1000 },
    secondary: { usedPercent: 63, resetsAt: (NOW + WEEK) / 1000 },
  };
  const calls = [], scans = [];
  const rpc = { isAlive: true, start: async () => {}, close: async () => {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: THREAD, path: 'synthetic-quota.jsonl', source: 'appServer' } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'account/rateLimits/read') {
      if (state.quotaError) throw state.quotaError;
      return { ordinaryUsageAllowed: state.allowance, rateLimits: { primary: state.primary, secondary: state.secondary } };
    }
    if (method === 'thread/queue/add') return { queuedSubmission: { id: `receipt-${calls.length}`, clientUserMessageId: params.clientUserMessageId } };
    throw Error(`Unexpected synthetic RPC ${method}`);
  } };
  const adapter = new CodexAdapter({ dependencies: {
    discover: async () => ({ path: 'codex.exe', version: '0.164.0' }), createRpc: () => rpc,
    readTail: async (_file, options) => {
      scans.push(options);
      if (state.onRead) state.onRead(options);
      return { records: state.records };
    }, now: () => state.now,
  } });
  t.after(() => adapter.close());
  const store = new TaskStore(directory);
  const clock = { now: () => state.now };
  const engine = new TaskEngine({ store, adapter, clock, intervalMs: 2500 });
  t.after(() => engine.stop());
  const create = (patch = {}) => engine.createTask({ title: '额度恢复回归', kind: 'watch', target: TARGET, message: '继续', cutoffAt: null, enabled: true, ...patch });
  const task = id => store.snapshot().tasks.find(task => task.id === id);
  const seedLegacy = async (patch = {}) => {
    const created = await create();
    await store.updateTask(created.id, {
      state: 'waiting_quota', nextAttemptAt: NOW + WEEK, updatedAt: NOW - 15000,
      lastObservation: { threadId: THREAD, status: 'waiting_quota', observedAt: NOW - 15000 },
      blocker: { type: 'quota', eventKey: 'legacy-quota', resetAt: NOW + WEEK, source: 'official' }, ...patch,
    });
    return created;
  };
  return { state, adapter, engine, store, clock, calls, scans, create, task, seedLegacy,
    reads: () => calls.filter(call => call.method === 'account/rateLimits/read'),
    sends: () => calls.filter(call => call.method === 'thread/queue/add'),
  };
}

test('persisted week-long quota wait rechecks and resumes without rebuilding the task', async t => {
  const h = await fixture(t), task = await h.seedLegacy();
  h.state.allowance = true; h.state.primary.usedPercent = 30;
  const restarted = new TaskEngine({ store: new TaskStore(h.store.directory), adapter: h.adapter, clock: h.clock, intervalMs: 2500 });
  t.after(() => restarted.stop());
  await restarted.tick();
  await restarted.tick();
  assert.equal(h.sends().length, 1);
  assert.equal(restarted.snapshot().tasks[0].id, task.id);
  assert.ok(h.scans.some(scan => scan.verify === true), 'resumption must include the full preflight scan');
  assert.equal(restarted.snapshot().tasks[0].intents.length, 1, 'queued continuation is never duplicated');
});

test('legacy waits respect the most recent refusal and recheck at fifteen seconds', async t => {
  const h = await fixture(t);
  await h.seedLegacy({ updatedAt: NOW - 5000, lastObservation: { threadId: THREAD, status: 'waiting_quota', observedAt: NOW - 10000 } });
  for (const offset of [0, 2500, 7500, 9999]) { h.state.now = NOW + offset; await h.engine.tick(); }
  assert.equal(h.reads().length, 0);
  h.state.now = NOW + 10000; await h.engine.tick();
  assert.equal(h.reads().length, 1);
  for (const offset of [12500, 15000, 20000, 24999]) { h.state.now = NOW + offset; await h.engine.tick(); }
  assert.equal(h.reads().length, 1, 'fast engine ticks must not repeatedly read official quota');
  h.state.now = NOW + 25000; await h.engine.tick();
  assert.equal(h.reads().length, 2);
  assert.equal(h.sends().length, 0);
});

test('new quota waits store a bounded check time while preserving the reset estimate', async t => {
  const h = await fixture(t), task = await h.create();
  await h.engine.tick();
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 15000);
  assert.equal(h.task(task.id).blocker.resetAt, NOW + WEEK);
  h.state.now += 15000; await h.engine.tick();
  assert.equal(h.reads().length, 2);
  assert.equal(h.task(task.id).state, 'waiting_quota');
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 30000);
});

test('unknown reset times still throttle quota reads to fifteen seconds', async t => {
  const h = await fixture(t), task = await h.create();
  h.state.primary = null; h.state.secondary = null;
  await h.engine.tick();
  for (let i = 1; i < 6; i++) { h.state.now = NOW + i * 2500; await h.engine.tick(); }
  assert.equal(h.reads().length, 1);
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 15000);
  h.state.now = NOW + 15000; await h.engine.tick();
  assert.equal(h.reads().length, 2);
});

test('a future explicit scheduled time still prevents quota recovery and sending', async t => {
  const h = await fixture(t);
  await h.seedLegacy({ scheduledAt: NOW + 60000 }); h.state.allowance = true;
  await h.engine.tick();
  assert.equal(h.reads().length, 0); assert.equal(h.sends().length, 0);
});

for (const mode of ['disabled', 'pausedAll', 'needs_attention', 'expired', 'completed', 'cutoff', 'unknown_intent', 'pending_intent', 'queued_intent']) {
  test(`legacy quota recovery preserves ${mode} protection`, async t => {
    const h = await fixture(t), task = await h.seedLegacy(); h.state.allowance = true;
    if (mode === 'disabled') await h.store.updateTask(task.id, { enabled: false, state: 'paused' });
    else if (mode === 'pausedAll') await h.store.updateSettings({ pausedAll: true });
    else if (['needs_attention', 'expired', 'completed'].includes(mode)) await h.store.updateTask(task.id, { state: mode });
    else if (mode === 'cutoff') await h.store.updateTask(task.id, { cutoffAt: NOW });
    else await h.store.updateTask(task.id, { intents: [{ id: '33333333-3333-4333-8333-333333333333', threadId: THREAD, type: 'send_message', eventKey: 'earlier-send', baseTurnId: 'quota-turn', intendedAt: NOW - 1000, status: mode.replace('_intent', '') }] });
    await h.engine.tick(); assert.equal(h.sends().length, 0);
  });
}

for (const mode of ['active', 'unknown_allowance', 'quota_read_failure', 'manual_stop', 'approval']) {
  test(`an overdue quota recheck cannot send during ${mode}`, async t => {
    const h = await fixture(t), task = await h.seedLegacy(); h.state.allowance = true;
    if (mode === 'active') h.state.records = [event('task_started', { turn_id: 'active-now' })];
    if (mode === 'unknown_allowance') h.state.allowance = null;
    if (mode === 'quota_read_failure') h.state.quotaError = Object.assign(Error('offline'), { code: 'RPC_TIMEOUT' });
    if (mode === 'manual_stop') h.state.records = [event('task_started', { turn_id: 'stopped' }), event('turn_aborted', { turn_id: 'stopped' })];
    if (mode === 'approval') h.state.records = [event('task_started', { turn_id: 'approval' }), event('exec_approval_request', { call_id: 'permission-1' })];
    await h.engine.tick(); assert.equal(h.sends().length, 0);
    assert.ok(h.reads().length > 0, 'the legacy long sleep must actually be rechecked');
    if (mode === 'active') assert.equal(h.task(task.id).state, 'running');
  });
}

test('only an exhausted five-hour window supplies its reset, never the unexhausted weekly reset', async t => {
  const h = await fixture(t);
  h.state.primary.resetsAt = (NOW + 3600000) / 1000;
  h.state.secondary.resetsAt = (NOW + 1000) / 1000;
  const result = await h.adapter.observe(TARGET);
  assert.equal(result.status, 'waiting_quota');
  assert.equal(result.quota.resetAt, NOW + 3600000);
});

test('weekly exhaustion blocks an enabled watch even when five-hour quota remains', async t => {
  const h = await fixture(t), task = await h.create();
  h.state.primary = { usedPercent: 30, resetsAt: (NOW + 3600000) / 1000 };
  h.state.secondary = { usedPercent: 100, resetsAt: (NOW + WEEK) / 1000 };
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'waiting_quota');
  assert.equal(h.task(task.id).blocker.resetAt, NOW + WEEK);
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 15000);
  assert.equal(h.sends().length, 0);
  h.state.now = NOW + 3600000 + 1000;
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'waiting_quota');
  assert.equal(h.sends().length, 0, 'five-hour reset must not clear a weekly block');
  h.state.now = NOW + WEEK + 60000;
  h.state.secondary = { usedPercent: 2, resetsAt: (NOW + 2 * WEEK) / 1000 };
  h.state.allowance = true;
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.sends().length, 1, 'fresh official allowance permits one continuation after reset');
});

for (const allowance of [null, true]) {
  test(`weekly exhaustion blocks first-time sending when official allowance is ${allowance}`, async t => {
    const h = await fixture(t), task = await h.create();
    h.state.records = [event('task_complete', { turn_id: 'ordinary-turn' })];
    h.state.primary = { usedPercent: 30, resetsAt: (NOW + 3600000) / 1000 };
    h.state.secondary = { usedPercent: 100, resetsAt: (NOW + WEEK) / 1000 };
    h.state.allowance = allowance;
    await h.engine.tick();
    assert.equal(h.task(task.id).state, 'waiting_quota');
    assert.equal(h.task(task.id).blocker.resetAt, NOW + WEEK);
    assert.equal(h.sends().length, 0);
  });
}

test('an exhausted window without a known reset cannot use another window reset as final', async t => {
  const h = await fixture(t);
  h.state.primary = { usedPercent: 100, resetsAt: (NOW + 3600000) / 1000 };
  h.state.secondary = { usedPercent: 100, resetsAt: null };
  const result = await h.adapter.observe(TARGET);
  assert.equal(result.status, 'waiting_quota');
  assert.equal(result.quota.resetAt, null);
});

test('two exhausted windows use the later reset', async t => {
  const h = await fixture(t);
  h.state.primary.resetsAt = (NOW + 3600000) / 1000; h.state.secondary.usedPercent = 100;
  const result = await h.adapter.observe(TARGET);
  assert.equal(result.quota.resetAt, NOW + WEEK);
});

for (const allowance of [false, null]) {
  test(`nonexhausted windows with allowance ${allowance} discard the old weekly estimate without authorizing a send`, async t => {
    const h = await fixture(t);
    await h.adapter.observe(TARGET);
    h.state.primary = { usedPercent: 0, resetsAt: (NOW - 1) / 1000 };
    h.state.secondary.usedPercent = 63; h.state.allowance = allowance;
    const result = await h.adapter.observe(TARGET, { task: { state: 'waiting_quota' } });
    assert.equal(result.status, 'waiting_quota'); assert.equal(result.quota.resetAt, null);
    assert.equal(h.sends().length, 0);
  });
}

test('a proven not-sent quota refusal bounds a long retry and rechecks before retrying', async t => {
  const h = await fixture(t), task = await h.create(); h.state.allowance = true;
  h.state.primary.usedPercent = 30;
  h.state.onRead = options => { if (options.verify) h.state.allowance = false; };
  await h.engine.tick();
  assert.equal(h.sends().length, 0);
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  assert.equal(h.task(task.id).intents[0].outcome, 'not_sent');
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 15000);
  h.state.now += 14999; await h.engine.tick(); assert.equal(h.reads().length, 2);
  h.state.now += 1; h.state.allowance = true; h.state.onRead = null;
  await h.engine.tick(); await h.engine.tick();
  assert.equal(h.sends().length, 1);
  assert.deepEqual(h.task(task.id).intents.map(intent => intent.status), ['cancelled', 'queued']);
});

test('explicit quota recheck wakes a recent wait and still performs fresh validation and queue deduplication', async t => {
  const h = await fixture(t), task = await h.seedLegacy({ updatedAt: NOW, lastObservation: { status: 'waiting_quota', observedAt: NOW } });
  const before = h.task(task.id); h.state.allowance = true; h.state.primary.usedPercent = 30;
  assert.equal(typeof h.engine.recheckQuota, 'function');
  await h.engine.recheckQuota(); await h.engine.recheckQuota();
  assert.equal(h.sends().length, 1); assert.ok(h.scans.some(scan => scan.verify));
  const after = h.task(task.id);
  for (const key of ['message', 'scheduledAt', 'target', 'enabled', 'cutoffAt']) assert.deepEqual(after[key], before[key]);
});

for (const mode of ['disabled', 'pausedAll', 'future_schedule', 'needs_attention', 'unknown', 'pending', 'queued', 'active', 'approval', 'false', 'unknown_allowance']) {
  test(`explicit quota recheck preserves ${mode} safety`, async t => {
    const h = await fixture(t), task = await h.seedLegacy({ updatedAt: NOW }); h.state.allowance = true;
    if (mode === 'disabled') await h.store.updateTask(task.id, { enabled: false });
    if (mode === 'pausedAll') await h.store.updateSettings({ pausedAll: true });
    if (mode === 'future_schedule') await h.store.updateTask(task.id, { scheduledAt: NOW + 60000 });
    if (mode === 'needs_attention') await h.store.updateTask(task.id, { state: 'needs_attention' });
    if (['unknown', 'pending', 'queued'].includes(mode)) await h.store.updateTask(task.id, { intents: [{ id: '33333333-3333-4333-8333-333333333333', threadId: THREAD, type: 'send_message', eventKey: 'earlier-send', baseTurnId: 'quota-turn', intendedAt: NOW - 1000, status: mode }] });
    if (mode === 'active') h.state.records = [event('task_started', { turn_id: 'active' })];
    if (mode === 'approval') h.state.records = [event('task_started', { turn_id: 'approval' }), event('exec_approval_request', { call_id: 'permission-1' })];
    if (mode === 'false') h.state.allowance = false;
    if (mode === 'unknown_allowance') h.state.allowance = null;
    assert.equal(typeof h.engine.recheckQuota, 'function');
    await h.engine.recheckQuota(); assert.equal(h.sends().length, 0);
    assert.equal(h.task(task.id).enabled, mode !== 'disabled');
    if (['disabled', 'pausedAll', 'future_schedule', 'needs_attention', 'unknown', 'pending', 'queued'].includes(mode)) assert.equal(h.reads().length, 0);
  });
}

for (const phase of ['before_mutator', 'after_mutator']) {
  test(`stopping a quota recheck ${phase} prevents starting a new observation or send`, async t => {
    const h = await fixture(t), task = await h.seedLegacy({ updatedAt: NOW });
    h.state.allowance = true;
    h.state.records = [event('task_started', { turn_id: 'ready-to-continue' }), event('task_complete', { turn_id: 'ready-to-continue' })];
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const blocked = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const edit = h.store._editTask.bind(h.store);
    let intercepted = false;
    h.store._editTask = async (id, mutate) => {
      if (id !== task.id || intercepted) return edit(id, mutate);
      intercepted = true;
      const saved = phase === 'after_mutator' ? await edit(id, mutate) : null;
      entered(); await gate;
      return phase === 'after_mutator' ? saved : edit(id, mutate);
    };
    const recheck = h.engine.recheckQuota();
    await blocked;
    h.engine.stop();
    release(); await recheck;
    assert.equal(h.calls.length, 0, 'stop must cancel the in-flight wake before any adapter access');
    assert.equal(h.sends().length, 0);
    assert.equal(h.task(task.id).intents.length, 0);
    if (phase === 'before_mutator') assert.equal(h.task(task.id).nextAttemptAt, NOW + WEEK);
  });
}

test('stopping while a quota recheck awaits initialization cancels its wake', async t => {
  const h = await fixture(t), task = await h.seedLegacy({ updatedAt: NOW }); h.state.allowance = true;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const ensure = h.engine._ensure.bind(h.engine);
  h.engine._ensure = async () => { await ensure(); entered(); await gate; };
  const recheck = h.engine.recheckQuota(); await blocked;
  h.engine.stop(); release(); await recheck;
  assert.equal(h.calls.length, 0);
  assert.equal(h.task(task.id).nextAttemptAt, NOW + WEEK);
  assert.equal(h.task(task.id).intents.length, 0);
});
