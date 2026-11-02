import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { TaskEngine, TaskStore } from '../src/core/index.mjs';

const threadId='11111111-1111-4111-8111-111111111111';
const target={type:'fixed',threadId,link:`codex://threads/${threadId}`};
const event=(type,fields={})=>({type:'event_msg',payload:{type,...fields}});
const failedTurn=(turnId='failed-1',info={response_stream_disconnected:{http_status_code:null}},ended=true)=>[
  event('task_started',{turn_id:turnId}),event('error',{codex_error_info:info}),
  ...(ended?[event('task_complete',{turn_id:turnId})]:[]),
];
function fixture(){
  const state={now:1793102400000,records:failedTurn(),turn:null,allowance:true,quotaError:null,queueError:null};
  const calls=[];
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/read')return{thread:{id:threadId,path:'synthetic.jsonl',source:'appServer',status:{type:'notLoaded'}}};
    if(method==='thread/turns/list')return{data:state.turn?[state.turn]:[],nextCursor:null};
    if(method==='account/rateLimits/read'){if(state.quotaError)throw state.quotaError;return{ordinaryUsageAllowed:state.allowance,rateLimits:{primary:{usedPercent:20},secondary:{usedPercent:30}}};}
    if(method==='thread/queue/add'){if(state.queueError)throw state.queueError;return{queuedSubmission:{id:'receipt-'+calls.length,clientUserMessageId:params.clientUserMessageId}};}
    throw Error('Unexpected synthetic method '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:async()=>({records:state.records}),now:()=>state.now}});
  const sends=()=>calls.filter(call=>call.method==='thread/queue/add');
  const perform=()=>adapter.perform({id:'33333333-3333-4333-8333-333333333333',type:'send_message',threadId,target,message:'继续'});
  return{adapter,state,calls,sends,perform};
}

test('a terminal typed network failure backs off then becomes retryable on a fresh allowance',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  assert.equal((await h.adapter.observe(target)).status,'waiting_network');
  h.state.now+=31000;
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  assert.equal((await h.perform()).status,'queued');assert.equal(h.sends().length,1);
  await h.perform();assert.equal(h.sends().length,1);
});

test('persisted in-progress evidence keeps a network-retrying turn active',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.records=failedTurn('retrying',{http_connection_failed:{http_status_code:null}},false);
  h.state.turn={id:'retrying',status:'inProgress'};
  assert.equal((await h.adapter.observe(target)).status,'active');
  assert.equal((await h.perform()).retryState,'running');assert.equal(h.sends().length,0);
});

test('a network error without a terminal boundary never permits a continuation',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.records=failedTurn('not-ended',{httpConnectionFailed:{httpStatusCode:503}},false);
  await h.adapter.observe(target);h.state.now+=600000;
  assert.equal((await h.adapter.observe(target)).status,'waiting_network');
  await h.perform();assert.equal(h.sends().length,0);
});

test('a matching failed turn summary supplies the missing terminal boundary',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.records=failedTurn('summary-failed',{http_connection_failed:{http_status_code:502}},false);
  h.state.turn={id:'summary-failed',status:'failed',error:{codexErrorInfo:{httpConnectionFailed:{httpStatusCode:502}}}};
  assert.equal((await h.adapter.observe(target)).status,'waiting_network');h.state.now+=31000;
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
});

test('authentication and invalid-request HTTP failures need attention rather than retry',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  for(const status of [400,401,403,404]){
    h.state.records=failedTurn('http-'+status,{http_connection_failed:{http_status_code:status}});
    assert.equal((await h.adapter.observe(target)).status,'needs_attention');
  }
  assert.equal(h.sends().length,0);
});

test('a recovered connection still waits when quota is unavailable or unknown',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  await h.adapter.observe(target);h.state.now+=31000;
  h.state.allowance=false;assert.equal((await h.adapter.observe(target)).status,'waiting_quota');
  h.state.allowance=null;assert.equal((await h.adapter.observe(target)).status,'waiting_quota');
  h.state.allowance=true;assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  h.state.quotaError=Object.assign(Error('offline'),{code:'RPC_TIMEOUT'});
  assert.equal((await h.perform()).retryState,'waiting_network');assert.equal(h.sends().length,0);
});

test('successive terminal network failures get longer cooldowns until a normal turn completes',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  await h.adapter.observe(target);h.state.now+=31000;assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  h.state.records=failedTurn('failed-2');assert.equal((await h.adapter.observe(target)).status,'waiting_network');
  h.state.now+=31000;assert.equal((await h.adapter.observe(target)).status,'waiting_network');
  h.state.now+=30000;assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  h.state.records=[event('task_started',{turn_id:'normal'}),event('task_complete',{turn_id:'normal'})];
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  h.state.records=failedTurn('failed-3');await h.adapter.observe(target);h.state.now+=31000;
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
});

test('manual interruption remains authoritative after a late network error',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.records=[...failedTurn('stopped'),event('turn_aborted',{turn_id:'stopped'}),event('turn_failed',{turn_id:'stopped',codex_error_info:{http_connection_failed:{http_status_code:503}}})];
  assert.equal((await h.adapter.observe(target)).status,'needs_attention');h.state.now+=600000;
  await h.perform();assert.equal(h.sends().length,0);
});

