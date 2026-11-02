import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let core;
try { core = await import('../src/core/index.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const THREAD = '019a8421-7acf-7001-89ab-123456789abc';
const OTHER = '019a8421-7acf-7001-89ab-123456789def';
const TARGET = { type: 'fixed', link: `codex://threads/${THREAD}` };
const NOW = 1793000000000;
const delay = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, overrides = {}) {
  assert.equal(typeof core?.TaskEngine, 'function', 'task engine is not implemented');
  const dir = await mkdtemp(join(tmpdir(), 'codex-timer-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new core.TaskStore(dir);
  await store.init();
  let now = NOW;
  let observation = { threadId: THREAD, status: 'idle', lastTurnId: 'turn-1' };
  let result = { status: 'confirmed', receipt: 'receipt-1', threadId: THREAD };
  const actions = [];
  const observations = [];
  const adapter = {
    async observe(target, context) {
      observations.push({ target, context });
      return typeof observation === 'function' ? observation(target, context) : observation;
    },
    async perform(action) {
      actions.push(action);
      return typeof result === 'function' ? result(action) : result;
    },
  };
  const clock = { now: () => now };
  const engine = new core.TaskEngine({ store, adapter, clock, ...overrides });
  t.after(() => engine.stop());
  return {
    dir, store, adapter, clock, engine, actions, observations,
    advance: (ms) => { now += ms; },
    observe: (value) => { observation = value; },
    respond: (value) => { result = value; },
    task: (id) => store.snapshot().tasks.find((item) => item.id === id),
    create: (patch = {}) => engine.createTask({ title: '测试任务', kind: 'watch', target: TARGET, message: '继续完成目标', enabled: true, ...patch }),
  };
}

test('new tasks require enable; watch cutoff defaults to eight hours and can be unlimited', async (t) => {
  const h = await setup(t);
  const disabled = await h.create({ enabled: undefined });
  const unlimited = await h.create({ cutoffAt: null, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, 'paused');
  assert.equal(disabled.cutoffAt, NOW + 8 * 60 * 60 * 1000);
  assert.equal(unlimited.cutoffAt, null);
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
});

test('legacy enabled watch stop warnings are re-observed without a blind send after update', async t => {
  const h=await setup(t);const task=await h.create();
  await h.store.updateTask(task.id,{state:'needs_attention',reason:'目标回合已被停止，助手不会替本人重新启动'});
  h.observe({threadId:THREAD,status:'active',lastTurnId:'still-running'});
  const restarted=new core.TaskEngine({store:h.store,adapter:h.adapter,clock:h.clock});t.after(()=>restarted.stop());
  await restarted.tick();assert.equal(h.task(task.id).state,'running');assert.equal(h.actions.length,0);
});

test('rechecking a legacy warning preserves a real manual stop and all unrelated attention states', async t => {
  const h=await setup(t);const task=await h.create();
  await h.store.updateTask(task.id,{state:'needs_attention',reason:'目标回合已被停止，助手不会替本人重新启动'});
  h.observe({threadId:THREAD,status:'needs_attention',reason:'目标回合已被停止，助手不会替本人重新启动'});
  const restarted=new core.TaskEngine({store:h.store,adapter:h.adapter,clock:h.clock});t.after(()=>restarted.stop());
  await restarted.tick();assert.equal(h.task(task.id).state,'needs_attention');assert.equal(h.actions.length,0);
  assert.equal(h.observations.length,1);
  const disabled=await h.create({enabled:false});await h.store.updateTask(disabled.id,{state:'needs_attention',reason:'目标回合已被停止，助手不会替本人重新启动'});
  const unrelated=await h.create();await h.store.updateTask(unrelated.id,{state:'needs_attention',reason:'权限待本人审批'});
  const next=new core.TaskEngine({store:h.store,adapter:h.adapter,clock:h.clock});t.after(()=>next.stop());
  await next.tick();assert.equal(h.task(disabled.id).enabled,false);assert.equal(h.task(unrelated.id).reason,'权限待本人审批');assert.equal(h.actions.length,0);
});

test('invalid task input and mismatched fixed link ids cannot be saved', async (t) => {
  const h = await setup(t);
  for (const patch of [
    { message: '' }, { kind: 'other' }, { kind: 'once', scheduledAt: 'bad' },
    { target: { ...TARGET, threadId: OTHER } },
    { target: { type: 'current', windowId: '' } },
    { cutoffAt: NOW - 1 }, { autoAnswerOrdinary: 'yes' },
  ]) await assert.rejects(h.create(patch), { name: 'ValidationError' });
  assert.equal(h.store.snapshot().tasks.length, 0);
});

test('a once task waits until its absolute time then completes confirmed delivery exactly once', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW + 1000 });
  await h.engine.tick();
  assert.equal(h.observations.length, 0);
  h.advance(1000);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, 'send_message');
  assert.equal(h.task(task.id).state, 'completed');
  assert.equal(h.task(task.id).intents[0].status, 'confirmed');
});

