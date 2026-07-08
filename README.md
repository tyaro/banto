# Banto（番頭）

Tauri v2 + SvelteKit（Svelte 5 Runes）向けのフルスタック管理画面
フレームワーク/テンプレート。refineライクなヘッドレスコアに、独自の
データグリッド・スキーマ駆動フォーム・チャート・ドッキングレイアウトを
組み合わせる。

名称は、江戸時代の商家で主人に代わって店を切り盛りした「番頭」に由来。

- 仕様書: [docs/ui-framework-spec.md](docs/ui-framework-spec.md)
- 機能拡張ロードマップ（M10〜）: [docs/roadmap.md](docs/roadmap.md)
- 公開手順: [docs/publishing.md](docs/publishing.md)
- ライセンス: [MIT](LICENSE)
- npmスコープ: `@banto/*` / Rustクレート: `banto-*`

## 主な機能

- **データグリッド**（`@banto/grid-svelte`）: 仮想スクロール、複数列ソート、
  列フィルタ、列リサイズ/並び替え、Excelライクなセル編集・範囲選択・
  コピー&ペースト、クライアント/サーバー両モード、グルーピング+集計。
- **スキーマ駆動フォーム**（`@banto/forms`）: 定義オブジェクトから入力UI・
  バリデーション・状態管理を自動生成。
- **チャート**（`@banto/charts`）: 依存ライブラリなしのSVGフルスクラッチ。
  折れ線/エリア・棒・円/ドーナツ・散布図・スパークライン。
- **ドッキングレイアウト**（`@banto/dock-svelte`）: フローティングウィンドウ +
  分割・タブ化・ドラッグでの再配置・スナップ、レイアウトのJSON保存/復元。
- **refineライクなコア**（`@banto/admin-core`）: リソース定義、
  `DataProvider`/`AuthProvider`抽象、`createListResource`/`createFormResource`
  コンポーザブル。バックエンドはTauri `invoke()`（ローカルRust）を既定に、
  InMemory/HTTP を差し替え可能。
- **組み込みWebサーバ**（`banto-server`）: 設定でオプトイン有効化すると、
  同一LAN内の他端末のブラウザからREST + SSEで同じ画面を利用可能。

## 構成

npm パッケージ（`packages/`、すべて `@banto/*`、MIT、現状はモノレポ内で
ソース直接参照 — 公開する場合は [docs/publishing.md](docs/publishing.md)）:

| パッケージ | 内容 |
|---|---|
| `@banto/admin-core` | リソース定義・データ/認証プロバイダ・Runesコンポーザブル |
| `@banto/grid-svelte` | データグリッド（仮想化・編集・ソート/フィルタ・グルーピング） |
| `@banto/forms` | スキーマ駆動フォーム + 入力コンポーネント |
| `@banto/charts` | SVGチャート（折れ線/棒/円/散布図/スパークライン） |
| `@banto/dock-svelte` | ドッキング/フローティングレイアウト |
| `@banto/theme` | CSS変数テーマ + ライト/ダーク/システム切替 |

Rust クレート（`crates/`、MIT）:

| クレート | 内容 |
|---|---|
| `banto-core` | 共通型（ListParams/SortState/FilterState/エラー型） |
| `banto-storage` | sqlxリポジトリ（SQLite/PostgreSQL、ホワイトリスト式クエリ） |
| `banto-server` | 組み込みaxumサーバ（REST・SSE・認証・静的配信） |

アプリ（`apps/admin-template/`）: Tauri v2 + SvelteKit の管理画面テンプレート
本体。`core/`（tauri非依存のサービス層 `admin-template-core`）と
`src-tauri/`（薄いコマンドアダプタ）に分かれる。

## 開発

