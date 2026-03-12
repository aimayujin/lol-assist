// =====================================================
// matchupAnalyzer.js
// 1v1レーンマッチアップ + チームシナジー分析
// =====================================================

const ROLES = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];

// ---- ヘルパー ----------------------------------------

function lookupMatchup(laneMatchups, role, myKey, enemyKey) {
  const roleData = laneMatchups[role];
  if (!roleData) return null;
  const key1 = `${myKey}_vs_${enemyKey}`;
  const key2 = `${enemyKey}_vs_${myKey}`;
  if (roleData[key1]) return { ...roleData[key1], perspective: 'my' };
  if (roleData[key2]) {
    // 逆向きのデータを反転して返す
    const d = roleData[key2];
    const invertedResult =
      d.result === 'advantage' ? 'disadvantage' :
      d.result === 'disadvantage' ? 'advantage' : 'neutral';
    return {
      result: invertedResult,
      tips: d.tips,
      keyPoints: d.keyPoints,
      perspective: 'inverted',
    };
  }
  return null;
}

// スタイル → コンプタイプへの重み付け
const STYLE_WEIGHT = {
  engage:     { engage: 2 },
  burst:      { burst: 2 },
  poke:       { poke: 2 },
  teamfight:  { teamfight: 2 },
  splitpush:  { splitpush: 2 },
  peel:       { peel: 2 },
  utility:    { utility: 2 },
};

function detectCompType(picks, meta) {
  const score = {
    engage: 0, burst: 0, poke: 0,
    teamfight: 0, splitpush: 0, peel: 0, utility: 0,
  };
  for (const champ of picks) {
    if (!champ || !meta[champ]) continue;
    const style = meta[champ].style;
    const weights = STYLE_WEIGHT[style] || {};
    for (const [k, v] of Object.entries(weights)) score[k] += v;
  }
  // 上位2つのコンプタイプを返す
  const sorted = Object.entries(score)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 2).map(([k]) => k);
}

const COMP_LABELS = {
  engage:    'エンゲージ',
  burst:     'バースト',
  poke:      'ポーク',
  teamfight: 'チームファイト',
  splitpush: 'スプリットプッシュ',
  peel:      'ピール（ADC保護）',
  utility:   'ユーティリティ',
};

// ---- フォールバックマッチアップ生成 ------------------

function fallbackLaneAdvice(myChamp, enemyChamp, meta) {
  const my = meta[myChamp];
  const en = meta[enemyChamp];
  if (!my || !en) {
    return {
      result: 'neutral',
      tips: ['詳細なマッチアップデータがありません。基本的なポジショニングを心がけてください。'],
      keyPoints: 'チャンピオンデータ未登録',
    };
  }

  const tips = [];
  let result = 'neutral';

  // 射程比較
  const rangeScore = { short: 0, medium: 1, long: 2 };
  const myRange = rangeScore[my.range] ?? 1;
  const enRange = rangeScore[en.range] ?? 1;

  if (myRange > enRange) {
    tips.push(`${myChamp}は射程が長いため、距離を保ちながらポークしましょう`);
    result = 'slight_advantage';
  } else if (myRange < enRange) {
    tips.push(`${enemyChamp}のほうが射程が長いです。ミニオンを盾にして被弾を減らしましょう`);
    result = 'slight_disadvantage';
  } else {
    tips.push('お互いの射程は近いです。スキルの有効射程を把握してトレードを管理しましょう');
  }

  // ダメージタイプ比較
  if (my.dmg !== en.dmg) {
    const myDmgLabel = my.dmg === 'physical' ? '物理' : my.dmg === 'magic' ? '魔法' : '混合';
    const enDmgLabel = en.dmg === 'physical' ? '物理' : en.dmg === 'magic' ? '魔法' : '混合';
    tips.push(`あなたは${myDmgLabel}ダメージ、相手は${enDmgLabel}ダメージです。それぞれ対応する防御アイテムに注意`);
  }

  // スタイルアドバイス
  const styleAdvice = {
    engage:    '積極的なエンゲージを狙い、集団戦で存在感を出しましょう',
    burst:     'コンボを確実に入れて瞬間火力を活かしてください',
    poke:      '安全な距離からスキルポークを継続し、体力差を作ってから本格戦',
    teamfight: '集団戦での継続火力を活かし、集団状況を作りましょう',
    splitpush: 'サイドレーンへのプレッシャーを意識し、TP参加で有利を広げましょう',
    peel:      'ADC・キャリーの周囲にいてCCやシールドで守り続けましょう',
    utility:   'チームバフとユーティリティスキルでチームメイトを強化しましょう',
  };

  if (styleAdvice[my.style]) {
    tips.push(styleAdvice[my.style]);
  }

  // 相手スタイルへの対処
  const counterAdvice = {
    engage:    '相手はエンゲージ型。フラッシュやダッシュスキルでCCを回避できる準備をしましょう',
    burst:     '相手はバースト型。HPを7割以上に保ち、一気に削られないポジションを意識',
    poke:      '相手はポーク型。ミニオンを盾にしてスキルを遮断しましょう',
    teamfight: '相手は集団戦型。集団状況を避けてオブジェクトで分散させましょう',
    splitpush: '相手はスプリット型。一人で対応せず、テレポートやマップ優位で対処',
    peel:      '相手はピール型。ADCではなく、支援しているサポートを先に倒しましょう',
    utility:   '相手はユーティリティ型。バフが来る前に先にエンゲージしてアドバンテージを奪う',
  };

  if (counterAdvice[en.style]) {
    tips.push(counterAdvice[en.style]);
  }

  // 5番目のヒント
  tips.push('ガンクのサポートを活用してレーン圧力を高めましょう');

  const resultLabel =
    result === 'slight_advantage' ? 'slight_advantage' :
    result === 'slight_disadvantage' ? 'slight_disadvantage' : 'neutral';

  return {
    result: resultLabel,
    tips: tips.slice(0, 4),
    keyPoints: `${myChamp}（${COMP_LABELS[my.style] ?? my.style}）vs ${enemyChamp}（${COMP_LABELS[en.style] ?? en.style}）の汎用分析`,
    isFallback: true,
  };
}