test('active chats receive no additional continuation even after quota recovery', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ threadId: THREAD, status: 'waiting_quota', quota: { resetAt: NOW + 5000, source: 'official' } });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'waiting_quota');
  h.advance(5000);
  h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'turn-2' });
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'running');
});

test('quota waits until the reset, then a fresh idle observation causes one continuation', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ threadId: THREAD, status: 'waiting_quota', lastTurnId: 'turn-1', quota: { resetAt: NOW + 10000, source: 'official' } });
  await h.engine.tick();
  h.advance(9999);
  await h.engine.tick();
  assert.equal(h.observations.length, 1);
  assert.equal(h.actions.length, 0);
  h.advance(1);
  h.observe({ threadId: THREAD, status: 'idle', lastTurnId: 'turn-1' });
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).state, 'watching');
});

test('an exact reset-time task keeps waiting past a minute until quota actually recovers', async (t) => {
  const h = await setup(t, { intervalMs: 15000 });
  const task = await h.create({ kind: 'once', scheduledAt: NOW + 10000 });
  h.advance(10000);
  h.observe({ threadId: THREAD, status: 'waiting_quota', lastTurnId: 'turn-1', quota: { resetAt: NOW + 10000, source: 'official' } });
  await h.engine.tick();
  for(let i=0;i<5;i++){h.advance(15000);await h.engine.tick();assert.equal(h.actions.length,0);assert.equal(h.task(task.id).state,'waiting_quota');}
  h.observe({ threadId: THREAD, status: 'idle', lastTurnId: 'turn-1' });
  h.advance(15000);await h.engine.tick();await h.engine.tick();
  assert.equal(h.actions.length,1);
  assert.equal(h.task(task.id).state,'completed');
});

test('a completed turn continues a watch, while only explicit goal completion ends it', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ threadId: THREAD, status: 'turn_completed', lastTurnId: 'turn-1', goalCompleted: false });
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).state, 'watching');
  h.observe({ threadId: THREAD, status: 'turn_completed', lastTurnId: 'turn-2', goalCompleted: false });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  h.observe({ threadId: THREAD, status: 'idle', lastTurnId: 'turn-3', goalCompleted: true });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  assert.equal(h.task(task.id).state, 'completed');
  assert.equal(h.task(task.id).enabled, false);
  await assert.rejects(h.engine.resumeTask(task.id), { name: 'ValidationError' });
});

test('ordinary questions answer the original stable question exactly once', async (t) => {
  const h = await setup(t);
  const task = await h.create({ autoReply: '按已确认目标继续' });
  h.observe({ threadId: THREAD, status: 'waiting_user', question: { id: 'question-1', kind: 'ordinary', text: '请选择 A 或 B' } });
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, 'answer_question');
  assert.equal(h.actions[0].questionId, 'question-1');
  assert.equal(h.actions[0].message, '按已确认目标继续');
  assert.equal(h.task(task.id).state, 'waiting_user');
});

test('ordinary autoanswer can be disabled per task', async (t) => {
  const h = await setup(t);
  const task = await h.create({ autoAnswerOrdinary: false });
  h.observe({ threadId: THREAD, status: 'waiting_user', question: { id: 'q', kind: 'ordinary', text: '请选择' } });
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'waiting_user');
});

test('permission, unknown, and unidentifiable questions always require attention', async (t) => {
  for (const question of [
    { id: 'permission', kind: 'permission', text: '允许删除文件？' },
    { id: 'unknown', kind: 'unknown', text: '继续吗？' },
    { kind: 'ordinary', text: '请选择' },
  ]) {
    const h = await setup(t);
    const task = await h.create();
    h.observe({ threadId: THREAD, status: 'waiting_user', question });
    await h.engine.tick();
    assert.equal(h.actions.length, 0);
    assert.equal(h.task(task.id).state, 'needs_attention');
  }
});

test('network read errors back off and a successful read resets retry count', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe(() => { throw new Error('network offline'); });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'waiting_network');
  assert.equal(h.task(task.id).networkAttempts, 1);
  const next = h.task(task.id).nextAttemptAt;
  assert.ok(next > NOW);
  await h.engine.tick();
  assert.equal(h.observations.length, 1);
  h.advance(next - NOW);
  h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'turn-1' });
  await h.engine.tick();
  assert.equal(h.task(task.id).networkAttempts, 0);
  assert.equal(h.task(task.id).state, 'running');
});

