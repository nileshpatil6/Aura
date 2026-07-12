const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, nativeImage, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const automation = require('./automation');
const store = require('./store');
const visionMemory = require('./vision-memory');

let mainWindow = null;
let dashboardWindow = null;
let askWindow = null;
let regionWindow = null;
let clipsWindow = null;
let agentWindow = null;
let tray = null;
let isVisible = false;
let actionModeHidden = [];  // windows we hid during action mode

const COLLAPSED_W = 88;
const COLLAPSED_H = 56;
const EXPANDED_W  = 380;
const EXPANDED_H  = 360;

function getCenter(w) {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  return Math.floor((width - w) / 2);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: COLLAPSED_W,
    height: COLLAPSED_H,
    x: getCenter(COLLAPSED_W),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: true,
    show: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Always open DevTools when run via `npm start` (no app.isPackaged === unpacked dev)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Make transparent areas click-through while forwarding events to renderer
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1280, width - 80);
  const h = Math.min(820, height - 80);
  dashboardWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.floor((width - w) / 2),
    y: Math.floor((height - h) / 2),
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    show: true,
    backgroundColor: '#050811',
    title: 'Aura · Command Center',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  dashboardWindow.focus();
}

// ───── Ask Anywhere ─────────────────────────────────────────────────────────
function openAsk(context) {
  if (askWindow && !askWindow.isDestroyed()) { askWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  askWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.floor((width - 800) / 2),
    y: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  askWindow.loadFile(path.join(__dirname, 'renderer', 'ask.html'));
  askWindow.show();
  askWindow.focus();
  if (context) {
    askWindow.webContents.once('did-finish-load', () => {
      askWindow.webContents.send('ask-context', context);
    });
  }
  askWindow.on('blur', () => askWindow && !askWindow.isDestroyed() && askWindow.close());
  askWindow.on('closed', () => { askWindow = null; });
}

// ───── Region Screenshot ────────────────────────────────────────────────────
function openRegionSelector() {
  if (regionWindow && !regionWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  regionWindow = new BrowserWindow({
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.bounds.width,
    height: primary.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreen: false,
    movable: false,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  regionWindow.setAlwaysOnTop(true, 'screen-saver');
  regionWindow.loadFile(path.join(__dirname, 'renderer', 'region.html'));
  regionWindow.on('closed', () => { regionWindow = null; });
}

async function captureRegion(rect) {
  if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();
  await new Promise(r => setTimeout(r, 220));
  const primary = screen.getPrimaryDisplay();
  const sf = primary.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.bounds.width * sf),
      height: Math.round(primary.bounds.height * sf),
    },
  });
  if (!sources.length) return;
  const fullImg = sources[0].thumbnail;
  // Crop the requested rect (rect coords are in logical pixels)
  const cropped = fullImg.crop({
    x: Math.round(rect.x * sf),
    y: Math.round(rect.y * sf),
    width: Math.round(rect.width * sf),
    height: Math.round(rect.height * sf),
  });
  const b64 = cropped.toJPEG(85).toString('base64');
  openAsk({ mode: 'image', imageB64: b64 });
}

// ───── Clipboard History ────────────────────────────────────────────────────
function openClips() {
  if (clipsWindow && !clipsWindow.isDestroyed()) { clipsWindow.focus(); return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  clipsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    x: Math.floor((width - 500) / 2),
    y: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  clipsWindow.loadFile(path.join(__dirname, 'renderer', 'clips.html'));
  clipsWindow.show();
  clipsWindow.focus();
  clipsWindow.on('blur', () => clipsWindow && !clipsWindow.isDestroyed() && clipsWindow.close());
  clipsWindow.on('closed', () => { clipsWindow = null; });
}

// Background clipboard monitor: capture text changes, store with AI labels (cheap heuristic)
let lastClip = '';
function startClipboardWatcher() {
  setInterval(() => {
    try {
      const txt = clipboard.readText();
      if (!txt || txt === lastClip || txt.length > 5000) return;
      lastClip = txt;
      const label = quickLabel(txt);
      const clips = store.get('clipboard_history') || [];
      // Dedupe with previous if same
      if (clips.length && clips[clips.length - 1].text === txt) return;
      clips.push({ ts: Date.now(), text: txt, label });
      if (clips.length > 30) clips.splice(0, clips.length - 30);
      store.set('clipboard_history', clips);
    } catch {}
  }, 1500);
}
// ───── Agent Console ────────────────────────────────────────────────────────
function openAgentWithGoal(goal) {
  openAgent();
  // Wait for ready then send goal
  const send = () => agentWindow?.webContents.send('agent-set-goal', goal);
  if (agentWindow?.webContents.isLoading()) {
    agentWindow.webContents.once('did-finish-load', send);
  } else {
    setTimeout(send, 80);
  }
}

function openAgent() {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (agentWindow.isMinimized()) agentWindow.restore();
    agentWindow.show();
    agentWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1180, width - 80);
  const h = Math.min(740, height - 80);
  agentWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.floor((width - w) / 2),
    y: Math.max(40, Math.floor((height - h) / 2)),
    frame: false,
    show: true,
    backgroundColor: '#050811',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  agentWindow.loadFile(path.join(__dirname, 'renderer', 'agent.html'));
  agentWindow.on('closed', () => { agentWindow = null; });
  agentWindow.focus();
}

