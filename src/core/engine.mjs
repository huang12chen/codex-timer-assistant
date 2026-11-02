import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ValidationError, clone, editableInput, newTask, normalizeTarget, isThreadId,
  textField, timeField, normalizeAttachments, messageField,
} from './validation.mjs';

const TERMINAL = new Set(['completed', 'expired']);
const UNRESOLVED = new Set(['pending', 'queued', 'unknown']);
const OBSERVATION_STATES = new Set([
  'active', 'idle', 'turn_completed', 'waiting_quota', 'waiting_network',
  'waiting_user', 'needs_attention', 'unknown',
]);
const safeText = (value, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, 2000) : fallback;
const errorText = (error) => safeText(error?.message, '连接操作失败');
const targetKey = (threadId) => `thread:${threadId}`;
const QUOTA_RECHECK_MS = 15000;
const RUNNING_CHECKPOINT_MS = 60000;
function sameObservation(a, b) {
  if (!a || !b) return false;
  const { observedAt: _previousTime, ...previous } = a;
  const { observedAt: _currentTime, ...current } = b;
  return isDeepStrictEqual(previous, current);
}
const quotaCheckAt = (now, resetAt) => Number.isSafeInteger(resetAt) && resetAt > now
  ? Math.min(resetAt, now + QUOTA_RECHECK_MS) : now + QUOTA_RECHECK_MS;

function sanitizeObservation(raw, now) {
  if (!raw || typeof raw !== 'object' || !OBSERVATION_STATES.has(raw.status)) {
    return { status: 'unknown', reason: '无法可靠识别当前聊天状态', observedAt: now };
  }
  const observation = {
    status: raw.status, reason: safeText(raw.reason, ''), observedAt: now,
    goalCompleted: raw.goalCompleted === true,
  };
  if (isThreadId(raw.threadId)) observation.threadId = raw.threadId.toLowerCase();
  if (typeof raw.windowId === 'string') observation.windowId = raw.windowId.slice(0, 500);
  if (typeof raw.lastTurnId === 'string' && raw.lastTurnId.trim()) observation.lastTurnId = raw.lastTurnId.slice(0, 1000);
  if (Array.isArray(raw.acceptedMessageIds)) observation.acceptedMessageIds = raw.acceptedMessageIds.filter(isThreadId).slice(-100).map(id => id.toLowerCase());
  if (raw.question && typeof raw.question === 'object') {
    observation.question = {
      kind: ['ordinary', 'permission', 'unknown'].includes(raw.question.kind) ? raw.question.kind : 'unknown',
      text: safeText(raw.question.text, '聊天正在等待回复'),
    };
    if (typeof raw.question.id === 'string' && raw.question.id.trim()) observation.question.id = raw.question.id.slice(0, 1000);
  }
  if (raw.quota && typeof raw.quota === 'object') {
    observation.quota = {
      resetAt: Number.isSafeInteger(raw.quota.resetAt) && raw.quota.resetAt >= 0 ? raw.quota.resetAt : null,
      source: ['official', 'manual', 'unknown'].includes(raw.quota.source) ? raw.quota.source : 'unknown',
    };
    if (typeof raw.quota.eventId === 'string' && raw.quota.eventId.trim()) observation.quota.eventId = raw.quota.eventId.slice(0, 1000);
  }
  return observation;
}

