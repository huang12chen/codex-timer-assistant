import { currentLanguage, tr } from './i18n.mjs';

export function formatDuration(value) {
  const seconds = Math.max(0, Math.ceil(Number(value || 0) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
}
export function toLocalInput(value, zone, seconds = false) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds?{second:'2-digit'}:{}), hourCycle: 'h23' }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}${seconds?':'+p.second:''}`;
}
export function parseLocalInput(value, zone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error(tr('请选择有效的日期和时间'));
  const [year, month, day, hour, minute, second=0] = value.match(/\d+/g).map(Number);
  const requested = Date.UTC(year, month - 1, day, hour, minute, second), valid=new Date(requested);
  if(valid.getUTCFullYear()!==year||valid.getUTCMonth()!==month-1||valid.getUTCDate()!==day||hour>23||minute>59||second>59)throw new Error(tr('请选择有效的日期和时间'));
  const seconds=value.length>16;
  let instant = requested;
  for (let i = 0; i < 4; i++) {
    const displayed = toLocalInput(instant, zone, seconds);
    const [y, m, d, h, min, sec=0] = displayed.match(/\d+/g).map(Number);
    const delta = requested - Date.UTC(y, m - 1, d, h, min,sec);
    if (!delta) return instant;
    instant += delta;
  }
  if (toLocalInput(instant, zone,seconds) !== value) throw new Error(tr('此时间在所选时区不存在，请避开夏令时切换时段'));
  return instant;
}
export function formatDate(value, zone, short = false, seconds=false) {
  if (!Number.isFinite(value)) return tr('不限时间');
  return new Intl.DateTimeFormat(currentLanguage()==='en'?'en-US':'zh-CN', { timeZone: zone, ...(short ? {} : { year:'numeric', month: 'long', day: 'numeric' }), hour: '2-digit', minute: '2-digit', ...(seconds?{second:'2-digit'}:{}), hourCycle: 'h23' }).format(value);
}
export function quotaWindowLabel(bucket) {
  const minutes=bucket?.windowDurationMins;
  if (!Number.isSafeInteger(minutes) || minutes<=0) return tr('额度剩余');
  if (minutes===300) return tr('5 小时剩余');
  if (minutes===10080) return tr('本周剩余');
  const english=currentLanguage()==='en';
  if (minutes%1440===0) return english?`${minutes/1440}-day limit`:`${minutes/1440} 天剩余`;
  if (minutes%60===0) return english?`${minutes/60}-hour limit`:`${minutes/60} 小时剩余`;
  return english?`${minutes}-minute limit`:`${minutes} 分钟剩余`;
}
export function formatQuotaCountdown(ms) {
  if (!Number.isFinite(ms) || ms<86400000) return formatDuration(ms);
  const days=Math.floor(ms/86400000),hours=Math.floor(ms%86400000/3600000);
  return currentLanguage()==='en'?`${days}d ${hours}h`:`${days}天 ${hours}小时`;
}
export function isQuotaFresh(connection,now=Date.now()){
  const quota=connection?.quota,age=now-quota?.readAt;
  return Boolean(connection?.connected&&connection.capabilities?.readQuota&&Number.isFinite(quota?.readAt)&&quota.stale!==true&&!quota.error&&age>=0&&age<=45000);
}
export function quotaResetInfo(connection,key,now=Date.now()){
  const resetAt=connection?.quota?.[key]?.resetAt;
  if(!isQuotaFresh(connection,now)||!Number.isSafeInteger(resetAt)||resetAt<=0||resetAt>8640000000000000)return{status:'unknown',resetAt:null,remainingMs:null};
  return{status:resetAt>now?'countdown':'checking',resetAt,remainingMs:Math.max(0,resetAt-now)};
}
export function quotaScheduleAt(connection,{bufferMinutes=1,now=Date.now()}={}){
  if(!isQuotaFresh(connection,now)||!Number.isInteger(bufferMinutes)||bufferMinutes<0||bufferMinutes>60)return null;
  const buckets=[connection.quota.primary,connection.quota.secondary].filter(Boolean);
  const blocked=buckets.filter(bucket=>Number.isFinite(bucket.usedPercent)&&bucket.usedPercent>=100);
  const candidates=blocked.length?blocked:[connection.quota.primary||connection.quota.secondary].filter(Boolean);
  if(!candidates.length||candidates.some(bucket=>!Number.isSafeInteger(bucket.resetAt)||bucket.resetAt<=0))return null;
  const scheduledAt=Math.max(...candidates.map(bucket=>bucket.resetAt))+bufferMinutes*60000;
  return Number.isSafeInteger(scheduledAt)&&scheduledAt>now&&scheduledAt<=8640000000000000?scheduledAt:null;
}
export function isEnabledTask(task){return Boolean(task?.enabled&&!['paused','completed','expired'].includes(task.state));}
export function taskStatusLabel(task,now=Date.now()){
  if((task.intents||[]).some(intent=>intent.status==='unknown'))return tr('待确认');
  if(task.state==='completed')return tr(task.kind==='once'?'已发送':'目标完成');
  if(task.state==='paused'&&task.reason==='任务尚未启用')return tr('未启用');
  if(task.state==='watching'&&task.scheduledAt>now)return tr('待开始');
  return tr(({scheduled:'待发送',watching:'看守中',running:'运行中',waiting_quota:'等待额度',waiting_network:'等待连接',waiting_user:'等待选择',needs_attention:'需要处理',queued:'等待确认',paused:'已暂停',expired:'已到期'}[task.state]||task.state));
}
export function upcoming(tasks, now = Date.now()) {
  return tasks.filter(t => isEnabledTask(t)&&t.state!=='needs_attention').map(task => {
    let due=null,phase=task.state==='queued'?'confirmation':task.state==='running'?'running':task.state==='waiting_user'?'user':'watch';
    if(task.scheduledAt>now||task.state==='scheduled'){due=task.scheduledAt;phase='start';}
    else if(task.state==='waiting_quota'){due=task.nextAttemptAt??task.lastObservation?.quota?.resetAt;phase='quota';}
    else if(task.state==='waiting_network'){due=task.nextAttemptAt;phase='retry';}
    return { task, phase, due: Number.isFinite(due) ? due : null };
  }).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))[0] ?? null;
}