test('unknown send results are durable attention states and cannot be resumed into a resend', async (t) => {
  const h = await setup(t);
  h.respond({ status: 'unknown', message: '发送后断开，结果待核实' });
  const task = await h.create();
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).state, 'needs_attention');
  assert.equal(h.task(task.id).intents[0].status, 'unknown');
  await assert.rejects(h.engine.resumeTask(task.id), { name: 'ValidationError' });
  await assert.rejects(h.engine.deleteTask(task.id), { name: 'ValidationError' });
});

test('a user-confirmed unknown delivery can be deleted without resending', async t => {
  const h = await setup(t); const task = await h.create({ kind: 'once', scheduledAt: NOW });
  h.respond({ status: 'unknown', threadId: THREAD, message: 'unconfirmed' });
  await h.engine.tick(); await h.engine.pauseTask(task.id);
  const intent = h.task(task.id).intents[0]; assert.equal(intent.status, 'unknown');
  await assert.rejects(h.engine.deleteTask(task.id), /待核实/);
  await assert.rejects(h.engine.confirmDelivery(task.id, OTHER), /记录已变化/);
  assert.equal(h.task(task.id).intents[0].status, 'unknown');
  await h.store.updateTask(task.id, { intents: [intent, { ...intent, id: OTHER }] });
  await assert.rejects(h.engine.confirmDelivery(task.id, intent.id), /记录已变化/);
  await h.store.updateTask(task.id, { intents: [intent] });
  await h.engine.confirmDelivery(task.id, intent.id);
  assert.equal(h.task(task.id).state, 'completed'); assert.equal(h.task(task.id).enabled, false);
  assert.equal(h.task(task.id).intents[0].confirmedByUser, true);
  await assert.rejects(h.engine.confirmDelivery(task.id, intent.id), /记录已变化/);
  await h.engine.tick(); assert.equal(h.actions.length, 1);
  await h.engine.deleteTask(task.id); assert.equal(h.task(task.id), undefined);
});

test('manual confirmation does not resolve queued sends or resume a watch', async t => {
  const h = await setup(t); const watch = await h.create();
  h.respond({ status: 'queued', receipt: 'queued', threadId: THREAD }); await h.engine.tick();
  const intent = h.task(watch.id).intents[0]; assert.equal(intent.status, 'queued');
  await assert.rejects(h.engine.confirmDelivery(watch.id, intent.id), /记录已变化/);
  await h.store.updateTask(watch.id, { intents: [{ ...intent, status: 'unknown' }], state: 'needs_attention' });
  await h.engine.confirmDelivery(watch.id, intent.id);
  assert.equal(h.task(watch.id).state, 'paused'); assert.equal(h.task(watch.id).enabled, false);
  await h.engine.tick(); assert.equal(h.actions.length, 1);
});

test('a thrown send is uncertain and never treated as a retryable network read', async (t) => {
  const h = await setup(t);
  h.respond(() => { throw new Error('socket closed after write'); });
  const task = await h.create();
  await h.engine.tick();
  h.advance(120000);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).state, 'needs_attention');
});

test('queued delivery stays queued, does not duplicate, and needs attention after confirmation timeout', async (t) => {
  const h = await setup(t, { confirmationTimeoutMs: 1000 });
  h.respond({ status: 'queued', receipt: 'queue-1' });
  const task = await h.create();
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'queued');
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  h.advance(1000);
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'needs_attention');
  assert.equal(h.actions.length, 1);
});

test('a matching delivered message resolves a queued watch and a new finished turn may continue', async (t) => {
  const h = await setup(t);
  h.respond({ status: 'queued', receipt: 'queue-1' });
  const task = await h.create();
  await h.engine.tick();
  h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'turn-2', acceptedMessageIds: [h.actions[0].id] });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'running');
  h.respond({ status: 'confirmed' });
  h.observe({ threadId: THREAD, status: 'turn_completed', lastTurnId: 'turn-2' });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  assert.equal(h.task(task.id).state, 'watching');
});

test('queued once task completes only when the exact submitted message is observed', async (t) => {
  const h = await setup(t);
  h.respond({ status: 'queued' });
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'queued');
  h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'turn-2', acceptedMessageIds: [h.actions[0].id] });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'completed');
  assert.equal(h.actions.length, 1);
});

