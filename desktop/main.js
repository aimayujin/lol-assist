const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { LcuClient } = require('./lcu');

let mainWindow = null;
let lcuClient = null;
let gPendingReload = false;

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

  // ホットアップデート版があればそちらを優先ロード
  const hotHtmlPath = path.join(app.getPath('userData'), 'hot-update', 'index.html');
  if (fs.existsSync(hotHtmlPath)) {
    console.log('[Boot] ホットアップデート版 index.html をロード');
    mainWindow.loadFile(hotHtmlPath);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }

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
    // 保留中のリロードがあれば実行
    if (gPendingReload) {
      gPendingReload = false;
      console.log('[Update] 保留中のリロードを実行');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      }, 2000); // チャンプセレクト終了の処理が完了してから
    }
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

ipcMain.handle('get-team-ranks', async (_, session) => {
  if (!lcuClient?.isConnected()) return null;
  return lcuClient.getTeamRanks(session);
});

ipcMain.handle('get-team-match-history', async (_, session, count) => {
  if (!lcuClient?.isConnected()) return null;
  return lcuClient.getTeamMatchHistory(session, count || 10);
});

// ── データ自動アップデート ──
const SITE_BASE = 'https://lolpick.jp';
const DATA_FILES = [
  'src/data/winrate_cache.json',
  'src/data/overallwinrate_cache.json',
  'src/data/champion_meta.json',
  'src/data/power_spikes.json',
  'src/data/lane_champions_cache.json',
  'src/data/build_cache.json',
  'src/data/lane_matchups.json',
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'lolpick-desktop/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location); // リダイレクト対応
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

async function checkForUpdates() {
  console.log('[Update] データ更新チェック開始...');
  const localDataDir = path.join(__dirname, 'src', 'data');
  if (!fs.existsSync(localDataDir)) fs.mkdirSync(localDataDir, { recursive: true });

  let updated = 0;
  for (const file of DATA_FILES) {
    try {
      const url = `${SITE_BASE}/${file}`;
      const remoteData = await fetchUrl(url);
      const localPath = path.join(__dirname, file);

      // ローカルファイルと比較して変更があれば更新
      let needsUpdate = true;
      if (fs.existsSync(localPath)) {
        const localData = fs.readFileSync(localPath);
        needsUpdate = !remoteData.equals(localData);
      }

      if (needsUpdate) {
        // 親ディレクトリがなければ作成
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, remoteData);
        console.log(`[Update] 更新: ${file}`);
        updated++;
      }
    } catch (err) {
      console.warn(`[Update] ${file} の取得に失敗: ${err.message}`);
    }
  }

  // index.html のホットアップデート
  try {
    const versionUrl = `${SITE_BASE}/version.json`;
    const versionData = JSON.parse((await fetchUrl(versionUrl)).toString());
    const remoteVer = versionData.version;
    const minMain = versionData.minMainVersion || '0.0.0';

    if (remoteVer && compareVersions(remoteVer, CURRENT_VERSION) > 0) {
      // メインプロセス更新が必要な場合はインストーラー案内
      if (compareVersions(minMain, CURRENT_VERSION) > 0) {
        console.log(`[Update] メインプロセス更新が必要 (min: v${minMain})`);
        sendToRenderer('app-update-available', {
          currentVersion: CURRENT_VERSION,
          latestVersion: remoteVer,
          downloadUrl: `https://github.com/${GITHUB_REPO}/releases/latest`,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases/latest`,
          requiresInstaller: true,
        });
      } else {
        // index.html だけ更新すればOK
        console.log(`[Update] index.html ホットアップデート v${remoteVer} ...`);
        const htmlData = await fetchUrl(`${SITE_BASE}/index.html`);
        const hotDir = path.join(app.getPath('userData'), 'hot-update');
        if (!fs.existsSync(hotDir)) fs.mkdirSync(hotDir, { recursive: true });

        // 現在のローカルindex.htmlと比較
        const hotHtmlPath = path.join(hotDir, 'index.html');
        let needsHtmlUpdate = true;
        if (fs.existsSync(hotHtmlPath)) {
          const localHtml = fs.readFileSync(hotHtmlPath);
          needsHtmlUpdate = !htmlData.equals(localHtml);
        }

        if (needsHtmlUpdate) {
          fs.writeFileSync(hotHtmlPath, htmlData);
          fs.writeFileSync(path.join(hotDir, 'version.json'), JSON.stringify({ version: remoteVer }));
          console.log(`[Update] index.html 更新完了 → v${remoteVer}`);
          sendToRenderer('app-hot-updated', { version: remoteVer });
          updated++;
        }
      }
    }
  } catch (err) {
    console.warn('[Update] index.html ホットアップデート失敗:', err.message);
  }

  if (updated > 0) {
    console.log(`[Update] ${updated} ファイル更新完了`);
    // チャンプセレクト中でなければ自動リロード
    const inChampSelect = lcuClient?.inChampSelect ?? false;
    if (!inChampSelect) {
      console.log('[Update] 自動リロード実行');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reloadIgnoringCache();
      }
    } else {
      // チャンプセレクト中は通知のみ（終了後にリロード）
      console.log('[Update] チャンプセレクト中のため通知のみ');
      sendToRenderer('data-updated', { count: updated });
      gPendingReload = true;
    }
  } else {
    console.log('[Update] すべて最新です');
  }
  sendToRenderer('update-check-done', { updated });
}

ipcMain.handle('check-updates', async () => {
  await checkForUpdates();
  return { ok: true };
});

// ── バージョン管理 ──
const CURRENT_VERSION = require('./package.json').version;
const GITHUB_REPO = 'aimayujin/lol-assist';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

ipcMain.handle('get-app-version', () => CURRENT_VERSION);
ipcMain.handle('open-external', (_, url) => {
  const { shell } = require('electron');
  return shell.openExternal(url);
});

// ── App Lifecycle ──
app.whenReady().then(() => {
  createWindow();
  startLcu();
  // 起動時にバックグラウンドでデータ＆アプリ更新チェック
  setTimeout(() => checkForUpdates(), 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (lcuClient) lcuClient.stop();
  if (process.platform !== 'darwin') app.quit();
});
