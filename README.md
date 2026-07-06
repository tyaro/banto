# Banto（番頭）

Tauri v2 + SvelteKit（Svelte 5 Runes）向けのフルスタック管理画面
フレームワーク/テンプレート。refineライクなヘッドレスコアに、独自の
データグリッド・スキーマ駆動フォーム・チャート・ドッキングレイアウトを
組み合わせる。

名称は、江戸時代の商家で主人に代わって店を切り盛りした「番頭」に由来。

- 仕様書: [docs/ui-framework-spec.md](docs/ui-framework-spec.md)
- npmスコープ: `@banto/*` / Rustクレート: `banto-*`

## 構成

```
packages/
  theme/            @banto/theme — CSS変数テーマ + ライト/ダーク/システム切替
crates/
  banto-core/       共通型（ListParams/SortState/FilterState/エラー型）とtrait
  banto-storage/    sqlxリポジトリ実装（M2で実装）
  banto-server/     組み込みaxumサーバ（M6で実装）
apps/
  admin-template/   Tauri v2 + SvelteKit 管理画面テンプレート本体
```

## 開発

前提: Node 22+ / pnpm 10+ / Rust（Tauriの[プラットフォーム別前提条件](https://tauri.app/start/prerequisites/)）

```sh
pnpm install

# ブラウザのみで開発（Tauri不要）
pnpm dev                # http://localhost:1420

# Tauriデスクトップアプリとして開発
pnpm --filter admin-template tauri dev

# 検証
pnpm check              # svelte-check + tsc
pnpm build              # SvelteKit 静的ビルド（apps/admin-template/build）
cargo check -p banto-core -p banto-storage -p banto-server
```

## Windowsでのローカルセットアップ

前提ツール（未導入のもののみ）:

1. **Node.js 22+**: https://nodejs.org/
2. **pnpm 10+**: 管理者不要。`corepack enable pnpm` または `npm i -g pnpm`
3. **Rust**: https://rustup.rs/ （MSVCツールチェーン。インストーラの指示に従い
   Visual Studio Build Tools の「C++によるデスクトップ開発」を入れる）
4. **WebView2 Runtime**: Windows 10/11 は通常プリインストール済み
   （詳細: https://tauri.app/start/prerequisites/ ）

セットアップ（PowerShell / コマンドプロンプト）:

```powershell
cd D:\develop
git clone https://github.com/tyaro/my-template.git banto
cd banto
git checkout claude/tauri-custom-ui-framework-ibbdjh
pnpm install

# デスクトップアプリとして起動（初回はRustのコンパイルで数分かかります）
pnpm --filter admin-template tauri dev
```

起動後、admin / admin でログイン。Tauriウィンドウ内ではRust+SQLite
（初回起動時に1,000件シード）、ブラウザ実行（`pnpm dev`）ではInMemory
（10,000件）が自動選択される。SQLiteファイルは
`%APPDATA%\dev.banto.admin\admin-template.sqlite3` に作成される。

補足:

- Windowsでは`tauri dev`/`tauri build`に`icons/icon.ico`が必須（同梱済み）。
  独自アイコンに差し替える場合は`pnpm --filter admin-template tauri icon
  <画像>`で全形式を再生成できる。
- 認証はデモ実装（admin/admin固定）。実運用の認証方式はアプリ側で
  `AuthProvider`を差し替えて実装する。
- テーマ設定の保存先は現状localStorage。M6で`SettingsProvider`
  （ローカルSQLite設定DB）に移行する。
