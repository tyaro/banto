# @banto/grid-svelte

Banto のデータグリッド。仮想スクロール・複数列ソート・列フィルタ・
列リサイズ/並び替え・Excel ライクなセル編集/範囲選択/コピー&ペースト・
クライアント/サーバー両モード・グルーピング+集計を提供する（spec §4）。
フォームスキーマから列を自動導出する `columnsFromSchema`（M23）も含む。

## 使用例

```svelte
<script lang="ts">
	import { BantoGrid, GridState, type GridColumn } from '@banto/grid-svelte';

	interface Row {
		id: number;
		name: string;
	}

	const rows: Row[] = [{ id: 1, name: 'ペン' }];
	const columns: GridColumn<Row>[] = [{ id: 'name', header: '商品名', accessor: 'name' }];
	const state = new GridState<Row>(columns);
</script>

<BantoGrid {rows} {columns} {state} getRowId={(row) => row.id} />
```

## セル編集の名前・エラー・保存状態（次リリース）

組み込み editor の名前は列の `header`、空白の見出しは列 `id` を使う。
入力の `aria-invalid` と、グリッドごとに一意なエラー要素への `aria-describedby` を設定し、
エラーがなくなったら参照も外す。既存の `role="alert"` とセルの枠は維持する。
保存待ちの状態は編集中セルの `aria-busy` で示す。pending の操作抑止・フォーカス所有権・
保存結果の反映・検証・session 判定を維持する。

checkbox editor は `--banto-checkbox-size`（fallback `1.1rem`）で native の形を保ち、
セル全幅・全高へは伸ばさない。フォーカスは既存の編集セル枠で示す。
行高・列幅・仮想化・native の checked / Space / 即時確定は維持する。

変換中（`isComposing` または互換用の `keyCode === 229`）と処理済み（`defaultPrevented`）の
keydown は保存・取消・セル移動へ渡さず、グリッド本体へも伝播させない。
通常のキーは確定・取消・エラー参照の規則に従う。pending 中の操作抑止と blur による確定は維持するため、
変換中の Tab がブラウザの標準動作で blur を起こした場合まで保存を止める契約ではない。

### 長いエラーの全文を読む（次リリース、ADR-0027）

エラーはスクロール領域の外側に重ねる。幅を可視範囲に収め、右端・下端や入れ子の
スクロール領域でも折返し・上下の切替・高さ制限を行う。極長文はエラー領域自身をスクロールして読める。
表の寸法・行配置・編集中の入力 DOM を変えず、表示位置だけを更新する。

| 操作                                    | 結果                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Enter で検証・保存に失敗                | 入力欄とドラフトを保持する                                                |
| エラーがある時の Tab / Shift+Tab        | 再送信せず、全文を読む領域へ移る。入力変更後も Enter で明示的に再試行する |
| エラーなしで Tab 確定し失敗             | 同じ編集とフォーカス所有権が残る場合だけエラー領域へ移る                  |
| エラー領域の矢印・Home/End・PageUp/Down | ブラウザの標準動作で全文をスクロールする                                  |
| エラー領域の Shift+Tab / Escape         | 保存・取消せず、同じ入力欄へ戻る                                          |
| エラー領域の Tab                        | 標準の順序で次の操作要素へ進む                                            |

