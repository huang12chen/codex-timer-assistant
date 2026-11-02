'use strict';
// Read-only account synchronization is independent of the task scheduler.
function startQuotaSync({read,onError=()=>{},intervalMs=15000,schedule=setInterval,cancel=clearInterval}) {
  let stopped=false,pending=null;
  function refresh(){
    if(stopped)return Promise.resolve(null);
    if(pending)return pending;
    pending=Promise.resolve().then(read).catch(error=>{onError(error);throw error;}).finally(()=>{pending=null;});
    return pending;
  }
  const timer=schedule(()=>{refresh().catch(()=>{});},intervalMs);timer?.unref?.();
  return {refresh,stop(){if(!stopped){stopped=true;cancel(timer);}}};
}
module.exports={startQuotaSync};
