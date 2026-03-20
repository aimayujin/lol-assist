const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { LcuClient } = require('./lcu');

let mainWindow = null;
let lcuClient = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'lolpick.jp',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0a0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 同ディレクトリの index.html を読み込み
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // DevTools (--dev フラグで開く)
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── LCU 接続管理 ──
function startLcu() {
  lcuClient = new LcuClient();

  lcuClient.on('lcu-connected', () => {
    console.log('[Main] LCU 接続完了');
    sendToRenderer('lcu-status', { connected: true });
  });

  lcuClient.on('lcu-disconnected', () => {
    console.log('[Main] LCU 切断');
    sendToRenderer('lcu-status', { connected: false });
  });

  lcuClient.on('champ-select-start', (session) => {
    console.log('[Main] チャンプセレクト開始');
    sendToRenderer('champ-select-update', session);
  });

  lcuClient.on('champ-select-update', (session) => {
    sendToRenderer('champ-select-update', session);
  });

  lcuClient.on('champ-select-end', () => {
    console.log('[Main] チャンプセレクト終了');
    sendToRenderer('champ-select-end', {});
  });

  lcuClient.on('gameflow-phase', (phase) => {
    sendToRenderer('gameflow-phase', phase);
  });

  lcuClient.start();
}

// ── IPC ハンドラ ──
ipcMain.handle('get-lcu-status', () => {
  return { connected: lcuClient?.isConnected() ?? false };
});

ipcMain.handle('get-champ-select', async () => {
  if (!lcuClient?.isConnected()) return null;
  return lcuClient.getChampSelectSession();
});

// ── App Lifecycle ──
app.whenReady().then(() => {
  createWindow();
  startLcu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (lcuClient) lcuClient.stop();
  if (process.platform !== 'darwin') app.quit();
});
