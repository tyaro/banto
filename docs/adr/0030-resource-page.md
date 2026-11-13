# ADR-0030: リソースの画面は app 層の共通部品 `ResourceListPage` / `ResourceDetail` で組み、ナビとコマンドはリソース定義から導出する

> English: [0030-resource-page.en.md](0030-resource-page.en.md)

- 状態: Accepted（2026-11-13）
- 日付: 2026-11-13
- 関連: Issue #554 / [design-ux-review-2026-11](../reviews/design-ux-review-2026-11.md) E-1 /
  conventions §4・§5・§10・§13 / [template-scope](../template-scope.md) §3.1・§6 /
  [add-resource](../recipes/add-resource.md) ステップ 7・8 / [ADR-0009](0009-schema-ui-rest-renderer-boundary.md) /
  [ADR-0012](0012-lan-public-viewer-synthetic-session.md) / [ADR-0018](0018-shared-ui-package.md) /
  後続: #555（B-2＋C-4 検索・フィルタチップ・保存ビュー）・#556（C-1＋B-4 基礎部品と `window.confirm` の廃止）

## コンテキスト

**画面はコピーで増やしている。** `ResourceDefinition`（`packages/admin-core/src/registry.svelte.ts`）は
`name` / `label` / `icon` / `schema` / `capabilities` を持つが、画面は items のルート一式をコピーして書き換える
（add-resource ステップ 8。2026-07-18 に「動的ルート `[resource]` は採用せず、items をコピーする」と決めた —
template-scope §6）。2026-11-13 時点の行数（テストと日報ページを除く）:

| ファイル（`apps/admin-template/src/routes/(app)/items/`）      | 行数         |
| -------------------------------------------------------------- | ------------ |
| `+page.svelte`（一覧）                                         | 1,101        |
| `ItemsServerGrid.svelte` / `ItemsClientGrid.svelte`            | 229 / 127    |
| `[id]/+page.svelte`（詳細・編集） / `new/+page.svelte`（新規） | 271 / 75     |
| `rowSaveQueue.ts` / `importPreview.ts` / `itemRow.ts`          | 80 / 40 / 23 |
| 計                                                             | 1,946        |

このうち items に固有なのは、CSV 取込（`itemsAdmin.ts` の `importItems`。`DataProvider` に取込の口は無い）と
その規則の文言 `items.importRules`、名前から作る「カテゴリ」列とグループ化のデモ、日報ボタン（オプション
`@banto/report`）、添付パネル（オプション `@banto/attachments`）、注釈ドロワーの本文くらいで、残り —
読み込み方の切替（client / server）、絞り込み・並びの復元（#215）、行の保存キュー、範囲貼り付け、
絞り込みから外れた行の通知、CSV 出力（Tauri はフォルダへの書き出し）、列メニュー、viewer の読み取り専用、
未保存の確認、削除 — はどのリソースでも同じ形になる。

**ナビも手で足す。** `navigation.ts` の items 項目（`[scaffold:items]` の印つき）、`NavIconKey` /
`NavLabelKey` の union、`navIcons.ts` の `Package`。コマンドパレットのページ移動は `navItems` から導出済み
（`commands.ts`）なので、ナビを導出すればパレットもついてくる。なお `ResourceDefinition.icon`（items は
`'📦'`）はどこからも読まれておらず、ナビの文言 `nav.items`（Products）と定義の `label`
（`items.resourceLabel` = Product）は英語で単数・複数が違う。

**直近の変更（#561〜#565）。** 一覧のヘッダーに「表示」メニュー（読み込み方の切替。#563）、デモビルドだけの
注釈（`AnnotationButton` をヘッダーの操作に、`AnnotationDrawer` をページの根に置く — ヘッダーは
`view-transition-name` を持ち fixed の子の包含ブロックになるので、ドロワーをヘッダーの中に描けない。#565）、
`items.importRules` を取込ボタンの title・注釈・取込の確認パネルの 3 か所で使う形が入った。

**scaffold はこの形に文字列で依存している。** `scripts/scaffold.mjs` の `removeItems` はルート一式・
`resources/items.ts`・`itemsAdmin.ts`・`sampleData.ts` を消し、`navigation.ts` の印の区間と union の 1 語、
`navIcons.ts` の `Package`、辞書の `items.*` / `nav.items` を落とす。`removeReport` は一覧の
`+page.svelte` の lucide の import と日報ボタンを、`removeAttachments` は `[id]/+page.svelte` の 3 つの import と
`M20 demo wiring` の区間を、どちらも一字一句の一致で切る。`template-acceptance.yml` は 4 つのプリセットで
`scaffold.mjs --strict` を当てたコピーに `verify:architecture`・`check`・`build`・`cargo test` を通し、
`scaffold.test.mjs` も回す。