test('unrelated new turns cannot confirm a queued message or finish a watch', async (t) => {
  for (const kind of ['once', 'watch']) {
    const h = await setup(t, { confirmationTimeoutMs: 1000 });
    h.respond({ status: 'queued', receipt: 'queue-1' });
    const task = await h.create({ kind, scheduledAt: NOW });
    await h.engine.tick();
    h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'someone-else', goalCompleted: true, acceptedMessageIds: [OTHER] });
    await h.engine.tick();
    assert.equal(h.task(task.id).state, 'queued');
    assert.equal(h.task(task.id).intents[0].status, 'queued');
    assert.equal(h.actions.length, 1);
    h.advance(1000); await h.engine.tick();
    assert.equal(h.task(task.id).state, 'needs_attention');
    assert.equal(h.task(task.id).intents[0].status, 'unknown');
    assert.equal(h.actions.length, 1);
  }
});

test('a delivered message is recorded before an immediate approval or question needs attention', async (t) => {
  for (const kind of ['once', 'watch']) {
    const h = await setup(t);
    h.respond({ status: 'queued', receipt: 'queue-1' });
    const task = await h.create({ kind, scheduledAt: NOW });
    await h.engine.tick();
    h.observe({ threadId: THREAD, status: 'needs_attention', reason: '请本人处理权限或选择', acceptedMessageIds: [h.actions[0].id] });
    await h.engine.tick();
    assert.equal(h.task(task.id).intents[0].status, 'confirmed');
    assert.equal(h.task(task.id).state, kind === 'once' ? 'completed' : 'needs_attention');
    assert.equal(h.actions.length, 1);
    if (kind === 'watch') {
      assert.equal(h.task(task.id).reason, '请本人处理权限或选择');
      await h.engine.resumeTask(task.id);
      await h.engine.tick();
      assert.equal(h.task(task.id).state, 'needs_attention');
      assert.equal(h.actions.length, 1);
    }
  }
});

test('an attention state with a missing or wrong chat identity never confirms a queued message', async (t) => {
  for (const threadId of [undefined, OTHER]) {
    const h = await setup(t);
    h.respond({ status: 'queued', receipt: 'queue-1' });
    const task = await h.create();
    await h.engine.tick();
    h.observe({ threadId, status: 'needs_attention', reason: '请核实', acceptedMessageIds: [h.actions[0].id] });
    await h.engine.tick();
    assert.equal(h.task(task.id).intents[0].status, 'queued');
    assert.equal(h.task(task.id).state, 'needs_attention');
    assert.equal(h.actions.length, 1);
  }
});

test('pausing during delivery confirmation preserves the pause and never sends again', async (t) => {
  const h = await setup(t);
  h.respond({ status: 'queued', receipt: 'queue-1' });
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.engine.tick();
  h.observe({ threadId: THREAD, status: 'needs_attention', acceptedMessageIds: [h.actions[0].id] });
  let release, observed;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { observed = resolve; });
  const edit = h.store._editTask.bind(h.store);
  let waiting = false;
  h.store._editTask = async (...args) => {
    const result = await edit(...args);
    if (!waiting && result.intents.some(intent => intent.status === 'confirmed')) {
      waiting = true; observed(); await blocked;
    }
    return result;
  };
  const tick = h.engine.tick(); await reached;
  await h.engine.pauseTask(task.id);
  release(); await tick;
  assert.equal(h.task(task.id).state, 'paused');
  assert.equal(h.task(task.id).intents[0].status, 'confirmed');
  await h.engine.resumeTask(task.id); await h.engine.tick();
  assert.equal(h.task(task.id).state, 'completed');
  assert.equal(h.actions.length, 1);
});

test('postponing during delivery confirmation does not complete the edited schedule early', async (t) => {
  const h = await setup(t);
  h.respond({ status: 'queued', receipt: 'queue-1' });
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.engine.tick();
  h.observe({ threadId: THREAD, status: 'active', acceptedMessageIds: [h.actions[0].id] });
  let release, observed;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { observed = resolve; });
  const edit = h.store._editTask.bind(h.store);
  let waiting = false;
  h.store._editTask = async (...args) => {
    const result = await edit(...args);
    if (!waiting && result.intents.some(intent => intent.status === 'confirmed')) {
      waiting = true; observed(); await blocked;
    }
    return result;
  };
  const tick = h.engine.tick(); await reached;
  await h.engine.updateTask(task.id, { scheduledAt: NOW + 60000 });
  release(); await tick;
  assert.notEqual(h.task(task.id).state, 'completed');
  await h.engine.tick(); assert.notEqual(h.task(task.id).state, 'completed');
  h.advance(60000); await h.engine.tick();
  assert.equal(h.task(task.id).state, 'completed');
  assert.equal(h.actions.length, 1);
});

