'use strict';
const METHODS = new Set(['snapshot', 'createTask', 'updateTask', 'taskAction', 'settings', 'diagnose', 'refreshQuota', 'retryScheduler', 'listThreads', 'listWindows', 'captureCurrent', 'readClipboard', 'openThread', 'window', 'exportLogs', 'clearLogs', 'chooseCli','importImages','imagePreviews','discardImages']);
const ORB_METHODS = new Set(['snapshot', 'window', 'pauseAll']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateCall(method, payload, role = 'main') {
  if (typeof method !== 'string' || !(METHODS.has(method) || method === 'pauseAll')) throw new Error('不支持的操作');
  if (role === 'orb' && !ORB_METHODS.has(method)) throw new Error('悬浮球没有此操作权限');
  if (method === 'clearLogs') {
    if (role !== 'main') throw new Error('没有此操作权限');
    if (payload !== null && payload !== undefined) throw new Error('清理记录请求格式无效');
  }
  if(method==='importImages'){
    if(!payload||Object.keys(payload).some(key=>key!=='images')||!Array.isArray(payload.images)||payload.images.length<1||payload.images.length>8)throw new Error('最多添加8张图片');
    let total=0;
    for(const image of payload.images){
      if(!image||Object.keys(image).some(key=>!['name','data'].includes(key))||typeof image.name!=='string'||!image.name.trim()||image.name.length>200||/[\\/\u0000-\u001f\u007f]/u.test(image.name)||!(image.data instanceof ArrayBuffer))throw new Error('图片导入格式无效');
      if(image.data.byteLength<1||image.data.byteLength>10*1024*1024)throw new Error('单张图片不能超过10MiB');
      total+=image.data.byteLength;if(total>32*1024*1024)throw new Error('图片总大小不能超过32MiB');
    }
    return method;
  }
  let size;
  try { size = Buffer.byteLength(JSON.stringify(payload ?? null)); } catch { throw new Error('请求格式无效'); }
  if (size > 262144) throw new Error('请求内容过大');
  if(['imagePreviews','discardImages'].includes(method)){
    if(!payload||Object.keys(payload).some(key=>key!=='ids')||!Array.isArray(payload.ids)||payload.ids.length>8||payload.ids.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(payload.ids).size!==payload.ids.length)throw new Error('图片标识无效');
  }
  if (['taskAction', 'updateTask'].includes(method) && !UUID.test(payload?.id ?? '')) throw new Error('任务标识无效');
  if (method === 'taskAction' && !['enable', 'pause', 'delete', 'open', 'check', 'confirmDelivered'].includes(payload.action)) throw new Error('不支持的任务操作');
  if (method === 'taskAction' && payload.action === 'confirmDelivered' && !UUID.test(payload.intentId ?? '')) throw new Error('操作标识无效');
  if (method === 'window' && !['minimize', 'maximize', 'close', 'showMain', 'showOrb', 'hideOrb', 'orbMenu', 'quit', 'orbDragStart', 'orbDragMove', 'orbDragEnd'].includes(payload?.action)) throw new Error('不支持的窗口操作');
  if (method === 'window' && payload?.action?.startsWith('orbDrag') && role !== 'orb') throw new Error('窗口操作权限不足');
  return method;
}
module.exports = { validateCall };