**部品の置き場の制約。** パッケージ間の import はゼロ（conventions §4「現状の担保」）、パッケージは `#lib` も
Paraglide も持たない（§5・§13）。一覧は `@banto/grid-svelte`・`@banto/forms`・`@banto/ui`・`@banto/admin-core`
を同時に使う。

## 決定

### 1. 置き場は app 層。パッケージにしない

`apps/admin-template/src/lib/resource/` を新設し、`ResourceListPage.svelte`・`ResourceDetail.svelte` と
その下請け（server / client のグリッド、保存キュー、取込の確認パネル、権限の判定）を置く。app 層のコアとして
扱い、scaffold のどのプリセットも消さない（display はリソース 0 件のまま型検査を通す）。
**`lib/resource/` はオプション資産（`@banto/attachments`・`@banto/report`・`@banto/charts`・`@banto/dock-svelte`・
`@banto/tree-svelte`、コマンドパレット）を import しない**。オプションの配線は各リソースのルートのファイルから
snippet で差し込む（§4「コア → オプションの逆依存禁止」を app 層の中に延ばしたもの）。

### 2. ルートは動的化しない

2026-07-18 の「動的ルート `[resource]` を採用しない」は維持する。リソースごとに `routes/(app)/<name>/` の
3 本（一覧・`[id]`・`new`）を置き続けるが、中身は共通部品を呼ぶ薄いファイルにする。置き換えるのは
「items のルート一式をコピーして書き換える」の部分だけ。ルートが実在するので、`RouteId` の型・
`(app)/+layout.ts` の閲覧公開のガード・scaffold の「ディレクトリを消せば外れる」はそのまま効く。

### 3. 定義は 2 層。admin-core は変えない

- **`@banto/admin-core` の `ResourceDefinition` は段 1〜5 では変えない**（破壊的変更なし。外部利用 fixture にも
  影響しない）。
- **app 層に拡張の型 `AppResourceDefinition<T>`（`#lib/resource/types.ts`）を置く。** `ResourceDefinition` を
  継承し、画面に要るものだけを足す。形の案（最終形は各段の PR で決める）:

```ts
interface AppResourceDefinition<T extends { id: string | number }> extends ResourceDefinition {
	schema: FormSchema; // 任意から必須に狭める
	path: AppPath; // '/items'
	description?: () => string;
	nav?:
		| false
		| {
				icon: Component; // lucide の部品を定義ファイルが直接持つ（絵文字はやめる — A-5）
				label?: () => string; // 既定は label。英語の複数形などで分ける
				publicViewer?: boolean; // 閲覧公開の画面の許可リスト（ADR-0012。認可ではない）
				badge?: boolean; // 未読の変更のバッジ（navBadges）
				adminOnly?: boolean;
		  };
	list?: {
		loadModes?: readonly ('server' | 'client')[]; // 2 つなら「表示」メニューに切替を出す
		columns?: SchemaColumnOverrides<T>; // columnsFromSchema の overrides
		groupBy?: { field: string; label: () => string }[]; // client のときだけ
	};
	csv?: {
		export?:
			boolean | { toFolder?: (csv: string, filename: string) => Promise<FolderExportResult> };
		import?: {
			available?: () => boolean; // provider 層の判定（conventions §10）。既定は常に可
			rules: () => string; // items.importRules の置き場
			run: (rows: ResourceImportRow[]) => Promise<ResourceImportResult>;
			required?: readonly string[]; // 既定はスキーマの required で readonly でない欄（段 5）
			preview?: readonly string[]; // 確認表の列。既定は required（段 5）
			idType?: 'integer' | 'string'; // id 列の読み方。既定は integer（段 5）
		};
	};
	demoNotes?: () => string[]; // デモビルドの注釈ドロワーの段落
	canWrite?: (role: Role) => boolean; // 既定は canWriteResources
}
```

文言は `get label()` と同じく関数で遅延させる（`resources/items.ts` の冒頭の注記の理由 — 起動時に評価すると
既定ロケールに固まる）。`defineResource()` は型推論のための恒等関数だけで、実行時の仕掛けは持たない。