test('concurrent ticks share one global flight and persist intent before sending', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.respond(async () => {
    const saved = h.task(task.id);
    assert.equal(saved.intents.length, 1);
    assert.equal(saved.intents[0].status, 'pending');
    await gate;
    return { status: 'confirmed' };
  });
  const first = h.engine.tick();
  const second = h.engine.tick();
  while (h.actions.length === 0) await delay();
  assert.equal(h.actions.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(h.actions.length, 1);
});

test('two due tasks for the same target cannot both send in one tick', async (t) => {
  const h = await setup(t);
  await h.create({ kind: 'once', scheduledAt: NOW });
  const second = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(second.id).state, 'queued');
});

test('fixed target identity mismatches block sending', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ threadId: OTHER, status: 'idle', lastTurnId: 'turn-1' });
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'needs_attention');
});

test('current target follows a newly displayed chat only in the selected verified window', async (t) => {
  const h = await setup(t);
  const task = await h.create({ target: { type: 'current', windowId: 'window-A', confirmedThreadId: THREAD } });
  h.observe({ threadId: OTHER, windowId: 'window-A', status: 'idle', lastTurnId: 'other-turn-1' });
  h.respond({ status: 'confirmed', threadId: OTHER });
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].threadId, OTHER);
  assert.equal(h.task(task.id).state, 'watching');
  const wrong = await h.create({ target: { type: 'current', windowId: 'window-B', confirmedThreadId: THREAD } });
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(wrong.id).state, 'needs_attention');
});

test('pausing during an issued send preserves the eventual receipt without re-enabling the task', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.respond(async () => { await gate; return { status: 'confirmed', receipt: 'late-receipt' }; });
  const tick = h.engine.tick();
  while (h.actions.length === 0) await delay();
  await h.engine.pauseTask(task.id);
  release();
  await tick;
  assert.equal(h.task(task.id).state, 'paused');
  assert.equal(h.task(task.id).enabled, false);
  assert.equal(h.task(task.id).intents[0].receipt, 'late-receipt');
});

test('cutoff expires assistant intervention before observation and never marks a goal complete', async (t) => {
  const h = await setup(t);
  const task = await h.create({ cutoffAt: NOW + 1 });
  h.advance(1);
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.observations.length, 0);
  assert.equal(h.task(task.id).state, 'expired');
  assert.equal(h.task(task.id).enabled, false);
});

test('restart surfaces missed once schedules and unfinished intents without auto-sending', async (t) => {
  const h = await setup(t);
  const once = await h.create({ kind: 'once', scheduledAt: NOW + 1000 });
  const watch = await h.create();
  await h.store.updateTask(watch.id, { state: 'queued', intents: [{ id: 'intent-1', status: 'pending', eventKey: 'watch:first', intendedAt: NOW, type: 'send_message', threadId: THREAD }] });
  h.advance(2000);
  const recovered = new core.TaskEngine({ store: h.store, adapter: h.adapter, clock: h.clock });
  await recovered.tick();
  assert.equal(h.task(once.id).state, 'needs_attention');
  assert.equal(h.task(watch.id).state, 'needs_attention');
  assert.equal(h.task(watch.id).intents[0].status, 'unknown');
  assert.equal(h.actions.length, 0);
});

test('global pause skips adapter access and task edits do not restart completed tasks', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.store.updateSettings({ pausedAll: true });
  await h.engine.tick();
  assert.equal(h.observations.length, 0);
  await h.store.updateSettings({ pausedAll: false });
  await h.engine.tick();
  await h.engine.updateTask(task.id, { title: '重命名' });
  assert.equal(h.task(task.id).state, 'completed');
  await assert.rejects(h.engine.updateTask(task.id, { enabled: true }), { name: 'ValidationError' });
  await h.engine.deleteTask(task.id);
  assert.equal(h.task(task.id), undefined);
});

test('start and stop manage the scheduler without issuing an unsolicited initial send', async (t) => {
  let callback;
  let cleared = false;
  const fakeClock = { now: () => NOW, setInterval(fn) { callback = fn; return 42; }, clearInterval(id) { cleared = id === 42; } };
  const h = await setup(t, { clock: fakeClock });
  await h.create();
  await h.engine.start();
  assert.equal(h.engine.snapshot().engine.running, true);
  assert.equal(h.actions.length, 0);
  assert.equal(typeof callback, 'function');
  h.engine.stop();
  assert.equal(cleared, true);
  assert.equal(h.engine.snapshot().engine.running, false);
});

