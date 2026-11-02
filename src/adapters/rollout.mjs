import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AdapterError } from './process.mjs';
import { createRolloutReader as lifecycleReader } from './rollout-reader.mjs';

export function createRolloutReader(options={}) {
  const roots=options.roots;
  return lifecycleReader({...options,roots:typeof roots==='function'?roots:()=>roots||defaultRolloutRoots()});
}

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const DONE_MARKER = '[CODEX_TIMER_DONE]';
export const defaultRolloutRoots = () => {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
};
const within = (file, root) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

export async function readRolloutTail(file, { threadId, roots = defaultRolloutRoots(), maxBytes = 768 * 1024, maxRecords = 1600 } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.jsonl' || !THREAD_ID.test(threadId || '')) throw new AdapterError('聊天的持久记录路径无效，不能读取实时状态', 'INVALID_TARGET');
  const canonical = await realpath(file);
  const canonicalRoots = (await Promise.all(roots.map(async root => { try { return await realpath(root); } catch { return null; } }))).filter(Boolean);
  if (!canonicalRoots.some(root => within(canonical, root))) throw new AdapterError('聊天记录不在当前用户的 Codex 会话目录，已拒绝读取', 'INVALID_TARGET');
  const handle = await open(canonical, 'r');
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new AdapterError('聊天记录不是普通文件', 'INVALID_TARGET');
    // session_meta may contain a long instruction document. Validate the actual
    // first record independently of the event-tail limit, with a separate cap.
    const headerParts = []; let headerSize = 0, foundNewline = false;
    while (headerSize < Math.min(info.size, 2 * 1024 * 1024) && !foundNewline) {
      const part = Buffer.alloc(Math.min(65536, info.size - headerSize, 2 * 1024 * 1024 - headerSize));
      const { bytesRead } = await handle.read(part, 0, part.length, headerSize);
      if (!bytesRead) break;
      const content = part.subarray(0, bytesRead), newline = content.indexOf(10);
      headerParts.push(newline >= 0 ? content.subarray(0, newline) : content); headerSize += bytesRead; foundNewline = newline >= 0;
    }
    if (!foundNewline && headerSize < info.size) throw new AdapterError('聊天元数据超过读取上限，无法核对会话标识', 'INVALID_TARGET');
    const firstLine = Buffer.concat(headerParts).toString('utf8').replace(/^\uFEFF/u, '');
    let meta; try { meta = JSON.parse(firstLine); } catch { throw new AdapterError('聊天记录缺少可核对的会话标识', 'INVALID_TARGET'); }
    if (meta.type !== 'session_meta' || String(meta.payload?.id).toLowerCase() !== threadId.toLowerCase()) throw new AdapterError('聊天记录标识与目标聊天不一致，已拒绝读取', 'INVALID_TARGET');
    const length = Math.min(info.size, Math.min(2 * 1024 * 1024, Math.max(4096, maxBytes)));
    const offset = Math.max(0, info.size - length), buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) { const next = text.indexOf('\n'); text = next < 0 ? '' : text.slice(next + 1); }
    // A writer can be in the middle of its next JSONL record. Never infer state
    // from that partial record, and never hold or bypass its writer lock.
    if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const lines = text.split('\n').filter(line => line.trim()).slice(-maxRecords);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line.replace(/^\uFEFF/u, ''))); } catch { throw new AdapterError('聊天记录中存在无法识别的完整行，无法安全判断状态', 'ROLLOUT_PROTOCOL'); }
    }
    return { records, truncated: offset > 0 || lines.length >= maxRecords, modifiedAt: info.mtimeMs };
  } finally { await handle.close(); }
}

const clean = (value, max = 1000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').slice(0, max) : '';
const json = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value); } catch { return null; } };
const toolName = value => typeof value === 'string' ? value.split(/[.:/]/u).at(-1) : '';
const textContent = payload => Array.isArray(payload.content) ? payload.content.filter(part => part?.type === 'output_text' || part?.type === 'text').map(part => part.text || '').join('\n') : '';
const finalLine = text => clean(text, 200000).trim().split(/\r?\n/u).at(-1) === DONE_MARKER;
const PERMISSION = /权限|批准|授权|提权|管理员|是否允许|允许访问|确认支付|确认购买|支付|购买|付费|公开发布|发布到|部署到|删除|覆盖|密钥|令牌|密码|付款|转账|发邮件|发送给|发送消息|(?<![a-z])(?:permission|approve|approval|authorize|authorise|elevat\w*|admin(?:istrator)?|sudo|payment|purchase|buy|paid|charge|publish|deploy|delete|overwrite|password|secret|token|credential|send\s+(?:an?\s+)?(?:email|message)|transfer)(?![a-z])/iu;

