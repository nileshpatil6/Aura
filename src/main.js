const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const automation = require('./automation');
const store = require('./store');

let mainWindow = null;
let tray = null;
let isVisible = false;

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
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Make transparent areas click-through while forwarding events to renderer
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on('closed', () => { mainWindow = null; });
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
    { label: `Toggle (${shortcutLabel})`, click: () => toggleAssistant() },
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('collapse', () => { collapseWindow(); isVisible = false; });
ipcMain.on('resize-expanded', () => expandWindow());
ipcMain.on('resize-collapsed', () => collapseWindow());

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

// Higher-res clean shot for Computer Use (1440x900 is recommended). Hide overlay first.
ipcMain.handle('take-screenshot-clean', async () => {
  const wasVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  if (wasVisible) mainWindow.hide();
  await new Promise(r => setTimeout(r, 180));
  const b64 = await captureScreen(1440, 900);
  if (wasVisible && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  return b64;
});

ipcMain.handle('run-powershell', (_e, command) => automation.runPowerShell(command));
ipcMain.handle('open-app', (_e, name, url) => automation.openApp(name, url));
ipcMain.handle('search-web', (_e, query) => automation.searchWeb(query));
ipcMain.handle('show-notification', (_e, title, message) => automation.showNotification(title, message));
ipcMain.handle('get-system-info', (_e, type) => automation.getSystemInfo(type));

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
