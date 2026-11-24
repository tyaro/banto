# D1: 下流の使い勝手の精査（2026-11）

> **オーナー決定（2026-11-24）: §2 の判断はすべて v8 に入れる。** #821 の 3 点・座標で開く文脈メニュー（#889）・`BantoGrid` の `columns` の反映（#890）・`BantoTree` の名前変更の IME のガード（#891）・`ThreePaneDock` の左右を px で保つ指定（#892）を v8 で実装する。§2 の 4（ChronoGazer の `initialized` 依存）は D3 の upgrading に 1 項。§2 の「推奨」は決定前の案として残す。

- 調べた日: 2026-11-24。読み取りのみ（どのリポジトリも変更していない。ビルド・テストは走らせていない）。
- banto: `main` 73d019e5（最新タグ v7.11.0、[Unreleased] が v8 の中身）。
- banto-industrial: f20773bf（`@banto/*` と Rust の crate は **v7.9.0** に固定）。アプリは banto-hub・chronogazer、パッケージは trend・demo-backend。
- temp-scada: `work` a1e1e5c7（`@banto/*` は **v7.10.0**、Rust は rev 9caa238c = v7.10.0）。アプリは banto-scada。
- 行番号は上の commit のもの。「概数」と書いた数は grep の一致数で、試験のコードを含む。

## 1. 結論

1. **下流が「入ったら置き換える」と書いていた回り道は、全部 main に置き換え先がある。** #784（行の右クリック）・#791（配置の保存と確定の合図）・#792（`isOnScreen`）・#793（書き込みの切り離し）・#786（条件付きの書き込みと再送）・#838（メモリだけのトークン）・dock の進行中の操作の取り消し・Toast の透け・`--banto-warning` と `--banto-chart-2` の近さ。足りない口のまま残っているものは無い。
2. **新しく見つかった「足りない口」は 2 つ**: (a) 座標で開く文脈メニュー（`@banto/ui`。Hub と temp-scada が別々に 270〜290 行で自作）、(b) `BantoGrid` の `columns` を後から変えても反映されない（Hub が `{#key}` で作り直している）。どちらも足すだけで、v8 を待たせる理由は無い。
3. **#821（`BantoTree` の 3 点）は、口が無いことは事実。ただし今それを要る下流は居ない。** temp-scada は `@banto/tree-svelte` に依存しておらず（自前の `LayerTree`）、置き換えを先送りしている。banto-industrial の 3 か所は 3 点のどれも使わない。v8 では足さないのが妥当（**決定前の推奨。オーナー決定で v8 に入れる＝計画書 §7 の D4**）。
4. **「D1 で見る」項目に、banto の計画を変えるものは無い。** 下流の migration は 0101 から（0014・0015 と衝突しない）。監査を名前 `local` で絞る所は無い。slot の公開 API を使う下流は無い。dock・grid の DOM 試験の下準備を求める下流は無い（下流は部品をマウントする試験を持たない）。`initialized` は 2 アプリが読んでいて、ChronoGazer は設計に食い込んでいる（§2 の 4）。
5. **D2 の 4 件（#811・#816・#818・#822）は、下流の互換を気にせず進められる。** 下流は日付のピッカーを 1 つも使っておらず、`ReachCheckClock` も使っていない。`BantoGrid` の編集の口を使うのは Hub のタグ表 1 か所だけ。
6. v8 へ上げるときの下流の直しは多い（§6）。大半はテンプレートの写し（`src-tauri/src/lib.rs`・`core`・`src/lib/banto/*`）の追従で、upgrading の 4.2 節に載っている種類のもの。

## 2. オーナー判断が要る点

1. **#821 `BantoTree` の 3 点を v8 で足すか。**
   推奨: **足さない**。#821 に本書の判定（§5）を写して開けたままにし、temp-scada が置き換えに着手するときの Issue（小さい利用側の fixture つき）を待つ。使い手が 1 つで、しかもまだ依存していないので、template-scope §1 の横断性を満たさない。
2. **座標で開く文脈メニューを `@banto/ui` に足すか（§3 の N1）。**
   推奨: **別 Issue を立て、v8 の後の minor で足す**（足すだけの変更。D2 には入れない）。`BantoTree.onContextMenu` と `BantoGrid.onRowContextMenu` は座標を渡すのに、そこに出すメニューが banto に無いため、Hub は 290 行、temp-scada は「見えないボタンを座標に置いて click する」274 行を持っている。4 条件はどれも満たす。
3. **`BantoGrid` の `columns` の反映（§3 の N2）を #822 の PR に入れるか。**
   推奨: **入れない。別 Issue にする**。#822 は「既存の挙動を維持」が条件なので、挙動を変える話を混ぜない。ただし #822 の設計では、編集の可否（`editable`）を `GridState` の作り直しなしに切り替えられる余地を潰さないこと、を PR の指示に 1 行入れる。