### 4. 部品の境界と API

**`<ResourceListPage resource={itemsResource}>`** — Issue の書き方（文字列の名前）ではなく**定義そのものを渡す**。
行の型 `T` が snippet まで届き、名前の引き直しと「登録し忘れ」の実行時エラーが要らない。既定で持つもの:

- ページの見出し（`PageHeader`。`label`・`description`）、主操作「新規作成」
- 「表示」メニュー: 読み込み方（`loadModes` が 2 つのとき）・グループ化（`groupBy` があり client のとき）。
  #555 の保存ビューとフィルタチップもここと一覧の上に足す（1 か所で全リソースに届く）
- 列メニュー、CSV 出力（`getList` ＋ `toCsv`。`toFolder` があれば Tauri のフォルダ書き出し）、
  CSV 取込（`csv.import` があるときだけ。確認パネルと `rules` を含む）
- server / client の 2 つのグリッド、絞り込み・並びの復元（#215。保存のキーはリソース名と読み込み方）、
  セルの編集と保存キュー、範囲貼り付け、絞り込みから外れた行の通知
- 権限による出し分け（§5）、デモビルドの注釈（§7）

差し込み口（snippet）は少なく始める: `actions`（主操作の前に足す操作。日報ボタンはここ）、`viewMenu`
（「表示」メニューへの追加項目）、`beforeGrid`（KPI など一覧の上。取込の確認パネルの下）、`empty`（空状態。B-6）、`annotation`
（`demoNotes` の代わりに注釈を自分で描く）。列の見た目はグリッドの列定義の `overrides` で変え、snippet にしない。

**`<ResourceDetail resource={…} id={…}>`** — `id` が `null` なら新規、値があれば編集。`createFormResource` と
`BantoForm`、未保存の確認、保存・削除、viewer の読み取り専用を持つ。差し込み口は `after`（フォームの下。
添付パネルはここ）と `actions`。B-3（詳細を右ドロワーで開く）は、同じ部品を一覧のドロワーの中に置けるよう
「ページの外枠に依存しない」形にしておくが、ドロワーを既定にする切替そのものは本 ADR の段に入れない（論点 4）。

### 5. 権限による出し分け

`resourcePermissions(definition, role)`（純関数）が `{ create, edit, delete, import, export }` を返す。書き込み系は
「定義の `capabilities` がその操作を持つ」かつ「`canWrite(role)`（既定 `canWriteResources`）」、出力は読み取り
なので `capabilities.list` だけを見る。取込は新規の行を足すだけでなく既存の行も更新するので、`capabilities` の
`create` と `edit` を両方持つときだけ許す（段 2 で決定）。持たない操作は**隠す**（無効表示にしない — M10 の方針）。これは画面の
出し分けで、認可はサーバーの `RoleGuard` と Tauri の `require_role` が持つ（conventions §1。変えない）。
閲覧公開のセッションは role が viewer なので自動的に読み取り専用になり、`nav.publicViewer` は画面の許可リストの
ままにする（ADR-0012）。

### 6. i18n キーの持ち方

- リソースに依らない文言（新規作成・CSV 出力・取込・「表示」・読み込み方・保存の通知・`{resource}を編集` など）は
  **新しい接頭辞 `resource.*`** に移す。リソースに固有の文言は `<name>.*` に残し、定義から関数で参照する。
- 部品は app 層にあるので Paraglide を直接使う（§13）。`@banto/*` は辞書を持たないまま（変更なし）。
- scaffold の `removeMessageKeys(['items', 'nav.items'])` は `resource.*` を残すので、display でも汎用の文言は残る。

### 7. デモビルドの注釈と `items.importRules`

`ResourceListPage` は、定義に `demoNotes` があるか `annotation` snippet が渡されたときだけ、ヘッダーの操作に
`AnnotationButton`、ページの根に `AnnotationDrawer` を置く（包含ブロックの制約を部品の中で 1 回だけ守る）。
デモビルドでだけ見える条件は `AnnotationButton` の `isDemoBuild()` のまま変えない。
取込の規則は `csv.import.rules` に置き、取込ボタンの title と確認パネルで部品が使う。注釈に出すかどうかは
定義の `demoNotes` が決める（items は今どおり出す）。部品が勝手に注釈へ足すことはしない。

### 8. ナビとコマンドパレットの導出

