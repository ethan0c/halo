const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureArea', { finish: rect => ipcRenderer.send('capture-area:finish', rect) });
