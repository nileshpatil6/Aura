const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, nativeImage, desktopCapturer, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const automation = require('./automation');
const store = require('./store');
const visionMemory = require('./vision-memory');
const uia = require('./uia');
const { jevCall } = require('./jev');
const { buildJevRequest, interpretJevAnswers, snapshotSignature } = require('./jev-step');
const { resolveJevKey } = require('./env-keys');

let mainWindow = null;
let dashboardWindow = null;
let askWindow = null;
let regionWindow = null;
let clipsWindow = null;
let agentWindow = null;
let tray = null;
let isVisible = false;
let actionModeHidden = [];  // windows we hid during action mode
let lastSnapshot = null;    // full UiaSnapshot (with elements) from the most recent uia-snapshot call

const COLLAPSED_W  = 96;  // initial guess only — renderer reports its real size once painted
const COLLAPSED_H  = 56;
const EXPANDED_W   = 380;
const EXPANDED_H   = 360;

// The pill's true width is whatever its own content measures out to, reported
// live by the renderer via the 'resize-pill' IPC. This replaces a history of
// hardcoded pixel constants that drifted out of sync with the actual markup
// every time a button or waveform was added, clipping the pill. Main.js never
// guesses layout again — it just paints whatever width the DOM says it needs.
let currentPillW = COLLAPSED_W;
let currentPillH = COLLAPSED_H;

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
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // DevTools only when explicitly requested — auto-opening stole focus and
  // repositioned the pill on every launch (looked like a random-move glitch).
  if (!app.isPackaged && process.env.AURA_DEVTOOLS) {
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
    // Only matters for `npm start` — the packaged .exe already carries
    // assets/icon.ico as its resource icon via build.win.icon.
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
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
      webSecurity: true,
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
      webSecurity: true,
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
  mainWindow.setBounds({ x: getCenter(currentPillW), y: 0, width: currentPillW, height: currentPillH }, true);
}

// The renderer measures its own real content size (getBoundingClientRect on
// #pill, after layout settles) and reports it here. This is the single
// source of truth for pill dimensions — no more guessed pixel constants.
function setPillSize(w, h) {
  currentPillW = Math.max(1, Math.ceil(w));
  currentPillH = Math.max(1, Math.ceil(h));
  if (!mainWindow || mainWindow.isDestroyed() || isPillHidden) return;
  mainWindow.setBounds({ x: getCenter(currentPillW), y: 0, width: currentPillW, height: currentPillH }, true);
}

// ── Auto-hide pill at top edge ────────────────────────────────────────────────
let isPillHidden    = false;
let cursorPollTimer = null;

function hidePillEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || isPillHidden) return;
  isPillHidden = true;
  mainWindow.setBounds({ x: getCenter(currentPillW), y: -(currentPillH - 5), width: currentPillW, height: currentPillH }, true);
  if (!cursorPollTimer) {
    let peeking = false;
    cursorPollTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { stopCursorPoll(); return; }
      const pillX = getCenter(currentPillW);
      const { x, y } = screen.getCursorScreenPoint();
      const overPill = x >= pillX - 20 && x <= pillX + currentPillW + 20;
      if (y <= 12 && overPill) {
        if (!peeking) {
          peeking = true;
          mainWindow.setBounds({ x: pillX, y: 0, width: currentPillW, height: currentPillH }, false);
          // Make pill interactive so user can click the peek-bar
          mainWindow.setIgnoreMouseEvents(false);
          mainWindow.webContents.send('pill-peeking', true);
        }
      } else if (peeking && (y > 80 || !overPill)) {
        peeking = false;
        mainWindow.setBounds({ x: pillX, y: -(currentPillH - 5), width: currentPillW, height: currentPillH }, false);
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
        mainWindow.webContents.send('pill-peeking', false);
      }
    }, 80);
  }
}

