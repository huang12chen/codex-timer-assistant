import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as validation from '../src/core/validation.mjs';
import {TaskEngine,TaskStore} from '../src/core/index.mjs';
import guard from '../src/ipc-guard.cjs';
import {CodexAdapter} from '../src/adapters/codex.mjs';

const threadId='11111111-1111-4111-8111-111111111111';
const target={type:'fixed',threadId,link:`codex://threads/${threadId}`};
const image={id:'22222222-2222-4222-8222-222222222222',name:'示意图.png',mime:'image/png',bytes:100,width:2,height:2,sha256:'a'.repeat(64)};
const second={...image,id:'44444444-4444-4444-8444-444444444444'};
const now=1793230000000;
async function engineFixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'ctimer-image-core-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new TaskStore(dir);let observation={threadId,status:'turn_completed',lastTurnId:'turn-1'};const actions=[];
  const adapter={observe:async()=>observation,perform:async action=>{actions.push(action);return{status:'confirmed',threadId,receipt:'receipt-'+actions.length};}};
  const engine=new TaskEngine({store,adapter,clock:{now:()=>now}});t.after(()=>engine.stop());
  return{store,engine,actions,observe:value=>{observation=value;},create:patch=>engine.createTask({title:'图片任务',kind:'once',target,message:'请按图调整',scheduledAt:now,enabled:true,attachments:[image],...patch})};
}

