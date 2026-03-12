// =====================================================
// app.js - LOL Assist メインアプリケーション
// =====================================================

import { getDDragonVersion, getAllChampions, championIconUrl } from './utils/ddragon.js';
import { analyzeMatchup, ROLES, COMP_LABELS } from './utils/matchupAnalyzer.js';

// ---- グローバル状態 ----------------------------------
const state = {
  version: null,
  champions: {},     // { id: { id, name, key } }   ← key は数値IDの文字列
  championList: [],  // ソート済み配列
  meta: null,        // champion_meta.json
  laneMatchups: null,// lane_matchups.json
  myPicks: { TOP: null, JG: null, MID: null, ADC: null, SUP: null },
  enemyPicks: { TOP: null, JG: null, MID: null, ADC: null, SUP: null },
  pickerOpen: null,  // { side: 'my'|'enemy', role: 'TOP'|..., inputEl }
  searchQuery: '',
};
window._debugState = state; // デバッグ用（後で削除）

const ROLE_LABELS = { TOP: 'TOP', JG: 'JG', MID: 'MID', ADC: 'ADC', SUP: 'SUP' };
const ROLE_ICONS  = { TOP: '⚔️', JG: '🌿', MID: '🔮', ADC: '🏹', SUP: '🛡️' };

// ---- 初期化 -----------------------------------------

