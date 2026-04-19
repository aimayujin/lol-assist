const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcuBridge', {
  // LCU接続状態を取得
  getStatus: () => ipcRenderer.invoke('get-lcu-status'),

  // チャンプセレクト情報を手動取得
  getChampSelect: () => ipcRenderer.invoke('get-champ-select'),

  // リアルタイムイベントのリスナー登録
  onLcuStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lcu-status', handler);
    return () => ipcRenderer.removeListener('lcu-status', handler);
  },

  onChampSelectUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('champ-select-update', handler);
    return () => ipcRenderer.removeListener('champ-select-update', handler);
  },

  onChampSelectEnd: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('champ-select-end', handler);
    return () => ipcRenderer.removeListener('champ-select-end', handler);
  },

  onGameflowPhase: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('gameflow-phase', handler);
    return () => ipcRenderer.removeListener('gameflow-phase', handler);
  },

  // ランク情報取得
  getTeamRanks: (session) => ipcRenderer.invoke('get-team-ranks', session),

  // 戦績取得
  getTeamMatchHistory: (session, count) => ipcRenderer.invoke('get-team-match-history', session, count),

  // 試合中の両チーム戦績+ランク（Live Client API 経由で敵puuid解決）
  getInGameTeamStats: (count) => ipcRenderer.invoke('get-in-game-team-stats', count),

  // データ自動更新
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  onDataUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('data-updated', handler);
    return () => ipcRenderer.removeListener('data-updated', handler);
  },
  onUpdateCheckDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-check-done', handler);
    return () => ipcRenderer.removeListener('update-check-done', handler);
  },

  // アプリ更新通知
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onAppHotUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('app-hot-updated', handler);
    return () => ipcRenderer.removeListener('app-hot-updated', handler);
  },
  onAppUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('app-update-available', handler);
    return () => ipcRenderer.removeListener('app-update-available', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // デバッグ用
  lcuDebug: () => ipcRenderer.invoke('lcu-debug'),
  lcuTestApi: (endpoint) => ipcRenderer.invoke('lcu-test-api', endpoint),
});
