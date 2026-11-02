import { AdapterError, AppServerClient, callNative, discoverCli, versionAtLeast } from './process.mjs';
import { DONE_MARKER, THREAD_ID, normalizeQuota, parseRollout, createRolloutReader } from './rollout.mjs';
import {normalizeAttachments} from '../core/validation.mjs';
import path from 'node:path';

const QUEUE_MINIMUM = '0.148.0-alpha.14';
const ORDINARY_REASON = '当前桌面连接没有可验证的待答请求提交接口。请在 Codex 中处理普通选择题；看守消息会预先附带决策规则，但无法解除已经阻塞的问题。';
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').slice(0, max) : '';
const error = (message, code = 'INVALID_TARGET', extra = {}) => new AdapterError(message, code, extra);
const isSubagent = source => /subagent|guardian/iu.test(typeof source === 'string' ? source : source && typeof source === 'object' ? [source.type || '', ...Object.keys(source)].join(' ') : '');
const isNetwork = value => ['RPC_TIMEOUT', 'RPC_DISCONNECTED', 'PROCESS_TIMEOUT', 'RPC_CLOSED'].includes(value?.code) || /ECONNRESET|ENOTFOUND|ETIMEDOUT/u.test(value?.code || '');
function parseLink(value) {
  const match = typeof value === 'string' ? /^codex:\/\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(value.trim()) : null;
  if (!match) throw error('聊天链接无效，请使用 Codex 复制的 codex://threads/UUID 链接');
  const threadId = match[1].toLowerCase(); return { threadId, link: `codex://threads/${threadId}` };
}
function normalizeTarget(target) {
  if (target?.type === 'fixed') {
    const parsed = parseLink(target.link);
    if (target.threadId !== undefined && (typeof target.threadId !== 'string' || target.threadId.toLowerCase() !== parsed.threadId)) throw error('固定聊天 UUID 与链接不一致');
    return { ...target, ...parsed };
  }
  if (target?.type === 'current' && typeof target.windowId === 'string' && target.windowId.length > 0 && target.windowId.length <= 500 && THREAD_ID.test(target.confirmedThreadId || '')) return { ...target, confirmedThreadId: target.confirmedThreadId.toLowerCase() };
  throw error('任务目标无效，请重新绑定窗口或固定聊天');
}
const bounded = async (promise, timeoutMs, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error(message, 'PROCESS_TIMEOUT')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
};

