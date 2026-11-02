import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

let core;
try { core = await import('../src/core/index.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

async function setup(t, options) {
  assert.equal(typeof core?.TaskStore, 'function', 'atomic JSON store is not implemented');
  const dir = await mkdtemp(join(tmpdir(), 'codex-timer-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new core.TaskStore(dir, options);
  await store.init();
  return { dir, store };
}

const THREAD = '019a8421-7acf-7001-89ab-123456789abc';
const plainTask = (id) => ({
  id, kind: 'once', state: 'paused', enabled: false, intents: [], title: '测试任务',
  target: { type: 'fixed', link: `codex://threads/${THREAD}`, threadId: THREAD },
  message: '测试消息', reason: '未启用', scheduledAt: 1793000000000, cutoffAt: null,
  createdAt: 1793000000000, updatedAt: 1793000000000, nextAttemptAt: null,
  networkAttempts: 0, autoAnswerOrdinary: true, autoReply: '继续', lastObservation: null, blocker: null,
});

test('store serializes concurrent changes and reloads tasks, settings, and logs', async (t) => {
  const { dir, store } = await setup(t);
  await Promise.all([
    store.putTask(plainTask('one')),
    store.putTask(plainTask('two')),
    store.updateSettings({ pausedAll: true }),
    store.appendLog({ level: 'info', event: 'created', message: '任务已创建' }),
  ]);
  const reloaded = new core.TaskStore(dir);
  await reloaded.init();
  const snap = reloaded.snapshot();
  assert.equal(snap.tasks.length, 2);
  assert.equal(snap.settings.pausedAll, true);
  assert.equal(snap.logs.length, 1);
  assert.equal(snap.version, 1);
  assert.ok((await readdir(dir)).includes('state.json.bak'));
});

test('snapshot and returned tasks do not expose mutable store references', async (t) => {
  const { store } = await setup(t);
  const task = await store.putTask(plainTask('one'));
  task.state = 'running';
  const snap = store.snapshot();
  snap.tasks[0].state = 'completed';
  snap.settings.pausedAll = true;
  assert.equal(store.snapshot().tasks[0].state, 'paused');
  assert.equal(store.snapshot().settings.pausedAll, false);
});

test('previous valid data is retained as a backup during atomic replacement', async (t) => {
  const { dir, store } = await setup(t);
  await store.putTask(plainTask('one'));
  await store.putTask(plainTask('two'));
  const backup = JSON.parse(await readFile(join(dir, 'state.json.bak'), 'utf8'));
  assert.deepEqual(backup.tasks.map((task) => task.id), ['one']);
  const files = await readdir(dir);
  assert.ok(files.every((name) => name === 'state.json' || name === 'state.json.bak'));
});

test('leaf-only redirection keeps updates and backups beside the physical document', async (t) => {
  const logical = await setup(t);
  const physical = await setup(t);
  const original = fs.promises.realpath;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs.promises, 'realpath', async value => value === join(logical.dir, 'state.json') ? join(physical.dir, 'state.json') : original(value));
  syncBuiltinESMExports();
  const store = new core.TaskStore(logical.dir);
  await store.init();
  await store.updateSettings({ showOrb: false });
  assert.equal(JSON.parse(await readFile(join(physical.dir, 'state.json'), 'utf8')).settings.showOrb, false);
  assert.equal(JSON.parse(await readFile(join(physical.dir, 'state.json.bak'), 'utf8')).settings.showOrb, true);
  assert.equal(store.directory, await original(physical.dir));
});

test('a redirected new temporary file commits to its physical directory on first creation', async (t) => {
  const logical = await mkdtemp(join(tmpdir(), 'codex-timer-logical-'));
  const physical = await mkdtemp(join(tmpdir(), 'codex-timer-physical-'));
  const originalOpen = fs.promises.open, originalRealpath = fs.promises.realpath;
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(logical, { recursive:true, force:true }); await rm(physical, { recursive:true, force:true }); });
  const redirects = value => typeof value === 'string' && dirname(value) === logical && /^state\.json\..+\.tmp$/.test(basename(value));
  t.mock.method(fs.promises, 'open', (value, ...args) => originalOpen(redirects(value) ? join(physical, basename(value)) : value, ...args));
  t.mock.method(fs.promises, 'realpath', value => originalRealpath(redirects(value) ? join(physical, basename(value)) : value));
  syncBuiltinESMExports();
  const store = new core.TaskStore(logical);
  await store.init();
  await store.updateSettings({ showOrb:false });
  assert.equal(store.directory, await originalRealpath(physical));
  assert.equal(JSON.parse(await readFile(join(physical, 'state.json'), 'utf8')).settings.showOrb, false);
  assert.equal(JSON.parse(await readFile(join(physical, 'state.json.bak'), 'utf8')).settings.showOrb, true);
  assert.deepEqual(await readdir(logical), []);
});

test('first creation refuses an unexpected existing physical document after redirection', async (t) => {
  const logical = await mkdtemp(join(tmpdir(), 'codex-timer-logical-'));
  const physical = await setup(t);
  await physical.store.putTask(plainTask('keep-existing'));
  const bytes = await readFile(join(physical.dir, 'state.json'));
  const originalOpen = fs.promises.open, originalRealpath = fs.promises.realpath;
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(logical, { recursive:true, force:true }); });
  const redirects = value => typeof value === 'string' && dirname(value) === logical && /^state\.json\..+\.tmp$/.test(basename(value));
  t.mock.method(fs.promises, 'open', (value, ...args) => originalOpen(redirects(value) ? join(physical.dir, basename(value)) : value, ...args));
  t.mock.method(fs.promises, 'realpath', value => originalRealpath(redirects(value) ? join(physical.dir, basename(value)) : value));
  syncBuiltinESMExports();
  await assert.rejects(new core.TaskStore(logical).init(), { name:'StoreCorruptionError' });
  assert.ok((await readFile(join(physical.dir, 'state.json'))).equals(bytes));
  assert.deepEqual((await readdir(physical.dir)).sort(), ['state.json','state.json.bak']);
});

