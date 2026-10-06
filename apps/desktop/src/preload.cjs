// Exposed to the store page only (the store window is the only one with this preload).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pwamart', {
  install: (app) => ipcRenderer.invoke('pwamart:install', app),
  installed: () => ipcRenderer.invoke('pwamart:installed'),
  desktop: true,
});
