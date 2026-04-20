#!/usr/bin/env node
/**
 * 全チャンピオンの全体勝率を一括取得するスクリプト
 *
 * ハイブリッド戦略:
 *   - 各チャンプの「primary role」(champion_meta.roles[0]) の値は op.gg から取得
 *     (op.gg の /counters ページは lane クエリを無視して primary の値を返すため)
 *   - 非 primary ロールの値は LoLalytics から取得
 *     (LoLalytics は lane クエリに応じて per-role の値を返す)
 *   - こうして op.gg の「ユーザーの肌感覚と合う値」と、
 *     LoLalytics の「ロール別差分」を両立する
 *
 * 使い方:
 *   node scripts/batch_fetch_overall_winrates.js         # 未取得のみ
 *   node scripts/batch_fetch_overall_winrates.js --force # 全件再取得
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DELAY_MS = 1500;
const CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'overallwinrate_cache.json');
const META_PATH = path.join(__dirname, '..', 'src', 'data', 'champion_meta.json');

const champMeta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

let existingCache = {};
try { existingCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch {}

const ROLE_TO_LANE = { TOP: 'top', JG: 'jungle', MID: 'mid', ADC: 'bottom', SUP: 'support' };
const OPGG_LANE = { TOP: 'top', JG: 'jungle', MID: 'mid', ADC: 'adc', SUP: 'support' };

// op.gg slug マップ (champion_meta の ID → op.gg URL の slug)
const OPGG_SLUG = {
  MonkeyKing:'monkeyking', AurelionSol:'aurelionsol', DrMundo:'drmundo',
  JarvanIV:'jarvaniv', KSante:'ksante', TahmKench:'tahmkench',
  TwistedFate:'twistedfate', MissFortune:'missfortune', MasterYi:'masteryi',
  LeeSin:'leesin', XinZhao:'xinzhao', RekSai:'reksai', BelVeth:'belveth',
  KogMaw:'kogmaw', Leblanc:'leblanc', VelKoz:'velkoz', Chogath:'chogath',
  Nunu:'nunu', RenataGlasc:'renata-glasc', Kaisa:'kaisa', Khazix:'khazix',
};
function champToSlug(id) { return OPGG_SLUG[id] || id.toLowerCase(); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location)); return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchOpggWr(champId, role) {
  const slug = champToSlug(champId);
  const lane = OPGG_LANE[role] || 'mid';
  const url = `https://op.gg/lol/champions/${slug}/counters?region=global&tier=emerald_plus&lane=${lane}`;
  const { status, body } = await httpsGet(url);
  if (status !== 200) return null;
  const m = body.match(/Win rate<\/em><b[^>]*>([\d.]+)<!-- -->%/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 100) / 100;
}

async function fetchLolalyticsWr(champId, role) {
  const slug = champId.toLowerCase();
  const lane = ROLE_TO_LANE[role];
  const url = lane === 'mid'
    ? `https://lolalytics.com/lol/${slug}/build/`
    : `https://lolalytics.com/lol/${slug}/build/?lane=${lane}`;
  const { status, body } = await httpsGet(url);
  if (status !== 200) return null;
  const m = body.match(/<!--t=[^>]+-->([\d.]+)<!---->%<\/div>[^<]*<div[^>]*>Win Rate<\/div>/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 100) / 100;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const forceAll = process.argv.includes('--force');
  const champList = Object.entries(champMeta).filter(([_, m]) => m.roles && m.roles.length > 0);

  console.log('\n=== 全体勝率一括取得 (ハイブリッド: op.gg + LoLalytics) ===');
  console.log(`対象チャンプ: ${champList.length}`);
  console.log(`モード: ${forceAll ? '全件強制再取得' : '未取得のみ'}\n`);

  let done = 0, success = 0, failed = 0;

  for (const [champId, meta] of champList) {
    const primaryRole = meta.roles[0];
    const primaryLane = ROLE_TO_LANE[primaryRole];
    const primaryKey = `${champId}_${primaryLane}`;
    done++;

    // 既存チェック: --force でなければ全ロールが揃っていればスキップ
    const allCached = meta.roles.every(r => {
      const k = `${champId}_${ROLE_TO_LANE[r]}`;
      return existingCache[k] && existingCache[k].winRate != null;
    });
    if (!forceAll && allCached) continue;

    // ① op.gg から primary の値を取得 (全ロールのベースライン)
    let opggWr = null;
    try { opggWr = await fetchOpggWr(champId, primaryRole); } catch (e) {}
    await sleep(300);

    // ② 各ロールの lolalytics 値を取得
    const laWr = {};
    for (const r of meta.roles) {
      try { laWr[r] = await fetchLolalyticsWr(champId, r); } catch {}
      await sleep(300);
    }

    // ③ primary ロールを lolalytics の delta で補正してキャッシュに書く
    //    final = opggWr + (laWr[role] - laWr[primary])
    const laPrimary = laWr[primaryRole];
    for (const r of meta.roles) {
      const lane = ROLE_TO_LANE[r];
      const key = `${champId}_${lane}`;
      let finalWr = null;
      if (opggWr != null && laPrimary != null && laWr[r] != null) {
        finalWr = Math.round((opggWr + (laWr[r] - laPrimary)) * 100) / 100;
      } else if (opggWr != null && r === primaryRole) {
        finalWr = opggWr;
      } else if (laWr[r] != null) {
        finalWr = laWr[r]; // 両方取れなかった時は lolalytics の素の値
      }
      if (finalWr != null) {
        existingCache[key] = { winRate: finalWr, fetchedAt: new Date().toISOString() };
        success++;
      } else {
        failed++;
      }
    }

    const summary = meta.roles.map(r => `${r}:${existingCache[`${champId}_${ROLE_TO_LANE[r]}`]?.winRate ?? 'N/A'}`).join(' ');
    console.log(`[${done}/${champList.length}] ${champId} (opgg=${opggWr ?? 'N/A'}) → ${summary}`);

    if (done % 5 === 0) {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
  console.log(`\n=== 完了 ===\n成功: ${success}, 失敗: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