function quickLabel(t) {
  if (/^https?:\/\//.test(t)) return 'URL';
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(t.trim())) return 'Email';
  if (/^\+?[\d\s()-]{7,}$/.test(t.trim())) return 'Phone';
  if (/^[\d.]+$/.test(t.trim())) return 'Number';
  if (/^[A-Fa-f0-9]{6,8}$/.test(t.trim()) || /^#[A-Fa-f0-9]{3,8}$/.test(t.trim())) return 'Color';
  if (t.split('\n').length > 3) return 'Multi-line text';
  if (/(function|const|let|var|class|def |import |return)/.test(t) && t.length > 30) return 'Code';
  if (t.length < 60) return 'Snippet';
  return 'Text';
}

function createTray(shortcutLabel) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('empty');
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(`Aura (${shortcutLabel})`);

  const contextMenu = Menu.buildFromTemplate([
    { label: `Toggle Aura (${shortcutLabel})`, click: () => toggleAssistant() },
    { type: 'separator' },
    { label: '🤖  Agent Console (Ctrl+Shift+Q)', click: () => openAgent() },
    { label: '💬  Ask Aura (Ctrl+Shift+A)', click: () => openAsk() },
    { label: '📸  Region screenshot (Ctrl+Shift+S)', click: () => openRegionSelector() },
    { label: '📋  Clipboard history (Ctrl+Shift+V)', click: () => openClips() },
    { type: 'separator' },
    { label: '⌘  Command Center', click: () => createDashboard() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => toggleAssistant());
}

function toggleAssistant() {
  if (!mainWindow) return;
  if (isVisible) {
    mainWindow.webContents.send('deactivate');
    collapseWindow();
    isVisible = false;
  } else {
    expandWindow();
    mainWindow.focus();
    mainWindow.webContents.send('activate');
    isVisible = true;
  }
}

function expandWindow() {
  if (!mainWindow) return;
  mainWindow.setBounds({ x: getCenter(EXPANDED_W), y: 0, width: EXPANDED_W, height: EXPANDED_H }, true);
}

function collapseWindow() {
  if (!mainWindow) return;
  mainWindow.setBounds({ x: getCenter(COLLAPSED_W), y: 0, width: COLLAPSED_W, height: COLLAPSED_H }, true);
}

// ── Auto-hide pill at top edge ────────────────────────────────────────────────
let isPillHidden    = false;
let cursorPollTimer = null;

function hidePillEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || isPillHidden) return;
  isPillHidden = true;
  // Slide pill up: only 5px visible at top
  mainWindow.setBounds({ x: getCenter(COLLAPSED_W), y: -(COLLAPSED_H - 5), width: COLLAPSED_W, height: COLLAPSED_H }, true);
  // Poll cursor position so we can peek-show when user reaches top
  if (!cursorPollTimer) {
    const pillX = getCenter(COLLAPSED_W);
    cursorPollTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { stopCursorPoll(); return; }
      const { x, y } = screen.getCursorScreenPoint();
      const overPill = x >= pillX - 20 && x <= pillX + COLLAPSED_W + 20;
      if (y <= 5 && overPill) {
        mainWindow.setBounds({ x: pillX, y: 0, width: COLLAPSED_W, height: COLLAPSED_H }, false);
        mainWindow.webContents.send('pill-peeking', true);
      } else if ((y > 70 || !overPill) && isPillHidden) {
        mainWindow.setBounds({ x: pillX, y: -(COLLAPSED_H - 5), width: COLLAPSED_W, height: COLLAPSED_H }, false);
        mainWindow.webContents.send('pill-peeking', false);
      }
    }, 80);
  }
}

function showPillEdge() {
  stopCursorPoll();
  if (!isPillHidden) return;  // already visible, do nothing
  isPillHidden = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds({ x: getCenter(COLLAPSED_W), y: 0, width: COLLAPSED_W, height: COLLAPSED_H }, true);
  mainWindow.webContents.send('pill-peeking', false);
}

