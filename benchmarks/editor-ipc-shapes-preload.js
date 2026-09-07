const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('v', {
  objects: () => ipcRenderer.invoke('v:objects'),
  string: () => ipcRenderer.invoke('v:string'),
  columns: () => ipcRenderer.invoke('v:columns'),
});
