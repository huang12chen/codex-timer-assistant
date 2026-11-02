import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { parser } from 'stream-json';
import { AdapterError } from './process.mjs';

const fail = message => new AdapterError(message, 'ROLLOUT_PROTOCOL');
const fields = new Set(['type','id','client_id','thread_id','turn_id','turnId','call_id','name','arguments','output','reason','will_retry','codex_error_info','codexErrorInfo','error','message','last_agent_message','role','phase']);
const within = (file, root) => { const r=path.relative(root,file);return !r||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${path.sep}`)); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Project large JSON records with the upstream streaming tokenizer. Image data
// and unrelated fields are validated but never assembled into a JS string.
function projection(entry) {
  const stream=parser.asStream({packValues:false,packKeys:true,streamKeys:false,packNumbers:true,streamNumbers:false});
  const stack=[];let root,scalar=null,nodes=0,characters=0,error;
  const wanted=p=>{
    if(!p.length)return true;
    if(p.length===1)return ['type','timestamp','payload'].includes(p[0]);
    if(p[0]!=='payload')return false;
    if(p[1]==='item')return p.length===2||(p.length===3&&['type','client_id'].includes(p[2]));
    if(p[1]==='arguments'&&root?.payload?.name&&!['request_user_input','update_goal'].includes(String(root.payload.name).split(/[.:/]/u).at(-1)))return false;
    if(p[1]==='output'&&root?.payload?.call_id&&!entry.pending.has(root.payload.call_id))return false;
    if(p[1]==='message'&&root?.payload?.type&&!['error','turn_failed'].includes(root.payload.type))return false;
    if(fields.has(p[1]))return true;
    if(p[1]!=='content'||root?.payload?.role==='user')return false;
    if(root?.payload?.phase&&root.payload.phase!=='final_answer')return false;
    if(Number.isInteger(p[2])&&p[2]>=32)throw fail('聊天完成证明超过安全读取上限，不能据此推断目标未完成');
    return p.length===2||Number.isInteger(p[2])&&p[2]<32&&(p.length===3||['type','text'].includes(p[3]));
  };
  const nextPath=()=>{const f=stack.at(-1);return f?[...f.path,f.array?f.index:f.key]:[];};
  const put=(p,value)=>{
    if(!wanted(p))return;
    if(++nodes>4096)throw fail('聊天状态字段超过安全读取上限');
    if(!p.length){root=value;return;}
    const parent=stack.at(-1)?.value;
    if(parent!==undefined)Object.defineProperty(parent,p.at(-1),{value,writable:true,enumerable:true,configurable:true});
  };
  const advance=()=>{const f=stack.at(-1);if(f?.array)f.index++;};
  stream.on('error',e=>{error=e;});
  stream.on('data',token=>{
    if(error)return;
    try {
      if(token.name==='keyValue'){if(token.value.length>256)throw fail('聊天记录键名过长');stack.at(-1).key=token.value;}
      else if(token.name==='startObject'||token.name==='startArray'){
        const p=nextPath(),array=token.name==='startArray',value=wanted(p)?(array?[]:Object.create(null)):undefined;
        put(p,value);stack.push({path:p,array,index:0,value});if(stack.length>64)throw fail('聊天记录嵌套超过安全读取上限');
      }else if(token.name==='endObject'||token.name==='endArray'){stack.pop();advance();}
      else if(token.name==='startString')scalar={path:nextPath(),text:''};
      else if(token.name==='stringChunk'&&scalar&&wanted(scalar.path)){
        if(scalar.text.length+token.value.length>200000)throw fail('聊天状态字段超过安全读取上限，不能忽略截断后的完成或阻塞证据');
        const part=token.value;
        scalar.text+=part;characters+=part.length;if(characters>1024*1024)throw fail('聊天状态文本超过安全读取上限');
      }else if(token.name==='endString'){if(scalar)put(scalar.path,scalar.text);scalar=null;advance();}
      else if(['numberValue','trueValue','falseValue','nullValue'].includes(token.name)){put(nextPath(),token.name==='numberValue'?Number(token.value):token.value);advance();}
    }catch(e){error=e;stream.destroy(e);}
  });
  return {
    async write(buffer){if(error)throw error;await new Promise((resolve,reject)=>stream.write(buffer,e=>e?reject(e):resolve()));if(error)throw error;},
    async end(){stream.end();await finished(stream);if(error)throw error;return root;},
    destroy(){stream.destroy();},
  };
}

function keepRecord(entry,record,threadId){
  if(!entry.identified){
    if(record?.type!=='session_meta'||String(record.payload?.id).toLowerCase()!==threadId)throw new AdapterError('聊天记录标识与目标聊天不一致，已拒绝读取','INVALID_TARGET');
    entry.identified=true;return;
  }
  const p=record?.payload||{},type=p.type;
  const deliveredId = record?.type==='event_msg'&&type==='user_message' ? p.client_id
    : record?.type==='event_msg'&&type==='item_completed'&&p.item?.type==='UserMessage'&&typeof p.thread_id==='string'&&p.thread_id.toLowerCase()===threadId ? p.item.client_id : null;
  if(type==='user_message'||type==='item_completed'){
    if(typeof deliveredId==='string'&&uuid.test(deliveredId)){
      const id=deliveredId.toLowerCase();entry.clientMessageIds.delete(id);entry.clientMessageIds.add(id);
      if(entry.clientMessageIds.size>2000)entry.clientMessageIds.delete(entry.clientMessageIds.values().next().value);
    }
    return;
  }
  if(record?.type==='event_msg'&&['task_started','turn_started'].includes(type)){
    entry.records=[];entry.pending.clear();entry.turnId=p.turn_id||p.turnId||null;
  }else if(record?.type==='turn_context'&&p.turn_id&&entry.turnId!==p.turn_id){
    entry.records=[];entry.pending.clear();entry.turnId=p.turn_id;
  }
  const lifecycle=record?.type==='event_msg'&&(['task_started','turn_started','task_complete','turn_complete','turn_aborted','task_aborted','turn_failed','error'].includes(type)||/approval_request|request_approval/u.test(type||''));
  const call=record?.type==='response_item'&&type==='function_call'&&['request_user_input','update_goal'].includes(String(p.name||'').split(/[.:/]/u).at(-1));
  const output=record?.type==='response_item'&&type==='function_call_output'&&entry.pending.has(p.call_id);
  const final=record?.type==='response_item'&&type==='message'&&p.role==='assistant'&&p.phase==='final_answer';
  if(!(lifecycle||call||output||final||record?.type==='turn_context'))return;
  if(lifecycle&&/approval_request|request_approval/u.test(type||''))entry.pending.add(p.call_id||p.id);
  if(call)entry.pending.add(p.call_id);
  if(output)entry.pending.delete(p.call_id);
  if(record.type==='turn_context'){
    entry.records=entry.records.filter(r=>r.type!=='turn_context');
    record={type:'turn_context',payload:{turn_id:p.turn_id}};
  }
  if(final)entry.records=entry.records.filter(r=>!(r.type==='response_item'&&r.payload?.type==='message'));
  entry.records.push(record);
  if(entry.records.length>2000||entry.pending.size>500||Buffer.byteLength(JSON.stringify(entry.records))>4*1024*1024)throw fail('当前回合状态事件超过安全读取上限，等待本人核实');
}

async function feed(entry,chunk,threadId){
  let from=0;
  while(from<chunk.length){
    const newline=chunk.indexOf(10,from),end=newline<0?chunk.length:newline;
    let part=chunk.subarray(from,end);
    entry.lineBytes+=part.length;
    if(!entry.parser&&entry.lineBytes<=65536){entry.parts.push(Buffer.from(part));}
    else {
      if(!entry.parser){
        entry.parser=projection(entry);let prefix=Buffer.concat(entry.parts);
        if(!entry.identified&&prefix[0]===239&&prefix[1]===187&&prefix[2]===191)prefix=prefix.subarray(3);
        await entry.parser.write(prefix);entry.parts=[];
      }
      await entry.parser.write(part);
    }
    if(newline<0)break;
    if(entry.lineBytes){
      let record;
      try {record=entry.parser?await entry.parser.end():JSON.parse(Buffer.concat(entry.parts).toString('utf8').replace(!entry.identified?/^\uFEFF/u:/$^/u,''));}
      catch(e){if(!entry.parser&&Buffer.concat(entry.parts).toString('utf8').trim()===''){record=null;}else throw fail('聊天记录包含无法识别的完整 JSON 行，已停止推断状态');}
      if(record)keepRecord(entry,record,threadId);
    }
    entry.parser=null;entry.parts=[];entry.lineBytes=0;from=newline+1;
  }
}

// One small cache per adapter. Initial indexing has an I/O budget; subsequent
// polls read only appended bytes. An incomplete line never authorizes a send.
export function createRolloutReader({roots,maxBytesPerRead=64*1024*1024,chunkBytes=65536,maxFiles=16}={}){
  for(const value of [maxBytesPerRead,chunkBytes,maxFiles])if(!Number.isSafeInteger(value)||value<1)throw new TypeError('聊天记录读取上限无效');
  const entries=new Map(),pending=new Map();
  const read=async(file,{threadId,verify=false}={})=>{
    if(typeof file!=='string'||!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.jsonl'||!uuid.test(threadId||''))throw new AdapterError('聊天持久记录路径或标识无效','INVALID_TARGET');
    const canonical=await realpath(file),id=threadId.toLowerCase();
    const allowed=(await Promise.all(roots().map(async r=>{try{return await realpath(r);}catch{return null;}}))).filter(Boolean);
    if(!allowed.some(r=>within(canonical,r)))throw new AdapterError('聊天记录不在当前用户的 Codex 会话目录，已拒绝读取','INVALID_TARGET');
    const key=canonical+'\0'+id;
    if(pending.has(key)){
      const previous=pending.get(key);const result=await previous;
      if(!verify)return result;
      if(pending.get(key)===previous)pending.delete(key);
    }
    const operation=(async()=>{
      const handle=await open(canonical,'r');let entry;
      try{
        const info=await handle.stat();if(!info.isFile())throw fail('聊天记录不是普通文件');
        entry=entries.get(key);
        entries.delete(key);
        let valid=!verify&&entry&&entry.ino===info.ino&&entry.dev===info.dev&&entry.birth===info.birthtimeMs&&info.size>=entry.offset&&!(info.size===entry.size&&info.mtimeMs!==entry.mtime);
        if(valid&&entry.head?.length){const head=Buffer.alloc(entry.head.length);const r=await handle.read(head,0,head.length,0);valid=r.bytesRead===head.length&&head.equals(entry.head);}
        if(valid&&entry.anchor?.length){const anchor=Buffer.alloc(entry.anchor.length);const r=await handle.read(anchor,0,anchor.length,entry.offset-anchor.length);valid=r.bytesRead===anchor.length&&anchor.equals(entry.anchor);}
        if(!valid){entry?.parser?.destroy();entry={ino:info.ino,dev:info.dev,birth:info.birthtimeMs,offset:0,records:[],clientMessageIds:new Set(),pending:new Set(),parts:[],lineBytes:0,started:false,identified:false,turnId:null};entries.delete(key);}
        // Anchors accelerate observation; they cannot prove the entire prefix
        // was unchanged. Before sending or accepting goal completion, rebuild
        // state from the full file instead of trusting cached authorization.
        if(verify&&info.size>512*1024*1024)throw fail('聊天记录超过单次完整核验上限，已阻止自动发送');
        const stop=verify?info.size:Math.min(info.size,entry.offset+maxBytesPerRead);let bytesRead=0;
        while(entry.offset<stop){
          const buffer=Buffer.alloc(Math.min(chunkBytes,stop-entry.offset));const r=await handle.read(buffer,0,buffer.length,entry.offset);
          if(!r.bytesRead)break;await feed(entry,buffer.subarray(0,r.bytesRead),id);entry.offset+=r.bytesRead;bytesRead+=r.bytesRead;
        }
        const after=await handle.stat();
        if(after.size<entry.offset||(after.size===info.size&&after.mtimeMs!==info.mtimeMs))throw fail('聊天记录在读取期间发生改写，等待重新核对');
        entry.size=after.size;entry.mtime=after.mtimeMs;entry.anchor=Buffer.alloc(Math.min(128,entry.offset));
        entry.head=Buffer.alloc(Math.min(256,entry.offset));
        if(entry.head.length)await handle.read(entry.head,0,entry.head.length,0);
        if(entry.anchor.length)await handle.read(entry.anchor,0,entry.anchor.length,entry.offset-entry.anchor.length);
        const partial=entry.lineBytes>0&&(entry.parser||Buffer.concat(entry.parts).toString('utf8').trim()!=='');
        entries.delete(key);entries.set(key,entry);
        while(entries.size>maxFiles){const first=entries.keys().next().value;entries.get(first)?.parser?.destroy();entries.delete(first);}
        return{records:structuredClone(entry.records),clientMessageIds:[...entry.clientMessageIds],incomplete:!entry.identified||entry.offset<after.size||Boolean(partial),modifiedAt:after.mtimeMs,bytesRead};
      }catch(e){entry?.parser?.destroy();entries.delete(key);throw e;}
      finally{await handle.close();}
    })();
    pending.set(key,operation);try{return await operation;}finally{if(pending.get(key)===operation)pending.delete(key);}
  };
  return read;
}