test('unsupported observations retain their concrete reason even without a readable thread id', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ status: 'needs_attention', reason: '当前客户端不支持 readThread，请使用受支持版本' });
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).reason, '当前客户端不支持 readThread，请使用受支持版本');
});

test('deleting a task during a pending observation finishes the tick without sending', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.observe(async () => { await gate; return { threadId: THREAD, status: 'idle', lastTurnId: 't' }; });
  const tick = h.engine.tick();
  while (h.observations.length === 0) await delay();
  await h.engine.deleteTask(task.id);
  release();
  await tick;
  assert.equal(h.actions.length, 0);
  assert.equal(h.engine.snapshot().engine.lastError, null);
});

test('stop during intent persistence prevents a new adapter action and records a truthful cancellation', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  h.engine.stop();
  release();
  await tick;
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  assert.equal(h.task(task.id).intents[0].receipt, undefined);
});

test('permission-bearing ordinary questions cannot be autoanswered because their kind says ordinary', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.observe({ threadId: THREAD, status: 'needs_attention', reason: '需要用户批准', question: { id: 'approval', kind: 'ordinary', text: '允许写入受限目录？' } });
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'needs_attention');
});

test('disabling an already completed task cannot erase its terminal state and re-arm it', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'completed');
  await h.engine.pauseTask(task.id);
  assert.equal(h.task(task.id).state, 'completed');
  await assert.rejects(h.engine.resumeTask(task.id), { name: 'ValidationError' });
  assert.equal(h.actions.length, 1);
});

test('pausing while an intent is being persisted prevents a not-yet-issued action', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  const paused = h.engine.pauseTask(task.id);
  release();
  await Promise.all([tick, paused]);
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'paused');
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
});

test('restart surfaces every enabled missed once task with no send intent, across prior waiting states', async (t) => {
  for (const state of ['waiting_network', 'waiting_quota', 'running', 'waiting_user']) {
    const h = await setup(t);
    const task = await h.create({ kind: 'once', scheduledAt: NOW + 1000 });
    await h.store.updateTask(task.id, { state });
    h.advance(2000);
    const recovered = new core.TaskEngine({ store: h.store, adapter: h.adapter, clock: h.clock });
    await recovered.tick();
    assert.equal(h.task(task.id).state, 'needs_attention', state);
    assert.equal(h.actions.length, 0, state);
  }
});

test('confirming a queued ordinary answer never completes the original once scheduled message', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  h.observe({ threadId: THREAD, status: 'waiting_user', lastTurnId: 'turn-1', question: { id: 'q', kind: 'ordinary', text: '请选择' } });
  h.respond({ status: 'queued', receipt: 'answer-queue' });
  await h.engine.tick();
  assert.equal(h.actions[0].type, 'answer_question');
  h.observe({ threadId: THREAD, status: 'active', lastTurnId: 'turn-2', acceptedMessageIds: [h.actions[0].id] });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'running');
  assert.equal(h.task(task.id).enabled, true);
  assert.equal(h.actions.length, 1);
  h.respond({ status: 'confirmed' });
  h.observe({ threadId: THREAD, status: 'turn_completed', lastTurnId: 'turn-2' });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions[1].type, 'send_message');
  assert.equal(h.task(task.id).state, 'completed');
});

test('deletion cannot erase an unresolved intent that is still being atomically written', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  const deleted = h.engine.deleteTask(task.id);
  const rejected = assert.rejects(deleted, { name: 'ValidationError', code: 'UNRESOLVED_INTENT' });
  await delay();
  release();
  await Promise.all([tick, rejected]);
  assert.ok(h.task(task.id));
  assert.equal(h.task(task.id).intents.length, 1);
  assert.equal(h.engine.snapshot().engine.lastError, null);
});

test('postponing a once schedule during observation prevents an early send', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.observe(async () => { await gate; return { threadId: THREAD, status: 'idle', lastTurnId: 't' }; });
  const tick = h.engine.tick();
  while (h.observations.length === 0) await delay();
  await h.engine.updateTask(task.id, { scheduledAt: NOW + 60000 });
  release();
  await tick;
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'scheduled');
});

test('postponing during intent persistence cancels only the unissued action and honors the new due time', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  const edited = h.engine.updateTask(task.id, { scheduledAt: NOW + 60000 });
  release();
  await Promise.all([tick, edited]);
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  h.advance(60000);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).state, 'completed');
});

test('cutoff reached during durable intent write immediately expires an unissued operation', async (t) => {
  const h = await setup(t);
  const task = await h.create({ cutoffAt: NOW + 1 });
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  h.advance(1);
  release();
  await tick;
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).state, 'expired');
  assert.equal(h.task(task.id).enabled, false);
  await h.engine.pauseTask(task.id);
  assert.equal(h.task(task.id).state, 'expired');
});

