'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('timer', Object.freeze({
  invoke: async (method, payload = null) => {
    const reply = await ipcRenderer.invoke('timer:invoke', { method, payload });
    if (!reply?.ok) throw new Error(reply?.error || '助手操作失败');
    return reply.value;
  },
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('timer:state', listener);
    return () => ipcRenderer.removeListener('timer:state', listener);
  }
}));
