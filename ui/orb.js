import { upcoming, formatDuration, taskStatusLabel } from './time.mjs';
import { initializeLiquidRim } from './liquid-rim.mjs';
import { bindOrbInteraction } from './orb-interaction.mjs';
import { tr, setLanguage, currentLanguage } from './i18n.mjs';
let state={tasks:[],settings:{}};
let disposed=false,renderTimer=0;
const $=id=>document.getElementById(id);
export const orbRim=initializeLiquidRim($('orb'));
function display(value,description,ratio=0,attention=false){
  $('orb-time').textContent=value;
  $('orb').title=description;
  document.querySelector('.orb-content').setAttribute('aria-label',description+(currentLanguage()==='en'?', open assistant':'，打开助手'));
  $('progress').style.strokeDashoffset=String(301.6*(1-ratio));
  $('orb-led').className='orb-led'+(attention?' attention':ratio?' active':'');
}
function render(){
  $('orb').classList.toggle('orb-closed',state.settings?.showOrb!==true);
  setLanguage(state.settings?.language||'zh-CN',state.app?.systemLocale||navigator.language);
  document.documentElement.lang=currentLanguage();
  document.title=tr('Codex 倒计时');
  document.documentElement.style.setProperty('--orb-tint',String(1-(state.settings?.glassTransparency??40)/100));
  const failure=state.engine?.lastError||(state.engine&&!state.engine.running&&!state.settings?.pausedAll);
  if(failure){display(tr('已停止'),tr('调度已停止，请打开助手检查'),0,true);return;}
  const next=upcoming(state.tasks||[]);
  const attention=(state.tasks||[]).filter(t=>t.state==='needs_attention').length;
  if(state.settings?.pausedAll||!next){display(state.settings?.pausedAll?tr('已暂停'):attention?tr('需处理'):tr('待命'),attention?(currentLanguage()==='en'?`${attention} task(s) need attention`:attention+' 项任务需要处理'):tr('暂无待执行任务'),0,attention>0);return;}
  const {task,due}=next;
  const remaining=due===null?null:Math.max(0,due-Date.now());
  const ratio=due===null?1:Math.min(1,remaining/Math.max(1,due-task.createdAt));
  display(remaining===null?taskStatusLabel(task):remaining===0?tr('核对中'):formatDuration(remaining),task.title+' · '+taskStatusLabel(task),ratio);
}
const unsubscribeState=window.timer.onState(value=>{if(!disposed){state=value;render();}});
window.timer.invoke('snapshot').then(value=>{if(!disposed){state=value;render();}}).catch(()=>{if(!disposed)display(tr('连接中'),tr('正在连接助手'));});
function connectionError(){if(!disposed)display(tr('连接异常'),tr('请从任务栏打开助手'),0,true);}
const disposeInteraction=bindOrbInteraction(document.querySelector('.orb-content'),(method,payload)=>window.timer.invoke(method,payload),connectionError);
function openMenu(event){event.preventDefault();window.timer.invoke('window',{action:'orbMenu'}).catch(connectionError);}
function syncCountdown(){
  clearInterval(renderTimer);renderTimer=0;
  if(disposed||document.hidden)return;
  render();renderTimer=setInterval(render,1000);
}
export function disposeOrb(){
  if(disposed)return;
  disposed=true;clearInterval(renderTimer);renderTimer=0;orbRim.dispose();
  if(typeof unsubscribeState==='function')unsubscribeState();
  disposeInteraction();
  document.removeEventListener('contextmenu',openMenu);document.removeEventListener('visibilitychange',syncCountdown);
  window.removeEventListener('pagehide',disposeOrb);
}
document.addEventListener('contextmenu',openMenu);document.addEventListener('visibilitychange',syncCountdown);
window.addEventListener('pagehide',disposeOrb,{once:true});syncCountdown();