// ---- チームシナジー分析 ------------------------------

function analyzeTeamSynergy(myComp, enemyComp) {
  const adviceMap = {
    'engage_vs_poke': 'エンゲージ vs ポーク。フラッシュを使って一気に詰めるか、ポーク射程外からのアプローチを狙いましょう。ガンク前にオラクルレンズでワードを破壊し視界を奪ってからエンゲージする動きが効果的です。',
    'engage_vs_burst': 'エンゲージ vs バースト。タンクがCCをかけた直後にバーストが重なると壊滅的なダメージが出せます。エンゲージ→バーストの連携でキルを量産しましょう。',
    'poke_vs_engage': 'ポーク vs エンゲージ。相手がエンゲージする前に体力を60%以下に削ることが目標。エンゲージが来る前にプッシュして体力有利を作りましょう。',
    'poke_vs_teamfight': 'ポーク vs チームファイト。集団状況を避けてポーク戦を強いましょう。相手が全体HP60%未満でないとエンゲージしてこないよう圧力をかける。',
    'burst_vs_peel': 'バースト vs ピール。相手のピール対象（ADC）ではなくサポートを先に排除することでピール価値を下げましょう。',
    'teamfight_vs_splitpush': 'チームファイト vs スプリット。3〜4人でオブジェクトを取り続け、スプリット側のプレイヤーに一人で対応させる展開が有利。集団状況の数的優位を活かす。',
    'splitpush_vs_teamfight': 'スプリット vs チームファイト。相手が集団で来るため、テレポートやアビリティで戦線維持が必要。スプリット役は常にTPを温存し、集団戦に参加できる準備をしておく。',
  };

  const typeStr = `${myComp[0] ?? 'neutral'}_vs_${enemyComp[0] ?? 'neutral'}`;
  const advice = adviceMap[typeStr] ?? '標準的な構成同士の対面です。オブジェクトコントロールと視界確保でゲームペースをつかみましょう。';

  return { myComp, enemyComp, advice };
}

// ---- メイン分析関数 ----------------------------------

export function analyzeMatchup(myPicks, enemyPicks, meta, laneMatchups) {
  // myPicks / enemyPicks は { TOP, JG, MID, ADC, SUP } の形式
  const laneResults = [];

  for (const role of ROLES) {
    const my = myPicks[role];
    const enemy = enemyPicks[role];
    if (!my || !enemy) {
      laneResults.push({ role, my, enemy, data: null });
      continue;
    }
    const staticData = lookupMatchup(laneMatchups, role, my, enemy);
    const data = staticData ?? fallbackLaneAdvice(my, enemy, meta);
    laneResults.push({ role, my, enemy, data });
  }

  const myPickList = ROLES.map(r => myPicks[r]).filter(Boolean);
  const enemyPickList = ROLES.map(r => enemyPicks[r]).filter(Boolean);
  const myComp = detectCompType(myPickList, meta);
  const enemyComp = detectCompType(enemyPickList, meta);
  const synergy = analyzeTeamSynergy(myComp, enemyComp);

  return { laneResults, synergy };
}

export { ROLES, COMP_LABELS };
