const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT                = process.env.PORT || 5174;
const ROOT                = __dirname;
const CACHE_FILE             = path.join(ROOT, 'src/data/winrate_cache.json');
const TIERLIST_CACHE_FILE    = path.join(ROOT, 'src/data/tierlist_cache.json');
const OVERALL_WR_CACHE_FILE  = path.join(ROOT, 'src/data/overallwinrate_cache.json');
const LANE_CHAMPS_CACHE_FILE = path.join(ROOT, 'src/data/lane_champions_cache.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// =====================================================
// 勝率キャッシュ (src/data/winrate_cache.json)
// =====================================================
let winrateCache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      winrateCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[cache] 読み込み失敗:', e.message);
    winrateCache = {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(winrateCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[cache] 書き込み失敗:', e.message);
  }
}

/** 24時間以内に取得したエントリか判定 */
function isCacheFresh(entry) {
  if (!entry?.fetchedAt) return false;
  return Date.now() - new Date(entry.fetchedAt).getTime() < 24 * 60 * 60 * 1000;
}

// =====================================================
// ティアリストキャッシュ (src/data/tierlist_cache.json)
// =====================================================
let tierlistCache = {}; // { "TOP": { fetchedAt: "...", data: { Darius: 8.5, ... } }, ... }

function loadTierlistCache() {
  try {
    if (fs.existsSync(TIERLIST_CACHE_FILE)) {
      tierlistCache = JSON.parse(fs.readFileSync(TIERLIST_CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[tierlist cache] 読み込み失敗:', e.message);
    tierlistCache = {};
  }
}

function saveTierlistCache() {
  try {
    fs.writeFileSync(TIERLIST_CACHE_FILE, JSON.stringify(tierlistCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[tierlist cache] 書き込み失敗:', e.message);
  }
}

// =====================================================
// 全体勝率キャッシュ (src/data/overallwinrate_cache.json)
// =====================================================
let overallWrCache = {}; // { "Darius_top": { winRate: 51.7, fetchedAt: "..." }, ... }

function loadOverallWrCache() {
  try {
    if (fs.existsSync(OVERALL_WR_CACHE_FILE)) {
      overallWrCache = JSON.parse(fs.readFileSync(OVERALL_WR_CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[overallwr cache] 読み込み失敗:', e.message);
    overallWrCache = {};
  }
}

function saveOverallWrCache() {
  try {
    fs.writeFileSync(OVERALL_WR_CACHE_FILE, JSON.stringify(overallWrCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[overallwr cache] 書き込み失敗:', e.message);
  }
}

// =====================================================
// レーン別チャンピオンキャッシュ (src/data/lane_champions_cache.json)
// =====================================================
let laneChampsCache = {}; // { fetchedAt: "...", data: { TOP: [...], JG: [...], ... } }

function loadLaneChampsCache() {
  try {
    if (fs.existsSync(LANE_CHAMPS_CACHE_FILE)) {
      laneChampsCache = JSON.parse(fs.readFileSync(LANE_CHAMPS_CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[lane-champs cache] 読み込み失敗:', e.message);
    laneChampsCache = {};
  }
}

function saveLaneChampsCache() {
  try {
    fs.writeFileSync(LANE_CHAMPS_CACHE_FILE, JSON.stringify(laneChampsCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[lane-champs cache] 書き込み失敗:', e.message);
  }
}

// =====================================================
// LoLalytics フェッチ
// =====================================================
const LANE_MAP = {
  TOP: 'top',
  JG:  'jungle',
  MID: 'mid',
  ADC: 'bottom',
  SUP: 'support',
};

/**
 * Node.js 組み込みの https モジュールで GET → HTML テキスト
 * LoLalytics は SSR で勝率をページに埋め込んでいるためHTML取得で対応
 */
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://op.gg/',
      },
    }, (res) => {
      // リダイレクト追従（相対パス対応）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const fullUrl = loc.startsWith('http') ? loc : `https://${urlObj.hostname}${loc}`;
        resolve(httpsGetText(fullUrl));
        return;
      }
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * op.gg のカウンターページから双方向の勝率を取得
 * URL: https://op.gg/lol/champions/{champ}/counters?region=global&tier=emerald_plus&target_champion={vs}
 * ページに「50.28%49.72%」のような隣接した2つの勝率が含まれており、合計が~100%になる
 */
const OPGG_SLUG_MAP = {
  'MonkeyKing': 'monkeyking',   // DDragon ID → op.gg slug
  'AurelionSol': 'aurelionsol',
};
function champToOpGGSlug(champId) {
  return OPGG_SLUG_MAP[champId] || champId.toLowerCase();
}

async function fetchMatchupFromOpGG(champId, vsId) {
  const champSlug = champToOpGGSlug(champId);
  const vsSlug    = champToOpGGSlug(vsId);
  const url = `https://op.gg/lol/champions/${champSlug}/counters?region=global&tier=emerald_plus&target_champion=${vsSlug}`;

  console.log(`[opgg] GET ${url}`);
  const { status, body } = await httpsGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  // XX.XX% の全数値を位置付きで収集
  const re = /(\d{2}\.\d{2})%/g;
  const values = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    values.push({ val: parseFloat(m[1]), idx: m.index });
  }

  // 隣接していて合計が~100%になるペアを探す（Win rate セクション）
  for (let i = 0; i < values.length - 1; i++) {
    const a = values[i].val, b = values[i + 1].val;
    const gap = values[i + 1].idx - values[i].idx;
    if (gap < 600 && Math.abs(a + b - 100) < 1.0) {
      console.log(`[opgg] ${champSlug} vs ${vsSlug}: ${a}% / ${b}%`);
      return { winRate: a, enemyWinRate: b, fetchedAt: new Date().toISOString() };
    }
  }
  throw new Error('complementary win rate pair not found in op.gg response');
}

/**
 * LoLalytics の対戦ページ HTML から勝率を抽出する
 * URL: https://lolalytics.com/lol/{champ}/vs/{enemy}/build/
 * ページ内に "Darius wins against Fiora 51.06% of the time" のような文章が埋め込まれる
 *
 * @param {string} champId  - DDragon champion ID (例: "Darius")
 * @param {string} vsId     - 相手 champion ID (例: "Fiora")
 * @param {string} _lane    - (将来用。現在は URL に lane を含まないため未使用)
 */
async function fetchFromLolalytics(champId, vsId, _lane) {
  const slug   = champId.toLowerCase();
  const vsSlug = vsId.toLowerCase();
  const url    = `https://lolalytics.com/lol/${slug}/vs/${vsSlug}/build/`;

  console.log(`[lolalytics] GET ${url}`);
  const { status, body } = await httpsGetText(url);

  if (status !== 200) throw new Error(`HTTP ${status}`);

  // "Darius wins against Fiora 51.06% of the time"
  const wrMatch = body.match(/wins against .+?\s+([\d.]+)%\s+of the time/i);
  if (!wrMatch) {
    // フォールバック: "XX.XX%\nWin Rate" パターン
    const fallback = body.match(/>(\d{2}\.\d+)%<[^>]*>\s*Win Rate/);
    if (!fallback) throw new Error('win rate pattern not found in page');
    return { winRate: Math.round(parseFloat(fallback[1]) * 10) / 10, games: null, fetchedAt: new Date().toISOString() };
  }

  const winRate = Math.round(parseFloat(wrMatch[1]) * 10) / 10;

  // 試合数を探す: "51.06%\nWin Rate\nXX,XXX\nGames" に近いパターン
  const gamesMatch = body.match(/Win Rate[\s\S]{0,60}?([\d,]{3,})\s*Games/i);
  const games = gamesMatch ? parseInt(gamesMatch[1].replace(/,/g, ''), 10) : null;

  return { winRate, games, fetchedAt: new Date().toISOString() };
}

/**
 * op.gg のビルドページから全体勝率を取得
 * URL: https://op.gg/lol/champions/{slug}/build?region=global&tier=emerald_plus&lane={lane}
 * ページ内に <em>Win rate</em><b ...>52.38%</b> 形式で埋め込まれている
 *
 * @param {string} champId - DDragon champion ID (例: "Ahri")
 * @param {string} lane    - op.gg lane slug (例: "mid")
 */
const OPGG_LANE_MAP = { top:'top', jungle:'jungle', mid:'mid', bottom:'bottom', support:'support' };

async function fetchOverallWinrateFromOpGG(champId, lane) {
  const slug     = champToOpGGSlug(champId);
  const opggLane = OPGG_LANE_MAP[lane] || lane;
  // build ページはCSRのため全体勝率がSSR HTMLに含まれない
  // counters ページはSSRで Win rate を埋め込んでいる (52.38<!-- -->% 形式)
  const url = `https://op.gg/lol/champions/${slug}/counters?region=global&tier=emerald_plus&lane=${opggLane}`;

  console.log(`[opgg-overall] GET ${url}`);
  const { status, body } = await httpsGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  // <em>Win rate</em><b ...>52.38<!-- -->%  (SSRパターン)
  const m = body.match(/Win rate<\/em><b[^>]*>([\d.]+)<!-- -->%/);
  if (!m) throw new Error('overall win rate pattern not found in op.gg counters response');

  const winRate = Math.round(parseFloat(m[1]) * 100) / 100;
  console.log(`[opgg-overall] ${slug} ${opggLane}: ${winRate}%`);
  return { winRate, fetchedAt: new Date().toISOString() };
}

/**
 * LoLalytics の個別チャンピオンページから全体勝率を取得
 * URL: https://lolalytics.com/lol/{champ}/build/?lane={lane}
 * ページに "Average Emerald+ Win Rate: <!--t=XX-->51.72<!---->%" 形式で埋め込まれている
 *
 * @param {string} champId - DDragon champion ID (例: "Darius")
 * @param {string} lane    - LoLalytics lane slug (例: "top")
 */
async function fetchOverallWinrateFromLolalytics(champId, lane) {
  const slug = champId.toLowerCase();
  // mid lane は ?lane=mid を付けると 404 になるため、パラメータなしURLを使用
  const url  = lane === 'mid'
    ? `https://lolalytics.com/lol/${slug}/build/`
    : `https://lolalytics.com/lol/${slug}/build/?lane=${lane}`;

  console.log(`[overallwr] GET ${url}`);
  const { status, body } = await httpsGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  // Qwik SSR パターン: "<!--t=XX-->52.92<!---->%</div><div ...>Win Rate</div>"
  // ※ "Average Emerald+ Win Rate: <!--t=2d-->51.71<!---->%" はサイト全体平均のため使用しない
  const m1 = body.match(/<!--t=[^>]+-->([\d.]+)<!---->%<\/div>[^<]*<div[^>]*>Win Rate<\/div>/i);
  if (m1) {
    return { winRate: Math.round(parseFloat(m1[1]) * 100) / 100, fetchedAt: new Date().toISOString() };
  }

  // フォールバック: "XX.XX% Win Rate" パターン (例: "52.92% Win Rate")
  const m2 = body.match(/([\d.]+)<!---->%[^<]*Win Rate/i);
  if (m2) {
    return { winRate: Math.round(parseFloat(m2[1]) * 100) / 100, fetchedAt: new Date().toISOString() };
  }

  throw new Error('overall win rate pattern not found in page');
}

/**
 * __NEXT_DATA__ JSON を再帰探索してピック率マップを返す
 * チャンピオンオブジェクト配列 (pickRate フィールドあり) を探す
 */
function extractPickRatesFromJson(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || !obj || typeof obj !== 'object') return {};
  if (Array.isArray(obj)) {
    // 配列の先頭が pickRate を持つチャンピオンオブジェクトか確認
    const first = obj[0];
    if (first && typeof first === 'object' && first.pickRate !== undefined) {
      const result = {};
      for (const item of obj) {
        // DDragon style ID を探す: id / name / champion フィールドを優先
        const rawId = item.id ?? item.name ?? item.champion ?? item.key ?? '';
        if (rawId && item.pickRate !== undefined) {
          result[String(rawId)] = parseFloat(item.pickRate);
        }
      }
      if (Object.keys(result).length > 5) return result; // 十分なデータが見つかった
    }
    for (const child of obj) {
      const r = extractPickRatesFromJson(child, depth + 1);
      if (Object.keys(r).length > 5) return r;
    }
    return {};
  }
  for (const key of Object.keys(obj)) {
    const r = extractPickRatesFromJson(obj[key], depth + 1);
    if (Object.keys(r).length > 5) return r;
  }
  return {};
}

/**
 * LoLalytics ティアリストページから全チャンピオンのピック率を取得
 * @param {string} lane - 'top' | 'jungle' | 'mid' | 'bottom' | 'support'
 * @returns {Object}  { DdragonId: pickRateNumber, ... }
 */
async function fetchTierlistFromLolalytics(lane) {
  const url = `https://lolalytics.com/lol/tierlist/?lane=${lane}`;
  console.log(`[tierlist] GET ${url}`);
  const { status, body } = await httpsGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  // ---- 方法1: __NEXT_DATA__ スクリプトタグから JSON を抽出 ----
  const ndMatch = body.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (ndMatch) {
    try {
      const json   = JSON.parse(ndMatch[1]);
      const result = extractPickRatesFromJson(json);
      if (Object.keys(result).length > 5) {
        console.log(`[tierlist] __NEXT_DATA__ から ${Object.keys(result).length} 件取得`);
        return result;
      }
    } catch (e) {
      console.warn('[tierlist] __NEXT_DATA__ パース失敗:', e.message);
    }
  }

  // ---- 方法2: インライン JSON から "pickRate" を持つオブジェクト列を探す ----
  // {"id":"Darius","pickRate":8.52,...} のようなパターン
  const result = {};
  const re = /"(?:id|name|champion)":\s*"([A-Za-z][A-Za-z0-9'.\s]*)"[^}]{0,300}?"pickRate":\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    // DDragon ID 形式に正規化 ("Dr. Mundo" → "DrMundo", "Kai'Sa" → "Kaisa" など)
    const rawId = m[1].trim().replace(/['.\s]/g, '');
    result[rawId] = parseFloat(m[2]);
  }
  if (Object.keys(result).length > 5) {
    console.log(`[tierlist] regex から ${Object.keys(result).length} 件取得`);
    return result;
  }

  // ---- 方法3: 逆順パターン "pickRate": X ... "id": "Champ" ----
  const re2 = /"pickRate":\s*([\d.]+)[^}]{0,300}?"(?:id|name|champion)":\s*"([A-Za-z][A-Za-z0-9'.\s]*)"/g;
  while ((m = re2.exec(body)) !== null) {
    const rawId = m[2].trim().replace(/['.\s]/g, '');
    result[rawId] = parseFloat(m[1]);
  }
  if (Object.keys(result).length > 5) {
    console.log(`[tierlist] regex2 から ${Object.keys(result).length} 件取得`);
    return result;
  }

  throw new Error('pick rate data not found in page');
}

// =====================================================
// op.gg レーン別チャンピオン一覧取得
// =====================================================
const OPGG_POSITION_MAP = {
  TOP: 'top', JG: 'jungle', MID: 'mid', ADC: 'adc', SUP: 'support',
};

// op.gg チャンピオン名 → DDragon ID への変換マップ
const OPGG_NAME_TO_ID = {
  "Dr. Mundo": "DrMundo", "Wukong": "MonkeyKing", "Twisted Fate": "TwistedFate",
  "Lee Sin": "LeeSin", "Master Yi": "MasterYi", "Kha'Zix": "Khazix",
  "Rek'Sai": "RekSai", "Jarvan IV": "JarvanIV", "Miss Fortune": "MissFortune",
  "Kai'Sa": "Kaisa", "Kog'Maw": "KogMaw", "Vel'Koz": "Velkoz",
  "Renata Glasc": "RenataGlasc", "Tahm Kench": "TahmKench",
  "Xin Zhao": "XinZhao", "Aurelion Sol": "AurelionSol",
  "Cho'Gath": "Chogath", "Bel'Veth": "Belveth", "K'Sante": "KSante",
  "Nunu & Willump": "Nunu",
};

function opggNameToId(name) {
  if (OPGG_NAME_TO_ID[name]) return OPGG_NAME_TO_ID[name];
  // SLUG_TO_ID でもチェック（JSON内部IDが小文字の場合に対応）
  const slug = name.toLowerCase().replace(/['\s.]/g, '');
  if (SLUG_TO_ID[slug]) return SLUG_TO_ID[slug];
  // スペースや記号を除去して CamelCase 化
  return name.replace(/['\s.]/g, '');
}

/**
 * op.gg ティアリストページからチャンピオン名一覧を取得
 * URL: https://www.op.gg/champions?region=global&tier=emerald_plus&position={position}
 */
const LANE_CHAMPS_PICK_RATE_THRESHOLD = 1.0; // ピック率1%以上のチャンピオンのみキャッシュ

async function fetchLaneChampionsFromOpGG(role) {
  const position = OPGG_POSITION_MAP[role];
  const url = `https://www.op.gg/champions?region=global&tier=emerald_plus&position=${position}`;
  console.log(`[lane-champs] GET ${url}`);
  const { status, body } = await httpsGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  const champions = [];

  // __NEXT_DATA__ JSON から champion 名とピック率を抽出
  const ndMatch = body.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (ndMatch) {
    try {
      const json = JSON.parse(ndMatch[1]);

      // ピック率マップ取得を試みる
      const pickRates = extractPickRatesFromJson(json);
      const hasPickRates = Object.keys(pickRates).length > 5;

      // チャンピオン名リスト取得
      const champNames = extractChampionNamesFromJson(json);

      if (hasPickRates) {
        // ピック率でフィルタリング
        for (const name of champNames) {
          const id = opggNameToId(name);
          const pr = pickRates[name] ?? pickRates[id] ?? pickRates[name.replace(/['\s.]/g, '')] ?? 0;
          if (pr >= LANE_CHAMPS_PICK_RATE_THRESHOLD) {
            champions.push(id);
          }
        }
        console.log(`[lane-champs] ${role}: ${champNames.length}体中 ${champions.length}体（PR>=${LANE_CHAMPS_PICK_RATE_THRESHOLD}%）`);
      } else {
        // ピック率データなし → 名前リストのみ
        for (const name of champNames) {
          champions.push(opggNameToId(name));
        }
      }
    } catch (e) {
      console.warn('[lane-champs] __NEXT_DATA__ パース失敗:', e.message);
    }
  }

  // フォールバック: リンクパターンから抽出
  if (champions.length < 10) {
    const linkRe = /\/lol\/champions\/([a-z][a-z0-9-]*?)\/build/g;
    const slugSet = new Set();
    let m;
    while ((m = linkRe.exec(body)) !== null) slugSet.add(m[1]);
    for (const slug of slugSet) {
      const id = opggSlugToId(slug);
      if (id && !champions.includes(id)) champions.push(id);
    }
  }

  console.log(`[lane-champs] ${role}: ${champions.length} チャンピオン`);
  return champions;
}

// op.gg slug → DDragon ID
const SLUG_TO_ID = {
  'drmundo': 'DrMundo', 'wukong': 'MonkeyKing', 'twistedfate': 'TwistedFate',
  'leesin': 'LeeSin', 'masteryi': 'MasterYi', 'khazix': 'Khazix',
  'reksai': 'RekSai', 'jarvaniv': 'JarvanIV', 'missfortune': 'MissFortune',
  'kaisa': 'Kaisa', 'kogmaw': 'KogMaw', 'velkoz': 'Velkoz',
  'renataglasc': 'RenataGlasc', 'tahmkench': 'TahmKench',
  'xinzhao': 'XinZhao', 'aurelionsol': 'AurelionSol',
  'chogath': 'Chogath', 'belveth': 'Belveth', 'ksante': 'KSante',
  'nunu': 'Nunu', 'nunuwillump': 'Nunu',
  'monkeyking': 'MonkeyKing',
};

function opggSlugToId(slug) {
  if (SLUG_TO_ID[slug]) return SLUG_TO_ID[slug];
  // 先頭を大文字にして返す
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// JSON から champion 名の配列を再帰的に探す
function extractChampionNamesFromJson(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 12 || !obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    // name フィールドを持つチャンピオンオブジェクト配列か
    const first = obj[0];
    if (first && typeof first === 'object' && (first.name || first.id) && obj.length > 10) {
      const names = [];
      for (const item of obj) {
        if (item.name) names.push(String(item.name));
        else if (item.id) names.push(String(item.id));
      }
      if (names.length > 10) return names;
    }
    for (const child of obj) {
      const r = extractChampionNamesFromJson(child, depth + 1);
      if (r.length > 10) return r;
    }
    return [];
  }
  for (const key of Object.keys(obj)) {
    const r = extractChampionNamesFromJson(obj[key], depth + 1);
    if (r.length > 10) return r;
  }
  return [];
}

// =====================================================
// リクエストハンドラ
// =====================================================
async function handleRequest(req, res) {
  const [urlPath, qs] = req.url.split('?');

  // ---------- CORS preflight ----------
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  // ---------- /api/winrate ----------
  if (urlPath === '/api/winrate') {
    const p     = new URLSearchParams(qs || '');
    const champ = p.get('champ');
    const vs    = p.get('vs');
    const lane  = p.get('lane');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!champ || !vs || !lane) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing params: champ, vs, lane' }));
      return;
    }

    const cacheKey = `${champ}_vs_${vs}_${lane}`;

    // キャッシュが新鮮かつ enemyWinRate もある場合はそのまま返す
    const cached = winrateCache[cacheKey];
    if (isCacheFresh(cached) && cached.enemyWinRate != null) {
      console.log(`[cache] hit: ${cacheKey}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ...cached, cached: true }));
      return;
    }

    // op.gg から双方向勝率を取得（主要ソース）
    try {
      const result = await fetchMatchupFromOpGG(champ, vs);
      winrateCache[cacheKey] = result;
      saveCache();
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, cached: false }));
      return;
    } catch (e) {
      console.warn(`[opgg] ${cacheKey} 失敗 (${e.message}), LoLalyticsにフォールバック`);
    }

    // フォールバック: LoLalytics
    try {
      const result = await fetchFromLolalytics(champ, vs, lane);
      winrateCache[cacheKey] = result;
      saveCache();
      console.log(`[lolalytics fallback] ${cacheKey} → ${result.winRate ?? 'N/A'}%`);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, cached: false }));
    } catch (e) {
      console.error(`[lolalytics] ${cacheKey} 失敗: ${e.message}`);
      res.writeHead(200);
      res.end(JSON.stringify({ winRate: null, games: null, error: e.message, cached: false }));
    }
    return;
  }

  // ---------- /api/overallwinrate ----------
  if (urlPath === '/api/overallwinrate') {
    const p     = new URLSearchParams(qs || '');
    const champ = p.get('champ');
    const role  = p.get('lane');   // 'TOP' | 'JG' | 'MID' | 'ADC' | 'SUP'

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!champ || !role || !LANE_MAP[role]) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing params: champ, lane (TOP/JG/MID/ADC/SUP)' }));
      return;
    }

    const lane     = LANE_MAP[role];
    const cacheKey = `${champ}_${lane}`;

    if (isCacheFresh(overallWrCache[cacheKey])) {
      console.log(`[overallwr cache] hit: ${cacheKey}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ...overallWrCache[cacheKey], cached: true }));
      return;
    }

    // op.gg から取得（主要ソース）
    try {
      const result = await fetchOverallWinrateFromOpGG(champ, lane);
      overallWrCache[cacheKey] = result;
      saveOverallWrCache();
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, cached: false }));
      return;
    } catch (e) {
      console.warn(`[opgg-overall] ${cacheKey} 失敗 (${e.message}), LoLalyticsにフォールバック`);
    }

    // フォールバック: LoLalytics
    try {
      const result = await fetchOverallWinrateFromLolalytics(champ, lane);
      overallWrCache[cacheKey] = result;
      saveOverallWrCache();
      console.log(`[overallwr-fallback] ${cacheKey} → ${result.winRate}%`);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, cached: false }));
    } catch (e) {
      console.error(`[overallwr] ${cacheKey} 失敗: ${e.message}`);
      res.writeHead(200);
      res.end(JSON.stringify({ winRate: null, error: e.message, cached: false }));
    }
    return;
  }

  // ---------- /api/tierlist ----------
  if (urlPath === '/api/tierlist') {
    const p    = new URLSearchParams(qs || '');
    const role = p.get('lane');          // 'TOP' | 'JG' | 'MID' | 'ADC' | 'SUP'

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!role || !LANE_MAP[role]) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing or invalid lane param (TOP/JG/MID/ADC/SUP)' }));
      return;
    }

    const lane        = LANE_MAP[role];
    const cacheEntry  = tierlistCache[role];

    // キャッシュが新鮮ならそのまま返す
    if (isCacheFresh(cacheEntry)) {
      console.log(`[tierlist cache] hit: ${role}`);
      res.writeHead(200);
      res.end(JSON.stringify({ data: cacheEntry.data, cached: true }));
      return;
    }

    // LoLalytics からフェッチ
    try {
      const data = await fetchTierlistFromLolalytics(lane);
      tierlistCache[role] = { fetchedAt: new Date().toISOString(), data };
      saveTierlistCache();
      console.log(`[tierlist] ${role} (${lane}) → ${Object.keys(data).length} チャンピオン`);
      res.writeHead(200);
      res.end(JSON.stringify({ data, cached: false }));
    } catch (e) {
      console.error(`[tierlist] ${role} 失敗: ${e.message}`);
      res.writeHead(200);
      res.end(JSON.stringify({ data: {}, error: e.message, cached: false }));
    }
    return;
  }

  // ---------- /api/lane-champions ----------
  if (urlPath === '/api/lane-champions') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // キャッシュが新鮮ならそのまま返す
    if (isCacheFresh(laneChampsCache)) {
      console.log('[lane-champs cache] hit');
      res.writeHead(200);
      res.end(JSON.stringify({ data: laneChampsCache.data, cached: true }));
      return;
    }

    // 全レーンを並列フェッチ → 全成功時のみキャッシュ更新（アトミック更新）
    try {
      const roles = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];
      const results = await Promise.allSettled(
        roles.map(role => fetchLaneChampionsFromOpGG(role))
      );
      const data = {};
      let allSucceeded = true;
      for (let i = 0; i < roles.length; i++) {
        if (results[i].status === 'fulfilled' && results[i].value.length > 0) {
          data[roles[i]] = results[i].value;
        } else {
          allSucceeded = false;
          console.warn(`[lane-champs] ${roles[i]} 取得失敗: ${results[i].reason?.message ?? 'empty'}`);
          // 既存キャッシュがあればそのレーンを維持
          data[roles[i]] = laneChampsCache.data?.[roles[i]] ?? [];
        }
      }
      if (allSucceeded) {
        laneChampsCache = { fetchedAt: new Date().toISOString(), data };
        saveLaneChampsCache();
        console.log(`[lane-champs] 全レーン取得完了・キャッシュ更新`);
      } else {
        console.log(`[lane-champs] 一部失敗のためキャッシュ未更新（レスポンスには返す）`);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ data, cached: false }));
    } catch (e) {
      console.error(`[lane-champs] 失敗: ${e.message}`);
      // キャッシュがあればフォールバック
      if (laneChampsCache.data) {
        res.writeHead(200);
        res.end(JSON.stringify({ data: laneChampsCache.data, cached: true, error: e.message }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ data: {}, error: e.message, cached: false }));
      }
    }
    return;
  }

  // ---------- 静的ファイル ----------
  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  const ext      = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // JSON データファイルはキャッシュしない（更新が反映されるように）
    if (ext === '.json') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// =====================================================
// 起動
// =====================================================
loadCache();
loadTierlistCache();
loadOverallWrCache();
loadLaneChampsCache();

http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[server] unhandled:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
}).listen(PORT, () => {
  console.log(`LOL Assist: http://localhost:${PORT}`);
  console.log(`Win rate cache: ${Object.keys(winrateCache).length} 件ロード済み`);
  // 起動時にキャッシュが古ければ自動更新
  scheduleAutoRefresh();
});

// =====================================================
// 自動キャッシュ更新（サーバーサイド）
// =====================================================
const AUTO_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6時間ごと

async function refreshLaneChampsIfStale() {
  if (isCacheFresh(laneChampsCache)) {
    console.log('[auto-refresh] レーン別チャンピオンキャッシュは新鮮 → スキップ');
    return;
  }
  console.log('[auto-refresh] レーン別チャンピオンキャッシュが古い → 更新開始');
  try {
    const roles = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];
    const results = await Promise.allSettled(
      roles.map(role => fetchLaneChampionsFromOpGG(role))
    );
    const newData = {};
    let allOk = true;
    for (let i = 0; i < roles.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value.length > 0) {
        newData[roles[i]] = results[i].value;
      } else {
        allOk = false;
        console.warn(`[auto-refresh] ${roles[i]} 失敗`);
      }
    }
    if (allOk) {
      laneChampsCache = { fetchedAt: new Date().toISOString(), data: newData };
      saveLaneChampsCache();
      console.log('[auto-refresh] レーン別チャンピオンキャッシュ更新完了');
      for (const r of roles) console.log(`  ${r}: ${newData[r].length}体`);
    } else {
      console.log('[auto-refresh] 一部失敗のためキャッシュ未更新');
    }
  } catch (e) {
    console.error('[auto-refresh] 失敗:', e.message);
  }
}

