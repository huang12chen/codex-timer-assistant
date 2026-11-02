import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRollout, normalizeQuota, readRolloutTail } from '../src/adapters/rollout.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-27T12:00:00.000Z';
const event = (type, fields = {}) => ({ timestamp: at, type: 'event_msg', payload: { type, ...fields } });
const item = (type, fields = {}) => ({ timestamp: at, type: 'response_item', payload: { type, ...fields } });

test('a quiet or notLoaded read never invents desktop idle', () => {
  assert.equal(parseRollout([], { threadId: id }).status, 'unknown');
  assert.equal(parseRollout([event('token_count')], { threadId: id }).status, 'unknown');
});
test('an explicit active turn remains active until an explicit terminal event', () => {
  const state = parseRollout([event('task_started', { turn_id: 'turn-1' }), event('token_count')], { threadId: id });
  assert.equal(state.status, 'active');
  assert.equal(state.lastTurnId, 'turn-1');
});
test('turn completion alone does not mean the watched project is done', () => {
  const state = parseRollout([event('task_started', { turn_id: 'turn-1' }), event('task_complete', { turn_id: 'turn-1', last_agent_message: '完成本回合。' })], { threadId: id });
  assert.equal(state.status, 'turn_completed');
  assert.equal(state.goalCompleted, false);
});
test('only an agreed explicit final completion line ends the watch', () => {
  const records = [event('task_started', { turn_id: 'turn-1' }), event('task_complete', { turn_id: 'turn-1', last_agent_message: '所有工作完成。\n[CODEX_TIMER_DONE]' })];
  assert.equal(parseRollout(records, { threadId: id }).goalCompleted, false);
  assert.equal(parseRollout(records, { threadId: id, expectDoneMarker: true }).goalCompleted, true);
  records.push(event('task_started', { turn_id: 'turn-2' }));
  assert.equal(parseRollout(records, { threadId: id, expectDoneMarker: true }).goalCompleted, false);
});
test('pending input has a stable call identity and a matching output resolves it', () => {
  const args = JSON.stringify({ questions: [{ id: 'style', question: '选择配色风格？', options: [{ label: '蓝色', description: '使用蓝色。' }, { label: '绿色', description: '使用绿色。' }] }] });
  const records = [event('task_started', { turn_id: 'turn-1' }), item('function_call', { name: 'request_user_input', call_id: 'call-q', arguments: args })];
  const state = parseRollout(records, { threadId: id });
  assert.equal(state.status, 'waiting_user');
  assert.equal(state.question.id, 'call-q');
  assert.equal(state.question.kind, 'ordinary');
  records.push(item('function_call_output', { call_id: 'call-q', output: '{}' }));
  assert.equal(parseRollout(records, { threadId: id }).status, 'active');
});
test('approval wording cannot be classified as an ordinary choice', () => {
  const args = JSON.stringify({ questions: [{ id: 'publish', question: '是否授权发布到公开 GitHub？', options: [{ label: '批准', description: '发布。' }, { label: '拒绝', description: '停止。' }] }] });
  assert.equal(parseRollout([item('function_call', { name: 'request_user_input', call_id: 'approval', arguments: args })], { threadId: id }).question.kind, 'permission');
  assert.equal(parseRollout([event('exec_approval_request', { call_id: 'exec-1' })], { threadId: id }).question.kind, 'permission');
});
test('quota errors survive a task_complete and interrupted turns require attention', () => {
  const state = parseRollout([event('task_started', { turn_id: 'turn-1' }), event('error', { codex_error_info: 'usageLimitExceeded' }), event('task_complete', { turn_id: 'turn-1' })], { threadId: id });
  assert.equal(state.status, 'waiting_quota');
  assert.equal(parseRollout([event('turn_aborted', { turn_id: 'turn-1' })], { threadId: id }).status, 'needs_attention');
});
test('official allowance is three-state and reset seconds become milliseconds', () => {
  const q = normalizeQuota({ ordinaryUsageAllowed: null, rateLimits: { planType: 'plus', primary: { usedPercent: 0, resetsAt: 1793100000 }, secondary: { usedPercent: 100 } } }, 123);
  assert.equal(q.ordinaryUsageAllowed, null);
  assert.equal(q.primary.resetAt, 1793100000000);
  assert.equal(normalizeQuota({ ordinaryUsageAllowed: false }, 123).ordinaryUsageAllowed, false);
  assert.equal(normalizeQuota({}, 123).ordinaryUsageAllowed, null);
});
test('bounded tail rejects unrelated session metadata and ignores a partial last line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-timer-tail-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n${JSON.stringify(event('task_complete', { turn_id: 'ok' }))}\n{"partial":`);
    const result = await readRolloutTail(file, { threadId: id, roots: [dir], maxBytes: 4096 });
    assert.equal(result.records.length, 2);
    await assert.rejects(readRolloutTail(file, { threadId: '22222222-2222-4222-8222-222222222222', roots: [dir] }), /聊天/);
    await assert.rejects(readRolloutTail(file, { threadId: id, roots: [path.join(dir, 'other')] }), /目录/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('large session metadata is validated separately from the bounded event tail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-timer-header-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, `\uFEFF${JSON.stringify({ type: 'session_meta', payload: { id, instructions: 'x'.repeat(50000) } })}\n${JSON.stringify(event('task_complete', { turn_id: 'after-header' }))}\n`);
    const result = await readRolloutTail(file, { threadId: id, roots: [dir], maxBytes: 4096 });
    assert.equal(parseRollout(result.records, { threadId: id }).status, 'turn_completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