入力欄とエラー領域の往復は blur 保存を起こさない。外クリック・別の編集・window blur が
先行した場合、保存失敗後にフォーカスを取り戻さない。領域が表示範囲から外れた時も強制復帰しない。
本文の `role="alert"` と入力欄の説明 ID を維持し、フォーカスできる領域の名前・操作ヒントを
`messages.inlineEditErrorLabel(header)` / `inlineEditErrorHint()` で上書きできる。
表の外側には常設の `.banto-grid-frame` が入る。独自 CSS で直下構造を参照する場合は
[移行の注意](../../docs/upgrading.md#グリッドのエラー領域次リリースadr-0027) を参照。

## フィルタ・選択範囲の操作性（次リリース）

列フィルタの条件選択と値入力の名前は `messages.filterOperatorLabel` /
`filterValueLabel` で上書きできる。省略時は日本語を使い、placeholder は名前と独立して維持する。
開閉ボタンは `aria-haspopup="dialog"`、`aria-expanded` と、開いている間だけ一意な dialog ID への
`aria-controls` を持つ。開くと値入力へ移り、内部の Escape・適用・クリア後はボタンへ戻る。
同じボタンの再クリックでも閉じる。外クリックは閉じるだけでフォーカスを取り戻さず、
Tab / Shift+Tab はブラウザの標準移動を使う非modalのまま。
値を空にして適用すると条件を解除する。数値入力の空欄も解除し、数値 `0` は値として維持する。
値入力の Enter と内部の Escape も、変換中（`isComposing` / `keyCode === 229`）や処理済みのキーを奪わない。

適用済みのフィルタはボタンの二重下線で示す。文字色や背景色に加えて形でも区別し、
強制配色でも印を残す。ボタン幅・列幅・見出しの省略幅は変えない。
適用中だけ列固有の説明へ `aria-describedby` を付け、hover の title にも同じ文言を出す。
説明は任意の `messages.filterAppliedDescription(header)` で上書きできる。
`aria-expanded` はポップオーバーの開閉を表し、適用状態とは独立する。
入力途中やキャンセルは適用状態を変えず、条件を適用すると印が付き、解除すると印と説明参照が外れる。

グリッド入口・見出し・フィルタ操作子のフォーカスは実線枠で示す。
強制配色では範囲選択を内側の破線、active セルを実線で区別する。選択計算・通常配色・
ソートやフィルタの値・セル編集・仮想スクロールの契約は維持する。

## 組み込みのセル表現と条件つき書式（#713）

列に `renderer` を付けると、値を文字以外で描く。解決は `core/cellView.ts` の純関数
（`resolveCellView`。値を 1 回だけ読んで view と tone を返す `resolveCellPresentation` もある）で、描画だけが `BantoGrid.svelte`。

```ts
interface Job {
	id: number;
	state: 'late' | 'ok';
	done: number; // 0..1
	qty: number;
	enabled: boolean;
	title: string;
	url: string;
}

const columns: GridColumn<Job>[] = [
	{
		id: 'state',
		header: '状態',
		accessor: 'state',
		renderer: 'badge',
		format: (v) => (v === 'late' ? '遅れ' : '順調'),
		tone: (v) => (v === 'late' ? 'danger' : 'success')
	},
	{ id: 'done', header: '進捗', accessor: 'done', renderer: 'progress' }, // 0..1
	{ id: 'qty', header: '達成', accessor: 'qty', renderer: 'progress', progressMax: 200 },
	{ id: 'on', header: '有効', accessor: 'enabled', renderer: 'boolean' },
	{ id: 'doc', header: '資料', accessor: 'title', renderer: 'link', href: (row) => row.url }
];
```

| `renderer` | 描き方                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `badge`    | `format` 後の文字を小さなバッジで。色は `tone`（無ければ neutral）                                                                                                                                               |
| `progress` | 数値を `progressMax`（既定 1、つまり 0..1）で割って 0〜100% に丸めた棒と、横の文字（`format` があればその結果、無ければ %）。棒は `role="progressbar"`（`aria-valuenow` は 0〜100、`aria-valuetext` は横の文字） |
| `boolean`  | true は ✓、false は空。読み上げは `messages.booleanTrue` / `booleanFalse`（既定「はい」「いいえ」）                                                                                                              |
| `link`     | `href(row)` への `<a>`。http(s)・mailto・tel・相対 URL だけ（`javascript:` などは文字に落とす）。文字が行で決まるなら従来の `cell` を使う                                                                        |

- 描く優先順位は `render`（snippet） > `cell` > `renderer` > 素の文字。値が描き方に合わない行（数値でない progress、boolean でない値、安全な href の無い link）は文字にフォールバックする。
- キーボード: `link` の `<a>` が実際に描かれたセルでは、Enter / Space が行操作（`onRowClick`）より先にそのリンクを開く。文字にフォールバックした行や `cell` 列は従来どおり。
- 編集: `link` は `cell` / `render` と同じく編集不可。`badge` / `progress` / `boolean` は表示だけを変えるので `editable` に従い、編集中は編集欄に置き換わる。
- コピー・CSV は従来どおり生の値（`format` も `renderer` も通さない）。列メニュー・列の並べ替え・グループ化・仮想スクロール・server モードの挙動は変わらない。
- `tone: (value, row) => success | warning | danger | info | neutral | null` は素の文字・`cell`・`renderer` のセルに役割の色を付ける（`render` には効かない）。色は theme の `--banto-success` などの状態色トークンのみで、バッジは `-tint` の組。値は `data-tone` にも出る。色だけに意味を持たせず、`format` やバッジの文字でも伝えること。

## 行選択と一括操作バー（#713）

`selectable` を付けると、先頭にチェックボックスの列が出て、1 件以上を選ぶとグリッドの下に一括操作バーが出る（既定は off）。
判定（全選択の none / some / all、切替、一覧から消えた行の除外）は `core/rowSelection.ts` の純関数で、描画だけが `BantoGrid.svelte`。

```svelte
<script lang="ts">
	let selected = $state<(string | number)[]>([]);
</script>

<BantoGrid {rows} {columns} getRowId={(row) => row.id} selectable bind:selectedRowIds={selected}>
	{#snippet bulkActions({ ids, clear })}
		<button type="button" onclick={() => removeMany(ids).then(clear)}>削除</button>
	{/snippet}
</BantoGrid>
```

- props: `selectable`、`selectedRowIds`（bindable。`getRowId` の値を選んだ順に持つ配列）、`allMatchingSelected`（bindable。server モードの「絞り込んだ全件」。下の項目）、`onSelectionChange(ids)`、`getRowLabel(row)`（チェックボックスの名前に使う行の呼び名。既定は `render` でない先頭の表示列の文字、無ければ行の id）、`bulkActions`（バーに差し込む snippet。`{ ids, clear, allMatching, matchingCount }` を受け取る）。グリッドは一括の処理を持たず、選んだ id を渡すだけ。
- チェックボックスの列は `GridColumn` ではない。列メニュー・列の並べ替え（ドラッグ）・幅の変更・並び替え・絞り込み・セルの範囲選択・コピー / 貼り付け・CSV の対象にならず、`GridState`（保存ビュー）にも入らない。グループ化したときはグループ見出しの行にチェックボックスは出ない（行にだけ出る）。
- **全選択が対象にする行**はヘッダーのチェックボックスの名前とツールチップに出る。client モードは一覧の全行（絞り込み後。畳んだグループの中の行も含む）、server モードは**読み込み済みの行だけ**（「読み込み済みの 40 件をすべて選択（全 1200 件のうち）」）。読み込んでいない行まで含めて選ぶには、下の「該当する全件を選択」を使う。
- **該当する全件を選択（server モードだけ）**。読み込み済みの行がすべて選ばれていて、`totalRows` がその数より多いとき、バーに「該当する全 1200 件を選択」のボタンが出る。押すと全件モードに入り、バーは「該当する全 1200 件を選択中」になる。全件モードの間は、読み込み済みの行も、あとから読み込まれた行も選択済みとして描く。client モードには無い（全選択がもとから絞り込んだ全件を対象にする）。
  - 全件モードかどうかは、`bulkActions` の `allMatching`（と件数 `matchingCount`。server モードでは `totalRows` の値）か、`bind:allMatchingSelected` で知る。`onSelectionChange(ids)` は全件モードに入ったときにも呼ばれ（`ids` は変わらない）、その時点で `allMatchingSelected` は更新済み。
  - **全件モードの `ids`（`selectedRowIds`）は、全件モードに入ったときの読み込み済みの行の id のまま**で、絞り込んだ全件ではない。全件モードの一括処理は、id ではなく**絞り込みの条件**で行う。グリッドの絞り込みは、利用側が渡している `GridState` の `filters`（行を読み込むときに server へ送っているものと同じ）で足りるので、snippet には渡していない。**検索語などグリッドの外で持っている条件があれば、それも条件に含めること**（含めないと、画面に出ている件数より多くの行を処理してしまう）。
  - 全件モードを抜けるのは次のときで、選択は空になる: 行のチェックボックスを外す（Space も同じ）、ヘッダーのチェックボックスを外す、グリッドの絞り込みが変わる、`clear()` / 選択解除のボタン、利用側が `allMatchingSelected = false` にする、`selectable` が外れる、client モードになる。**利用側が `selectedRowIds` を（入ったときと違う内容に）書き換えたときだけは、全件モードを抜けるだけで、利用側が書いた値（空の配列も）はそのまま残る**（読み上げは残った件数）。「全件から数件だけ外す」選び方は無い。並び替えとスクロールでは抜けない。
  - `allMatchingSelected` は読むためのもの。利用側が `true` を書いても全件モードには入らず、`false` に戻る（入るのはバーのボタンだけ）。
  - グリッドの外の検索語が変わったときは、通常の選択と同じく利用側で `clear()` を呼ぶ（グリッドは外の条件の変化を知らない）。

```svelte
<BantoGrid
	{rows}
	{columns}
	{state}
	mode="server"
	{totalRows}
	getRowId={(row) => row.id}
	selectable
	bind:selectedRowIds={selected}
>
	{#snippet bulkActions({ ids, clear, allMatching, matchingCount })}
		<button
			type="button"
			onclick={() =>
				(allMatching ? removeMatching({ filters: state.filters, search }) : removeMany(ids)).then(
					clear
				)}
		>
			{allMatching ? matchingCount : ids.length} 件を削除
		</button>
	{/snippet}
</BantoGrid>
```

- **見えなくなった行の選択は外す**。client モードでは、絞り込み・再読み込み・削除で一覧（絞り込み後の `rows`）から消えた行は選択からも外れる（一括操作が見えていない行に届かないようにするため。並び替え・列の非表示・グループの開閉では外れない）。server モードでは、グリッドの絞り込みが変わると選択をすべて外す（読み込んだ窓の外の行が条件に合うか分からないため）。スクロールで窓から出ただけの行と並び替えでは外れない。グリッドの外の検索語などで server の条件を変えるときと、一括操作で行を消したあとは、利用側で `clear()` を呼ぶか `selectedRowIds = []` にする。
- キーボード: アクティブなセルで Space を押すとその行の選択を切り替える。リンクやボタンを持つセル（`renderer: 'link'`・`cell` のリンク・`render` の操作）ではそのリンク・ボタンが優先、グループ見出しでは開閉。編集可能なセルでも Space は選択（編集の開始は Enter / F2 のまま）。**`selectable` のグリッドでは、読み取り専用でも Space は `onRowClick` を呼ばない**（行を開くのは Enter）。チェックボックス自体も Tab で届き、Space で切り替えられる。マウスでチェックボックスを押すと、フォーカスはグリッドに残り、その行がアクティブになる。
- 読み上げ: 行のチェックボックスの名前は「〈行の呼び名〉を選択」。件数は `role="status"` の領域が「3件を選択中」「選択なし」と読む。全件モードに入ると「該当する全1200件を選択中」、抜けると「選択なし」（利用側の書き換えで抜けたときは残った件数）と読む。行の選択状態はチェックボックスの checked で伝え、`aria-selected` は使わない（このグリッドの `aria-selected` はセルの範囲選択のもの）。
- バーは選択解除のボタンを持つ。解除でバーが消えるとき、フォーカスがバーの中にあればグリッドへ戻す（`clear()` も同じ。全件モードでも同じ）。「該当する全件を選択」のボタンは押すと消えるので、フォーカスはバー自体へ移す（次の Tab でバーの中の操作に届く）。バーはグリッドの下に出るので、出たときに行の位置は動かない（グリッドの高さがバーの分だけ縮む）。
- 文言: `selectRowLabel` / `selectAllRows` / `selectAllLoadedRows` / `selectionStatus` / `selectAllMatching` / `allMatchingStatus` / `selectionClear` / `bulkBarLabel`。

## 列の固定（左端、#713）

列に `pinned: 'left'` を付けると、その列は左端に固定され、ほかの列だけが横にスクロールする（既定は固定なし）。
判定（表示順・各列の `left`・並べ替えの制約・スクロール量）は `core/pinning.ts` の純関数で、描画だけが `BantoGrid.svelte` と `HeaderCell.svelte`（`position: sticky`）。

```ts
const columns: GridColumn<Item>[] = [
	{ id: 'code', header: 'コード', accessor: 'code', width: 120, pinned: 'left' },
	{ id: 'name', header: '品名', accessor: 'name', width: 240 }
	// …
];
```

- **表示順**: 固定した列は、固定していない列より常に左に出る（定義や `order` の位置に関係なく）。固定した列どうし・固定していない列どうしの順は `order` のまま。`selectable` のチェックボックスの列は、固定した列が 1 つでも表示されていれば一緒に固定され、固定した列はその右に続く。
- **状態**: `hidden` と同じく、`pinned` は初期値。以後は `GridState` が持つ（`pinned: string[]`、`isPinned(id)`・`setColumnPinned(id, pinned)`・`toggleColumnPinned(id)`・`pinnedCount`）。`serialize()` は `pinned` を書き出し、`hydrate()` は `pinned` の無い古い保存内容を受け付ける（そのときは列の定義の `pinned` のまま）。固定を解くと、列は `order` の元の位置に戻る。**固定を切り替える UI は同梱していない**（`ColumnsMenu` には無い）。利用側のメニューから `toggleColumnPinned` を呼ぶ。
- **境界の影**: 固定した最後の列の右端に、横スクロールが 0 より大きいときだけ影が出る（theme の `--banto-grid-pinned-shadow`。forced-colors では線）。スクロール中はコンテナに `scrolled-x` クラスが付く。
- **列の並べ替え（ドラッグ）**: 列は自分の区画（固定 / 固定でない）の中でだけ動く。境を越えて落とすと、区画の端に入る（`moveColumn` も同じ制約）。
- **非表示**: 固定した列も非表示にできる。固定した列がすべて非表示になると、チェックボックスの列の固定も解ける。再表示すると固定のまま戻る。
- **幅が足りないとき**: 固定した列（とチェックボックスの列）の幅の合計が、グリッドの幅から 120px（`MIN_SCROLLABLE_WIDTH`）を引いた分を超えると、収まらない後ろの固定列から順に固定をやめる（並びはそのまま。ほかの列がスクロールで見えなくなるのを防ぐ）。1 列も収まらなければ、チェックボックスの列も固定しない。
- **キーボード**: 矢印や Tab でアクティブなセルが動くとき、固定した列の下に隠れないようにスクロールする（固定した列の幅を引く）。固定した列のセルへ動いたときはスクロールしない。
- **グループ化**: グループ見出しの行は列をまたぐので固定しない。固定した列があるあいだは、見出しの中身（開閉の印・ラベル・集計）を左端に留める。
- **行の背景**: 固定したセルは不透明（下をくぐるセルを隠すため）で、ホバー・行選択・範囲選択の色はグリッドが重ねる。`rowClass` で行に付けた独自の背景は、固定したセルには出ない。
- 行の仮想化・server モード（未読み込みの行の仮の表示も固定する）・列のリサイズ（後ろの固定列の位置が追従する）・セル編集（編集中のセルとエラーの表示は固定した列でもそのまま）と併用できる。横方向の仮想化は無いので、固定した列は常に描画される。

## 日付のセルと注入（date-time-pickers PR-4）

`editor: 'date'` のセルの値は `YYYY-MM-DD`（実在の日）か、空なら **`null`**（`''` ではない。
[docs/design/date-time-pickers.md](../../docs/design/date-time-pickers.md) D6）。

- **解析**: `parseCellInput(raw, 'date')`（セルの確定・貼り付け・CSV 取り込みの共通の入口）は、寛容な形
  （`2026/11/7`・`2026.11.7`・`20261107`・全角）を `YYYY-MM-DD` に直し、空白だけなら `null`、それ以外（実在しない日・
  `11/07/2026` のような別の順・時刻付き）は失敗にする。年を省いた `11/7` は、セルで打って確定したときだけ今年として
  受け付け、貼り付けと CSV では失敗にする（どの年か決まらないため）。
- **検証**: `columnsFromSchema` の date の列は forms の `validateField` と同じ規則・文言で、形式 → `min` / `max`
  （正規の文字列、両端を含む）→ `isDateDisabled` を検査する。文言は `ColumnValidationMessages` の任意の
  `dateInvalid` / `dateMin` / `dateMax` / `dateDisabled`。範囲と無効日は列の `editorMin` / `editorMax` /
  `isDateDisabled` にも入り、注入したピッカーのカレンダーで選べなくなる。
- **ピッカーの注入**: grid は `@banto/ui` を import しない（docs/conventions.md §4）。アプリが部品を渡す。

  ```svelte
  <!-- +layout.svelte: 下のすべての BantoGrid に効く -->
  <script lang="ts">
  	import { provideCellEditors } from '@banto/grid-svelte';
  	import CellDateInput from '#lib/components/CellDateInput.svelte'; // DateInput + messages + locale

  	provideCellEditors({ date: CellDateInput });
  </script>
  ```

  グリッドごとに替えるときは `<BantoGrid cellEditors={{ date: OtherInput }} … />`（型ごとに context より優先）。
  渡される props は `CellDateEditorProps`（`@banto/ui` の `DateInput` の props の一部。`inputEl` は bindable で、grid が
  フォーカスを置く先）。注入が無ければネイティブの `<input type="date">` のまま。

- **セル編集の約束**（§5.8）: 編集の状態遷移は変わらない。カレンダーで日を選んでも下書きに入るだけで確定しない
  （確定は Enter・Tab・セルの外を押したとき）。Esc の 1 回目はカレンダーを閉じて入力欄へ戻り、2 回目で編集を
  取り消す。ボタンやカレンダーの日をマウスで押しても、選ぶ前に確定したり編集欄が消えたりしない。注入する部品は
  `DateInput` と同じく、ポップオーバーの中のキーと `pointerdown` を外へ出さず、自分で処理したキーは
  `preventDefault` してから `onkeydown` に渡し、`onblur` は部品全体からフォーカスが出たときだけ呼ぶこと。

## 時刻・日時のセル（date-time-pickers PR-5）

`editor: 'time'`（`HH:mm`）と `editor: 'datetime'`（`YYYY-MM-DDTHH:mm`、タイムゾーンなし）。空は `null`。

- **解析**: `parseCellInput(raw, 'time' | 'datetime')` は `930`・`9:30`・全角や、Excel の `2026/11/7 9:30` を正規の形に
  直す。秒付き・`24:00`・日付だけの datetime は失敗。年を省いた `11/7 9:30` はセルで打ったときだけ今年。
- **検証**: `columnsFromSchema` の列は forms と同じ規則・文言（`timeInvalid` / `timeMin` / `timeMax` / `timeStep` /
  `dateTimeInvalid` / `dateTimeMin` / `dateTimeMax`）。範囲・刻み・（datetime の）無効日は `editorMin` / `editorMax` /
  `editorStep` / `isDateDisabled` にも入る。datetime の列は既定の `format` で空白区切りに見せる（値とコピーは `T`）。
- **ピッカーの注入**: `provideCellEditors({ date, time, datetime })`。props は `CellTimeEditorProps` /
  `CellDateTimeEditorProps`。注入が無ければネイティブの `time` / `datetime-local`。§5.8 の約束は date と同じで、
  `DateTimeInput` では日を選ぶと時刻の一覧へ移り、時刻を選ぶと下書きに入って入力欄へ戻る（確定は次の Enter・Tab・外を押す）。

## 期間の絞り込み（date-time-pickers PR-6）

`filterType: 'date' | 'datetime'` の列は、絞り込みが演算子と値ではなく期間（開始日・終了日）になる。

- **値の形**: `FilterOp` の `'between'`。値は `[from | null, to | null]` で、意味は**半開区間 `from <= v && v < to`**
  （文字列の大小で比べる）。`null` の端はその側の条件を省き、両方 `null` は条件なし（`null` のセルも残る）。
  Rust の `FilterOp::Between`（`banto-storage` の `list_query.rs` が `>=` と `<` の 2 つの束縛に展開。PostgreSQL では
  `CAST(列 AS TEXT) COLLATE "C"` で比べ、DB の照合順序に左右されない）・admin-core の InMemory と同じ規則で、共通の
  ケースは `crates/banto-storage/testdata/filter-between-parity.json`。形の崩れた値はサーバーでは 400、クライアントでは
  一致なし、保存した状態の復元（`GridState.hydrate`）では捨てる。
- **画面と値の変換は 1 か所**: FilterPopover は両端とも含む日を見せ、適用すると終了日の**翌日**を `to` にして送る
  （`dateRangeToBetween`。月末・年末・うるう日を繰り上げ、`9999-12-31` は開いた端になる）。開き直すと
  `betweenToDateRange` で含む日に戻して見せる。日時の列でも同じ日の範囲になり、秒が付いた値も取りこぼさない。
  終了日が開始日より前・日付でない入力は、ポップオーバーにエラーを出して適用しない。両方空で適用すると絞り込みを外す。
- **部品の注入**: `provideCellEditors({ dateRange })`（`BantoGrid` の `cellEditors.dateRange` も可）。props は
  `FilterDateRangeInputProps`（`@banto/ui` の `DateRangeInput` がそのまま合う）。注入が無ければ 2 つのネイティブの
  `<input type="date">`。カレンダーを開いた状態の Esc はカレンダーだけを閉じ、次の Esc でポップオーバーが閉じる。
- **既定の変化**: `columnsFromSchema` は date・datetime の列を絞り込みできるようにする（以前は不可。読み取り専用の列も）。
  date・time・datetime の列は並べ替えと `lt`／`gt` などの比較も文字列の大小で行う（`comparator: compareTemporal`、
  手書きの列は `editor`／`filterType` が日付・時刻なら同じ）。
- **文言**: `GridMessages` に `filterRangeLabel`・`filterRangeStart`・`filterRangeEnd`・`filterRangeInvalid`・
  `filterRangeOrder`。
- 選択中のセルがあっても、FilterPopover の入力欄への貼り付けはその入力欄のもの（範囲の貼り付けにしない）。

## 依存

`ColumnsMenu` の checkbox はネイティブ描画を使い、`--banto-checkbox-size`（既定・fallback は `1.1rem`）で
forms と寸法・実線フォーカス・無効状態を揃える。ラベル行の最小高さは `--banto-control-height-sm`。
最後の表示列を隠せない制約やキーボード操作は維持する（ADR-0026）。

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §4](../../docs/ui-framework-spec.md)（データグリッド仕様）

## CSV export: spreadsheet formula safety (`formulaSafe`)

`toCsv(columns, rows, { formulaSafe: true })` is an opt-in mode for CSV files
that people open in Excel-style spreadsheets (use together with `csvForExcel`,
which only adds the UTF-8 BOM).

- Only values that are JavaScript **strings** are affected. If one starts with
  `=` `+` `-` `@`, TAB, CR, LF, or the full-width `＝` `＋` `－` `＠`, a leading
  `'` is added before RFC 4180 quoting. Numbers (including negative ones),
  booleans, null/undefined and header cells are never changed.
- The default (`formulaSafe` omitted/`false`) output is unchanged and re-imports
  losslessly. The safe output is **not** the raw value: `parseCsv` keeps the
  leading `'`, so strip it on import if you need the original text.
- This is a mitigation for Excel-style software, not a guarantee for every way
  of consuming CSV. Leading-space forms such as `" =1"` are not changed.