4. **`initialized` に頼った下流の入口（ChronoGazer の「この PC から続ける」）を、upgrading にどう書くか。**
   推奨: **D3 の upgrading に 1 項を足す**（「`status().initialized` / `is_initialized()` を自分の入口・grant の条件に使っていた派生アプリ」）。banto に口は足さない。ChronoGazer は `grantPolicy.ts:51,180,182` と `core/src/local_grant.rs:335-344`（`is_initialized` は Rust で概数 22）で「アカウントが 1 つも無い間だけ」の分岐を持っており、v8 では「新しい DB はログインなしで始まる」に変わるので、下流の設計の見直しが要る。置き換え先（認証モード・`has_admin`）で同じことが書けるかは **確かめていない**。
5. **`ThreePaneDock` の左右の区画を px で保つ口を足すか（§3 の S6）。**
   推奨: **足さない**。使い手は temp-scada だけ。代わりに、D3 の upgrading に「`dock.layout = ...` を自分で代入している派生アプリは、#782 PR7 の『外から代入したときの元の場所』の規則の変更を確かめる」を 1 行入れる（temp-scada は窓の幅が変わるたびに代入している。浮動を止めているので影響は小さいはずだが、確かめていない）。
6. **`BantoTree` の名前変更の Enter に IME の変換中のガードが無い件（§5 の末尾）を、別 Issue にするか。**
   推奨: **別 Issue（小さい修正、v8 に入れてよい）**。`onRenameKeydown`（`packages/tree-svelte/src/BantoTree.svelte:389-399`）は `isComposing` を見ていない。実機での再現は確かめていない（Windows の WebView2 では変換中の `key` が `Process` になり当たらない可能性が高い。macOS の Safari・WKWebView が怪しい）。

## 3. 所見の表

分類: **置き換え可**（main の口で置き換えられる）／**足りない口**／**下流に残す**／**既知の写し**（テンプレートの写し、または v8 でパッケージへ移した物の写し）。

### 3.1 banto-industrial

