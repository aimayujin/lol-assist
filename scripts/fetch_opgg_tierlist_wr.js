/**
 * op.gg の /lol/champions?position=<lane> ページから各チャンプの
 * per-role 勝率を取得し、overallwinrate_cache.json を更新する。
 *
 * 既存の batch_fetch_overall_winrates.js (op.gg+LoLalytics ハイブリッド) は
 * 一部チャンプで lolalytics が per-role を返さないと全ロール同値になる問題があった。
 * op.gg の tier list ページは per-lane で各チャンプの勝率を確実に出しているので
 * そちらを優先ソースとする。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'overallwinrate_cache.json');

// op.gg の lane slug (MID は "middle", ADC は "adc", SUP は "support")
const LANES = {
  top: 'top',
  jungle: 'jungle',
  mid: 'middle',
  bottom: 'adc',
  support: 'support',
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

// op.gg のチャンプ表示名を DDragon ID に正規化
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
  'K\'Sante': 'KSante',
  "K'Sante": 'KSante',
};

function normalizeName(name) {
  const mapped = NAME_TO_ID[name];
  if (mapped) return mapped;
  // 汎用: アポストロフィ/ピリオド/スペース除去
  return name.replace(/[\'\.\s]/g, '');
}

// op.gg tier list HTML から (championName, winRate, pickRate) を抽出
function parseTierlistHtml(html) {
  const result = {};
  // チャンピオン行のパターン: /<champ>/build/<lane>" ... <strong>CHAMP NAME</strong> ... 3つの数値 (WR, PR, Ban/Tier)
  // op.gg は tr 行の中に champion 名、tier、WR、PR、BR、KDA... と並ぶ
  // 正規表現で各行を抽出:
  //   <tr>...<a href="/lol/champions/<slug>/build/<lane>..."..<strong..>CHAMP_NAME</strong>...
  //     ...td align="center"...>XX.XX%</td>...
  const rowRe = /\/lol\/champions\/([a-z]+)\/build\/[a-z]+[^"]*"[^>]*>[\s\S]{0,800}?<strong[^>]*>([^<]{2,30})<\/strong>[\s\S]{0,4000}?>([\d]{2}\.[\d]{1,2})<!-- -->%/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const name = m[2].trim();
    const wr = parseFloat(m[3]);
    const id = normalizeName(name);
    if (id && wr >= 20 && wr <= 80) {
      result[id] = wr;
    }
  }
  return result;
}

async function main() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch {}

  console.log('=== op.gg tier list から per-role 勝率を取得 ===');

  for (const [lane, opggPosition] of Object.entries(LANES)) {
    const url = `https://op.gg/lol/champions?region=global&tier=emerald_plus&position=${opggPosition}`;
    console.log(`\n--- ${lane} (${opggPosition}) ---`);
    console.log(`GET ${url}`);
    let html;
    try {
      const res = await httpsGetText(url);
      if (res.status !== 200) { console.warn(`HTTP ${res.status}`); continue; }
      html = res.body;
    } catch (err) { console.warn('fetch error:', err.message); continue; }

    const parsed = parseTierlistHtml(html);
    let updated = 0;
    for (const [champId, wr] of Object.entries(parsed)) {
      const key = `${champId}_${lane}`;
      cache[key] = { winRate: wr, fetchedAt: new Date().toISOString() };
      updated++;
    }
    console.log(`${updated} 件更新`);
    // 5秒待機 (op.gg レート制限対策)
    await new Promise(r => setTimeout(r, 5000));
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`\n=== 完了 === 合計 ${Object.keys(cache).length} エントリ`);
}

main().catch(e => { console.error(e); process.exit(1); });