test('network retry delay stays capped at five minutes across further failed turns',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  for(let i=0;i<7;i++){
    h.state.records=failedTurn('successive-'+i);assert.equal((await h.adapter.observe(target)).status,'waiting_network');
    const delay=Math.min(300000,30000*(2**i));h.state.now+=delay-1;
    assert.equal((await h.adapter.observe(target)).status,'waiting_network','retry must respect delay for attempt '+(i+1));
    h.state.now+=1;assert.equal((await h.adapter.observe(target)).status,'turn_completed');
  }
});

test('newer persisted active turns prevent retrying an older failed turn',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.turn={id:'newer-active',status:'inProgress'};
  assert.equal((await h.adapter.observe(target)).status,'active');await h.perform();assert.equal(h.sends().length,0);
  h.state.turn={id:'newer-failed',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}};
  h.state.now+=600000;assert.equal((await h.adapter.observe(target)).status,'waiting_network');
  await h.perform();assert.equal(h.sends().length,0);
});

test('late lifecycle events tagged with an older turn cannot stop a newer active turn',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  for(const type of ['turn_failed','task_complete','turn_aborted']){
    h.state.records=[event('task_started',{turn_id:'current-turn'}),event(type,{turn_id:'older-turn',codex_error_info:{http_connection_failed:{http_status_code:503}}})];
    assert.equal((await h.adapter.observe(target)).status,'active',type+' belongs to an older turn');
  }
  assert.equal(h.sends().length,0);
});

test('a matching failed summary can confirm a typed tail error even when its error details are absent',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  h.state.records=failedTurn('summary-no-details',{http_connection_failed:{http_status_code:503}},false);
  h.state.turn={id:'summary-no-details',status:'failed',error:null};
  assert.equal((await h.adapter.observe(target)).status,'waiting_network');h.state.now+=31000;
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
});

test('unresolved approval survives a network terminal event and prevents automatic writes',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  const records=failedTurn('approval-turn');
  records.splice(1,0,event('exec_approval_request',{call_id:'permission-1'}));h.state.records=records;
  const before=await h.adapter.observe(target);assert.equal(before.status,'waiting_user');assert.equal(before.question.kind,'permission');
  h.state.now+=31000;await h.perform();assert.equal(h.sends().length,0);
});

test('an unanswered ordinary question stays blocked after network failure and turn completion',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  const records=failedTurn('question-turn');
  records.splice(1,0,{type:'response_item',payload:{type:'function_call',name:'request_user_input',call_id:'question-1',arguments:JSON.stringify({questions:[{id:'implementation',question:'选择实现方式？',options:[{label:'A'},{label:'B'}]}]})}});h.state.records=records;
  const before=await h.adapter.observe(target);assert.equal(before.status,'needs_attention');assert.equal(before.question.kind,'ordinary');
  h.state.now+=31000;await h.perform();assert.equal(h.sends().length,0);
});

test('an explicitly resolved question allows recovery of the later terminal network failure',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  const records=failedTurn('resolved-question');
  records.splice(1,0,event('exec_approval_request',{call_id:'permission-1'}),{type:'response_item',payload:{type:'function_call_output',call_id:'permission-1',output:'Resolved by the user'}});h.state.records=records;
  assert.equal((await h.adapter.observe(target)).status,'waiting_network');h.state.now+=31000;
  assert.equal((await h.adapter.observe(target)).status,'turn_completed');
});

test('a newer permanent failure message cannot borrow an older transient error classification',async t=>{
  const h=fixture();t.after(()=>h.adapter.close());
  for(const message of ['HTTP 401 Unauthorized: invalid API key','permission denied by policy']){
    h.state.records=failedTurn('contradictory-final',{http_connection_failed:{http_status_code:503}},false);
    h.state.turn={id:'contradictory-final',status:'failed',error:{message}};
    assert.equal((await h.adapter.observe(target)).status,'needs_attention');h.state.now+=31000;
    await h.perform();assert.equal(h.sends().length,0);
  }
});

test('real core and adapter can recover a stopped network turn without duplicate queued writes',async t=>{
  const h=fixture(),directory=await mkdtemp(path.join(tmpdir(),'codex-timer-network-recovery-'));
  const store=new TaskStore(directory),engine=new TaskEngine({store,adapter:h.adapter,clock:{now:()=>h.state.now}});
  t.after(async()=>{engine.stop();await h.adapter.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'codex-timer-network-recovery-'));await rm(directory,{recursive:true,force:true});});
  const task=await engine.createTask({title:'网络恢复合成验收',kind:'watch',target,message:'继续',enabled:true,scheduledAt:h.state.now});
  await engine.tick();assert.equal(h.sends().length,0);assert.equal(store.snapshot().tasks[0].state,'waiting_network');
  h.state.now+=31000;await engine.tick();assert.equal(h.sends().length,1);assert.equal(store.snapshot().tasks[0].state,'queued');
  h.state.records=[event('task_started',{turn_id:'resumed'}),event('user_message',{client_id:h.sends()[0].params.clientUserMessageId})];h.state.now+=5000;await engine.tick();
  assert.equal(store.snapshot().tasks.find(item=>item.id===task.id).intents[0].status,'confirmed');assert.equal(h.sends().length,1);
});