| # | 下流のファイル:行 | 何をしているか | 分類 | banto 側の置き換え先・新しい口の案 | 扱い |
| --- | --- | --- | --- | --- | --- |
| I1 | `apps/banto-hub/src/lib/dockLayoutStore.ts`（165 行、:4-5 に「#791 が入ったら置き換える」）・`dockLayout.ts`（87）・`dockLayoutPersist.svelte.ts`（90、:18） | dock の配置を利用者ごとに保存（サーバー + localStorage の控え）。確定の合図が無いので `layoutSnapshot()` を `$effect` で追う | 置き換え可（既知の写し） | `@banto/dock-svelte` の `createDockLayoutStore`（`packages/dock-svelte/src/layoutStore.ts:196`。`settingKey`・`storageKey`・`scope`・`reset`・`validate`）と `createThreePaneLayoutTarget`、`ThreePaneDock` の `onLayoutCommit` | 下流の作業。banto は無し |
| I2 | `apps/banto-hub/src/lib/dockLogBand.svelte.ts`（210） | 低い画面では、既定の配置のログのパネルを帯にしてから基準にする | 置き換え可 | `createDockLayoutStore` の `beforeBaseline`（doc の例がこの用途） | 下流の作業 |
| I3 | (a) `apps/banto-hub/src/lib/dockPanelOnScreen.ts`（49、:17-18）／(b) `routes/(app)/tags/+page.svelte:2180-2191`（`rightPaneOperable`・`paneOperableIn`） | (a) 配置の木（`layout.floating`・`autoHidden`・`docked`）を自分で歩いて「実際に画面に出ているか」を判定（ログの購読の判定）／(b) 右ペインを操作できるか。狭い表示・自動で隠した帯（引き出し中も）・畳んだ区画・裏のタブを除く | (a) 置き換え可／(b) 下流に残す | (a) `DockState.isOnScreen(id)`・`dock.panels[].onScreen`。`ThreePaneDock` に `isOnScreen` は無い（公開は `isVisible` で、帯にしまったパネルも真）／(b) 「画面に出ている」とは別の判定（引き出した帯は画面に出ていても操作できないと数える）。既存の条件を残す | 下流の作業。v8 は帯の `slot` を消したので、木を歩くコードは帯の形の変化を確かめる |
| I4 | `apps/banto-hub/src/routes/(app)/tags/+page.svelte:3581-3584` | グリッドを包む要素で `contextmenu` を受け、`rowClass` に載せた `tag-row-id-<id>` で行を特定 | 置き換え可 | `BantoGrid` の `onRowContextMenu`（#784、v7.11.0） | 下流の作業 |
| I5 | `apps/banto-hub/src/lib/components/TreeContextMenu.svelte`（290） | 座標に浮かべる ARIA `menu`（フォーカス・Esc・外側クリック・層の判定を自作） | **足りない口**（N1） | `@banto/ui` に座標で開くメニュー（`Menu` の `trigger` なしの開き方、または `ContextMenu`）。`Menu.svelte` は `trigger` の矩形からしか位置を出せない（:9, :40） | 別 Issue（§2 の 2） |
| I6 | `apps/banto-hub/src/routes/(app)/tags/+page.svelte:8292-8305` | 表編集モードの切り替えで `columns` の `editable` を変えても反映されないので、`{#key gridEditMode}` で `BantoGrid` を作り直す（列幅・並べ替え・絞り込み・スクロールが戻る） | **足りない口**（N2） | `BantoGrid.svelte:249` は `new GridState(columns, …)` を 1 回だけ作る。`columns` の変化を `GridState` に伝える口、または `editable` を関数で受ける形 | 別 Issue（§2 の 3）。#822 に関係 |
| I7 | `apps/banto-hub/src/lib/watchListStore.ts`（497、:4-6・:66） | 見張りの一覧。`createSavedSetting` を使わず `provider.get` / `set` を直に呼び（:412・:439）、読む → 操作を当てる → 書く、失敗は間隔を延ばして再送 | 置き換え可（一部） | 読む → 当てる → 条件付きで書く → 衝突したら当て直す、は `updateUiSetting(provider, key, apply)`。再送は `createSavedSetting` の `retry`・`merge`・`onSettled`。操作の列・消えたタグの照会（`dead`・`known`）は Hub の事情なので **下流に残す** | 下流の作業。`get` の戻り値が `{ value, revision }` になるので、どのみち直す |
| I8 | `apps/banto-hub/src/lib/settings.svelte.ts:194-197`・`apps/chronogazer/src/lib/settings.svelte.ts:196-199`・`apps/banto-hub/src/lib/recentCommands.ts:122` | `UiSettingsProvider.get` を直に呼ぶ（テンプレートの写し） | 既知の写し | テンプレートの同名ファイルの差分（`.value` を取る）を取り込む | 下流の作業（C5 の破壊的変更） |
| I9 | `apps/banto-hub/src/lib/demo/bantoRoutes.ts:53-64`・`apps/chronogazer/src/lib/demo/bantoRoutes.ts:53-64`（`resetDemoToken`） | デモのトークンのキーを両方の storage から消して置き直す（「#838 が入るまでの回り道」） | 置き換え可 | `createHttpAuthProvider({ storage: 'memory' })`。ただし **初めのトークンを渡す口は無い**ので、デモは起動時に模擬の `login()` か grant で入る形に変える | 下流の作業。口は足さない（デモだけの事情） |
| I10 | 同 `bantoRoutes.ts:36-48` | 模擬の `GET` / `PUT /api/ui-settings/:key` が旧い形（`{ value }`・204） | 既知の写し（破壊的変更に当たる） | 新しい形（`GET` は `{ value, revision }`、`PUT` は `200 { revision }`、`DELETE`）に合わせる。合わないと同梱の provider が `other` のエラーにする | 下流の作業。D3 の upgrading に「自作の模擬サーバー」を 1 行 |
| I11 | `apps/chronogazer/core/src/local_grant.rs:672-683`（`run_detached`、呼び出し 11） | 書き込みの handler を `tokio::spawn` で切り離し、切断で途中で止まらないようにする（「#793 が入ったら置き換える」） | 置き換え可 | `banto-server` の `BoundServer::serve` が router 全体に掛ける層（`detach.rs`、ADR-0035）。ChronoGazer は `BoundServer::serve` を使っている（`core/src/engine.rs:1389`） | 下流の作業 |
| I12 | `apps/banto-hub/core/src/detached.rs` | Hub 自身の切り離したタスクの数え（終了時に待つ） | 下流に残す（**未確認**） | Hub が `BoundServer` を使っているかを確かめていない（grep では見つからなかった）。使っていないなら banto の層は掛からない | — |
| I13 | `apps/chronogazer/core/src/local_grant.rs:192-203`（`RESERVED_USERNAMES`） | `local`・`localDesktop`・`public` の名前のアカウントを、banto のサービスを呼ぶ前に断る | 置き換え可 | `UsersService::with_reserved_usernames(ReservedUsernames::new([..]))`（`crates/banto-admin-services/src/users.rs:791`）。`admin` は banto が断る | 下流の作業 |
| I14 | `apps/chronogazer/core/src/settings.rs:65-70`（`parse_retention`） | 監査の保持期間の読み方。banto の同名の関数が非公開なので写している | 既知の写し | banto の `AuditSettings` をそのまま使えるか（Hub は `core/src/settings.rs:60-66` で使っている）は **確かめていない** | 急がない。必要なら公開する（別 Issue） |
| I15 | `apps/banto-hub/src/lib/mobileNav.svelte.ts:27`・`apps/chronogazer/src/lib/mobileNav.svelte.ts:26`・両アプリの `viewportWatch.ts` | `(max-width: 900px)` を見るリアクティブな状態（テンプレートの写し + 注入できる `matchMedia`） | 置き換え可（既知の写し、#850） | `@banto/ui` の `NARROW_QUERY`・`narrowViewport`（`packages/ui/src/index.ts:214`） | 下流の作業 |
| I16 | `apps/chronogazer/src/lib/historical/historyLogic.ts:130-137`・`dailyReport/dailyReportLogic.ts:57-75`、`<input type="datetime-local">` / `type="date"`（chronogazer 3 画面、hub 1 画面） | ブラウザーの日付入力 + ローカル時刻との変換を自作。`@banto/ui` の `DateInput` 系は使っていない | 下流に残す（置き換え候補） | `@banto/ui` の `DateTimeInput`・`DateRangeInput`、`parseDateTimeText` / `formatDateTimeText`。値の形が合うかは **確かめていない** | #811 の後に下流で検討。banto は無し |
| I17 | `apps/banto-hub/src/lib/banto/*.test.ts` の「vitest 制約の回避」（例 `tagRegistryAdmin.test.ts:8-20`） | `@banto/admin-core` が `.svelte.ts` を推移的に import するので、svelte のプラグイン無しの vitest では `vi.mock` で差し替える | 下流に残す | 下流の vitest に `@sveltejs/vite-plugin-svelte` を入れれば要らない（下流の構成の選択）。banto の口ではない | — |
| I18 | `apps/banto-hub/src/routes/login/+page.svelte:43`、`apps/chronogazer/src/lib/banto/grantPolicy.ts:51,180,182`・`components/SetupBanner.svelte`・`core/src/local_grant.rs:335-344` | `status().initialized` / `is_initialized()` で初回セットアップと入口を分ける | 既知の写し（Hub）／**下流の設計に食い込む**（ChronoGazer） | C2b で `initialized`・`setup`・`is_initialized` は無い。Hub はログインのフォームだけにする。ChronoGazer は §2 の 4 | 下流の作業。D3 の upgrading に 1 項 |
| I19 | テンプレートと同じパスのファイル: Hub 21（`src/lib` の下。`banto/usersAdmin.ts`・`settings.svelte.ts`・`components/Header.svelte` ほか）、ChronoGazer 30（`banto/authAdmin.ts`・`backupsAdmin.ts`・`serverAdmin.ts`・`unsavedChanges.ts` ほか）、`src-tauri/src/lib.rs`、`core/migrations-sqlite/0002〜0013` | テンプレートの写し（派生アプリの作り） | 既知の写し | v8 のテンプレートの差分を取り込む（§6） | 下流の作業。banto は無し |
| I20 | `packages/demo-backend/src/storage.ts`（`createMemoryStorage`・`installDemoStorage`）・`apps/*/src/hooks.client.ts` | デモのビルドでだけ `localStorage`・`sessionStorage` をメモリに差し替える | 下流に残す | §4 の 5。banto に口は要らない | — |