function showPillEdge() {
  stopCursorPoll();
  if (!isPillHidden) return;
  isPillHidden = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds({ x: getCenter(currentPillW), y: 0, width: currentPillW, height: currentPillH }, true);
  // Restore normal click-through behaviour (renderer's mousemove controls this)
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
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
    // Always bring the pill back to its default visible position first —
    // this is the "interface" the user expects to see on manual relaunch.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      stopCursorPoll();
      isPillHidden = false;
      mainWindow.setBounds({ x: getCenter(currentPillW), y: 0, width: currentPillW, height: currentPillH }, true);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      if (!mainWindow.isVisible()) mainWindow.show();
    }

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
  // app.quit() above is asynchronous, so a second instance that LOST the
  // single-instance lock still reaches this callback. Without this guard it
  // creates a window, grabs a fallback hotkey (which is why a duplicate launch
  // logged "Control+Shift+Space" instead of "Alt+Space"), and fights the real
  // instance over the userData cache — visible as "Unable to move the cache:
  // Access is denied" and a second pill on screen.
  if (!gotLock) return;

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

  const cfg = jevConfig();
  if (cfg.enabled) uia.uiaWarm();
  debugLog(`jev key source=${cfg.source || 'none'} enabled=${cfg.enabled}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { visionMemory.stop(); } catch {}
  try { automation.shutdownAutomation(); } catch {}
  try { uia.shutdownUia(); } catch {}
  exitActionMode();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('collapse', () => { collapseWindow(); isVisible = false; });
ipcMain.on('resize-expanded', () => expandWindow());
// Renderer reports its own measured pill size — see setPillSize() for why.
ipcMain.on('resize-pill', (_e, { width, height }) => setPillSize(width, height));

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
// While pill is edge-hidden, the cursor poll owns setIgnoreMouseEvents — skip renderer requests
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (isPillHidden) return;
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

// Screenshot sized for the computer-use model. Two things matter here:
//  1. Aspect ratio must match the real display, or the model reasons about a
//     stretched image (the old fixed 1440x900 is 16:10 on a 16:9 panel).
//  2. Payload size dominates request latency. Measured against the live API:
//     1440px wide -> 3.0s median with an 86s outlier; 1024px -> 0.9s median and
//     no outliers. Bigger images did not measurably improve targeting.
const CU_CAPTURE_WIDTH = 1024;
function cuCaptureSize() {
  const b = screen.getPrimaryDisplay().bounds;
  const w = CU_CAPTURE_WIDTH;
  return { width: w, height: Math.round(w * (b.height / b.width)) };
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

// Resolved lazily on every jev-status/jev-decide call (cheap — env-keys.js
// caches the .env read) so a settings edit takes effect without a restart.
function jevConfig() {
  const settingsKey = store.get('settings', 'jevApiKey');
  const { key, source } = resolveJevKey({
    settingsKey,
    searchDirs: [...new Set([app.getAppPath(), process.cwd()])],
  });
  const enabled = store.get('settings', 'jevEnabled') !== false &&
    process.env.AURA_JEV !== '0' && !!key && process.platform === 'win32';
  return { enabled, key, source };
}

// Physical-pixel rects of every visible, non-minimized Aura window, so the
// UIA host can exclude our own pill/dashboard/agent windows from clicks.
function auraPhysicalRects() {
  return allAuraWindows()
    .filter(w => w.isVisible() && !w.isMinimized())
    .map((win) => {
      const r = screen.dipToScreenRect(win, win.getBounds());
      return [r.x, r.y, r.width, r.height];
    });
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

// Clean shot for Computer Use. Hide visible (non-minimized) Aura overlays first.
ipcMain.handle('take-screenshot-clean', async () => {
  const toRestore = allAuraWindows()
    .filter(w => w.isVisible() && !w.isMinimized());
  toRestore.forEach(w => w.hide());
  await new Promise(r => setTimeout(r, 120));
  const { width, height } = cuCaptureSize();
  const b64 = await captureScreen(width, height);
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

// ── Debug log ────────────────────────────────────────────────────────────────
// Renderer processes have no console the user can see (DevTools is opt-in), so
// diagnostics go to a file: %APPDATA%/aura/aura-debug.log. Truncated on launch
// so each session starts clean.
const DEBUG_LOG = path.join(app.getPath('userData'), 'aura-debug.log');
try { fs.writeFileSync(DEBUG_LOG, `=== Aura session ${new Date().toISOString()} ===\n`); } catch {}

function debugLog(line) {
  const stamp = new Date().toISOString().slice(11, 23);
  const text = `[${stamp}] ${line}\n`;
  try { fs.appendFileSync(DEBUG_LOG, text); } catch {}
  process.stdout.write(text);
}
ipcMain.on('debug-log', (_e, line) => debugLog(line));
ipcMain.handle('get-log-path', () => DEBUG_LOG);
ipcMain.on('open-log', () => { try { shell.showItemInFolder(DEBUG_LOG); } catch {} });

// Store IPC
// 'settings' gets special handling so the Jev key (I2) never crosses into a
// renderer, whether read directly or as part of the whole bucket the
// dashboard's Settings tab fetches — and so that tab's "save" (which writes
// back a plain object of the fields IT knows about) doesn't silently wipe a
// jevApiKey/jevEnabled it never saw.
ipcMain.handle('store-get', (_e, bucket, key) => {
  if (bucket === 'settings') {
    if (key === 'jevApiKey') return '';
    if (key === undefined) {
      const { jevApiKey, ...safe } = store.get('settings') || {};
      return safe;
    }
  }
  return store.get(bucket, key);
});
ipcMain.handle('store-set', (_e, bucket, key, value) => {
  if (bucket === 'settings' && value === undefined && key && typeof key === 'object') {
    const existing = store.get('settings') || {};
    const merged = { ...key };
    if (!('jevApiKey' in merged)) merged.jevApiKey = existing.jevApiKey || '';
    if (!('jevEnabled' in merged)) merged.jevEnabled = existing.jevEnabled !== false;
    return store.set(bucket, merged);
  }
  return store.set(bucket, key, value);
});
ipcMain.handle('store-push',   (_e, bucket, item)       => store.push(bucket, item));
ipcMain.handle('store-remove', (_e, bucket, id)         => store.remove(bucket, id));
ipcMain.handle('store-clear',  (_e, bucket)             => store.clear(bucket));

ipcMain.handle('computer-action', (_e, params) => {
  const display = screen.getPrimaryDisplay();
  // Use LOGICAL bounds, not physical pixels. The PowerShell helper that calls
  // SetCursorPos is not DPI-aware, so Windows virtualizes its coordinates into
  // logical space. Passing physical pixels (bounds * scaleFactor) overshot by
  // exactly the scale factor — on a 1920x1080 panel at 125% (1536x864 logical)
  // a "click the centre" landed 192px right and 108px low, and anything past
  // ~80% of the width fell off-screen entirely.
  const physW = display.bounds.width;
  const physH = display.bounds.height;
  const scaleX = physW / 1280;
  const scaleY = physH / 720;
  return automation.computerAction({ ...params, physW, physH, scaleX, scaleY });
});

// ── Jev / UIA ────────────────────────────────────────────────────────────
ipcMain.handle('jev-status', () => {
  const cfg = jevConfig();
  return { enabled: cfg.enabled, hasKey: !!cfg.key, source: cfg.source };
});

ipcMain.handle('uia-snapshot', async () => {
  const auraRects = auraPhysicalRects();
  let snap = await uia.uiaSnapshot({ excludePid: process.pid, auraRects, maxElements: 200 });
  // A sentinel collision (host text containing the raw stdout sentinel) or
  // any other malformed-but-"ok" host response could hand back a snapshot
  // with no elements array; guard instead of throwing inside an IPC handler
  // (I3 — handlers must always resolve).
  if (snap && snap.ok && !Array.isArray(snap.elements)) {
    snap = { ok: false, reason: 'error', detail: 'malformed snapshot' };
  }
  if (snap.ok) {
    snap.sig = snapshotSignature(snap);
    lastSnapshot = snap;
    debugLog(`[uia] ${snap.process} "${(snap.title || '').slice(0, 40)}" elems=${snap.elements.length}/${snap.total} host=${snap.ms}ms`);
  } else {
    lastSnapshot = null;
    debugLog(`[uia] FAIL ${snap.reason}${snap.detail ? ' ' + snap.detail : ''}`);
  }
  return snap;
});

ipcMain.handle('uia-act', async (_e, params) => {
  const { snapshotId, elementId, op, text, direction, key } = params || {};
  if (!lastSnapshot || snapshotId !== lastSnapshot.snapshotId) {
    return { ok: false, reason: 'stale_snapshot' };
  }
  const el = elementId ? lastSnapshot.elements.find(e => e.id === elementId) : null;
  let result;
  const t0 = Date.now();

  if (op === 'click' || op === 'scroll') {
    if (op === 'click' && !el) {
      result = { ok: false, reason: 'stale_element' };
    } else {
      result = await uia.uiaAct({ snapshotId, index: el ? el.i : undefined, op, direction });
    }
  } else if (op === 'type') {
    if (!el) {
      result = { ok: false, reason: 'stale_element' };
    } else {
      const canSetValue = Array.isArray(el.pats) && el.pats.includes('value') && !el.readOnly &&
        (el.type === 'Edit' || el.type === 'ComboBox') && lastSnapshot.fw !== 'Chrome';
      let handled = false;
      if (canSetValue) {
        // Sub-op timeouts capped well below the renderer's 8000ms uiaAct
        // budget: set_value(2000) + focus(2000) + two SendKeys calls + the
        // 300ms settle below must all fit inside it, or the renderer's own
        // withTimeout fires while this handler is still mid-flight and a
        // later SendKeys call can land on whatever window is foreground by then.
        const svRes = await uia.uiaAct({ snapshotId, index: el.i, op: 'set_value', text, timeoutMs: 2000 });
        if (svRes.reason === 'timeout') {
          // Outcome unknown, not failed — and the host may have just been
          // killed/regenerated for this, so don't chase it with focus/SendKeys
          // against what could now be a stale generation.
          result = svRes; handled = true;
        } else if (svRes.ok && svRes.verified) {
          result = svRes; handled = true;
        }
      }
      if (!handled) {
        const focusRes = await uia.uiaAct({ snapshotId, index: el.i, op: 'focus', timeoutMs: 2000 });
        if (!focusRes.ok && !el.focused) {
          result = focusRes;
        } else {
          let ok = true;
          if (el.type === 'Edit' || el.type === 'ComboBox') {
            const ctrlARes = await automation.computerAction({ action: 'key', key: 'ctrl+a' });
            if (!ctrlARes || !ctrlARes.success) ok = false;
          }
          // Past the budget the renderer may already have moved on; typing now could hit another window.
          if (!ok || Date.now() - t0 > 5000) {
            result = { ok: false, reason: ok ? 'timeout' : 'error', detail: 'skipped typing', ms: Date.now() - t0 };
          } else {
            const typeRes = await automation.computerAction({ action: 'type', text: text || '' });
            if (!typeRes || !typeRes.success) ok = false;
          }
          if (!result) result = ok
            ? { ok: true, method: 'sendkeys', ms: Date.now() - t0 }
            : { ok: false, reason: 'error', detail: 'sendkeys failed', ms: Date.now() - t0 };
        }
      }
    }
  } else if (op === 'key') {
    const keyRes = await automation.computerAction({ action: 'key', key });
    result = (keyRes && keyRes.success)
      ? { ok: true, method: 'key', ms: Date.now() - t0 }
      : { ok: false, reason: 'error', detail: 'key action failed', ms: Date.now() - t0 };
  } else {
    result = { ok: false, reason: 'unsupported' };
  }

  // Patterns return before the UI repaints — settle here so the NEXT snapshot's
  // no-effect detection compares against post-action state, not mid-transition.
  await new Promise(r => setTimeout(r, 300));
  return result;
});

ipcMain.handle('jev-decide', async (_e, params) => {
  const cfg = jevConfig();
  if (!cfg.enabled) return { ok: false, error: 'disabled' };

  const { snapshotId, goal, history, excludeKeys, executedCount } = params || {};
  if (!lastSnapshot || snapshotId !== lastSnapshot.snapshotId) {
    return { ok: false, error: 'stale_snapshot' };
  }

  const ctx = { goal, history: history || [], excludeKeys: excludeKeys || [], executedCount: executedCount || 0 };
  const built = buildJevRequest(lastSnapshot, ctx);
  const r = await jevCall({ key: cfg.key, state: built.state, questions: built.questions, timeoutMs: 4000 });
  if (!r.ok) return { ok: false, error: r.error, status: r.status, ms: r.ms };

  const decision = interpretJevAnswers(r.answers, built, ctx);
  const top2Str = (decision.top2 || []).map(([k, p]) => `${k}:${p.toFixed(2)}`).join(',');
  debugLog(`[jev] s=${snapshotId} elems=${lastSnapshot.elements.length}/${lastSnapshot.total} tok~${built.approxTokens} ` +
    `choice=${decision.choice} conf=${decision.conf.toFixed(2)} goal=${decision.goal.toFixed(2)} stuck=${decision.stuck.toFixed(2)} ` +
    `top2=${top2Str} ${r.ms}ms -> ${decision.kind}${decision.op ? '/' + decision.op : ''}${decision.reason ? '/' + decision.reason : ''} ${decision.target || ''}`);

  return { ...decision, ms: r.ms, usage: r.usage };
});
