# ダッシュボードにウィジェットを足す・期間を使う

アプリ作者向け。ダッシュボード（`/dashboard`）の KPI の帯とウィジェット（チャート・一覧・メモ）に、自分の項目を足す手順と、
見出しの「期間」で絞った行を使う手順（#716）。

線引き: **配置**（追加・並べ替え・大きさ・表示 / 非表示）は利用者が画面で編集でき、利用者ごとに保存される。ウィジェットの
**種類と中身**は作者がコードで登録する。利用者がデータの出どころ・式・見た目を画面で組む口は無い
（[template-scope §4.2](../template-scope.md)）。

ファイルはどれも `apps/admin-template/src/lib/` の下。

| ファイル                                           | 役割                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `banto/dashboardData.svelte.ts`                    | `createDashboardData()`。データを 1 回だけ読み、期間で絞った行と KPI の数字を持つ         |
| `banto/dashboardPeriod.ts`                         | 期間の選択肢と、行の絞り込み（`narrowRows`）                                              |
| `banto/dashboardKpis.ts`                           | KPI の帯の定義（配列 1 つ）                                                               |
| `banto/dashboardWidgets.ts`                        | ウィジェットの登録（1 ウィジェット = 登録 1 件 + 部品 1 ファイル）                        |
| `banto/dashboardLayout.ts`                         | 既定の配置（`DEFAULT_ROWS`）・dock の高さ・保存キー                                       |
| `components/dashboard/`                            | ウィジェットの部品。チャートは `charts/`                                                  |
| `components/dashboard/DashboardWidgetFrame.svelte` | ウィジェット 1 枚を置かれた箱に描く枠（高さを測って渡す。期間を使うかで渡すデータを選ぶ） |

## ウィジェットを足す

1. **部品を 1 ファイル書く**（`components/dashboard/MyWidget.svelte`）。props はどのウィジェットも同じ
   `DashboardWidgetProps`（`data` と `height`）。**部品は自分でデータを読まない**（ページが 1 回読んだ `data.rows` を使う）。

   ```svelte
   <script lang="ts">
   	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';

   	let { data, height }: DashboardWidgetProps = $props();
   	const expensive = $derived(data.rows.filter((row) => row.price >= 200).length);
   </script>

   <p style:height="{height}px">{expensive.toLocaleString()}</p>
   ```

   チャートを描く部品は `charts/` に置き、`ChartFit` で包む（凡例の高さを引いて、区画に収める。隣の `MonthlyWidget.svelte` が見本）。

2. **登録に 1 件足す**（`banto/dashboardWidgets.ts`）。

   ```ts
   widgets.push({
   	id: 'expensive', // 保存した配置に入るので、あとから変えない
   	titleKey: 'panels.expensive', // 文言のキー（messages/ja.json・en.json の両方に足す）
   	icon: 'expensive', // components/PanelIcon.svelte の表に足す（無ければ文字で出る）
   	width: 360, // 浮動の窓の大きさ
   	height: 320,
   	component: MyWidget,
   	usesPeriod: true // 期間で絞った行を使う（下の「期間を使う」）
   });
   ```

   `@banto/charts` を使う部品の登録は `[scaffold:charts]` の印の間に、メモのように dock に結び付く部品は `[scaffold:dock]` の印の間に書く
   （`pnpm scaffold` がその資産を外すとき、登録と部品を一緒に消す）。どちらも使わない部品は、印の外に書く。
   dock 専用の部品を足すときは、(a) `dashboardWidgets.ts` の import と登録の**両方**を既存の `[scaffold:dock]` の印の中に置く、
   (b) 自分の部品ファイルを `scripts/scaffold.mjs` の `removeDock`（`MemoWidget.svelte` を消している行の隣）の削除対象に足す
   （`removeDock` が消すのは `MemoWidget.svelte` 固定で、ほかの部品ファイルは自動では消えない。残ると、消えた import を
   参照して `pnpm check` が落ちる）。charts 専用も同様に `removeCharts` へ。