### 3.2 temp-scada

| # | 下流のファイル:行 | 何をしているか | 分類 | banto 側の置き換え先・新しい口の案 | 扱い |
| --- | --- | --- | --- | --- | --- |
| S1 | `apps/banto-scada/src/App.svelte:484-493`（`cancelDesignerGesture`）、呼び出しは `:596`（`restorePanelLayout`） | 「標準に戻す」の前に、`arrange` を一瞬 `false` にして進行中の divider のドラッグを取り消す | 置き換え可 | v8 の `DockHost.replaceLayout`（`ThreePaneDock` の `resetLayout` / `restoreLayout` を含む）は、置き換えの前に進行中の操作を自分で取り消す（CHANGELOG [Unreleased] Changed）。応急処置ごと消せる。`DockHost.cancelGesture()` も足したが、**`ThreePaneDock` はそれを公開していない**（今の使い方では要らない） | 下流の作業 |
| S2 | `apps/banto-scada/src/lib/designer/ContextActions.svelte`（274、:59-126・:161-175） | `@banto/ui` の `Menu` を文脈メニューとして使うため、見えない trigger を座標に置いて `click()` し、フォーカスの戻り先を自分で直す | **足りない口**（N1） | I5 と同じ | 別 Issue（§2 の 2） |
| S3 | `apps/banto-scada/src/lib/designer/controllers/designer-shortcuts.svelte.ts:188-192` | メニューを開いたまま F1 でモーダルを開くと、上流の層の判定で互いに「上」になるので、保存のショートカットを dispatcher に載せない | 置き換え可（**未確認**） | `@banto/ui` の `closeOpenMenus`（`packages/ui/src/openMenus.ts:19`）でモーダルを開く前にメニューを閉じれば、2 つが同時に残らない。temp-scada の監査（§7）も「使えるかは未確認」 | 下流で確かめる。直らなければ別 Issue |
| S4 | `apps/banto-scada/src/lib/banto/ui-preference.ts`（88） | `createSavedSetting` の薄い包み（失敗の通知を送信ごとに 1 回） | 置き換え可（小） | `createSavedSetting` の `onSettled`（送信ごとに 1 回）と `retry` | 下流の作業 |
| S5 | `apps/banto-scada/src/lib/designer/dock-layout.ts:92-116`（`frontLeftPanes`） | 配置の木を歩いて、左のパネルのうちタブの組の前面のもの（引き出していない帯の選択タブも含む）を求め、前面のタブの復元・文脈の鍵に使う | 下流に残す | `isOnScreen(id)` は画面上の可視性なので、引き出していない帯の選択タブが外れて挙動が変わる。置き換えない | 下流の作業。v8 の帯の形（`autoHidden[].node`）に合わせて確かめるだけ |
| S6 | `apps/banto-scada/src/App.svelte:446-473`、`dock-layout.ts:126-171`（`withDesignerPaneWidths`・`keepDesignerPaneWidths`） | 窓の幅が変わるたびに `dock.layout` を代入し、左右の区画の px を保つ（dock の分割は比率） | 下流に残す | 口の案は「`ThreePaneDock` に左右を px で保つ指定」。使い手が 1 つなので足さない（§2 の 5。**決定前の推奨。オーナー決定で v8 に入れる＝#892**） | #892。D3 の upgrading にも 1 行 |
| S7 | `apps/banto-scada/src/lib/designer/LayerTree.svelte`（723）・`controllers/layer-tree.svelte.ts`（634） | レイヤーとフォルダーの木を自作（行末の表示・ロック・操作のボタン、ドロップの可否と理由、検索、IME のガード） | 下流に残す（今は） | §5 | §2 の 1 |
| S8 | `apps/banto-scada/src/lib/history/time-input.ts:8-48`、`<input type="datetime-local">`（3 画面） | UTC とローカルの時刻入力の変換を自作 | 下流に残す（置き換え候補） | I16 と同じ | #811 の後に下流で検討 |
| S9 | `apps/banto-scada/src/lib/hub-tag-csv.ts`・`equipment-io-csv.ts` | CSV の直列化・解析を自作（Shift_JIS の判定・列名の推定つき） | 下流に残す | `@banto/grid-svelte` の `toCsv`・`csvForExcel`・`parseCsv` はあるが、temp-scada は grid-svelte に依存していない。Shift_JIS の判定は banto に無い | 下流の判断。要望が来たら別 Issue |
| S10 | `apps/banto-scada/src/lib/canvas-colors.ts:15-35` | WCAG の相対輝度・コントラスト比 | 下流に残す | banto の theme は色差（OKLab）を試験で見ているが、公開の関数ではない | 要望が来たら別 Issue |
| S11 | `crates/scada-host/src/operation_write.rs:361`（`TODO(O5)`、banto#697 待ち） | ユーザーごとの権限が無いので「誰も操作できない」にしている | 置き換え可 | #697 は v7.7.0 で公開済み（`permissions`）。temp-scada の固定の rev に入っている | 下流の作業（v8 と無関係） |
| S12 | `crates/scada-host/migrations-sqlite/0002〜0013`、`src/auth.rs`・`desktop_auth.rs`、`apps/banto-scada/src-tauri/src/auth.rs` | テンプレートの認証まわりの写し（`auth_status` の `initialized`・`auth_setup`・合成セッション `local`） | 既知の写し | v8 のテンプレートの差分を取り込む（§6） | 下流の作業 |
| S13 | temp-scada の監査 §3 の「Toast がダークで透ける」「`--banto-warning` と `--banto-chart-2` が近い」 | 回避なし（見た目の不満） | 置き換え可（直っている） | `ToastHost` は不透明な `--banto-surface-overlay` の上に tint を重ねる形になった。先頭 4 系列と状態色の色差の下限（OKLab 0.09）を試験にした（CHANGELOG [Unreleased] Changed） | 版を上げれば済む |
| S14 | temp-scada の監査 §3 の「`ThreePaneDock` の左のタブの帯が既定の 240px で詰まる」 | 未対応・未起票 | **確かめていない** | — | temp-scada が再現を添えて起票するのを待つ |

