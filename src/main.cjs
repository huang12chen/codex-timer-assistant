'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, protocol, net, clipboard, shell, dialog, globalShortcut, powerSaveBlocker, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateCall } = require('./ipc-guard.cjs');
const { startQuotaSync } = require('./quota-sync.cjs');
const { createMenuAction } = require('./menu-action.cjs');
const { createOrbDrag } = require('./orb-drag.cjs');
const SMOKE = process.env.CODEX_TIMER_SMOKE === '1';
const dataDir = process.env.CODEX_TIMER_DATA_DIR || path.join(app.getPath('appData'), 'CodexTimerAssistant');
app.setName('Codex定时助手');
if(process.platform==='win32')app.setAppUserModelId('local.codex.timer.assistant');
app.setPath('userData', dataDir);
protocol.registerSchemesAsPrivileged([{ scheme:'ctimer', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
const singleInstance=app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let mainWindow, orbWindow, tray, store, engine, adapter, imageStore, parseThreadLink, validateNewTask, exiting=false, quitPromise=null, broadcastTimer, orbHideTimer=null, sleepBlocker=null, startupError=null, menuError=null, menuErrorSequence=0, normalBounds=null, quotaSync=null;
const allowedFiles = new Set(['index.html','app.js','style.css','ron-theme.css','orb.html','orb.js','orb.css','orb-interaction.mjs','time.mjs','i18n.mjs','icons.mjs','liquid.mjs','liquid-optics.mjs','liquid-rim.mjs','backdrop.svg']);
const roleOf = event => event.sender===mainWindow?.webContents?'main':event.sender===orbWindow?.webContents?'orb':null;
const systemLocale = () => typeof app.getLocale === 'function' ? app.getLocale() : 'zh-CN';
const uiEnglish = () => !String(store?.snapshot()?.settings?.language === 'system' ? systemLocale() : (store?.snapshot()?.settings?.language || 'zh-CN')).toLowerCase().startsWith('zh');
const appText = (zh,en) => uiEnglish() ? en : zh;
const orbDrag = createOrbDrag({cursor:()=>screen.getCursorScreenPoint(),window:()=>orbWindow,workArea:point=>screen.getDisplayNearestPoint(point).workArea});
function iconImage(size=32) {
  const pixels=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const px=(x+.5)*32/size-.5,py=(y+.5)*32/size-.5;const distance=Math.hypot(px-15.5,py-15.5);const angle=(Math.atan2(py-15.5,px-15.5)+Math.PI*2.5)%(Math.PI*2);let alpha=0;const rgb=[40,94,216];if(distance>=11&&distance<=14){alpha=angle<Math.PI*1.55?255:100;}if(px>=15&&px<=16&&py>=7&&py<=16)alpha=255;if(py>=15&&py<=16&&px>=15&&px<=23)alpha=255;const i=(y*size+x)*4;pixels[i]=rgb[2];pixels[i+1]=rgb[1];pixels[i+2]=rgb[0];pixels[i+3]=alpha;}
  return nativeImage.createFromBitmap(pixels,{width:size,height:size,scaleFactor:1});
}
function hardenedWindow(options) {
  const win = new BrowserWindow({ ...options, icon:iconImage(), webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:true,spellcheck:false} });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('ctimer://app/'))event.preventDefault();});
  win.webContents.on('did-fail-load',(_event,code,description)=>{startupError=`界面加载失败：${code} ${description}`;});
  return win;
}
function createMain() {
  const area=screen.getPrimaryDisplay().workArea;
  const width=Math.min(1180,area.width),height=Math.min(810,area.height);
  mainWindow=hardenedWindow({width,height,minWidth:Math.min(820,width),minHeight:Math.min(640,height),frame:false,transparent:true,resizable:false,maximizable:false,show:false,backgroundColor:'#00000000',title:SMOKE?appText('Codex定时助手 · 桌面测试','Codex Timer Assistant · Test'):appText('Codex定时助手','Codex Timer Assistant')});
  normalBounds=null;
  mainWindow.loadURL('ctimer://app/index.html');
  mainWindow.once('ready-to-show',()=>{mainWindow.show();broadcast();});
  mainWindow.on('close',event=>{if(!exiting){event.preventDefault();mainWindow.hide();}});
}
function showMain(){if(!mainWindow||mainWindow.isDestroyed())createMain();if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();quotaSync?.refresh().catch(()=>{});}
function toggleExpanded(){if(normalBounds){const previous=normalBounds;normalBounds=null;mainWindow.setBounds(previous);}else{normalBounds=mainWindow.getBounds();mainWindow.setBounds(screen.getDisplayMatching(normalBounds).workArea);}}
function showOrbWindow(win){
  if(!win||win.isDestroyed()||win.webContents.isDestroyed())return;
  clearTimeout(orbHideTimer);orbHideTimer=null;
  // showInactive can leave Chromium's visibility state hidden after a hide.
  // Unthrottle only while shown so its compositor and visibility state wake up.
  win.webContents.setBackgroundThrottling(false);
  try{win.showInactive();}catch(error){win.webContents.setBackgroundThrottling(true);throw error;}
}
function hideOrbWindow(){
  orbDrag.end();const win=orbWindow;if(!win||win.isDestroyed())return;
  clearTimeout(orbHideTimer);
  // Allow the renderer's short exit transition to finish before hiding the
  // native window. A subsequent show cancels this timer.
  orbHideTimer=setTimeout(()=>{orbHideTimer=null;if(win.isDestroyed()||store.snapshot().settings.showOrb)return;win.hide();if(!win.webContents.isDestroyed())win.webContents.setBackgroundThrottling(true);},200);
}
function showOrb(){
  if(!orbWindow||orbWindow.isDestroyed()){
    const bounds=screen.getPrimaryDisplay().workArea;
    orbWindow=hardenedWindow({width:132,height:132,x:bounds.x+bounds.width-158,y:bounds.y+Math.round(bounds.height*.52),frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,minimizable:false,skipTaskbar:true,alwaysOnTop:true,show:false,paintWhenInitiallyHidden:false,hasShadow:false,title:appText('Codex 倒计时','Codex Timer')});
    const loadingOrb=orbWindow;
    // Electron otherwise treats a newly hidden window as visible. With initial
    // painting disabled, ready-to-show never fires; show after module loading.
    loadingOrb.webContents.once('did-finish-load',()=>{if(exiting||loadingOrb.isDestroyed()||orbWindow!==loadingOrb)return;if(store.snapshot().settings.showOrb)showOrbWindow(loadingOrb);broadcast();});
    loadingOrb.loadURL('ctimer://app/orb.html');
    orbWindow.on('close',event=>{if(exiting)return;event.preventDefault();applySettings({showOrb:false}).then(broadcast).catch(()=>{startupError='无法保存悬浮球设置，请在助手中重试';broadcast();});});
    orbWindow.on('system-context-menu',event=>{event.preventDefault();orbMenu();});orbWindow.on('closed',()=>{orbDrag.end();orbWindow=null;});
  }else{showOrbWindow(orbWindow);broadcast();}
}
const menuAction=action=>createMenuAction(action,error=>{if(exiting)return;menuError={id:++menuErrorSequence,message:'操作未保存，请重试。'};console.error('Menu action failed:',error?.message||String(error));broadcast();},()=>{menuError=null;broadcast();});
function orbMenu(){Menu.buildFromTemplate([{label:appText('打开助手','Open assistant'),click:showMain},{label:store.snapshot().settings.pausedAll?appText('恢复全部任务','Resume all tasks'):appText('暂停全部任务','Pause all tasks'),click:menuAction(()=>pauseAll(!store.snapshot().settings.pausedAll))},{type:'separator'},{label:appText('关闭悬浮球','Hide floating timer'),click:menuAction(async()=>{await applySettings({showOrb:false});broadcast();})},{label:appText('退出助手','Quit assistant'),click:quit}]).popup({window:orbWindow});}
function refreshTrayMenu(){if(!tray)return;tray.setToolTip(appText('Codex 定时助手','Codex Timer Assistant'));tray.setContextMenu(Menu.buildFromTemplate([{label:appText('打开 Codex 定时助手','Open Codex Timer Assistant'),click:showMain},{label:appText('显示倒计时悬浮球','Show floating timer'),click:menuAction(async()=>{await applySettings({showOrb:true});broadcast();})},{type:'separator'},{label:appText('暂停全部任务','Pause all tasks'),click:menuAction(()=>pauseAll(true))},{label:appText('恢复全部任务','Resume all tasks'),click:menuAction(()=>pauseAll(false))},{type:'separator'},{label:appText('退出','Quit'),click:quit}]));}
function setupTray(){tray=new Tray(iconImage());tray.on('double-click',showMain);refreshTrayMenu();}
function getSnapshot(){return {...engine.snapshot(),connection:adapter.status(),app:{version:app.getVersion(),systemLocale:systemLocale(),testMode:SMOKE,dataDir,startupError,menuError}};}
function updatePower(){const s=store.snapshot();const needed=s.settings.keepAwake!==false&&!s.settings.pausedAll&&s.tasks.some(t=>t.enabled&&!['completed','expired','paused','needs_attention'].includes(t.state));if(needed&&sleepBlocker===null)sleepBlocker=powerSaveBlocker.start('prevent-app-suspension');if(!needed&&sleepBlocker!==null){powerSaveBlocker.stop(sleepBlocker);sleepBlocker=null;}}
function broadcast(){if(!engine||!adapter)return;const value=getSnapshot();for(const win of [mainWindow,orbWindow])if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('timer:state',value);updatePower();}
async function pauseAll(paused){if(paused)engine.stop();await store.updateSettings({pausedAll:Boolean(paused)});if(!paused)await engine.start();await store.appendLog({event:paused?'pause_all':'resume_all',level:'info',message:paused?'用户已暂停全部自动操作':'用户已恢复任务检查'});broadcast();}
async function openThread(link){const parsed=parseThreadLink(link);await shell.openExternal(parsed.link);return {opened:true};}
async function refreshQuotaAndWake(){
  const status=await(adapter.refreshQuota?adapter.refreshQuota():adapter.diagnose());
  if(!exiting&&status?.connected===true&&status.quota?.ordinaryUsageAllowed===true&&status.quota.stale===false){
    const snapshot=engine.snapshot();
    if(snapshot.engine.running&&!snapshot.settings.pausedAll)await engine.recheckQuota();
  }
  return status;
}
async function applySettings(patch){
  const allowed=new Set(['showOrb','keepAwake','timeZone','glassTransparency','language']);
  if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!allowed.has(k)))throw new Error('设置字段无效');
  const settings=await store.updateSettings(patch);
  if(Object.hasOwn(patch,'showOrb')){if(settings.showOrb)showOrb();else hideOrbWindow();}
  if(Object.hasOwn(patch,'language')){refreshTrayMenu();mainWindow?.setTitle(appText('Codex定时助手','Codex Timer Assistant'));orbWindow?.setTitle(appText('Codex 倒计时','Codex Timer'));}
  return settings;
}
function logImageWarnings(){
  for(const warning of imageStore?.drainWarnings?.()||[]){
    const message=typeof warning==='string'?warning:warning.message;
    store.appendLog({level:'warning',event:'image_draft_cleanup',message,at:Date.now()}).catch(error=>console.warn('Image cleanup warning could not be saved:',error?.code||error?.name));
  }
}
async function previewImage(id){
  const {metadata,buffer}=await imageStore.readImage(id);
  const image=nativeImage.createFromBuffer(buffer),size=image.getSize();
  const exact=size.width===metadata.width&&size.height===metadata.height;
  const rotated=size.width===metadata.height&&size.height===metadata.width;
  if(image.isEmpty()||(!exact&&!rotated))throw new Error('图片内容无法完整解码，请重新选择有效图片');
  const scale=Math.min(1,160/size.width,160/size.height);
  return{id:metadata.id,previewDataUrl:image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'}).toDataURL()};
}
async function invoke(method,payload){
  if(method==='snapshot')return getSnapshot();
  if(method==='importImages'){
    const imported=await imageStore.importImages(payload.images);
    try{const result=[];for(const metadata of imported)result.push({...metadata,...await previewImage(metadata.id)});return result;}
    catch(error){try{await imageStore.discardDrafts(imported.map(image=>image.id));}catch(cleanupError){console.warn('Rejected image drafts could not be cleaned:',cleanupError?.code||cleanupError?.name);}throw error;}
  }
  if(method==='imagePreviews'){const result=[];for(const id of payload.ids)result.push(await previewImage(id));return result;}
  if(method==='discardImages'){await imageStore.discardDrafts(payload.ids);logImageWarnings();return true;}
  if(method==='createTask'){
    validateNewTask(payload,Date.now(),store.snapshot().settings);
    const input={...payload,attachments:await imageStore.prepare(payload.attachments??[])};
    try{return await engine.createTask(input);}finally{logImageWarnings();}
  }
  if(method==='updateTask'){
    const patch={...payload.patch};
    try{return await engine.updateTask(payload.id,patch,{prepareAttachments:refs=>imageStore.prepare(refs)});}finally{logImageWarnings();}
  }
  if(method==='pauseAll'){await pauseAll(payload?.paused!==false);return true;}
  if(method==='settings')return applySettings(payload);
  if(method==='diagnose')return adapter.diagnose();
  if(method==='refreshQuota'){await quotaSync.refresh();return adapter.status();}
  if(method==='retryScheduler'){engine.stop();await engine.tick();if(!store.snapshot().settings.pausedAll)await engine.start();return true;}
  if(method==='listThreads')return adapter.listThreads({query:typeof payload?.query==='string'?payload.query.slice(0,200):''});
  if(method==='listWindows')return adapter.listWindows();
  if(method==='captureCurrent'){if(typeof payload?.windowId!=='string'||payload.windowId.length>500)throw new Error('窗口标识无效');const result=await adapter.captureCurrent(payload.windowId);showMain();return result;}
  if(method==='readClipboard')return clipboard.readText().slice(0,2000);
  if(method==='openThread')return openThread(payload?.link);
  if(method==='taskAction'){
    const task=store.snapshot().tasks.find(t=>t.id===payload.id);if(!task)throw new Error('找不到这项任务');
    if(payload.action==='pause')return engine.pauseTask(task.id);
    if(payload.action==='enable')return engine.resumeTask(task.id);
    if(payload.action==='confirmDelivered')return engine.confirmDelivery(task.id,payload.intentId);
    if(payload.action==='delete')return engine.deleteTask(task.id);
    if(payload.action==='check'){await engine.tick();return true;}
    if(payload.action==='open'){if(task.target.type==='fixed')return openThread(task.target.link);if(adapter.focusWindow)return adapter.focusWindow(task.target.windowId);await adapter.captureCurrent(task.target.windowId);return {opened:true};}
  }
  if(method==='exportLogs'){
    const result=await dialog.showSaveDialog(mainWindow,{title:appText('导出执行记录','Export history'),defaultPath:appText('Codex定时助手-执行记录.json','Codex-Timer-history.json'),filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return false;
    await fs.promises.writeFile(result.filePath,JSON.stringify({exportedAt:new Date().toISOString(),logs:store.snapshot().logs},null,2),'utf8');return true;
  }
  if(method==='clearLogs')return await store.clearLogs();
  if(method==='chooseCli'){
    const result=await dialog.showOpenDialog(mainWindow,{title:appText('选择 Codex CLI 程序','Choose the Codex CLI executable'),properties:['openFile'],filters:[{name:'Codex',extensions:['exe']}]});if(result.canceled)return false;const selected=result.filePaths[0];if(path.basename(selected).toLowerCase()!=='codex.exe')throw new Error(appText('请选择 Codex 安装目录中的 codex.exe','Choose codex.exe from the Codex installation'));await store.updateSettings({cliPath:selected});await adapter.diagnose();return true;
  }
  if(method==='window'){
    switch(payload.action){case'minimize':mainWindow.minimize();break;case'maximize':toggleExpanded();break;case'close':mainWindow.hide();break;case'showMain':showMain();break;case'showOrb':await store.updateSettings({showOrb:true});showOrb();break;case'hideOrb':await store.updateSettings({showOrb:false});hideOrbWindow();break;case'orbMenu':orbMenu();break;case'orbDragStart':orbDrag.begin();break;case'orbDragMove':orbDrag.move();break;case'orbDragEnd':orbDrag.end();break;case'quit':quit();break;}return true;
  }
  throw new Error('不支持的操作');
}
function smokeAdapter(){
  const id='11111111-1111-4111-8111-111111111111';let calls=0;
  return {status:()=>({connected:true,testMode:true,plan:'测试环境',cliPath:'合成测试适配器',message:'桌面自动测试使用合成数据，不连接真实 Codex。',quota:{primary:{usedPercent:12},secondary:{usedPercent:24}},capabilities:{listThreads:true,readQuota:true,readState:true,sendMessage:true,resolveCurrent:true,answerQuestion:true}}),diagnose:async()=>({connected:true}),listThreads:async()=>[{id,name:'桌面测试项目',project:'合成数据',link:`codex://threads/${id}`}],listWindows:async()=>[{id:'test-window',title:'Codex 测试窗口'}],captureCurrent:async windowId=>({type:'current',windowId,confirmedThreadId:id,nickname:'桌面测试项目'}),observe:async target=>({threadId:target.threadId||id,windowId:target.windowId,status:'idle',lastTurnId:'test-turn',reason:'合成测试：空闲'}),perform:async action=>({status:'confirmed',threadId:action.threadId,receipt:`test-${++calls}`,message:'测试适配器：模拟确认，未发送真实消息'}),close:()=>{},get calls(){return calls;}};
}
async function boot(){
  Menu.setApplicationMenu(null);
  fs.mkdirSync(dataDir,{recursive:true});
  protocol.handle('ctimer',request=>{try{const url=new URL(request.url);const file=decodeURIComponent(url.pathname.replace(/^\//,''));if(url.hostname!=='app'||!allowedFiles.has(file))return new Response('Not found',{status:404});return net.fetch(pathToFileURL(path.join(__dirname,'..','ui',file)).href);}catch{return new Response('Bad request',{status:400});}});
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  const core=await import(pathToFileURL(path.join(__dirname,'core','index.mjs')).href);parseThreadLink=core.parseThreadLink;
  const existing=fs.existsSync(path.join(dataDir,'state.json'));store=new core.TaskStore(dataDir);await store.init();
  const validation=await import(pathToFileURL(path.join(__dirname,'core','validation.mjs')).href);validateNewTask=validation.newTask;
  const {AttachmentStore}=await import(pathToFileURL(path.join(__dirname,'attachments.mjs')).href);
  imageStore=new AttachmentStore(path.join(store.directory,'attachments'));await imageStore.init();
  if(!existing&&process.env.CODEX_TIMER_TIMEZONE)await store.updateSettings({timeZone:process.env.CODEX_TIMER_TIMEZONE});
  if(SMOKE)adapter=smokeAdapter();else {const {CodexAdapter}=await import(pathToFileURL(path.join(__dirname,'adapters','codex.mjs')).href);adapter=new CodexAdapter({settings:()=>({...store.snapshot().settings,language:uiEnglish()?'en':'zh-CN'}),onStatus:()=>broadcast(),openExternal:link=>shell.openExternal(link),nativeScript:path.join(__dirname.replace('app.asar','app.asar.unpacked'),'native','windows.ps1'),dependencies:{resolveImages:refs=>imageStore.resolveForSend(refs)}});}
  engine=new core.TaskEngine({store,adapter,intervalMs:SMOKE?250:5000,confirmationTimeoutMs:90000});await engine.start();
  ipcMain.handle('timer:invoke',async(event,envelope)=>{try{const role=roleOf(event);if(!role||event.senderFrame!==event.sender.mainFrame)throw new Error('请求来源无效');const method=validateCall(envelope?.method,envelope?.payload,role);const value=await invoke(method,envelope.payload);if(!(method==='window'&&envelope.payload?.action?.startsWith('orbDrag')))broadcast();return {ok:true,value};}catch(error){return {ok:false,error:typeof error?.message==='string'?error.message.slice(0,1800):'操作失败'};}});
  quotaSync=startQuotaSync({read:refreshQuotaAndWake,onError:()=>broadcast()});
  createMain();setupTray();if(store.snapshot().settings.showOrb!==false&&!(SMOKE&&process.env.CODEX_TIMER_NO_ORB==='1'))showOrb();
  globalShortcut.register('CommandOrControl+Alt+Shift+S',()=>pauseAll(true).catch(error=>{startupError=error.message;broadcast();}));
  broadcastTimer=setInterval(broadcast,1500);broadcastTimer.unref();
  if(!SMOKE)adapter.diagnose().then(broadcast).catch(error=>{startupError=error.message;broadcast();});
  if(SMOKE)globalThis.__timerSmoke={snapshot:getSnapshot,engine,adapter,store,mainWindow:()=>mainWindow,orbWindow:()=>orbWindow,iconPng:()=>iconImage(256).toPNG().toString('base64'),quit};
}
function quit(){
  if(quitPromise)return quitPromise;
  exiting=true;quotaSync?.stop();engine?.stop();clearInterval(broadcastTimer);clearTimeout(orbHideTimer);globalShortcut.unregisterAll();
  if(sleepBlocker!==null){powerSaveBlocker.stop(sleepBlocker);sleepBlocker=null;}
  quitPromise=(async()=>{
    const results=await Promise.allSettled([adapter?.close(),imageStore?.clearDrafts()]);
    for(const result of results)if(result.status==='rejected')console.warn('Shutdown cleanup will be retried on next start:',result.reason?.code||result.reason?.name);
    logImageWarnings();app.quit();
  })();return quitPromise;
}
app.on('second-instance',showMain);app.on('window-all-closed',()=>{});app.on('before-quit',event=>{if(!exiting){event.preventDefault();quit();}});
app.whenReady().then(()=>singleInstance?boot():undefined).catch(error=>{startupError=error.message;console.error('Startup failed:',error.message);if(!SMOKE)dialog.showErrorBox('Codex 定时助手无法启动',`${error.message}\n\n未启用任何自动任务。请保留数据目录并查看交付说明。`);app.exit(1);});