export class CodexAdapter {
  constructor({ settings = () => ({}), onStatus = () => {}, openExternal, nativeScript, dependencies = {} } = {}) {
    this.settings = settings; this.onStatus = onStatus; this.openExternal = openExternal; this.nativeScript = nativeScript;
    this.discover = dependencies.discover || discoverCli;
    this.createRpc = dependencies.createRpc || (options => new AppServerClient(options));
    this.readTail = dependencies.readTail || createRolloutReader();
    this.native = dependencies.native || ((action, payload) => callNative(this.nativeScript, action, payload));
    this.now = dependencies.now || Date.now;
    this.resolveImages=dependencies.resolveImages;
    this.rpc = null; this.cli = null; this.explicitPath = null; this.connecting = null; this.closed = false;
    this.threadCache = null; this.quotaCache = null; this.quotaReading=null; this.desktop = null; this.windowTitles = new Map();
    this.quotaBlocked = new Map(); this.contexts = new Map(); this.markerRequested = new Map(); this.networkRetries=new Map();
    this.operations = new Map(); this.performingThreads = new Set();
    this.connection = { connected: false, checking: false, cliPath: '', plan: null, message: '尚未连接。连接诊断只读取聊天索引和官方额度。', quota: { primary: null, secondary: null, ordinaryUsageAllowed: null }, capabilities: { listThreads: false, readQuota: false, readState: false, sendMessage: false, resolveCurrent: false, answerQuestion: false }, ordinaryQuestionReason: ORDINARY_REASON };
  }
  status() { const status=structuredClone(this.connection);const age=this.now()-status.quota.readAt;status.quota.stale=!status.connected||!Number.isFinite(status.quota.readAt)||age<0||age>45000;return status; }
  _status(patch) { this.connection = { ...this.connection, ...patch }; try { this.onStatus(this.status()); } catch {} }
  async _ensure() {
    if (this.closed) throw error('助手连接已经关闭', 'RPC_CLOSED');
    const explicit = this.settings()?.cliPath || '';
    if (this.connecting) return this.connecting;
    if (this.rpc && this.rpc.isAlive !== false && this.explicitPath === explicit) return this.rpc;
    this.connecting = this._connect(explicit);
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async _connect(explicit) {
    this._status({ checking: true });
    try {
      if (this.rpc) await this.rpc.close();
      this.rpc = null; this.quotaCache = null; this.threadCache = null;
      const cli = await this.discover({ explicitPath: explicit });
      let rpc;
      rpc = this.createRpc({ cliPath: cli.path, onDisconnect: () => {
        if (!this.closed && this.rpc === rpc) {
          this.quotaCache = null;
          this._status({ connected: false, message: 'Codex 读取连接已断开，下一次检查会尝试重新建立读取连接。', capabilities: { ...this.connection.capabilities, readQuota: false, sendMessage: false } });
        }
      } });
      this.rpc = rpc; this.cli = cli; this.explicitPath = explicit;
      await rpc.start();
      if (this.closed) { await rpc.close(); throw error('助手连接已经关闭', 'RPC_CLOSED'); }
      this._status({ connected: false, checking: true, cliPath: cli.path, message: '正在核对 Codex 登录和额度状态。', capabilities: { ...this.connection.capabilities, listThreads: true, readQuota: false, readState: true, sendMessage: false, answerQuestion: false } });
      return rpc;
    } catch (caught) {
      this._status({ connected: false, checking: false, message: text(caught.message, 500) || 'Codex 连接失败，请检查 CLI 与登录状态', capabilities: { ...this.connection.capabilities, listThreads: false, readQuota: false, readState: false, sendMessage: false } });
      throw caught;
    }
  }
  async _quota({ force = false } = {}) {
    const age=this.quotaCache?this.now()-this.quotaCache.readAt:Infinity;
    if (!force && this.quotaCache && age>=0 && age<30000) return this.quotaCache;
    if(this.quotaReading)return this.quotaReading;
    this._status({quota:{...this.connection.quota,refreshing:true}});
    this.quotaReading=(async()=>{try {
      const rpc=await this._ensure();
      const response = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true });
      if(this.closed || this.rpc !== rpc || rpc.isAlive === false)throw error('助手连接已经关闭','RPC_CLOSED');
      const quota = normalizeQuota(response, this.now());
      this.quotaCache = quota;
      const confirmed = Boolean(quota.primary || quota.secondary || quota.ordinaryUsageAllowed !== null);
      this._status({ connected: confirmed, checking: false, message: confirmed ? '已连接本机 Codex。排队成功仍需等待目标聊天确认。' : '无法确认登录或额度，请检查 Codex 登录状态后重试。', quota: { primary: quota.primary, secondary: quota.secondary, ordinaryUsageAllowed: quota.ordinaryUsageAllowed,readAt:quota.readAt,refreshing:false,error:null }, plan: quota.plan, capabilities: { ...this.connection.capabilities, readQuota: confirmed, sendMessage: confirmed && versionAtLeast(this.cli?.version, QUEUE_MINIMUM) } });
      return quota;
    } catch (caught) {
      // Never keep displaying an old positive allowance as a fresh signal.
      this.quotaCache = null;
      this._status({ connected: false, checking: false, message: '无法确认登录或额度，请检查 Codex 登录状态后重试。', quota: { primary:null,secondary:null,ordinaryUsageAllowed:null,readAt:null,refreshing:false,error:'暂时无法读取官方额度' }, capabilities: { ...this.connection.capabilities, readQuota: false, sendMessage: false } });
      throw caught;
    }finally{this.quotaReading=null;}})();
    return this.quotaReading;
  }
  async refreshQuota(){await this._quota({force:true});return this.status();}
  async diagnose() {
    this._status({ checking: true });
    try {
      await this._ensure();
      await this._quota({ force: true });
      await this._loadThreads({ force: true, maxPages: 1 });
      try {
        const result = await this.native('Capabilities', {}); this.desktop = result.desktop || null;
        const windows = Array.isArray(result.windows) ? result.windows : [];
        this.windowTitles = new Map(windows.filter(w => typeof w.id === 'string').map(w => [w.id, text(w.title, 200)]));
        this._status({ capabilities: { ...this.connection.capabilities, resolveCurrent: windows.length > 0, answerQuestion: false }, ordinaryQuestionReason: text(this.desktop?.ordinaryQuestionReason, 1000) || ORDINARY_REASON });
      } catch (caught) {
        this._status({ capabilities: { ...this.connection.capabilities, resolveCurrent: false, answerQuestion: false }, message: `Codex 索引和额度读取正常；窗口助手不可用：${text(caught.message, 300)}` });
      }
    } catch (caught) {
      this._status({ message: this.connection.quota.error ? '无法确认登录或额度，请检查 Codex 登录状态后重试。' : text(caught.message, 500) || 'Codex 连接诊断失败' });
    } finally { this._status({ checking: false }); }
    return this.status();
  }
  async _loadThreads({ force = false, maxPages = 5 } = {}) {
    if (!force && this.threadCache && this.now() - this.threadCache.at < 15000 && (this.threadCache.complete || this.threadCache.pages >= maxPages)) return this.threadCache.rows;
    const rpc = await this._ensure(); const rows = [], seen = new Set(); let cursor = null, complete = false, pages = 0;
    do {
      const params = { limit: 50, useStateDbOnly: true, modelProviders: [], sourceKinds: [], sortKey: 'updated_at', sortDirection: 'desc' };
      if (cursor) params.cursor = cursor;
      const result = await rpc.request('thread/list', params);
      if (!Array.isArray(result?.data)) throw error('Codex 聊天列表响应无效，请检查 CLI 版本', 'RPC_PROTOCOL');
      for (const thread of result.data) {
        if (!THREAD_ID.test(thread?.id || '') || seen.has(thread.id.toLowerCase())) continue;
        if (isSubagent(thread.source)) continue;
        const id = thread.id.toLowerCase(); seen.add(id);
        rows.push({ id, name: text(thread.name || thread.preview, 300) || `聊天 ${id.slice(0, 8)}`, project: text(thread.cwd || thread.project?.name, 500), link: `codex://threads/${id}` });
      }
      pages++; cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null; complete = !cursor;
    } while (cursor && pages < maxPages && rows.length < 250);
    this.threadCache = { at: this.now(), rows: rows.slice(0, 250), complete, pages };
    return this.threadCache.rows;
  }
  async listThreads({ query = '' } = {}) {
    const rows = await this._loadThreads(); const term = text(query, 200).trim().toLowerCase();
    return structuredClone(term ? rows.filter(row => `${row.id} ${row.name} ${row.project}`.toLowerCase().includes(term)) : rows);
  }
  async listWindows() {
    const result = await this.native('ListWindows', {});
    const windows = (Array.isArray(result.windows) ? result.windows : []).filter(window => typeof window?.id === 'string' && typeof window.title === 'string').slice(0, 40).map(window => ({ id: window.id.slice(0, 500), title: text(window.title, 300) }));
    this.windowTitles = new Map(windows.map(window => [window.id, window.title]));
    this._status({ capabilities: { ...this.connection.capabilities, resolveCurrent: windows.length > 0 } });
    return windows;
  }
  async captureCurrent(windowId) {
    if (typeof windowId !== 'string' || !windowId || windowId.length > 500) throw error('所选 Codex 窗口标识无效');
    const result = await this.native('CaptureLink', { windowId });
    const parsed = parseLink(result.link);
    if (result.windowId !== windowId || typeof result.threadId !== 'string' || result.threadId.toLowerCase() !== parsed.threadId) throw error('当前窗口与聊天链接无法相互核对，已阻止操作');
    return { type: 'current', windowId, confirmedThreadId: parsed.threadId, nickname: this.windowTitles.get(windowId) || '所选 Codex 窗口的当前聊天' };
  }
  async _identity(target) {
    const normalized = normalizeTarget(target);
    if (normalized.type === 'fixed') return { threadId: normalized.threadId };
    const captured = await this.captureCurrent(normalized.windowId);
    return { threadId: captured.confirmedThreadId, windowId: captured.windowId };
  }
  _context(task) {
    if (task?.id) {
      this.contexts.set(task.id, { kind: task.kind, autoReply: text(task.autoReply, 100000), autoAnswerOrdinary: task.autoAnswerOrdinary !== false, markerThreadIds: task.kind === 'watch' ? (task.intents || []).filter(intent => intent.type === 'send_message' && ['queued', 'confirmed'].includes(intent.status) && THREAD_ID.test(intent.threadId || '')).map(intent => intent.threadId.toLowerCase()) : [] });
      if (this.contexts.size > 1000) this.contexts.delete(this.contexts.keys().next().value);
    }
    return task;
  }
  async observe(target, { task = {} } = {}) {
    this._context(task); let identity;
    try {
      identity = await this._identity(target); const observation = await this._observeIdentity(identity, task);
      if (observation.question?.kind === 'ordinary' && !this.connection.capabilities.answerQuestion) return { ...observation, status: 'needs_attention', reason: ORDINARY_REASON };
      return observation;
    }
    catch (caught) {
      return { ...(identity || {}), status: isNetwork(caught) ? 'waiting_network' : caught.code === 'INVALID_TARGET' ? 'needs_attention' : 'unknown', reason: text(caught.message, 700) || '无法可靠读取目标状态，已停止自动操作', goalCompleted: false };
    }
  }
  async _observeIdentity(identity, task = {}, { fresh = false } = {}) {
    const rpc = await this._ensure();
    const result = await rpc.request('thread/read', { threadId: identity.threadId, includeTurns: false });
    const thread = result?.thread;
    if (!THREAD_ID.test(thread?.id || '') || thread.id.toLowerCase() !== identity.threadId) throw error('Codex 返回的聊天标识与目标聊天不一致，已阻止发送');
    if (thread.archived === true) throw error('目标聊天已归档，请先在 Codex 中确认后重新选择');
    if (isSubagent(thread.source)) throw error('目标是子代理线程，不能作为桌面助手的发送目标');
    let observation, records = [], clientMessageIds = [], markerAgreed = false;
    try {
      if (!thread.path) throw error('此聊天没有可读取的本机持久记录，无法判定桌面回合状态', 'UNSUPPORTED');
      let tail = await this.readTail(thread.path, { threadId: identity.threadId, verify:fresh });
      if(tail.incomplete)return{...identity,status:'waiting_network',reason:'聊天记录仍在写入或正在补全读取，稍后重新核对；尚未发送消息',goalCompleted:false};
      const context = this.contexts.get(task.id);
      markerAgreed = task.kind === 'watch' && Boolean(context?.markerThreadIds?.includes(identity.threadId) || this.markerRequested.get(task.id) === identity.threadId);
      records = tail.records;
      clientMessageIds = Array.isArray(tail.clientMessageIds) ? tail.clientMessageIds : records
        .filter(record => record?.type === 'event_msg' && record.payload?.type === 'user_message')
        .map(record => record.payload.client_id);
      observation = { ...parseRollout(records, { threadId: identity.threadId, expectDoneMarker: markerAgreed }), ...identity };
    } catch (caught) {
      if (caught.code === 'INVALID_TARGET') throw caught;
      // A failed scan can have omitted an approval, stop, or completion proof.
      // A stale turn summary cannot turn that coverage failure into permission.
      return { ...identity, status: 'unknown', reason: '无法完整核对聊天的运行、停止和完成记录，已阻止自动发送', goalCompleted: false };
    }
    if (observation.status === 'unknown'||observation.status==='waiting_network') {
      // This is persisted TURN history, distinct from the separately launched
      // server's runtime Thread.status. One bounded metadata-only turn page can
      // supply a lifecycle boundary that fell outside the JSONL tail.
      try {
        const summary = await rpc.request('thread/turns/list', { threadId: identity.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const turn = summary?.data?.[0];
        const validTurn=typeof turn?.id==='string'&&turn.id&&turn.id.length<=300;
        const noSummaryError=turn?.error==null||(typeof turn.error==='object'&&!Array.isArray(turn.error)&&Object.keys(turn.error).length===0);
        if(validTurn&&observation.status==='waiting_network'&&turn.status==='inProgress'){
          observation={...identity,status:'active',lastTurnId:turn.id,reason:'最新持久回合状态显示仍在运行，助手不会追加消息',goalCompleted:false};
        }else if(validTurn&&observation.status==='waiting_network'&&turn.status==='failed'&&turn.id===observation.lastTurnId&&observation.networkRecovery?.turnId===turn.id&&noSummaryError){
          observation={...observation,networkRecovery:{...observation.networkRecovery,terminal:true}};
        }else if (validTurn && (!observation.lastTurnId || observation.lastTurnId === turn.id)) {
          let events = [];
          if (turn.status === 'inProgress') events = [{ type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } }];
          else if (turn.status === 'completed' && Number.isFinite(turn.completedAt)) events = [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } }];
          else if (turn.status === 'interrupted') events = [{ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn.id } }];
          else if (turn.status === 'failed') events = [{ type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } }, { type: 'event_msg', payload: { type: 'turn_failed', turn_id:turn.id, codex_error_info: turn.error?.codexErrorInfo, message: turn.error?.message } }];
          // For a completed summary, keep the real final assistant record so
          // same-turn agreed completion proof is not replaced by a synthetic
          // empty final. A different tail turn can never be completed by this.
          if (events.length) observation = { ...parseRollout([...records, ...events], { threadId: identity.threadId, expectDoneMarker: markerAgreed }), ...identity };
        }else if(validTurn&&observation.status==='waiting_network'){
          observation={...observation,networkRecovery:null,reason:'最新回合与本机事件尚未一致，等待重新核对后再决定是否重试'};
        }
      } catch (caught) { if (isNetwork(caught)) throw caught; }
    }
    // A queue receipt proves only acceptance into the queue. Correlate the
    // durable user-message event with this task's exact client message ID;
    // an unrelated new turn, or a vanished queue item, proves no delivery.
    const queuedIds = new Set((Array.isArray(task.intents) ? task.intents : [])
      .filter(intent => intent?.status === 'queued' && intent?.type === 'send_message' && intent.threadId === identity.threadId && THREAD_ID.test(intent.id || ''))
      .map(intent => intent.id.toLowerCase()));
    const acceptedMessageIds = new Set();
    for (const clientId of clientMessageIds) if (typeof clientId === 'string' && THREAD_ID.test(clientId) && queuedIds.has(clientId.toLowerCase())) acceptedMessageIds.add(clientId.toLowerCase());
    if (acceptedMessageIds.size) observation.acceptedMessageIds = [...acceptedMessageIds];
    if(!fresh&&acceptedMessageIds.size)return this._observeIdentity(identity,task,{fresh:true});
    // Summary-derived completion needs the same full verification as a terminal
    // JSONL record. Rebuild both the local evidence and matching summary before
    // the engine may permanently finish a watch.
    if(!fresh&&observation.goalCompleted)return this._observeIdentity(identity,task,{fresh:true});
    const previouslyBlocked = this.quotaBlocked.has(identity.threadId) || task.state === 'waiting_quota' || task.blocker?.type === 'quota';
    const recordQuota = observation.status === 'waiting_quota';
    if (recordQuota || previouslyBlocked) this.quotaBlocked.set(identity.threadId, this.quotaBlocked.get(identity.threadId) || { eventId: task.blocker?.eventKey || `${identity.threadId}:${observation.lastTurnId || 'quota'}`, resetAt: task.blocker?.resetAt ?? null });
    let quota;
    try { quota = await this._quota({ force: fresh || recordQuota || previouslyBlocked }); }
    catch (caught) {
      if (observation.status === 'active') return observation;
      if (isNetwork(caught)) return { ...observation, status: 'waiting_network', reason: '官方额度读取连接暂不可用，等待重新核对，未推断额度已恢复', goalCompleted: false };
      if (recordQuota || previouslyBlocked) return { ...observation, status: 'waiting_quota', reason: '此前已遇到额度限制，当前无法获得新鲜的官方允许信号', quota: { source: 'unknown', resetAt: this.quotaBlocked.get(identity.threadId)?.resetAt ?? null, eventId: this.quotaBlocked.get(identity.threadId)?.eventId }, goalCompleted: false };
      return { ...observation, status: 'unknown', reason: '无法读取官方额度，暂不进行自动发送', goalCompleted: false };
    }
    const exhausted = [quota.primary, quota.secondary].filter(window => Number.isFinite(window?.usedPercent) && window.usedPercent >= 100);
    if (quota.ordinaryUsageAllowed === true && exhausted.length === 0) this.quotaBlocked.delete(identity.threadId);
    if (observation.status === 'active') return observation;
    // A blocking question or explicit manual stop always keeps its exact meaning.
    if (observation.question || observation.status === 'needs_attention') return observation;
    if (quota.ordinaryUsageAllowed === false || exhausted.length > 0 || (this.quotaBlocked.has(identity.threadId) && quota.ordinaryUsageAllowed !== true)) {
      const previous = this.quotaBlocked.get(identity.threadId);
      const resets = exhausted.map(window => window.resetAt);
      const resetAt = resets.length && resets.every(value => Number.isSafeInteger(value) && value > this.now()) ? Math.max(...resets) : null;
      const eventId = previous?.eventId || `${identity.threadId}:${observation.lastTurnId || 'quota'}:${resetAt || 'unknown'}`;
      this.quotaBlocked.set(identity.threadId, { resetAt, eventId });
      const reason = exhausted.length ? '至少一项额度已用尽，等待恢复并定期重新核对' : quota.ordinaryUsageAllowed === false ? '官方明确表示普通用量暂不可用；会定期重新读取官方允许状态' : '此前额度受限，百分比或未知状态不能证明恢复，继续等待官方允许信号';
      return { ...observation, status: 'waiting_quota', reason, quota: { source: 'official', resetAt, eventId }, goalCompleted: false };
    }
    if (recordQuota && quota.ordinaryUsageAllowed === true) return { ...observation, status: 'turn_completed', reason: '已取得新鲜的官方普通用量允许信号，可继续先前因额度停止的回合', quota: { source: 'official', resetAt: null }, goalCompleted: false };
    if(observation.status==='waiting_network')return this._recoverNetwork(identity.threadId,observation,quota);
    if(observation.status==='turn_completed')this.networkRetries.delete(identity.threadId);
    return observation;
  }
  _recoverNetwork(threadId,observation,quota){
    const evidence=observation.networkRecovery;
    if(!evidence?.terminal||!evidence.turnId)return{...observation,reason:'尚未确认网络失败的回合已经结束，继续等待，避免与客户端自身重试重叠'};
    if(!evidence.retryable)return{...observation,status:'needs_attention',reason:'网络错误缺少可验证的临时故障类型，请在 Codex 中核实后处理'};
    const now=this.now();let retry=this.networkRetries.get(threadId);
    if(!retry||retry.turnId!==evidence.turnId){
      const attempts=retry&&now>=retry.failedAt&&now-retry.readyAt<300000?Math.min(5,retry.attempts+1):1;
      retry={turnId:evidence.turnId,attempts,failedAt:now,readyAt:now+Math.min(300000,30000*(2**(attempts-1)))};
      this.networkRetries.set(threadId,retry);
      if(this.networkRetries.size>500)this.networkRetries.delete(this.networkRetries.keys().next().value);
    }
    if(now<retry.readyAt)return{...observation,reason:'已确认回合因临时网络错误结束，等待退避后再尝试继续'};
    if(quota.ordinaryUsageAllowed!==true)return{...observation,reason:'尚未取得新鲜的官方允许状态，继续等待网络和额度核对'};
    return{...observation,status:'turn_completed',reason:'网络失败回合已结束，退避时间已到且官方允许使用，可以尝试继续',goalCompleted:false};
  }
  perform(action) {
    const key = typeof action?.id === 'string' ? action.id : '';
    const fingerprint = JSON.stringify([action?.target, action?.threadId, action?.type, action?.message, action?.questionId, action?.attachments??[]]);
    const previous = this.operations.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.reject(error('同一操作标识对应了不同内容，已阻止重复操作'));
    const attempt = { possibleWrite: false };
    const promise = this._perform(action, attempt).catch(caught => {
      if (attempt.possibleWrite) return { status: 'unknown', threadId: action.threadId, message: '发送阶段发生错误，操作可能已经入队，助手不会重发，请在目标聊天核实' };
      const result = { status: 'not_sent', possibleWrite: false, threadId: action?.threadId, message: text(caught.message, 1000) || '发送前核对未通过，未提交消息', retryState: isNetwork(caught) ? 'waiting_network' : caught.code === 'ACTIVE' ? 'running' : caught.code === 'QUOTA_UNAVAILABLE' ? 'waiting_quota' : 'needs_attention' };
      if (Number.isFinite(caught.retryAt)) result.retryAt = caught.retryAt;
      return result;
    });
    this.operations.set(key, { fingerprint, promise });
    // The persistent core ledger is authoritative across restarts. This bounded
    // session cache additionally coalesces duplicate/concurrent calls to one RPC.
    if (this.operations.size > 2000) this.operations.delete(this.operations.keys().next().value);
    return promise;
  }
  async _perform(action, attempt) {
    if (!THREAD_ID.test(action?.id || '') || !THREAD_ID.test(action?.threadId || '')) throw error('发送操作或聊天标识无效');
    if (action.type === 'answer_question') throw error(`普通问题自动回答不可用：${ORDINARY_REASON}`, 'UNSUPPORTED');
    const attachments=normalizeAttachments(action.attachments);
    if (action.type !== 'send_message' || typeof action.message !== 'string' || (!action.message.trim()&&!attachments.length) || action.message.length > 100000 || /\u0000/u.test(action.message)) throw error('发送操作类型或消息内容无效');
    const target = normalizeTarget(action.target), expected = action.threadId.toLowerCase();
    if (target.type === 'fixed' && target.threadId !== expected) throw error('发送操作与固定目标聊天不一致');
    if (this.performingThreads.has(expected)) throw error('此聊天有另一项发送正在核对，请等待其结果');
    this.performingThreads.add(expected);
    try {
      const identity = await this._identity(target);
      if (identity.threadId !== expected) throw error('所选窗口的当前聊天已经切换，已阻止发送');
      const context = this.contexts.get(action.taskId) || {};
      let imageInputs=[];
      if(attachments.length){
        if(typeof this.resolveImages!=='function')throw error('图片存储尚未就绪，请重新添加图片','UNSUPPORTED');
        imageInputs=await this.resolveImages(attachments);
        if(!Array.isArray(imageInputs)||imageInputs.length!==attachments.length||imageInputs.some(image=>image?.type!=='localImage'||typeof image.path!=='string'||!path.isAbsolute(image.path)))throw error('图片存储返回的发送数据无效');
      }
      const observation = await this._observeIdentity(identity, { id: action.taskId, kind: context.kind }, { fresh: true });
      if (observation.threadId !== expected) throw error('发送前无法核对目标聊天');
      if (!['idle', 'turn_completed'].includes(observation.status) || observation.goalCompleted) throw error(observation.status === 'active' ? '目标聊天仍在运行，已跳过发送' : observation.reason || '当前状态不允许安全发送', observation.status === 'waiting_quota' ? 'QUOTA_UNAVAILABLE' : observation.status === 'active' ? 'ACTIVE' : observation.status === 'waiting_network' ? 'RPC_DISCONNECTED' : 'INVALID_TARGET', { retryAt: observation.quota?.resetAt });
      const rpc = await this._ensure();
      if (!versionAtLeast(this.cli?.version, QUEUE_MINIMUM)) throw error('当前 CLI 版本无法核实实验队列支持，请更新 Codex 后重试', 'UNSUPPORTED');
      let message = action.message;
      if (context.kind === 'watch') {
        const english = this.settings()?.language === 'en';
        message += english
          ? `\n\n[Codex Timer Assistant watch instruction]\nContinue all goals already agreed in this chat. Only when all goals and necessary verification are complete, put ${DONE_MARKER} alone on the last line of the final reply. Do not output it for intermediate work, partial completion, or a blocker.`
          : `\n\n【Codex 定时助手看守约定】\n继续完成本聊天已经约定的全部目标。只有全部目标均已完成并完成必要验证时，才在最终回复的最后一行单独输出 ${DONE_MARKER}。中间回合、部分完成或遇到阻塞时不要输出该标记。`;
        if (context.autoReply && context.autoAnswerOrdinary && this.settings()?.autoAnswerOrdinary !== false) message += english
          ? `\nFor ordinary choices, decide using this rule:\n${context.autoReply}\nThis does not replace approvals or expand the permissions already granted in this chat.`
          : `\n遇到普通选择时，请按以下预设规则自行作出合理决定：\n${context.autoReply}\n该规则不代替权限审批，也不扩大本聊天已经授予的操作权限。`;
      }
      // Resolve current-page identity again immediately before queue/add. No
      // previous setup confirmation or cached window title is treated as current.
      if (target.type === 'current') {
        const recaptured = await this._identity(target);
        if (recaptured.windowId !== identity.windowId || recaptured.threadId !== expected) throw error('发送前所选窗口的当前聊天已经切换，已阻止发送');
      }
      const readyQuota = this.quotaCache;
      const quotaAge = this.now() - readyQuota?.readAt;
      const exhausted = [readyQuota?.primary, readyQuota?.secondary].some(window => Number.isFinite(window?.usedPercent) && window.usedPercent >= 100);
      if (readyQuota?.ordinaryUsageAllowed !== true || !Number.isFinite(quotaAge) || quotaAge < 0 || quotaAge > 45000 || exhausted) {
        throw error('无法确认官方额度允许发送，等待重新核对', 'QUOTA_UNAVAILABLE');
      }
      const input=[...(message.trim()?[{type:'text',text:message,text_elements:[]}]:[]),...imageInputs];
      let result;
      try {
        attempt.possibleWrite = true;
        result = await rpc.request('thread/queue/add', { threadId: expected, clientUserMessageId: action.id, input }, { write: true, timeoutMs: 20000 });
      }
      catch (caught) {
        // Once the request could have reached storage, neither a timeout nor a
        // generic server error proves refusal. Never enqueue it a second time.
        if (caught.possibleWrite === false) { attempt.possibleWrite = false; throw caught; }
        return { status: 'unknown', threadId: expected, message: '排队请求发出后未取得可核实结果；可能已经入队，助手不会重发，请在原聊天核实' };
      }
      const submission = result?.queuedSubmission;
      if (typeof submission?.id !== 'string' || !submission.id || (submission.clientUserMessageId !== undefined && submission.clientUserMessageId !== action.id)) return { status: 'unknown', threadId: expected, message: '队列响应缺少匹配的提交凭据，助手不会重发，请在目标聊天核实' };
      if (context.kind === 'watch') this.markerRequested.set(action.taskId, expected);
      let note = '消息已进入共享队列；尚未确认目标聊天开始运行';
      if (this.desktop?.supportsWake === true && versionAtLeast(this.cli.version, QUEUE_MINIMUM) && typeof this.openExternal === 'function') {
        try {
          await bounded(Promise.resolve(this.openExternal(`codex://threads/wake/${expected}`)), 4000, '桌面唤醒请求超时');
          note += '，已向已核实兼容的桌面请求唤醒';
        } catch { note += '；桌面唤醒请求未得到确认，请检查 Codex 窗口'; }
      } else note += '。未加载或已中断的聊天可能需要在 Codex 中手工恢复';
      return { status: 'queued', receipt: submission.id.slice(0, 500), threadId: expected, message: note };
    } finally { this.performingThreads.delete(expected); }
  }
  async close() { this.closed = true; if (this.rpc) await this.rpc.close(); this._status({ connected: false, checking: false }); }
}