3. **既定の配置に置くなら** `banto/dashboardLayout.ts` の `DEFAULT_ROWS` に id を足す。足さなければ、利用者が「表示」メニューで
   足せる（浮動の窓で出る）。すでに配置を保存している利用者には、既定を変えても届かない（「レイアウトを既定に戻す」で届く）。

4. 確かめる: `pnpm --filter admin-template test`（登録の単体テストが id の重複・title・部品を見る）、`pnpm check`、画面で
   「表示」メニューに出ること。

## KPI のタイルを足す

`banto/dashboardKpis.ts` の `DASHBOARD_KPIS` に 1 件足す（`id`・`label` の getter・`icon`・`value(data)`）。帯は固定で、
利用者は並べ替えも非表示もできない。数字をいくつものタイルで使うなら、`dashboard.ts` の `computeStatTiles` に足す
（`data.stats` は行が変わるたびに 1 回だけ計算される）。KPI の帯は、いつも期間で絞った行で描く。

## 期間を使う

ページの見出しに「期間」の操作が 1 つあり（全期間・直近 30 日・直近 90 日・直近 12 か月。既定は全期間）、ページがその状態を 1 つ持つ。

- **登録に `usesPeriod: true` と書くと**、そのウィジェットの `data.rows`・`data.stats` は期間で絞った行になる（KPI の帯と同じ行）。
  期間を変えると、KPI の帯と `usesPeriod` のウィジェットだけが描き直される。
- **書かなければ**（メモ、流れるトレンドのように期間と関係のないもの）、`data` は読み込んだ行そのままで、期間を変えても描き直されない。
- **部品は期間の中身を知らなくてよい**。渡された `data.rows` を描くだけ（上の `MyWidget` は、`usesPeriod` を書けばそのまま期間に追随する）。
- **期間は保存されない**。再読み込みで全期間へ戻る。配置の保存値にも入らない。切り離した窓（Tauri のポップアウト。別の文書）へは
  届かず、全期間で描く。
- 期間を変えても、サーバーへ読み直しには行かない（読み込み済みの行を画面の側で絞る）。

### 自分のデータに合わせる（`banto/dashboardPeriod.ts`）

見本は items の `updatedAt` で絞り、**データの中でいちばん新しい `updatedAt` からさかのぼって数える**（見本のデータは日付が固定なので、
今日から数えると「直近 30 日」が空になるため）。自分のアプリでは次を書き換える。

- **基準の日を今日にする**: `narrowRows` の `latestDay(rows)` を、今日の日付（`new Date().toISOString().slice(0, 10)`）にする。
- **絞る列を変える**: `narrowRows` と `latestDay` の `row.updatedAt` を、自分の日付の列にする（`YYYY-MM-DD` で始まる文字列を想定）。
- **選択肢を変える**: `DASHBOARD_PERIODS` と、日数・月数の表（`DAYS`・`MONTHS`）、ページの `PERIOD_LABELS`、文言
  （`dashboard.period*`。ja・en）を合わせて直す。日付の範囲を自由に入れる口は無い。
- **条件を足す**（カテゴリで絞る、など）: `DashboardFilter` に欄を足し、`narrowRows` に絞り込みを 1 段足す。ページは
  `let filter = $state<DashboardFilter>(…)` を `createDashboardData({ filter: () => filter })` に渡しているので、操作を足して
  `filter` の欄を書き換えれば、KPI の帯と `usesPeriod` のウィジェットへ届く。
- **サーバーで絞りたい**（行が多く、全件を読めない）ときは、`createDashboardData()` の読み込みごと差し替える
  （期間が変わるたびに、条件を付けて読み直す形にする）。ウィジェットが見るのは `DashboardData` だけなので、部品は変えなくてよい。

