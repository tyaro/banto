# レシピ: オプション資産の削除（scaffold プリセットと手動手順）

作成日: 2026-10-08（README「3. オプション資産の削除」から切り出し。トラックB＝
アプリ作者向け）

Banto の同梱物のうち「同梱するが削除できる」ことが保証されたオプション資産
（[template-scope.md §3](../template-scope.md)）を外す手順。まず `pnpm scaffold` の
プリセットでまとめて外し、scaffold が触らない資産や独自に削りたいものは
後半の手動手順で外す。**表示専用アプリを作るなら、まず [`--preset display`](#--preset-display表示専用アプリ) を読む。**

## scaffold プリセット

```bash
pnpm scaffold --preset <preset>    # minimal | standard | full | display
pnpm install                       # 外れた依存の反映（lockfile も更新される）
# --interactive で資産ごとに対話選択、--dry-run で変更内容の確認のみ
```

各プリセットが**残す**オプション資産（✓＝残す / ✗＝外す。コアは全プリセットで常在）:

| オプション資産                                                           | minimal | standard | full |    display    |
| ------------------------------------------------------------------------ | :-----: | :------: | :--: | :-----------: |
| `@banto/charts` / `@banto/dock-svelte` / Glass テーマ / コマンドパレット |    ✗    |    ✓     |  ✓   |       ✗       |
| `@banto/attachments` / `@banto/report` / `@banto/tree-svelte` のデモ     |    ✗    |    ✗     |  ✓   |       ✗       |
| `@banto/touch-keys-svelte` の見本（`/ui-demo` のカード）                 |    ✗    |    ✗     |  ✓   |       ✗       |
| `items` デモリソース一式                                                 |    ✓    |    ✓     |  ✓   | ✗（追加削除） |

- テンプレートは `full` 相当で出荷され、scaffold は基本「引く」だけ。`display` だけが
  「足す」工程も持つ（下記）。
- `@banto/scan-wedge` はレシピのみ・テンプレート未配線のため scaffold は触れない
  （[scan-wedge.md](scan-wedge.md)）。
- `@banto/image-assets` もテンプレート未配線（アプリが依存しない）のため scaffold は触れない
  （下記「`@banto/image-assets`」、[ADR-0020](../adr/0020-image-assets-package.md)）。
- `@banto/touch-keys-svelte` の配線は `/ui-demo` のカード 1 枚だけで、`full` 以外のプリセットが外す
  （下記「`@banto/touch-keys-svelte`」、[ADR-0036](../adr/0036-touch-keys-package.md)）。パッケージ本体は残る。
- 設計は [design/scaffold-presets-plan.md](../design/scaffold-presets-plan.md)、
  受け入れ検査は `.github/workflows/template-acceptance.yml`（4 プリセットの
  scaffold → verify:architecture → check → build → cargo test）。

## `--preset display`（表示専用アプリ）

```bash
pnpm scaffold --preset display
pnpm install          # 外れた依存の反映（lockfile も更新される）
```

カンバン（アンドン）・常設ダッシュボード・展示デモのように、**画面を出しっぱなしに
して眺めるだけ**のアプリ向けの初期状態にする。唯一「外す」だけでなく「足す」も
行うプリセット（他は削除のみ）。設計は
[design/display-preset-plan.md](../design/display-preset-plan.md)（Issue #190）。

**外れるもの**

| 区分               | 内容                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| オプション資産     | `minimal` と同じ（charts / dock / Glass / コマンドパレット / 添付 / 帳票 / ツリー）                                                                                                                                                                                                                                                                                        |
| items デモリソース | `core/src/items.rs`・`core/src/rest/items.rs`・`migrations-{sqlite,postgres}/0001_items.sql`・`src-tauri` の `items_*` コマンド・`routes/(app)/items/**`・`#lib/banto/{itemsAdmin,resources/items,sampleData,dashboard}.ts`・ナビ項目・`messages` の `items.*`／`nav.items`・`verify-architecture` の items マニフェスト行                                                 |
| 管理画面           | `routes/(app)/users/**` と `routes/(app)/audit-log/**`（**画面だけ**。サービス層・REST・Tauri コマンドは残るので、ルートを足し直せば戻せる）                                                                                                                                                                                                                               |
| ダッシュボード     | `routes/(app)/dashboard/**`。ホーム（`/`）とログイン後の遷移先は `/monitor` になる                                                                                                                                                                                                                                                                                         |
| e2e / ビジュアル   | 同梱スモークは items/users 画面前提なので、**シナリオ1本**のスモークに差し替わる（未ログインの `/` が `/monitor` に着く）。`e2e/tests-public-viewer/`・`e2e/visual/`（ベースライン画像を含む）・`playwright.config.ts` の該当 project／webServer・ルート `package.json` の `e2e:visual`／`e2e:public-viewer`・`ci.yml` の該当ステップ・`visual-baselines.yml` は削除される |

**足されるもの / 既定値が変わるもの**

- `src/routes/(app)/monitor/+page.svelte` — 時計と「最終更新」だけの最小ページ。
  `$effect` + 世代トークンのポーリング雛形が入っているので、`load()` を自分の
  **読み取り専用**の取得に差し替えて使う。ナビは `{ publicViewer: true }` で登録される。
- **初回起動の既定**（`apps/admin-template/core/src/first_boot.rs` の
  `FIRST_BOOT_SETTINGS`。`settings` テーブルが空のときだけ書き込まれる）:
  `auth.disabled=true` / `auth.disabled_role=admin` / `server.viewer_public=true` /
  `server.enabled=true` / `server.bind=0.0.0.0`。
  つまり**コピーして起動した瞬間から、LAN の未ログイン端末が合成 `viewer`
  セッションで `/monitor` を見られる**（[ADR-0012](../adr/0012-lan-public-viewer-synthetic-session.md)）。
  書き込みは RBAC の `viewer` 床で 403 のまま。既定を変えたければこの const を編集する。
- **キオスクシェル既定 ON**（`src/lib/settings.svelte.ts` の `KIOSK_DEFAULT`）:
  サイドバー折り畳み・ヘッダのコンパクト化・全画面ボタン。設定画面「外観」で戻せる。
- **`banto.i18n = "raw"`**（`apps/admin-template/package.json`）: 単一言語アプリとして
  UI 文言を直書きしてよい opt-out。`verify:architecture` の `raw-jp-in-app` と
  `check-i18n-nonempty` が自身をスキップする（[conventions.md §13](../conventions.md#i18n-messages)）。
  多言語に戻したいときは `"keys"` に戻し、`/monitor` の文言を `messages/{ja,en}.json` へ移す。

**注意**

- **セキュリティ**: 初回起動の既定は「LAN に閲覧公開する」設定。社外ネットワークに
  出す用途では、`first_boot.rs` の `server.viewer_public` / `server.bind` を見直すこと
  （[lan-access.md](lan-access.md) のセキュリティ注意）。
- [add-resource.md](add-resource.md) は **items がある前提**で書かれている。display では
  items 一式が無いので、「items をコピーして書き換える」ステップは「レシピ本文のコード片を
  新規ファイルとして起こす」と読み替える（層別のファイル一覧と配線先はそのまま使える）。
- `pnpm install --frozen-lockfile` は通らない（`apps/admin-template/package.json` から
  workspace 依存が5つ消えるため）。scaffold 直後は `pnpm install` を使う。

## 手動手順（資産別）

scaffold の各 remover はこの手順を 1 対 1 で自動化したもの（`scripts/scaffold.mjs`）。
scaffold が触らない箇所（`src-tauri` 側のポップアウト配線・システムメトリクス）は
ここだけに手順がある。

### `@banto/dock-svelte`（ダッシュボードのドッキングレイアウト）

`apps/admin-template/src/routes/(app)/dashboard/+page.svelte` の
`DockHost`/`dock`/`onPopOut` 関連コード（`[scaffold:dock]` の印で挟んだ 7 つの領域: import・script・pane を開閉する「表示」メニュー `PageViewMenu` の
配置・ページの幅の計測・dock・メモを閉じるときの確認・snippet。`PageViewMenu.svelte`・`src/lib/pageViewMenu.svelte.ts` 自体はシェルの汎用の口なので残す。#663）、ダッシュボードの登録 `src/lib/banto/dashboardWidgets.ts` の `[scaffold:dock]` の領域
（メモのウィジェットの import と登録の行。チャートと一覧のウィジェットの登録は残る）と、その単体テスト `dashboardWidgets.test.ts` の同じ印の領域、
`src/lib/banto/dashboardLayout.ts` とその `.test.ts`（既定の配置・dock の高さ・保存キー・保存値の確かめ。#716）・
`src/lib/components/dashboard/MemoWidget.svelte`・`src/lib/components/PanelIcon.svelte`（#716）・
`src/lib/banto/popout.ts`・`src/lib/banto/dockEscape.ts` とその `.test.ts`（dock の gesture の
Esc をどの層に譲るか。#433）・`src/lib/banto/dockMessages.ts` とその `.test.ts`（dock の文言を `dock.*` から作る。`messages/{ja,en}.json` の `dock.*` キーも外す。#729）・`src/lib/banto/dockTitles.ts` とその `.test.ts`（保存済みレイアウトの title を今の言語で引き直す。#729）（レイアウトの保存の部品は `@banto/dock-svelte` の中にあるので、パッケージと一緒に外れる。ダッシュボードの `currentSessionScope`・`isCurrentSessionScope` の import と、ダッシュボードの dock の保存を見る `e2e/demo/dashboard-layout-commit.spec.ts` も外す。#791）・`src/routes/panel/[id]/`（ポップアウト先の
スタンドアロンウィンドウ用ルート）、メモ pane の draft と確認ダイアログ
（`src/lib/banto/dashboardMemo.svelte.ts`・`src/lib/banto/settlePrompt.svelte.ts` と
それぞれの `.test.ts`、`src/lib/components/DashboardMemoField.svelte`・
`src/lib/components/DraftSettleDialog.svelte`。#432。メモの Ctrl+S の登録もここ。#435）を削除する。印の領域を切った後の
ダッシュボードは、KPI の帯の下に、登録に残ったウィジェット（チャートと一覧）を登録の順に 1 列で積む
（`src/lib/components/dashboard/DashboardWidgetStack.svelte`。配置の編集と保存は無い。dock があるときも、ページの幅が 900px 以下なら
同じ表示になる。#716）。ページの `stackView` は、領域を切った後の既定（いつも積む・登録を全部出す）のまま残る。3 ペインの dock 版の見本（`ThreePaneDock`、#663 ④）
`src/routes/(app)/tree/workspace-dock/`（ルート丸ごと。固定版の見本 `tree/workspace/` は残る）も削除し、
`/tree` の索引（`src/routes/(app)/tree/+page.svelte`）の「dock 版」のリンクカードと
`messages/{ja,en}.json` の `tree.workspaceDock.*` キーを外す（ツリーデモごと消すなら、これらはツリーの削除に含まれる）。
`apps/admin-template/package.json` の
`@banto/dock-svelte` 依存と、`apps/admin-template/vite.config.ts` の
`optimizeDeps.exclude` にある `'@banto/dock-svelte'` 行を外す（残すと
`pnpm verify:architecture` の `optimizedeps-svelte-source` が「不要なのに
登録」で落ちる。[ADR-0007](../adr/0007-derived-app-dev-optimizer-exclude.md)）。

あわせて **`src-tauri` 側**の以下も外す。ポップアウト専用の配線であり、
残すと呼び出し元のない孤立コード + 不要なウィンドウ権限になる
（`pnpm scaffold` は `src-tauri` を書き換えないため、ここは常に手作業）:

- `apps/admin-template/src-tauri/src/lib.rs` の `.plugin(banto_tauri_panel::init())`
  （パネルの窓の plugin の登録。[ADR-0037](../adr/0037-tauri-panel-plugin.md)）
- `apps/admin-template/src-tauri/Cargo.toml` の `banto-tauri-panel` の依存
- `apps/admin-template/src-tauri/capabilities/default.json` の `"permissions"` の
  `"banto-tauri-panel:allow-open"`（依存を外した後に残すと、`tauri-build` が「知らない permission」で落ちる）と、
  `"windows"` 配列内 `"panel-*"` エントリ（ポップアウトウィンドウのケイパビリティ許可）

crate 本体（`crates/banto-tauri-panel`）は、モノレポを写したアプリなら workspace の member として残してよい
（どこからも依存されなければビルドに入らない）。消すなら、ルートの `Cargo.toml` の `members` と
`[workspace.dependencies]` の行も外す。

### `@banto/charts`（SVGチャート）

ダッシュボードのチャートは「登録 1 件 + 部品 1 ファイル」のウィジェットなので（#716）、ページ
（`dashboard/+page.svelte`）は触らず、登録の行と部品のファイルを消す:
`apps/admin-template/src/lib/banto/dashboardWidgets.ts` の `[scaffold:charts]` の領域（部品の import と、
ウィジェットの行）と、その単体テスト `dashboardWidgets.test.ts` の同じ印の領域、
`src/lib/components/dashboard/charts/`（チャートのウィジェットの部品。ディレクトリごと）、
KPI の帯の `Sparkline`（`src/lib/banto/dashboardKpis.ts` と `src/lib/components/DashboardKpiStrip.svelte` の
`[scaffold:charts]` の領域）、`src/lib/banto/dashboard.ts` の
`@banto/charts` に依存する集計処理（`// --- M24 chart demo data` 以降と `GanttTask` の import）を削除。
dock を残すなら、dock には一覧（在庫の少ない商品）とメモのパネルが残る（既定の配置は登録に在るものだけで組まれ、
dock の高さも 1 行ぶん = 300px になる。`dashboardLayout.ts`）。dock も外すなら、一覧だけを積む。
チャート見本のデモ専用ルート `src/routes/(app)/chart-gallery/` も丸ごと削除し、あわせて
`src/lib/navigation.ts` の `allNavItems` の `/chart-gallery` 行と
`DemoNavIconKey`（`'chart-gallery'`）・`DemoNavLabelKey`（`'nav.chartGallery'`）の語、
`src/lib/components/navIcons.ts` の `ChartColumn` の import と `'chart-gallery'` の行、
`messages/{ja,en}.json` の `chartGallery.*`・`nav.chartGallery` を外す。
テーマを試すページ `src/routes/(app)/theme-lab/` は残し、チャートの部分だけを外す
（`ThemeLabCharts.svelte` の削除、`+page.svelte` の `ThemeLabCharts` の import と
`[scaffold:charts]` の印で挟んだ節、`messages/{ja,en}.json` の `themeLab.charts.*`）。`items`
自体は他機能（CSVエクスポート等）で使うため残してよい。
`package.json` の `@banto/charts` 依存を外す（外した後に `@banto/charts` を参照する
ファイルが残らないこと）。

### Glassテーマ + Windows vibrancy（M12）

`packages/theme/src/css/banto-glass.css` を削除し
`packages/theme/src/css/banto.css` の `@import './banto-glass.css'`
を外す。`packages/theme/src/index.ts` の `ThemePreset` から `'glass'` を
除去。設定画面（`apps/admin-template/src/routes/(app)/settings/AppearanceSection.svelte`）
のプリセット選択肢から「ガラス」を外す。デスクトップの本物のガラス感
（Windows Acrylic）も併せて外す場合は `src/lib/banto/vibrancy.ts`、
`src-tauri/src/lib.rs` の `vibrancy_apply`/`vibrancy_status`/
`set_window_vibrancy` と `window-vibrancy` 依存
（`src-tauri/Cargo.toml`）、設定画面のvibrancyトグルを削除する。
プリセット未選択（`standard`のみ）ならCSSは不活性のため、見た目だけ
気にしないなら削除自体は必須ではない。

### コマンドパレット（Ctrl+K、M16）

`apps/admin-template/src/lib/components/CommandPalette.svelte`・
`src/lib/commandPalette.svelte.ts`・`src/lib/commands.ts`・`src/lib/commands.test.ts`・
`src/lib/recentCommands.ts`・`src/lib/recentCommands.test.ts`・
`src/lib/recordSearch.ts`・`src/lib/recordSearch.test.ts`（レコード検索、#711）を削除し
（テストを残すと、消したモジュールを import して `pnpm --filter admin-template test` が落ちる）、
`src/routes/(app)/+layout.svelte` と `src/lib/components/Header.svelte`
からの参照（`commandPaletteStore`・Ctrl+K の command の登録とパレットの host・パレット起動
ボタンと鍵帽の表示）を外す。キーの dispatcher（`src/lib/shortcuts.ts`、#435）はページの command
（ダッシュボードの Ctrl+S）のために残す。ナビ定義（`navigation.ts`）からの自動導出のみで構成
されるため、削除してもナビ自体には影響しない。

### 添付ファイル機能（`@banto/attachments` + items 添付デモ、M20）

以下の順で外すとビルド・テストが引き続き通る（依存の少ない順）。

1. `apps/admin-template/src/routes/(app)/items/[id]/+page.svelte` の
   添付パネルの配線（`ResourceDetail` の `after` snippet）と、一覧
   `items/+page.svelte` の詳細ドロワーの配線（`ResourceListPage` の
   `detailAfter` snippet）、それぞれの `ItemAttachments` の import を削除。
   どれも `[scaffold:attachments]` の印で囲んである。`[id]` の snippet を消したら
   `<ResourceDetail … />` の自己終了タグにする。そのうえで
   `items/ItemAttachments.svelte`（`AttachmentsPanel` を置く部品）を削除。
   あわせて `src/lib/banto/resources/items.ts` の `file` 欄（`files`）と、その欄だけが使う
   import（`attachmentsAdmin`・`attachmentsClient`・`confirm`）を削除する（これも
   `[scaffold:attachments]` の印で囲んである。欄の前のカンマも消す）。新規作成の保存のあとに
   ファイルを上げる配線（`ResourceDetail`）は、`file` 欄が無ければ何もしないので残してよい。
2. `apps/admin-template/src/lib/banto/attachmentsClient.ts`・
   `src/lib/banto/attachmentsAdmin.ts`（と試験の `attachmentsAdmin.test.ts`）を削除。
3. `apps/admin-template/core/src/rest/attachments.rs` **ファイルを削除**し、
   `rest/mod.rs` の `mod attachments;`・`use attachments::attachments_router;`・
   `use banto_attachments::{…}` を外す。あわせて、`attachments.rs` だけが
   `use super::*` 経由で使っていた `mod.rs` の import（`axum::body::Bytes`・
   `axum::extract::Query`・`axum::response::Response`・`banto_core::BantoError`・
   `serde::Deserialize`）も外す（残すと unused import 警告で、`-D warnings` の
   ビルドが落ちる）。`mod.rs` の `api_router` からは `attachments_router`
   一式（`attachments_list`/`attachments_upload`/`attachments_delete`等）と
   `items_delete` からの `sweep_item_attachments` 呼び出し・`items_bulk_delete` からの
   `sweep_items_attachments` 呼び出し・`ItemsWriteState`
   の `attachments` フィールドを外す（`detail` は `None` にする）。`src-tauri/src/lib.rs` も同様に
   `attachments_*` コマンドと `AppState` の `attachments`/`attachments_dir`
   フィールド、`items_delete` の `sweep_item_attachments` 呼び出し、
   `items_bulk_delete_body` の `sweep_items_attachments` 呼び出し、
   `attachment_wiring` の `use` を外す。共通部品の
   `apps/admin-template/core/src/attachment_wiring.rs` と `core/src/lib.rs` の
   `pub mod attachment_wiring;` も削除する。
4. `apps/admin-template/core/src/rest/tests.rs` から attachments 参照を外す
   （`api_router` から attachments 引数が消えるのに追随。外さないと
   `cargo test` がコンパイルできない）: `unused_attachments_service` ヘルパと
   その各呼び出し・`api_router(...)` 実引数の `attachments,`、末尾の
   `// --- M20: attachments` テストブロック（EOF まで、独自の実サービスを含む）を削除。
5. `apps/admin-template/package.json` の `@banto/attachments` 依存、
   ワークスペースの `crates/banto-attachments`（`Cargo.toml` の
   `members` と `admin-template-core`/`admin-template` の依存）を外す。
6. `apps/admin-template/core/migrations-sqlite/0006_attachments.sql`（および
   `migrations-postgres/0006_attachments.sql`）を削除（`attachments` テーブルは
   他のテーブルから参照されないため、単独で安全に外せる）。

### 帳票デモ（`@banto/report` + 日報デモ、M19）

DB/バックエンド配線を一切持たない最小デモのため、以下だけで外せる。

1. `apps/admin-template/src/routes/(app)/items/+page.svelte` の「日報」
   メニュー項目（一覧の「…」メニューへ足す `ResourceListPage` の `actions` snippet）と、その import
   （`goto`・`resolve`・`FileText`・`MenuItem`・`m`）を削除。どちらも `[scaffold:report]` の印で
   囲んである。残るのは `<ResourceListPage resource={itemsResource}>` の呼び出しだけ
   （CSV 取込は定義の `csv.import` で部品が描く）。
2. `apps/admin-template/src/routes/(app)/items/report/`（ルート丸ごと）と
   `src/lib/banto/reports/`（`daily.md`・`raw.d.ts`）を削除。
3. `apps/admin-template/package.json` の `@banto/report` 依存、
   `src/app.css` の `@import '@banto/report/print.css'` と
   `.banto-report-active` 用の `@media print` ブロックを外す。
   `@banto/report` パッケージ自体（`packages/report`）はテンプレートに
   同梱したままでも他に影響しないが、完全に外す場合は
   `pnpm-workspace.yaml` の対象から漏れないことを確認する。

### ツリーデモ（`@banto/tree-svelte` + `/tree` デモ、M-review 2026-08）

DB/バックエンド配線を持たない最小デモ。`pnpm scaffold` の minimal / standard
プリセット（または `--interactive`）で自動削除できる。手動で外す場合は以下。

1. `apps/admin-template/src/routes/(app)/tree/`（ルート丸ごと。3 ペインの見本 `tree/workspace/` を含む）と
   `src/lib/banto/treeSample.ts` を削除。
2. `src/lib/navigation.ts` の `'tree'`/`'nav.tree'`（`NavIconKey`/`NavLabelKey`
   の union と navItems の `/tree` 行）、`src/lib/components/navIcons.ts` の
   `tree:` エントリと `ListTree` の import を削除（union とアイコンマップは
   型で連結しているため対で外す）。
3. `src/lib/banto/i18n.ts` の `treeMessages()` と `TreeMessages` import、
   `messages/{ja,en}.json` の `nav.tree`・`tree.*` キーを削除。
4. `apps/admin-template/package.json` の `@banto/tree-svelte` 依存を外す。
   パッケージ本体（`packages/tree-svelte`）は同梱のままでも他に影響しないが、
   ナビが1項目減るぶんサイドバーが写る認証ページのビジュアル回帰ベースライン
   を再生成する（`.github/workflows/visual-baselines.yml` を dispatch）。

### `@banto/image-assets`（ブラウザ側の画像の原本・取込検査、Issue #438）

テンプレートのアプリには配線していない（`apps/admin-template/package.json` に依存が無い）ので、
アプリ側に外す配線は無く、`pnpm scaffold` もどのプリセットでも触れない。パッケージ本体を
同梱のままにしても他に影響しない。リポジトリから消したい場合は以下。

1. `packages/image-assets/` を削除し、`pnpm install` で lockfile を更新する。
2. `docs/` と README の `@banto/image-assets` の参照（template-scope §3 の行・本節・
   ADR-0020 など）を消すか、スコープ無しの書き方に直す（`verify:architecture` の
   rule `docs-package-refs` が実在しないパッケージの参照を落とす）。
3. banto 本体のリポジトリで消す場合は、外部利用 fixture（`fixtures/external-consumer/`）の
   `package.json` の依存・`src/routes/+page.svelte` の import・`vite.config.ts` の
   `optimizeDeps.exclude` からも外す（`verify:architecture` の rule `external-consumer-fixture`。
   scaffold した派生アプリでは fixture ごと除去済み）。

### `@banto/touch-keys-svelte`（タッチ向けの画面内キー、Issue #937）

`pnpm scaffold --preset minimal|standard|display` は自動で外す（`full` は残す。`--interactive` の
custom では `touchKeys`）。テンプレートの配線は `/ui-demo` のカード 1 枚だけで（#937 T7）、ルートのレイアウトに
ホストは置いていない。ナビも変わらない。手で外すなら以下（scaffold の `removeTouchKeys` と 1 対 1）。

1. `apps/admin-template/src/routes/(app)/ui-demo/+page.svelte` の `[scaffold:touch-keys]` の印で囲んだ
   2 つの領域（script の import と状態、markup のカードと `<TouchKeysHost>`）を消す。
2. `apps/admin-template/src/lib/banto/touchKeysMessages.ts`（Paraglide の束）を消す。
3. `apps/admin-template/messages/{ja,en}.json` の `touchKeys.*` と `uiDemo.touchKeys.*` のキーを消す。
4. `apps/admin-template/package.json` の `@banto/touch-keys-svelte` の依存を消し、`pnpm install` で
   lockfile を更新する（`.svelte.ts` を持たないパッケージなので、`vite.config.ts` の `optimizeDeps.exclude` には
   元から載っていない。conventions §14）。
5. `e2e/demo/touch-keys.spec.ts` と `e2e/demo/touch-keys-grid.spec.ts` を消す。`ui-demo` の基準画像（`e2e/visual`）を使い続けるなら、
   `visual-baselines.yml` で作り直す。

パッケージ本体（`packages/touch-keys-svelte`）は scaffold では消えない。同梱のままにしても他に影響しない。
リポジトリからも消したい場合は、上に続けて以下。

1. `packages/touch-keys-svelte/` を削除し、`pnpm install` で lockfile を更新する。ルートの `package.json` の
   `e2e:touch-keys`、`ci.yml` のジョブ `touch-keys-browser` とその判定（`changes` の出力 `touch`）、
   `eslint.config.js`・`.gitignore` の fixture の出力の行も外す。
2. `docs/` と README の `@banto/touch-keys-svelte` の参照（template-scope §3 の行・本節・
   ADR-0036・設計書・レシピなど）を消すか、スコープ無しの書き方に直す（rule `docs-package-refs`）。
3. 外部利用 fixture に入れた後の段階（`.svelte.ts` を持つようになった後）では、fixture の
   `package.json` の依存・`+page.svelte` の import・`vite.config.ts` の `optimizeDeps.exclude` からも外す。
4. 派生アプリが自分で配線していたなら、ルートの `<TouchKeysHost>`・入力欄の指定・端末ごとの設定を外す
   （設計書 §16。入力欄は素の `<input>` のまま動く）。

### 設定の下書き → 反映 → 元に戻す（`configDrafts`、Issue #938）

`pnpm scaffold --preset minimal|display` は自動で外す（`standard`・`full` は残す。
スクリプトは `removeConfigDrafts()`）。使い方は [config-draft-publish.md](config-draft-publish.md)、
設計は [design/config-draft-publish-design.md](../design/config-draft-publish-design.md) §10。
消す所は全部 `// [scaffold:config-drafts] begin` … `end` の印で囲んである（手で外すときも、
印の区画を消せばよい）。コアからの参照は無いので、外しても残りは壊れない。

1. `core/migrations-sqlite/0016_config_drafts.sql`・`core/migrations-postgres/0016_config_drafts.sql`
   を消す（まだ DB を作っていないアプリ。作った後なら表を残したまま 2 以降だけ行う）。
2. `core/src/rest/mod.rs` の印の区画 4 つ（対応表の行・説明・import・`config_drafts_access` と
   `config_router`）と、`core/src/bin/banto-serve.rs` の区画 2 つ（起動時の用意・合流）を消す。
3. `src-tauri/src/lib.rs` の印の区画 10 個（import・状態の欄・`config_*` コマンド・起動時の用意・
   埋め込みサーバーへの受け渡し・`invoke_handler` の行）を消す。
4. `scripts/verify-architecture.mjs` の印の区画 4 つ（`DUAL_PATH`・`ROLE_READ`・`TAURI_READ`・
   `REST_READ` の config の行）を消す。
5. `core/src/lib.rs` の区画（`config_targets`・`open_config_drafts`）を消す。
6. 試験: `core/src/rest/tests/config_drafts.rs`・`src-tauri/src/tests/config_drafts.rs` と、
   `core/src/rest/tests.rs`・`src-tauri/src/tests.rs`・`core/tests/pg_smoke.rs` の印の区画を消す。
7. フロントで読み口（`createHttpConfigDrafts` など）を使っていれば、その呼び出しを消す。

### システムメトリクス（`sysinfo`）を外す（ADR-0013、Issue #185）

`apps/admin-template/core/Cargo.toml` と `apps/admin-template/src-tauri/Cargo.toml`
の `default` から `system-metrics` を外す。System Info カードの CPU/メモリの
行は `metrics` が `null` になり自動的に消える（他の行は従来どおり）。
`banto-admin-services` 自体の `system-metrics` feature（`sysinfo` 依存の実体）
はそのまま残しておいて構わない（無効化されたテンプレート側から到達しなく
なるだけ）。

## 関連

- デモリソース `items` 自体の差し替え・削除は [add-resource.md](add-resource.md)
  （`attachments` の items デモ配線を使っている場合は本書の添付の手順が先）。
- ログイン無しの小さなアプリとして始めるなら [no-login-app.md](no-login-app.md)。
