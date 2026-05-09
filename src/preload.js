const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onActivate: (cb) => ipcRenderer.on('activate', cb),
  onDeactivate: (cb) => ipcRenderer.on('deactivate', cb),
  collapse: () => ipcRenderer.send('collapse'),
  resizeExpanded: () => ipcRenderer.send('resize-expanded'),
  resizeCollapsed: () => ipcRenderer.send('resize-collapsed'),
  setIgnoreMouse: (v) => ipcRenderer.send('set-ignore-mouse', v),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  runPowerShell: (cmd) => ipcRenderer.invoke('run-powershell', cmd),
  openApp: (name, url) => ipcRenderer.invoke('open-app', name, url),
  searchWeb: (query) => ipcRenderer.invoke('search-web', query),
  showNotification: (title, msg) => ipcRenderer.invoke('show-notification', title, msg),
  getSystemInfo: (type) => ipcRenderer.invoke('get-system-info', type),
  computerAction: (params) => ipcRenderer.invoke('computer-action', params),
});