期間を使わないなら、ページ（`routes/(app)/dashboard/+page.svelte`）の `SegmentedControl` と `filter` を消し、
`createDashboardData()` を引数なしで呼ぶ（何も絞られない）。

## 印から一覧へ移る

チャートの印（価格帯のドーナツの 1 片）が数えた行を持つ一覧（`/items`）へ移れる（Issue #882。設計は
[crossfilter-drilldown-design.md](../design/crossfilter-drilldown-design.md) §7.2）。
**見本のダッシュボードでは、印そのものは「絞る」操作（次の節）で、一覧へは、価格帯を選んだときに見出しの下に出る帯の「一覧で開く」から移る**
（#882 C2 で意味を変えた。設計書 §7.4）。絞り込みを使わないウィジェット（`selects` を登録しないもの）は、下の 3 のとおり印から直接移ってよい。

流れ: 部品が「何を選んだか」だけを言い（`onDrill({ kind: 'priceBucket', bucket })`）、期間を足して URL を作るのはページ
（`banto/dashboardDrill.ts` の `drillHref`）。部品は期間を知らないままでよい。

1. **一覧の側にビューを用意する**（[add-resource.md](add-resource.md)「一覧のビューに引数を持たせる」）。移る先は `?view=<id>&arg.<名前>=<値>` で、items の見本は
   `price-band`（`arg.band`）と `low-stock`（`arg.after`）。区切りの表は 1 か所（`resources/items.ts` の `PRICE_BANDS`）で、集計もビューもそれを読む。
2. **`DashboardDrill` に種類を足し**、`drillHref` に移る先を書く。期間が「全期間」でなければ、`periodStart` が返した日（`latestDay` から数えた日。
   **その日は含まない**下限）をそのまま `arg.after` に載せる。一覧の側で基準の日を数え直さない。
3. **部品**: 印から直接移すウィジェットは、`DashboardWidgetProps` の `onDrill` があるときだけ、チャートに `onMarkActivate` を渡す
   （`onMarkActivate={onDrill ? (mark) => onDrill({ kind: 'priceBucket', bucket: PRICE_BANDS[mark.index].id }) : undefined}`）。
   印で絞り込むウィジェット（次の節）では、移る口は選択の帯（`DashboardSelectionBar.svelte` が `drillHref` でリンクを作る）。
   **`onMarkActivate`・`markLabel`・`markSelected` は `components/dashboard/charts/` の中だけで使う**
   （charts を外すと部品ごと消える。登録・ページ・枠・帯は `@banto/charts` を import しない）。
4. **KPI のタイル**: `dashboardKpis.ts` の `link` に `drill` を書くと、帯が `drillHref` で URL を作る（期間つき。「在庫少」が見本）。

決まっていること:

- **カテゴリは入れない**。items に実在のカテゴリの列が無い（名前の先頭の語からの派生）ため、価格帯と在庫少だけ（オーナー決定）。
- **切り離した窓（Tauri のポップアウト、`/panel/[id]`）では印を選べず、ドリルダウンも絞り込みもしない**。ページが `onDrill`・`select` を渡さないので、
  部品は `onMarkActivate` を渡さず、フォーカスも止まらない。シェルの無い小さな窓の中で `/items` へ移らないため（選択も窓へは届けない）。
- **取得の上限を超えたときだけ画面で断る**。ダッシュボードは最大 20,000 行（`DASHBOARD_ROW_LIMIT`）を読んで集計し、一覧は（サーバー方式なら）条件に合う全件に対して絞るので、
  それを超えるデータでは印の値と一覧の件数が合わない。サーバーの総数が読んだ行数（期間で絞る前）より多いときだけ、見出し・帯の「一覧で開く」の title・
  KPI のリンクの title に「ダッシュボードは取得した範囲の集計。一覧は、サーバー方式（少しずつ読み込む）なら条件に合う全件に対して絞る（全件を読み込む方式は、同じ範囲の外の行を出さない）」と出す（`DashboardData.truncated`）。期間で絞っただけでは出ない。
