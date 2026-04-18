const { EventEmitter } = require('events');
const { exec } = require('child_process');
const https = require('https');

// LCU の assignedPosition → アプリの ROLES マッピング
const POS_TO_ROLE = {
  top: 'TOP',
  jungle: 'JG',
  middle: 'MID',
  bottom: 'ADC',
  utility: 'SUP',
};

// SSL自己署名証明書を無視するHTTPSエージェント
const agent = new https.Agent({ rejectUnauthorized: false });

class LcuClient extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.password = null;
    this.authHeader = null;
    this.ws = null;
    this.connected = false;
    this.inChampSelect = false;
    this.lastSessionJson = '';
    this.pollTimer = null;
    this.detectTimer = null;
  }

  isConnected() {
    return this.connected;
  }

  async start() {
    this._detectLoop();
  }

  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.detectTimer) { clearInterval(this.detectTimer); this.detectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
  }

  // ── プロセスからポート・トークンを取得 ──
  _detectLoop() {
    console.log('[LCU] クライアント検出を待機中...');
    const check = async () => {
      if (this.connected) return;
      try {
        const creds = await this._findCredentials();
        if (creds) {
          this.port = creds.port;
          this.password = creds.password;
          this.authHeader = 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64');
          console.log(`[LCU] 接続成功 port=${creds.port}`);
          this.connected = true;
          this.emit('lcu-connected');
          this._startWatching();
        }
      } catch (err) {
        console.warn('[LCU] 検出エラー:', err.message);
      }
    };
    check();
    this.detectTimer = setInterval(async () => {
      if (this.connected) {
        // 接続中: プロセスがまだ生きているか確認
        const alive = await this._isProcessAlive();
        if (!alive) {
          console.log('[LCU] クライアント切断');
          this.connected = false;
          this.port = null;
          this.password = null;
          this.authHeader = null;
          this.inChampSelect = false;
          this.lastSessionJson = '';
          if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
          if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
          this.emit('lcu-disconnected');
        }
      } else {
        check();
      }
    }, 3000);
  }

  // ── WMIC でコマンドライン引数からポート・パスワード取得 ──
  _findCredentials() {
    return new Promise((resolve) => {
      exec(
        'wmic PROCESS WHERE name="LeagueClientUx.exe" GET commandline /FORMAT:LIST',
        { timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout) return resolve(null);
          const portMatch = stdout.match(/--app-port=(\d+)/);
          const tokenMatch = stdout.match(/--remoting-auth-token=([\w-]+)/);
          if (portMatch && tokenMatch) {
            resolve({ port: parseInt(portMatch[1]), password: tokenMatch[1] });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  // ── プロセス生存確認 ──
  _isProcessAlive() {
    return new Promise((resolve) => {
      exec(
        'tasklist /FI "IMAGENAME eq LeagueClientUx.exe" /NH',
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve(false);
          resolve(stdout.includes('LeagueClientUx.exe'));
        }
      );
    });
  }

  // ── HTTPS リクエスト ──
  _request(method, endpoint) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: endpoint,
        method,
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
        agent,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, json, body });
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
      req.end();
    });
  }

  // ── 監視開始（ポーリング方式） ──
  async _startWatching() {
    this._startPolling();
  }

  // ── ポーリング ──
  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    console.log('[LCU] ポーリング監視を開始');
    this.lastPhase = null;
    this.pollTimer = setInterval(async () => {
      if (!this.connected) return;
      // gameflow-phase 監視
      try {
        const phaseRes = await this._request('GET', '/lol-gameflow/v1/gameflow-phase');
        if (phaseRes.status === 200) {
          // レスポンスボディはクォート付き文字列 "ReadyCheck" なので JSON.parse で剥がす
          const phase = phaseRes.json ?? (phaseRes.body ? phaseRes.body.replace(/"/g, '') : null);
          if (phase !== this.lastPhase) {
            this.lastPhase = phase;
            this.emit('gameflow-phase', phase);
          }
        }
      } catch {}
      // champ-select セッション監視
      try {
        const res = await this._request('GET', '/lol-champ-select/v1/session');
        if (res.status === 200 && res.json) {
          this._handleSession(res.json);
        } else if (this.inChampSelect) {
          this.inChampSelect = false;
          this.lastSessionJson = '';
          this.emit('champ-select-end');
        }
      } catch (err) {
        console.error('[LCU] ポーリングエラー:', err.message);
      }
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
    const myTeam = {};
    const enemyTeam = {};
    const ROLE_ORDER = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];

    let myIdx = 0;
    let myRolesInferred = false;
    for (const player of session.myTeam) {
      let role = POS_TO_ROLE[player.assignedPosition] || null;
      if (!role) {
        myRolesInferred = true;
        if (myIdx < ROLE_ORDER.length) role = ROLE_ORDER[myIdx];
        else continue;
      }
      myIdx++;
      const champId = player.championId || player.championPickIntent || 0;
      if (champId > 0) myTeam[role] = champId;
    }

    let enemyIdx = 0;
    let enemyRolesInferred = false;
    for (const player of (session.theirTeam || [])) {
      let role = POS_TO_ROLE[player.assignedPosition] || null;
      if (!role) {
        enemyRolesInferred = true;
        if (enemyIdx < ROLE_ORDER.length) role = ROLE_ORDER[enemyIdx];
        else continue;
      }
      enemyIdx++;
      const champId = player.championId || player.championPickIntent || 0;
      if (champId > 0) enemyTeam[role] = champId;
    }

    const bans = {
      myTeam: (session.bans?.myTeamBans || []).filter(id => id > 0),
      theirTeam: (session.bans?.theirTeamBans || []).filter(id => id > 0),
    };

    let myRole = null;
    for (const player of session.myTeam) {
      if (player.cellId === localCellId) {
        myRole = POS_TO_ROLE[player.assignedPosition] || null;
        break;
      }
    }

    const myTeamPlayers = {};
    const enemyTeamPlayers = {};
    let myIdx2 = 0;
    for (const player of session.myTeam) {
      let r = POS_TO_ROLE[player.assignedPosition] || null;
      if (!r) { if (myIdx2 < ROLE_ORDER.length) r = ROLE_ORDER[myIdx2]; else continue; }
      myIdx2++;
      myTeamPlayers[r] = { summonerId: player.summonerId, puuid: player.puuid };
    }
    let enemyIdx2 = 0;
    for (const player of (session.theirTeam || [])) {
      let r = POS_TO_ROLE[player.assignedPosition] || null;
      if (!r) { if (enemyIdx2 < ROLE_ORDER.length) r = ROLE_ORDER[enemyIdx2]; else continue; }
      enemyIdx2++;
      enemyTeamPlayers[r] = { summonerId: player.summonerId, puuid: player.puuid };
    }

    return { myTeam, enemyTeam, bans, localCellId, myRole, myTeamPlayers, enemyTeamPlayers, myRolesInferred, enemyRolesInferred };
  }

  // ── 手動でセッション取得 ──
  async getChampSelectSession() {
    if (!this.connected) return null;
    try {
      const res = await this._request('GET', '/lol-champ-select/v1/session');
      console.log('[LCU] getChampSelectSession status:', res.status);
      if (res.status === 200 && res.json) return this._parseSession(res.json);
    } catch (err) {
      console.error('[LCU] getChampSelectSession エラー:', err.message);
    }
    return null;
  }

  // ── デバッグ情報取得 ──
  getDebugInfo() {
    return {
      connected: this.connected,
      inChampSelect: this.inChampSelect,
      port: this.port,
      hasPassword: !!this.password,
      hasWs: !!this.ws,
      wsReadyState: this.ws?.readyState ?? null,
      hasPollTimer: !!this.pollTimer,
      lastSessionLength: this.lastSessionJson.length,
    };
  }

  // ── LCU API直接テスト ──
  async testApiCall(endpoint) {
    if (!this.connected) return { error: 'not connected' };
    try {
      const res = await this._request('GET', endpoint);
      return { status: res.status, body: (res.body || '').substring(0, 500) };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ── ランク情報取得 ──
  async getRankedStats(puuid) {
    if (!this.connected || !puuid) return null;
    try {
      const res = await this._request('GET', `/lol-ranked/v1/ranked-stats/${puuid}`);
      if (res.status === 200 && res.json) {
        const data = res.json;
        const solo = data.queues?.find(q => q.queueType === 'RANKED_SOLO_5x5') || data.queueMap?.RANKED_SOLO_5x5;
        if (solo) {
          return {
            tier: solo.tier || solo.tierHumanReadable || '',
            division: solo.division || solo.rank || '',
            lp: solo.leaguePoints ?? solo.lp ?? 0,
            wins: solo.wins ?? 0,
            losses: solo.losses ?? 0,
          };
        }
      }
    } catch (err) {
      console.warn('[LCU] ランク取得失敗:', err.message);
    }
    return null;
  }

  // ── チーム全員のランク取得 ──
  async getTeamRanks(session) {
    if (!this.connected || !session) return { myTeam: {}, enemyTeam: {} };
    const result = { myTeam: {}, enemyTeam: {} };

    const fetchRank = async (players, target) => {
      await Promise.allSettled(Object.entries(players).map(async ([role, p]) => {
        if (!p.puuid) return;
        const rank = await this.getRankedStats(p.puuid);
        if (rank) target[role] = rank;
      }));
    };

    await Promise.all([
      fetchRank(session.myTeamPlayers || {}, result.myTeam),
      fetchRank(session.enemyTeamPlayers || {}, result.enemyTeam),
    ]);
    return result;
  }

  // ── 戦績取得 ──
  async getMatchHistory(puuid, count = 20) {
    if (!this.connected || !puuid) return null;
    try {
      const res = await this._request('GET', `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${count - 1}`);
      if (res.status === 200 && res.json) {
        const data = res.json;
        const games = data.games?.games || data.games || [];
        return games.map(g => {
          const p = g.participants?.[0] || {};
          const stats = p.stats || {};
          return {
            gameId: g.gameId,
            championId: p.championId || g.championId,
            win: stats.win ?? g.win ?? false,
            kills: stats.kills ?? 0,
            deaths: stats.deaths ?? 0,
            assists: stats.assists ?? 0,
            cs: (stats.totalMinionsKilled ?? 0) + (stats.neutralMinionsKilled ?? 0),
            duration: g.gameDuration ?? 0,
            queueId: g.queueId ?? 0,
            timestamp: g.gameCreation ?? g.gameCreationDate ?? 0,
            visionScore: stats.visionScore ?? 0,
            goldEarned: stats.goldEarned ?? 0,
            damageDealt: stats.totalDamageDealtToChampions ?? 0,
          };
        });
      }
    } catch (err) {
      console.warn('[LCU] 戦績取得失敗:', err.message);
    }
    return null;
  }

  // ── チーム全員の戦績取得 ──
  async getTeamMatchHistory(session, count = 10) {
    if (!this.connected || !session) return { myTeam: {}, enemyTeam: {} };
    const result = { myTeam: {}, enemyTeam: {} };

    const fetchHistory = async (players, target) => {
      await Promise.allSettled(Object.entries(players).map(async ([role, p]) => {
        if (!p.puuid) return;
        const history = await this.getMatchHistory(p.puuid, count);
        if (history) target[role] = history;
      }));
    };

    await Promise.all([
      fetchHistory(session.myTeamPlayers || {}, result.myTeam),
      fetchHistory(session.enemyTeamPlayers || {}, result.enemyTeam),
    ]);
    return result;
  }
}

module.exports = { LcuClient };
