import { mkdir, readFile, open, copyFile, rename, unlink, stat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError, TASK_STATES, DEFAULT_SETTINGS, assertJson, clone, validateSettings, textField, normalizeTarget, isThreadId, normalizeAttachments, messageField } from './validation.mjs';

export class StoreCorruptionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreCorruptionError';
    this.code = 'STORE_CORRUPT';
  }
}

function validateTask(task) {
  assertJson(task);
  if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id ||
      !['once', 'watch'].includes(task.kind) || !TASK_STATES.includes(task.state) ||
      typeof task.enabled !== 'boolean' || !Array.isArray(task.intents)) {
    throw new ValidationError('任务记录格式无效');
  }
  task.target = normalizeTarget(task.target);
  for (const [key, max] of [['title', 200], ['autoReply', 100000]]) textField(task[key], key, max);
  const attachments=normalizeAttachments(task.attachments);messageField(task.message,attachments);
  for (const key of ['createdAt', 'updatedAt', 'scheduledAt']) {
    if (!Number.isSafeInteger(task[key]) || task[key] < 0) throw new ValidationError(`任务 ${key} 无效`);
  }
  for (const key of ['nextAttemptAt', 'cutoffAt']) {
    if (task[key] !== null && (!Number.isSafeInteger(task[key]) || task[key] < 0)) throw new ValidationError(`任务 ${key} 无效`);
  }
  if (!Number.isSafeInteger(task.networkAttempts) || task.networkAttempts < 0 || typeof task.autoAnswerOrdinary !== 'boolean' ||
      typeof task.reason !== 'string' || (task.lastObservation !== null && (typeof task.lastObservation !== 'object' || Array.isArray(task.lastObservation)))) {
    throw new ValidationError('任务状态字段无效');
  }
  const ids = new Set();
  for (const intent of task.intents) {
    if (!intent || typeof intent.id !== 'string' || ids.has(intent.id) ||
        !['pending', 'queued', 'confirmed', 'unknown', 'cancelled'].includes(intent.status) ||
        !['send_message', 'answer_question'].includes(intent.type) || !isThreadId(intent.threadId) ||
        typeof intent.eventKey !== 'string' || !Number.isSafeInteger(intent.intendedAt) || intent.intendedAt < 0) throw new ValidationError('动作记录格式无效');
    ids.add(intent.id);
    if(intent.attachments!==undefined)normalizeAttachments(intent.attachments);
  }
}

function validateDocument(document) {
  assertJson(document);
  if (!document || document.version !== 1 || !Array.isArray(document.tasks) || !Array.isArray(document.logs) ||
      !document.settings || typeof document.settings !== 'object') throw new ValidationError('本地数据格式或版本不受支持');
  document.settings = validateSettings(document.settings);
  const ids = new Set();
  for (const task of document.tasks) {
    validateTask(task);
    if (ids.has(task.id)) throw new ValidationError('存在重复任务标识');
    ids.add(task.id);
  }
  for (const log of document.logs) {
    if (!log || !['info', 'warning', 'error'].includes(log.level) || typeof log.event !== 'string' || typeof log.message !== 'string') {
      throw new ValidationError('日志格式无效');
    }
  }
  document.logs = document.logs.slice(-document.settings.logLimit);
  return document;
}

export class TaskStore {
  constructor(directory, { filename = 'state.json', logLimit = 500 } = {}) {
    if (typeof directory !== 'string' || !directory || typeof filename !== 'string' || basename(filename) !== filename || !filename || filename === '.' || filename === '..') {
      throw new ValidationError('本地数据路径无效');
    }
    validateSettings({ logLimit });
    this.directory = resolve(directory);
    this.path = join(this.directory, filename);
    this.backupPath = `${this.path}.bak`;
    this._initialLogLimit = logLimit;
    this._document = null;
    this._initializing = null;
    this._tail = Promise.resolve();
    this._hasFile = false;
  }

  init() {
    if (!this._initializing) this._initializing = this._initialize();
    return this._initializing;
  }

  async _initialize() {
    await mkdir(this.directory, { recursive: true });
    // MSIX/AppData redirection can make two apparent siblings resolve to
    // different volumes during rename. Keep the existing atomic replacement,
    // using the physical directory for both the temporary and final files.
    this.directory = await realpath(this.directory);
    this.path = join(this.directory, basename(this.path));
    // MSIX can redirect a file while its parent still resolves to C:.
    // Existing document identity is more precise than the directory alias.
    try { this.path = await realpath(this.path); this.directory = dirname(this.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.backupPath = `${this.path}.bak`;
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await stat(this.backupPath);
        throw new StoreCorruptionError(`主数据文件缺失，备份仍在：${this.backupPath}。请先核实恢复。`);
      } catch (backupError) {
        if (backupError.code !== 'ENOENT') throw backupError;
      }
      const document = { version: 1, tasks: [], logs: [], settings: { ...DEFAULT_SETTINGS, logLimit: this._initialLogLimit } };
      await this._write(document);
      this._document = document;
      return this.snapshot();
    }
    try { this._document = validateDocument(JSON.parse(raw)); }
    catch (error) { throw new StoreCorruptionError(`本地任务数据损坏，原文件已保留：${this.path}`, { cause: error }); }
    this._hasFile = true;
    return this.snapshot();
  }