// =====================================================
// 勝率キャッシュ自動更新（サーバーサイド）
// =====================================================
const WINRATE_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24時間ごと
const WINRATE_FETCH_DELAY = 2000; // リクエスト間隔（ms）— レート制限対策
let winrateRefreshRunning = false;

/** champion_meta.json からロール別のチャンピオン一覧を構築 */
function getRoleChampionsFromMeta() {
  try {
    const metaPath = path.join(ROOT, 'src/data/champion_meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const roleMap = { TOP:[], JG:[], MID:[], ADC:[], SUP:[] };
    for (const [name, data] of Object.entries(meta)) {
      for (const role of data.roles || []) {
        if (roleMap[role]) roleMap[role].push(name);
      }
    }
    return roleMap;
  } catch (e) {
    console.warn('[winrate-refresh] champion_meta.json 読み込み失敗:', e.message);
    return null;
  }
}

/** 24時間以上古いエントリを持つマッチアップを再取得 */
async function refreshWinratesIfStale() {
  if (winrateRefreshRunning) {
    console.log('[winrate-refresh] 既に実行中 → スキップ');
    return;
  }

  // champion_meta.json からロール別チャンピオンを取得（主要ピックのみに絞る）
  const roleChamps = getRoleChampionsFromMeta();
  if (!roleChamps) {
    console.log('[winrate-refresh] チャンピオンメタデータなし → スキップ');
    return;
  }

  winrateRefreshRunning = true;
  const roles = Object.keys(roleChamps);
  const ROLE_TO_LANE = { TOP:'top', JG:'jungle', MID:'mid', ADC:'bottom', SUP:'support' };

  // 件数見積もり
  let totalOverall = 0, totalVs = 0;
  for (const role of roles) {
    const n = roleChamps[role].length;
    totalOverall += n;
    totalVs += n * (n - 1);
  }
  console.log(`[winrate-refresh] 勝率キャッシュ更新開始 (全体${totalOverall}件 + VS${totalVs}件, 推定${Math.ceil((totalOverall + totalVs) * WINRATE_FETCH_DELAY / 3600000)}時間)`);

  let updated = 0, skipped = 0, failed = 0;

  try {
    // 1. 全体勝率の更新
    for (const role of roles) {
      const lane = ROLE_TO_LANE[role];
      const champs = roleChamps[role];
      for (const champ of champs) {
        const key = `${champ}_${lane}`;
        if (isCacheFresh(overallWrCache[key])) { skipped++; continue; }
        try {
          const wr = await fetchOverallWinrateFromOpGG(champ, lane);
          if (wr) {
            overallWrCache[key] = { winRate: wr, fetchedAt: new Date().toISOString() };
            updated++;
          } else { failed++; }
        } catch { failed++; }
        await new Promise(r => setTimeout(r, WINRATE_FETCH_DELAY));
      }
    }
    saveOverallWrCache();
    console.log(`[winrate-refresh] 全体勝率: 更新${updated}, スキップ${skipped}, 失敗${failed}`);

    // 2. VSマッチアップ勝率の更新
    updated = 0; skipped = 0; failed = 0;
    for (const role of roles) {
      const champs = roleChamps[role];
      console.log(`[winrate-refresh] ${role} (${champs.length}体) VS勝率更新中...`);
      for (const champ of champs) {
        for (const vs of champs) {
          if (champ === vs) continue;
          const key = `${champ}_vs_${vs}_${role}`;
          if (winrateCache[key] && winrateCache[key].winRate != null && isCacheFresh(winrateCache[key])) {
            skipped++;
            continue;
          }
          try {
            const result = await fetchMatchupFromOpGG(champ, vs);
            if (result && result.winRate != null) {
              winrateCache[key] = result;
              updated++;
            } else { failed++; }
          } catch { failed++; }
          // 定期保存（100件ごと）
          if ((updated + failed) % 100 === 0 && updated > 0) {
            saveCache();
            console.log(`[winrate-refresh]   ...${updated}件更新済み`);
          }
          await new Promise(r => setTimeout(r, WINRATE_FETCH_DELAY));
        }
      }
    }
    saveCache();
    console.log(`[winrate-refresh] VS勝率: 更新${updated}, スキップ${skipped}, 失敗${failed}`);
    console.log('[winrate-refresh] 勝率キャッシュ更新完了');
  } catch (e) {
    console.error('[winrate-refresh] エラー:', e.message);
    // エラーが起きても途中まで保存
    saveCache();
    saveOverallWrCache();
  } finally {
    winrateRefreshRunning = false;
  }
}

function scheduleAutoRefresh() {
  // 起動10秒後にレーンチャンピオン更新
  setTimeout(() => refreshLaneChampsIfStale(), 10000);
  // 起動60秒後に勝率更新（レーンチャンピオン更新後に実行）
  setTimeout(() => refreshWinratesIfStale(), 60000);
  // レーンチャンピオン: 6時間ごと
  setInterval(() => refreshLaneChampsIfStale(), AUTO_REFRESH_INTERVAL);
  // 勝率: 24時間ごと
  setInterval(() => refreshWinratesIfStale(), WINRATE_REFRESH_INTERVAL);
}