test('a rejected schedule edit cannot leave a hidden pause request behind', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  await assert.rejects(h.engine.updateTask(task.id, { enabled: false, scheduledAt: 'bad-date' }), { name: 'ValidationError' });
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.task(task.id).enabled, true);
});

test('a schedule edit cannot postpone a watch beyond its existing cutoff', async (t) => {
  const h = await setup(t);
  const task = await h.create({ cutoffAt: NOW + 5000 });
  await assert.rejects(h.engine.updateTask(task.id, { scheduledAt: NOW + 10000 }), { name: 'ValidationError' });
  assert.equal(h.task(task.id).scheduledAt, NOW);
});

test('a cancelled, never-issued once intent still requires missed-schedule attention on restart', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW + 1000 });
  await h.store.updateTask(task.id, { intents: [{ id: 'cancelled-1', eventKey: `once:${task.id}`, type: 'send_message', threadId: THREAD, status: 'cancelled', intendedAt: NOW }] });
  h.advance(2000);
  const recovered = new core.TaskEngine({ store: h.store, adapter: h.adapter, clock: h.clock });
  await recovered.tick();
  assert.equal(h.task(task.id).state, 'needs_attention');
  assert.equal(h.actions.length, 0);
});

test('an answered question does not count as delivery of a missed once schedule after restart', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW + 1000 });
  await h.store.updateTask(task.id, { state: 'waiting_user', intents: [{ id: 'answer-1', eventKey: 'q1', type: 'answer_question', threadId: THREAD, status: 'confirmed', intendedAt: NOW }] });
  h.advance(2000);
  const recovered = new core.TaskEngine({ store: h.store, adapter: h.adapter, clock: h.clock });
  await recovered.tick();
  assert.equal(h.task(task.id).state, 'needs_attention');
  assert.equal(h.actions.length, 0);
});

test('global pause stops immediately before persisting settings, then explicit resume may restart', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  let writing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = h.store._write.bind(h.store);
  h.store._write = async (document) => {
    if (!writing && document.tasks.some((item) => item.intents.some((intent) => intent.status === 'pending'))) {
      writing = true;
      await gate;
    }
    return write(document);
  };
  const tick = h.engine.tick();
  while (!writing) await delay();
  h.engine.stop();
  const paused = h.store.updateSettings({ pausedAll: true });
  await delay();
  release();
  await Promise.all([tick, paused]);
  assert.equal(h.actions.length, 0);
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  assert.equal(h.store.snapshot().settings.pausedAll, true);
  assert.equal(h.engine.snapshot().engine.running, false);
  await h.engine.tick();
  assert.equal(h.actions.length, 0);
  await h.store.updateSettings({ pausedAll: false });
  await h.engine.start();
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.engine.snapshot().engine.running, true);
});

test('proven pre-write active refusal cancels its intent and later permits one successful send', async (t) => {
  const h = await setup(t);
  const task = await h.create({ kind: 'once', scheduledAt: NOW });
  h.respond({ status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'running', message: '第二次检查发现聊天正在运行', receipt: 'must-not-be-saved' });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'running');
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  assert.equal(h.task(task.id).intents[0].receipt, undefined);
  assert.ok(h.task(task.id).nextAttemptAt > NOW);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  h.advance(h.task(task.id).nextAttemptAt - NOW);
  h.respond({ status: 'confirmed', threadId: THREAD });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  assert.equal(h.task(task.id).state, 'completed');
  assert.deepEqual(h.task(task.id).intents.map((intent) => intent.status), ['cancelled', 'confirmed']);
});

test('pre-write network refusals back off across successful observations then recover safely', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.respond({ status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'waiting_network', message: '第二次检查遇到网络中断' });
  await h.engine.tick();
  const first = h.task(task.id);
  assert.equal(first.state, 'waiting_network');
  assert.equal(first.networkAttempts, 1);
  assert.equal(first.nextAttemptAt, NOW + 1000);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  h.advance(1000);
  await h.engine.tick();
  const second = h.task(task.id);
  assert.equal(second.networkAttempts, 2);
  assert.equal(second.nextAttemptAt, NOW + 1000 + 2000);
  h.advance(2000);
  h.respond({ status: 'confirmed', threadId: THREAD });
  await h.engine.tick();
  assert.equal(h.task(task.id).networkAttempts, 0);
  assert.deepEqual(h.task(task.id).intents.map((intent) => intent.status), ['cancelled', 'cancelled', 'confirmed']);
});

