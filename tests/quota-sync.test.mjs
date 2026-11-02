import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {startQuotaSync}=require('../src/quota-sync.cjs');
test('quota polling runs independently of tasks, coalesces reads, and stops cleanly',async()=>{
  let tick,reads=0,resolve,cancelled=false;
  const sync=startQuotaSync({read:()=>{reads++;return new Promise(r=>{resolve=r;});},schedule:(callback,ms)=>{tick=callback;assert.equal(ms,15000);return 1;},cancel:()=>{cancelled=true;}});
  tick();await Promise.resolve();tick();const pending=sync.refresh();assert.equal(reads,1);
  resolve('fresh');assert.equal(await pending,'fresh');tick();await Promise.resolve();assert.equal(reads,2);
  resolve('again');await sync.refresh();sync.stop();tick();await sync.refresh();assert.equal(reads,2);assert.equal(cancelled,true);
});
test('quota read failures reach the error observer and manual caller',async()=>{
  let failures=0;
  const sync=startQuotaSync({read:async()=>{throw new Error('offline');},onError:()=>{failures++;},schedule:()=>1,cancel:()=>{}});
  await assert.rejects(sync.refresh(),/offline/);assert.equal(failures,1);sync.stop();
});
