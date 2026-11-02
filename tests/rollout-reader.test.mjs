import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as rollout from '../src/adapters/rollout.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

const id='11111111-1111-4111-8111-111111111111';
const target={type:'fixed',threadId:id,link:`codex://threads/${id}`};
const event=(type,fields={})=>({type:'event_msg',payload:{type,...fields}});
const item=(type,fields={})=>({type:'response_item',payload:{type,...fields}});
const lines=records=>records.map(r=>JSON.stringify(r)+'\n').join('');
const meta={type:'session_meta',payload:{id}};
const start=event('task_started',{turn_id:'current'});
const image=item('message',{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+'x'.repeat(3*1024*1024)}]});
async function fixture(t,records=[meta,start],options={}){
  const dir=await mkdtemp(path.join(tmpdir(),'ctimer-reader-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'rollout.jsonl');await writeFile(file,lines(records));
  assert.equal(typeof rollout.createRolloutReader,'function','incremental lifecycle reader is required');
  const read=rollout.createRolloutReader({roots:[dir],...options});
  return{dir,file,read:()=>read(file,{threadId:id}),reader:read};
}
const state=result=>rollout.parseRollout(result.records,{threadId:id});

test('large image records cannot hide the active lifecycle boundary',async t=>{
  const h=await fixture(t,[meta,start,image]);const r=await h.read();
  assert.equal(r.incomplete,false);assert.equal(state(r).status,'active');
  assert.ok(JSON.stringify(r.records).length<10000,'image data is never retained');
});

test('large multi-part user messages are validated without retaining their text',async t=>{
  const h=await fixture(t,[meta,start,item('message',{role:'user',content:Array.from({length:20},()=>({type:'input_text',text:'x'.repeat(90000)}))})]);
  const r=await h.read();assert.equal(r.incomplete,false);assert.equal(state(r).status,'active');assert.ok(JSON.stringify(r.records).length<10000);
});

test('a submitted message id survives new turns and reader restart without retaining message contents',async t=>{
  const clientId='33333333-3333-4333-8333-333333333333';
  const privateText='PRIVATE_FIXTURE_'+('x'.repeat(70000));
  const h=await fixture(t,[meta,start,event('user_message',{client_id:clientId,message:privateText}),event('task_started',{turn_id:'newer'})]);
  const initial=await h.read();
  assert.deepEqual(initial.clientMessageIds,[clientId]);
  assert.equal(JSON.stringify(initial).includes('PRIVATE_FIXTURE_'),false);
  const freshReader=rollout.createRolloutReader({roots:[h.dir]});
  assert.deepEqual((await freshReader(h.file,{threadId:id,verify:true})).clientMessageIds,[clientId]);
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method)=>{
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    throw Error('Unexpected RPC '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:freshReader}});
  t.after(()=>adapter.close());
  const task={id:'test-watch',kind:'watch',intents:[{id:clientId,threadId:id,status:'queued',type:'send_message'}]};
  assert.deepEqual((await adapter.observe(target,{task})).acceptedMessageIds,[clientId]);
});

test('actual queue-consumption event retains only the same thread user message id',async t=>{
  const accepted='44444444-4444-4444-8444-444444444444';
  const foreign='55555555-5555-4555-8555-555555555555';
  const wrongType='66666666-6666-4666-8666-666666666666';
  const completed=(threadId,item)=>event('item_completed',{thread_id:threadId,turn_id:'current',item});
  const h=await fixture(t,[meta,start,
    completed(id,{type:'UserMessage',client_id:accepted,content:[{type:'input_text',text:'PRIVATE_QUEUE_'+('x'.repeat(70000))}]}),
    completed(foreign,{type:'UserMessage',client_id:foreign,content:[]}),
    completed(id,{type:'AgentMessage',client_id:wrongType,content:[]}),
    event('task_started',{turn_id:'later'})]);
  const result=await h.read();
  assert.deepEqual(result.clientMessageIds,[accepted]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_QUEUE_'),false);
});

test('an old interrupted summary cannot override an active turn behind large records',async t=>{
  const h=await fixture(t,[meta,start,image]);const calls=[];
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method)=>{
    calls.push(method);
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='thread/turns/list')return{data:[{id:'current',status:'interrupted',completedAt:null}]};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    throw Error('Unexpected write '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:h.reader}});
  t.after(()=>adapter.close());
  assert.equal((await adapter.observe(target)).status,'active');
  assert.equal(calls.includes('thread/turns/list'),false);
});

test('incremental reads consume only appended bytes and immediately honor an abort',async t=>{
  const h=await fixture(t,[meta,start,image]);await h.read();
  assert.equal((await h.read()).bytesRead,0);
  const added=lines([event('turn_aborted',{turn_id:'current'})]);await appendFile(h.file,added);
  const r=await h.read();assert.ok(r.bytesRead<=Buffer.byteLength(added));
  assert.equal(state(r).status,'needs_attention');
});

