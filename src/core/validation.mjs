import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export const TASK_STATES = Object.freeze([
  'scheduled', 'watching', 'running', 'waiting_quota', 'waiting_network',
  'waiting_user', 'needs_attention', 'queued', 'paused', 'completed', 'expired',
]);

export const DEFAULT_AUTO_REPLY = '根据本聊天已经确认的目标、约束和验收标准，自行比较并选择最合适的方案，简要记录理由后继续执行。普通实现选择无需再次询问我；完成约定目标后停止。';
export const DEFAULT_SETTINGS = Object.freeze({
  pausedAll: false, logLimit: 500, pollIntervalMs: 5000,
  autoAnswerOrdinary: true, defaultAutoReply: DEFAULT_AUTO_REPLY,
  showOrb: true, keepAwake: true, startOnLogin: false, glassTransparency: 40,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, cliPath: '', language: 'system',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^(?:password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|sessiontoken|apikey|accesskey|authorization|cookies?|sessioncookie|credentials)$/i;
export const clone = (value) => structuredClone(value);
export const isThreadId = (value) => typeof value === 'string' && UUID.test(value);
export const IMAGE_LIMITS = Object.freeze({count:8,bytes:10*1024*1024,totalBytes:32*1024*1024,side:16384,pixels:16777216});
const IMAGE_FIELDS = new Set(['id','name','mime','bytes','width','height','sha256']);

export function normalizeAttachments(value = []) {
  assertJson(value);
  if(!Array.isArray(value)||value.length>IMAGE_LIMITS.count)throw new ValidationError('最多添加8张图片');
  const ids=new Set();let total=0;
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!IMAGE_FIELDS.has(key)))throw new ValidationError('图片记录格式无效');
    if(!isThreadId(item.id)||ids.has(item.id.toLowerCase()))throw new ValidationError('图片标识无效或重复');
    if(!['image/png','image/jpeg','image/webp'].includes(item.mime))throw new ValidationError('仅支持PNG、JPEG和WebP图片');
    if(typeof item.name!=='string'||!item.name.trim()||item.name.length>200||/[\\/\u0000-\u001f\u007f]/u.test(item.name))throw new ValidationError('图片名称无效');
    for(const key of ['bytes','width','height'])if(!Number.isSafeInteger(item[key])||item[key]<1)throw new ValidationError('图片大小或尺寸无效');
    if(item.bytes>IMAGE_LIMITS.bytes||item.width>IMAGE_LIMITS.side||item.height>IMAGE_LIMITS.side||item.width*item.height>IMAGE_LIMITS.pixels)throw new ValidationError('图片大小或像素超过上限');
    total+=item.bytes;if(total>IMAGE_LIMITS.totalBytes)throw new ValidationError('图片总大小不能超过32MiB');
    if(typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/u.test(item.sha256))throw new ValidationError('图片校验信息无效');
    ids.add(item.id.toLowerCase());return{...item,id:item.id.toLowerCase(),name:item.name.trim()};
  });
}

export function messageField(value, attachments = []) {
  if(attachments.length&&(value===undefined||value===''))return '';
  return textField(value,'任务消息',100000);
}

export function assertJson(value, path = 'data', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new ValidationError(`${path} 必须是无循环的 JSON 数据`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ValidationError(`${path} 必须是普通 JSON 对象`);
  }
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL.test(key.replace(/[-_\s]/g, '')) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new ValidationError(`不允许保存凭据或不安全字段：${key}`);
    }
    assertJson(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function textField(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) {
    throw new ValidationError(`${label} 必须是 1–${max} 个字符的文本`);
  }
  return value.trim();
}

export function timeField(value, label, { nullable = false, fallback } = {}) {
  if (value === undefined) value = fallback;
  if (value === null && nullable) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) value = Date.parse(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) {
    throw new ValidationError(`${label} 必须是有效的绝对时间`);
  }
  return value;
}

export function parseThreadLink(value) {
  if (typeof value !== 'string' || value.length > 1000 || /[\s\\\u0000-\u001f]/.test(value)) {
    throw new ValidationError('请提供规范的 Codex 聊天链接');
  }
  let link = value;
  if (/^codex%3a/i.test(link)) {
    try { link = decodeURIComponent(link); }
    catch { throw new ValidationError('聊天链接编码无效'); }
  }
  const match = /^codex:\/\/threads\/([0-9a-f-]+)\/?$/i.exec(link);
  if (!match || !isThreadId(match[1])) throw new ValidationError('仅支持 codex://threads/<UUID> 聊天链接');
  const threadId = match[1].toLowerCase();
  return { threadId, link: `codex://threads/${threadId}` };
}