temp-scada 自身の精査（`docs/reviews/upstream-placement-audit-2026-11-22.md`）は v7.11.0 の時点のもので、本表の S1・S3・S7〜S10・S13・S14 はそこを起点に、今の main で確かめ直した。

## 4. 「D1 で見る」項目への答え

1. **下流は自分の migration を何番から足しているか（C1 との衝突）**
   - banto-hub: `apps/banto-hub/core/migrations-sqlite/0101_api_keys.sql`〜`0112_…`。chronogazer: `0101_display_groups.sql`〜`0109_free_trends.sql`。temp-scada（`crates/scada-host/migrations-sqlite`）: 自分の migration は無い。
   - **0014・0015 とは衝突しない。番号をずらす必要は無い。**
   - 3 つとも、banto の基準の migration のうち `0002・0003・0004・0005・0007・0008・0010・0012・0013` だけを写している（items・attachments の `0001・0006・0009・0011` は持たない）。v8 では `0003_users.sql`・`0005_audit_log.sql` を差し替え、`0014_ui_settings.sql`・`0015_auth_mode_defaults.sql` を足す。
   - Hub の `core/src/db.rs` は sqlx の記録の表の名前を変えて（`dangerous_set_table_name`）`banto_tags` の migration と分けている。旧形式の DB の判定も自前（`db.rs:112` 付近、`upgrade.rs`）。v8 の「旧い DB は明示の文言で止める」をここへどう載せるかは下流の作業（**中身は読んでいない**）。
   - PostgreSQL の migration を持つ下流は無い。
2. **監査を名前（`local`）で絞っている所が下流にあるか**
   - **無い。** 監査の問い合わせ・画面で actor の名前を条件にしている所は見つからなかった。
   - `local` という文字列は、(a) 合成セッションの `username`（`apps/chronogazer/src-tauri/src/lib.rs:1209` ほか、`crates/scada-host/src/auth.rs:30,630`）、(b) セッションの `kind === 'local'` の判定（chronogazer の `session.svelte.ts:48`・`grantPolicy.ts:116`、temp-scada の `native/auth/session.svelte.ts:77`・`AuthControls.svelte:64`・`src-tauri/src/alarm.rs:114`）、(c) 予約名（I13）に出る。
   - v8 では監査の actor が `local` から `admin` に変わる（`actorKind` は `local`）。(a) の写しは追従が要る。(b) の `kind` は変わらないので、そのままでよい。