export class TaskEngine {
  constructor({ store, adapter, clock = {}, intervalMs, confirmationTimeoutMs = 60000 }) {
    if (!store || typeof store.init !== 'function' || typeof store._editTask !== 'function' ||
        !adapter || typeof adapter.observe !== 'function' || typeof adapter.perform !== 'function') {
      throw new ValidationError('调度器需要任务存储和连接适配器');
    }
    if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 1)) throw new ValidationError('检查间隔无效');
    if (!Number.isInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1) throw new ValidationError('确认等待时间无效');
    this.store = store;
    this.adapter = adapter;
    this.clock = {
      now: typeof clock.now === 'function' ? clock.now.bind(clock) : Date.now,
      setInterval: typeof clock.setInterval === 'function' ? clock.setInterval.bind(clock) : globalThis.setInterval,
      clearInterval: typeof clock.clearInterval === 'function' ? clock.clearInterval.bind(clock) : globalThis.clearInterval,
    };
    this.intervalMs = intervalMs;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this._ready = null;
    this._tickPromise = null;
    this._timer = null;
    this._running = false;
    this._epoch = 0;
    this._lastError = null;
    this._pausing = new Set();
    this._deleting = new Set();
    this._scheduleRequests = new Map();
    this._editing = new Map();
  }

  _ensure() {
    if (!this._ready) {
      this._ready = (async () => {
        await this.store.init();
        const now = this.clock.now();
        for (const task of this.store.snapshot().tasks) {
          if (task.intents.some((intent) => intent.status === 'pending' || intent.status === 'queued')) {
            await this.store._editTask(task.id, (current) => ({
              ...current, state: 'needs_attention', reason: '上次退出时操作尚未确认，请核实聊天后处理，助手不会重发',
              updatedAt: now, nextAttemptAt: null,
              intents: current.intents.map((intent) => ['pending', 'queued'].includes(intent.status) ? { ...intent, status: 'unknown', finishedAt: now } : intent),
            }));
            await this._log(task.id, 'warning', 'recovery_uncertain', '上次操作结果待核实，已阻止自动重发');
          } else if (task.enabled && task.kind === 'watch' && task.state === 'needs_attention' &&
                     task.reason === '目标回合已被停止，助手不会替本人重新启动' && !task.intents.some(intent => UNRESOLVED.has(intent.status))) {
            // Earlier versions could mistake an old persisted turn summary for
            // a stop after a large image pushed lifecycle events out of the tail.
            // Re-observe only; an actual stop/question still forbids any write.
            await this.store.updateTask(task.id,{state:'watching',reason:'重新核对目标回合状态',nextAttemptAt:null,updatedAt:now});
          } else if (task.enabled && task.kind === 'once' && !TERMINAL.has(task.state) && task.state !== 'needs_attention' && task.scheduledAt < now &&
                     !task.intents.some((intent) => intent.type === 'send_message' && intent.status !== 'cancelled')) {
            await this.store.updateTask(task.id, { state: 'needs_attention', reason: '关机或退出期间错过了定时发送；请明确启用后再执行', updatedAt: now, nextAttemptAt: null });
            await this._log(task.id, 'warning', 'recovery_missed', '错过的定时任务等待手动处理');
          }
        }
      })();
    }
    return this._ready;
  }

  async start() {
    await this._ensure();
    if (this._running) return this.snapshot();
    this._running = true;
    this._timer = this.clock.setInterval(() => {
      this.tick().catch((error) => {
        this._lastError = { at: this.clock.now(), message: errorText(error) };
        this.stop();
      });
    }, this.intervalMs ?? this.store.snapshot().settings.pollIntervalMs);
    this._timer?.unref?.();
    return this.snapshot();
  }

  stop() {
    this._epoch += 1;
    if (this._timer !== null) this.clock.clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }

  snapshot() {
    return { ...this.store.snapshot(), engine: { running: this._running, ticking: this._tickPromise !== null, lastError: clone(this._lastError) } };
  }

  tick() {
    if (this._tickPromise) return this._tickPromise;
    const epoch = this._epoch;
    this._tickPromise = (async () => {
      try {
        await this._ensure();
        if (!this.store.snapshot().settings.pausedAll) {
          const claimed = new Set();
          for (const task of this.store.snapshot().tasks) {
            if (epoch !== this._epoch || this.store.snapshot().settings.pausedAll) break;
            await this._process(task.id, claimed, epoch);
          }
        }
        this._lastError = null;
      } catch (error) {
        this._lastError = { at: this.clock.now(), message: errorText(error) };
        throw error;
      } finally {
        this._tickPromise = null;
      }
      return this.snapshot();
    })();
    return this._tickPromise;
  }

  async recheckQuota() {
    const epoch = this._epoch;
    await this._ensure();
    if (epoch !== this._epoch || this.store.snapshot().settings.pausedAll) return this.snapshot();
    for (const task of this.store.snapshot().tasks) {
      if (epoch !== this._epoch || this.store.snapshot().settings.pausedAll) return this.snapshot();
      if (!task.enabled || task.state !== 'waiting_quota') continue;
      await this.store._editTask(task.id, current => {
        if (epoch !== this._epoch || !current.enabled || current.state !== 'waiting_quota' || this.store.snapshot().settings.pausedAll ||
            current.scheduledAt > this.clock.now() || current.intents.some(intent => UNRESOLVED.has(intent.status))) return current;
        return { ...current, nextAttemptAt: this.clock.now() };
      });
    }
    if (epoch !== this._epoch || this.store.snapshot().settings.pausedAll) return this.snapshot();
    return this.tick();
  }

  async createTask(input) {
    await this._ensure();
    const task = newTask(input, this.clock.now(), this.store.snapshot().settings);
    await this.store.putTask(task);
    await this._log(task.id, 'info', 'task_created', task.enabled ? '任务已启用' : '任务已保存，尚未启用');
    return this._task(task.id);
  }

  async updateTask(id, input, {validateOnly=false,prepareAttachments}={}) {
    const patch = editableInput(input);
    let attachmentPatch=patch.attachments===undefined?undefined:normalizeAttachments(patch.attachments);
    if(prepareAttachments!==undefined&&typeof prepareAttachments!=='function')throw new ValidationError('图片保存方式无效');
    const scheduleRequest = patch.scheduledAt === undefined ? null : { value: timeField(patch.scheduledAt, '触发时间') };
    const editToken=Symbol('task edit');
    if(!validateOnly){
      if(!this._editing.has(id))this._editing.set(id,new Set());
      this._editing.get(id).add(editToken);
    }
    if (!validateOnly&&patch.enabled === false) this._pausing.add(id);
    if (!validateOnly&&scheduleRequest) this._scheduleRequests.set(id, scheduleRequest);
    try {
      await this._ensure();
      const applyPatch=(task) => {
        const now = this.clock.now();
        if (patch.kind !== undefined && patch.kind !== task.kind) throw new ValidationError('更换任务模式请新建任务');
        if (patch.enabled === true && TERMINAL.has(task.state)) throw new ValidationError('已结束任务不会重新启用，请新建任务', 'TASK_TERMINAL');
        if (patch.enabled === true && task.intents.some((intent) => UNRESOLVED.has(intent.status))) throw new ValidationError('操作结果待核实，不能重新启用', 'UNRESOLVED_INTENT');
        if (patch.target !== undefined && task.intents.some((intent) => UNRESOLVED.has(intent.status))) throw new ValidationError('操作结果待核实时不能切换目标', 'UNRESOLVED_INTENT');
        if(attachmentPatch!==undefined&&JSON.stringify(attachmentPatch)!==JSON.stringify(task.attachments??[])&&task.intents.some(intent=>UNRESOLVED.has(intent.status)))throw new ValidationError('发送结果待核实时不能更换图片','UNRESOLVED_INTENT');
        const next = { ...task, updatedAt: now };
        if (patch.title !== undefined) next.title = textField(patch.title, '任务名称', 200);
        if(attachmentPatch!==undefined)next.attachments=attachmentPatch;
        if(patch.message!==undefined)next.message=messageField(patch.message,next.attachments??[]);
        if (patch.autoReply !== undefined) next.autoReply = textField(patch.autoReply, '普通问题回复', 100000);
        if (patch.target !== undefined) next.target = normalizeTarget(patch.target);
        if (patch.scheduledAt !== undefined) next.scheduledAt = scheduleRequest.value;
        if (patch.cutoffAt !== undefined) next.cutoffAt = timeField(patch.cutoffAt, '截止时间', { nullable: true });
        if ((patch.cutoffAt !== undefined || scheduleRequest) && next.cutoffAt !== null &&
            ((patch.cutoffAt !== undefined && next.cutoffAt <= now) || next.cutoffAt <= next.scheduledAt)) {
          throw new ValidationError('截止时间须晚于当前时间和触发时间');
        }
        if (patch.autoAnswerOrdinary !== undefined) {
          if (typeof patch.autoAnswerOrdinary !== 'boolean') throw new ValidationError('自动回复选项须为布尔值');
          next.autoAnswerOrdinary = patch.autoAnswerOrdinary;
        }
        if (patch.enabled !== undefined) {
          if (typeof patch.enabled !== 'boolean') throw new ValidationError('启用选项须为布尔值');
          next.enabled = patch.enabled;
          if (!TERMINAL.has(task.state)) {
            next.state = patch.enabled ? (task.kind === 'once' ? 'scheduled' : 'watching') : 'paused';
            next.reason = patch.enabled ? '任务已明确启用，等待执行' : '任务已暂停';
          }
          next.nextAttemptAt = null;
        }
        messageField(next.message,next.attachments??[]);
        return next;
      };
      const validated=applyPatch(this._task(id));
      if(validateOnly)return clone(validated);
      if(attachmentPatch!==undefined&&prepareAttachments){
        const prepared=normalizeAttachments(await prepareAttachments(clone(attachmentPatch)));
        if(JSON.stringify(prepared)!==JSON.stringify(attachmentPatch))throw new ValidationError('保存后的图片与所选图片不一致');
        attachmentPatch=prepared;
      }
      return await this.store._editTask(id,applyPatch);
    } finally {
      if(!validateOnly){
        const edits=this._editing.get(id);edits?.delete(editToken);
        if(edits?.size===0)this._editing.delete(id);
      }
      if (!validateOnly&&patch.enabled === false) this._pausing.delete(id);
      if (!validateOnly&&scheduleRequest && this._scheduleRequests.get(id) === scheduleRequest) this._scheduleRequests.delete(id);
    }
  }

  async pauseTask(id) {
    return this.updateTask(id, { enabled: false });
  }

  async resumeTask(id) {
    await this._ensure();
    const task = this._task(id);
    if (task.cutoffAt !== null && task.cutoffAt <= this.clock.now()) throw new ValidationError('截止时间已到，请新建或修改任务');
    return this.updateTask(id, { enabled: true });
  }

  async confirmDelivery(id, intentId) {
    if (!isThreadId(intentId)) throw new ValidationError('操作标识无效');
    const editToken = Symbol('manual delivery confirmation');
    if (!this._editing.has(id)) this._editing.set(id, new Set());
    this._editing.get(id).add(editToken);
    try {
      await this._ensure();
      const now = this.clock.now();
      const task = await this.store._editTask(id, current => {
        const unresolved = current.intents.filter(intent => UNRESOLVED.has(intent.status));
        if (unresolved.length !== 1 || unresolved[0].id !== intentId || unresolved[0].status !== 'unknown' || unresolved[0].type !== 'send_message') {
          throw new ValidationError('待核实的发送记录已变化，请重新检查任务', 'UNRESOLVED_INTENT');
        }
        return { ...current, enabled: false, state: current.kind === 'once' ? 'completed' : 'paused',
          reason: current.kind === 'once' ? '本人确认消息已送达' : '本人确认消息已送达；看守保持暂停',
          updatedAt: now, nextAttemptAt: null, blocker: null,
          intents: current.intents.map(intent => intent.id === intentId ? { ...intent, status: 'confirmed', confirmedByUser: true, finishedAt: now } : intent) };
      });
      await this._log(id, 'info', 'delivery_confirmed_by_user', task.reason);
      return task;
    } finally { const edits = this._editing.get(id); edits?.delete(editToken); if (edits?.size === 0) this._editing.delete(id); }
  }

  async deleteTask(id) {
    this._deleting.add(id);
    try {
      await this._ensure();
      await this.store._removeTask(id, (task) => {
        if (task.intents.some((intent) => UNRESOLVED.has(intent.status))) throw new ValidationError('操作结果待核实，暂不能删除任务', 'UNRESOLVED_INTENT');
      });
      await this._log(id, 'info', 'task_deleted', '任务已删除');
      return true;
    } finally {
      this._deleting.delete(id);
    }
  }

  _task(id) {
    const task = this.store.snapshot().tasks.find((item) => item.id === id);
    if (!task) throw new ValidationError('任务不存在', 'TASK_NOT_FOUND');
    return task;
  }

  _log(taskId, level, event, message) {
    return this.store.appendLog({ taskId, level, event, message: message.slice(0, 4000), at: this.clock.now() });
  }

  async _state(id, state, reason, extra = {}, guard = () => true) {
    const before = this._task(id);
    const age = this.clock.now() - before.updatedAt;
    // Keep observing an active chat every tick, but checkpoint an identical
    // running state only once a minute. New evidence and all other states are
    // persisted immediately, including quota, approval and delivery changes.
    if (state === 'running' && before.enabled && before.state === state && before.reason === reason &&
        age >= 0 && age < RUNNING_CHECKPOINT_MS && guard(before) &&
        Object.entries(extra).every(([key,value]) => key === 'lastObservation'
          ? sameObservation(before.lastObservation, value) : isDeepStrictEqual(before[key], value))) return before;
    const saved = await this.store._editTask(id, (task) => {
      if (!task.enabled || TERMINAL.has(task.state) || !guard(task)) return task;
      return { ...task, ...extra, state, reason, updatedAt: this.clock.now(), ...(TERMINAL.has(state) ? { enabled: false, nextAttemptAt: null } : {}) };
    });
    if (saved.state !== before.state || saved.reason !== before.reason) {
      await this._log(id, state === 'needs_attention' ? 'warning' : 'info', `state_${saved.state}`, saved.reason || saved.state);
    }
    return saved;
  }

  async _network(id, reason, observation) {
    const task = this._task(id);
    const attempts = task.networkAttempts + 1;
    const nextAttemptAt = this.clock.now() + Math.min(300000, 1000 * (2 ** Math.min(attempts - 1, 9)));
    return this._state(id, 'waiting_network', reason, {
      networkAttempts: attempts, nextAttemptAt,
      ...(observation ? { lastObservation: observation } : {}),
    });
  }

  async _process(id, claimed, epoch) {
    if (this._editing.has(id) || this._pausing.has(id) || this._deleting.has(id)) return;
    let task;
    try { task = this._task(id); }
    catch (error) { if (error.code === 'TASK_NOT_FOUND') return; throw error; }
    const now = this.clock.now();
    if (!task.enabled || TERMINAL.has(task.state) || task.state === 'needs_attention') return;
    if (task.kind === 'once' && task.scheduledAt <= now && !task.intents.some(intent => UNRESOLVED.has(intent.status)) && task.intents.some(intent => intent.status === 'confirmed' && intent.type === 'send_message' && intent.eventKey === `once:${task.id}` && JSON.stringify(intent.target) === JSON.stringify(task.target))) {
      await this._state(id, 'completed', '目标聊天已收到对应的定时消息');
      return;
    }
    if(task.intents.some(intent=>intent.status==='unknown')){
      await this._state(id,'needs_attention','此前发送的结果尚未核实，助手不会自动重发',{nextAttemptAt:null});return;
    }
    if (task.cutoffAt !== null && task.cutoffAt <= now) {
      await this._state(id, 'expired', '截止时间已到，助手已停止干预');
      return;
    }
    // Old ledgers may have slept until a weekly reset. A reset is an estimate,
    // never permission to send or a reason to stop checking fresh official quota.
    const lastQuotaCheck = Math.max(task.updatedAt, Number.isSafeInteger(task.lastObservation?.observedAt) ? task.lastObservation.observedAt : 0);
    const nextAttemptAt = task.state === 'waiting_quota'
      ? Math.min(task.nextAttemptAt ?? Infinity, lastQuotaCheck + QUOTA_RECHECK_MS) : task.nextAttemptAt;
    if (task.scheduledAt > now || (nextAttemptAt !== null && nextAttemptAt > now)) return;
    if (task.intents.some((intent) => intent.status === 'pending')) {
      await this._state(id, 'needs_attention', '发送意图存在而结果未保存，请核实，助手不会重发', {
        intents: task.intents.map((intent) => intent.status === 'pending' ? { ...intent, status: 'unknown', finishedAt: now } : intent),
      });
      return;
    }
    let target;
    try { target = normalizeTarget(task.target); }
    catch {
      await this._state(id, 'needs_attention', '任务目标记录无效，请重新选择目标');
      return;
    }
    if (target.type === 'fixed' && claimed.has(targetKey(target.threadId))) {
      await this._state(id, 'queued', '同一聊天的另一项操作已在本轮提交，等待重新核对');
      return;
    }
    let raw;
    try { raw = await this.adapter.observe(clone(target), { task: clone(task) }); }
    catch (error) {
      if (this._editing.has(id) || this._deleting.has(id) || this._pausing.has(id) || !this.store.snapshot().tasks.some((item) => item.id === id)) return;
      if (['UNSUPPORTED', 'PERMISSION_DENIED', 'INVALID_TARGET'].includes(error.code)) await this._state(id, 'needs_attention', errorText(error));
      else await this._network(id, errorText(error));
      return;
    }
    if (this._editing.has(id) || this._deleting.has(id) || this._pausing.has(id)) return;
    task = this.store.snapshot().tasks.find((item) => item.id === id);
    if (!task || epoch !== this._epoch || !task.enabled || this.store.snapshot().settings.pausedAll || JSON.stringify(target) !== JSON.stringify(task.target)) return;
    if (task.scheduledAt > this.clock.now() || (this._scheduleRequests.get(id)?.value ?? 0) > this.clock.now()) return;
    if (task.cutoffAt !== null && task.cutoffAt <= this.clock.now()) {
      await this._state(id, 'expired', '截止时间已到，助手已停止干预');
      return;
    }
    const observation = sanitizeObservation(raw, this.clock.now());
    const validIdentity = observation.threadId && (target.type === 'fixed'
      ? observation.threadId === target.threadId : observation.windowId === target.windowId);
    let queued = task.intents.findLast((intent) => intent.status === 'queued');
    const accepted = queued && validIdentity && queued.threadId === observation.threadId && typeof queued.id === 'string' && observation.acceptedMessageIds?.includes(queued.id.toLowerCase());
    if (accepted) {
      const queuedId = queued.id;
      task = await this.store._editTask(id, (current) => ({ ...current, intents: current.intents.map((intent) =>
        intent.id === queuedId && intent.status === 'queued' && intent.threadId === observation.threadId
          ? { ...intent, status: 'confirmed', confirmedByObservation: true, finishedAt: this.clock.now() } : intent) }));
      if (!task.intents.some(intent => intent.id === queuedId && intent.status === 'confirmed' && intent.threadId === observation.threadId)) return;
      if (epoch !== this._epoch || !task.enabled || TERMINAL.has(task.state) || this.store.snapshot().settings.pausedAll ||
          this._editing.has(id) || this._deleting.has(id) || this._pausing.has(id) || JSON.stringify(target) !== JSON.stringify(task.target) ||
          task.scheduledAt > this.clock.now() || (this._scheduleRequests.get(id)?.value ?? 0) > this.clock.now()) return;
      if (task.kind === 'once' && queued.type === 'send_message') {
        await this._state(id, 'completed', '目标聊天已收到对应的定时消息', { lastObservation: observation, nextAttemptAt: null, networkAttempts: 0 }, current =>
          epoch === this._epoch && !this.store.snapshot().settings.pausedAll && !this._editing.has(id) && !this._deleting.has(id) && !this._pausing.has(id) &&
          JSON.stringify(target) === JSON.stringify(current.target) && current.scheduledAt <= this.clock.now() && (this._scheduleRequests.get(id)?.value ?? 0) <= this.clock.now());
        return;
      }
      queued = null;
    }
    if (observation.status === 'waiting_network') {
      await this._network(id, observation.reason || '网络连接暂不可用，等待重新读取', observation);
      return;
    }
    if (observation.status === 'needs_attention' || observation.status === 'unknown') {
      await this._state(id, 'needs_attention', observation.reason || '当前客户端无法可靠识别所需状态，请手工处理', { lastObservation: observation, nextAttemptAt: null, networkAttempts: 0 });
      return;
    }
    if (!validIdentity) {
      await this._state(id, 'needs_attention', '无法核对所选窗口或目标聊天，已阻止发送', { lastObservation: observation, nextAttemptAt: null });
      return;
    }
    const common = { lastObservation: observation, nextAttemptAt: null, networkAttempts: 0 };
    if (queued) {
      if (queued.threadId !== observation.threadId) {
        await this._state(id, 'needs_attention', '当前页面已切换，先前排队操作仍待原聊天确认', common);
        return;
      }
      if (this.clock.now() - queued.intendedAt >= this.confirmationTimeoutMs) {
        await this._state(id, 'needs_attention', '排队消息尚未得到对应的送达确认，请核实，助手不会重发', {
          ...common, intents: task.intents.map((intent) => intent.id === queued.id ? { ...intent, status: 'unknown', finishedAt: this.clock.now() } : intent),
        });
      } else await this._state(id, 'queued', '消息已进入队列，正在等待目标聊天确认', common);
      return;
    }
    if (task.kind === 'watch' && observation.goalCompleted) {
      await this._state(id, 'completed', '聊天明确确认约定目标已完成，看守已结束', common);
      return;
    }
    if (observation.status === 'active') {
      claimed.add(targetKey(observation.threadId));
      await this._state(id, 'running', observation.reason || '目标聊天正在运行，助手不会追加消息', common);
      return;
    }
    if (observation.status === 'waiting_quota') {
      const resetAt = observation.quota?.resetAt ?? null;
      const quotaEvent = observation.quota?.eventId ?? `${resetAt ?? 'unknown'}:${observation.lastTurnId ?? 'unknown'}`;
      await this._state(id, 'waiting_quota', observation.reason || (resetAt ? '等待额度恢复，再重新核对聊天状态' : '等待官方额度信息或手工恢复时间'), {
        ...common, nextAttemptAt: quotaCheckAt(this.clock.now(), resetAt),
        blocker: { type: 'quota', eventKey: quotaEvent, resetAt, source: observation.quota?.source ?? 'unknown' },
      });
      return;
    }
    let type = 'send_message';
    let eventKey;
    let message = task.message;
    let questionId;
    if (observation.status === 'waiting_user' || observation.question) {
      const question = observation.question;
      if (!question?.id || question.kind !== 'ordinary') {
        await this._state(id, 'needs_attention', question?.kind === 'permission' ? '聊天请求权限审批，请本人核实并处理' : '等待回复的问题无法可靠分类，请本人处理', common);
        return;
      }
      if (!task.autoAnswerOrdinary || !this.store.snapshot().settings.autoAnswerOrdinary) {
        await this._state(id, 'waiting_user', '普通问题自动回复已关闭，等待本人回复', common);
        return;
      }
      type = 'answer_question';
      questionId = question.id;
      eventKey = `${observation.threadId}:question:${questionId}`;
      message = task.autoReply;
    } else if (task.kind === 'once') eventKey = `once:${task.id}`;
    else if (task.blocker?.type === 'quota') eventKey = `${observation.threadId}:quota:${task.blocker.eventKey}`;
    else if (observation.lastTurnId) eventKey = `${observation.threadId}:turn:${observation.lastTurnId}`;
    else if (!task.intents.some((intent) => intent.threadId === observation.threadId && intent.status !== 'cancelled')) eventKey = `${observation.threadId}:watch_start`;
    else {
      await this._state(id, 'needs_attention', '无法区分新的完成回合，已停止自动追加消息', common);
      return;
    }
    const alreadyHandled = task.intents.some((intent) => intent.eventKey === eventKey && intent.status !== 'cancelled');
    const sameTurn = type === 'send_message' && task.kind === 'watch' && !task.blocker && observation.lastTurnId &&
      task.intents.some((intent) => intent.threadId === observation.threadId && intent.baseTurnId === observation.lastTurnId && intent.status !== 'cancelled');
    if (alreadyHandled || sameTurn) {
      await this._state(id, type === 'answer_question' ? 'waiting_user' : 'watching',
        type === 'answer_question' ? '该问题的回复已提交，等待聊天继续' : '该事件已处理，等待新的聊天进展', { ...common, blocker: null });
      return;
    }
    const key = targetKey(observation.threadId);
    const otherUnresolved = this.store.snapshot().tasks.some((other) => other.id !== id && other.intents.some((intent) => intent.threadId === observation.threadId && UNRESOLVED.has(intent.status)));
    if (claimed.has(key) || otherUnresolved) {
      await this._state(id, 'queued', '同一聊天有另一项操作等待确认，当前任务尚未发送', common);
      return;
    }
    await this._perform(id, { type, eventKey, message, ...(questionId ? { questionId } : {}) }, observation, target, common, claimed, epoch);
  }

  async _perform(id, fields, observation, target, common, claimed, epoch) {
    if (epoch !== this._epoch || this.store.snapshot().settings.pausedAll || this._editing.has(id) || this._pausing.has(id) || this._deleting.has(id)) return;
    const intendedAt = this.clock.now();
    const imageTask=this._task(id),attachmentSource=normalizeAttachments(imageTask.attachments);
    const submittedImages=new Set(imageTask.kind==='watch'?imageTask.intents
      .filter(intent=>intent.type==='send_message'&&intent.threadId===observation.threadId&&['queued','confirmed','unknown'].includes(intent.status))
      .flatMap(intent=>(intent.attachments??[]).map(image=>image.id+':'+image.sha256)):[]);
    const attachments=fields.type==='send_message'?attachmentSource.filter(image=>!submittedImages.has(image.id+':'+image.sha256)):[];
    const continuation=imageTask.kind==='watch'&&fields.type==='send_message'&&!attachments.length&&!fields.message?.trim()
      ?{message:'继续完成本聊天已经确认的任务。'}:{};
    const action = {
      id: randomUUID(), taskId: id, target: clone(target), threadId: observation.threadId,
      ...fields,...continuation,...(attachments.length?{attachments}:{}),
    };
    const saved = await this.store._editTask(id, (task) => {
      if (this._editing.has(id) || !task.enabled || TERMINAL.has(task.state) || JSON.stringify(task.target) !== JSON.stringify(target) ||
          JSON.stringify(task.attachments??[])!==JSON.stringify(attachmentSource)||
          task.scheduledAt > this.clock.now() || (this._scheduleRequests.get(id)?.value ?? 0) > this.clock.now() ||
          task.intents.some((intent) => intent.eventKey === action.eventKey && intent.status !== 'cancelled')) return task;
      if (task.cutoffAt !== null && task.cutoffAt <= intendedAt) return { ...task, enabled: false, state: 'expired', reason: '截止时间已到，助手已停止干预', updatedAt: intendedAt };
      return {
        ...task, ...common, networkAttempts: task.networkAttempts, state: 'queued', reason: '操作意图已保存，等待客户端返回结果', updatedAt: intendedAt,
        intents: [...task.intents, { ...clone(action), status: 'pending', intendedAt, baseTurnId: observation.lastTurnId ?? null }],
      };
    });
    if (!saved.intents.some((intent) => intent.id === action.id)) return;
    const current = this._task(id);
    if (epoch !== this._epoch || this._editing.has(id) || this._pausing.has(id) || this._deleting.has(id) || !current.enabled || current.scheduledAt > this.clock.now() || (this._scheduleRequests.get(id)?.value ?? 0) > this.clock.now() ||
        this.store.snapshot().settings.pausedAll || (current.cutoffAt !== null && current.cutoffAt <= this.clock.now())) {
      await this.store._editTask(id, (task) => {
        const expired = task.enabled && task.cutoffAt !== null && task.cutoffAt <= this.clock.now();
        return {
          ...task, updatedAt: this.clock.now(),
          ...(task.enabled && !TERMINAL.has(task.state) ? {
            state: expired ? 'expired' : task.kind === 'once' ? 'scheduled' : 'watching',
            enabled: !expired, reason: expired ? '截止时间已到，操作尚未发出，助手已停止干预' : '操作发出前已停止，尚未调用客户端',
          } : {}),
          intents: task.intents.map((intent) => intent.id === action.id ? { ...intent, status: 'cancelled', finishedAt: this.clock.now() } : intent),
        };
      });
      await this._log(id, 'info', 'action_cancelled', '操作发出前已停止，尚未调用客户端');
      return;
    }
    claimed.add(targetKey(observation.threadId));
    let result;
    try { result = await this.adapter.perform(clone(action)); }
    catch (error) { result = { status: 'unknown', message: errorText(error) }; }
    if (result?.status === 'not_sent' && result.possibleWrite === false && isThreadId(result.threadId) &&
        result.threadId.toLowerCase() === action.threadId && ['running', 'waiting_network', 'waiting_quota', 'needs_attention'].includes(result.retryState)) {
      await this._notSent(id, action, result, epoch);
      return;
    }
    const knownStatus = result && ['queued', 'confirmed', 'unknown'].includes(result.status);
    const sameThread = result?.threadId === undefined || (isThreadId(result.threadId) && result.threadId.toLowerCase() === action.threadId);
    const status = knownStatus && sameThread ? result.status : 'unknown';
    const reason = status === 'unknown' ? safeText(result?.message, '操作结果无法确认，请核实，助手不会重发')
      : status === 'queued' ? '消息已进入队列，尚未确认目标聊天开始运行'
      : saved.kind === 'once' && action.type === 'send_message' ? '定时消息已确认送达'
      : '操作已确认提交，继续观察聊天进展';
    const finishedAt = this.clock.now();
    const final = await this.store._editTask(id, (task) => {
      const intents = task.intents.map((intent) => {
        if (intent.id !== action.id) return intent;
        const updated = { ...intent, status, finishedAt };
        if (typeof result?.receipt === 'string') updated.receipt = result.receipt.slice(0, 2000);
        if (typeof result?.message === 'string') updated.messageFromAdapter = result.message.slice(0, 2000);
        return updated;
      });
      let next = { ...task, intents, updatedAt: finishedAt, blocker: null, ...(status === 'queued' || status === 'confirmed' ? { networkAttempts: 0 } : {}) };
      if (status === 'unknown') return { ...next, state: 'needs_attention', reason, nextAttemptAt: null };
      if (!task.enabled || TERMINAL.has(task.state)) return next;
      if (task.cutoffAt !== null && task.cutoffAt <= finishedAt) return { ...next, state: 'expired', enabled: false, reason: '截止时间已到；已发出操作的结果已记录', nextAttemptAt: null };
      const completed = status === 'confirmed' && task.kind === 'once' && action.type === 'send_message';
      return { ...next, state: status === 'queued' ? 'queued' : completed ? 'completed' : 'watching', enabled: completed ? false : task.enabled, reason, nextAttemptAt: null };
    });
    await this._log(id, status === 'unknown' ? 'warning' : 'info', `action_${status}`, final.reason);
  }

  async _notSent(id, action, result, epoch) {
    const now = this.clock.now();
    const reason = safeText(result.message, '执行前的复核阻止了操作，客户端尚未执行写入');
    const saved = await this.store._editTask(id, (task) => {
      const next = {
        ...task, updatedAt: now,
        intents: task.intents.map((intent) => intent.id === action.id ? {
          ...intent, status: 'cancelled', finishedAt: now, outcome: 'not_sent', possibleWrite: false,
          retryState: result.retryState, messageFromAdapter: reason,
        } : intent),
      };
      if (!task.enabled || TERMINAL.has(task.state)) return next;
      if (task.cutoffAt !== null && task.cutoffAt <= now) {
        return { ...next, state: 'expired', enabled: false, nextAttemptAt: null, reason: '截止时间已到；执行前已确认没有写入，助手已停止干预' };
      }
      const interval = this.intervalMs ?? this.store.snapshot().settings.pollIntervalMs;
      if (result.retryState === 'needs_attention') return { ...next, state: 'needs_attention', reason, nextAttemptAt: null };
      if (epoch !== this._epoch) {
        return { ...next, state: task.kind === 'once' ? 'scheduled' : 'watching', reason: `助手已停止；${reason}`, nextAttemptAt: now + interval };
      }
      const retryAt = Number.isSafeInteger(result.retryAt) && result.retryAt >= 0 ? result.retryAt : now;
      if (result.retryState === 'waiting_network') {
        const attempts = task.networkAttempts + 1;
        const backoff = Math.min(300000, 1000 * (2 ** Math.min(attempts - 1, 9)));
        return { ...next, state: 'waiting_network', reason, networkAttempts: attempts, nextAttemptAt: Math.max(now + backoff, Math.min(retryAt, now + 300000)) };
      }
      if (result.retryState === 'waiting_quota') return { ...next, state: 'waiting_quota', reason, networkAttempts: 0, nextAttemptAt: quotaCheckAt(now, retryAt) };
      return { ...next, state: result.retryState, reason, networkAttempts: 0, nextAttemptAt: Math.max(now + interval, retryAt) };
    });
    await this._log(id, saved.state === 'needs_attention' ? 'warning' : 'info', 'action_not_sent', saved.reason);
  }
}