- リンクは 1 回きりの指示で、保存しない・ダッシュボードの URL に載せない（一覧が適用して `view` と `arg.*` を消す）。

## 外すとき

- **charts 専用のウィジェットの部品は `components/dashboard/charts/` に置く**。`pnpm scaffold` の `removeCharts` はこのディレクトリを
  ごと消す（個々のファイルは数えない）。登録の行と import は `dashboardWidgets.ts` の `[scaffold:charts]` の領域の中に書く（領域の外に置くと、
  外した後に参照が残る）。
- charts / dock を外す: `pnpm scaffold`（[remove-optional-assets.md](remove-optional-assets.md)）。charts を外すと、期間は KPI の帯と
  一覧に効く。dock を外すと、ウィジェットは登録の順に 1 列で積まれる（期間の操作は同じ）。
- ダッシュボードごと外す: `--preset display`。

## 印で絞り込む（クロスフィルタ）

チャートの印を選ぶと、ほかのウィジェットと数値の帯が、その値の行だけで描き直される（Issue #882 C1・C2。設計は
[crossfilter-drilldown-design.md](../design/crossfilter-drilldown-design.md) §6.3・§7.3・§7.4）。見本は「カテゴリ別在庫」の棒（次元 `category`）と
「価格帯分布」の片（次元 `priceBucket`）。もう一度選ぶと外れ、同じチャートの別の印を選ぶと置き換わる（次元ごとに 1 値）。
選択があるときだけ、見出しの下に帯が出る（次元ごとのチップと「すべて解除」）。選択はページの状態で、保存しない（再読み込みで消える。配置の保存値にも入らない）。

流れ: 印 → `onSelect(value)` → ページの `filter.selection`（`toggleSelection`）→ `createDashboardData` が行を絞る → 枠が登録に応じて渡す。

1. **次元を足す**（新しい次元のとき）: `banto/dashboardPeriod.ts` の `DASHBOARD_DIMENSIONS` と `DIMENSION_VALUE`（行からその次元の値を出す関数）。
   帯の表示名は `DashboardSelectionBar.svelte` の `DIMENSION_LABELS`（文言はキー経由）、値の読みは `selectionValueLabel`。
2. **登録**（`dashboardWidgets.ts`）: 印で選ばせるウィジェットに `selects: '<次元>'` と `usesSelection: true`。選択で絞られるだけのウィジェットは
   `usesSelection: true`。**自分の次元では絞られない**（選んだ棒以外も残り、選んだ棒が目立つ）。`usesSelection` を付けないウィジェットには選択が届かない
   （`usesPeriod` だけなら期間の行、どちらも無ければ読んだままの行）。
3. **部品**: `DashboardWidgetProps` の `onSelect` があるときだけ、チャートに `onMarkActivate`（`onSelect(その印の値)`）と `markSelected`
   （その印の値 === `selected`）を渡す（`CategoryStockWidget.svelte`・`PriceBucketsWidget.svelte` が見本）。`markSelected` を渡すと、印は
   切り替えのボタン（`aria-pressed`）になり、選ばれていない印が薄くなる。

決まっていること:

- **印の操作は「絞る」**。一覧へ移るのは、選択の帯の「一覧で開く」から（価格帯だけを選んでいる間だけ出る。カテゴリは一覧で絞れないので、選んでいる間は出さない）。
- **KPI の「在庫少」のリンクは選択を持って行かない**（期間だけ）。選択がある間は、タイルの中に見える文言でそう断る。
- **charts を外した構成**では選ぶウィジェットが無いので、帯は出ず、一覧のウィジェットは期間の行を描く（`DashboardSelectionBar.svelte` は `@banto/charts` を import しない）。
- 使わないなら: 登録から `selects` / `usesSelection` を消し、ページの `DashboardSelectionBar` と `select` を消す（印に `onDrill` を渡せば、D3 の「印から一覧へ」に戻る）。
