import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { TaskEngine, TaskStore } from '../src/core/index.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const actionId = '33333333-3333-4333-8333-333333333333';
const fixed = { type: 'fixed', threadId: id, link: `codex://threads/${id}` };
const current = { type: 'current', windowId: 'window-identity', confirmedThreadId: id };
const event = (type, fields = {}) => ({ type: 'event_msg', timestamp: '2026-10-27T12:00:00Z', payload: { type, ...fields } });

function fixture({ records = [event('task_complete', { turn_id: 'turn-1' })], allowance = true, metadataId = id, nativeId = id, queueError = null, turn = null, readError = null, source = 'appServer' } = {}) {
  const calls = []; const state = { records, allowance, metadataId, nativeId, usedPercent:20, quotaError:null, quotaEmpty:false, onCapture:null };
  const rpc = { isAlive: true, start: async () => {}, close: async () => {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id, name: '项目', cwd: 'C:\\project', source, status: { type: 'notLoaded' } }], nextCursor: null };
    if (method === 'account/rateLimits/read') {if(state.quotaError)throw state.quotaError;if(state.quotaEmpty)return {ordinaryUsageAllowed:null,rateLimits:null};return { ordinaryUsageAllowed: state.allowance, rateLimits: { planType: 'plus', primary: { usedPercent: state.usedPercent, resetsAt: 1793100000 } } };}
    if (method === 'thread/read') { if (readError) throw readError; return { thread: { id: state.metadataId, path: 'fixture.jsonl', source, status: { type: 'notLoaded' } } }; }
    if (method === 'thread/turns/list') return { data: turn ? [turn] : [], nextCursor: null };
    if (method === 'thread/queue/add') { if (queueError) throw queueError; return { queuedSubmission: { id: 'queue-receipt', clientUserMessageId: params.clientUserMessageId } }; }
    throw new Error(`unexpected method ${method}`);
  } };
  const adapter = new CodexAdapter({ settings: () => ({}), nativeScript: 'windows.ps1', dependencies: {
    discover: async () => ({ path: 'C:\\Codex\\codex.exe', version: '0.164.0-alpha.11.1' }), createRpc: () => rpc,
    readTail: async () => ({ records: state.records }),
    native: async (command) => { if(command==='CaptureLink'){state.onCapture?.();return { threadId: state.nativeId, link: `codex://threads/${state.nativeId}`, windowId: 'window-identity' };} return command === 'ListWindows' ? { windows: [{ id: 'window-identity', title: 'Codex' }], desktop: null } : { desktop: null }; },
    now: () => 1793102400000,
  } });
  return { adapter, calls, state };
}

test('diagnose is real RPC discovery; sanitized status does not disclose account or transcript', async () => {
  const { adapter, calls } = fixture(); await adapter.diagnose();
  const status = adapter.status(); assert.equal(status.connected, true); assert.equal(status.plan, 'plus');
  assert.equal(status.capabilities.answerQuestion, false);
  assert.ok(calls.some(call => call.method === 'account/rateLimits/read'));
  const text = JSON.stringify(status); assert.ok(!text.includes('fixture.jsonl')); assert.ok(!text.includes('accessToken'));
  await adapter.close();
});
test('unconfirmed account quota cannot appear connected or ready, and recovers after a successful recheck', async () => {
  const {adapter,state}=fixture();
  state.quotaError=new Error('codex account authentication required to read rate limits');
  const refused=await adapter.diagnose();
  assert.equal(refused.connected,false);
  assert.equal(refused.capabilities.sendMessage,false);
  assert.equal(refused.capabilities.readQuota,false);
  assert.match(refused.message,/登录|额度|连接/);
  state.quotaError=null;
  const recovered=await adapter.refreshQuota();
  assert.equal(recovered.connected,true);
  assert.equal(recovered.capabilities.sendMessage,true);
  assert.equal(recovered.capabilities.readQuota,true);
  await adapter.close();
});
test('thread list uses bounded state-db reads and no subagents', async () => {
  const { adapter, calls } = fixture(); const threads = await adapter.listThreads({ query: '项目' });
  assert.equal(threads[0].link, `codex://threads/${id}`);
  const request = calls.find(call => call.method === 'thread/list').params;
  assert.equal(request.useStateDbOnly, true); assert.ok(request.limit <= 100); assert.ok(!request.sourceKinds?.some(value => value.startsWith('subAgent')));
  await adapter.close();
});

