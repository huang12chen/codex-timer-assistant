import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { createRolloutReader, parseRollout } from '../src/adapters/rollout.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const target = { type: 'fixed', threadId, link: `codex://threads/${threadId}` };
const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const item = (type, fields = {}) => ({ type: 'response_item', payload: { type, ...fields } });
const failedTurn = (error, type = 'task_complete') => [event('task_started', { turn_id: 'nested-failed' }), event(type, { turn_id: 'nested-failed', error, last_agent_message: '[CODEX_TIMER_DONE]' })];
const httpError = status => ({ message: `unexpected status ${status}`, codex_error_info: { http_connection_failed: { http_status_code: status } } });

test('nested terminal HTTP 503 errors are failed turns with matching retry evidence', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    const state = parseRollout(failedTurn(httpError(503), type), { threadId, expectDoneMarker: true });
    assert.equal(state.status, 'waiting_network', type);
    assert.equal(state.goalCompleted, false, type);
    assert.deepEqual(state.networkRecovery, { retryable: true, turnId: 'nested-failed', terminal: true }, type);
  }
});

test('camel and snake case nested errors share the lifecycle error classification', () => {
  for (const type of ['error', 'turn_failed', 'task_complete', 'turn_complete']) {
    for (const info of [{ codex_error_info: { http_connection_failed: { http_status_code: 503 } } }, { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }]) {
      const state = parseRollout([event('task_started', { turn_id: 'typed-error' }), event(type, { turn_id: 'typed-error', error: { message: 'service unavailable', ...info } })], { threadId });
      assert.equal(state.status, 'waiting_network', type);
      assert.deepEqual(state.networkRecovery, { retryable: true, turnId: 'typed-error', terminal: type !== 'error' }, type);
    }
  }
});

test('terminal HTTP 401 errors cannot be successful or automatically retried', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    const state = parseRollout(failedTurn(httpError(401), type), { threadId, expectDoneMarker: true });
    assert.equal(state.status, 'needs_attention', type);
    assert.equal(state.goalCompleted, false, type);
    assert.equal(state.networkRecovery, undefined, type);
  }
});

test('every non-null completion error fails closed even when its details are malformed', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    for (const error of [{}, [], '', false, 0, 123, 'unclassified failure', { message: '' }]) {
      const state = parseRollout(failedTurn(error, type), { threadId, expectDoneMarker: true });
      assert.equal(state.status, 'needs_attention', `${type}: ${JSON.stringify(error)}`);
      assert.equal(state.goalCompleted, false);
      assert.equal(state.networkRecovery, undefined);
    }
  }
});

test('absent and null completion errors retain normal completion behavior', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    for (const fields of [{}, { error: null }]) {
      const state = parseRollout([event('task_started', { turn_id: 'normal' }), event(type, { turn_id: 'normal', ...fields, last_agent_message: '[CODEX_TIMER_DONE]' })], { threadId, expectDoneMarker: true });
      assert.equal(state.status, 'turn_completed');
      assert.equal(state.goalCompleted, true);
    }
  }
});

test('nested quota types and messages in completion errors retain the quota blocker', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    for (const error of [{ codex_error_info: 'usageLimitExceeded' }, { codexErrorInfo: 'rateLimitExceeded' }, { codex_error_info: 'other', message: 'quota_exceeded' }, { message: '当前额度不足' }]) {
      const state = parseRollout(failedTurn(error, type), { threadId, expectDoneMarker: true });
      assert.equal(state.status, 'waiting_quota', JSON.stringify(error));
      assert.equal(state.goalCompleted, false);
      assert.equal(state.networkRecovery, undefined);
    }
  }
});

test('a confirmed goal receipt cannot turn an error-bearing completion into success', () => {
  const state = parseRollout([
    event('task_started', { turn_id: 'goal-failed' }),
    item('function_call', { name: 'update_goal', call_id: 'goal-done', arguments: '{"status":"complete"}' }),
    item('function_call_output', { call_id: 'goal-done', output: '{"goal":{"status":"complete"}}' }),
    event('task_complete', { turn_id: 'goal-failed', error: {} }),
  ], { threadId });
  assert.equal(state.status, 'needs_attention');
  assert.equal(state.goalCompleted, false);
});

