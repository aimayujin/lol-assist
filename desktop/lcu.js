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
      try {
        if (this.connected) {
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
          await check();
        }
      } catch (err) {
        console.error('[LCU] 検出ループエラー:', err.message);
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
        const queues = data.queues || [];
        const parseQueue = (q) => q ? {
          tier: q.tier || q.tierHumanReadable || '',
          division: q.division || q.rank || '',
          lp: q.leaguePoints ?? q.lp ?? 0,
          wins: q.wins ?? 0,
          losses: q.losses ?? 0,
        } : null;
        const solo = parseQueue(queues.find(q => q.queueType === 'RANKED_SOLO_5x5') || data.queueMap?.RANKED_SOLO_5x5);
        const flex = parseQueue(queues.find(q => q.queueType === 'RANKED_FLEX_SR') || data.queueMap?.RANKED_FLEX_SR);
        // 前シーズン / 最高到達
        const prevTier = data.previousSeasonEndTier || data.previousSeasonHighestTier || null;
        const prevDiv = data.previousSeasonEndDivision || null;
        const highestTier = data.highestRankedEntry?.tier || data.highestTier || null;
        const highestDiv = data.highestRankedEntry?.division || data.highestDivision || null;
        const result = {
          tier: solo?.tier || '',
          division: solo?.division || '',
          lp: solo?.lp || 0,
          wins: solo?.wins || 0,
          losses: solo?.losses || 0,
          solo,
          flex,
          previousSeason: prevTier ? { tier: prevTier, division: prevDiv } : null,
          highest: highestTier ? { tier: highestTier, division: highestDiv } : null,
        };
        return result;
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
          const timeline = p.timeline || {};
          // position 推定（timeline.lane + timeline.role → TOP/JG/MID/ADC/SUP）
          let position = null;
          const lane = timeline.lane;
          const role = timeline.role;
          if (lane === 'TOP') position = 'TOP';
          else if (lane === 'JUNGLE') position = 'JG';
          else if (lane === 'MIDDLE' || lane === 'MID') position = 'MID';
          else if (lane === 'BOTTOM' || lane === 'BOT') {
            position = role === 'DUO_SUPPORT' ? 'SUP' : 'ADC';
          }
          return {
            gameId: g.gameId,
            championId: p.championId || g.championId,
            position,
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

  // ── Live Client Data API (port 2999, 認証不要, 試合中のみ利用可) ──
  _liveClientRequest(endpoint) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1',
        port: 2999,
        path: endpoint,
        method: 'GET',
        headers: { Accept: 'application/json' },
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
      req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
      req.end();
    });
  }

  async getLiveClientPlayerList() {
    try {
      const res = await this._liveClientRequest('/liveclientdata/playerlist');
      if (res.status === 200 && Array.isArray(res.json)) return res.json;
    } catch (err) {
      // 試合中でない場合は接続拒否されるのが正常
    }
    return null;
  }

  async getLiveClientActivePlayer() {
    try {
      const res = await this._liveClientRequest('/liveclientdata/activeplayer');
      if (res.status === 200 && res.json) return res.json;
    } catch {}
    return null;
  }

  // ── RiotID (gameName#tagLine) → puuid 解決 ──
  async resolvePuuidByRiotId(gameName, tagLine) {
    if (!this.connected || !gameName) return null;

    // ① モダンな alias lookup
    try {
      const res = await this._request('GET',
        `/player-account/aliases/v1/lookup?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine || '')}`);
      if (res.status === 200 && res.json) {
        if (Array.isArray(res.json) && res.json[0]?.puuid) return res.json[0].puuid;
        if (res.json.puuid) return res.json.puuid;
      }
    } catch {}

    // ② POST /lol-summoner/v1/summoners/aliases （フォールバック）
    try {
      const body = JSON.stringify([{ gameName, tagLine: tagLine || '' }]);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: this.port,
          path: '/lol-summoner/v1/summoners/aliases',
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          agent,
        }, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            const b = Buffer.concat(chunks).toString();
            let json = null; try { json = JSON.parse(b); } catch {}
            resolve({ status: r.statusCode, json });
          });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        req.write(body); req.end();
      });
      if (res.status === 200 && Array.isArray(res.json) && res.json[0]?.puuid) {
        return res.json[0].puuid;
      }
    } catch {}

    return null;
  }

  // ── 試合中の両チームプレイヤー情報を Live Client API から組み立て ──
  async getInGamePlayers() {
    const LC_POS_TO_ROLE = { TOP:'TOP', JUNGLE:'JG', MIDDLE:'MID', BOTTOM:'ADC', UTILITY:'SUP' };
    const ROLE_ORDER = ['TOP','JG','MID','ADC','SUP'];

    const list = await this.getLiveClientPlayerList();
    if (!list || list.length === 0) return null;

    // 自分の team を判定（activeplayer の riotId と突合）
    const active = await this.getLiveClientActivePlayer();
    const activeRiotId = active?.riotId || active?.summonerName || '';
    const [myName, myTag] = activeRiotId.split('#');
    let mySide = null;
    for (const p of list) {
      const gn = p.riotIdGameName || p.summonerName || '';
      const tl = p.riotIdTagLine || '';
      if (myName && gn === myName && (!myTag || tl === myTag)) { mySide = p.team; break; }
    }
    if (!mySide) mySide = 'ORDER'; // フォールバック

    const myTeamPlayers = {};
    const enemyTeamPlayers = {};
    const myTeamChamps = {};
    const enemyTeamChamps = {};
    let myIdx = 0, enemyIdx = 0;

    for (const p of list) {
      const role = LC_POS_TO_ROLE[p.position] || null;
      const isMine = p.team === mySide;
      const target = isMine ? myTeamPlayers : enemyTeamPlayers;
      const champTarget = isMine ? myTeamChamps : enemyTeamChamps;
      let r = role;
      if (!r) {
        if (isMine) { if (myIdx < ROLE_ORDER.length) r = ROLE_ORDER[myIdx]; else continue; }
        else { if (enemyIdx < ROLE_ORDER.length) r = ROLE_ORDER[enemyIdx]; else continue; }
      }
      if (isMine) myIdx++; else enemyIdx++;
      target[r] = {
        gameName: p.riotIdGameName || p.summonerName || '',
        tagLine: p.riotIdTagLine || '',
        championName: p.championName || '',
        rawChampionName: p.rawChampionName || '',
      };
      champTarget[r] = p.rawChampionName || p.championName || '';
    }

    // 全員の puuid を解決（並列）
    const all = [
      ...Object.entries(myTeamPlayers).map(([r,p]) => ({ r, p })),
      ...Object.entries(enemyTeamPlayers).map(([r,p]) => ({ r, p })),
    ];
    await Promise.allSettled(all.map(async ({ p }) => {
      const puuid = await this.resolvePuuidByRiotId(p.gameName, p.tagLine);
      if (puuid) p.puuid = puuid;
    }));

    return { myTeamPlayers, enemyTeamPlayers, myTeamChamps, enemyTeamChamps, mySide };
  }

  // ── 試合中の両チーム戦績+ランク一括取得 ──
  async getInGameTeamStats(historyCount = 20) {
    if (!this.connected) return null;
    const players = await this.getInGamePlayers();
    if (!players) return null;

    const ranks = { myTeam: {}, enemyTeam: {} };
    const history = { myTeam: {}, enemyTeam: {} };

    const fetchBoth = async (role, p, rankTarget, historyTarget) => {
      if (!p.puuid) return;
      const [rank, hist] = await Promise.all([
        this.getRankedStats(p.puuid),
        this.getMatchHistory(p.puuid, historyCount),
      ]);
      if (rank) rankTarget[role] = rank;
      if (hist) historyTarget[role] = hist;
    };

    await Promise.all([
      ...Object.entries(players.myTeamPlayers).map(([r,p]) => fetchBoth(r, p, ranks.myTeam, history.myTeam)),
      ...Object.entries(players.enemyTeamPlayers).map(([r,p]) => fetchBoth(r, p, ranks.enemyTeam, history.enemyTeam)),
    ]);

    return { ranks, history, players };
  }
}

module.exports = { LcuClient };