test('redirected data directory uses its canonical path for atomic writes and keeps backups', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-timer-redirected-'));
  const physical = join(root, 'physical');
  const redirected = join(root, 'redirected');
  await mkdir(physical);
  await symlink(physical, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new core.TaskStore(redirected);
  await store.init();
  assert.equal(store.directory, await realpath(physical));
  assert.equal(store.path, join(await realpath(physical), 'state.json'));
  await store.putTask(plainTask('retained'));
  await store.updateTask('retained', { title: 'saved after redirection' });
  const reopened = new core.TaskStore(redirected);
  await reopened.init();
  assert.equal(reopened.snapshot().tasks[0].title, 'saved after redirection');
  const backup = JSON.parse(await readFile(join(physical, 'state.json.bak'), 'utf8'));
  assert.equal(backup.tasks[0].title, '测试任务');
});

test('corrupt main data throws and preserves original bytes despite a valid backup', async (t) => {
  const { dir, store } = await setup(t);
  await store.putTask(plainTask('one'));
  const corrupt = '{"tasks": broken';
  await writeFile(join(dir, 'state.json'), corrupt);
  const reopened = new core.TaskStore(dir);
  await assert.rejects(reopened.init(), { name: 'StoreCorruptionError' });
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), corrupt);
});

test('invalid document schema does not silently become an empty store', async (t) => {
  const { dir } = await setup(t);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, tasks: 'wrong', logs: [], settings: {} }));
  await assert.rejects(new core.TaskStore(dir).init(), { name: 'StoreCorruptionError' });
});

test('bounded logs keep the newest entries and honor a reduced limit immediately', async (t) => {
  const { store } = await setup(t, { logLimit: 3 });
  for (let i = 0; i < 5; i += 1) {
    await store.appendLog({ level: 'info', event: 'poll', message: String(i) });
  }
  assert.deepEqual(store.snapshot().logs.map((log) => log.message), ['2', '3', '4']);
  await store.updateSettings({ logLimit: 1 });
  assert.deepEqual(store.snapshot().logs.map((log) => log.message), ['4']);
});