export function classifyQuestion(args, callId) {
  const questions = args?.questions;
  if (!callId || !Array.isArray(questions) || questions.length < 1 || questions.length > 3) return { id: clean(callId, 300), kind: 'unknown', text: '问题结构不完整，需本人处理' };
  const valid = questions.every(q => q && typeof q.id === 'string' && q.id && typeof q.question === 'string' && q.question && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && q.options.every(option => typeof option.label === 'string' && option.label));
  const wording = questions.map(q => `${q?.question || ''}\n${q?.options?.map(option => `${option.label || ''} ${option.description || ''}`).join('\n') || ''}`).join('\n');
  return { id: clean(callId, 300), kind: PERMISSION.test(wording) ? 'permission' : valid ? 'ordinary' : 'unknown', text: clean(questions.map(q => q?.question || '').join('\n'), 3000) || '问题内容未知' };
}

export function normalizeQuota(raw, readAt = Date.now()) {
  const limits = raw?.rateLimits ?? Object.values(raw?.rateLimitsByLimitId || {}).find(value => value?.limitId === 'codex') ?? Object.values(raw?.rateLimitsByLimitId || {})[0] ?? {};
  const window = value => value && typeof value === 'object' ? {
    usedPercent: Number.isFinite(value.usedPercent) ? Math.min(100, Math.max(0, value.usedPercent)) : null,
    windowDurationMins: Number.isFinite(value.windowDurationMins) ? value.windowDurationMins : null,
    resetAt: Number.isFinite(value.resetsAt) && value.resetsAt > 0 && value.resetsAt < 8640000000000 ? value.resetsAt * 1000 : null,
  } : null;
  return { primary: window(limits.primary), secondary: window(limits.secondary), ordinaryUsageAllowed: typeof raw?.ordinaryUsageAllowed === 'boolean' ? raw.ordinaryUsageAllowed : null, plan: clean(limits.planType, 50) || null, readAt };
}

const errorPayload = payload => payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error) ? payload.error : payload;
const errorText = payload => JSON.stringify([payload.codex_error_info ?? payload.codexErrorInfo, payload.error, payload.message]).slice(0, 5000);
function networkFailure(payload) {
  const info=payload.codex_error_info??payload.codexErrorInfo;
  const type=typeof info==='string'?info:info&&typeof info==='object'&&Object.keys(info).length===1?Object.keys(info)[0]:'';
  const known=['httpconnectionfailed','responsestreamconnectionfailed','responsestreamdisconnected','responsetoomanyfailedattempts'].includes(type.replace(/_/gu,'').toLowerCase());
  if(known){
    const details=typeof info==='object'?info[type]:null;
    const status=details?.http_status_code??details?.httpStatusCode??null;
    return{known:true,retryable:status===null||(Number.isInteger(status)&&(status===408||status===429||(status>=500&&status<=599)))};
  }
  const wording=errorText(payload);
  return /network|connection|timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|DNS|网络|连接中断/iu.test(wording)?{known:false,retryable:false}:null;
}

