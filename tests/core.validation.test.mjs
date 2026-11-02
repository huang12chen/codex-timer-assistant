import test from 'node:test';
import assert from 'node:assert/strict';

let core;
try { core = await import('../src/core/index.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const THREAD = '019a8421-7acf-7001-89ab-123456789abc';
const LINK = `codex://threads/${THREAD}`;

test('thread links canonicalize UUIDs and one safely encoded link', () => {
  assert.equal(typeof core?.parseThreadLink, 'function', 'thread link validator is not implemented');
  assert.deepEqual(core.parseThreadLink(LINK.toUpperCase()), { threadId: THREAD, link: LINK });
  assert.deepEqual(core.parseThreadLink(encodeURIComponent(LINK)), { threadId: THREAD, link: LINK });
});

test('thread links reject arbitrary protocols, hidden components, and ambiguous paths', () => {
  assert.equal(typeof core?.parseThreadLink, 'function', 'thread link validator is not implemented');
  for (const bad of [
    `https://threads/${THREAD}`, `file:///${THREAD}`, `codex://user@threads/${THREAD}`,
    `${LINK}?exec=calc`, `${LINK}#x`, `${LINK}/other`, `codex://threads/../${THREAD}`,
    `codex://threads:123/${THREAD}`, `codex://threads/not-a-uuid`,
    encodeURIComponent(encodeURIComponent(LINK)), `${LINK}\n`, `${LINK}\\x`,
  ]) assert.throws(() => core.parseThreadLink(bad), { name: 'ValidationError' }, bad);
});

test('task state vocabulary includes queued separately from running', () => {
  assert.ok(Array.isArray(core?.TASK_STATES), 'task state contract is not implemented');
  assert.deepEqual(new Set(core.TASK_STATES), new Set([
    'scheduled', 'watching', 'running', 'waiting_quota', 'waiting_network',
    'waiting_user', 'needs_attention', 'queued', 'paused', 'completed', 'expired',
  ]));
  assert.ok(core.DEFAULT_AUTO_REPLY.includes('完成约定目标后停止'));
});
