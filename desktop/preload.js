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
});