test('proven pre-write quota refusal bounds its retry time and rechecks after fifteen seconds', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.respond({ status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'waiting_quota', retryAt: NOW + 60000, message: '额度尚未恢复' });
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'waiting_quota');
  assert.equal(h.task(task.id).nextAttemptAt, NOW + 15000);
  h.advance(14999);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.observations.length, 1);
  h.advance(1);
  h.observe({ threadId: THREAD, status: 'waiting_quota', quota: { source: 'official', resetAt: NOW + 60000 } });
  await h.engine.tick();
  assert.equal(h.observations.length, 2);
  assert.equal(h.actions.length, 1);
});

test('proven pre-write attention refusal stays cancelled and waits for manual handling', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  h.respond({ status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'needs_attention', message: '选定窗口已经切换聊天，请重新核对' });
  await h.engine.tick();
  h.advance(120000);
  await h.engine.tick();
  assert.equal(h.task(task.id).state, 'needs_attention');
  assert.equal(h.task(task.id).intents[0].status, 'cancelled');
  assert.equal(h.actions.length, 1);
});

test('pre-write outcome proof never overrides a pause or cutoff while adapter is pending', async (t) => {
  for (const control of ['pause', 'cutoff', 'stop']) {
    const h = await setup(t);
    const task = await h.create(control === 'cutoff' ? { cutoffAt: NOW + 1 } : {});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.respond(async () => { await gate; return { status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'waiting_network', message: '没有执行写入' }; });
    const tick = h.engine.tick();
    while (h.actions.length === 0) await delay();
    if (control === 'pause') await h.engine.pauseTask(task.id);
    if (control === 'cutoff') h.advance(1);
    if (control === 'stop') h.engine.stop();
    release();
    await tick;
    assert.equal(h.task(task.id).intents[0].status, 'cancelled', control);
    if (control === 'pause') assert.equal(h.task(task.id).state, 'paused');
    if (control === 'cutoff') assert.equal(h.task(task.id).state, 'expired');
    await h.engine.tick();
    assert.equal(h.actions.length, 1, control);
  }
});

test('unproven or mismatched not_sent results remain unknown and can never auto-retry', async (t) => {
  for (const result of [
    { status: 'not_sent', threadId: THREAD, retryState: 'running' },
    { status: 'not_sent', possibleWrite: true, threadId: THREAD, retryState: 'running' },
    { status: 'not_sent', possibleWrite: false, threadId: OTHER, retryState: 'running' },
    { status: 'not_sent', possibleWrite: false, retryState: 'running' },
    { status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'invalid' },
  ]) {
    const h = await setup(t);
    const task = await h.create();
    h.respond(result);
    await h.engine.tick();
    h.advance(120000);
    await h.engine.tick();
    assert.equal(h.task(task.id).state, 'needs_attention');
    assert.equal(h.task(task.id).intents[0].status, 'unknown');
    assert.equal(h.actions.length, 1);
    await assert.rejects(h.engine.resumeTask(task.id), { name: 'ValidationError' });
  }
});

test('stopping during a proven attention refusal cannot turn it into an automatic retry', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.respond(async () => { await gate; return { status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'needs_attention', message: '需要本人处理' }; });
  const tick = h.engine.tick();
  while (h.actions.length === 0) await delay();
  h.engine.stop();
  release();
  await tick;
  assert.equal(h.task(task.id).state, 'needs_attention');
  h.advance(120000);
  await h.engine.tick();
  assert.equal(h.actions.length, 1);
});

test('a proven refusal preserves a distinct quota event even if an older send handled the same turn', async (t) => {
  const h = await setup(t);
  const task = await h.create();
  await h.engine.tick();
  h.observe({ threadId: THREAD, status: 'waiting_quota', lastTurnId: 'turn-1', quota: { resetAt: NOW + 1, source: 'official', eventId: 'quota-1' } });
  await h.engine.tick();
  h.advance(1);
  h.observe({ threadId: THREAD, status: 'idle', lastTurnId: 'turn-1' });
  h.respond({ status: 'not_sent', possibleWrite: false, threadId: THREAD, retryState: 'waiting_network', message: '第二次检查前断网，尚未写入' });
  await h.engine.tick();
  assert.equal(h.actions.length, 2);
  h.advance(1000);
  h.respond({ status: 'confirmed', threadId: THREAD });
  await h.engine.tick();
  assert.equal(h.actions.length, 3);
  assert.equal(h.actions[1].eventKey, h.actions[2].eventKey);
  assert.equal(h.task(task.id).blocker, null);
  assert.deepEqual(h.task(task.id).intents.map((intent) => intent.status), ['confirmed', 'cancelled', 'confirmed']);
});
