/**
 * electron-builder afterPack フック
 *
 * signAndEditExecutable: false で winCodeSign 依存を避けつつ、
 * rcedit で .exe の PE リソース (FileDescription / ProductName / CompanyName 等) を
 * 書き換えてタスクマネージャーの表示を "Electron" から "lolpick.jp" に変える。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const RCEDIT_CANDIDATES = [
  // electron-builder 既存キャッシュ
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', '094733855', 'rcedit-x64.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', '072904631', 'rcedit-x64.exe'),
  // 他の候補
];

function findRcedit() {
  for (const p of RCEDIT_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  // キャッシュディレクトリを走査
  const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (fs.existsSync(cacheDir)) {
    const dirs = fs.readdirSync(cacheDir).filter(d => !d.endsWith('.7z'));
    for (const d of dirs) {
      const rcPath = path.join(cacheDir, d, 'rcedit-x64.exe');
      if (fs.existsSync(rcPath)) return rcPath;
    }
  }
  return null;
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('[after-pack] rcedit-x64.exe が見つからないため PE リソース編集をスキップ');
    return;
  }

  const exePath = path.join(context.appOutDir, 'lolpick.jp.exe');
  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] 対象exeが見つかりません: ${exePath}`);
    return;
  }

  const version = context.packager.appInfo.version;
  const args = [
    exePath,
    '--set-version-string', 'FileDescription', 'lolpick.jp - チーム構成マッチアップ分析',
    '--set-version-string', 'ProductName',     'lolpick.jp',
    '--set-version-string', 'CompanyName',     'lolpick.jp',
    '--set-version-string', 'LegalCopyright',  '© lolpick.jp',
    '--set-version-string', 'OriginalFilename','lolpick.jp.exe',
    '--set-version-string', 'InternalName',    'lolpick.jp',
    '--set-file-version',   version,
    '--set-product-version', version,
  ];

  try {
    execFileSync(rcedit, args, { stdio: 'inherit' });
    console.log(`[after-pack] ✓ PE リソース書き換え完了: ${exePath}`);
  } catch (e) {
    console.error('[after-pack] rcedit 実行エラー:', e.message);
  }
};