test('image references are bounded metadata, never renderer supplied file paths or binary data',()=>{
  assert.equal(typeof validation.normalizeAttachments,'function');
  assert.deepEqual(validation.normalizeAttachments([image]),[image]);
  for(const bad of [[{...image,path:'C:\\private.png'}],[{...image,data:'base64'}],[{...image,mime:'image/svg+xml'}],[{...image,bytes:11*1024*1024}],[{...image,width:16385}],[{...image,width:8192,height:8192}],[{...image,sha256:'bad'}],[image,image],Array.from({length:9},(_,n)=>({...image,id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`}))])assert.throws(()=>validation.normalizeAttachments(bad));
});

test('a once image message reaches the action and durable intent exactly once',async t=>{
  const h=await engineFixture(t);const task=await h.create();await h.engine.tick();await h.engine.tick();
  assert.equal(h.actions.length,1);assert.deepEqual(h.actions[0].attachments,[image]);
  assert.deepEqual(h.store.snapshot().tasks.find(t=>t.id===task.id).intents[0].attachments,[image]);
});

test('an image-only task is valid but removing its last image cannot leave an empty task',async t=>{
  const h=await engineFixture(t);const task=await h.create({message:''});assert.equal(task.message,'');
  await assert.rejects(h.engine.updateTask(task.id,{attachments:[]}));
  await h.engine.tick();assert.equal(h.actions[0].message,'');assert.deepEqual(h.actions[0].attachments,[image]);
});

test('a watch attaches images only on its first successful submission to the same chat',async t=>{
  const h=await engineFixture(t);const task=await h.create({kind:'watch',cutoffAt:null});await h.engine.tick();
  h.observe({threadId,status:'turn_completed',lastTurnId:'turn-2'});await h.engine.tick();
  assert.equal(h.actions.length,2);assert.deepEqual(h.actions[0].attachments,[image]);assert.deepEqual(h.actions[1].attachments??[],[]);
  assert.deepEqual(h.store.snapshot().tasks.find(t=>t.id===task.id).attachments,[image]);
});

test('watch edits submit only newly added images and keep the history across restart',async t=>{
  const h=await engineFixture(t);const task=await h.create({kind:'watch',cutoffAt:null,attachments:[]});
  await h.engine.tick();assert.deepEqual(h.actions[0].attachments??[],[]);
  await h.engine.updateTask(task.id,{attachments:[image]});
  h.observe({threadId,status:'turn_completed',lastTurnId:'turn-2'});await h.engine.tick();assert.deepEqual(h.actions[1].attachments,[image]);
  await h.engine.updateTask(task.id,{attachments:[image,second]});
  h.observe({threadId,status:'turn_completed',lastTurnId:'turn-3'});await h.engine.tick();assert.deepEqual(h.actions[2].attachments,[second]);
  await h.engine.updateTask(task.id,{attachments:[second]});
  const reloaded=new TaskStore(h.store.directory),afterRestart=[];
  const restarted=new TaskEngine({store:reloaded,clock:{now:()=>now},adapter:{observe:async()=>({threadId,status:'turn_completed',lastTurnId:'turn-4'}),perform:async action=>{afterRestart.push(action);return{status:'confirmed',threadId};}}});t.after(()=>restarted.stop());
  await restarted.tick();assert.deepEqual(afterRestart[0].attachments??[],[]);
  const fresh={...image,id:'55555555-5555-4555-8555-555555555555'};
  await restarted.updateTask(task.id,{attachments:[fresh]});
  restarted.adapter.observe=async()=>({threadId,status:'turn_completed',lastTurnId:'turn-5'});
  await restarted.tick();assert.deepEqual(afterRestart[1].attachments,[fresh]);
});

test('queued or unknown send outcomes prevent editing images or automatically resending them',async t=>{
  const h=await engineFixture(t);const task=await h.create();
  await h.store.updateTask(task.id,{intents:[{id:'33333333-3333-4333-8333-333333333333',type:'send_message',threadId,eventKey:'pending',status:'unknown',intendedAt:now}]});
  await assert.rejects(h.engine.updateTask(task.id,{attachments:[second]}),{code:'UNRESOLVED_INTENT'});
  await h.engine.tick();assert.equal(h.actions.length,0);
});

test('image metadata survives a storage restart without changing legacy task inputs',async t=>{
  const h=await engineFixture(t);const task=await h.create({enabled:false});
  const reloaded=new TaskStore(h.store.directory);await reloaded.init();assert.deepEqual(reloaded.snapshot().tasks.find(t=>t.id===task.id).attachments,[image]);
  const legacy=await h.create({enabled:false,attachments:undefined});assert.deepEqual(legacy.attachments??[],[]);
});

test('task image edit validation has no storage or scheduler side effects',async t=>{
  const h=await engineFixture(t);const task=await h.create({enabled:false});const before=h.store.snapshot();
  const preview=await h.engine.updateTask(task.id,{attachments:[second],enabled:true},{validateOnly:true});
  assert.deepEqual(preview.attachments,[second]);assert.equal(preview.enabled,true);
  assert.deepEqual(h.store.snapshot(),before);await h.engine.tick();assert.equal(h.actions.length,0);
});

test('image preparation holds an edit barrier and releases it after failure',async t=>{
  const h=await engineFixture(t);const task=await h.create();let release,entered=false;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const editing=h.engine.updateTask(task.id,{attachments:[second]},{prepareAttachments:async refs=>{entered=true;await gate;return refs;}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);
  await h.engine.tick();assert.equal(h.actions.length,0,'old images must not be submitted while new images are preparing');
  release();await editing;await h.engine.tick();assert.deepEqual(h.actions[0].attachments,[second]);
  const next=await h.create();
  await assert.rejects(h.engine.updateTask(next.id,{attachments:[second]},{prepareAttachments:async()=>{throw Error('disk failure');}}),/disk failure/);
  await h.engine.tick();assert.ok(h.actions.some(action=>action.taskId===next.id),'failed preparation must release its barrier');
});

test('image-only watch continuations receive usable text after the initial image submission',async t=>{
  const h=await engineFixture(t);await h.create({kind:'watch',cutoffAt:null,message:''});await h.engine.tick();
  h.observe({threadId,status:'turn_completed',lastTurnId:'turn-2'});await h.engine.tick();
  assert.deepEqual(h.actions[1].attachments??[],[]);assert.ok(h.actions[1].message.trim());
});

test('binary import IPC checks actual ArrayBuffer bytes before JSON serialization and rejects forged sizes',()=>{
  const request={images:[{name:'截图.png',data:new ArrayBuffer(300000)}]};
  assert.equal(guard.validateCall('importImages',request,'main'),'importImages');
  assert.throws(()=>guard.validateCall('importImages',request,'orb'),/权限/);
  for(const payload of [{images:[{name:'x.png',data:{byteLength:3}}]},{images:[{name:'x.png',data:'x'}]},{images:[{name:'x.png',data:new ArrayBuffer(11*1024*1024)}]},{images:[{name:'x.png',data:new ArrayBuffer(10),path:'C:\\private.png'}]}])assert.throws(()=>guard.validateCall('importImages',payload,'main'));
  for(const method of ['imagePreviews','discardImages']){
    assert.equal(guard.validateCall(method,{ids:[image.id]},'main'),method);
    assert.throws(()=>guard.validateCall(method,{ids:['../private']},'main'));
    assert.throws(()=>guard.validateCall(method,{ids:[image.id]},'orb'),/权限/);
  }
});

function adapterFixture(t,resolveImages){
  const calls=[];const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/read')return{thread:{id:threadId,path:'fixture.jsonl',source:'appServer'}};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    if(method==='thread/queue/add')return{queuedSubmission:{id:'queued',clientUserMessageId:params.clientUserMessageId}};
    throw Error('Unexpected method '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.165.0-alpha.1.2'}),createRpc:()=>rpc,readTail:async()=>({records:[{type:'event_msg',payload:{type:'task_complete',turn_id:'ready'}}]}),resolveImages}});t.after(()=>adapter.close());
  const action={id:'33333333-3333-4333-8333-333333333333',type:'send_message',threadId,target,message:'按图修改',attachments:[image]};
  return{adapter,calls,action};
}

test('the official queue carries verified localImage inputs, including image-only messages',async t=>{
  const h=adapterFixture(t,async refs=>{assert.deepEqual(refs,[image]);return[{type:'localImage',path:path.resolve('owned','image.png')}];});
  assert.equal((await h.adapter.perform({...h.action,message:''})).status,'queued');
  const input=h.calls.find(c=>c.method==='thread/queue/add').params.input;
  assert.deepEqual(input,[{type:'localImage',path:path.resolve('owned','image.png')}]);
});

test('missing image data is a proven refusal before queue submission',async t=>{
  const h=adapterFixture(t,async()=>{throw Error('图片文件缺失，请重新添加');});
  const result=await h.adapter.perform(h.action);assert.equal(result.status,'not_sent');assert.equal(result.possibleWrite,false);assert.match(result.message,/图片/);
  assert.equal(h.calls.some(c=>c.method==='thread/queue/add'),false);
});

test('the same operation id cannot silently reuse a result for different images',async t=>{
  const h=adapterFixture(t,async()=>[{type:'localImage',path:path.resolve('owned','image.png')}]);
  await h.adapter.perform(h.action);
  await assert.rejects(h.adapter.perform({...h.action,attachments:[second]}),/标识|不同/);
});