export function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new ValidationError('请选择目标聊天');
  const nickname = target.nickname === undefined ? undefined : textField(target.nickname, '目标昵称', 200);
  let result;
  if (target.type === 'fixed') {
    const parsed = parseThreadLink(target.link);
    if (target.threadId !== undefined && (!isThreadId(target.threadId) || target.threadId.toLowerCase() !== parsed.threadId)) {
      throw new ValidationError('聊天标识与固定链接不一致');
    }
    result = { type: 'fixed', ...parsed };
  } else if (target.type === 'current') {
    const windowId = textField(target.windowId, 'Codex 窗口标识', 500);
    if (!isThreadId(target.confirmedThreadId)) throw new ValidationError('添加当前页面任务前须确认当前聊天');
    result = { type: 'current', windowId, confirmedThreadId: target.confirmedThreadId.toLowerCase() };
  } else throw new ValidationError('目标类型无效');
  if (nickname !== undefined) result.nickname = nickname;
  return result;
}

export function validateSettings(patch, base = DEFAULT_SETTINGS) {
  assertJson(patch);
  if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new ValidationError('设置必须为对象');
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new ValidationError(`未知设置：${key}`);
  }
  const result = { ...base, ...patch };
  for (const key of ['pausedAll', 'autoAnswerOrdinary', 'showOrb', 'keepAwake', 'startOnLogin']) {
    if (typeof result[key] !== 'boolean') throw new ValidationError(`${key} 必须为布尔值`);
  }
  if (!Number.isInteger(result.logLimit) || result.logLimit < 1 || result.logLimit > 10000) throw new ValidationError('日志数量须为 1–10000');
  if (!Number.isInteger(result.pollIntervalMs) || result.pollIntervalMs < 1000 || result.pollIntervalMs > 3600000) throw new ValidationError('检查间隔须为 1 秒至 1 小时');
  if (!Number.isInteger(result.glassTransparency) || result.glassTransparency < 20 || result.glassTransparency > 85) throw new ValidationError('玻璃透明度须为 20–85');
  if (!['system', 'zh-CN', 'en'].includes(result.language)) throw new ValidationError('语言设置无效');
  result.defaultAutoReply = textField(result.defaultAutoReply, '默认回复', 100000);
  result.timeZone = textField(result.timeZone, '显示时区', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: result.timeZone }); }
  catch { throw new ValidationError('显示时区无效'); }
  if (typeof result.cliPath !== 'string' || result.cliPath.length > 4096 || /[\u0000-\u001f]/.test(result.cliPath)) {
    throw new ValidationError('Codex CLI 路径须为空或不超过 4096 个字符的有效路径文本');
  }
  return result;
}

const EDITABLE = new Set(['title', 'kind', 'target', 'message', 'enabled', 'scheduledAt', 'cutoffAt', 'autoAnswerOrdinary', 'autoReply', 'attachments']);

export function editableInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('任务必须为对象');
  const defined = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  assertJson(defined);
  for (const key of Object.keys(defined)) if (!EDITABLE.has(key)) throw new ValidationError(`不允许修改任务字段：${key}`);
  return defined;
}

export function newTask(input, now, settings) {
  input = editableInput(input);
  if (!['once', 'watch'].includes(input.kind)) throw new ValidationError('任务模式须为 once 或 watch');
  const enabled = input.enabled ?? false;
  const autoAnswerOrdinary = input.autoAnswerOrdinary ?? settings.autoAnswerOrdinary;
  if (typeof enabled !== 'boolean' || typeof autoAnswerOrdinary !== 'boolean') throw new ValidationError('启用和自动回复选项须为布尔值');
  const scheduledAt = timeField(input.scheduledAt, '触发时间', { fallback: input.kind === 'watch' ? now : undefined });
  const cutoffAt = timeField(input.cutoffAt, '截止时间', { nullable: true, fallback: input.kind === 'watch' ? now + 8 * 3600000 : null });
  const attachments=normalizeAttachments(input.attachments);
  if (cutoffAt !== null && (cutoffAt <= now || cutoffAt <= scheduledAt)) throw new ValidationError('截止时间须晚于当前时间和触发时间');
  return {
    id: randomUUID(), title: textField(input.title ?? (input.kind === 'watch' ? '持续看守' : '定时发送'), '任务名称', 200),
    kind: input.kind, target: normalizeTarget(input.target), message: messageField(input.message,attachments), attachments,
    enabled, state: enabled ? (input.kind === 'once' ? 'scheduled' : 'watching') : 'paused',
    reason: enabled ? '等待计划执行' : '任务尚未启用', scheduledAt, cutoffAt,
    autoAnswerOrdinary, autoReply: textField(input.autoReply ?? settings.defaultAutoReply, '普通问题回复', 100000),
    createdAt: now, updatedAt: now, nextAttemptAt: null, networkAttempts: 0, lastObservation: null, intents: [], blocker: null,
  };
}
