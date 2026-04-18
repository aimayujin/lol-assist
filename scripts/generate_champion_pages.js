#!/usr/bin/env node
/**
 * チャンピオン個別ページ（/champion/<id>.html）と一覧ページ（/champions.html）を生成するスクリプト。
 * DDragonから日本語名・スキル情報を取得し、src/data/*.json のデータと結合して静的HTMLを出力。
 *
 * 実行: node scripts/generate_champion_pages.js
 * 出力: champion/*.html, champions.html
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'src', 'data');
const OUT_DIR = path.join(ROOT, 'champion');

// 最新バージョンとチャンピオン日本語データ取得
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const ROLE_LABEL = { TOP: 'トップ', JG: 'ジャングル', MID: 'ミッド', ADC: 'ボット（ADC）', SUP: 'サポート' };
const ROLE_TO_BUILD = { TOP: 'top', JG: 'jg', MID: 'mid', ADC: 'adc', SUP: 'sup' };
const LCU_TO_ROLE = { top: 'TOP', jungle: 'JG', middle: 'MID', bottom: 'ADC', utility: 'SUP' };

// 並列度を制限して Promise を実行
async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function iconUrl(id, ver) {
  return `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${id}.png`;
}

function winRateLabel(wr) {
  if (wr >= 55) return { className: 'wr-strong', label: '非常に有利' };
  if (wr >= 50.5) return { className: 'wr-good', label: 'やや有利' };
  if (wr >= 49.5) return { className: 'wr-even', label: '互角' };
  if (wr >= 45) return { className: 'wr-bad', label: 'やや不利' };
  return { className: 'wr-weak', label: '非常に不利' };
}

function formatWr(wr) {
  return typeof wr === 'number' ? wr.toFixed(1) + '%' : '—';
}

function renderHeader(title, description, canonicalUrl) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonicalUrl}">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/assets/site.css">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:locale" content="ja_JP">
<meta property="og:site_name" content="lolpick.jp">
<style>
.champ-hero { display:flex; gap:20px; align-items:center; margin:16px 0 24px; padding:20px; background:var(--bg-panel); border:1px solid var(--border); border-radius:10px; }
.champ-hero img { width:96px; height:96px; border-radius:8px; border:2px solid var(--gold-dark); flex-shrink:0; }
.champ-hero-info { flex:1; }
.champ-hero-name { font-size:1.8rem; font-weight:900; color:var(--gold); margin:0 0 4px; letter-spacing:.03em; }
.champ-hero-title { font-size:.95rem; color:var(--text-dim); margin:0 0 8px; }
.champ-tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.champ-tag { background:var(--bg-card2); border:1px solid var(--border); color:var(--text); padding:2px 10px; border-radius:12px; font-size:.75rem; }
.champ-tag.gold { background:rgba(200,155,60,.1); border-color:var(--gold-dark); color:var(--gold-light); }
.stat-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:14px 0 24px; }
.stat-card { background:var(--bg-panel); border:1px solid var(--border); border-radius:6px; padding:12px 14px; }
.stat-card-label { font-size:.72rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em; }
.stat-card-value { font-size:1.3rem; font-weight:700; color:var(--gold-light); margin-top:4px; }
.stat-card-value.wr-strong { color:#4ade80; }
.stat-card-value.wr-good { color:#86efac; }
.stat-card-value.wr-even { color:#fbbf24; }
.stat-card-value.wr-bad { color:#fb923c; }
.stat-card-value.wr-weak { color:#f87171; }
.matchup-list { list-style:none; padding:0; margin:12px 0; }
.matchup-row { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg-panel); border:1px solid var(--border); border-radius:6px; margin-bottom:8px; transition:border-color .15s; }
.matchup-row:hover { border-color:var(--gold-dark); }
.matchup-row img { width:40px; height:40px; border-radius:6px; flex-shrink:0; }
.matchup-row .mu-name { flex:1; font-weight:600; color:var(--text); }
.matchup-row .mu-name a { color:var(--text); }
.matchup-row .mu-name a:hover { color:var(--gold); text-decoration:none; }
.matchup-row .mu-wr { font-weight:700; min-width:60px; text-align:right; }
.matchup-row .mu-wr.wr-strong { color:#4ade80; }
.matchup-row .mu-wr.wr-good { color:#86efac; }
.matchup-row .mu-wr.wr-even { color:#fbbf24; }
.matchup-row .mu-wr.wr-bad { color:#fb923c; }
.matchup-row .mu-wr.wr-weak { color:#f87171; }
.matchup-tips { padding:12px 14px; background:var(--bg-card); border-left:3px solid var(--gold-dark); margin:8px 0 16px 20px; border-radius:0 6px 6px 0; font-size:.9rem; }
.matchup-tips ul { margin:6px 0; padding-left:20px; }
.matchup-tips li { margin:4px 0; color:var(--text); }
.matchup-tips .key-point { color:var(--gold); font-weight:600; font-size:.85rem; }
.spike-bar { display:flex; gap:4px; margin:8px 0; }
.spike-cell { flex:1; padding:6px 0; text-align:center; background:var(--bg-panel); border:1px solid var(--border); border-radius:4px; font-size:.8rem; color:var(--text-dim); }
.spike-cell.active { background:linear-gradient(135deg,rgba(200,155,60,.15),rgba(200,155,60,.05)); border-color:var(--gold-dark); color:var(--gold-light); font-weight:700; }
.related-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; margin:12px 0; }
.related-card { display:flex; flex-direction:column; align-items:center; padding:10px 8px; background:var(--bg-panel); border:1px solid var(--border); border-radius:6px; text-align:center; transition:border-color .15s, transform .15s; }
.related-card:hover { border-color:var(--gold-dark); transform:translateY(-2px); text-decoration:none; }
.related-card img { width:52px; height:52px; border-radius:6px; margin-bottom:6px; }
.related-card-name { font-size:.8rem; color:var(--text); }
.role-section { margin-top:32px; padding-top:16px; border-top:1px solid var(--border); }
.ability-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin:12px 0; }
.ability-card { background:var(--bg-panel); border:1px solid var(--border); border-radius:8px; padding:12px 14px; display:flex; gap:12px; }
.ability-card img { width:48px; height:48px; border-radius:6px; flex-shrink:0; object-fit:cover; }
.ability-card-inner { flex:1; min-width:0; }
.ability-key { display:inline-block; background:var(--gold-dark); color:#000; font-weight:900; padding:1px 7px; border-radius:3px; font-size:.72rem; margin-right:6px; }
.ability-name { font-weight:700; color:var(--gold-light); font-size:.95rem; }
.ability-desc { color:var(--text-dim); font-size:.82rem; margin-top:4px; line-height:1.5; }
.build-box { background:var(--bg-panel); border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin:12px 0; }
.build-row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:6px 0; }
.build-label { font-size:.75rem; color:var(--text-dim); min-width:70px; }
.build-item { display:flex; flex-direction:column; align-items:center; gap:2px; }
.build-item img { width:38px; height:38px; border-radius:4px; background:var(--bg-card); border:1px solid var(--border); }
.build-item-name { font-size:.68rem; color:var(--text-dim); max-width:60px; text-align:center; line-height:1.2; }
.build-rune img { width:30px; height:30px; }
</style>
</head>
<body>

<header class="site-header">
  <div class="site-header-inner">
    <a href="/" class="site-logo">⚔ lolpick.jp</a>
    <nav class="site-nav">
      <a href="/">ツール</a>
      <a href="/champions.html">チャンピオン</a>
      <a href="/guide.html">使い方</a>
      <a href="/about.html">サイトについて</a>
    </nav>
  </div>
</header>

<main class="content">
`;
}

function renderFooter() {
  return `
</main>

<footer class="site-footer">
  <div class="site-footer-inner">
    <nav class="site-footer-nav">
      <a href="/">トップ</a>
      <a href="/champions.html">チャンピオン一覧</a>
      <a href="/guide.html">使い方</a>
      <a href="/faq.html">FAQ</a>
      <a href="/about.html">サイトについて</a>
      <a href="/privacy.html">プライバシーポリシー</a>
      <a href="/terms.html">利用規約</a>
      <a href="/contact.html">お問い合わせ</a>
    </nav>
    <div class="site-footer-meta">
      <small>
        lolpick.jp — League of Legends チーム構成分析ツール<br>
        本サイトは Riot Games, Inc. またはその関連会社が承認または支援しているものではありません。<br>
        League of Legends および Riot Games は Riot Games, Inc. の商標または登録商標です。
      </small>
    </div>
  </div>
</footer>

</body>
</html>
`;
}

function renderAbilities(detail, version) {
  if (!detail || !detail.spells) return '';
  const passive = detail.passive;
  const spells = detail.spells;
  const slotKeys = ['Q', 'W', 'E', 'R'];
  const sanitize = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  let out = `<h2>スキル概要</h2><div class="ability-list">`;

  if (passive) {
    const img = `https://ddragon.leagueoflegends.com/cdn/${version}/img/passive/${passive.image?.full}`;
    out += `<div class="ability-card">
  <img src="${img}" alt="${escapeHtml(passive.name)}" loading="lazy">
  <div class="ability-card-inner">
    <div><span class="ability-key">P</span><span class="ability-name">${escapeHtml(passive.name)}</span></div>
    <div class="ability-desc">${escapeHtml(sanitize(passive.description))}</div>
  </div>
</div>`;
  }

  spells.forEach((sp, i) => {
    const key = slotKeys[i] || '';
    const img = `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${sp.image?.full}`;
    out += `<div class="ability-card">
  <img src="${img}" alt="${escapeHtml(sp.name)}" loading="lazy">
  <div class="ability-card-inner">
    <div><span class="ability-key">${key}</span><span class="ability-name">${escapeHtml(sp.name)}</span></div>
    <div class="ability-desc">${escapeHtml(sanitize(sp.description))}</div>
  </div>
</div>`;
  });

  out += `</div>`;
  return out;
}

function renderBuild(champId, role, builds, items, runeTrees, version) {
  const key = `${champId}_${ROLE_TO_BUILD[role]}`;
  const b = builds[key];
  if (!b) return '';

  const itemImg = (id) => `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`;
  const itemName = (id) => items[id]?.name || '';

  let out = `<div class="build-box">
  <h3>${ROLE_LABEL[role]} 推奨ビルド（op.gg 統計）</h3>`;

  if (b.items && b.items.length) {
    out += `<div class="build-row"><span class="build-label">スターターアイテム</span>`;
    out += b.items.map(id => `<div class="build-item">
  <img src="${itemImg(id)}" alt="${escapeHtml(itemName(id))}" title="${escapeHtml(itemName(id))}" loading="lazy">
  <span class="build-item-name">${escapeHtml(itemName(id))}</span>
</div>`).join('');
    out += `</div>`;
  }

  if (b.boots) {
    out += `<div class="build-row"><span class="build-label">ブーツ</span>
<div class="build-item">
  <img src="${itemImg(b.boots)}" alt="${escapeHtml(itemName(b.boots))}" title="${escapeHtml(itemName(b.boots))}" loading="lazy">
  <span class="build-item-name">${escapeHtml(itemName(b.boots))}</span>
</div></div>`;
  }

  if (b.runes && b.runes.length) {
    out += `<div class="build-row"><span class="build-label">ルーン</span>`;
    out += b.runes.map(rid => {
      const r = runeTrees[rid];
      const img = r ? `https://ddragon.leagueoflegends.com/cdn/img/${r.icon}` : '';
      const name = r?.name || rid;
      return `<div class="build-item build-rune">
  <img src="${img}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none'">
  <span class="build-item-name">${escapeHtml(name)}</span>
</div>`;
    }).join('');
    out += `</div>`;
  }

  out += `</div>`;
  return out;
}

function renderChampionPage(champId, ddData, version, data, detail) {
  const dd = ddData[champId];
  if (!dd) return null;
  const name = dd.name;
  const title = dd.title || '';
  const meta = data.meta[champId] || {};
  const roles = meta.roles || [];
  const spikes = data.spikes[champId] || [];
  const allMatchups = data.matchups || {};

  const pageTitle = `${name} 有利・不利マッチアップ - lolpick.jp`;
  const description = `${name} の各レーンでの有利・不利マッチアップ、勝率、立ち回りアドバイスをまとめたページ。${roles.map(r => ROLE_LABEL[r]).join('・')} で使える詳細情報。`;

  let html = renderHeader(pageTitle, description, `https://lolpick.jp/champion/${champId}.html`);

  // ヒーロー
  html += `
<div class="champ-hero">
  <img src="${iconUrl(champId, version)}" alt="${escapeHtml(name)}" loading="lazy">
  <div class="champ-hero-info">
    <h1 class="champ-hero-name">${escapeHtml(name)}</h1>
    <p class="champ-hero-title">${escapeHtml(title)}</p>
    <div class="champ-tags">
      ${(meta.types || []).map(t => `<span class="champ-tag">${escapeHtml(t)}</span>`).join('')}
      ${roles.map(r => `<span class="champ-tag gold">${ROLE_LABEL[r]}</span>`).join('')}
    </div>
  </div>
</div>
<p class="lead">${escapeHtml(name)} の各ロールでのマッチアップ勝率・立ち回りアドバイスをまとめたページです。レーンごとに有利な相手、不利な相手、試合序盤〜終盤までの動き方を解説します。</p>
`;

  // 全体勝率
  const statRoleCards = roles.map(role => {
    const key = `${champId}_${role.toLowerCase()}`;
    const wr = data.owr[key]?.winRate;
    const spike = winRateLabel(wr || 50);
    return `
    <div class="stat-card">
      <div class="stat-card-label">${ROLE_LABEL[role]} 全体勝率</div>
      <div class="stat-card-value ${wr ? spike.className : ''}">${formatWr(wr)}</div>
    </div>`;
  }).join('');
  if (statRoleCards) {
    html += `<h2>全体統計</h2><div class="stat-grid">${statRoleCards}</div>`;
  }

  // パワースパイク
  if (spikes.length > 0) {
    html += `<h2>パワースパイク</h2>
<p>${escapeHtml(name)} が特に強くなるタイミング（レベル）:</p>
<div class="spike-bar">`;
    for (let lv = 1; lv <= 18; lv++) {
      const active = spikes.includes(lv);
      html += `<div class="spike-cell${active ? ' active' : ''}">Lv${lv}</div>`;
    }
    html += `</div>
<p style="font-size:.85rem;color:var(--text-dim);">スパイクレベル: ${spikes.map(s => `Lv${s}`).join(' / ')}</p>`;
  }

  // スキル概要
  html += renderAbilities(detail, version);

  // 推奨ビルド（ロールごと）
  const buildBlocks = roles.map(r => renderBuild(champId, r, data.builds, data.items, data.runeTrees, version)).filter(Boolean).join('');
  if (buildBlocks) {
    html += `<h2>推奨ビルド</h2>${buildBlocks}`;
  }

  // ロール別マッチアップ
  for (const role of roles) {
    const roleMatchups = allMatchups[role] || {};

    // このチャンプ vs 相手 の全マッチアップ
    const myMatchups = [];
    for (const [key, detail] of Object.entries(roleMatchups)) {
      if (!key.startsWith(`${champId}_vs_`)) continue;
      const opponent = key.slice(`${champId}_vs_`.length);
      if (!ddData[opponent]) continue;
      const wrKey = `${champId}_vs_${opponent}_${role}`;
      const wr = data.wr[wrKey]?.winRate;
      myMatchups.push({ opponent, opponentName: ddData[opponent].name, wr, detail });
    }
    // 勝率でソート、なければ result で並べる
    myMatchups.sort((a, b) => {
      const wa = typeof a.wr === 'number' ? a.wr : 50;
      const wb = typeof b.wr === 'number' ? b.wr : 50;
      return wb - wa;
    });

    if (myMatchups.length === 0) continue;

    const favorable = myMatchups.filter(m => m.detail.result === 'advantage').slice(0, 5);
    const unfavorable = myMatchups.filter(m => m.detail.result === 'disadvantage').slice(-5).reverse();

    html += `<section class="role-section"><h2>${ROLE_LABEL[role]} でのマッチアップ</h2>`;

    if (favorable.length > 0) {
      html += `<h3>🟢 有利な相手 Top ${favorable.length}</h3><ul class="matchup-list">`;
      for (const m of favorable) {
        const lbl = typeof m.wr === 'number' ? winRateLabel(m.wr) : { className: 'wr-good' };
        html += `<li>
  <div class="matchup-row">
    <img src="${iconUrl(m.opponent, version)}" alt="${escapeHtml(m.opponentName)}" loading="lazy">
    <span class="mu-name"><a href="/champion/${m.opponent}.html">${escapeHtml(m.opponentName)}</a></span>
    <span class="mu-wr ${lbl.className}">${formatWr(m.wr)}</span>
  </div>
  <div class="matchup-tips">
    ${m.detail.keyPoints ? `<div class="key-point">▶ ${escapeHtml(m.detail.keyPoints)}</div>` : ''}
    <ul>${(m.detail.tips || []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  </div>
</li>`;
      }
      html += `</ul>`;
    }

    if (unfavorable.length > 0) {
      html += `<h3>🔴 不利な相手 Top ${unfavorable.length}</h3><ul class="matchup-list">`;
      for (const m of unfavorable) {
        const lbl = typeof m.wr === 'number' ? winRateLabel(m.wr) : { className: 'wr-bad' };
        html += `<li>
  <div class="matchup-row">
    <img src="${iconUrl(m.opponent, version)}" alt="${escapeHtml(m.opponentName)}" loading="lazy">
    <span class="mu-name"><a href="/champion/${m.opponent}.html">${escapeHtml(m.opponentName)}</a></span>
    <span class="mu-wr ${lbl.className}">${formatWr(m.wr)}</span>
  </div>
  <div class="matchup-tips">
    ${m.detail.keyPoints ? `<div class="key-point">▶ ${escapeHtml(m.detail.keyPoints)}</div>` : ''}
    <ul>${(m.detail.tips || []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  </div>
</li>`;
      }
      html += `</ul>`;
    }

    html += `</section>`;
  }

  // 関連: 同ロールのチャンプ
  const sameRoleChamps = new Set();
  for (const role of roles) {
    for (const [cid, cmeta] of Object.entries(data.meta)) {
      if (cid !== champId && (cmeta.roles || []).includes(role) && ddData[cid]) {
        sameRoleChamps.add(cid);
      }
    }
  }
  const relatedIds = Array.from(sameRoleChamps).slice(0, 18);
  if (relatedIds.length > 0) {
    html += `<h2>同じロールの他のチャンピオン</h2>
<div class="related-grid">
${relatedIds.map(id => `
  <a href="/champion/${id}.html" class="related-card">
    <img src="${iconUrl(id, version)}" alt="${escapeHtml(ddData[id].name)}" loading="lazy">
    <span class="related-card-name">${escapeHtml(ddData[id].name)}</span>
  </a>`).join('')}
</div>`;
  }

  html += `
<div class="cta-box">
  <a href="/" class="btn">マッチアップ分析ツールを使う</a>
</div>`;

  html += renderFooter();
  return html;
}

function renderChampionsIndex(ddData, version, meta) {
  const byRole = { TOP: [], JG: [], MID: [], ADC: [], SUP: [] };
  for (const [cid, cmeta] of Object.entries(meta)) {
    if (!ddData[cid]) continue;
    for (const r of (cmeta.roles || [])) {
      if (byRole[r]) byRole[r].push({ id: cid, name: ddData[cid].name });
    }
  }
  for (const r of Object.keys(byRole)) {
    byRole[r].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  const pageTitle = 'チャンピオン一覧 - lolpick.jp';
  const description = 'League of Legends の全チャンピオンのレーン別一覧。各チャンピオンのマッチアップ勝率・立ち回りアドバイスページへのリンク集。';
  let html = renderHeader(pageTitle, description, 'https://lolpick.jp/champions.html');

  html += `<h1>チャンピオン一覧</h1>
<p class="lead">各チャンピオンをクリックすると、有利・不利マッチアップや立ち回りアドバイスの詳細ページに移動します。</p>`;

  for (const role of ['TOP', 'JG', 'MID', 'ADC', 'SUP']) {
    const champs = byRole[role];
    if (champs.length === 0) continue;
    html += `<h2>${ROLE_LABEL[role]} (${champs.length}体)</h2>
<div class="related-grid">
${champs.map(c => `
  <a href="/champion/${c.id}.html" class="related-card">
    <img src="${iconUrl(c.id, version)}" alt="${escapeHtml(c.name)}" loading="lazy">
    <span class="related-card-name">${escapeHtml(c.name)}</span>
  </a>`).join('')}
</div>`;
  }

  html += `<div class="cta-box"><a href="/" class="btn">マッチアップ分析ツールを使う</a></div>`;
  html += renderFooter();
  return html;
}

async function main() {
  console.log('[generate] データ読込...');
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'champion_meta.json'), 'utf8'));
  const matchups = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'lane_matchups.json'), 'utf8'));
  const wr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'winrate_cache.json'), 'utf8'));
  const owr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'overallwinrate_cache.json'), 'utf8'));
  const spikes = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'power_spikes.json'), 'utf8'));

  const builds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'build_cache.json'), 'utf8'));

  console.log('[generate] DDragon取得...');
  const versions = await fetchJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const version = versions[0];
  const ddJson = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ja_JP/champion.json`);
  const ddData = ddJson.data;
  console.log(`[generate] DDragon v${version}, ${Object.keys(ddData).length} チャンピオン`);

  // アイテムとルーンのマスタ取得
  console.log('[generate] アイテム・ルーン取得...');
  const itemJson = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ja_JP/item.json`);
  const items = itemJson.data;
  const runeJson = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ja_JP/runesReforged.json`);
  const runeTrees = {};
  for (const tree of runeJson) {
    runeTrees[tree.id] = { name: tree.name, icon: tree.icon };
    for (const slot of tree.slots || []) {
      for (const r of slot.runes || []) {
        runeTrees[r.id] = { name: r.name, icon: r.icon };
      }
    }
  }

  // チャンピオン詳細（スキル情報）を並列取得
  console.log('[generate] チャンピオン詳細（スキル）取得...');
  const champIds = Object.keys(meta).filter(id => ddData[id]);
  const details = {};
  await mapLimit(champIds, 8, async (id) => {
    try {
      const d = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ja_JP/champion/${id}.json`);
      details[id] = d.data?.[id];
    } catch (err) {
      console.warn(`[generate] ${id} 詳細取得失敗: ${err.message}`);
    }
  });
  console.log(`[generate] スキル情報取得完了 (${Object.keys(details).length} 件)`);

  // 出力ディレクトリ作成
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const data = { meta, matchups, wr, owr, spikes, builds, items, runeTrees };
  let count = 0;

  for (const champId of champIds) {
    const html = renderChampionPage(champId, ddData, version, data, details[champId]);
    if (!html) continue;
    fs.writeFileSync(path.join(OUT_DIR, `${champId}.html`), html);
    count++;
  }
  console.log(`[generate] チャンピオンページ ${count} 件生成`);

  // 一覧ページ
  const indexHtml = renderChampionsIndex(ddData, version, meta);
  fs.writeFileSync(path.join(ROOT, 'champions.html'), indexHtml);
  console.log(`[generate] 一覧ページ: champions.html`);

  // sitemap.xml 生成
  const today = new Date().toISOString().slice(0, 10);
  const champUrls = champIds
    .map(id => `  <url>
    <loc>https://lolpick.jp/champion/${id}.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`).join('\n');

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://lolpick.jp/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/champions.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/guide.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/about.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/faq.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/patch-notes.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/contact.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/privacy.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>https://lolpick.jp/terms.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.4</priority>
  </url>
${champUrls}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
  console.log(`[generate] sitemap.xml 更新 (${count} チャンピオンURLを含む)`);
}

main().catch(e => { console.error(e); process.exit(1); });