test('a final permanent error replaces earlier transient retry evidence', () => {
  for (const error of [{ message: 'permission denied by policy' }, httpError(401), {}]) {
    const state = parseRollout([
      event('task_started', { turn_id: 'overridden' }),
      event('error', { codex_error_info: { http_connection_failed: { http_status_code: 503 } } }),
      event('task_complete', { turn_id: 'overridden', error }),
    ], { threadId });
    assert.equal(state.status, 'needs_attention', JSON.stringify(error));
    assert.equal(state.networkRecovery, undefined);
    assert.equal(state.goalCompleted, false);
  }
});

test('untyped disconnection wording cannot inherit a previous typed retry allowance', () => {
  const state = parseRollout([
    event('task_started', { turn_id: 'cut' }),
    event('error', { codex_error_info: { http_connection_failed: { http_status_code: 503 } } }),
    event('task_complete', { turn_id: 'cut', error: { message: 'stream disconnected before completion: Transport error: network error: error decoding response body', codex_error_info: 'other' } }),
  ], { threadId });
  assert.equal(state.goalCompleted, false);
  assert.notEqual(state.status, 'turn_completed');
  assert.notEqual(state.networkRecovery?.retryable, true);
});

test('will_retry only preserves an active intermediate retryable error', () => {
  for (const type of ['error', 'turn_failed', 'task_complete', 'turn_complete']) {
    const state = parseRollout([event('task_started', { turn_id: 'retrying' }), event(type, { turn_id: 'retrying', will_retry: true, error: { codex_error_info: { http_connection_failed: { http_status_code: 503 } } } })], { threadId });
    assert.equal(state.status, type === 'error' ? 'active' : 'waiting_network', type);
    assert.equal(state.goalCompleted, false);
  }
  const state = parseRollout([event('task_started', { turn_id: 'auth' }), event('error', { will_retry: true, codex_error_info: { http_connection_failed: { http_status_code: 401 } } })], { threadId });
  assert.equal(state.status, 'needs_attention');
});

test('pending questions and approvals remain unresolved across an error-bearing completion', () => {
  const question = item('function_call', { name: 'request_user_input', call_id: 'question', arguments: JSON.stringify({ questions: [{ id: 'style', question: '选择配色？', options: [{ label: '蓝色' }, { label: '绿色' }] }] }) });
  for (const pending of [question, event('exec_approval_request', { call_id: 'approval' })]) {
    const records = failedTurn(httpError(503)); records.splice(1, 0, pending);
    const state = parseRollout(records, { threadId, expectDoneMarker: true });
    assert.equal(state.status, 'waiting_user');
    assert.equal(state.question.id, pending.payload.call_id);
    assert.equal(state.goalCompleted, false);
    assert.equal(state.networkRecovery, undefined);
  }
});

test('manual stops remain authoritative after late error-bearing completion records', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    const records = failedTurn(httpError(503), type); records.splice(1, 0, event('turn_aborted', { turn_id: 'nested-failed' }));
    const state = parseRollout(records, { threadId });
    assert.equal(state.status, 'needs_attention');
    assert.equal(state.networkRecovery, undefined);
    assert.equal(state.goalCompleted, false);
  }
});

test('older completion errors cannot replace the current turn and newer turns reset failures', () => {
  for (const type of ['task_complete', 'turn_complete']) {
    const state = parseRollout([event('task_started', { turn_id: 'current' }), event(type, { turn_id: 'older', error: httpError(503) })], { threadId });
    assert.equal(state.status, 'active');
    assert.equal(state.lastTurnId, 'current');
    assert.equal(state.networkRecovery, undefined);
  }
  const failed = failedTurn(httpError(503));
  const next = parseRollout([...failed, event('task_started', { turn_id: 'next' })], { threadId });
  assert.equal(next.status, 'active');
  assert.equal(next.networkRecovery, undefined);
  const context = parseRollout([...failed, { type: 'turn_context', payload: { turn_id: 'next' } }], { threadId });
  assert.equal(context.status, 'unknown');
  assert.equal(context.networkRecovery, undefined);
});