前提: Node 24+ / pnpm 10+ / Rust（Tauriの[プラットフォーム別前提条件](https://tauri.app/start/prerequisites/)）

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

## LANアクセス（組み込みWebサーバ、M6）

デフォルトは無効（`invoke()`専用、攻撃面ゼロ）。設定画面から有効化すると、
同一LAN内の他端末のブラウザから同じ管理画面をREST API + SSEで利用できる
（仕様 §11）。

**有効化手順:**

1. デスクトップアプリの設定画面 →「LANアクセス（組み込みWebサーバ）」で
   トグルをON、バインドアドレス（`0.0.0.0`でLAN公開）・ポート番号を設定し
   「保存して適用」。
2. 表示されたURL/QRコードから、同一LAN内の他端末のブラウザでアクセスし、
   初回起動時（Tauriウィンドウまたはこのブラウザ自身）に作成した
   管理者アカウントでログイン。まだアカウントがなければ初回セットアップ
   画面が表示される。

**`banto-serve`（Tauri不要の開発用バイナリ）:**

```sh
pnpm --filter admin-template build   # apps/admin-template/build を生成
cargo run -p admin-template-core --bin banto-serve --features embed-ui
```

Tauriを起動せずにREST + 静的配信のフルスタックを試せる（`--features
embed-ui`を省略すると組み込みのプレースホルダページを返す）。環境変数
`PORT`（既定8721）/ `BANTO_BIND`（既定`0.0.0.0`）/ `BANTO_DB`（既定
`./banto-dev.sqlite3`）。

**`embed-ui`フィーチャー:**

- `admin-template-core`はデフォルトでフロントエンドを埋め込まない
  （プレースホルダページのみ）。`pnpm --filter admin-template build`で
  フロントをビルドしてから`--features embed-ui`を付けて再ビルドすると、
  実際のSvelteKitビルドが埋め込まれる。
- src-tauri（デスクトップアプリ本体）も同名のパススルーfeatureを持つ:
  `tauri build --features embed-ui`（または`cargo build -p admin-template
  --features embed-ui`）を指定しないと、LANアクセス経由のブラウザには
  プレースホルダページしか返らない（Tauriウィンドウ自体の表示には影響
  しない — Webview は常にバンドルされた実フロントを表示する）。

**セキュリティ注意:**

- v1は「信頼できるLAN内でのHTTP + トークン認証」という割り切り。TLSは
  未実装（v2以降で検討）。**信頼できるLAN以外では有効化しないこと。**
  HTTPのみのため、ログイン情報やセッショントークンは平文でLAN内を流れる。
- 認証はargon2id資格情報ストア + 初回セットアップ実装済み
  （`apps/admin-template/core/src/users.rs`。固定パスワードのデモ実装
  ではない）。セッショントークンは絶対8時間/アイドル1時間で自動失効し、
  ログインは5回連続失敗で60秒ロックアウトされる（いずれも
  `banto-server`の`TokenPolicy`/`RateLimitPolicy`で変更可能）。
  Tauriウィンドウのセッションと LANブラウザ側（REST/SSE）のセッションは
  独立したトークン空間。

## Windowsでのローカルセットアップ

前提ツール（未導入のもののみ）:

1. **Node.js 24+**: https://nodejs.org/
2. **pnpm 10+**: 管理者不要。`corepack enable pnpm` または `npm i -g pnpm`
3. **Rust**: https://rustup.rs/ （MSVCツールチェーン。インストーラの指示に従い
   Visual Studio Build Tools の「C++によるデスクトップ開発」を入れる）
4. **WebView2 Runtime**: Windows 10/11 は通常プリインストール済み
   （詳細: https://tauri.app/start/prerequisites/ ）

セットアップ（PowerShell / コマンドプロンプト）:

```powershell
cd D:\develop
git clone https://github.com/tyaro/banto.git banto
cd banto
pnpm install

# デスクトップアプリとして起動（初回はRustのコンパイルで数分かかります）
pnpm --filter admin-template tauri dev
```

初回起動時は管理者アカウント作成画面が表示されるので、ユーザー名・
表示名・パスワード（8文字以上）を入力してアカウントを作成する。以降の
起動ではそのアカウントでログインする。Tauriウィンドウ内ではRust+SQLite
（初回起動時に1,000件シード）、ブラウザ実行（`pnpm dev`）ではInMemory
（10,000件）が自動選択される。SQLiteファイルは
`%APPDATA%\dev.banto.admin\admin-template.sqlite3` に作成される。

補足:

- Windowsでは`tauri dev`/`tauri build`に`icons/icon.ico`が必須（同梱済み）。
  独自アイコンに差し替える場合は`pnpm --filter admin-template tauri icon
  <画像>`で全形式を再生成できる。
- 認証はargon2id資格情報ストア + 初回セットアップ実装済み（`users`テーブル、
  `apps/admin-template/core/src/users.rs`）。`pnpm dev`のブラウザ単体
  デモモード（Tauri/バックエンドなし、InMemoryデータ）のみ、Rustバック
  エンドを持たないため`admin` / `admin`固定の簡易セッション認証のまま。
- テーマ・ドックレイアウト等のUI設定の保存先は現状localStorage。将来
  `SettingsProvider`（ローカルSQLite設定DB）に移行予定（仕様 §12.1）。

## ライセンス

[MIT](LICENSE) © tyaro