export function parseRollout(records, { threadId, expectDoneMarker = false } = {}) {
  let state = { threadId, status: 'unknown', reason: '仅能读取持久记录，尚无明确的回合状态证据', goalCompleted: false };
  let running = false, question = null, blocker = null, latestFinal = '', goalConfirmed = false, networkRecovery=null, manuallyStopped=false;
  const goalCalls = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const p = record.payload || {};
    if (record.type === 'turn_context' && typeof p.turn_id === 'string' && p.turn_id) {
      if (state.lastTurnId && state.lastTurnId !== p.turn_id) {
        running = false; question = null; blocker = null; latestFinal = ''; goalConfirmed = false; networkRecovery=null; manuallyStopped=false;
        state = { threadId, status: 'unknown', reason: '记录出现新的回合上下文，尚无该回合的明确终止证据', goalCompleted: false };
      }
      state.lastTurnId = clean(p.turn_id, 300);
    } else if (record.type === 'event_msg') {
      const type = p.type;
      const eventTurnId=clean(p.turn_id||p.turnId,300);
      if(eventTurnId&&state.lastTurnId&&eventTurnId!==state.lastTurnId&&['task_complete','turn_complete','turn_aborted','task_aborted','turn_failed','error'].includes(type))continue;
      if (type === 'task_started' || type === 'turn_started') {
        running = true; question = null; blocker = null; latestFinal = ''; goalConfirmed = false; networkRecovery=null; manuallyStopped=false;
        state = { threadId, status: 'active', reason: '持久记录明确显示目标回合仍在运行', goalCompleted: false, ...(p.turn_id || p.turnId ? { lastTurnId: clean(p.turn_id || p.turnId, 300) } : {}) };
      } else if (type === 'error' || type === 'turn_failed' || ((type === 'task_complete' || type === 'turn_complete') && p.error != null)) {
        if(manuallyStopped)continue;
        const failure=errorPayload(p),network=networkFailure(failure);
        if(type==='error'&&network?.retryable&&p.will_retry===true&&running)continue;
        const error=errorText(failure);
        running = false; state.goalCompleted = false; networkRecovery=null;
        if(eventTurnId)state.lastTurnId=eventTurnId;
        if (/usageLimitExceeded|rateLimitExceeded|usage_limit|rate_limit|quota_exceeded|额度|配额/u.test(error)) { blocker = 'waiting_quota'; state.reason = '目标回合明确遇到额度限制，等待新鲜的官方允许信号'; }
        else if(network?.known&&!network.retryable){blocker='needs_attention';state.reason='目标回合记录了不可自动重试的连接错误，请核实登录或请求状态';}
        else if(network){
          blocker='waiting_network';state.reason='目标回合出现网络连接错误，等待重新读取';
          const turnId=state.lastTurnId||null;
          networkRecovery={retryable:network.retryable,turnId,terminal:type!=='error'&&Boolean(eventTurnId&&eventTurnId===turnId)};
        }
        else { blocker = 'needs_attention'; state.reason = '目标回合记录了错误，需要本人核实后继续'; }
        state.status = blocker;
      } else if (type === 'task_complete' || type === 'turn_complete') {
        // A terminal lifecycle record does not prove the user answered a prompt.
        // Keep unanswered questions until their matching output or a new turn.
        running = false;
        const endedId=clean(p.turn_id||p.turnId,300);
        if(networkRecovery)networkRecovery.terminal=Boolean(endedId&&endedId===networkRecovery.turnId);
        if (p.turn_id || p.turnId) state.lastTurnId = clean(p.turn_id || p.turnId, 300);
        state.status = blocker || 'turn_completed';
        state.reason = blocker === 'waiting_quota' ? '目标回合因额度限制停止，等待新鲜的官方允许信号' : blocker === 'waiting_network' ? '目标回合出现网络错误，等待连接恢复' : '持久记录明确显示该回合已完成，项目是否完成仍按约定判断';
        const text = typeof p.last_agent_message === 'string' ? p.last_agent_message : latestFinal;
        state.goalCompleted = !blocker && (goalConfirmed || (expectDoneMarker && finalLine(text)));
      } else if (type === 'turn_aborted' || type === 'task_aborted') {
        running = false; question = null; blocker = 'needs_attention'; networkRecovery=null; manuallyStopped=true;
        state.status = 'needs_attention'; state.reason = '目标回合已被停止，助手不会替本人重新启动'; state.goalCompleted = false;
        if (p.turn_id || p.turnId) state.lastTurnId = clean(p.turn_id || p.turnId, 300);
      } else if (/approval_request|request_approval/u.test(type || '')) {
        question = { id: clean(p.call_id || p.id || `${state.lastTurnId || 'unknown'}:approval`, 300), kind: 'permission', text: '目标聊天正在请求权限审批，请本人处理' };
      }
    } else if (record.type === 'response_item') {
      if (p.type === 'function_call') {
        if (toolName(p.name) === 'request_user_input') question = classifyQuestion(json(p.arguments), p.call_id);
        if (toolName(p.name) === 'update_goal' && json(p.arguments)?.status === 'complete') goalCalls.set(p.call_id, true);
      } else if (p.type === 'function_call_output') {
        if (question?.id && p.call_id === question.id) { question = null; if (running && !blocker) { state.status = 'active'; state.reason = '问题已得到回复，目标回合仍在运行'; } }
        if (goalCalls.has(p.call_id)) {
          const output = json(p.output);
          if (output?.goal?.status === 'complete' && output?.isError !== true && output?.error === undefined) goalConfirmed = true;
        }
      } else if (p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer') latestFinal = textContent(p);
    }
  }
  if (question) { state.question = question; state.status = 'waiting_user'; state.reason = question.kind === 'ordinary' ? '目标聊天存在尚未解决的普通选择题' : question.kind === 'permission' ? '目标聊天请求权限审批，请本人处理' : '目标聊天存在无法可靠分类的问题，请本人处理'; state.goalCompleted = false; }
  if(state.status==='waiting_network'&&networkRecovery)state.networkRecovery=networkRecovery;
  return state;
}