- `navigation.ts` は `resources` のうち `nav !== false` のものから項目を作り、ダッシュボードの直後に
  `resources` の順で並べる（論点 8）。`pageTitles` の `/(app)/<name>/new`・`/(app)/<name>/[id]` は
  `resource.createTitle` / `resource.editTitle` で導出する。
- `NavIconKey` / `NavLabelKey` の union と `NAV_ICONS` は**手書きの固定ページ（dashboard・tree・users など）
  だけ**のものに戻す。リソース由来の項目はアイコンの部品と文言の関数を定義から受け取る。
- ページ移動のコマンドは今どおり `navItems` から出る。加えて `commands.ts` に、作成できるリソースごとの
  「<label>を新規作成」を足す（`visible()` が `resourcePermissions` とセッションに従う）。`commands.ts` は
  コマンドパレットの remover が丸ごと消すので、オプションへの逆依存は生まれない。レコード検索（B-5）は対象外。

### 9. scaffold.mjs と template-acceptance の作り直し

- **`removeItems` のフロント側は「消すだけ」になる。** ルートのディレクトリ・`resources/items.ts`・
  `itemsAdmin.ts`・`sampleData.ts` を消し、`resources` の配列を空にし、辞書の `items.*` / `nav.items` を落とす。
  `navigation.ts`・`navIcons.ts` への items の編集（印の区間・union の 1 語・`Package`）は不要になる。
- **オプションの remover の錨は薄いルートのファイルに移し、自由な文字列から `[scaffold:<tag>]` の印に変える**
  （`cutMarked`）。日報ボタンは一覧のルートの `actions` snippet、添付パネルは `[id]` のルートの `after` snippet に
  置くので、錨の対象は数十行のファイルになる。
- **各段の PR は scaffold.mjs と `scaffold.test.mjs` を同じ PR で直す。** フロントだけの変更でも、push の前に
  4 つのプリセットで `node scripts/scaffold.mjs --preset <p> --dry-run --strict` を手元で通す
  （template-acceptance の `paths` は `src/routes/**`・`src/lib/**` を含むので CI でも走るが、手元で先に見る）。
- template-acceptance の工程は増やさない。`lib/resource/` がオプションを import しないことは
  `verify:architecture` に規則を 1 つ足して守る（段 3。全プリセットのコピーでも走る）。
- display（リソース 0 件）でナビの導出と `lib/resource/` が壊れないことを、`navigation.test.ts` の
  「リソースが空」のケースと display の受け入れで確かめる。

### 10. 段階的な PR 分割

各段は単独でマージでき、CI（frontend・e2e・template-acceptance）が緑になる粒度にする。各段で画面の DOM を
変えないことを狙い、変わったら visual のベースラインを `visual-baselines.yml` の dispatch で作り直す。

| 段  | 内容                                                                                                                                                                                                                                                                                                                         | 規模の目安                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0   | 本 ADR と索引                                                                                                                                                                                                                                                                                                                | 文書のみ                         |
| 1   | ナビをリソース定義から導出。`AppResourceDefinition` の `path` と `nav` だけを入れ、items の定義に足す。`navigation.ts` の items 項目・union の 2 語・`Package` を消し、`removeItems` を直す。`navigation.test.ts` に導出・空・閲覧公開・ページ題のケース                                                                     | 小（±150 行）                    |
| 2   | `resourcePermissions` と「<label>を新規作成」コマンド。純関数のテストと `commands.test.ts`                                                                                                                                                                                                                                   | 小（±120 行）                    |
| 3   | `ResourceDetail` を切り出し、items の `[id]`・`new` を置き換える。添付は `after` snippet と `[scaffold:attachments]` の印。`removeAttachments` を直す。`verify:architecture` に「`lib/resource/` はオプションを import しない」と conventions §4 への追記                                                                    | 中（移動が主）                   |
| 4   | `ResourceListPage` の骨格: 見出し・「表示」メニュー・列メニュー・新規作成・注釈・権限・2 つのグリッド（`ItemsServerGrid`/`ItemsClientGrid` を汎用化して移す）・#215 の復元・セルの編集と保存キュー・CSV 出力。CSV 取込は一時的に items のルートの snippet に残す。日報ボタンは `actions` snippet と `[scaffold:report]` の印 | 大（移動が主。差分の多くは移設） |
| 5   | CSV 取込を `csv.import` で汎用化し、確認パネルを `lib/resource/` へ。add-resource ステップ 7〜9（日英）、template-scope §6 の 2026-07-18 の項を更新                                                                                                                                                                          | 中                               |

