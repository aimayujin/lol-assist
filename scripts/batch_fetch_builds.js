/**
 * op.ggからチャンピオンのビルド情報（ルーン・コアアイテム）を一括取得
 * 使用法: node scripts/batch_fetch_builds.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'build_cache.json');
const META_PATH = path.join(__dirname, '..', 'src', 'data', 'champion_meta.json');
const DELAY_MS = 1800;

const OPGG_SLUG_MAP = {
  MonkeyKing:'monkeyking', AurelionSol:'aurelionsol', DrMundo:'drmundo',
  JarvanIV:'jarvaniv', KSante:'ksante', TahmKench:'tahmkench',
  TwistedFate:'twistedfate', MissFortune:'missfortune', MasterYi:'masteryi',
  LeeSin:'leesin', XinZhao:'xinzhao', RekSai:'reksai', BelVeth:'belveth',
  KogMaw:'kogmaw', Leblanc:'leblanc', VelKoz:'velkoz', Chogath:'chogath',
  Nunu:'nunu', RenataGlasc:'renataglasc', Kaisa:'kaisa', Khazix:'khazix',
};
const LANE_MAP = { TOP:'top', JG:'jungle', MID:'mid', ADC:'adc', SUP:'support' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function champSlug(id) { return OPGG_SLUG_MAP[id] || id.toLowerCase(); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://op.gg/',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractBuild(html) {
  const result = { runes: [], items: [], starters: [] };

  // ルーン: opacity-100クラスを持つ選択済みperkのみ抽出
  const runeRe = /<img[^>]*class="[^"]*opacity-100[^"]*"[^>]*perk\/(\d+)\.png|<img[^>]*perk\/(\d+)\.png[^>]*class="[^"]*opacity-100[^"]*"/g;
  const runeIds = [];
  let m;
  while ((m = runeRe.exec(html)) !== null) {
    const id = m[1] || m[2];
    if (!runeIds.includes(id)) runeIds.push(id);
    if (runeIds.length >= 6) break;
  }
  result.runes = runeIds;

  // アイテム分類:
  //  starters: 試合開始時に買うアイテム（ドラン系、ポーション、サポートアイテム等）
  //  boots: ブーツ類
  //  items: コア（レジェンダリー）アイテム
  const starterIds = new Set([
    '1055','1056','1054', // ドランの剣/指輪/盾
    '1082', // ダークシール
    '2003','2031','2033', // ポーション / リフィラブル / コラプティング
    '3850','3851','3853', // Spellthief's Edge 系（サポ）
    '3854','3855','3857', // Steel Shoulderguards 系
    '3858','3859','3860', // Relic Shield 系
    '3862','3863','3864', // Spectral Sickle 系
    '3070', // Tear of the Goddess
    '1036','1042','1043', // ロングソード / ダガー
    '1052','1058', // アンプリファイトーム / ラージロッド
    '1083', // Cull
    '1101','1102','1103','1104', // ジャングルペット（旧JGアイテム含む）
    '2010','3340', // Total Biscuit / Warding Totem
  ]);
  const bootIds = new Set(['3006','3009','3020','3047','3111','3117','3158']);
  const itemRe = /item\/(\d{4})\.png/g;
  const coreItems = [];
  const seenCore = new Set();
  const seenStarter = new Set();
  let boots = null;
  while ((m = itemRe.exec(html)) !== null) {
    const id = m[1];
    if (starterIds.has(id)) {
      if (!seenStarter.has(id) && result.starters.length < 4) {
        seenStarter.add(id);
        result.starters.push(id);
      }
      continue;
    }
    if (bootIds.has(id)) { if (!boots) boots = id; continue; }
    if (seenCore.has(id)) continue;
    seenCore.add(id);
    if (parseInt(id) >= 2000) {
      coreItems.push(id);
      if (coreItems.length >= 3) break;
    }
  }
  result.items = coreItems;
  result.boots = boots;

  return result;
}

async function main() {
  const forceAll = process.argv.includes('--force');
  let cache = {};
  if (!forceAll) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch {}
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

  // champion_meta.json から全チャンプ+ロール組み合わせを取得
  const tasks = [];
  for (const [champId, info] of Object.entries(meta)) {
    for (const role of info.roles || []) {
      const key = `${champId}_${role.toLowerCase()}`;
      tasks.push({ champId, role, key });
    }
  }

  console.log(`=== ビルド情報一括取得 ${forceAll ? '(全件強制再取得)' : ''} ===`);
  console.log(`全タスク数: ${tasks.length}`);

  const toFetch = forceAll ? tasks : tasks.filter(t => !cache[t.key] || !cache[t.key].runes || cache[t.key].runes.length === 0 || !cache[t.key].starters);
  console.log(`キャッシュ済み: ${tasks.length - toFetch.length}`);
  console.log(`取得対象: ${toFetch.length}`);

  let done = 0, ok = 0, fail = 0;

  for (const t of toFetch) {
    const slug = champSlug(t.champId);
    const lane = LANE_MAP[t.role] || t.role.toLowerCase();
    const url = `https://op.gg/lol/champions/${slug}/build?region=global&tier=emerald_plus&lane=${lane}`;

    try {
      const res = await httpsGet(url);
      if (res.status === 200) {
        const build = extractBuild(res.body);
        if (build.runes.length > 0 || build.items.length > 0) {
          cache[t.key] = { runes: build.runes, items: build.items, starters: build.starters, boots: build.boots, fetchedAt: new Date().toISOString() };
          ok++;
          console.log(`[${++done}/${toFetch.length}] ✓ ${t.key}: runes=${build.runes.length} items=${build.items.length} starters=${build.starters.length}`);
        } else {
          fail++;
          console.log(`[${++done}/${toFetch.length}] ✗ ${t.key}: no data found`);
        }
      } else {
        fail++;
        console.log(`[${++done}/${toFetch.length}] ✗ ${t.key}: HTTP ${res.status}`);
      }
    } catch (e) {
      fail++;
      console.log(`[${++done}/${toFetch.length}] ✗ ${t.key}: ${e.message}`);
    }

    if (done % 30 === 0) {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      console.log(`  💾 キャッシュ保存 (${Object.keys(cache).length}件)`);
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${ok}, 失敗: ${fail}, 合計キャッシュ: ${Object.keys(cache).length}件`);
}

main().catch(console.error);
