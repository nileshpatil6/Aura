const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onActivate: (cb) => ipcRenderer.on('activate', cb),
  onDeactivate: (cb) => ipcRenderer.on('deactivate', cb),
  collapse: () => ipcRenderer.send('collapse'),
  resizeExpanded: () => ipcRenderer.send('resize-expanded'),
  resizeCollapsed: () => ipcRenderer.send('resize-collapsed'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
});
