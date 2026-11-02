import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createMenuAction } = createRequire(import.meta.url)('../src/menu-action.cjs');

test('native menu reports synchronous and asynchronous persistence failures', async () => {
  for (const action of [() => { throw new Error('save failed'); }, async () => { throw new Error('save failed'); }]) {
    const errors=[];
    assert.equal(await createMenuAction(action,error=>errors.push(error.message))(),false);
    assert.deepEqual(errors,['save failed']);
  }
});

test('a failed native menu action can be retried without terminating the helper', async () => {
  let attempts=0,reported=0,lastError=null;
  const action=createMenuAction(async()=>{if(++attempts===1)throw new Error('save failed');},error=>{reported++;lastError=error;},()=>{lastError=null;});
  assert.equal(await action(),false);
  assert.equal(lastError.message,'save failed');
  assert.equal(await action(),true);
  assert.equal(reported,1);
  assert.equal(lastError,null);
});