段 0（本 ADR）が Accepted になってから段 1 に着手する（ADR の運用）。#556 の `ConfirmDialog` は段 3 の後に
`ResourceDetail` の削除へ 1 回入れれば全リソースに届く。#555 は段 4 の後に `ResourceListPage` へ入れる。

**行数の見込み（控えめに）。** テンプレート自身の行数はほぼ変わらない（汎用部品へ移すだけで、汎用化の分だけ
少し増えることもある）。減るのは **2 本目以降のリソースが書く量**で、今は約 1,950 行のコピーと書き換えだが、
定義ファイル（100〜150 行）とルート 3 本（各 10〜40 行）程度になる見込み。items の固有のコードは定義と
ルートに 300〜400 行ほど残る見込み。どちらも段 4・5 の PR で実測して本文に書く。

**段 4 の実測（2026-11-13）。** 一覧の部品は `lib/resource/` に 1,324 行（`ResourceListPage.svelte` 691・
`ResourceServerGrid.svelte` 263・`ResourceClientGrid.svelte` 161・`rowSaveQueue.ts` 84・`listState.ts` 68・
`columns.ts` 57。テストを除く）になり、`types.ts` が 71 行増えた。items の一覧はルート一式 1,691 行
（`+page.svelte` 1,191・グリッド 2 本 391・`rowSaveQueue.ts` 84・`itemRow.ts` 25）から、ルート 555 行と定義の
増分 69 行（`items.ts` 95 → 164）になった。ルート 555 行のうち約 510 行は段 5 で部品へ移す CSV 取込で、それを
除くとルートは 50 行弱。テンプレート全体の一覧まわりは約 1,790 行から約 2,110 行に**増えた**（doc コメントと
汎用化の型の分。見込みの「ほぼ変わらない」より多い）。2 本目のリソースが CSV 取込なし・server だけで書く量は、
定義が 60〜100 行（items から client のグループ化の見本 約 55 行を除いた量）、ルートが一覧 10 行前後・`[id]` と
`new` が各 20〜30 行で、合わせて 150 行前後になる。items の固有のコードは今 797 行（定義 164・ルート 3 本 633）
で、段 5 で取込を移した後に改めて測る。

**段 5 の実測（2026-11-13）。** CSV 取込を部品へ移し、段 4 の一時的な差し込み口 `csvImport` を消した
（`beforeGrid` は KPI などのために残す）。一覧の部品は 2,015 行（`ResourceListPage.svelte` 816・
`ResourceImportPanel.svelte` 348・`csvImport.ts` 214・`ResourceServerGrid.svelte` 263・
`ResourceClientGrid.svelte` 161・`rowSaveQueue.ts` 84・`listState.ts` 68・`columns.ts` 61。テストを除く）に
なり、`types.ts` がさらに 42 行増えた（111 → 153）。items の一覧のルートは 555 行から 34 行に、定義は
164 行から 193 行（`csv.import` と、汎用の行を `ItemImportRow` に直す `toItemImportRow`）になり、
`importPreview.ts`（45 行）は汎用の `csvImport.ts` に置き換わった。items の固有のコードは 797 行から
**305 行**（定義 193・ルート 3 本 112）になった — 見込みの 300〜400 行の下端。テンプレート全体の一覧まわりは
約 2,110 行から約 2,200 行に増えた（取込の汎用化 — 必須列・確認表の列・文字列 id・一部だけ反映された
ときの表示 — と doc コメントの分）。2 本目のリソースが CSV 取込を持つときに足す量は、定義の `csv.import`
の 5〜10 行と取込の API のクライアント（items の `importItems` は約 10 行）だけになる。

## 検討した代替案

- **案A（採用）: app 層の共通部品 ＋ 薄いルート ＋ app 層の定義の拡張。** パッケージ間 import の制約に触れず、
  Paraglide をそのまま使え、派生アプリが部品そのものを読んで書き換えられる（コピー型テンプレートの方針と合う）。
  欠点: 一覧の部品は 1,000 行級になり、読む負担が 1 か所に集まる。ファイルの分割と doc コメントで抑える。
- **案B（不採用）: 動的ルート `routes/(app)/[resource]/`。** 2026-07-18 の判断の理由（利用者が読み解けない
  魔法）がそのまま残る。リソースごとの差し込みがルートの分岐になり、`RouteId` の型のページ題、閲覧公開の
  ガード、scaffold の「ディレクトリを消せば外れる」がどれも効かなくなる。
