#!/usr/bin/env node
/**
 * 全マッチアップの勝率を一括取得するスクリプト
 *
 * 使い方:
 *   1. サーバーを起動: node server.js
 *   2. 別ターミナルで: node scripts/batch_fetch_winrates.js
 *
 * サーバーの /api/winrate エンドポイントを通じて op.gg から勝率を取得し、
 * winrate_cache.json に保存します。
 *
 * レート制限を避けるため、リクエスト間に遅延を入れています。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_PORT = process.env.PORT || 5174;
const DELAY_MS = 1500;  // リクエスト間の遅延（ms）— op.ggのレート制限対策
const CACHE_PATH = path.join(__dirname, '..', 'src', 'data', 'winrate_cache.json');

// lane_champions_cache.json からレーン別チャンピオン一覧を読み込む
const champCachePath = path.join(__dirname, '..', 'src', 'data', 'lane_champions_cache.json');
const champCache = JSON.parse(fs.readFileSync(champCachePath, 'utf-8'));
const laneChampions = champCache.data;

// 既存キャッシュを読み込み
let existingCache = {};
try {
  existingCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
} catch { /* なければ空 */ }

function fetchWinrate(champ, vs, lane) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${SERVER_PORT}/api/winrate?champ=${encodeURIComponent(champ)}&vs=${encodeURIComponent(vs)}&lane=${encodeURIComponent(lane)}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON: ${data.substring(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const roles = Object.keys(laneChampions);

  // 全マッチアップ数を計算
  let totalPairs = 0;
  for (const role of roles) {
    const champs = laneChampions[role];
    totalPairs += champs.length * (champs.length - 1);
  }

  // 既存キャッシュでスキップできる数
  let skipCount = 0;
  for (const role of roles) {
    const champs = laneChampions[role];
    for (const a of champs) {
      for (const b of champs) {
        if (a === b) continue;
        const key = `${a}_vs_${b}_${role}`;
        if (existingCache[key] && existingCache[key].winRate != null) skipCount++;
      }
    }
  }

  const needFetch = totalPairs - skipCount;
  console.log(`\n=== 勝率一括取得 ===`);
  console.log(`全マッチアップ数: ${totalPairs}`);
  console.log(`キャッシュ済み: ${skipCount}`);
  console.log(`取得対象: ${needFetch}`);
  console.log(`推定所要時間: ${Math.ceil(needFetch * DELAY_MS / 60000)} 分\n`);

  let done = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const role of roles) {
    const champs = laneChampions[role];
    console.log(`\n--- ${role} (${champs.length} チャンピオン) ---`);

    for (const champ of champs) {
      for (const vs of champs) {
        if (champ === vs) continue;

        const key = `${champ}_vs_${vs}_${role}`;

        // キャッシュ済みならスキップ
        if (existingCache[key] && existingCache[key].winRate != null) {
          skipped++;
          continue;
        }

        done++;
        try {
          const result = await fetchWinrate(champ, vs, role);
          if (result.winRate != null) {
            existingCache[key] = {
              winRate: result.winRate,
              enemyWinRate: result.enemyWinRate,
              fetchedAt: result.fetchedAt || new Date().toISOString()
            };
            success++;
            process.stdout.write(`\r[${done}/${needFetch}] ✓ ${key}: ${result.winRate}%    `);
          } else {
            failed++;
            process.stdout.write(`\r[${done}/${needFetch}] ✗ ${key}: no data    `);
          }
        } catch (e) {
          failed++;
          process.stdout.write(`\r[${done}/${needFetch}] ✗ ${key}: ${e.message.substring(0, 40)}    `);
        }

        // 定期的にキャッシュを保存（50件ごと）
        if (done % 50 === 0) {
          fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');
          console.log(`\n  [保存] ${Object.keys(existingCache).length} 件`);
        }

        await sleep(DELAY_MS);
      }
    }
  }

  // 最終保存
  fs.writeFileSync(CACHE_PATH, JSON.stringify(existingCache, null, 2), 'utf-8');

  console.log(`\n\n=== 完了 ===`);
  console.log(`成功: ${success}`);
  console.log(`失敗: ${failed}`);
  console.log(`スキップ(キャッシュ済み): ${skipped}`);
  console.log(`合計キャッシュ件数: ${Object.keys(existingCache).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