test('a partial terminal line blocks sending until its full newline arrives',async t=>{
  const h=await fixture(t,[meta,start,event('task_complete',{turn_id:'current'})]);
  assert.equal(state(await h.read()).status,'turn_completed');
  const next=JSON.stringify(event('turn_aborted',{turn_id:'current'}));
  await appendFile(h.file,next.slice(0,-4));assert.equal((await h.read()).incomplete,true);
  await appendFile(h.file,next.slice(-4)+'\n');const r=await h.read();
  assert.equal(r.incomplete,false);assert.equal(state(r).status,'needs_attention');
});

test('partial records cause a temporary observation wait instead of a permanent needs-attention state',async t=>{
  const h=await fixture(t,[meta,start,event('task_complete',{turn_id:'current'})]);
  await appendFile(h.file,'{"type":"event_msg","payload":');
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method)=>{
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    throw Error('No summary or send may authorize a partial record');
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:h.reader}});t.after(()=>adapter.close());
  assert.equal((await adapter.observe(target)).status,'waiting_network');
});

test('permission requests survive large irrelevant tool outputs until their matching response',async t=>{
  const h=await fixture(t,[meta,start,event('exec_approval_request',{call_id:'permit'}),image,item('function_call_output',{call_id:'unrelated',output:'x'.repeat(3*1024*1024)})]);
  assert.equal(state(await h.read()).question.kind,'permission');
  await appendFile(h.file,lines([item('function_call_output',{call_id:'permit',output:'{}'})]));
  assert.equal(state(await h.read()).status,'active');
});

test('event-looking text and image strings never become root lifecycle events',async t=>{
  const h=await fixture(t,[meta,start,item('message',{role:'user',content:[{type:'input_text',text:JSON.stringify(event('turn_aborted',{turn_id:'current'}))}]})]);
  assert.equal(state(await h.read()).status,'active');
});

test('truncation and replacement invalidate cached active evidence',async t=>{
  const h=await fixture(t,[meta,start,image]);await h.read();
  await writeFile(h.file,lines([meta,event('turn_aborted',{turn_id:'replacement'})]));
  assert.equal(state(await h.read()).status,'needs_attention');
  const replacement=path.join(h.dir,'new.jsonl');await writeFile(replacement,lines([meta,event('task_complete',{turn_id:'new'})]));
  await rename(replacement,h.file);assert.equal(state(await h.read()).status,'turn_completed');
});

test('same-size rewrites do not retain an earlier completion authorization',async t=>{
  const h=await fixture(t,[meta,event('task_complete',{turn_id:'old'})]);await h.read();
  const original=lines([meta,event('task_complete',{turn_id:'old'})]);
  const changed=lines([meta,event('turn_aborted',{turn_id:'old'})]);
  await writeFile(h.file,changed+' '.repeat(Buffer.byteLength(original)-Buffer.byteLength(changed)));
  await utimes(h.file,new Date(),new Date(Date.now()+2000));
  assert.equal(state(await h.read()).status,'needs_attention');
});

test('UTF-8 and question tokens crossing small chunks are preserved',async t=>{
  const question='请选择界面配色方案？';
  const h=await fixture(t,[meta,start,item('function_call',{name:'request_user_input',call_id:'q',arguments:JSON.stringify({questions:[{id:'style',question,options:[{label:'蓝色'},{label:'绿色'}]}]})})],{chunkBytes:37});
  const r=state(await h.read());assert.equal(r.status,'waiting_user');assert.equal(r.question.text,question);
});

test('bounded scan budgets resume without publishing incomplete coverage as idle',async t=>{
  const h=await fixture(t,[meta,start,item('message',{role:'user',content:[{type:'input_image',image_url:'x'.repeat(16000)}]}),event('turn_aborted',{turn_id:'current'})],{maxBytesPerRead:4096});
  let r=await h.read();assert.equal(r.incomplete,true);
  for(let i=0;i<10&&r.incomplete;i++)r=await h.read();
  assert.equal(r.incomplete,false);assert.equal(state(r).status,'needs_attention');
});

test('invalid complete JSON is rejected and unrelated session identities remain rejected',async t=>{
  const h=await fixture(t);await h.read();await appendFile(h.file,'{"type":"event_msg",bad}\n');
  await assert.rejects(h.read(),/记录|JSON/);
  await writeFile(h.file,lines([{...meta,payload:{id:'22222222-2222-4222-8222-222222222222'}},start]));
  await assert.rejects(h.read(),/标识|聊天/);
});

test('a larger replacement with a changed session header cannot reuse a cached identity',async t=>{
  const h=await fixture(t,[meta,start]);await h.read();
  await writeFile(h.file,lines([{type:'session_meta',payload:{id:'22222222-2222-4222-8222-222222222222'}},start,image]));
  await assert.rejects(h.read(),/标识|聊天/);
});

test('large typed error records retain numeric HTTP status and transient failure classification',async t=>{
  const h=await fixture(t,[meta,start,event('error',{codex_error_info:{http_connection_failed:{http_status_code:503}},message:'x'.repeat(90000)}),event('task_complete',{turn_id:'current'})]);
  const r=state(await h.read());assert.equal(r.status,'waiting_network');assert.equal(r.networkRecovery.retryable,true);assert.equal(r.networkRecovery.terminal,true);
});

