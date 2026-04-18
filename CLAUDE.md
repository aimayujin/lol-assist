# CLAUDE.md

このファイルは Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイドです。

## プロジェクト概要

**lolpick.jp** — League of Legends のチームピック分析ツール。

- **Web版**: `index.html` (ルート) を GitHub Pages で配信 → https://lolpick.jp
- **デスクトップ版**: `desktop/` 配下の Electron アプリ。LCU API でチャンプセレクトを自動検出
- **データ生成**: `scripts/` の Node.js スクリプト群でマッチアップ・勝率・ビルド情報を取得

## アーキテクチャ

### 2つの index.html の関係

- **ルート `index.html`**: Web版として配信 **かつ** デスクトップ版のホットアップデート配信元
- **`desktop/index.html`**: デスクトップ版の初回バンドル用（インストーラーに同梱）

修正は原則**両方に適用**する。desktop 側だけ直しても既存ユーザーに届かない（main.js が `lolpick.jp/index.html` を取得してホットアップデートするため）。

### デスクトップ版のコアファイル

| ファイル | 役割 |
|---|---|
| `desktop/main.js` | Electron main プロセス。ウィンドウ管理、トレイ、LCU接続、ホットアップデート、自動起動 |
| `desktop/lcu.js` | LCU API クライアント（自前実装・WMIC+HTTPS ポーリング方式） |
| `desktop/preload.js` | IPC ブリッジ（`window.lcuBridge`） |
| `desktop/index.html` | レンダラー UI（バンドル版） |

### LCU 接続方式

`league-connect` は**使わない**。`desktop/lcu.js` で自前実装:
1. `wmic PROCESS WHERE name="LeagueClientUx.exe"` でコマンドライン引数を取得
2. `--app-port` と `--remoting-auth-token` から接続情報を取り出す
3. Node.js `https` モジュールで `Basic riot:PASSWORD` 認証、`rejectUnauthorized: false`
4. 1.5秒間隔でポーリング（WebSocket/WAMP は互換性が不安定だったため不採用）

## バージョン管理とデプロイ

### バージョンの3箇所

1. `desktop/package.json` の `version` — アプリ本体のバージョン（インストーラー名に反映）
2. `version.json` の `version` — 配信側が宣言する最新バージョン
3. `version.json` の `minMainVersion` — これより古いユーザーにはインストーラー更新を強制

### ホットアップデートの仕組み

- main.js が起動3秒後に `https://lolpick.jp/version.json` を取得
- `remoteVer > CURRENT_VERSION` かつ `minMainVersion <= CURRENT_VERSION` → HTML ホットアップデート（再インストール不要）
- `minMainVersion > CURRENT_VERSION` → 更新バナー表示、インストーラー再DL必要
- ホットアップデートされた `index.html` は `%APPDATA%\lolpick.jp\hot-update\` に保存され、**次回起動時**に読み込まれる（`reloadIgnoringCache()` では切り替わらない点に注意）

### リリース手順

`desktop/main.js` や `desktop/lcu.js` 等の本体変更が絡む場合は新しいインストーラー配布が必要:

```bash
# 1. desktop/package.json のバージョンを bump
# 2. ビルド
cd desktop && npm run build:win
# 3. DLリンク更新（index.html と desktop/index.html の lolpick-setup-X.Y.Z.exe）
# 4. version.json 更新（version と必要なら minMainVersion）
# 5. コミット & push
git add ... && git commit && git push origin main
# 6. GitHub Release 作成（インストーラーと blockmap 両方アップ）
gh release create vX.Y.Z desktop/dist/lolpick-setup-X.Y.Z.exe desktop/dist/lolpick-setup-X.Y.Z.exe.blockmap --title "..." --notes "..."
```

HTML/データだけの変更なら `version.json` の `version` を bump して push するだけでホットアップデート経由で届く。

### ビルド時の注意

`npm run build:win` が `d3dcompiler_47.dll: Access is denied` で失敗する場合、`win-unpacked` の `lolpick.jp.exe` がまだ起動中。以下で強制終了してからリトライ:
```bash
taskkill //F //IM "lolpick.jp.exe"
```

## 認証・Git 操作

### GitHub 認証

`gh auth status` で確認。credential.helper は `gh auth setup-git` で設定済み。
remote URL に古い PAT が埋め込まれていると古いトークンで認証して失敗するので、クリーンな URL に戻す:
```bash
git remote set-url origin https://github.com/aimayujin/lol-assist.git
```

## 既知の落とし穴

- **カスタムゲームのロール重複**: `_parseSession` で `assignedPosition` が同じ複数プレイヤーがいると、同じキーに上書きされて片方のピックが消える。現状は未対応（ユーザー側で正しくロール割り当てする運用）。
- **scope外の変数参照**: `initLcuBridge()` のクロージャ変数 `champById` を `initDDragon()` から参照するとReferenceError。必ず同じ関数スコープ内で扱う。
- **CDN キャッシュ**: GitHub Pages は数分〜1時間キャッシュされる。`version.json` 更新直後は古いHTMLが配信される場合あり。`curl -s https://lolpick.jp/version.json` で確認可能。

## ワークフロー指針

- **変更は両方の index.html へ**: desktop/index.html とルート index.html を忘れず両方修正
- **データ変更だけで済むか判断**: `main.js`/`lcu.js`/`preload.js` に手を入れる必要があるか → 必要ならインストーラー再配布、不要ならホットアップデートで済む
- **バージョン bump を忘れない**: デプロイ時は `version.json` と（必要なら）`desktop/package.json` の両方
- **Console エラーの「正常」判定**: `/api/tierlist` などのサーバーAPIはデスクトップ版に存在しない → `ERR_FILE_NOT_FOUND` は期待動作（キャッシュにフォールバック）
- **デバッグは `lcuDebug` / `lcuTestApi`**: `desktop/preload.js` の `lcuBridge.lcuDebug()` と `lcuTestApi(endpoint)` で LCU 接続状態と API 生レスポンスを確認可能

## 静的ページ生成

SEO / AdSense 対策で、チャンピオン個別ページ・一覧・必須ページ（プライバシー等）を提供。

| ファイル | 用途 |
|---|---|
| `scripts/generate_champion_pages.js` | `src/data/*.json` + DDragon を結合して `champion/*.html` と `champions.html` と `sitemap.xml` を再生成 |
| `assets/site.css` | 静的ページ共通スタイル |
| `privacy.html` / `terms.html` / `about.html` / `contact.html` / `guide.html` / `faq.html` / `patch-notes.html` | 手動メンテナンスの独立ページ |
| `champion/*.html` (168体) | 自動生成。勝率・マッチアップTop5・パワースパイク・関連チャンプ |
| `champions.html` | 全チャンピオン一覧（ロール別・50音順） |

**データ更新後は必ず `node scripts/generate_champion_pages.js` を再実行**してチャンピオンページと sitemap を更新する。

## スキル

`.claude/skills/lol-matchup-verify/` — マッチアップデータ（勝率・有利不利・アドバイス）の誤り指摘を検証して `lane_matchups.json` と `index.html` を修正するスキル。ユーザーが「この情報が間違っている」等を指摘した場合に起動。