test('quota can refresh with no task and becomes visibly stale after its freshness window', async () => {
  const {adapter,state,calls}=fixture();
  await adapter.refreshQuota();state.usedPercent=67;await adapter.refreshQuota();
  assert.equal(adapter.status().quota.primary.usedPercent,67);
  assert.equal(adapter.status().quota.stale,false);
  assert.equal(calls.filter(c=>c.method==='account/rateLimits/read').length,2);
  adapter.now=()=>1793102446000;
  assert.equal(adapter.status().quota.stale,true);
  await adapter.close();
});

test('concurrent quota refreshes share one official read and failed refresh hides old percentages', async () => {
  const {adapter,state,calls}=fixture();
  await Promise.all([adapter.refreshQuota(),adapter.refreshQuota(),adapter.refreshQuota()]);
  assert.equal(calls.filter(c=>c.method==='account/rateLimits/read').length,1);
  state.quotaError=Object.assign(new Error('offline'),{code:'RPC_TIMEOUT'});
  await assert.rejects(adapter.refreshQuota(),/offline/);
  const status=adapter.status();
  assert.equal(status.quota.primary,null);assert.equal(status.quota.secondary,null);
  assert.equal(status.quota.stale,true);assert.equal(status.capabilities.readQuota,false);
  await adapter.close();
});
test('notLoaded metadata does not override observed active nor invent idle from missing rollout', async () => {
  const a = fixture({ records: [event('task_started', { turn_id: 'turn-active' })] });
  assert.equal((await a.adapter.observe(fixed, { task: {} })).status, 'active'); await a.adapter.close();
  const b = fixture({ records: [] }); assert.equal((await b.adapter.observe(fixed, { task: {} })).status, 'unknown'); await b.adapter.close();
});
test('only the exact queued client id in a user-message event proves acceptance', async () => {
  const task = { id: 'watch-task', kind: 'watch', intents: [{ id: actionId, threadId: id, status: 'queued', type: 'send_message' }] };
  const { adapter, state } = fixture({ records: [event('task_started', { turn_id: 'new-turn' }), event('user_message', { client_id: other })] });
  assert.deepEqual((await adapter.observe(fixed, { task })).acceptedMessageIds ?? [], []);
  state.records.push({ type: 'response_item', payload: { type: 'message', role: 'user', client_id: actionId } });
  assert.deepEqual((await adapter.observe(fixed, { task })).acceptedMessageIds ?? [], []);
  state.records.push(event('user_message', { client_id: actionId }));
  assert.deepEqual((await adapter.observe(fixed, { task })).acceptedMessageIds, [actionId]);
  const otherTask = { ...task, intents: [{ ...task.intents[0], threadId: other }] };
  assert.deepEqual((await adapter.observe(fixed, { task: otherTask })).acceptedMessageIds ?? [], []);
  await adapter.close();
});
test('fixed read must identify the exact requested UUID', async () => {
  const { adapter, calls } = fixture({ metadataId: other });
  const observed = await adapter.observe(fixed, { task: {} }); assert.equal(observed.status, 'needs_attention');
  const refused = await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续' });
  assert.equal(refused.status, 'not_sent'); assert.equal(refused.possibleWrite, false); assert.match(refused.message, /聊天/u);
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
});
test('current mode follows selected window and recaptures immediately before sending', async () => {
  const { adapter, calls, state } = fixture();
  const observed = await adapter.observe(current, { task: {} }); assert.equal(observed.threadId, id); assert.equal(observed.windowId, current.windowId);
  state.nativeId = other;
  const refused = await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: current, message: '继续' });
  assert.equal(refused.status, 'not_sent'); assert.equal(refused.retryState, 'needs_attention'); assert.match(refused.message, /切换/u);
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
});
test('active and explicit quota-false preflight never submit queue writes', async () => {
  for (const options of [{ records: [event('task_started', { turn_id: 'active' })] }, { allowance: false }]) {
    const { adapter, calls } = fixture(options);
    const refused = await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续' });
    assert.equal(refused.status, 'not_sent'); assert.equal(refused.possibleWrite, false);
    assert.equal(refused.retryState, options.allowance === false ? 'waiting_quota' : 'running');
    assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
  }
});
test('missing official allowance blocks first-time queue writes even without a prior quota blocker', async () => {
  for (const empty of [false, true]) {
    const {adapter,calls,state}=fixture({allowance:null});state.quotaEmpty=empty;
    const result=await adapter.perform({id:actionId,type:'send_message',threadId:id,target:fixed,message:'继续'});
    assert.equal(result.status,'not_sent');assert.equal(result.possibleWrite,false);
    assert.equal(result.retryState,'waiting_quota');
    assert.equal(calls.filter(call=>call.method==='thread/queue/add').length,0);
    await adapter.close();
  }
});
test('quota becoming unknown, stale or exhausted during target recapture prevents queue writes', async () => {
  for (const mode of ['unknown','stale','weekly_exhausted']) {
    const {adapter,calls,state}=fixture();let captures=0;
    state.onCapture=()=>{if(++captures!==2)return;
      if(mode==='unknown')adapter.quotaCache.ordinaryUsageAllowed=null;
      else if(mode==='stale')adapter.now=()=>1793102446000;
      else adapter.quotaCache.secondary={usedPercent:100,resetAt:1793700000000};
    };
    const result=await adapter.perform({id:actionId,type:'send_message',threadId:id,target:current,message:'继续'});
    assert.equal(result.status,'not_sent');assert.equal(result.retryState,'waiting_quota');
    assert.equal(calls.filter(call=>call.method==='thread/queue/add').length,0);
    await adapter.close();
  }
});
test('quota errors recover only on fresh official true; null percentages are not recovery', async () => {
  const { adapter, state } = fixture({ allowance: null, records: [event('error', { codex_error_info: 'usageLimitExceeded' }), event('task_complete', { turn_id: 'turn-1' })] });
  assert.equal((await adapter.observe(fixed, { task: {} })).status, 'waiting_quota');
  state.records = [event('task_complete', { turn_id: 'turn-1' })];
  assert.equal((await adapter.observe(fixed, { task: {} })).status, 'waiting_quota');
  state.allowance = true;
  assert.equal((await adapter.observe(fixed, { task: { state: 'waiting_quota' } })).status, 'turn_completed');
  await adapter.close();
});
test('a queue acknowledgement is queued, carries the persistent id, and is never duplicated', async () => {
  const { adapter, calls } = fixture();
  const action = { id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续；$(x)' };
  const result = await adapter.perform(action); assert.equal(result.status, 'queued'); assert.equal(result.receipt, 'queue-receipt');
  assert.deepEqual(calls.find(call => call.method === 'thread/queue/add').params, { threadId: id, clientUserMessageId: actionId, input: [{ type: 'text', text: action.message, text_elements: [] }] });
  assert.deepEqual(await adapter.perform(action), result);
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1); await adapter.close();
});
test('uncertain queue error never retries; ordinary input cannot be faked by a queued message', async () => {
  const { adapter, calls } = fixture({ queueError: Object.assign(new Error('timeout after write'), { possibleWrite: true, code: 'RPC_TIMEOUT' }) });
  const action = { id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续' };
  assert.equal((await adapter.perform(action)).status, 'unknown');
  assert.equal((await adapter.perform(action)).status, 'unknown');
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1);
  const refused = await adapter.perform({ ...action, id: other, type: 'answer_question', questionId: 'ordinary-choice' });
  assert.equal(refused.status, 'not_sent'); assert.equal(refused.possibleWrite, false); assert.match(refused.message, /普通问题/u);
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1); await adapter.close();
});
test('bounded official persisted turn summary recovers a missing tail boundary without runtime idle', async () => {
  for (const [status, expected] of [['inProgress', 'active'], ['completed', 'turn_completed'], ['interrupted', 'needs_attention']]) {
    const { adapter, calls } = fixture({ records: [], turn: { id: 'summary-turn', status, completedAt: status === 'completed' ? 1793100000 : null, items: [] } });
    const observation = await adapter.observe(fixed, { task: {} });
    assert.equal(observation.status, expected); assert.equal(observation.lastTurnId, 'summary-turn');
    const params = calls.find(call => call.method === 'thread/turns/list').params;
    assert.equal(params.limit, 1); assert.equal(params.itemsView, 'notLoaded');
    await adapter.close();
  }
});
test('watch messages add completion and decision rules while once messages stay exact', async () => {
  const { adapter, calls } = fixture();
  await adapter.observe(fixed, { task: { id: 'watch-task', kind: 'watch', message: '继续', autoReply: '请自行选择合理方案', intents: [] } });
  await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, taskId: 'watch-task', message: '继续' });
  const body = calls.find(call => call.method === 'thread/queue/add').params.input[0].text;
  assert.match(body, /\[CODEX_TIMER_DONE\]/u); assert.match(body, /请自行选择合理方案/u);
  await adapter.close();
});
test('English watch instruction preserves the user message and the completion marker', async () => {
  const { adapter, calls } = fixture(); adapter.settings = () => ({ language: 'en' });
  await adapter.observe(fixed, { task: { id: 'watch-task', kind: 'watch', message: 'Continue this project', intents: [] } });
  await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, taskId: 'watch-task', message: 'Continue this project' });
  const body = calls.find(call => call.method === 'thread/queue/add').params.input[0].text;
  assert.ok(body.startsWith('Continue this project')); assert.match(body, /last line of the final reply/u); assert.match(body, /\[CODEX_TIMER_DONE\]/u);
  await adapter.close();
});
test('concurrent adapter reads wait for initialize completion', async () => {
  let ready = false, release;
  const barrier = new Promise(resolve => { release = () => { ready = true; resolve(); }; });
  const rpc = { isAlive: false, start: async () => { rpc.isAlive = true; await barrier; }, close: async () => {}, request: async () => { assert.equal(ready, true); return { data: [], nextCursor: null }; } };
  const adapter = new CodexAdapter({ dependencies: { discover: async () => ({ path: 'codex.exe', version: '0.164.0' }), createRpc: () => rpc } });
  const first = adapter.listThreads(); await new Promise(resolve => setTimeout(resolve, 2));
  const second = adapter.listThreads(); setTimeout(release, 5);
  await Promise.all([first, second]); await adapter.close();
});
test('completion-marker agreement is scoped to delivery in the exact observed chat', async () => {
  const { adapter } = fixture({ records: [event('task_complete', { turn_id: 'turn-marker', last_agent_message: '完成。\n[CODEX_TIMER_DONE]' })] });
  const task = { id: 'follow-watch', kind: 'watch', message: '最后输出 [CODEX_TIMER_DONE]', intents: [{ type: 'send_message', status: 'confirmed', threadId: other }] };
  assert.equal((await adapter.observe(current, { task })).goalCompleted, false);
  task.intents.push({ type: 'send_message', status: 'confirmed', threadId: id });
  assert.equal((await adapter.observe(current, { task })).goalCompleted, true);
  await adapter.close();
});
test('summary completion retains a same-turn final assistant marker and rejects a newer tail turn', async () => {
  const final = { timestamp: '2026-10-27T11:59:59Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '所有目标完成。\n[CODEX_TIMER_DONE]' }] } };
  const turn = { id: 'summary-turn', status: 'completed', completedAt: 1793102400, items: [] };
  const task = { id: 'watch', kind: 'watch', intents: [{ type: 'send_message', status: 'confirmed', threadId: id }] };
  const a = fixture({ records: [{ type: 'turn_context', payload: { turn_id: 'summary-turn' } }, final], turn });
  assert.equal((await a.adapter.observe(fixed, { task })).goalCompleted, true); await a.adapter.close();
  const b = fixture({ records: [{ type: 'turn_context', payload: { turn_id: 'newer-turn' } }, final], turn });
  assert.equal((await b.adapter.observe(fixed, { task })).status, 'unknown'); await b.adapter.close();
});
test('known unsupported ordinary questions stop before an answer intent can be created', async () => {
  const args = JSON.stringify({ questions: [{ id: 'style', question: '选择配色？', options: [{ label: '蓝色' }, { label: '绿色' }] }] });
  const { adapter, calls } = fixture({ records: [event('task_started', { turn_id: 'question-turn' }), { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'pending-q', arguments: args } }] });
  const observed = await adapter.observe(fixed, { task: { kind: 'watch' } });
  assert.equal(observed.status, 'needs_attention'); assert.equal(observed.question.kind, 'ordinary'); assert.match(observed.reason, /普通选择题/u);
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
});
test('a network failure during read-only preflight proves no send and remains retryable', async () => {
  const { adapter, calls } = fixture({ readError: Object.assign(new Error('connection lost before sending'), { code: 'RPC_TIMEOUT', possibleWrite: false }) });
  const result = await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续' });
  assert.equal(result.status, 'not_sent'); assert.equal(result.possibleWrite, false); assert.equal(result.threadId, id); assert.equal(result.retryState, 'waiting_network');
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
});
test('real SessionSource subAgent union is excluded from both listing and direct fixed sends', async () => {
  const { adapter, calls } = fixture({ source: { subAgent: { thread_spawn: { parent_thread_id: other, depth: 1 } } } });
  assert.deepEqual(await adapter.listThreads(), []);
  const observation = await adapter.observe(fixed, { task: {} }); assert.equal(observation.status, 'needs_attention');
  const result = await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, message: '继续' });
  assert.equal(result.status, 'not_sent'); assert.equal(result.possibleWrite, false); assert.equal(result.retryState, 'needs_attention');
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0); await adapter.close();
});
test('watch decision-rule delegation honors both task and global ordinary-answer disable', async () => {
  for (const globalOff of [false, true]) {
    const { adapter, calls } = fixture();
    if (globalOff) adapter.settings = () => ({ autoAnswerOrdinary: false });
    await adapter.observe(fixed, { task: { id: 'watch-task', kind: 'watch', autoReply: 'UNIQUE_DISABLED_RULE', autoAnswerOrdinary: globalOff, intents: [] } });
    await adapter.perform({ id: actionId, type: 'send_message', threadId: id, target: fixed, taskId: 'watch-task', message: '继续' });
    const body = calls.find(call => call.method === 'thread/queue/add').params.input[0].text;
    assert.ok(body.includes('[CODEX_TIMER_DONE]')); assert.ok(!body.includes('UNIQUE_DISABLED_RULE'));
    await adapter.close();
  }
});
test('real adapter and engine recover a pre-write read failure without an unknown intent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-timer-combined-'));
  const { adapter, calls } = fixture(); await adapter.diagnose();
  const original = adapter.rpc.request; let reads = 0;
  adapter.rpc.request = async (method, params) => {
    if (method === 'thread/read' && ++reads === 2) throw Object.assign(new Error('preflight read timeout'), { code: 'RPC_TIMEOUT', possibleWrite: false });
    return original(method, params);
  };
  let now = 1793102400000;
  const store = new TaskStore(directory); const engine = new TaskEngine({ store, adapter, clock: { now: () => now } });
  t.after(async () => { engine.stop(); await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const task = await engine.createTask({ title: '发送前网络恢复', kind: 'once', target: fixed, message: '继续', enabled: true, scheduledAt: now });
  await engine.tick();
  let saved = store.snapshot().tasks.find(value => value.id === task.id);
  assert.equal(saved.state, 'waiting_network'); assert.equal(saved.intents[0].status, 'cancelled'); assert.equal(saved.intents[0].outcome, 'not_sent');
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0);
  await engine.tick(); assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 0);
  now += 1000; await engine.tick();
  saved = store.snapshot().tasks.find(value => value.id === task.id);
  assert.equal(saved.state, 'queued'); assert.equal(saved.intents.at(-1).status, 'queued');
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1);
});