- **案C（不採用）: 新しいパッケージ `resource-page`。** パッケージ間 import ゼロ（§4）のもとでは
  grid・forms・ui を使えず、すべてを注入にすると props と `messages` が数十個になる。辞書を持てない（§13）。
  派生アプリは node_modules の中を書き換えられない。
- **案D（不採用）: 雛形からの生成（E-2 のジェネレータで画面も出す）。** 生成した後のコードには #555・#556 の
  改善が届かない。E-2（Rust 側の定型の生成）とは補い合う関係で、画面は部品、Rust 側は生成と分ける。
- **案E（不採用）: admin-core の `ResourceDefinition` に画面の項目を全部入れる。** コアのパッケージが
  lucide の部品や grid の列の上書きの型を持つことになり、パッケージ間 import ゼロに反する。app 層の拡張型に置く。
- **案F（不採用）: 現状維持（レシピの改善だけ）。** 2 本目のリソースのコピー量と、横断の改善を N 回
  当てる手間が残る。

## 帰結

- 不変条件は変えない（§1 の両経路の認可・監査、§10 の demo の拒否、§13 のキー経由）。§4 の「コア →
  オプションの逆依存禁止」を app 層の `lib/resource/` にも当て、`verify:architecture` で守る（段 3 で
  conventions §4 に追記）。
- template-scope §6 の 2026-07-18 の項は、段 5 で「動的ルートは採用しない（維持）・画面は定義 1 つとルート 3 本」
  に書き換える。ADR 索引の「ADR 化候補」から「なぜリソースのルートを動的化せず items をコピーするか」を外す
  （本 ADR が記録する）。
- ADR-0009 と整合する: シリアライズできる宣言の中核（admin-core の `ResourceDefinition` とスキーマ・
  `capabilities`）は変えず、関数・部品を持つ拡張は Web のレンダラ（app 層）に固有の拡張点として置く。
  `ResourceListPage` は Svelte の部品で、レンダラに依らない UI の DSL ではない（ADR-0009 §3）。
  template-scope §4.2（画面エディタを入れない）とも衝突しない — 定義はコードで、GUI の組み立てではない。
- 汎用の文言のキーが `items.*` から `resource.*` に移るので、派生アプリの辞書に差分が出る（CHANGELOG に書く。論点 6 で minor）。
- 外し方: 部品は app 層のコードなので、ルートのファイルに中身を書き戻せば外せる。

## 決めた論点（2026-11-13、オーナーが推奨どおりに承認）

1. **置き場:** app 層の `lib/resource/` にし、パッケージにしない（§1）。段 1〜5 で admin-core は変えない。
   Issue のタイトルの `feat(admin-core)` は実装の PR では使わない。
2. **prop の形:** `resource` には文字列の名前ではなく定義のオブジェクトを渡す（§4）。
3. **読み込み方の既定:** 定義が `loadModes` を指定しないときは server（ページング）だけにする。件数が増えても
   重くならない側を既定にする。items は今どおり両方を持ち、「表示」メニューで切り替えるデモを続ける。
4. **B-3（詳細を右ドロワーで開く）:** 本 ADR の段には入れない。`ResourceDetail` はページの外枠に依存しない形に
   しておき、ドロワーを既定にするかどうかは段 4 の後に別の Issue で決める。
5. **`ResourceDefinition.icon`:** 削除しない（admin-core の公開 API の削除は major になるため）。doc コメントに
   「画面では読まない。ナビのアイコンは app 層の `nav.icon` を使う」と書いて非推奨にする（段 1 で行う）。
   削除は次に major を出すときに改めて判断する。
6. **キーの移動の版番号:** minor とする。辞書はコピーしたテンプレート（CHANGELOG の B 節）にあり、`@banto/*` の
   公開 API ではない。CHANGELOG の「消費側への注意」に移ったキーの一覧と取り込み方を書く（publishing.md の
   2.x 以降の運用上の例外と同じ扱い）。
7. **users・監査ログ:** 本 ADR の対象外のままにする。リソース定義（`capabilities` と スキーマ）を持たず、画面の
   要件も違うため。載せたくなったら別の Issue にする。
8. **ナビの位置:** 「ダッシュボードの直後、`resources` の配列の順」に固定し、`nav.order` は持たせない。
   順は配列の並べ替えで変えられる。固定ページの間に挟みたい要望が出たら足す。