function stopCursorPoll() {
  if (cursorPollTimer) { clearInterval(cursorPollTimer); cursorPollTimer = null; }
}

// Single-instance lock — second launch focuses the running app instead of starting a new copy
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Surface the dashboard if not visible, otherwise toggle the pill
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      dashboardWindow.show();
      dashboardWindow.focus();
    } else {
      createDashboard();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  const shortcuts = ['Alt+Space', 'Control+Shift+Space', 'Control+Space'];
  let registered = false;
  for (const sc of shortcuts) {
    if (globalShortcut.register(sc, () => toggleAssistant())) {
      console.log('Shortcut registered:', sc);
      registered = sc;
      break;
    }
  }
  if (!registered) console.error('Failed to register any shortcut');

  createTray(registered || 'click tray icon');

  // Power-user global hotkeys
  globalShortcut.register('Control+Shift+A', () => openAsk());
  globalShortcut.register('Control+Shift+S', () => openRegionSelector());
  globalShortcut.register('Control+Shift+V', () => openClips());
  globalShortcut.register('Control+Shift+Q', () => openAgent());

  // Auto-start vision memory if user enabled it previously
  const visionPref = store.get('settings', 'visionMemoryEnabled');
  if (visionPref) visionMemory.start(store.get('settings', 'visionMemoryInterval') || 90);
  globalShortcut.register('Control+Shift+E', async () => {
    // "Ask about selection" — simulate Ctrl+C to grab selection, then open ask with it
    const before = clipboard.readText();
    await automation.runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')`);
    await new Promise(r => setTimeout(r, 220));
    const after = clipboard.readText();
    if (after && after.length > 0) {
      openAsk({ mode: 'selection', text: after });
    } else {
      openAsk();
    }
  });

  startClipboardWatcher();

  // First-run welcome: open dashboard so users see the actual interface
  const isFirstRun = !store.get('settings', 'launchedOnce');
  if (isFirstRun) {
    store.set('settings', 'launchedOnce', true);
    setTimeout(() => createDashboard(), 600);
  } else {
    // Subsequent launches: show tray balloon notification (Windows only)
    try {
      tray?.displayBalloon?.({
        title: 'Aura is running',
        content: `Click the pill at top of screen, press ${registered || 'Alt+Space'} to talk, or Ctrl+Shift+Q for Agent mode.`,
      });
    } catch {}
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { visionMemory.stop(); } catch {}
  exitActionMode();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('collapse', () => { collapseWindow(); isVisible = false; });
ipcMain.on('resize-expanded', () => expandWindow());
ipcMain.on('resize-collapsed', () => collapseWindow());

ipcMain.on('open-dashboard',  () => createDashboard());
ipcMain.on('close-dashboard', () => dashboardWindow && dashboardWindow.close());
ipcMain.on('dash-voice-start', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('activate'); });
ipcMain.on('dash-voice-stop',  () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('deactivate'); });
ipcMain.on('pill-autohide',    () => hidePillEdge());
ipcMain.on('pill-show',        () => showPillEdge());
ipcMain.on('pill-state',       (_e, s) => { if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pill-state', s); });
ipcMain.on('open-ask',        () => openAsk());
ipcMain.on('close-ask',       () => askWindow && askWindow.close());
ipcMain.on('close-clips',     () => clipsWindow && clipsWindow.close());
ipcMain.on('cancel-region',   () => regionWindow && regionWindow.close());
ipcMain.on('capture-region',  (_e, rect) => captureRegion(rect));
ipcMain.on('open-agent',          () => openAgent());
ipcMain.on('open-agent-with-goal', (_e, goal) => openAgentWithGoal(goal));
ipcMain.on('close-agent',     () => agentWindow && agentWindow.close());
ipcMain.handle('minimize-agent', () => agentWindow && agentWindow.minimize());

// Vision Memory IPC
ipcMain.handle('vision-start',  (_e, sec) => { visionMemory.start(sec || 90); return true; });
ipcMain.handle('vision-stop',   () => { visionMemory.stop(); return true; });
ipcMain.handle('vision-status', () => ({ enabled: visionMemory.isEnabled() }));
ipcMain.handle('vision-search', (_e, q) => visionMemory.search(q));
ipcMain.handle('vision-image',  (_e, fp) => visionMemory.readImageB64(fp));
ipcMain.handle('minimize-dashboard', () => dashboardWindow && dashboardWindow.minimize());
ipcMain.handle('maximize-dashboard', () => {
  if (!dashboardWindow) return;
  dashboardWindow.isMaximized() ? dashboardWindow.unmaximize() : dashboardWindow.maximize();
});

// Toggle click-through: transparent areas pass clicks to windows below
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true });
});

