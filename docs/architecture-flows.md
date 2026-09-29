# Banto フロー図 — 認証・起動・開発・リソース追加

全体像は [architecture-overview.md](./architecture-overview.md)（特に §3 レイヤ・§6 典型フロー）を先に読む想定。

対象: ログイン／LAN／閲覧公開、初回起動、開発の3経路、CRUD 追加がどの層に載るかを知りたい人。

## 目次

1. [起動時の3環境と provider 選択](#1-起動時の3環境と-provider-選択)
2. [保護ルートへの入り方（`(app)` ガード）](#2-保護ルートへの入り方app-ガード)
3. [ログイン（資格情報 → トークン）](#3-ログイン資格情報--トークン)
4. [閲覧公開（合成 viewer）の位置づけ](#4-閲覧公開合成-viewer-の位置づけ)
5. [初回起動・セットアップ](#5-初回起動セットアップ)
6. [開発ループの3経路](#6-開発ループの3経路)
7. [add-resource × レイヤ対応](#7-add-resource--レイヤ対応)
8. [関連ドキュメント（リポジトリ）](#関連ドキュメントリポジトリ)

---

## 1. 起動時の3環境と provider 選択

`apps/admin-template/src/lib/banto/setup.ts` が `bantoReady` 解決時に一度だけ分岐する。

```mermaid
flowchart TD
  START["アプリ起動<br/>routes/+layout.svelte が bantoReady を待つ"]
  T{"isTauri()?"}
  E{"isEmbeddedServer()?<br/>GET /api/auth/check プローブ"}
  TAURI["mode: tauri<br/>TauriDataProvider / TauriAuthProvider<br/>TauriEventProvider"]
  SERVER["mode: server<br/>HttpDataProvider / HttpAuthProvider<br/>SseEventProvider"]
  DEMO["mode: demo<br/>InMemoryDataProvider<br/>demo AuthProvider"]

  START --> T
  T -->|Yes| TAURI
  T -->|No| E
  E -->|Yes| SERVER
  E -->|No| DEMO
```

### 読み方

- **Tauri Webview** — `invoke()` のみ。LAN 向け HTTP は別プロセス内の組み込みサーバ（設定で ON のとき）。
- **embedded server** — 同一オリジンの REST + SSE。`banto-serve` や LAN ブラウザもここ。
- **demo** — `pnpm dev` / `vite preview` でバックエンドがいないとき。InMemory + デモ認証。
- 画面コンポーネントは **mode を分岐しない**（`getDataProvider()` / `getAuthProvider()` 経由のみ）。

---

## 2. 保護ルートへの入り方（`(app)` ガード）

`(app)/+layout.ts` は `bantoReady` 後に `resolveProtectedSession` → `sessionStore.load()` を実行する。

```mermaid
flowchart TD
  GUARD["(app)/+layout.ts load"]
  CHECK["resolveProtectedSession<br/>AuthProvider.check()"]
  OK{"セッション有効?"}
  PV{"LAN かつ<br/>viewerPublic ON?"}
  ENTER["enterPublicViewer()<br/>POST /api/auth/public-viewer"]
  LOGIN["redirect /login"]
  LOAD["sessionStore.load()<br/>establishSession + role 確定"]
  ALLOW{"publicViewer セッション?"}
  NAV["publicNavItems 許可パスのみ<br/>それ以外は許可ルートへ redirect"]

  GUARD --> CHECK
  CHECK --> OK
  OK -->|Yes| LOAD
  OK -->|No| PV
  PV -->|Yes| ENTER
  ENTER --> LOAD
  PV -->|No| LOGIN
  LOAD --> ALLOW
  ALLOW -->|Yes| NAV
  ALLOW -->|No| PAGE["子ルートを表示"]
  NAV --> PAGE
```

### 読み方

- **有効トークン**があればそのまま `establishSession` で identity / role を確定（Remember me は HTTP 側の localStorage）。
- **無効・未ログイン**かつ **閲覧公開 ON** の LAN だけ、合成 `viewer` トークンを発行（ADR-0012）。Tauri ウィンドウと demo にはこの入口はない。
- サーバ到達不能・check 失敗時は **503 リトライ画面**（トークンは消さない — Issue #204）。
- `publicViewer` は **画面ナビの allowlist** 用。データアクセスの境界は RBAC の `viewer` ロール側。

---

## 3. ログイン（資格情報 → トークン）

LAN / 組み込みサーバ経路の例。Tauri は同じ契約を `invoke(auth_login)` に載せ替える。

```mermaid
sequenceDiagram
  participant U as 利用者
  participant LP as /login
  participant AP as HttpAuthProvider
  participant REST as REST auth ルート
  participant GU as (app) ガード

  U->>LP: ユーザー名・パスワード
  LP->>AP: login(...)
  AP->>REST: POST /api/auth/login<br/>+ X-Banto-Client
  REST-->>AP: token
  AP->>AP: sessionStorage / localStorage に保存
  LP->>GU: 遷移
  GU->>AP: check() / getIdentity()
  GU->>GU: sessionStore.role 確定
```

### 読み方

- 初回未初期化 DB では **setup** 画面（管理者作成）が先。initialized は `GET /api/auth/status` 等。
- HTTP リクエストは **CSRF 用カスタムヘッダ** + **Bearer トークン**（ログイン後）。
- デスクトップの **認証無効モード（M11）** は Tauri 専用。LAN との併用ルールは設定画面と `viewer-public` 計画書が一次情報。

---

## 4. 閲覧公開（合成 viewer）の位置づけ

```mermaid
flowchart LR
  subgraph lan["LAN ブラウザ（server mode）"]
    A["ログイン無しでアクセス"]
    B["POST /api/auth/public-viewer"]
    C["Bearer トークン<br/>identity.publicViewer"]
    D["viewer ロールで REST 読取"]
  end

  subgraph cfg["設定（デスクトップから）"]
    S["server.viewer_public = ON"]
  end

  S -.->|有効時のみ| B
  A --> B --> C --> D
```

### 読み方

- 設定トグルは **デスクトップ設定**から。OFF なら public-viewer 発行は 403。
- 合成セッションは **mutating を RBAC で拒否**（監査の扱いは conventions / viewer-public-plan 参照）。
- display プリセットは初回起動シード等で閲覧公開を既定 ON にする想定（[architecture-overview.md §4](./architecture-overview.md)）。

---

## 5. 初回起動・セットアップ

プロセス起動直後のシードと、初代アカウント／ログイン不要モード／LAN オプトインの関係。

### 5.1 プロセス起動（Rust）

```mermaid
flowchart TD
  RUN["src-tauri run() または banto-serve"]
  DB["DB 初期化<br/>migrations"]
  SET["SettingsService 生成"]
  SEED["seed_first_boot_settings<br/>settings が空のときだけ"]
  AUTH["Users / Auth 状態を読む"]
  LAN{"server.enabled?}
  EMB["組み込み HTTP 起動"]
  UI["Webview または静的 UI"]

  RUN --> DB --> SET --> SEED --> AUTH
  AUTH --> LAN
  LAN -->|Yes| EMB --> UI
  LAN -->|No| UI
```

### 読み方

- **`FIRST_BOOT_SETTINGS`**（`admin-template-core` の `first_boot.rs`）はテンプレート出荷では **空**。`settings` に1行でもあればシードしない。
- `pnpm scaffold --preset display` だけが非空リストへ差し替え（認証無効・閲覧公開・LAN 公開など）。仕組み自体は常在。
- シードは **auth_config / server_config を読む前**に走るので、初回起動から既定が効く。

### 5.2 初回画面（フロント）

```mermaid
flowchart TD
  LOGIN["/login"]
  ST["AuthProvider.status()"]
  INIT{"initialized?"}
  SETUP["セットアップ UI<br/>初代 admin 作成"]
  LOGINUI["通常ログイン UI"]
  SKIP{"Tauri かつ<br/>スキップ選択?"}
  CREATE["setup() / auth_setup<br/>admin アカウント"]
  NOLOGIN["auth.disabled=true<br/>ロール admin で合成セッション"]
  APP["(app) へ"]

  LOGIN --> ST --> INIT
  INIT -->|No| SETUP
  INIT -->|Yes| LOGINUI
  SETUP --> SKIP
  SKIP -->|アカウント作成| CREATE --> APP
  SKIP -->|ログインなしで始める| NOLOGIN --> APP
  LOGINUI --> APP
```

### 読み方

- **`initialized == false`** のときだけセットアップフォーム。通常は初代 admin を `setup` で作る。
- **「ログインなしで使い始める」**は **Tauri のみ**（`docs/recipes/no-login-app.md`）。LAN 初回には出ない。
- スキップはアカウント 0 のまま `auth.disabled` を ON にし、synthetic session（`local`）でダッシュボードへ。
- demo（`pnpm dev`）は別系。本物の first_boot / LAN シードは使わない。

### 5.3 LAN オプトインとの関係

```mermaid
flowchart LR
  subgraph desk["デスクトップ設定"]
    A1["認証: 通常 / 無効"]
    A2["閲覧公開 ON/OFF"]
    A3["LAN アクセス ON/OFF<br/>bind / port"]
  end

  A1 --> A2
  A2 --> A3
  A3 -->|"保存して適用"| S["server_apply<br/>組み込みサーバ起動"]
```

### 読み方

- 組み込みサーバは **既定 OFF**。利用者が設定で ON（または display シード）。
- **認証無効 + LAN** は、閲覧公開 ON のときだけ許可（表示専用アプリの標準形）。詳細は viewer-public / no-login レシピ。
- LAN 有効化後の URL / QR は設定画面から。ブラウザ側の入り方は [§2](#2-保護ルートへの入り方app-ガード)・[§4](#4-閲覧公開合成-viewer-の位置づけ)。

---

## 6. 開発ループの3経路

フロント／バックをどの組み合わせで回すか。いずれも同じ SvelteKit アプリだが、provider と永続化が違う（[§1](#1-起動時の3環境と-provider-選択)）。

```mermaid
flowchart LR
  subgraph pathA["A. pnpm dev"]
    V["Vite :1420"]
    IM["InMemory + demo 認証"]
    V --- IM
  end

  subgraph pathB["B. banto-serve"]
    BS["admin-template-core バイナリ"]
    REST["REST + SSE + 静的 UI"]
    DBB[("SQLite / Postgres")]
    BS --- REST --- DBB
  end

  subgraph pathC["C. tauri dev"]
    TW["Tauri Webview"]
    INV["invoke → サービス"]
    DBC[("SQLite 等")]
    EMB2["組み込み HTTP<br/>設定でオプトイン"]
    TW --- INV --- DBC
    TW -.-> EMB2
  end
```

### 使い分け

| 経路 | コマンド（要約） | mode | 向いていること |
|---|---|---|---|
| A | `pnpm dev` | `demo` | UI だけの高速イテレーション。Rust / Tauri 不要 |
| B | `pnpm build` → `cargo run -p admin-template-core --bin banto-serve --features embed-ui` | `server` | LAN / REST を Tauri なしで確認。CI・コンテナ向き |
| C | `pnpm --filter admin-template tauri dev` | `tauri` | 本番に近いデスクトップ。`invoke`・キーリング・LAN トグル |

### 読み方

- **A** はバックエンドなし。データはメモリ上のデモ。認証もデモ用。
- **B** はフルスタック HTTP。既定ポート `8721`、`BANTO_DB` / `BANTO_VIEWER_PUBLIC` / `BANTO_ALLOW_SETUP` などで挙動調整。`embed-ui` 無しだとプレースホルダ UI。
- **C** の Webview は常に開発中フロントを表示。LAN クライアントに実 UI を出す本番ビルドでは `embed-ui` が別途必要（README「embed-ui」）。
- 検証の常用は `pnpm check` / `cargo test` / `pnpm e2e`（e2e は多くの場合 `banto-serve`）。`src-tauri` コンパイルはこのサンドボックスでは不可なことがある。

---

## 7. add-resource × レイヤ対応

正式手順はリポジトリの `docs/recipes/add-resource.md`。ここでは [architecture-overview.md §3](./architecture-overview.md) の層に、チェックリストの各ステップがどこを触るかを対応づける索引。

| # | レシピのステップ | 主に触る層 | 置き場の目安 |
|---|---|---|---|
| 1 | マイグレーション | 永続化（DB） | `core/migrations-sqlite/` + `migrations-postgres/` |
| 2 | サービス層 | サービス | `core/src/<resource>.rs` |
| 3 | REST ルート | wiring（REST） | `core/src/rest/<resource>.rs` + `rest/mod.rs` |
| 4 | Tauri コマンド | wiring（Tauri） | `src-tauri/src/lib.rs` |
| 5 | 両経路の認可対称テスト | wiring（両経路） | `rest/tests` / サービス・コマンドのテスト |
| 6 | 監査イベント確認 | wiring | 同上（mutating のみ） |
| 7 | リソース定義・スキーマ | UI + admin-core 契約 | `src/lib/banto/resources/` |
| 8 | ページ・ナビ | UI | `routes/(app)/…`・`navigation.ts` |
| 9 | ダッシュボード / CSV / e2e（任意） | UI + 検証 | `dashboard.ts`・e2e 等 |

```mermaid
flowchart LR
  subgraph recipe["add-resource 手順の流れ"]
    S1["1 DB"]
    S2["2 サービス"]
    S34["3+4 wiring 両経路"]
    S56["5+6 対称テスト"]
    S78["7+8 フロント"]
    S9["9 任意"]
    S1 --> S2 --> S34 --> S56 --> S78 --> S9
  end
```

### 読み方

- **対象読者**: 新 CRUD を足すとき「いまどの層の作業か」を overview と突き合わせたい人・エージェント。
- **順序は Rust → フロント**。3 と 4 はペア（片方だけ足さない）。5・6 が対称性のゲート。
- provider 実装自体は通常いじらない（既存の Tauri/HTTP/InMemory が `DataProvider` 契約でリソース名を運ぶ）。
- InMemory デモに出すなら任意で `sampleData.ts`（[§6](#6-開発ループの3経路) の経路 A）。出さない機能は demo で明示拒否。
- 更新1回の実行時の流れは [architecture-overview.md §6](./architecture-overview.md) と本ファイルの認証節を参照。

---

## 関連ドキュメント（リポジトリ）

| 用途 | パス |
|---|---|
| provider 契約 | `packages/admin-core/src/provider.ts` |
| HTTP 認証実装 | `packages/admin-core/src/providers/http.ts` |
| 組成・3環境 | `apps/admin-template/src/lib/banto/setup.ts` |
| 埋め込みサーバ判定 | `apps/admin-template/src/lib/banto/environment.ts` |
| ルートガード | `apps/admin-template/src/routes/(app)/+layout.ts` |
| 初回シード | `apps/admin-template/core/src/first_boot.rs` |
| ログイン／セットアップ UI | `apps/admin-template/src/routes/login/+page.svelte` |
| ログイン無しレシピ | `docs/recipes/no-login-app.md` |
| display 既定 | `docs/display-preset-plan.md` |
| 開発コマンド | `README.md`「開発」「`banto-serve`」 |
| CRUD 追加手順 | `docs/recipes/add-resource.md`（本ファイル §7 は層の索引） |
| 閲覧公開計画 | `docs/viewer-public-plan.md` / `docs/adr/0012-lan-public-viewer-synthetic-session.md` |
