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

// セクション内のアイテムIDを抽出（指定した見出し直後の<tbody>範囲）
function extractItemsFromSection(html, sectionHeader, opts = {}) {
  const { skipBoots = true, skipStarters = true, max = 3 } = opts;
  const headerRe = new RegExp('<th[^>]*>\\s*' + sectionHeader + '\\s*</th>', 'i');
  const mHead = headerRe.exec(html);
  if (!mHead) return [];
  const startPos = mHead.index;
  const endMarker = html.indexOf('</tbody>', startPos);
  const endPos = endMarker === -1 ? Math.min(startPos + 10000, html.length) : endMarker;
  const section = html.substring(startPos, endPos);
  const bootIds = new Set(['3006','3009','3020','3047','3111','3117','3158']);
  const starterIds = new Set([
    '1054','1055','1056','1082','2003','2031','2033',
    '3850','3851','3853','3854','3855','3857','3858','3859','3860','3862','3863','3864',
    '3070','1036','1042','1043','1052','1058','1083','1101','1102','1103','1104','2010','3340',
  ]);
  const itemRe = /item\/(\d{4})\.png/g;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = itemRe.exec(section)) !== null) {
    const id = m[1];
    if (skipStarters && starterIds.has(id)) continue;
    if (skipBoots && bootIds.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (parseInt(id) < 2000) continue;
    items.push(id);
    if (items.length >= max) break;
  }
  return items;
}

function extractBootsFromSection(html) {
  const mHead = /<th[^>]*>\s*Boots\s*<\/th>/i.exec(html);
  if (!mHead) return null;
  const endMarker = html.indexOf('</tbody>', mHead.index);
  const endPos = endMarker === -1 ? Math.min(mHead.index + 4000, html.length) : endMarker;
  const section = html.substring(mHead.index, endPos);
  const bootIds = ['3006','3009','3020','3047','3111','3117','3158'];
  for (const id of bootIds) {
    if (section.includes('item/' + id + '.png')) return id;
  }
  return null;
}

function extractStartersFromSection(html) {
  const mHead = /<th[^>]*>\s*Starter Items\s*<\/th>/i.exec(html);
  if (!mHead) return [];
  const endMarker = html.indexOf('</tbody>', mHead.index);
  const endPos = endMarker === -1 ? Math.min(mHead.index + 4000, html.length) : endMarker;
  const section = html.substring(mHead.index, endPos);
  const itemRe = /item\/(\d{4})\.png/g;
  const ids = []; const seen = new Set();
  let m;
  while ((m = itemRe.exec(section)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 4) break;
  }
  return ids;
}

function extractBuild(html) {
  // ルーン: opacity-100クラスを持つ選択済みperkのみ抽出
  const runeRe = /<img[^>]*class="[^"]*opacity-100[^"]*"[^>]*perk\/(\d+)\.png|<img[^>]*perk\/(\d+)\.png[^>]*class="[^"]*opacity-100[^"]*"/g;
  const runeIds = [];
  let m;
  while ((m = runeRe.exec(html)) !== null) {
    const id = m[1] || m[2];
    if (!runeIds.includes(id)) runeIds.push(id);
    if (runeIds.length >= 6) break;
  }

  // セクション単位で抽出して SUP アイテム等の誤取得を防ぐ
  const coreItems = extractItemsFromSection(html, 'Core Builds', { max: 3 });
  const boots = extractBootsFromSection(html);
  const starters = extractStartersFromSection(html);

  return { runes: runeIds, items: coreItems, starters, boots };
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