test('oversized completion text cannot silently become an unfinished goal',async t=>{
  const content=Array.from({length:34},()=>({type:'output_text',text:'x'.repeat(3000)}));content.at(-1).text='[CODEX_TIMER_DONE]';
  const h=await fixture(t,[meta,start,item('message',{role:'assistant',phase:'final_answer',content}),event('task_complete',{turn_id:'current'})]);
  await assert.rejects(h.read(),/上限|记录/);
});

test('oversized goal receipts are rejected instead of losing successful completion proof',async t=>{
  const h=await fixture(t,[meta,start,item('function_call',{name:'update_goal',call_id:'done',arguments:'{"status":"complete"}'}),item('function_call_output',{call_id:'done',output:JSON.stringify({goal:{status:'complete'},padding:'x'.repeat(210000)})}),event('task_complete',{turn_id:'current'})]);
  await assert.rejects(h.read(),/上限|记录/);
});

test('a rejected lifecycle scan cannot fall back to an old completed summary and send',async t=>{
  const h=await fixture(t,[meta,start,event('exec_approval_request',{call_id:'permit'})]);await appendFile(h.file,'{"type":"event_msg",bad}\n');
  const writes=[];
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method,params)=>{
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='thread/turns/list')return{data:[{id:'current',status:'completed',completedAt:1793102400}]};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    if(method==='thread/queue/add'){writes.push(params);return{queuedSubmission:{id:'bad-send'}};}
    throw Error('Unexpected method '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:h.reader}});t.after(()=>adapter.close());
  assert.equal((await adapter.observe(target)).status,'unknown');
  await adapter.perform({id:'33333333-3333-4333-8333-333333333333',type:'send_message',threadId:id,target,message:'继续'});
  assert.equal(writes.length,0);
});

test('send preflight revalidates an in-place growing rewrite even when both cache anchors match',async t=>{
  const done=lines([event('task_complete',{turn_id:'current'})]);
  const aborted=JSON.stringify(event('turn_aborted',{turn_id:'current'}));
  const first=lines([meta,start,event('token_count',{padding:'h'.repeat(800)})]);
  const last=lines([event('token_count',{padding:'t'.repeat(3000)})]);
  const h=await fixture(t);await writeFile(h.file,first+done+last);
  const writes=[];
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method,params)=>{
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    if(method==='thread/turns/list')return{data:[{id:'current',status:'completed',completedAt:1793102400}]};
    if(method==='thread/queue/add'){writes.push(params);return{queuedSubmission:{id:'bad-send'}};}
    throw Error('Unexpected method '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:h.reader}});t.after(()=>adapter.close());
  assert.equal((await adapter.observe(target)).status,'turn_completed');
  await writeFile(h.file,first+aborted+' '.repeat(Buffer.byteLength(done)-Buffer.byteLength(aborted)-1)+'\n'+last+lines([event('token_count')]));
  await adapter.perform({id:'33333333-3333-4333-8333-333333333333',type:'send_message',threadId:id,target,message:'继续'});
  assert.equal(writes.length,0,'cached completion cannot authorize writing after a prefix rewrite');
});

test('a UTF-8 BOM split across tiny chunks does not invalidate a correctly identified session',async t=>{
  const h=await fixture(t,[meta,start],{chunkBytes:1});await writeFile(h.file,'\uFEFF'+lines([meta,start]));
  assert.equal(state(await h.read()).status,'active');
});

test('goal completion derived from a summary also requires a complete fresh scan',async t=>{
  const marker='[CODEX_TIMER_DONE]';
  const contents=lines([meta,{type:'turn_context',payload:{turn_id:'current'}},event('token_count',{padding:'h'.repeat(1000)}),item('message',{role:'assistant',phase:'final_answer',content:[{type:'output_text',text:marker}]}),event('token_count',{padding:'t'.repeat(3000)})]);
  const h=await fixture(t);await writeFile(h.file,contents);const verifies=[];
  const rpc={isAlive:true,start:async()=>{},close:async()=>{},request:async(method)=>{
    if(method==='thread/read')return{thread:{id,path:h.file,source:'appServer'}};
    if(method==='account/rateLimits/read')return{ordinaryUsageAllowed:true};
    if(method==='thread/turns/list')return{data:[{id:'current',status:'completed',completedAt:1793102400}]};
    throw Error('Unexpected method '+method);
  }};
  const adapter=new CodexAdapter({dependencies:{discover:async()=>({path:'codex.exe',version:'0.164.0'}),createRpc:()=>rpc,readTail:(file,options)=>{verifies.push(options.verify);return h.reader(file,options);}}});t.after(()=>adapter.close());
  const task={id:'33333333-3333-4333-8333-333333333333',kind:'watch',intents:[{type:'send_message',status:'confirmed',threadId:id}]};
  assert.equal((await adapter.observe(target,{task})).goalCompleted,true);
  await writeFile(h.file,contents.replace(marker,'x'.repeat(marker.length))+lines([event('token_count')]));
  assert.equal((await adapter.observe(target,{task})).goalCompleted,false);
  assert.ok(verifies.filter(Boolean).length>=2,'both completion decisions must use a full scan');
});