async function init() {
  showLoading(true);
  try {
    [state.version, state.champions, state.meta, state.laneMatchups] = await Promise.all([
      getDDragonVersion(),
      getAllChampions(),
      fetch('./src/data/champion_meta.json').then(r => r.json()),
      fetch('./src/data/lane_matchups.json').then(r => r.json()),
    ]);
    state.championList = Object.values(state.champions)
      .map(c => ({ id: c.id, name: c.name, key: c.key }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    renderTeamBuilder();
    setupPickerEvents();
    fetchAndRenderLaneChampions();
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML =
      `<p class="error">データの読み込みに失敗しました。ネット接続を確認してください。<br>${e.message}</p>`;
  }
  showLoading(false);
}

function showLoading(show) {
  document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

// ---- チームビルダー描画 ------------------------------

function renderTeamBuilder() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="team-builder">
      <div class="team-header">
        <div class="team-label my-label">MY TEAM</div>
        <div class="role-labels">
          ${ROLES.map(r => `
            <div class="role-label">
              <span class="role-icon">${ROLE_ICONS[r]}</span>
              <span>${ROLE_LABELS[r]}</span>
            </div>`).join('')}
        </div>
        <div class="team-label enemy-label">ENEMY</div>
      </div>
      <div class="picks-grid">
        ${ROLES.map(role => renderRoleRow(role)).join('')}
      </div>
      <div class="analyze-bar">
        <button id="analyze-btn" class="analyze-btn">
          ⚡ マッチアップ分析
        </button>
      </div>
    </div>
    <div id="result-section"></div>
  `;

  document.getElementById('analyze-btn').addEventListener('click', runAnalysis);
}

function renderRoleRow(role) {
  return `
    <div class="role-row" id="row-${role}">
      <div class="pick-slot my-pick" data-side="my" data-role="${role}">
        ${renderPickSlot(state.myPicks[role], 'my')}
      </div>
      <div class="role-center">
        <span class="role-icon-lg">${ROLE_ICONS[role]}</span>
        <span class="role-name">${ROLE_LABELS[role]}</span>
      </div>
      <div class="pick-slot enemy-pick" data-side="enemy" data-role="${role}">
        ${renderPickSlot(state.enemyPicks[role], 'enemy')}
      </div>
    </div>
  `;
}

function renderPickSlot(champId, side) {
  if (!champId) {
    return `
      <div class="slot-empty">
        <span class="slot-plus">＋</span>
        <span class="slot-text">選択</span>
      </div>`;
  }
  const iconUrl = championIconUrl(state.version, champId);
  const name = state.champions[champId]?.name ?? champId;
  return `
    <div class="slot-filled">
      <img src="${iconUrl}" alt="${name}" class="champ-icon" loading="lazy"
           onerror="this.src='https://ddragon.leagueoflegends.com/cdn/img/champion/tiles/${champId}_0.jpg'">
      <span class="champ-name">${name}</span>
      <button class="slot-clear" data-remove="true">✕</button>
    </div>`;
}

// ---- ピッカーイベント ---------------------------------

function setupPickerEvents() {
  document.getElementById('app').addEventListener('click', (e) => {
    const slot = e.target.closest('.pick-slot');
    if (!slot) return;
    const removeBtn = e.target.closest('[data-remove]');
    const { side, role } = slot.dataset;

    if (removeBtn) {
      if (side === 'my') state.myPicks[role] = null;
      else state.enemyPicks[role] = null;
      updateSlot(side, role);
      return;
    }
    openPicker(side, role);
  });

  // ピッカー検索
  document.getElementById('picker-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    renderPickerList();
  });

  // ピッカー閉じる
  document.getElementById('picker-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePicker();
  });
  document.getElementById('picker-close').addEventListener('click', closePicker);
}

function openPicker(side, role) {
  state.pickerOpen = { side, role };
  state.searchQuery = '';
  document.getElementById('picker-search').value = '';
  document.getElementById('picker-title').textContent =
    `${side === 'my' ? 'MY TEAM' : 'ENEMY'} - ${ROLE_ICONS[role]} ${ROLE_LABELS[role]}`;
  renderPickerList();
  document.getElementById('picker-overlay').classList.add('open');
  document.getElementById('picker-search').focus();
}

function closePicker() {
  document.getElementById('picker-overlay').classList.remove('open');
  state.pickerOpen = null;
}

function renderPickerList() {
  const query = state.searchQuery;
  const filtered = query
    ? state.championList.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.id.toLowerCase().includes(query))
    : state.championList;

  const container = document.getElementById('picker-list');
  container.innerHTML = filtered.map(c => {
    const iconUrl = championIconUrl(state.version, c.id);
    return `
      <button class="picker-item" data-champ="${c.id}">
        <img src="${iconUrl}" alt="${c.name}" loading="lazy"
             onerror="this.src='https://ddragon.leagueoflegends.com/cdn/14.24.1/img/champion/${c.id}.png'">
        <span>${c.name}</span>
      </button>`;
  }).join('');

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.picker-item');
    if (!btn) return;
    selectChampion(btn.dataset.champ);
  });
}

function selectChampion(champId) {
  if (!state.pickerOpen) return;
  const { side, role } = state.pickerOpen;
  if (side === 'my') state.myPicks[role] = champId;
  else state.enemyPicks[role] = champId;
  updateSlot(side, role);
  closePicker();
}

function updateSlot(side, role) {
  const champId = side === 'my' ? state.myPicks[role] : state.enemyPicks[role];
  const slotEl = document.querySelector(
    `.pick-slot[data-side="${side}"][data-role="${role}"]`
  );
  if (slotEl) slotEl.innerHTML = renderPickSlot(champId, side);
}

// ---- 分析実行 ----------------------------------------

function runAnalysis() {
  const filled = ROLES.filter(r => state.myPicks[r] && state.enemyPicks[r]);
  if (filled.length === 0) {
    alert('少なくとも1レーン分（MY TEAM + ENEMY 両方）のチャンピオンを選択してください');
    return;
  }

  const result = analyzeMatchup(
    state.myPicks,
    state.enemyPicks,
    state.meta,
    state.laneMatchups
  );
  renderResult(result);
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });
  // 分析表示後に勝率を非同期で取得・表示
  fetchWinRates(result.laneResults);
}

// ---- 結果描画 ----------------------------------------

const RESULT_CONFIG = {
  advantage:           { label: '有利',     cls: 'result-advantage',    icon: '▲' },
  slight_advantage:    { label: 'やや有利', cls: 'result-slight-adv',   icon: '△' },
  neutral:             { label: '互角',     cls: 'result-neutral',      icon: '＝' },
  slight_disadvantage: { label: 'やや不利', cls: 'result-slight-dis',   icon: '▽' },
  disadvantage:        { label: '不利',     cls: 'result-disadvantage', icon: '▼' },
};

function renderResult({ laneResults, synergy }) {
  const el = document.getElementById('result-section');

  const laneCards = laneResults
    .filter(r => r.my && r.enemy)
    .map(r => renderLaneCard(r))
    .join('');

  const myCompTypes = synergy.myComp.map(t => COMP_LABELS[t] ?? t).join(' + ') || '不明';
  const enCompTypes = synergy.enemyComp.map(t => COMP_LABELS[t] ?? t).join(' + ') || '不明';

  el.innerHTML = `
    <div class="result-section">
      <h2 class="result-title">📊 マッチアップ分析結果</h2>

      <div class="lane-cards">
        ${laneCards || '<p class="no-data">チャンピオンが選択されていないレーンはスキップされています</p>'}
      </div>

      <div class="team-synergy">
        <h3 class="synergy-title">🏟️ チーム構成分析</h3>
        <div class="comp-row">
          <div class="comp-box my-comp">
            <div class="comp-team-label">MY TEAM</div>
            <div class="comp-type">${myCompTypes}</div>
          </div>
          <div class="comp-vs">VS</div>
          <div class="comp-box enemy-comp">
            <div class="comp-team-label">ENEMY</div>
            <div class="comp-type">${enCompTypes}</div>
          </div>
        </div>
        <div class="synergy-advice">
          <p>${synergy.advice}</p>
        </div>
      </div>

      <div class="result-footer">
        <button id="reset-btn" class="reset-btn">← ピックをやり直す</button>
      </div>
    </div>
  `;

  document.getElementById('reset-btn').addEventListener('click', () => {
    state.myPicks = { TOP: null, JG: null, MID: null, ADC: null, SUP: null };
    state.enemyPicks = { TOP: null, JG: null, MID: null, ADC: null, SUP: null };
    el.innerHTML = '';
    renderTeamBuilder();
    setupPickerEvents();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function renderLaneCard({ role, my, enemy, data }) {
  const cfg = RESULT_CONFIG[data.result] ?? RESULT_CONFIG.neutral;
  const myName = state.champions[my]?.name ?? my;
  const enName = state.champions[enemy]?.name ?? enemy;
  const myIcon = championIconUrl(state.version, my);
  const enIcon = championIconUrl(state.version, enemy);
  const fallbackBadge = data.isFallback
    ? '<span class="fallback-badge">汎用アドバイス</span>' : '';

  const tips = data.tips.map(t => `<li>${t}</li>`).join('');

  return `
    <div class="lane-card ${cfg.cls}">
      <div class="lane-card-header">
        <div class="matchup-champs">
          <div class="matchup-champ my-champ">
            <img src="${myIcon}" alt="${myName}" loading="lazy">
            <span>${myName}</span>
          </div>
          <div class="matchup-center">
            <span class="role-badge">${ROLE_ICONS[role]} ${ROLE_LABELS[role]}</span>
            <div class="result-badge ${cfg.cls}">
              ${cfg.icon} ${cfg.label}
            </div>
            <div class="winrate-badge" id="wr-${role}">
              <span class="wr-loading">勝率取得中…</span>
            </div>
          </div>
          <div class="matchup-champ enemy-champ">
            <img src="${enIcon}" alt="${enName}" loading="lazy">
            <span>${enName}</span>
          </div>
        </div>
        ${fallbackBadge}
      </div>
      <div class="lane-card-body">
        <div class="key-points">
          <strong>🎯 ポイント：</strong>${data.keyPoints}
        </div>
        <ul class="tips-list">
          ${tips}
        </ul>
      </div>
    </div>
  `;
}

// ---- 勝率取得 ----------------------------------------

/**
 * 各レーンの勝率を /api/winrate から非同期取得し、
 * 対応するバッジ要素を更新する
 */
async function fetchWinRates(laneResults) {
  const filled = laneResults.filter(r => r.my && r.enemy);
  if (filled.length === 0) return;

  await Promise.allSettled(filled.map(async ({ role, my, enemy }) => {
    const myChamp    = state.champions[my];
    const enemyChamp = state.champions[enemy];
    if (!myChamp?.key || !enemyChamp?.key) return;

    const el = document.getElementById(`wr-${role}`);
    if (!el) return;

    try {
      const params = new URLSearchParams({
        champ:       my,
        vs:          enemy,
        lane:        role,
        champNumKey: myChamp.key,
        vsNumKey:    enemyChamp.key,
      });
      const resp = await fetch(`/api/winrate?${params}`);
      const data = await resp.json();

      if (data.winRate !== null && data.winRate !== undefined) {
        const wr    = data.winRate;
        const games = data.games ? `${Number(data.games).toLocaleString()}試合` : '';
        const wrCls = wr >= 52 ? 'wr-good' : wr <= 48 ? 'wr-bad' : 'wr-even';
        el.innerHTML = `
          <span class="wr-value ${wrCls}">${wr}%</span>
          ${games ? `<span class="wr-games">${games}</span>` : ''}
          <span class="wr-label">vs ${state.champions[enemy]?.name ?? enemy}</span>
        `;
      } else {
        el.innerHTML = '<span class="wr-na">勝率N/A</span>';
      }
    } catch {
      el.innerHTML = '<span class="wr-na">勝率N/A</span>';
    }
  }));
}

// ---- レーン別チャンピオン一覧 -------------------------

async function fetchAndRenderLaneChampions() {
  try {
    const resp = await fetch('/api/lane-champions');
    const { data, error } = await resp.json();
    if (error || !data) {
      console.warn('[lane-champs]', error);
      return;
    }
    renderLaneChampions(data);
  } catch (e) {
    console.warn('[lane-champs] fetch失敗:', e.message);
  }
}

function renderLaneChampions(data) {
  const container = document.getElementById('lane-champions-section');
  if (!container) return;

  const roleOrder = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];
  const roleLabels = { TOP: '⚔️ TOP', JG: '🌿 JG', MID: '🔮 MID', ADC: '🏹 ADC', SUP: '🛡️ SUP' };

  const sections = roleOrder.map(role => {
    const champs = data[role] || [];
    if (champs.length === 0) return '';
    const champTags = champs.map(id => {
      const name = state.champions[id]?.name ?? id;
      const iconUrl = state.version ? championIconUrl(state.version, id) : '';
      return `<div class="lane-champ-tag" title="${name}">
        ${iconUrl ? `<img src="${iconUrl}" alt="${name}" loading="lazy" onerror="this.style.display='none'">` : ''}
        <span>${name}</span>
      </div>`;
    }).join('');

    return `
      <div class="lane-champ-group">
        <div class="lane-champ-role">${roleLabels[role]} <span class="lane-champ-count">(${champs.length})</span></div>
        <div class="lane-champ-list">${champTags}</div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="lane-champs-panel">
      <h3 class="lane-champs-title">📋 レーン別チャンピオン一覧 <span class="lane-champs-source">（op.gg ティアリストより自動取得）</span></h3>
      ${sections || '<p class="no-data">データ取得中...</p>'}
    </div>`;
}

// ---- 起動 -------------------------------------------
init();
