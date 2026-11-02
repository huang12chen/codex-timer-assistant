import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskEngine, TaskStore } from '../src/core/index.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

async function removeFixture(directory, prefix) {
  const [target, temp] = await Promise.all([realpath(directory), realpath(tmpdir())]);
  assert.equal(path.dirname(target).toLowerCase(), temp.toLowerCase());
  assert.ok(path.basename(target).startsWith(prefix));
  await rm(target, { recursive: true, force: true });
}

// Sample a long-running watch using the real engine/adapter and isolated RPC
// responses. No network, desktop window, model, or real chat is involved.
test('a long watch handles both exhausted usage windows and continues only once after approval', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-timer-long-watch-'));
  const threadId = '11111111-1111-4111-8111-111111111111';
  const target = { type: 'fixed', link: `codex://threads/${threadId}` };
  const state = {
    now: 1793102400000,
    primary: 100,
    secondary: 20,
    allowed: false,
    records: [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'before-limit' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'before-limit' } }],
    queued: [],
  };
  const rpc = {
    isAlive: true,
    start: async () => {},
    close: async () => {},
    request: async (method, params) => {
      if (method === 'thread/read') return { thread: { id: threadId, path: 'isolated.jsonl', source: 'appServer' } };
      if (method === 'account/rateLimits/read') return {
        ordinaryUsageAllowed: state.allowed,
        rateLimits: { planType: 'plus',
          primary: { usedPercent: state.primary, windowDurationMins: 300, resetsAt: Math.floor((state.now + 3600000) / 1000) },
          secondary: { usedPercent: state.secondary, windowDurationMins: 10080, resetsAt: Math.floor((state.now + 86400000) / 1000) } },
      };
      if (method === 'thread/queue/add') {
        state.queued.push(params);
        return { queuedSubmission: { id: `fixture-${state.queued.length}`, clientUserMessageId: params.clientUserMessageId } };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
  const adapter = new CodexAdapter({ dependencies: {
    discover: async () => ({ path: 'codex.exe', version: '0.164.0-alpha.11.1' }),
    createRpc: () => rpc,
    readTail: async () => ({ records: state.records }),
    now: () => state.now,
  } });
  const store = new TaskStore(directory);
  const engine = new TaskEngine({ store, adapter, clock: { now: () => state.now } });
  t.after(async () => { engine.stop(); await adapter.close(); await removeFixture(directory, 'codex-timer-long-watch-'); });
  const task = await engine.createTask({ title: 'Isolated long watch', kind: 'watch', target, message: 'Continue', enabled: true, cutoffAt: null });
  const saved = () => store.snapshot().tasks.find(value => value.id === task.id);

  await engine.tick();
  assert.equal(saved().state, 'waiting_quota');
  for (let hour = 0; hour < 4; hour++) {
    state.now += 3600000;
    await engine.tick();
    assert.equal(saved().state, 'waiting_quota');
    assert.equal(state.queued.length, 0, 'an exhausted five-hour window must block sending');
  }

  // Another session has exhausted the weekly window while the short window recovered.
  state.now += 3600000;
  state.primary = 0; state.secondary = 100; state.allowed = true;
  await engine.tick();
  assert.equal(saved().state, 'waiting_quota');
  assert.equal(state.queued.length, 0, 'the exhausted weekly window still blocks an optimistic allow flag');
  for (let hour = 0; hour < 2; hour++) {
    state.now += 3600000;
    await engine.tick();
    assert.equal(saved().state, 'waiting_quota');
    assert.equal(state.queued.length, 0);
  }

  // Percentages alone are not enough; the official allow signal must be fresh.
  state.now += 15000;
  state.secondary = 0; state.allowed = false;
  await engine.tick();
  assert.equal(saved().state, 'waiting_quota');
  assert.equal(state.queued.length, 0);
  state.now += 15000; state.allowed = true;
  await engine.tick();
  assert.equal(saved().state, 'queued');
  assert.equal(state.queued.length, 1);

  const clientId = state.queued[0].clientUserMessageId;
  state.records.push({ type: 'event_msg', payload: { type: 'user_message', client_id: clientId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'continued-turn' } });
  state.now += 5000; await engine.tick();
  assert.equal(saved().state, 'running');
  assert.equal(saved().intents.at(-1).status, 'confirmed');
  for (let hour = 0; hour < 3; hour++) {
    state.now += 3600000; await engine.tick();
    assert.equal(saved().state, 'running');
    assert.equal(state.queued.length, 1, 'an active turn must not receive repeated continuations');
  }

  state.records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'continued-turn', last_agent_message: 'All agreed work is complete.\n[CODEX_TIMER_DONE]' } });
  state.now += 5000; await engine.tick();
  assert.equal(saved().state, 'completed');
  assert.equal(saved().enabled, false);
  await engine.tick();
  assert.equal(state.queued.length, 1);
});

test('a running watch keeps polling without rewriting unchanged task data on every tick', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-timer-steady-watch-'));
  const threadId = '11111111-1111-4111-8111-111111111111';
  let now = 1793102400000, reads = 0, writes = 0, turn = 'turn-1', status = 'active';
  const adapter = {
    observe: async () => { reads++; return { threadId, status, lastTurnId: turn }; },
    perform: async () => { throw new Error('A running or quota-blocked chat must never be sent to'); },
  };
  const store = new TaskStore(directory);
  await store.init();
  const write = store._write.bind(store);
  store._write = async document => { writes++; return write(document); };
  const engine = new TaskEngine({ store, adapter, clock: { now: () => now } });
  t.after(async () => { engine.stop(); await removeFixture(directory, 'codex-timer-steady-watch-'); });
  const task = await engine.createTask({ title: 'Stable watch', kind: 'watch', target: { type: 'fixed', link: `codex://threads/${threadId}` }, message: 'Continue', enabled: true, cutoffAt: null });
  writes = 0;
  for (let i = 0; i < 12; i++) { now += 5000; await engine.tick(); }
  assert.equal(reads, 12, 'the target must still be checked every time');
  assert.equal(store.snapshot().tasks[0].state, 'running');
  assert.ok(writes <= 3, `unchanged running state caused ${writes} writes in one minute`);

  now += 60000; await engine.tick();
  assert.equal(store.snapshot().tasks[0].lastObservation.observedAt, now, 'stable running state is checkpointed periodically');
  turn = 'turn-2'; now += 1000; await engine.tick();
  assert.equal(store.snapshot().tasks[0].lastObservation.lastTurnId, 'turn-2', 'a new turn must be persisted immediately');
  status = 'waiting_quota'; now += 5000; await engine.tick();
  assert.equal(store.snapshot().tasks[0].state, 'waiting_quota', 'quota blocking must be persisted immediately');
  const reloaded = new TaskStore(directory); await reloaded.init();
  assert.equal(reloaded.snapshot().tasks.find(item => item.id === task.id).state, 'waiting_quota');
});