function fixture(records) {
  const state = { records, now: 1793102400000, allowance: true };
  const sends = [];
  const rpc = { isAlive: true, start: async () => {}, close: async () => {}, request: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: threadId, path: 'synthetic.jsonl', source: 'appServer' } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'account/rateLimits/read') return { ordinaryUsageAllowed: state.allowance };
    if (method === 'thread/queue/add') { sends.push(params); return { queuedSubmission: { id: 'nested-receipt', clientUserMessageId: params.clientUserMessageId } }; }
    throw Error('Unexpected synthetic method ' + method);
  } };
  const adapter = new CodexAdapter({ dependencies: { discover: async () => ({ path: 'codex.exe', version: '0.165.0' }), createRpc: () => rpc, readTail: async () => ({ records: state.records }), now: () => state.now } });
  const perform = () => adapter.perform({ id: '33333333-3333-4333-8333-333333333333', type: 'send_message', threadId, target, message: '继续' });
  return { adapter, state, sends, perform };
}

test('nested terminal HTTP 503 waits thirty seconds and fresh official allowance before continuing', async t => {
  const h = fixture(failedTurn(httpError(503))); t.after(() => h.adapter.close());
  const first = await h.adapter.observe(target);
  assert.equal(first.status, 'waiting_network');
  assert.equal(first.goalCompleted, false);
  assert.deepEqual(first.networkRecovery, { retryable: true, turnId: 'nested-failed', terminal: true });
  h.state.now += 29999;
  assert.equal((await h.adapter.observe(target)).status, 'waiting_network');
  h.state.now += 1; h.state.allowance = null;
  assert.equal((await h.adapter.observe(target)).status, 'waiting_network');
  h.state.allowance = true;
  await h.adapter.refreshQuota();
  assert.equal((await h.adapter.observe(target)).status, 'turn_completed');
  assert.equal((await h.perform()).status, 'queued');
  assert.equal(h.sends.length, 1);
});

test('nested terminal HTTP 401 and untyped cut errors never become automatically continuable', async t => {
  for (const error of [httpError(401), { message: 'stream disconnected before completion: Transport error: network error: error decoding response body', codex_error_info: 'other' }, {}]) {
    const h = fixture(failedTurn(error)); t.after(() => h.adapter.close());
    assert.equal((await h.adapter.observe(target)).status, 'needs_attention');
    h.state.now += 600000;
    const result = await h.perform();
    assert.equal(result.status, 'not_sent');
    assert.equal(h.sends.length, 0);
  }
});

test('pending approval and manual interruption block nested transient completion recovery', async t => {
  for (const guard of [event('exec_approval_request', { call_id: 'approval' }), event('turn_aborted', { turn_id: 'nested-failed' })]) {
    const records = failedTurn(httpError(503)); records.splice(1, 0, guard);
    const h = fixture(records); t.after(() => h.adapter.close());
    const first = await h.adapter.observe(target);
    assert.equal(first.status, guard.payload.type === 'exec_approval_request' ? 'waiting_user' : 'needs_attention');
    h.state.now += 600000;
    assert.equal((await h.perform()).status, 'not_sent');
    assert.equal(h.sends.length, 0);
  }
});

test('lifecycle reader preserves nested terminal errors and numeric HTTP status', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-timer-terminal-error-'));
  const file = path.join(directory, 'rollout.jsonl');
  const reader = createRolloutReader({ roots: [directory], chunkBytes: 41 });
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'codex-timer-terminal-error-')); await rm(directory, { recursive: true, force: true }); });
  await writeFile(file, [{ type: 'session_meta', payload: { id: threadId } }, ...failedTurn(httpError(503))].map(record => JSON.stringify(record) + '\n').join(''));
  const result = await reader(file, { threadId });
  assert.equal(result.incomplete, false);
  const state = parseRollout(result.records, { threadId, expectDoneMarker: true });
  assert.equal(state.status, 'waiting_network');
  assert.equal(state.goalCompleted, false);
  assert.deepEqual(state.networkRecovery, { retryable: true, turnId: 'nested-failed', terminal: true });
});