async function captureScreen(w = 1280, h = 720) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  });
  if (!sources.length) return null;
  return sources[0].thumbnail.toJPEG(82).toString('base64');
}

ipcMain.handle('take-screenshot', () => captureScreen(1280, 720));

// Aura windows we can fully hide for clean screenshots / unobstructed clicks.
// Agent window is excluded here — we minimize it separately so its JS keeps running.
function hideableAuraWindows() {
  return [mainWindow, dashboardWindow, askWindow, clipsWindow, regionWindow]
    .filter(w => w && !w.isDestroyed());
}
function allAuraWindows() {
  const list = hideableAuraWindows();
  if (agentWindow && !agentWindow.isDestroyed()) list.push(agentWindow);
  return list;
}
function enterActionMode() {
  if (actionModeHidden.length) return;
  actionModeHidden = hideableAuraWindows().filter(w => w.isVisible());
  actionModeHidden.forEach(w => w.hide());
  // Minimize agent separately so user sees their actual screen
  if (agentWindow && !agentWindow.isDestroyed() && agentWindow.isVisible()) {
    agentWindow.minimize();
  }
}
function exitActionMode() {
  actionModeHidden.forEach(w => { try { w.show(); } catch {} });
  actionModeHidden = [];
}

// Higher-res clean shot for Computer Use. Hide visible (non-minimized) Aura overlays first.
ipcMain.handle('take-screenshot-clean', async () => {
  const toRestore = allAuraWindows()
    .filter(w => w.isVisible() && !w.isMinimized());
  toRestore.forEach(w => w.hide());
  await new Promise(r => setTimeout(r, 220));
  const b64 = await captureScreen(1440, 900);
  toRestore.forEach(w => { try { w.show(); } catch {} });
  return b64;
});

ipcMain.handle('set-action-mode', (_e, on) => { on ? enterActionMode() : exitActionMode(); });
ipcMain.handle('agent-progress', (_e, fraction) => {
  if (agentWindow && !agentWindow.isDestroyed()) agentWindow.setProgressBar(fraction);
});
ipcMain.handle('restore-agent', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (agentWindow.isMinimized()) agentWindow.restore();
    agentWindow.show();
    agentWindow.focus();
    try { agentWindow.setProgressBar(-1); } catch {}
  }
});

ipcMain.handle('run-powershell', (_e, command) => automation.runPowerShell(command));
ipcMain.handle('open-app', (_e, name, url) => automation.openApp(name, url));
ipcMain.handle('search-web', (_e, query) => automation.searchWeb(query));
ipcMain.handle('show-notification', (_e, title, message) => automation.showNotification(title, message));
ipcMain.handle('get-system-info', (_e, type) => automation.getSystemInfo(type));

// Power & media IPC
ipcMain.handle('read-clipboard',  () => automation.readClipboard());
ipcMain.handle('write-clipboard', (_e, t) => automation.writeClipboard(t));
ipcMain.handle('media-control',   (_e, a) => automation.mediaControl(a));
ipcMain.handle('set-volume',      (_e, p) => automation.setVolume(p));
ipcMain.handle('set-brightness',  (_e, p) => automation.setBrightness(p));
ipcMain.handle('focus-window',    (_e, n) => automation.focusWindow(n));
ipcMain.handle('minimize-all',    () => automation.minimizeAll());
ipcMain.handle('close-app',       (_e, n) => automation.closeApp(n));
ipcMain.handle('lock-screen',     () => automation.lockScreen());
ipcMain.handle('sleep-pc',        () => automation.sleepPc());

// Store IPC
ipcMain.handle('store-get',    (_e, bucket, key)        => store.get(bucket, key));
ipcMain.handle('store-set',    (_e, bucket, key, value) => store.set(bucket, key, value));
ipcMain.handle('store-push',   (_e, bucket, item)       => store.push(bucket, item));
ipcMain.handle('store-remove', (_e, bucket, id)         => store.remove(bucket, id));
ipcMain.handle('store-clear',  (_e, bucket)             => store.clear(bucket));

ipcMain.handle('computer-action', (_e, params) => {
  const display = screen.getPrimaryDisplay();
  const physW = display.bounds.width * display.scaleFactor;
  const physH = display.bounds.height * display.scaleFactor;
  const scaleX = physW / 1280;
  const scaleY = physH / 720;
  return automation.computerAction({ ...params, physW, physH, scaleX, scaleY });
});