3. **`auth_status` の `initialized` を読んでいる下流**
   - Hub: `src/routes/login/+page.svelte:43`（初回セットアップの画面へ分ける）、試験と模擬（`lib/banto/testing/hubHttp.ts:79`・`lib/demo/bantoRoutes.ts:32` ほか）。
   - ChronoGazer: `src/lib/banto/grantPolicy.ts:51,180,182`、`routes/login/+page.svelte`、`components/SetupBanner.svelte`、Rust は `core/src/local_grant.rs:335-344`・`server_admin.rs:787`・`rest.rs`（`/api/auth/status` の `{initialized, grants}`）。§2 の 4。
   - temp-scada: Rust の `crates/scada-host/src/desktop_auth.rs:121-125,280-283`（`AuthStatusResult.initialized`）と `apps/banto-scada/src-tauri/src/auth.rs:80`。画面の TypeScript が `.initialized` を読む所は見つからなかった（`auth_setup` は `native/auth/client.ts` ほかが呼ぶ）。
4. **`captureDockSlot`・`restoreDockSlot`・`DockSlot`・`homeSlot`・`dockAtSlot`（`dockSlot`・`restoredAt` も）を使っている下流**
   - **無い**（2 リポジトリとも 0 件。`.claude/worktrees` は見ていない）。公開から外して困る下流は居ない。
   - 関係する別の点: 配置の木を自分で歩く・代入するコードがある（I3・S5・S6）。保存の形は v8 で `version: 4` だけになるが、DB を作り直すので旧い保存は残らない。localStorage の控え（Hub の `banto.dock.v2.<page>.<持ち主>`）は残骸になり、読まれても部品の検査で既定に戻る（**実際にそうなるかは確かめていない**）。
5. **同じオリジンのほかの localStorage キー（`banto.ui.*`・テーマ・dock の配置）を下流のデモでどう分けているか・足りない口**
   - banto-industrial: **キーで分けず、storage ごと差し替える。** デモのビルド（`VITE_BANTO_DEMO === '1'`）でだけ、`apps/*/src/hooks.client.ts` の最上位で `installDemoStorage()`（`packages/demo-backend/src/storage.ts`）を呼び、`localStorage`・`sessionStorage` をタブの中のメモリに差し替える。テーマ・dock の控え・見張りの一覧・トークンのどれも、既定のキーのまま本物の storage に届かない。
   - temp-scada: `createLocalUiSettings()` を既定のまま使い（`lib/banto/setup.ts:32`）、キーは `scada.designer.*`・`scada.theme.mode`（実際のキーは `banto.ui.scada.…`）。`localStorage` を直に触る所は無い。キーの名前で banto・industrial のデモと重ならない。認証はファイルの中の provider（`localFileAuth`）で、トークンを storage に置かない。
   - banto 自身のデモ（`deploy-demo.yml`）は既定のキーを本物の localStorage に書く。
   - **足りない口は無い。** banto のパッケージが storage に触る所は 4 つで、どれも差し替えの口がある: `createHttpAuthProvider`（`storage: 'memory'`）、`createLocalUiSettings`（`storage`）、`listViewState` の各関数（`storage`）、`createDockLayoutStore`（`storage`）。テンプレートの `settings.svelte.ts`・`app.html` が直に読む `banto.theme` などはテンプレートのコード（派生アプリが持つ）なので、パッケージの口の話ではない。
   - 気付き（判断は不要）: `createLocalUiSettings` に接頭辞を変える口は無い（`LOCAL_PREFIX` は定数）。今は誰も困っていない。
6. **dock-svelte・grid-svelte に `@banto/charts/testing` 相当の DOM 試験の下準備の口が要るか**
   - **今は要らない。** 下流は `ThreePaneDock`・`DockHost`・`BantoGrid`・`BantoTree` をマウントする vitest の試験を 1 つも持たない（`@testing-library/svelte`・jsdom の設定とも 0 件）。部品の挙動は Playwright の e2e で見て、vitest は純粋な関数と、dock を模した小さなモック（temp-scada の `designer-dock.svelte.test.ts`）だけ。
   - `@banto/charts/testing` を使う下流もまだ無い（`packages/trend` の試験に `ResizeObserver` の差し替えは見つからなかった）。

## 5. #821 の判定（`BantoTree` の 3 点）

見たもの: `packages/tree-svelte/src/BantoTree.svelte` の props（:46-124）と `core/types.ts`、temp-scada の `LayerTree.svelte`・`controllers/layer-tree.svelte.ts`、banto-industrial の 3 か所（`ConnectionTree.svelte:300`・`RecordTree.svelte:144`・`PenTagPicker.svelte:253`）。