test('clearing execution logs preserves tasks, pending and queued intents, and settings after reopening', async (t) => {
  const { dir, store } = await setup(t);
  const task = {
    ...plainTask('queued-task'), state: 'queued', enabled: true,
    intents: [
      { id: 'pending-1', status: 'pending', eventKey: 'once:queued-task', intendedAt: 1793000000001, type: 'send_message', threadId: THREAD, baseTurnId: 'turn-1' },
      { id: 'queued-1', status: 'queued', eventKey: 'question:1', intendedAt: 1793000000002, type: 'answer_question', threadId: THREAD, receipt: 'queue-1' },
    ],
    blocker: { type: 'quota', eventKey: 'quota:1', resetAt: 1793000100000, source: 'official' },
  };
  await store.putTask(task);
  await store.updateSettings({ pausedAll: true, logLimit: 3 });
  await store.appendLog({ level: 'info', event: 'created', message: '创建任务' });
  await store.appendLog({ level: 'warning', event: 'queued', message: '等待确认' });
  const before = store.snapshot();

  assert.deepEqual(await store.clearLogs(), { clearedCount: 2 });
  const expected = { ...before, logs: [] };
  assert.deepEqual(store.snapshot(), expected);
  const reopened = new core.TaskStore(dir);
  await reopened.init();
  assert.deepEqual(reopened.snapshot(), expected);
  const backup = JSON.parse(await readFile(join(dir, 'state.json.bak'), 'utf8'));
  assert.deepEqual(backup.logs, before.logs);
  assert.deepEqual(await store.clearLogs(), { clearedCount: 0 });
  assert.deepEqual(store.snapshot(), expected);
});

test('clearing logs is ordered with concurrent appends and leaves later records intact', async (t) => {
  const { dir, store } = await setup(t);
  await store.appendLog({ level: 'info', event: 'old', message: 'old' });
  const beforeClear = store.appendLog({ level: 'info', event: 'before', message: 'before clear' });
  const clear = store.clearLogs();
  const afterClear = store.appendLog({ level: 'info', event: 'after', message: 'after clear' });
  const [, result, after] = await Promise.all([beforeClear, clear, afterClear]);

  assert.deepEqual(result, { clearedCount: 2 });
  assert.deepEqual(store.snapshot().logs, [after]);
  const reopened = new core.TaskStore(dir);
  await reopened.init();
  assert.deepEqual(reopened.snapshot().logs, [after]);
});

test('failed clear leaves existing records intact and the mutation queue usable', async (t) => {
  const { dir, store } = await setup(t);
  await store.appendLog({ level: 'info', event: 'old', message: 'keep me' });
  const before = store.snapshot();
  const bytes = await readFile(join(dir, 'state.json'), 'utf8');
  const backup = join(dir, 'state.json.bak');
  await rm(backup);
  await mkdir(backup);
  await assert.rejects(store.clearLogs());
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), bytes);
  await rm(backup, { recursive: true });
  assert.deepEqual(await store.clearLogs(), { clearedCount: 1 });
  assert.deepEqual(store.snapshot().logs, []);
});

test('credential fields, non-JSON objects, bad settings, and unknown ids are rejected without mutation', async (t) => {
  const { store } = await setup(t);
  const before = store.snapshot();
  await assert.rejects(store.putTask({ ...plainTask('secret'), accessToken: 'private' }), { name: 'ValidationError' });
  await assert.rejects(store.putTask({ ...plainTask('bad'), something: new Date() }), { name: 'ValidationError' });
  await assert.rejects(store.updateSettings({ password: 'private' }), { name: 'ValidationError' });
  await assert.rejects(store.updateSettings({ logLimit: 0 }), { name: 'ValidationError' });
  await assert.rejects(store.updateTask('missing', { state: 'paused' }), { name: 'ValidationError' });
  assert.deepEqual(store.snapshot(), before);
});

