import { formatDate, formatDuration, formatQuotaCountdown, quotaWindowLabel, toLocalInput, parseLocalInput, upcoming, isQuotaFresh, quotaResetInfo, quotaScheduleAt, isEnabledTask, taskStatusLabel } from './time.mjs';
import { tr, systemMessage, setLanguage, resolveLanguage, currentLanguage, captureStaticTranslations } from './i18n.mjs';
import { icon, hydrateIcons } from './icons.mjs';
import { initializeLiquidGlass } from './liquid.mjs';
const translateStatic = captureStaticTranslations(document);
hydrateIcons();
const disposeGlass=initializeLiquidGlass('.sidebar,.connection-strip,.next-card,.tasks-panel,.history-panel,.settings-card,#task-dialog',{nativeSelector:'.brand,.sidebar nav,.window-buttons,.page-heading,.connection-summary,.quota-summary,.section-toolbar,.task-card,.empty-copy,.settings-card,.history-panel,.next-card,dialog'});
window.addEventListener('pagehide',disposeGlass,{once:true});
const $ = id => document.getElementById(id);
const call = (method, payload = null) => window.timer.invoke(method, payload);
const DEFAULT_REPLY = '根据本聊天已经确认的目标、约束和验收标准，自行比较并选择最合适的方案，简要记录理由后继续执行。普通实现选择无需再次询问我；完成约定目标后停止。';
let snapshot = { tasks:[], logs:[], settings:{}, connection:{} }, filter='all', view='tasks', editing=null, kind='once', chosenThread=null, threads=[], toastTimer, searchTimer, lastMenuError=null;
let quotaSelection=null,cutoffSelection=null,editorZone=null,cutoffEdited=false,pendingConfirmation=null;
let logFilter='all',visibleLogCount=20,clearingLogs=false,logRenderKey=null;
let editorSession=0,editorImages=[],draftImageIds=new Set(),importingImages=false,savingTask=false;
const IMAGE_LIMITS={count:8,each:10*1024*1024,total:32*1024*1024};
const imageMetadata=image=>Object.fromEntries(['id','name','mime','bytes','width','height','sha256'].map(key=>[key,image[key]]));
function formError(message){$('form-error').textContent=systemMessage(message);$('form-error').classList.remove('hidden');}
function syncEditorBusy(){const busy=importingImages||savingTask;for(const id of ['save-task','close-dialog','cancel-dialog','choose-images','image-files'])$(id).disabled=busy;for(const button of $('image-list').querySelectorAll('button'))button.disabled=busy;$('image-input').setAttribute('aria-busy',String(importingImages));}
function renderImages(){
  $('image-count').textContent=`${editorImages.length} / 8`;$('image-list').replaceChildren();
  for(const image of editorImages){
    const tile=element('div','image-tile');tile.dataset.imageId=image.id;
    if(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.previewDataUrl||'')){const preview=element('img');preview.src=image.previewDataUrl;preview.alt='';tile.append(preview);}else tile.append(element('span','image-placeholder',tr('图片')));
    tile.append(element('span','image-name',image.name));
    const remove=element('button','secondary image-remove',tr('移除'));remove.type='button';remove.id=`remove-image-${image.id}`;remove.setAttribute('aria-label',currentLanguage()==='en'?`Remove image: ${image.name}`:`移除图片：${image.name}`);remove.addEventListener('click',act(async()=>{
      if(importingImages||savingTask)return;
      editorImages=editorImages.filter(item=>item.id!==image.id);renderImages();
      if(draftImageIds.has(image.id)){try{await call('discardImages',{ids:[image.id]});draftImageIds.delete(image.id);}catch{toast(tr('图片已移除，草稿副本暂未清理；关闭编辑器时会重试。'),true);}}
    }));tile.append(remove);$('image-list').append(tile);
  }syncEditorBusy();
}
async function discardImageDrafts(ids){
  let failed=false;
  for(let offset=0;offset<ids.length;offset+=IMAGE_LIMITS.count){
    try{await call('discardImages',{ids:ids.slice(offset,offset+IMAGE_LIMITS.count)});}catch{failed=true;}
  }
  if(failed)toast(tr('任务编辑已结束，但图片草稿暂未清理；下次启动会重试。'),true);
}
async function importImageFiles(files){
  if(!$('task-dialog').open)return;
  if(importingImages||savingTask)throw new Error(tr('图片正在处理，请稍候。'));
  const batch=Array.from(files);if(!batch.length)return;
  if(editorImages.length+batch.length>IMAGE_LIMITS.count)throw new Error(tr('每项任务最多添加8张图片。'));
  let total=editorImages.reduce((sum,image)=>sum+image.bytes,0);
  for(const file of batch){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)&&!(file.type===''&&/\.(png|jpe?g|webp)$/i.test(file.name)))throw new Error(tr('只支持 PNG、JPEG、WebP 图片。'));
    if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>IMAGE_LIMITS.each)throw new Error(tr('每张图片须大于0且不超过10 MiB。'));total+=file.size;
  }
  if(total>IMAGE_LIMITS.total)throw new Error(tr('图片总大小不能超过32 MiB。'));
  const session=editorSession;importingImages=true;syncEditorBusy();$('image-status').textContent=tr('正在导入图片…');$('form-error').classList.add('hidden');
  try{
    const images=await Promise.all(batch.map(async file=>({name:file.name,data:await file.arrayBuffer()})));
    const imported=await call('importImages',{images});
    if(session!==editorSession||!$('task-dialog').open){await discardImageDrafts(imported.map(image=>image.id));return;}
    for(const image of imported){editorImages.push({...imageMetadata(image),previewDataUrl:image.previewDataUrl});draftImageIds.add(image.id);}renderImages();
  }finally{if(session===editorSession){importingImages=false;$('image-status').textContent='';syncEditorBusy();}}
}
const zone = () => snapshot.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
function toast(message, error=false) { $('toast').textContent=systemMessage(message); $('toast').classList.toggle('error',error); $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5500); }
const act = fn => async event => { try { await fn(event); } catch(error) { toast(error.message || String(error),true); } };
function element(tag, cls, text) { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; }
function showView(value) { view=value; document.querySelectorAll('.view').forEach(v=>v.classList.toggle('hidden',v.id!==`view-${value}`)); document.querySelectorAll('[data-view]').forEach(v=>v.classList.toggle('selected',v.dataset.view===value)); $('view-title').textContent={tasks:tr('任务计划'),history:tr('执行记录'),settings:tr('连接与设置')}[value]; if(value==='history')renderLogs(); }
function render() {
  const preferred=snapshot.settings.language||'zh-CN';
  const systemLocale=snapshot.app?.systemLocale||navigator.language;
  if(resolveLanguage(preferred,systemLocale)!==currentLanguage()){
    setLanguage(preferred,systemLocale);translateStatic();logRenderKey=null;showView(view);
  }
  $('setting-language').value=preferred;
  const tasks=snapshot.tasks||[];
  const menuError=snapshot.app?.menuError||null;
  if(menuError?.id!==lastMenuError?.id){
    const previous=lastMenuError;lastMenuError=menuError;
    if(menuError)toast(menuError.message,true);
    else if(previous&&$('toast').textContent===systemMessage(previous.message)){clearTimeout(toastTimer);$('toast').classList.add('hidden');}
  }
  const schedulerError=snapshot.engine?.lastError?.message||((snapshot.engine&&!snapshot.engine.running&&!snapshot.settings.pausedAll)?tr('调度器未运行，请检查后恢复。'):null)||snapshot.app?.startupError;
  $('scheduler-error').classList.toggle('hidden',!schedulerError);$('scheduler-error-text').textContent=systemMessage(schedulerError)||'';
  $('nav-count').textContent=tasks.length; $('all-count').textContent=tasks.length;
  $('active-count').textContent=tasks.filter(isEnabledTask).length;
  $('attention-count').textContent=tasks.filter(needsAttention).length;
  $('pause-all-label').textContent=snapshot.settings.pausedAll?tr('恢复全部'):tr('暂停全部');
  $('pause-all').querySelector('[data-icon]').replaceChildren(icon(snapshot.settings.pausedAll?'play':'pause'));
  $('version').textContent=`${snapshot.app?.testMode?'TEST · ':''}v${snapshot.app?.version||'0.1.0'}`;
  $('test-indicator').classList.toggle('hidden',!snapshot.app?.testMode);
  if(snapshot.app?.testMode)$('test-indicator').textContent=tr('界面测试：使用独立测试数据，不向真实聊天发送消息。');
  const connection=snapshot.connection||{};
  $('connection-title').textContent=connection.connected?tr('已连接本机 Codex'):connection.checking?tr('正在检查连接'):tr('连接需要检查');
  $('connection-led').classList.toggle('connected',Boolean(connection.connected));
  const quota=connection.quota||{};
  const fresh=isQuotaFresh(connection);
  const updated=fresh?`${new Intl.DateTimeFormat(currentLanguage(),{timeZone:zone(),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(quota.readAt)} ${currentLanguage()==='en'?'updated':'更新'}`:quota.error?tr('额度同步失败'):tr('等待额度同步');
  $('connection-subtitle').textContent=connection.connected?`${connection.plan||'Codex'} · ${quota.refreshing?tr('同步中'):updated}`:systemMessage(connection.message)||tr('查看连接与设置');
  for(const [key,id] of [['primary','quota-primary'],['secondary','quota-secondary']]) {
    const bucket=quota[key]; const remaining=fresh&&Number.isFinite(bucket?.usedPercent)?Math.max(0,100-bucket.usedPercent):null;
    $(id).textContent=remaining===null?'—':`${Math.round(remaining)}%`;
    $(id+'-label').textContent=quotaWindowLabel(bucket);
    if(key==='primary')$('quota-primary-bar').style.width=`${remaining??0}%`;
  }
  const oneBucket=fresh&&Boolean(quota.primary)!==Boolean(quota.secondary);
  $('quota-primary-card').classList.toggle('hidden',oneBucket&&!quota.primary);
  $('quota-secondary-card').classList.toggle('hidden',fresh&&!quota.secondary);
  document.querySelector('.connection-strip').classList.toggle('single-quota',oneBucket||Boolean(fresh&&!quota.secondary));
  $('diagnostic-summary').textContent=systemMessage(connection.message)||tr('点击重新检查连接，确认本机支持的能力。');
  $('cli-path').textContent=connection.cliPath||tr('尚未发现 Codex CLI');
  $('capabilities').replaceChildren();
  const caps=connection.capabilities||{};
  for(const [key,label] of [['listThreads',tr('读取聊天列表')],['readQuota',tr('读取额度时间')],['readState',tr('识别任务状态')],['sendMessage',tr('发送消息')],['answerQuestion',tr('回复普通选择')]]) {
    const row=element('div','capability');row.append(element('span','',label));const available=Boolean(caps[key]);row.append(element('em',available?'':'unsupported',available?tr('可用'):tr('未启用')));$('capabilities').append(row);
  }
  const orbVisible=snapshot.settings.showOrb!==false;
  $('setting-orb').checked=orbVisible; $('setting-awake').checked=snapshot.settings.keepAwake!==false;
  $('show-orb').setAttribute('aria-pressed',String(orbVisible));
  $('show-orb').setAttribute('aria-label',orbVisible?tr('隐藏悬浮球'):tr('显示悬浮球'));
  $('show-orb').title=orbVisible?tr('隐藏悬浮球'):tr('显示悬浮球');
  if(document.activeElement!==$('setting-glass')){$('setting-glass').value=snapshot.settings.glassTransparency??40;applyGlass(Number($('setting-glass').value));}
  if(!Array.from($('setting-zone').options).some(o=>o.value===zone()))$('setting-zone').add(new Option(zone(),zone()));
  $('setting-zone').value=zone();
  syncAutoAnswer();renderTasks();renderTick();if(view==='history')renderLogs();
}
function needsAttention(task){return task.state==='needs_attention'||(task.intents||[]).some(intent=>intent.status==='unknown');}
function renderTasks() {
  const list=(snapshot.tasks||[]).filter(t=>filter==='all'||(filter==='attention'?needsAttention(t):isEnabledTask(t))).sort((a,b)=>b.createdAt-a.createdAt);
  const taskList=$('task-list');const existing=new Map([...taskList.children].map(row=>[row.dataset.id,row]));
  const focused=document.activeElement?.closest('.task-card');const focusedId=focused?.dataset.id;const focusedLabel=focused?.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
  const wanted=new Set(list.map(task=>task.id));for(const [id,row] of existing)if(!wanted.has(id))row.remove();
  $('empty-state').classList.toggle('hidden',list.length>0);
  const filteredEmpty=!list.length&&(snapshot.tasks||[]).length>0&&filter!=='all';
  $('add-link').classList.toggle('hidden',filteredEmpty);
  $('show-all-tasks').classList.toggle('hidden',!filteredEmpty);
  if(filteredEmpty){$('empty-state').querySelector('h3').textContent=filter==='active'?tr('还没有启用的任务'):tr('没有需要处理的任务');$('empty-state').querySelector('p').textContent=filter==='active'?tr('在全部任务中点击播放按钮，即可启用。'):tr('可以回到全部任务查看计划。');}
  else {$('empty-state').querySelector('h3').textContent=tr('添加第一个任务');$('empty-state').querySelector('p').textContent=tr('选择聊天，设置发送时间或看守规则。');}
  for(const [index,task] of list.entries()) {
    const key=JSON.stringify([task.title,task.kind,task.target,task.reason,task.nextAttemptAt,task.scheduledAt,task.state,task.enabled,task.intents,zone(),currentLanguage()]);
    const old=existing.get(task.id);if(old?.dataset.renderKey===key){if(taskList.children[index]!==old)taskList.insertBefore(old,taskList.children[index]||null);continue;}
    const row=element('article','task-card');row.dataset.id=task.id;
    row.dataset.renderKey=key;
    const taskIcon=element('div','task-icon');taskIcon.append(icon(task.kind==='watch'?'monitor':'clock-3'));taskIcon.title=task.kind==='watch'?tr('持续看守'):tr('定时发送');row.append(taskIcon);
    const info=element('div','task-info');info.append(element('h3','',task.title));
    const destination=task.target.nickname||tr('已绑定聊天');
    const summary=[task.kind==='watch'?tr('持续看守'):tr('定时发送')];
    if(destination!==task.title)summary.push(destination);
    info.append(element('p','',summary.join(' · ')));
    if(task.reason){row.title=systemMessage(task.reason);if(needsAttention(task)||['waiting_network','waiting_user'].includes(task.state))info.append(element('p','task-reason',systemMessage(task.reason)));}
    const unresolved=(task.intents||[]).filter(intent=>['pending','queued','unknown'].includes(intent.status));
    if(unresolved.length===1&&unresolved[0].status==='unknown'&&unresolved[0].type==='send_message'){
      const intentId=unresolved[0].id,button=element('button','secondary',tr('确认已送达'));button.type='button';
      button.addEventListener('click',act(async()=>{const latest=snapshot.tasks.find(item=>item.id===task.id);if(!latest)throw new Error(tr('这项任务已经移除。'));if(!await confirmAction({title:tr('确认已送达？'),subject:latest.title,description:tr('请确认对应聊天中已收到这条消息。确认后不会重发，任务将停止。'),button:tr('确认已送达')}))return;await call('taskAction',{id:task.id,action:'confirmDelivered',intentId});await refresh();}));info.append(button);
    }
    row.append(info);
    const due=task.nextAttemptAt??task.scheduledAt;const time=element('div','task-time');time.append(element('strong','',formatDate(due,zone(),true)));time.append(element('span','',new Intl.DateTimeFormat(currentLanguage(),{timeZone:zone(),year:'numeric',month:'numeric',day:'numeric'}).format(due)));
    const countdown=element('span','task-countdown');countdown.dataset.countdownTask=task.id;time.append(countdown);row.append(time);
    row.append(element('span',`task-state ${task.state==='needs_attention'?'attention':task.state}`,taskStatusLabel(task)));
    const actions=element('div','task-actions');
    for(const [action,label,iconName] of [['open',tr('定位聊天'),'arrow-up-right'],['edit',tr('编辑任务'),'pencil'],[task.enabled?'pause':'enable',task.enabled?tr('暂停任务'):tr('启用任务'),task.enabled?'pause':'play'],['delete',tr('删除任务'),'trash']]){
      if(['completed','expired'].includes(task.state)&&action==='enable')continue;
      const button=element('button');button.append(icon(iconName));button.title=label;button.setAttribute('aria-label',label);button.addEventListener('click',act(async()=>{const latest=snapshot.tasks.find(item=>item.id===task.id);if(!latest)throw new Error(tr('这项任务已经移除。'));if(action==='edit')return openEditor(latest);if(action==='delete'&&!await confirmTaskDeletion(latest))return;await call('taskAction',{id:task.id,action});await refresh();}));actions.append(button);
    }row.append(actions);if(old)old.replaceWith(row);else taskList.insertBefore(row,taskList.children[index]||null);
  }
  if(focusedId&&focusedLabel&&!$('task-dialog').open){const row=[...taskList.children].find(item=>item.dataset.id===focusedId);const control=[...(row?.querySelectorAll('button')||[])].find(button=>button.getAttribute('aria-label')===focusedLabel);if(control&&document.activeElement!==control)control.focus({preventScroll:true});}
}
function renderCountdown() {
  const next=upcoming(snapshot.tasks||[]);const paused=snapshot.settings.pausedAll;
  const failure=snapshot.engine?.lastError||(snapshot.engine&&!snapshot.engine.running&&!paused);
  $('next-panel').classList.toggle('hidden',!next||paused||Boolean(failure));
  if(snapshot.engine?.lastError||(snapshot.engine&&!snapshot.engine.running&&!snapshot.settings.pausedAll)){$('next-title').textContent=tr('调度已停止，需要处理');$('next-subtitle').textContent=systemMessage(snapshot.engine.lastError?.message)||tr('自动调度尚未运行。');$('next-state').textContent=tr('需要处理');$('hero-countdown').textContent=tr('已停止');$('hero-due').textContent=tr('请检查并恢复调度');$('hero-ring').style.strokeDashoffset='395.84';$('next-meta').textContent=tr('后续自动操作已停止');return;}
  if(!next||paused){$('next-title').textContent=paused?tr('全部任务已暂停'):tr('你的下一项计划');$('next-subtitle').textContent=paused?tr('恢复后，助手会先核对目标与任务状态。'):tr('选择聊天，设好时间，剩下的交给助手。');$('next-state').textContent=paused?tr('已暂停'):tr('等待安排');$('hero-countdown').textContent='--:--:--';$('hero-due').textContent=tr('尚无待执行计划');$('hero-ring').style.strokeDashoffset='395.84';$('next-meta').textContent=paused?tr('后续自动操作已暂停'):tr('准备就绪，等待添加任务');return;}
  const {task,due,phase}=next;const remaining=due===null?null:Math.max(0,due-Date.now());const ratio=due===null?1:Math.min(1,Math.max(0,remaining/Math.max(1,due-task.createdAt)));
  $('next-title').textContent=task.title;$('next-subtitle').textContent=systemMessage(task.reason)||`${task.target.type==='current'?tr('跟随所选窗口的当前聊天'):tr('已绑定指定聊天')} · ${task.target.nickname||'Codex'}`;
  $('next-state').textContent=taskStatusLabel(task);$('hero-countdown').textContent=remaining===null?taskStatusLabel(task):remaining===0?tr('核对中'):formatDuration(remaining);$('hero-due').textContent=due===null?tr('持续观察任务状态'):formatDate(due,zone(),false,true);$('hero-ring').style.strokeDashoffset=String(395.84*(1-ratio));$('countdown-label').textContent={quota:tr('距下次额度核对'),retry:tr('距下次重试'),start:tr('距开始执行')}[phase]||tr('当前任务');$('next-meta').textContent=task.cutoffAt?`${formatDate(task.cutoffAt,zone(),true)} ${tr('结束看守')}`:task.kind==='watch'?tr('持续看守'):tr('定时发送');
}
function renderQuotaTiming(){
  const now=Date.now();
  for(const [key,id]of [['primary','quota-primary'],['secondary','quota-secondary']]){
    const info=quotaResetInfo(snapshot.connection,key,now);
    const bucket=snapshot.connection?.quota?.[key];
    const reset=info.status==='countdown'?new Intl.DateTimeFormat(currentLanguage(),{timeZone:zone(),...(bucket?.windowDurationMins>=1440?{month:'numeric',day:'numeric'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(info.resetAt):'';
    $(id+'-reset').textContent=info.status==='unknown'?(isQuotaFresh(snapshot.connection,now)&&!bucket?tr('未提供额度信息'):tr('等待同步')):info.status==='checking'?tr('等待官方更新'):(currentLanguage()==='en'?`Resets ${reset}`:`${reset} 刷新`);
    $(id+'-countdown').textContent=info.status==='countdown'?formatQuotaCountdown(info.remainingMs):'';
  }
  const at=quotaScheduleAt(snapshot.connection,{now,bufferMinutes:$('quota-delay').checked?1:0});
  $('use-quota-reset').disabled=at===null;
  $('use-quota-reset').title=at===null?tr('暂时没有可用的官方刷新时间，可以手动选择时间'):(currentLanguage()==='en'?`Schedule for ${formatDate(at,editorZone||zone(),false,true)}`:`安排在 ${formatDate(at,editorZone||zone(),false,true)}`);
}
function renderTick(){
  renderCountdown();renderQuotaTiming();
  for(const label of document.querySelectorAll('[data-countdown-task]')){
    const task=snapshot.tasks.find(item=>item.id===label.dataset.countdownTask),next=task?upcoming([task]):null;
    label.textContent=!snapshot.settings.pausedAll&&next?.due!==null&&next?.due!==undefined?(next.due>Date.now()?`${formatDuration(next.due-Date.now())}${currentLanguage()==='en'?' left':' 后'}`:tr('核对中')):'';
  }
}
function syncAutoAnswer(){
  const available=snapshot.connection?.capabilities?.answerQuestion===true;
  $('auto-answer').disabled=!available;
  if(!available)$('auto-answer').checked=false;
  $('auto-answer-help').textContent=available?tr('仅处理明确识别的普通方案选择，权限请求仍等待你处理。'):tr('当前版本尚未支持自动填写选择题，遇到时会暂停并提醒。');
  $('auto-reply').disabled=!available||!$('auto-answer').checked;
  $('auto-reply').classList.toggle('hidden',!available||!$('auto-answer').checked);
}
function renderLogs(){
  const all=[...(snapshot.logs||[])].sort((a,b)=>b.at-a.at);
  const logs=logFilter==='attention'?all.filter(log=>log.level==='warning'||log.level==='error'):all;
  const tasks=new Map((snapshot.tasks||[]).map(task=>[task.id,task]));
  const visible=logs.slice(0,visibleLogCount);
  const rows=visible.map(log=>({log,label:log.taskId?(tasks.get(log.taskId)?.title||tr('已删除的任务')):tr('助手')}));
  const key=JSON.stringify([zone(),logFilter,all.length,rows,currentLanguage()]);
  const list=$('log-list');const focusedRow=document.activeElement?.closest('.log-row');const focusedId=focusedRow?.dataset.logId;
  if(key!==logRenderKey){
    list.replaceChildren();
    if(!logs.length)list.append(element('div','log-empty',all.length?tr('没有需要留意的记录。'):tr('还没有执行记录。安排任务后，检查和操作会显示在这里。')));
    for(const [index,{log,label}] of rows.entries()){
      const row=element('div','log-row');row.tabIndex=-1;row.dataset.logId=log.id||'';row.dataset.logIndex=String(index);
      const left=element('div');left.append(element('time','',formatDate(log.at,zone())));left.append(element('small','',label));
      const message=element('div',`log-message ${log.level||''}`);
      if(log.level==='warning'||log.level==='error')message.append(element('span','log-level',log.level==='warning'?tr('提醒：'):tr('错误：')));
      message.append(document.createTextNode(systemMessage(log.message)));row.append(left,message);list.append(row);
    }
    logRenderKey=key;
    if(focusedRow&&focusedId){const replacement=[...list.querySelectorAll('.log-row')].find(row=>row.dataset.logId===focusedId);(replacement||document.querySelector(`[data-log-filter="${logFilter}"]`)).focus({preventScroll:true});}
  }
  const clearWasFocused=document.activeElement===$('clear-logs');
  $('clear-logs').disabled=clearingLogs||!all.length;
  if(clearWasFocused&&$('clear-logs').disabled)$('export-logs').focus({preventScroll:true});
  const more=$('show-more-logs'),moreWasFocused=document.activeElement===more;
  more.classList.toggle('hidden',visible.length>=logs.length);
  $('log-summary').textContent=logs.length?(currentLanguage()==='en'?`Showing ${visible.length} / ${logs.length}`:`显示 ${visible.length} / ${logs.length} 条`):'';
  $('log-summary').parentElement.classList.toggle('hidden',!logs.length);
  if(moreWasFocused&&more.classList.contains('hidden'))document.querySelector(`[data-log-filter="${logFilter}"]`).focus({preventScroll:true});
}
async function refresh(){snapshot=await call('snapshot');render();}
function confirmAction({title,subject='',description,button}){
  if(pendingConfirmation)return Promise.resolve(false);
  $('confirm-title').textContent=title;$('confirm-task-name').textContent=subject;
  $('confirm-task-name').classList.toggle('hidden',!subject);
  $('confirm-description').textContent=description;$('confirm-delete').textContent=button;
  return new Promise(resolve=>{pendingConfirmation=resolve;$('confirm-dialog').showModal();$('confirm-cancel').focus();});
}
function confirmTaskDeletion(task){return confirmAction({title:tr('删除任务？'),subject:task.title,description:tr('执行记录会保留。'),button:tr('删除')});}
function finishConfirmation(confirmed){
  const resolve=pendingConfirmation;pendingConfirmation=null;
  if($('confirm-dialog').open)$('confirm-dialog').close();
  resolve?.(confirmed);
}
function syncSaveLabel(){$('save-task').textContent=editing?tr('保存修改'):$('enable-task').checked?tr('创建并启用'):tr('保存任务');}
function syncDefaultWatchCutoff(){
  if(kind!=='watch'||editing||cutoffEdited||$('unlimited-watch').checked)return;
  let start;try{start=quotaSelection?.value===$('scheduled-at').value?quotaSelection.at:parseLocalInput($('scheduled-at').value,editorZone);}catch{return;}
  const at=start+8*3600000;$('cutoff-at').value=toLocalInput(at,editorZone,true);cutoffSelection={at,value:$('cutoff-at').value,zone:editorZone};
}
function setKind(value){kind=value;document.querySelectorAll('[data-kind]').forEach(b=>b.classList.toggle('selected',b.dataset.kind===kind));$('watch-options').classList.toggle('hidden',kind!=='watch');$('cutoff-field').classList.toggle('hidden',kind!=='watch');$('schedule-label').textContent=kind==='watch'?tr('开始看守时间'):tr('执行时间');$('message-label').textContent=kind==='watch'?tr('继续工作时发送的指令'):tr('发送内容');$('mode-help').textContent=kind==='watch'?tr('收到 Codex 的明确目标完成确认后，结束看守。'):tr('确认消息送达后，此定时任务结束。');syncDefaultWatchCutoff();}
async function loadThreads(query=''){try{threads=await call('listThreads',{query});renderThreadOptions();}catch(error){$('thread-options').replaceChildren(element('p','field-help',systemMessage(error.message)));}}
function renderThreadOptions(){const query=$('thread-search').value.trim().toLowerCase();$('thread-options').replaceChildren();for(const item of threads.filter(t=>(t.name||'').toLowerCase().includes(query))){const b=element('button','thread-option',item.name||tr('未命名聊天'));b.type='button';b.append(element('small','',item.project||tr('本机聊天')));b.addEventListener('click',()=>{chosenThread=item;$('thread-link').value=item.link;$('selected-thread').textContent=(currentLanguage()==='en'?'Selected: ':'已选择：')+(item.name||tr('未命名聊天'));$('selected-thread').classList.remove('hidden');if(!$('task-title').value)$('task-title').value=item.name;$('thread-picker').open=false;});$('thread-options').append(b);}if(!$('thread-options').children.length)$('thread-options').append(element('p','field-help',tr('暂无匹配聊天，可直接粘贴深度链接。')));}
async function openEditor(task=null){
  if($('task-dialog').open)return;
  const session=++editorSession;editorImages=(task?.attachments||[]).map(image=>imageMetadata(image));draftImageIds=new Set();importingImages=false;savingTask=false;renderImages();$('image-status').textContent='';
  editing=task?.id||null;editorZone=zone();quotaSelection=null;cutoffEdited=false;chosenThread=null;$('task-form').reset();$('form-error').classList.add('hidden');$('selected-thread').classList.add('hidden');$('legacy-target-note').classList.toggle('hidden',task?.target.type!=='current');$('thread-picker').open=!task||task.target.type==='current';$('thread-options').replaceChildren(element('p','field-help',tr('正在查找本机聊天…')));
  $('dialog-title').textContent=task?tr('编辑任务'):tr('新建任务');$('task-title').value=task?.title||'';$('task-message').value=task?.message??tr('继续完成本聊天已经确认的任务。');const defaultReply=snapshot.settings.defaultAutoReply||DEFAULT_REPLY;$('auto-reply').value=task?.autoReply||(defaultReply===DEFAULT_REPLY?tr(DEFAULT_REPLY):defaultReply);$('auto-answer').checked=task?.autoAnswerOrdinary??true;syncAutoAnswer();$('enable-task').checked=task?.enabled??true;syncSaveLabel();$('unlimited-watch').checked=task?task.cutoffAt===null:false;
  const defaultStart=task?.scheduledAt??Date.now()+120000,defaultCutoff=task?.cutoffAt??Date.now()+8*3600000;
  $('scheduled-at').value=toLocalInput(defaultStart,editorZone,true);$('cutoff-at').value=toLocalInput(defaultCutoff,editorZone,true);$('cutoff-at').disabled=$('unlimited-watch').checked;$('thread-link').value=task?.target.type==='fixed'?task.target.link:'';$('zone-label').textContent=currentLanguage()==='en'?`Time zone: ${editorZone}`:`时区：${editorZone}`;
  quotaSelection={at:defaultStart,value:$('scheduled-at').value,zone:editorZone,resetAt:null};
  cutoffSelection={at:defaultCutoff,value:$('cutoff-at').value,zone:editorZone};
  $('schedule-help').textContent=tr('到点核对额度，尚未恢复会继续等待。');renderQuotaTiming();
  setKind(task?.kind||'once');$('task-dialog').showModal();$('task-title').focus();
  if(editorImages.length){const ids=editorImages.map(image=>image.id);call('imagePreviews',{ids}).then(previews=>{if(session!==editorSession||!$('task-dialog').open)return;for(const preview of previews){const image=editorImages.find(item=>item.id===preview.id);if(image)image.previewDataUrl=preview.previewDataUrl;}renderImages();}).catch(error=>{if(session===editorSession&&$('task-dialog').open)toast(currentLanguage()==='en'?`Image preview unavailable: ${systemMessage(error.message)}`:`图片预览未加载：${error.message}`,true);});}
  loadThreads();
}
async function closeEditor(){if(importingImages||savingTask)return;const ids=[...draftImageIds];++editorSession;draftImageIds=new Set();editorImages=[];$('task-dialog').close();editing=null;chosenThread=null;quotaSelection=null;cutoffSelection=null;editorZone=null;renderImages();await discardImageDrafts(ids);}
function fillQuotaTime(at,resetAt){
  if(!Number.isFinite(at)||at<=Date.now())throw new Error(tr('该刷新时间已过，请重新选择或手动调整时间。'));
  $('scheduled-at').value=toLocalInput(at,editorZone,true);quotaSelection={at,resetAt,value:$('scheduled-at').value,zone:editorZone};
  syncDefaultWatchCutoff();
  $('schedule-help').textContent=tr('已填入刷新时间；到点仍会核对实际额度。');
}
async function saveTask(event){event.preventDefault();if(importingImages||savingTask){formError(tr('图片正在处理，请稍候再保存。'));return;}const session=editorSession;savingTask=true;syncEditorBusy();$('form-error').classList.add('hidden');try{
  if(!$('task-message').value.trim()&&!editorImages.length)throw new Error(tr('请填写发送内容或添加图片。'));
  const link=$('thread-link').value.trim();if(!link)throw new Error(tr('请先选择本机聊天或粘贴深度链接。'));const selected=chosenThread?.link===link?chosenThread:threads.find(item=>item.link===link);const previousTarget=snapshot.tasks.find(item=>item.id===editing)?.target;const target={type:'fixed',link,nickname:(selected?.name||(previousTarget?.link===link?previousTarget.nickname:null)||tr('指定聊天')).slice(0,120)};
  let scheduledAt=quotaSelection?.value===$('scheduled-at').value&&quotaSelection.zone===editorZone?quotaSelection.at:parseLocalInput($('scheduled-at').value,editorZone);if(kind==='watch'&&scheduledAt<Date.now())scheduledAt=Date.now();
  const previous=snapshot.tasks.find(item=>item.id===editing);
  if(kind==='once'&&$('enable-task').checked&&scheduledAt<=Date.now()&&(!previous||!previous.enabled||previous.scheduledAt!==scheduledAt))throw new Error(tr('执行时间已过，请选择未来时间后再启用。'));
  const cutoffAt=kind==='watch'&&!$('unlimited-watch').checked?(cutoffSelection?.value===$('cutoff-at').value&&cutoffSelection.zone===editorZone?cutoffSelection.at:parseLocalInput($('cutoff-at').value,editorZone)):null;
  const input={title:$('task-title').value.trim(),kind,target,message:$('task-message').value.trim(),attachments:editorImages.map(imageMetadata),scheduledAt,cutoffAt,enabled:$('enable-task').checked,autoAnswerOrdinary:$('auto-answer').checked,autoReply:$('auto-reply').value.trim()};
  if(editing)await call('updateTask',{id:editing,patch:input});else await call('createTask',input);
  for(const image of editorImages)draftImageIds.delete(image.id);savingTask=false;
  const cleanup=closeEditor();toast(input.enabled?tr('任务已启用'):tr('已保存，尚未启用'));await cleanup;try{await refresh();}catch{toast(tr('任务已保存，列表暂未刷新，请稍后重试。'),true);}
}catch(error){if(session===editorSession)formError(error.message);}finally{if(session===editorSession){savingTask=false;syncEditorBusy();}}}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.querySelectorAll('[data-window]').forEach(b=>b.addEventListener('click',act(()=>call('window',{action:b.dataset.window}))));
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-selected',String(x===b));});renderTasks();}));
document.querySelector('.filters').addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('[data-filter]')];const index=tabs.indexOf(document.activeElement);if(index<0||!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;tabs[next].focus();tabs[next].click();});
document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>setKind(b.dataset.kind)));
$('new-task').addEventListener('click',act(()=>openEditor()));$('add-link').addEventListener('click',act(()=>openEditor()));
$('close-dialog').addEventListener('click',act(closeEditor));$('cancel-dialog').addEventListener('click',act(closeEditor));$('task-form').addEventListener('submit',act(saveTask));
$('task-dialog').addEventListener('cancel',act(event=>{event.preventDefault();return closeEditor();}));
$('choose-images').addEventListener('click',()=>$('image-files').click());
$('image-files').addEventListener('change',act(async()=>{const files=Array.from($('image-files').files);$('image-files').value='';await importImageFiles(files);}));
$('task-dialog').addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();$('image-input').classList.add('drag-over');}});
$('task-dialog').addEventListener('dragleave',event=>{if(!$('task-dialog').contains(event.relatedTarget))$('image-input').classList.remove('drag-over');});
$('task-dialog').addEventListener('drop',act(event=>{event.preventDefault();$('image-input').classList.remove('drag-over');return importImageFiles(event.dataTransfer?.files||[]);}));
$('task-dialog').addEventListener('paste',act(event=>{const files=event.clipboardData?.files;if(files?.length){event.preventDefault();return importImageFiles(files);}}));
$('confirm-cancel').addEventListener('click',()=>finishConfirmation(false));$('confirm-delete').addEventListener('click',()=>finishConfirmation(true));
$('confirm-dialog').addEventListener('cancel',event=>{event.preventDefault();finishConfirmation(false);});$('confirm-dialog').addEventListener('close',()=>{if(pendingConfirmation)finishConfirmation(false);});
$('enable-task').addEventListener('change',syncSaveLabel);
$('show-all-tasks').addEventListener('click',()=>document.querySelector('[data-filter="all"]').click());
$('use-quota-reset').addEventListener('click',act(()=>{const bufferMinutes=$('quota-delay').checked?1:0,at=quotaScheduleAt(snapshot.connection,{bufferMinutes});if(at===null)throw new Error(tr('暂时没有可用的刷新时间，请稍候同步或手动设置。'));fillQuotaTime(at,at-bufferMinutes*60000);}));
$('quota-delay').addEventListener('change',act(()=>{if(Number.isFinite(quotaSelection?.resetAt)&&quotaSelection.value===$('scheduled-at').value)fillQuotaTime(quotaSelection.resetAt+($('quota-delay').checked?60000:0),quotaSelection.resetAt);renderQuotaTiming();}));
$('scheduled-at').addEventListener('input',()=>{quotaSelection=null;syncDefaultWatchCutoff();$('schedule-help').textContent=tr('已手动设置时间；到点会核对实际额度。');});
$('cutoff-at').addEventListener('input',()=>{cutoffEdited=true;cutoffSelection=null;});
$('thread-link').addEventListener('input',()=>{chosenThread=null;$('selected-thread').classList.add('hidden');});
$('paste-link').addEventListener('click',act(async()=>{$('thread-link').value=await call('readClipboard');chosenThread=null;$('selected-thread').classList.add('hidden');}));$('preview-thread').addEventListener('click',act(()=>call('openThread',{link:$('thread-link').value.trim()})));
$('thread-search').addEventListener('input',()=>{renderThreadOptions();clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadThreads($('thread-search').value),350);});
$('unlimited-watch').addEventListener('change',()=>{$('cutoff-at').disabled=$('unlimited-watch').checked;syncDefaultWatchCutoff();});
$('auto-answer').addEventListener('change',syncAutoAnswer);
$('pause-all').addEventListener('click',act(async()=>{await call('pauseAll',{paused:!snapshot.settings.pausedAll});await refresh();}));$('show-orb').addEventListener('click',act(async()=>{$('show-orb').disabled=true;try{await call('settings',{showOrb:snapshot.settings.showOrb===false});await refresh();}finally{$('show-orb').disabled=false;}}));
$('connection-details').addEventListener('click',()=>showView('settings'));
$('retry-scheduler').addEventListener('click',act(async()=>{$('retry-scheduler').disabled=true;try{await call('retryScheduler');await refresh();toast(tr('调度检查通过，已恢复'));}finally{$('retry-scheduler').disabled=false;}}));
$('refresh-connection').addEventListener('click',act(async()=>{$('refresh-connection').disabled=true;try{await call('diagnose');await refresh();toast(tr('连接检查完成'));}finally{$('refresh-connection').disabled=false;}}));
$('refresh-quota').addEventListener('click',act(async()=>{$('refresh-quota').disabled=true;try{await call('refreshQuota');await refresh();}finally{$('refresh-quota').disabled=false;}}));
for(const [id,key] of [['setting-orb','showOrb'],['setting-awake','keepAwake']])$(id).addEventListener('change',act(async()=>{await call('settings',{[key]:$(id).checked});await refresh();}));
$('setting-zone').addEventListener('change',act(async()=>{await call('settings',{timeZone:$('setting-zone').value});await refresh();}));
$('setting-language').addEventListener('change',act(async()=>{await call('settings',{language:$('setting-language').value});await refresh();}));
$('setting-glass').addEventListener('input',()=>applyGlass(Number($('setting-glass').value)));
$('setting-glass').addEventListener('change',act(async()=>{try{await call('settings',{glassTransparency:Number($('setting-glass').value)});}finally{await refresh();applyGlass(snapshot.settings.glassTransparency??40);}}));
$('choose-cli').addEventListener('click',act(async()=>{await call('chooseCli');await refresh();}));$('export-logs').addEventListener('click',act(async()=>{const result=await call('exportLogs');if(result)toast(tr('执行记录已导出'));}));
document.querySelectorAll('[data-log-filter]').forEach(button=>button.addEventListener('click',()=>{
  logFilter=button.dataset.logFilter;visibleLogCount=20;
  document.querySelectorAll('[data-log-filter]').forEach(item=>{const selected=item===button;item.classList.toggle('selected',selected);item.setAttribute('aria-pressed',String(selected));});
  renderLogs();
}));
$('show-more-logs').addEventListener('click',()=>{const previous=visibleLogCount;visibleLogCount+=20;renderLogs();$('log-list').querySelector(`[data-log-index="${previous}"]`)?.focus();});
$('clear-logs').addEventListener('click',async()=>{
  if(clearingLogs||!(snapshot.logs||[]).length)return;
  if(!await confirmAction({title:tr('清空执行记录？'),description:tr('将清空全部执行记录，包括当前未显示的记录。任务不受影响。'),button:tr('清空记录')}))return;
  clearingLogs=true;renderLogs();
  try{
    let result;
    try{result=await call('clearLogs');}catch(error){
      const detail=typeof error?.message==='string'?error.message.trim():'';
      toast(detail?(currentLanguage()==='en'?`Could not clear history: ${systemMessage(detail)}`:`清空记录失败：${detail}`):tr('清空记录失败，请重试。'),true);return;
    }
    const outcome=result.clearedCount?(currentLanguage()==='en'?`Cleared ${result.clearedCount} records`:`已清空 ${result.clearedCount} 条记录`):tr('本次没有清空记录');
    try{await refresh();}catch{toast(currentLanguage()==='en'?`${outcome}, but the list could not be refreshed.`:`${outcome}，但列表暂未刷新，请稍后重试。`,true);return;}
    toast(outcome);
  }finally{clearingLogs=false;renderLogs();}
});
window.timer.onState(value=>{snapshot=value;render();});
setInterval(renderTick,1000);
refresh().catch(error=>toast(error.message,true));
function applyGlass(value){const tint=1-value/100;document.documentElement.style.setProperty('--window-tint',String(tint));document.documentElement.style.setProperty('--panel-tint',String(tint+.16));document.documentElement.style.setProperty('--sidebar-tint',String(tint+.08));document.documentElement.style.setProperty('--dialog-tint',String(Math.min(.97,tint+.43)));$('glass-value').value=`${value}%`;}
