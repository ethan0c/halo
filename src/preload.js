const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('halo', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  capture: () => ipcRenderer.invoke('screen:capture'),
  ask: (req) => ipcRenderer.invoke('claude:ask', req),
  abort: (id) => ipcRenderer.invoke('claude:abort', id),
  requestMic: () => ipcRenderer.invoke('mic:request'),
  importDocument: () => ipcRenderer.invoke('document:import'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  resize: (height) => ipcRenderer.send('window:resize', height),
  setPreset: (preset) => ipcRenderer.invoke('window:preset', preset),
  focusInput: () => ipcRenderer.send('window:focus-input'),
  releaseFocus: () => ipcRenderer.send('window:release-focus'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  onClaude: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on('claude:event', handler);
    return () => ipcRenderer.removeListener('claude:event', handler);
  },
  onHotkey: (fn) => ipcRenderer.on('hotkey', (_e, data) => fn(data)),
  onTheme: (fn) => ipcRenderer.on('theme', (_e, theme) => fn(theme)),
  onDocked: (fn) => ipcRenderer.on('docked', (_e, spot) => fn(spot)),
  onBackdrop: (fn) => ipcRenderer.on('backdrop', (_e, lum) => fn(lum)),
});
