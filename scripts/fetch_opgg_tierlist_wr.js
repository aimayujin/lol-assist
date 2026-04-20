/**
 * op.gg の /lol/champions?position=<lane> ページから各チャンプの
 * per-role 勝率 & 使用率を取得し、
 * - overallwinrate_cache.json  (winRate)
 * - tierlist_cache.json        (pickRate)
 * を更新する。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const WR_CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'overallwinrate_cache.json');
const TIER_CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'tierlist_cache.json');
const META_PATH = path.join(__dirname, '..', 'src', 'data', 'champion_meta.json');
const LANE_CHAMPS_PATH = path.join(__dirname, '..', 'src', 'data', 'lane_champions_cache.json');

// op.gg の position クエリ (URL パラメータ) と /build/<slug> の slug
// position=middle でも build URL は /build/mid になる点に注意
const LANES = {
  top:     { opgg: 'top',     buildSlug: 'top',     role: 'TOP' },
  jungle:  { opgg: 'jungle',  buildSlug: 'jungle',  role: 'JG'  },
  mid:     { opgg: 'middle',  buildSlug: 'mid',     role: 'MID' },
  bottom:  { opgg: 'adc',     buildSlug: 'adc',     role: 'ADC' },
  support: { opgg: 'support', buildSlug: 'support', role: 'SUP' },
};

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGetText(res.headers.location));
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// op.gg の表示名 → DDragon ID
const NAME_TO_ID = {
  "Aurelion Sol": 'AurelionSol',
  "Bel'Veth": 'Belveth',
  "Cho'Gath": 'Chogath',
  'Dr. Mundo': 'DrMundo',
  'Jarvan IV': 'JarvanIV',
  "Kai'Sa": 'Kaisa',
  "Kha'Zix": 'Khazix',
  "Kog'Maw": 'KogMaw',
  'Lee Sin': 'LeeSin',
  'Master Yi': 'MasterYi',
  'Miss Fortune': 'MissFortune',
  'Nunu & Willump': 'Nunu',
  "Rek'Sai": 'RekSai',
  'Renata Glasc': 'RenataGlasc',
  'Tahm Kench': 'TahmKench',
  'Twisted Fate': 'TwistedFate',
  "Vel'Koz": 'Velkoz',
  'Wukong': 'MonkeyKing',
  'Xin Zhao': 'XinZhao',
  "K'Sante": 'KSante',
};
function normalizeName(name) {
  return NAME_TO_ID[name] || name.replace(/[\'\.\s]/g, '');
}

// op.gg tier list HTML から (championName, lane, winRate, pickRate) を抽出
// 各行の build リンク `/build/<slug>` から lane を取得し、その lane にデータを紐付ける
// (op.gg は MID tier list に Jinx を ADC データで表示するなど、混入があるため)
// slug mapping: top=top, jungle=jungle, mid=mid, adc=bottom, support=support, "" (無し)→current page lane
function parseTierlistHtml(html, fallbackLane) {
  const result = {}; // { champId_lane: { wr, pr } }
  const BUILD_SLUG_TO_LANE = {
    top: 'top',
    jungle: 'jungle',
    mid: 'mid',
    adc: 'bottom',
    support: 'support',
  };
  // build リンク直後の <strong> まで、そして WR/PR へ到達する一連のパターン
  // /lol/champions/SLUG/build(/LANE)?... <strong>CHAMP</strong> ... WR% ... PR%
  const rowRe = /\/lol\/champions\/[a-z]+\/build(?:\/([a-z]+))?[^"]*"[^>]*>[\s\S]{0,800}?<strong[^>]*>([A-Za-z][A-Za-z\'\.\s&;]{1,30})<\/strong>[\s\S]{0,4000}?align="center"[^>]*>([\d]{2}\.[\d]{1,2})<!-- -->%<\/td><td[^>]*>([\d]{1,2}\.[\d]{1,2})<!-- -->%/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const slug = (m[1] || '').toLowerCase();
    const lane = BUILD_SLUG_TO_LANE[slug] || fallbackLane; // lane 無しリンクは現在のページの lane を使用
    const name = m[2].trim().replace(/&amp;/g, '&');
    const wr = parseFloat(m[3]);
    const pr = parseFloat(m[4]);
    const id = normalizeName(name);
    if (id && wr >= 20 && wr <= 80 && pr >= 0 && pr <= 100) {
      const key = `${id}|${lane}`;
      if (!result[key]) result[key] = { id, lane, wr, pr };
    }
  }
  return result;
}

// LoLalytics で per-role 勝率を補完 (op.gg では取れなかった champ 用)
async function fetchLolalyticsWr(champId, lane) {
  const slug = champId.toLowerCase();
  const url = lane === 'mid'
    ? `https://lolalytics.com/lol/${slug}/build/`
    : `https://lolalytics.com/lol/${slug}/build/?lane=${lane}`;
  try {
    const { status, body } = await httpsGetText(url);
    if (status !== 200) return null;
    const m = body.match(/<!--t=[^>]+-->([\d.]+)<!---->%<\/div>[^<]*<div[^>]*>Win Rate<\/div>/i);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * 100) / 100;
  } catch { return null; }
}

async function main() {
  let wrCache = {};
  let tierCache = {};
  try { wrCache = JSON.parse(fs.readFileSync(WR_CACHE_PATH, 'utf-8')); } catch {}
  try { tierCache = JSON.parse(fs.readFileSync(TIER_CACHE_PATH, 'utf-8')); } catch {}

  console.log('=== op.gg tier list から per-role 勝率 & 使用率を取得 ===');

  for (const [lane, { opgg, buildSlug, role }] of Object.entries(LANES)) {
    const url = `https://op.gg/lol/champions?region=global&tier=emerald_plus&position=${opgg}`;
    console.log(`\n--- ${role} (${lane}) ---`);
    console.log(`GET ${url}`);
    let html;
    try {
      const res = await httpsGetText(url);
      if (res.status !== 200) { console.warn(`HTTP ${res.status}`); continue; }
      html = res.body;
    } catch (err) { console.warn('fetch error:', err.message); continue; }

    const parsed = parseTierlistHtml(html, lane);
    const pickRates = {};
    let updated = 0, currentLaneCount = 0;
    for (const entry of Object.values(parsed)) {
      const { id, lane: entryLane, wr, pr } = entry;
      const wrKey = `${id}_${entryLane}`;
      wrCache[wrKey] = { winRate: wr, fetchedAt: new Date().toISOString() };
      updated++;
      // 現在スクレイプ中のレーンの pickrate だけを tierCache に集計
      if (entryLane === lane) {
        pickRates[id] = pr;
        currentLaneCount++;
      }
    }
    tierCache[role] = { fetchedAt: new Date().toISOString(), data: pickRates };
    console.log(`${updated} 件更新 (WR+PR), 現在レーン tier list: ${currentLaneCount} 件`);
    // サンプル表示
    const samples = Object.entries(parsed).slice(0, 5);
    for (const [id, { wr, pr }] of samples) {
      console.log(`  ${id.padEnd(16)} WR: ${wr.toFixed(2)}%  PR: ${pr.toFixed(2)}%`);
    }
    // 5秒待機 (op.gg レート制限対策)
    await new Promise(r => setTimeout(r, 5000));
  }

  // 中間保存
  fs.writeFileSync(WR_CACHE_PATH, JSON.stringify(wrCache, null, 2));
  fs.writeFileSync(TIER_CACHE_PATH, JSON.stringify(tierCache, null, 2));

  // === 補完ステップ: LoLalytics から missing champ の per-role 勝率を取得 ===
  // champion_meta.json の roles リストに存在するが op.gg でカバーされなかった
  // (champId, lane) ペアを lolalytics で埋める
  let meta = {};
  let laneChamps = null;
  try { meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8')); } catch {}
  try { laneChamps = JSON.parse(fs.readFileSync(LANE_CHAMPS_PATH, 'utf-8')); } catch {}
  const ROLE_TO_LANE = { TOP:'top', JG:'jungle', MID:'mid', ADC:'bottom', SUP:'support' };

  console.log('\n=== LoLalytics 補完ステップ ===');
  let suppCount = 0, suppOk = 0;
  for (const [champId, info] of Object.entries(meta)) {
    if (!info.roles || !info.roles.length) continue;
    for (const role of info.roles) {
      const lane = ROLE_TO_LANE[role];
      if (!lane) continue;
      const key = `${champId}_${lane}`;
      if (wrCache[key] && wrCache[key].winRate != null) continue; // 既に取得済み
      suppCount++;
      const wr = await fetchLolalyticsWr(champId, lane);
      if (wr != null) {
        wrCache[key] = { winRate: wr, fetchedAt: new Date().toISOString(), source: 'lolalytics' };
        // tierlist_cache に低めの pickrate でエントリを追加 (lane_champions_cache ランクから推定)
        if (!tierCache[role]) tierCache[role] = { fetchedAt: new Date().toISOString(), data: {} };
        if (tierCache[role].data[champId] === undefined) {
          // lane_champions_cache でのランク順位から pickrate を推定 (上位ほど高い)
          const list = laneChamps?.data?.[role] || [];
          const rank = list.indexOf(champId);
          const estPr = rank >= 0 && rank < 30
            ? Math.max(2.0, 8.0 - rank * 0.2)   // 0位:8% → 30位:2%
            : 2.0;
          tierCache[role].data[champId] = Math.round(estPr * 100) / 100;
        }
        suppOk++;
        process.stdout.write(`[${suppCount}] ✓ ${key}: ${wr}% `);
      } else {
        process.stdout.write(`[${suppCount}] ✗ ${key} `);
      }
      if (suppCount % 10 === 0) fs.writeFileSync(WR_CACHE_PATH, JSON.stringify(wrCache, null, 2));
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  console.log(`\n補完完了: ${suppOk}/${suppCount}`);

  fs.writeFileSync(WR_CACHE_PATH, JSON.stringify(wrCache, null, 2));
  fs.writeFileSync(TIER_CACHE_PATH, JSON.stringify(tierCache, null, 2));
  console.log(`\n=== 完了 === WR ${Object.keys(wrCache).length}, Tier ${Object.keys(tierCache).length} roles`);
}

main().catch(e => { console.error(e); process.exit(1); });
