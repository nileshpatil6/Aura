const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window/IPC events
  onActivate:   (cb) => ipcRenderer.on('activate', cb),
  onDeactivate: (cb) => ipcRenderer.on('deactivate', cb),
  onOpenDashboard: (cb) => ipcRenderer.on('open-dashboard', cb),
  collapse:        () => ipcRenderer.send('collapse'),
  debugLog:         (line) => ipcRenderer.send('debug-log', line),
  getLogPath:       () => ipcRenderer.invoke('get-log-path'),
  openLog:          () => ipcRenderer.send('open-log'),
  resizeExpanded:   () => ipcRenderer.send('resize-expanded'),
  resizePill:       (width, height) => ipcRenderer.send('resize-pill', { width, height }),
  sendPillState:     (s)  => ipcRenderer.send('pill-state', s),
  onPillState:       (cb) => ipcRenderer.on('pill-state', (_e, s) => cb(s)),
  setIgnoreMouse:  (v) => ipcRenderer.send('set-ignore-mouse', v),
  openDashboard:     () => ipcRenderer.send('open-dashboard'),
  closeDashboard:    () => ipcRenderer.send('close-dashboard'),
  dashVoiceStart:    () => ipcRenderer.send('dash-voice-start'),
  dashVoiceStop:     () => ipcRenderer.send('dash-voice-stop'),
  pillAutoHide:      () => ipcRenderer.send('pill-autohide'),
  pillShow:          () => ipcRenderer.send('pill-show'),
  onPillPeeking:     (cb) => ipcRenderer.on('pill-peeking', (_e, v) => cb(v)),
  minimizeDashboard: () => ipcRenderer.invoke('minimize-dashboard'),
  maximizeDashboard: () => ipcRenderer.invoke('maximize-dashboard'),

  // Ask Anywhere / region / clips
  openAsk:        () => ipcRenderer.send('open-ask'),
  closeAsk:       () => ipcRenderer.send('close-ask'),
  closeClips:     () => ipcRenderer.send('close-clips'),
  cancelRegion:   () => ipcRenderer.send('cancel-region'),
  captureRegion:  (r) => ipcRenderer.send('capture-region', r),
  onAskContext:   (cb) => ipcRenderer.on('ask-context', cb),

  // Agent Console
  openAgent:         () => ipcRenderer.send('open-agent'),
  openAgentWithGoal: (g) => ipcRenderer.send('open-agent-with-goal', g),
  onAgentSetGoal:    (cb) => ipcRenderer.on('agent-set-goal', cb),
  closeAgent:     () => ipcRenderer.send('close-agent'),
  minimizeAgent:  () => ipcRenderer.invoke('minimize-agent'),
  restoreAgent:   () => ipcRenderer.invoke('restore-agent'),
  agentProgress:  (f) => ipcRenderer.invoke('agent-progress', f),
  setActionMode:  (on) => ipcRenderer.invoke('set-action-mode', on),

  // Vision Memory
  visionStart:   (sec) => ipcRenderer.invoke('vision-start', sec),
  visionStop:    ()    => ipcRenderer.invoke('vision-stop'),
  visionStatus:  ()    => ipcRenderer.invoke('vision-status'),
  visionSearch:  (q)   => ipcRenderer.invoke('vision-search', q),
  visionImage:   (fp)  => ipcRenderer.invoke('vision-image', fp),

  // Screenshots
  takeScreenshot:      () => ipcRenderer.invoke('take-screenshot'),
  takeScreenshotClean: () => ipcRenderer.invoke('take-screenshot-clean'),

  // Automation
  runPowerShell:   (cmd)         => ipcRenderer.invoke('run-powershell', cmd),
  openApp:         (name, url)   => ipcRenderer.invoke('open-app', name, url),
  searchWeb:       (query)       => ipcRenderer.invoke('search-web', query),
  showNotification:(title, msg)  => ipcRenderer.invoke('show-notification', title, msg),
  getSystemInfo:   (type)        => ipcRenderer.invoke('get-system-info', type),
  computerAction:  (params)      => ipcRenderer.invoke('computer-action', params),

  // Extended automation
  readClipboard:  ()      => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (t)     => ipcRenderer.invoke('write-clipboard', t),
  mediaControl:   (a)     => ipcRenderer.invoke('media-control', a),
  setVolume:      (p)     => ipcRenderer.invoke('set-volume', p),
  setBrightness:  (p)     => ipcRenderer.invoke('set-brightness', p),
  focusWindow:    (n)     => ipcRenderer.invoke('focus-window', n),
  minimizeAll:    ()      => ipcRenderer.invoke('minimize-all'),
  closeApp:       (n)     => ipcRenderer.invoke('close-app', n),
  lockScreen:     ()      => ipcRenderer.invoke('lock-screen'),
  sleepPc:        ()      => ipcRenderer.invoke('sleep-pc'),

  // Persistent store
  storeGet:    (bucket, key)        => ipcRenderer.invoke('store-get', bucket, key),
  storeSet:    (bucket, key, value) => ipcRenderer.invoke('store-set', bucket, key, value),
  storePush:   (bucket, item)       => ipcRenderer.invoke('store-push', bucket, item),
  storeRemove: (bucket, id)         => ipcRenderer.invoke('store-remove', bucket, id),
  storeClear:  (bucket)             => ipcRenderer.invoke('store-clear', bucket),
});
