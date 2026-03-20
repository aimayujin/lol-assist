const { EventEmitter } = require('events');
const { authenticate, createHttp1Request, createWebSocketConnection, LeagueClient } = require('league-connect');

// LCU の assignedPosition → アプリの ROLES マッピング
const POS_TO_ROLE = {
  top: 'TOP',
  jungle: 'JG',
  middle: 'MID',
  bottom: 'ADC',
  utility: 'SUP',
};

class LcuClient extends EventEmitter {
  constructor() {
    super();
    this.credentials = null;
    this.ws = null;
    this.leagueClient = null;
    this.connected = false;
    this.inChampSelect = false;
    this.lastSessionJson = '';
    this.pollTimer = null;
  }

  isConnected() {
    return this.connected;
  }

  async start() {
    this._tryConnect();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
    if (this.leagueClient) this.leagueClient.stop();
    this.connected = false;
  }

  // ── 接続試行 ──
  async _tryConnect() {
    console.log('[LCU] クライアント検出を待機中...');
    try {
      this.credentials = await authenticate({
        awaitConnection: true,   // クライアントが起動するまで待つ
        pollInterval: 3000,
      });
      console.log(`[LCU] 接続成功 port=${this.credentials.port}`);
      this.connected = true;
      this.emit('lcu-connected');

      // クライアントの再起動/終了を監視
      this.leagueClient = new LeagueClient(this.credentials);
      this.leagueClient.on('connect', (newCreds) => {
        console.log('[LCU] クライアント再接続');
        this.credentials = newCreds;
        this.connected = true;
        this.emit('lcu-connected');
        this._startWatching();
      });
      this.leagueClient.on('disconnect', () => {
        console.log('[LCU] クライアント切断');
        this.connected = false;
        this.inChampSelect = false;
        this.emit('lcu-disconnected');
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      });
      this.leagueClient.start();

      await this._startWatching();
    } catch (err) {
      console.error('[LCU] 接続エラー:', err.message);
      // リトライ
      setTimeout(() => this._tryConnect(), 5000);
    }
  }

  // ── WebSocket or Polling で監視 ──
  async _startWatching() {
    // WebSocket 接続を試みる
    try {
      this.ws = await createWebSocketConnection({
        authenticationOptions: { awaitConnection: false },
        ...this.credentials && { port: this.credentials.port, password: this.credentials.password },
      });

      // gameflow フェーズ監視
      this.ws.subscribe('/lol-gameflow/v1/gameflow-phase', (data) => {
        this.emit('gameflow-phase', data);
        if (data === 'ChampSelect') {
          this.inChampSelect = true;
        } else if (this.inChampSelect) {
          this.inChampSelect = false;
          this.lastSessionJson = '';
          this.emit('champ-select-end');
        }
      });

      // チャンプセレクト セッション監視
      this.ws.subscribe('/lol-champ-select/v1/session', (data, event) => {
        if (event.eventType === 'Delete') {
          if (this.inChampSelect) {
            this.inChampSelect = false;
            this.lastSessionJson = '';
            this.emit('champ-select-end');
          }
          return;
        }
        this._handleSession(data);
      });

      console.log('[LCU] WebSocket監視を開始');
    } catch (err) {
      console.warn('[LCU] WebSocket失敗、ポーリングにフォールバック:', err.message);
      this._startPolling();
    }
  }

  // ── ポーリング（WebSocket失敗時のフォールバック） ──
  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.connected) return;
      try {
        const res = await createHttp1Request({
          method: 'GET',
          url: '/lol-champ-select/v1/session',
        }, this.credentials);

        if (res.status === 200) {
          this._handleSession(res.json());
        } else if (this.inChampSelect) {
          this.inChampSelect = false;
          this.lastSessionJson = '';
          this.emit('champ-select-end');
        }
      } catch {}
    }, 1500);
  }

  // ── セッションデータ処理 ──
  _handleSession(session) {
    if (!session || !session.myTeam) return;

    const parsed = this._parseSession(session);
    const json = JSON.stringify(parsed);

    // 変化がない場合はスキップ
    if (json === this.lastSessionJson) return;
    this.lastSessionJson = json;

    if (!this.inChampSelect) {
      this.inChampSelect = true;
      this.emit('champ-select-start', parsed);
    } else {
      this.emit('champ-select-update', parsed);
    }
  }

  // ── セッションを簡潔な形式に変換 ──
  _parseSession(session) {
    const localCellId = session.localPlayerCellId;

    // 自分がどちらのチームか判定
    const isMyTeam = session.myTeam.some(p => p.cellId === localCellId);

    const myTeam = {};
    const enemyTeam = {};

    // ロール未割当時（カスタム等）に順番でロールを割り当て
    const ROLE_ORDER = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];

    // 味方チーム
    let myIdx = 0;
    for (const player of session.myTeam) {
      let role = POS_TO_ROLE[player.assignedPosition] || null;
      if (!role) {
        // カスタム/ARAM等: ピック順でロール割当
        if (myIdx < ROLE_ORDER.length) role = ROLE_ORDER[myIdx];
        else continue;
      }
      myIdx++;
      const champId = player.championId || player.championPickIntent || 0;
      if (champId > 0) myTeam[role] = champId;
    }

    // 敵チーム
    let enemyIdx = 0;
    for (const player of (session.theirTeam || [])) {
      let role = POS_TO_ROLE[player.assignedPosition] || null;
      if (!role) {
        if (enemyIdx < ROLE_ORDER.length) role = ROLE_ORDER[enemyIdx];
        else continue;
      }
      enemyIdx++;
      const champId = player.championId || player.championPickIntent || 0;
      if (champId > 0) enemyTeam[role] = champId;
    }

    // BAN情報
    const bans = {
      myTeam: (session.bans?.myTeamBans || []).filter(id => id > 0),
      theirTeam: (session.bans?.theirTeamBans || []).filter(id => id > 0),
    };

    return { myTeam, enemyTeam, bans, localCellId };
  }

  // ── 手動でセッション取得 ──
  async getChampSelectSession() {
    if (!this.connected) return null;
    try {
      const res = await createHttp1Request({
        method: 'GET',
        url: '/lol-champ-select/v1/session',
      }, this.credentials);
      if (res.status === 200) return this._parseSession(res.json());
    } catch {}
    return null;
  }
}

module.exports = { LcuClient };
