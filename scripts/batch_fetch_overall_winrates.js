#!/usr/bin/env node
/**
 * 全チャンピオンの全体勝率を一括取得するスクリプト
 *
 * 使い方:
 *   1. サーバーを起動: node server.js
 *   2. 別ターミナルで: node scripts/batch_fetch_overall_winrates.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_PORT = process.env.PORT || 5174;
const DELAY_MS = 1500;
const CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'overallwinrate_cache.json');
const META_PATH = path.join(__dirname, '..', 'src', 'data', 'champion_meta.json');

// champion_meta.json から「各チャンプが実際にプレイするロール」だけを対象にする
// ※ lane_champions_cache.json は全チャンプが全ロールに含まれるため、off-role まで取得して
//   ノイズ値が混入する問題があった
const champMeta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

let existingCache = {};
try {
  existingCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
} catch {}

const ROLE_TO_LANE = { TOP: 'top', JG: 'jungle', MID: 'mid', ADC: 'bottom', SUP: 'support' };

// ※ /api/overallwinrate は lane=TOP/JG/MID/ADC/SUP (大文字) を受け取る仕様
function fetchOverallWinrate(champ, role) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${SERVER_PORT}/api/overallwinrate?champ=${encodeURIComponent(champ)}&lane=${encodeURIComponent(role)}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.substring(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const forceAll = process.argv.includes('--force');

  // champion_meta.json から「チャンプ × 実プレイロール」の組み合わせを生成
  const tasks = [];
  for (const [champId, info] of Object.entries(champMeta)) {
    for (const role of info.roles || []) {
      const lane = ROLE_TO_LANE[role];
      if (!lane) continue;
      tasks.push({ champ: champId, role, lane, key: `${champId}_${lane}` });
    }
  }
  // --force でない場合はキャッシュ済みをスキップ
  const toFetch = forceAll ? tasks : tasks.filter(t => {
    const v = existingCache[t.key];
    return !v || v.winRate == null;
  });

  console.log(`\n=== 全体勝率一括取得 ${forceAll ? '(全件強制再取得)' : ''} ===`);
  console.log(`全タスク (champ × 実プレイロール): ${tasks.length}`);
  console.log(`キャッシュ済み: ${tasks.length - toFetch.length}`);
  console.log(`取得対象: ${toFetch.length}`);
  console.log(`推定所要時間: ${Math.ceil(toFetch.length * DELAY_MS / 60000)} 分\n`);

  let done = 0, success = 0, failed = 0;
  for (const t of toFetch) {
    done++;
    try {
      const result = await fetchOverallWinrate(t.champ, t.role);
      if (result.winRate != null) {
        existingCache[t.key] = { winRate: result.winRate, fetchedAt: new Date().toISOString() };
        success++;
        process.stdout.write(`[${done}/${toFetch.length}] ✓ ${t.key}: ${result.winRate}%    `);
      } else {
        failed++;
        process.stdout.write(`[${done}/${toFetch.length}] ✗ ${t.key}: no data    `);
      }
    } catch (e) {
      failed++;
      process.stdout.write(`[${done}/${toFetch.length}] ✗ ${t.key}: ${e.message.substring(0, 40)}    `);
    }

    if (done % 10 === 0) {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
      console.log(`\n  💾 保存 (${Object.keys(existingCache).length}件)`);
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${success}, 失敗: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