| 点 | banto main の今 | temp-scada の実際 | 判定 |
| --- | --- | --- | --- |
| 行末のアクション | 口は無い。`label` のスニペットは見えるラベルの文字だけを置き換える（:89-95）。`columns`（`TreeColumn`）は文字だけ（`accessor` と `format`）で、ボタンを置けない | 行ごとに「表示・非表示」「ロック」「操作メニュー」の 3 つのボタン（`LayerTree.svelte:343-399`）。フォルダーの行にも操作のボタン（:263） | **口は無い（不足は事実）** |
| ドロップの可否の口 | 可否は内部の `canDrop`（`core/tree.ts:192`。自分自身・子孫へは落とせない、という木の形だけ）。利用側に聞く口・理由を返す口は無い | ドラッグ中に、落とせない理由（`layerDropTargetError`）と落とす先の説明を出す（`LayerTree.svelte:136-160`） | **口は無い（不足は事実）** |
| 外からの絞り込み | `filter` の prop は無い。絞った `nodes` を渡すことはできる（展開の状態は id で持つので、差し替えても残る。`tree-state.svelte.ts:31`）。ただし `expanded` は初めの値だけで、検索の間だけ一致の先祖を開いて、やめたら元に戻す、を外から指示する口が無い | 検索の間は一致を含むフォルダーを開き、「検索結果を展開中」を出す（`LayerTree.svelte:100-131`、`layer-tree.svelte.ts:58-94`） | **半分ある**（絞った木は渡せる。足りないのは展開を外から決める口） |

- **使い手の側**: temp-scada は `@banto/tree-svelte` に依存していない（`package.json` に無い）。`LayerTree` は `role="tree"` ではなく `nav` + ボタンの並びで、複数選択・フォルダーごとの移動の案内など、絵の編集の事情が濃い。temp-scada 自身の監査も「置き換えの効果は大きいが手間も大きい。D4 の後でよい」「小さい利用側の fixture で今の API との差を確かめてから起票する」としている。banto-industrial の 3 か所は、ドラッグなし・行末のボタンなし（Hub は右クリックのメニュー）・検索は木の外（`PenTagPicker` は検索中は木を出さず表にする）で、3 点のどれも使わない。
- **結論**: 3 点とも「banto に口が無い」ことは確かめられた。ただし「本当に不足か」＝今それを要る下流が居るか、は **否**。計画書の「不足が確かめられたら別 Issue・別 PR」に当たるほどの要望はまだ無い。§2 の 1 の推奨は「v8 では足さない」だったが、**オーナー決定で v8 に入れる（D4）**。外からの絞り込みは「絞り込みの機能を足す」ではなく「展開の状態を外から決める口を足す」（絞った `nodes` は今も渡せる）。
- 足すときの順の案（参考）: 行末のアクションのスニペット（いちばん汎用。Hub の木にも使える）→ 展開を外から決める口 → ドロップの可否を聞く口。
- ついでに見つけたこと: 名前変更の Enter に IME のガードが無い（§2 の 6）。temp-scada の監査が挙げた「IME 中のガード」はこれに当たる。`BantoGrid`・`@banto/ui` の入力は `isComposing` を見ている所がある（3 件）。

## 6. v8 の破壊的変更に当たる下流の箇所（D3 の upgrading の材料）

grep の一致数（概数。試験を含む。`apps`・`crates`・`packages`・`e2e` の `.rs`・`.ts`・`.svelte`）。

| 変更（CHANGELOG [Unreleased]） | 当たる識別子 | banto-industrial | temp-scada |
| --- | --- | --- | --- |
| 初回セットアップの撤去（C2b） | `setup_first_user` | 146 | 5 |
| 〃 | `allow_setup`（`api_router`・`extra_auth_router` の引数ほか） | 76 | 0 |
| 〃 | `is_initialized` | 22 | 6 |
| 〃 | `auth_setup` | 22 | 16 |
| 〃 | `BANTO_ALLOW_SETUP` | 22 | 0 |
| 〃 | `api_router(` / `extra_auth_router(` | 41 / 5 | 0 |
| 〃 | 画面の `.setup(` | 2 | 10 |
| 〃 | e2e の初回セットアップ（`e2e/*.playwright.config.ts` 4 本・`tests-banto-hub/banto-hub-auth.ts`） | 5 ファイル | `e2e/runtime-mode.spec.ts` ほか |
| 監査の主体（C2） | `record_write(` / `record_denied` / `actor_identity` | 33 / 12 / 26 | 0 |
| 〃 | `require_role(`（戻り値が `Caller` に） | 68 | 27 |
| 〃 | `GrantSpec {`（`audit_as_builtin_admin` を足す） | 3 | 0 |
| 持ち主のキー（C3） | `Identity {`（`UserIdentity {` を含む。`account_id` / `account_uid` を足す） | 52（うち `UserIdentity {` 8） | 31（うち 3） |
| 基準の作り直し（C1） | `UserSummary`（`kind` が増える） | 44 | 18 |
| 〃 | `BackupService::new` / `apply_pending_restore_at_startup` | 11 / 9 | 0 |
| 〃 | `users` への直接の INSERT | 4 | 2 |
| 〃 | `admin` という名前のアカウントを作る試験・fixture（予約名になる） | 約 80（`chronogazer/src-tauri/src/lib.rs` に 19） | 約 17 |
| ui-settings（C4・C5） | `ui_settings_get` / `ui_settings_set`（Tauri のコマンド） | 5 / 2 | 0 |
| 〃 | `SettingsService::ui_get(` / `ui_set(` | 1 / 1 | 0 |
| 〃 | `UiSettingsProvider.get` / `set` の直の呼び出し | I7・I8（10 か所）と模擬 I10 | 0（`createSavedSetting` だけを通す） |
| 〃 | `SessionValidation::`・`user_auth_state`（アカウントに結び付かないセッションは 401） | 41 / 27 | 0 |
| 認証モード | `auth.disabled` | 32 | 1 |
| dock（#782） | `autoHidden` を読む所 | 18 | 7 |
| 〃 | `resetLayout` / `restoreLayout` / `initialLayout` | 14 / 10 / 2 | 4 / 3 / 1 |
| 〃 | `dock.layout = …` の代入 | 0（見つからず） | 2（`App.svelte:447,467`） |
| Node 26 | ルートの `engines.node` | `>=24` | `>=24` |
| charts（#851） | `MAX_CHART_SERIES` | 1 | 0 |

