const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let isVisible = false;

const COLLAPSED_HEIGHT = 72;
const EXPANDED_HEIGHT = 340;
const WINDOW_WIDTH = 460;

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: COLLAPSED_HEIGHT,
    x: Math.floor((width - WINDOW_WIDTH) / 2),
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
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('empty');
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Gemini Assistant');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Toggle (Ctrl+Space)',
      click: () => toggleAssistant(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
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
  mainWindow.setSize(WINDOW_WIDTH, EXPANDED_HEIGHT, true);
}

function collapseWindow() {
  if (!mainWindow) return;
  mainWindow.setSize(WINDOW_WIDTH, COLLAPSED_HEIGHT, true);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  globalShortcut.register('Control+Space', () => {
    toggleAssistant();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on('collapse', () => {
  collapseWindow();
  isVisible = false;
});

ipcMain.on('resize-expanded', () => {
  expandWindow();
});

ipcMain.on('resize-collapsed', () => {
  collapseWindow();
});
