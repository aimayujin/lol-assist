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
const CHAMP_CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'lane_champions_cache.json');

const champCache = JSON.parse(fs.readFileSync(CHAMP_CACHE_PATH, 'utf-8'));
const laneChampions = champCache.data;

let existingCache = {};
try {
  existingCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
} catch {}

const ROLE_TO_LANE = { TOP: 'top', JG: 'jungle', MID: 'mid', ADC: 'bottom', SUP: 'support' };

function fetchOverallWinrate(champ, lane) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${SERVER_PORT}/api/overallwinrate?champ=${encodeURIComponent(champ)}&lane=${encodeURIComponent(lane)}`;
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
  let total = 0, skip = 0, success = 0, failed = 0;

  // Count total and skips
  for (const role of Object.keys(laneChampions)) {
    const lane = ROLE_TO_LANE[role];
    for (const champ of laneChampions[role]) {
      total++;
      const key = `${champ}_${lane}`;
      if (existingCache[key] && existingCache[key].winRate != null) skip++;
    }
  }

  console.log(`\n=== 全体勝率一括取得 ===`);
  console.log(`全チャンピオン: ${total}`);
  console.log(`キャッシュ済み: ${skip}`);
  console.log(`取得対象: ${total - skip}`);
  console.log(`推定所要時間: ${Math.ceil((total - skip) * DELAY_MS / 60000)} 分\n`);

  let done = 0;
  for (const role of Object.keys(laneChampions)) {
    const lane = ROLE_TO_LANE[role];
    console.log(`--- ${role} (${laneChampions[role].length} チャンピオン) ---`);

    for (const champ of laneChampions[role]) {
      const key = `${champ}_${lane}`;
      if (existingCache[key] && existingCache[key].winRate != null) continue;

      done++;
      try {
        const result = await fetchOverallWinrate(champ, lane);
        if (result.winRate != null) {
          existingCache[key] = { winRate: result.winRate, fetchedAt: new Date().toISOString() };
          success++;
          process.stdout.write(`[${done}] ✓ ${key}: ${result.winRate}%    `);
        } else {
          failed++;
          process.stdout.write(`[${done}] ✗ ${key}: no data    `);
        }
      } catch (e) {
        failed++;
        process.stdout.write(`[${done}] ✗ ${key}: ${e.message.substring(0, 40)}    `);
      }

      // 定期保存
      if (done % 10 === 0) {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
      }
      await sleep(DELAY_MS);
    }
    console.log('');
  }

  // 最終保存
  fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${success}, 失敗: ${failed}, スキップ: ${skip}`);
}

main().catch(e => { console.error(e); process.exit(1); });
