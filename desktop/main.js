const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { LcuClient } = require('./lcu');

// electron-updater: バックグラウンド差分更新
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;         // 明示的に downloadUpdate() で開始
  autoUpdater.autoInstallOnAppQuit = true;  // 終了時に適用
} catch (e) {
  console.warn('[updater] electron-updater 未インストール:', e.message);
}

// ── クラッシュ対策: グローバルエラーハンドラ ──
// クラッシュログを %APPDATA%/lolpick.jp/crash.log に追記
function logCrash(tag, err) {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    const line = `[${new Date().toISOString()}] [${tag}] ${err?.stack || err?.message || String(err)}\n`;
    fs.appendFileSync(logPath, line);
    console.error(`[Crash] ${tag}:`, err);
  } catch {}
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

// AppUserModelID を明示的に設定
// ※ 未設定だと Windows のタスクマネージャーで "Electron" と表示されるため
//   package.json の appId と一致させる
const APP_AUMID = 'jp.lolpick.desktop';
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_AUMID); } catch {}
}

// Windows ショートカット + レジストリに AUMID と FriendlyName を登録する
// これをやらないとタスクマネージャーが "Electron" と表示する。
function fixWindowsShortcutAumid() {
  if (process.platform !== 'win32') return;
  try {
    const exe = process.execPath;
    const iconPath = exe; // exe 自体にアイコンが埋め込まれている
    const friendlyName = 'lolpick.jp';

    // ── ① レジストリに AUMID を登録 (HKCU\Software\Classes\AppUserModelId\<aumid>) ──
    // これがないと Task Manager が FriendlyName を解決できず Electron デフォルトになる
    try {
      const { execFileSync } = require('child_process');
      const baseKey = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_AUMID}`;
      // 既定値 + 各プロパティを書き込む
      const regAdds = [
        ['/ve', '/d', friendlyName],
        ['/v', 'RelaunchDisplayNameResource', '/d', friendlyName],
        ['/v', 'RelaunchIconResource', '/d', `${iconPath},0`],
        ['/v', 'RelaunchCommand', '/d', `"${exe}"`],
      ];
      for (const args of regAdds) {
        execFileSync('reg', ['add', baseKey, ...args, '/f'], { stdio: 'ignore' });
      }
      console.log(`[aumid] レジストリ AUMID 登録: ${APP_AUMID} → "${friendlyName}"`);
    } catch (err) {
      console.warn('[aumid] レジストリ書き込み失敗:', err.message);
    }

    // ── ② ショートカットに AUMID を設定 (Start Menu / Desktop) ──
    const candidates = [
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'lolpick.jp.lnk'),
      path.join(app.getPath('desktop'), 'lolpick.jp.lnk'),
    ];
    for (const lnkPath of candidates) {
      if (!fs.existsSync(lnkPath)) continue;
      let existing = {};
      try { existing = shell.readShortcutLink(lnkPath); } catch {}
      if (existing.appUserModelId === APP_AUMID && existing.target === exe) continue;
      // create 操作で上書き (update だと既存の空 AUMID を書き換えないケースがあるため)
      try {
        const ok = shell.writeShortcutLink(lnkPath, 'create', {
          target: exe,
          appUserModelId: APP_AUMID,
          description: friendlyName,
          cwd: path.dirname(exe),
          icon: iconPath,
          iconIndex: 0,
        });
        if (ok) console.log(`[aumid] ショートカット更新: ${lnkPath}`);
        else console.warn(`[aumid] ショートカット更新 returned false: ${lnkPath}`);
      } catch (err) {
        console.warn(`[aumid] ショートカット更新失敗 ${lnkPath}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[aumid] 修正処理エラー:', err.message);
  }
}