- `status().initialized` の読み手は §4 の 3。
- slot の公開 API（#782 PR8c）は 0 件（§4 の 4）。
- `adaptLegacyAuthProvider` は試験 3 か所（`logout.test.ts` 2・`collectEvents.test.ts` 1）。`setup` を渡していれば落ちる（**中身は見ていない**）。
- banto-industrial は v7.9.0、temp-scada は v7.10.0 からなので、v7.10・v7.11 の変更（`isDockRearranging`・スクロール位置・`onRowContextMenu` ほか）も一緒に入る。

upgrading に足すとよい項（本書から出たもの）:
- 自作の模擬サーバー・デモの `/api/ui-settings` と `/api/auth/status` の形（I10）。
- `status().initialized` / `is_initialized()` を入口・grant の条件にしていた派生アプリ（§2 の 4）。
- `dock.layout` を自分で代入している・配置の木を自分で歩いている派生アプリ（S6・I3・S5。画面に出ているかの判定だけなら `isOnScreen` へ。操作できるか・前面のタブかの判定は別なので置き換えない）。
- `resetDemoToken` のような「トークンを置き直す」回り道は `storage: 'memory'` に替えられるが、初めのトークンは渡せない（I9）。

## 7. D2 の確定済み Issue への所見

- **#811（日付・時刻の解析と形式の複製）**: 下流は `DateInput`・`TimeInput`・`DateTimeInput`・`DateRangeInput` を 1 つも import していない。日付の入力は `<input type="date">` / `type="datetime-local">` が 7 画面（chronogazer 3、hub 1、temp-scada 3）で、ローカル時刻との変換を 3 か所で自作している（I16・S8）。`@banto/ui` の `parseDateText`・`formatDateTimeText` などを直に使う下流も無い。**公開の口の名前や形を変えても、下流は壊れない。** 逆に、寄せた後の解析・形式の関数を `@banto/ui` から引ける形にしておくと、下流の 3 か所の自作を後で消せる（今は求められていない）。
- **#816（ピッカーの `ownText`・`mirroredValue`）**: 同じ理由で、下流に影響は無い。
- **#818（テスト差し替え用の抽象の削除）**: `ReachCheckClock`・`reach_check` を使う下流は 0 件。消してよい。ほかの候補は洗っていない（Issue の本文どおり、着手時に洗う）。
- **#822（`BantoGrid` の編集の状態遷移）**: 編集の口（`onCellEdit`・`onRangePaste`・`pending`）を使う下流は Hub のタグ表 1 か所だけ（`routes/(app)/tags/+page.svelte`、`lib/banto/tagCellEdit.ts`）。`state`（外から渡す `GridState`）は 3 か所。I6（`columns` が反映されず `{#key}` で作り直す）は編集の可否の切り替えで起きているので、コントローラを切り出すときに「`editable` が後から変わる」を扱える形にしておくと、別 Issue（N2）が楽になる。#822 自体は挙動を変えない。

## 8. 確かめられなかったこと

- ビルド・テストを走らせていないので、「置き換え可」は口の形（props・関数のシグネチャ・doc）を読んでの判断。実際に置き換えて通るかは確かめていない。
- Hub が `banto-server` の `BoundServer` を使っているか（I12）。
- banto の `AuditSettings` が ChronoGazer の `parse_retention` の代わりになるか（I14）。
- `DateTimeInput` の値の形が下流の自作の変換と合うか（I16・S8）。
- メニューとモーダルが同時に残るときの層の判定（S3）が、今の main でも temp-scada の言うとおりか。
- `ThreePaneDock` の左のタブの帯が 240px で詰まる件（S14）。
- v8 の「外から代入したときの元の場所」の規則が、temp-scada の毎回の代入（S6）に与える影響。
- 旧い形の localStorage の控えが、v8 の部品で黙って既定に戻るか（§4 の 4）。
- `BantoTree` の名前変更の IME の件の実機での再現（§2 の 6）。
- ChronoGazer の「この PC から続ける」を v8 の認証モードでどう書き直すか（§2 の 4）。
- Hub の `core/src/db.rs`・`upgrade.rs` の旧形式の判定の中身（§4 の 1）。
- `.claude/worktrees` の下（指示どおり検索から外した）と、下流の `docs/` の設計書の大半。
- 下流の Rust の中で、banto の crate を包んでいる所の網羅（`run_detached`・`RESERVED_USERNAMES`・`parse_retention` の 3 つは見つけたが、`chronogazer/core/src/hub.rs` ほかの「写し」のコメント 300 件余りは、大半が Hub とアプリの間の話で、1 件ずつは読んでいない）。
