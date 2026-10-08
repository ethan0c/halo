const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('halo', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  capture: () => ipcRenderer.invoke('screen:capture'),
  ask: (req) => ipcRenderer.invoke('claude:ask', req),
  abort: (id) => ipcRenderer.invoke('claude:abort', id),
  requestMic: () => ipcRenderer.invoke('mic:request'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  resize: (height) => ipcRenderer.send('window:resize', height),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  onClaude: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on('claude:event', handler);
    return () => ipcRenderer.removeListener('claude:event', handler);
  },
  onHotkey: (fn) => ipcRenderer.on('hotkey', (_e, data) => fn(data)),
});