// 多重起動防止
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let mainWindow = null;
let tray = null;
let lcuClient = null;
let gPendingReload = false;
let gStartMinimized = process.argv.includes('--minimized');

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
    show: !gStartMinimized,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ホットアップデート版があればそちらを優先ロード
  // ただしインストーラー (本体) のバージョンがホットアップデート版より新しい場合は
  // stale と判定して削除 → バンドル版を読み込む
  const hotDir = path.join(app.getPath('userData'), 'hot-update');
  const hotHtmlPath = path.join(hotDir, 'index.html');
  const hotVerPath = path.join(hotDir, 'version.json');
  let useHot = fs.existsSync(hotHtmlPath);
  if (useHot) {
    try {
      let hotVer = null;
      if (fs.existsSync(hotVerPath)) {
        const vj = JSON.parse(fs.readFileSync(hotVerPath, 'utf-8'));
        hotVer = vj.version;
      }
      const compare = (a, b) => {
        const pa = String(a||'').split('.').map(Number), pb = String(b||'').split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const na = pa[i] || 0, nb = pb[i] || 0;
          if (na !== nb) return na - nb;
        }
        return 0;
      };
      if (hotVer && compare(CURRENT_VERSION, hotVer) > 0) {
        console.log(`[Boot] 本体 v${CURRENT_VERSION} > ホットアップデート v${hotVer} → stale なので削除`);
        try { fs.unlinkSync(hotHtmlPath); } catch {}
        try { fs.unlinkSync(hotVerPath); } catch {}
        useHot = false;
      }
    } catch (e) {
      console.warn('[Boot] ホットアップデート version.json 読み込み失敗:', e.message);
    }
  }
  if (useHot) {
    console.log('[Boot] ホットアップデート版 index.html をロード');
    mainWindow.loadFile(hotHtmlPath);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }

  // DevTools (--dev フラグで開く)
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // ウィンドウを閉じてもトレイに残す
  mainWindow.on('close', (e) => {
    if (tray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) {
    gStartMinimized = false;
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── トレイアイコン ──
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('lolpick.jp');
  updateTrayMenu('LoL未検出');

  tray.on('double-click', () => showWindow());
}

function updateTrayMenu(status) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `lolpick.jp v${CURRENT_VERSION}`, enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'ウィンドウを表示', click: () => showWindow() },
    { label: 'Windows起動時に自動起動', type: 'checkbox', checked: getAutoLaunch(), click: (item) => setAutoLaunch(item.checked) },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Windows 自動起動（レジストリ） ──
function getAutoLaunch() {
  try {
    const { execSync } = require('child_process');
    const result = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "lolpick.jp"', { encoding: 'utf8', timeout: 3000 });
    return result.includes('lolpick.jp');
  } catch {
    return false;
  }
}

function setAutoLaunch(enable) {
  const { execSync } = require('child_process');
  try {
    if (enable) {
      const exePath = process.execPath;
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "lolpick.jp" /t REG_SZ /d "\\"${exePath}\\" --minimized" /f`, { timeout: 3000 });
      console.log('[AutoLaunch] 自動起動を有効化');
    } else {
      execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "lolpick.jp" /f', { timeout: 3000 });
      console.log('[AutoLaunch] 自動起動を無効化');
    }
  } catch (err) {
    console.error('[AutoLaunch] エラー:', err.message);
  }
}

// ── LCU 接続管理 ──
function startLcu() {
  lcuClient = new LcuClient();

  lcuClient.on('lcu-connected', () => {
    console.log('[Main] LCU 接続完了');
    sendToRenderer('lcu-status', { connected: true });
    updateTrayMenu('LoLクライアント接続中');
    // LoL検出時にトレイから自動でウィンドウ表示
    if (!mainWindow || !mainWindow.isVisible()) {
      showWindow();
    }
  });

  lcuClient.on('lcu-disconnected', () => {
    console.log('[Main] LCU 切断');
    sendToRenderer('lcu-status', { connected: false });
    updateTrayMenu('LoL未検出');
  });

  lcuClient.on('champ-select-start', (session) => {
    console.log('[Main] チャンプセレクト開始');
    sendToRenderer('champ-select-update', session);
    // チャンプセレクト開始時にウィンドウを前面に
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  lcuClient.on('champ-select-update', (session) => {
    sendToRenderer('champ-select-update', session);
  });

  lcuClient.on('champ-select-end', () => {
    console.log('[Main] チャンプセレクト終了');
    sendToRenderer('champ-select-end', {});
    // 保留中のリロードがあれば実行（常に loadFile で hot-update HTML をロード）
    if (gPendingReload) {
      gPendingReload = false;
      console.log('[Update] 保留中のリロードを実行');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const hotHtmlPath = path.join(app.getPath('userData'), 'hot-update', 'index.html');
          if (fs.existsSync(hotHtmlPath)) {
            mainWindow.loadFile(hotHtmlPath);
          }
        }
      }, 2000);
    }
  });

  lcuClient.on('gameflow-phase', (phase) => {
    sendToRenderer('gameflow-phase', phase);
    // マッチング成立（Ready Check）/ チャンプセレクト開始時にウィンドウを前面に
    if (phase === 'ReadyCheck' || phase === 'ChampSelect') {
      if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        // 最前面化（一時的に常に最前面にしてから解除することで確実に前面に）
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); }, 500);
      }
    }
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

// 試合中: Live Client API 経由で両チーム戦績+ランクを一括取得
ipcMain.handle('get-in-game-team-stats', async (_, count) => {
  if (!lcuClient?.isConnected()) return null;
  return lcuClient.getInGameTeamStats(count || 20);
});

// デバッグ用
ipcMain.handle('lcu-debug', () => {
  return lcuClient?.getDebugInfo() ?? { error: 'lcuClient not initialized' };
});

ipcMain.handle('lcu-test-api', async (_, endpoint) => {
  return lcuClient?.testApiCall(endpoint) ?? { error: 'lcuClient not initialized' };
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
          get(res.headers.location);
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
  // hot-update ディレクトリに書き込む（asarは read-only なので）
  const hotDir = path.join(app.getPath('userData'), 'hot-update');
  if (!fs.existsSync(hotDir)) fs.mkdirSync(hotDir, { recursive: true });
  const localDataDir = path.join(hotDir, 'src', 'data');
  if (!fs.existsSync(localDataDir)) fs.mkdirSync(localDataDir, { recursive: true });

  let updated = 0;
  for (const file of DATA_FILES) {
    try {
      const url = `${SITE_BASE}/${file}`;
      const remoteData = await fetchUrl(url);
      const localPath = path.join(hotDir, file);

      let needsUpdate = true;
      if (fs.existsSync(localPath)) {
        const localData = fs.readFileSync(localPath);
        needsUpdate = !remoteData.equals(localData);
      }

      if (needsUpdate) {
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
        console.log(`[Update] index.html ホットアップデート v${remoteVer} ...`);
        const htmlData = await fetchUrl(`${SITE_BASE}/index.html`);
        const hotDir = path.join(app.getPath('userData'), 'hot-update');
        if (!fs.existsSync(hotDir)) fs.mkdirSync(hotDir, { recursive: true });

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
    const inChampSelect = lcuClient?.inChampSelect ?? false;
    if (!inChampSelect) {
      // 常に loadFile で hot-update HTML をロード（reloadIgnoringCache は file:// で新コンテンツを反映できないケースがあるため）
      const hotHtmlPath = path.join(app.getPath('userData'), 'hot-update', 'index.html');
      if (fs.existsSync(hotHtmlPath) && mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Update] hot-update HTML をロード（強制）');
        mainWindow.loadFile(hotHtmlPath);
      }
    } else {
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

// ── electron-updater: バックグラウンド差分更新 ──
// GitHub Releases の latest.yml と .blockmap を使って差分ダウンロード。
// %TEMP% にゴミを残さず、サイレントインストール→自動再起動まで自動。
function setupAutoUpdater() {
  if (!autoUpdater) return;
  const send = (channel, data) => {
    try { mainWindow?.webContents?.send(channel, data); } catch {}
  };
  autoUpdater.on('checking-for-update', () => send('installer-progress', { phase: 'checking' }));
  autoUpdater.on('update-available',   (info) => send('installer-progress', { phase: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('installer-progress', { phase: 'none' }));
  autoUpdater.on('download-progress', (p) => send('installer-progress', {
    phase: 'downloading',
    percent: Math.round(p.percent || 0),
    bytesPerSecond: p.bytesPerSecond,
    transferred: p.transferred,
    total: p.total,
  }));
  autoUpdater.on('update-downloaded', (info) => send('installer-progress', { phase: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send('installer-progress', { phase: 'error', error: err?.message || String(err) }));
}
setupAutoUpdater();

ipcMain.handle('check-app-update', async () => {
  if (!autoUpdater) return { ok: false, error: 'updater unavailable' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('download-app-update', async () => {
  if (!autoUpdater) return { ok: false, error: 'updater unavailable' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('install-app-update', () => {
  if (!autoUpdater) return { ok: false, error: 'updater unavailable' };
  // サイレント + 完了後に自動再起動
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 200);
  return { ok: true };
});

// 後方互換: 旧 HTML から呼ばれても安全に動作
ipcMain.handle('download-and-run-installer', async () => {
  if (!autoUpdater) return { ok: false, error: 'updater unavailable' };
  try {
    await autoUpdater.checkForUpdates();
    await autoUpdater.downloadUpdate();
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── App Lifecycle ──
app.whenReady().then(() => {
  // Windows ショートカットの AUMID を必ず修正 (タスクマネージャー表示のため)
  fixWindowsShortcutAumid();
  createTray();
  createWindow();
  startLcu();
  // 起動時にバックグラウンドでデータ＆アプリ更新チェック
  setTimeout(() => checkForUpdates(), 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 多重起動時: 既存ウィンドウを前面に
app.on('second-instance', () => {
  showWindow();
});

app.on('window-all-closed', () => {
  // トレイがあれば終了しない（バックグラウンド常駐）
  if (!tray) {
    if (lcuClient) lcuClient.stop();
    if (process.platform !== 'darwin') app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (lcuClient) lcuClient.stop();
});