  snapshot() {
    if (!this._document) throw new ValidationError('任务存储尚未初始化', 'STORE_NOT_READY');
    return clone(this._document);
  }

  async _write(document) {
    const suffix = randomUUID();
    let temporary = `${this.path}.${suffix}.tmp`;
    let backupTemporary;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      // A newly created leaf can be redirected even when the directory is not.
      // Resolve the staged file itself; retain rename + fsync atomicity.
      temporary = await realpath(temporary);
      const physicalDirectory = dirname(temporary);
      const destination = join(physicalDirectory, basename(this.path));
      if (this._hasFile) {
        if (await realpath(this.path) !== destination) throw new StoreCorruptionError('数据路径发生变化，原任务记录已保留，请重新打开助手。');
      } else {
        for (const candidate of [destination, `${destination}.bak`]) {
          try { await stat(candidate); throw new StoreCorruptionError('已发现原有任务数据，助手没有覆盖，请核实数据位置。'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      this.directory = physicalDirectory;
      this.path = destination;
      this.backupPath = `${destination}.bak`;
      backupTemporary = `${this.backupPath}.${suffix}.tmp`;
      if (this._hasFile) {
        await copyFile(this.path, backupTemporary);
        await rename(backupTemporary, this.backupPath);
      }
      await rename(temporary, this.path);
      this._hasFile = true;
    } finally {
      if (handle) await handle.close();
      for (const path of [temporary, backupTemporary].filter(Boolean)) {
        try { await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  async _mutate(change) {
    await this.init();
    const operation = this._tail.then(async () => {
      const next = this.snapshot();
      const result = change(next);
      validateDocument(next);
      await this._write(next);
      this._document = next;
      return clone(result);
    });
    // The caller receives operation's rejection; catching only the queue tail lets
    // a later, independent valid write proceed after a rejected mutation.
    this._tail = operation.catch(() => undefined);
    return operation;
  }

  putTask(task) {
    return this._mutate((document) => {
      validateTask(task);
      const saved = clone(task);
      const index = document.tasks.findIndex((item) => item.id === task.id);
      if (index < 0) document.tasks.push(saved);
      else document.tasks[index] = saved;
      return saved;
    });
  }

  updateTask(id, patch) {
    return this._editTask(id, (task) => {
      assertJson(patch);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || (patch.id !== undefined && patch.id !== id)) {
        throw new ValidationError('任务更新无效');
      }
      return { ...task, ...clone(patch) };
    });
  }

  // Internal atomic read-modify-write used by the engine to preserve concurrent
  // pause/edit changes while an asynchronous adapter call is in flight.
  _editTask(id, update) {
    return this._mutate((document) => {
      const index = document.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new ValidationError('任务不存在', 'TASK_NOT_FOUND');
      const saved = update(document.tasks[index]);
      validateTask(saved);
      if (saved.id !== id) throw new ValidationError('不能修改任务标识');
      document.tasks[index] = saved;
      return saved;
    });
  }

  removeTask(id) {
    return this._removeTask(id);
  }

  _removeTask(id, guard = () => {}) {
    return this._mutate((document) => {
      const index = document.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new ValidationError('任务不存在', 'TASK_NOT_FOUND');
      guard(document.tasks[index]);
      document.tasks.splice(index, 1);
      return true;
    });
  }

  appendLog(log) {
    return this._mutate((document) => {
      assertJson(log);
      if (!['info', 'warning', 'error'].includes(log.level)) throw new ValidationError('日志级别无效');
      const saved = {
        id: randomUUID(), at: log.at ?? Date.now(), level: log.level,
        event: textField(log.event, '日志事件', 200), message: textField(log.message, '日志内容', 4000),
      };
      if (log.taskId !== undefined) saved.taskId = textField(log.taskId, '任务标识', 200);
      if (!Number.isSafeInteger(saved.at) || saved.at < 0) throw new ValidationError('日志时间无效');
      document.logs.push(saved);
      document.logs = document.logs.slice(-document.settings.logLimit);
      return saved;
    });
  }

  clearLogs() {
    return this._mutate((document) => {
      const clearedCount = document.logs.length;
      document.logs = [];
      return { clearedCount };
    });
  }

  updateSettings(patch) {
    return this._mutate((document) => {
      document.settings = validateSettings(patch, document.settings);
      document.logs = document.logs.slice(-document.settings.logLimit);
      return document.settings;
    });
  }
}