test('update and remove persist, while duplicate task ids stay an upsert', async (t) => {
  const { dir, store } = await setup(t);
  await store.putTask(plainTask('one'));
  await store.putTask({ ...plainTask('one'), title: 'new' });
  await store.updateTask('one', { title: 'changed' });
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0].title, 'changed');
  await store.removeTask('one');
  const reloaded = new core.TaskStore(dir);
  await reloaded.init();
  assert.deepEqual(reloaded.snapshot().tasks, []);
});

test('malformed persisted task fields fail startup rather than later producing unsafe state decisions', async (t) => {
  const { dir, store } = await setup(t);
  await store.putTask(plainTask('one'));
  const corrupted = store.snapshot();
  corrupted.tasks[0].networkAttempts = 'a lot';
  await writeFile(join(dir, 'state.json'), JSON.stringify(corrupted));
  await assert.rejects(new core.TaskStore(dir).init(), { name: 'StoreCorruptionError' });
});

test('an interrupted replacement keeps the previous snapshot and main file; the mutation queue then recovers', async (t) => {
  const { dir, store } = await setup(t);
  await store.putTask(plainTask('one'));
  const before = store.snapshot();
  const bytes = await readFile(join(dir, 'state.json'), 'utf8');
  const backup = join(dir, 'state.json.bak');
  await rm(backup);
  await mkdir(backup);
  await assert.rejects(store.updateTask('one', { title: 'must not commit' }));
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), bytes);
  await rm(backup, { recursive: true });
  await store.updateTask('one', { title: 'recovered' });
  assert.equal(store.snapshot().tasks[0].title, 'recovered');
});

test('common credential field spellings are rejected throughout nested JSON', async (t) => {
  const { store } = await setup(t);
  for (const key of ['access_token', 'refresh_token', 'api_key', 'client_secret', 'sessionToken']) {
    await assert.rejects(store.putTask({ ...plainTask(key), extra: { [key]: 'private' } }), { name: 'ValidationError' });
  }
});

test('explicit GUI settings round-trip with safe defaults and a valid timezone', async (t) => {
  const { dir, store } = await setup(t);
  const defaults = store.snapshot().settings;
  assert.equal(defaults.showOrb, true);
  assert.equal(defaults.keepAwake, true);
  assert.equal(defaults.startOnLogin, false);
  assert.equal(defaults.glassTransparency, 40);
  assert.equal(defaults.cliPath, '');
  assert.equal(typeof defaults.timeZone, 'string');
  await store.updateSettings({ showOrb: false, keepAwake: false, startOnLogin: true, glassTransparency: 40, timeZone: 'America/Halifax', cliPath: 'C:\\Program Files\\Codex\\codex.exe' });
  const reloaded = new core.TaskStore(dir);
  await reloaded.init();
  assert.equal(reloaded.snapshot().settings.timeZone, 'America/Halifax');
  assert.equal(reloaded.snapshot().settings.cliPath, 'C:\\Program Files\\Codex\\codex.exe');
  assert.equal(reloaded.snapshot().settings.showOrb, false);
  assert.equal(reloaded.snapshot().settings.glassTransparency, 40);
});

test('GUI settings reject invalid booleans, unknown zones, and unsafe path text', async (t) => {
  const { store } = await setup(t);
  for (const patch of [
    { showOrb: 'yes' }, { keepAwake: 1 }, { startOnLogin: null },
    { timeZone: 'Invalid/Nowhere' }, { timeZone: '' },
    { cliPath: 'a'.repeat(4097) }, { cliPath: 'codex.exe\nother' },
    { glassTransparency: 19 }, { glassTransparency: 86 }, { glassTransparency: '75' }, { glassTransparency: 70.5 },
  ]) await assert.rejects(store.updateSettings(patch), { name: 'ValidationError' });
});
