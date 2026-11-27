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

## タッチ・ペンのタップで編集を始める（`editOnTap`、#964）

タッチ・ペンでは、編集できるセルを **1 回タップ**すると編集が始まる（[設計書 §3](../../docs/design/grid-touch-edit-design.md)）。
マウスは今までどおり（クリックは選択、ダブルクリックで編集）、キーボードも Enter / F2 のまま。

```svelte
<!-- 既定（editOnTap = true）。タップを選択だけに戻すなら false（編集はダブルタップ） -->
<BantoGrid {rows} {columns} {state} getRowId={(row) => row.id} editOnTap={false} />
```

- **タップ**は、`pointerType` が `touch` / `pen` の `pointerdown` に続いて、同じセルに届いた `click`。時間や移動量は測らない。
  スクロール（`pointercancel`）と長押し（`contextmenu`。`onRowContextMenu` があれば呼ぶ）は `click` にならないので、編集は始まらない。
  キーボードや支援技術が合成した `click` は、マウスと同じ扱い（選択だけ）。
- タッチ・ペンでは、**`pointerdown` では何も起きない**。フォーカス・アクティブセルの移動・編集中の別のセルの確定（blur）は
  `click` でまとめて起きる（`editOnTap={false}` でも同じ）。指を置いてスクロールしても、選択は動かず、編集中のセルも確定しない。
  タッチ・ペンのドラッグでは範囲選択は伸びない（ドラッグはスクロール）。
- 編集中のセル自身（エディタの中、セルの余白）のタップ・ダブルクリックでは、編集を作り直さない（下書きはそのまま）。
  保存待ち（`aria-busy`）のセルだけは、今までのダブルクリックと同じく新しい編集を始める。
- 編集できる列がある grid では、編集できないセルのタップは選択だけで、`onRowClick` は呼ばない（マウスのクリックと同じ。
  行を開く口はリンクの列）。編集できる列が無い grid のタップは、今までどおり `onRowClick`。
- チェックボックス・選択肢のセルは、タップで編集に入ってから、もう 1 度タップして切り替える。
- 画面のキーボード（`@banto/touch-keys-svelte`）と組み合わせて「タップ → 盤 → 盤の確定でセルも確定」にするのは、
  アプリのルートの配線（設計書 §4・§5。テンプレートの配線とレシピは後続の PR）。grid の側の口は下の節。

## セルのエディタの印と、エディタへ書く物（`data-grid-editor`、#964）

grid はほかのパッケージを知らないまま、アプリが「セルのエディタ」を見分けて繋げるための口を 2 つ持つ
（[設計書 §4.1・§5.1](../../docs/design/grid-touch-edit-design.md)）。

- **印の属性 `data-grid-editor`**（公開の約束）: 編集中のセルのエディタに付く。組み込みの `<input>`・`<select>`・checkbox は
  その要素自身、注入したエディタ（`cellEditors`）は grid が置く包み。どちらも `field.closest('[data-grid-editor]')` で見分けられる。
- **フォーカスを動かさずに書いて、blur で確定する**: フォーカス中のエディタの値を書き換えて `input` を出し、その後に
  `field.blur()` を呼ぶと、セルは今までの blur の経路で確定する（次のセルへは移らない）。確定して閉じたら、フォーカスは
  grid へ戻り、アクティブセルは編集したセルのまま（矢印キーや F2 で続けられる）。検証の失敗・保存の拒否では、下書きとエラーを
  残して、フォーカスがエディタへ戻る。

```ts
// 例: 画面のキーボード（@banto/touch-keys-svelte の TouchKeysHost）の確定の後に、
// セルのエディタだけ blur する（アプリのルートの 1 か所。grid はこの import を持たない）
import type { TouchKeysConfirmDetail } from '@banto/touch-keys-svelte';

function onconfirm({ input }: TouchKeysConfirmDetail) {
	if (input.closest('[data-grid-editor]')) input.blur();
}
```

フォーカスの規則（#212 の「手放したフォーカスは取り戻さない」は変わらない）:

- エディタの外の押下は、フォーカスが入力欄に残っていても、持ち主を手放す（今までどおり）。
- 編集中のエディタ自身に `input` が届き、**その時点でフォーカスが実際にそのエディタにあり、保存待ちでない**ときだけ、
  持ち主を取り直す。`input` を出さない押下（盤の取り消し・ただの外の押下）、フォーカスが離れた後の `input`、
  保存待ちの間の `input` では取り直さない。
- grid へ戻すのは、持ち主のまま閉じて、その時点でフォーカスがどこにも無い（`body`）ときだけ。別の場所へ移った blur、
  保存待ちの間に別の場所を操作した場合は、そちらが勝つ。
- 物理キーボードの Esc は今のまま（1 回で編集を取り消し、フォーカスは grid へ）。

## 今のセルを支援技術へ伝える（`aria-activedescendant`、#1016）

フォーカスは grid の外枠（`role="grid"`、`tabindex="0"`）に置いたままで、今のセルは `selection.active` で持つ
（行の仮想化でセルの DOM が出入りするため、セルごとの `tabindex` は持たない）。支援技術へは、外枠の
`aria-activedescendant` が今のセルの `id` を指して伝える。

- データのセル（`role="gridcell"`）は `id` を持つ。`<grid ごとの接頭辞>-cell-<行の鍵>-<列 id>` で、行の鍵（`getRowId`）と
  列 id は `[A-Za-z0-9]` 以外の文字を `_<16 進の符号>_` に置き換える（空白や記号が入っても 1 つの id として使え、
  別のセルと重ならない）。表示上の行番号からは作らないので、並べ替え・絞り込み・スクロールでセルの id は変わらない。
  **この `id` の形は公開の約束ではない**（セルを探すには今までどおり `data-cell-row`・`data-cell-field` を使う）。
- グループ見出しの行に今のセルがあるときは、その行（`role="row"`）の `id` を指す。
- 今のセルの行が仮想化の描画範囲の外にあっても、その 1 行だけは DOM に描いておき、`aria-activedescendant` は
  付いたままにする（グループ見出しの行も同じ）。属性が外れると、NVDA はその瞬間（grid にフォーカスがあるままホイールで
  スクロールしたとき）や、Tab で grid へ戻ったときに表全体を読み、ブラウズモードになるため。その行は流れから外して
  本来の位置（行の高さ × 表示の行番号）に置く（クラス `outside-window`、`position: absolute`）ので、描画範囲の行の並び・
  スクロールの高さ・`aria-rowindex` は変わらず、画面には見えない。DOM の順も行番号の順のまま（範囲より上なら先頭、
  下なら末尾）。カーソル・範囲の選択・行の選択・スクロールの位置は変えず、次の矢印キーでそのセルから動いて画面に入る。
  範囲の外にある間、その行の中のフォーカスできる要素は、標準のチェックボックス・リンクも、`render`・`cell` で消費側が描いた
  部品（ボタン・入力欄・`tabindex` を持つ要素など）も、すべて Tab の止まり場から外す（Tab で見えない行へ飛ばない）。
  **消費側への注意**: その間だけ、それらの要素に `tabindex="-32768"`（負の値の番兵。Tab には止まらず、プログラムからのフォーカスはできる。元から `-1` の要素も同じ）と `data-banto-grid-tabindex`（元の値の控え）が付き、
  行が範囲に戻ると元の `tabindex`（無ければ属性なし）に戻る。フォーカスは動かさない。`inert`・`aria-hidden` は使わない
  （指す先のセルが支援技術から見えなくなるため）。
  **DOM の行を数える消費側への注意**: 今のセルの行が範囲の外にある間、`.row` は 1 つ多い（`.row:not(.outside-window)` で除ける）。
- 今のセルが DOM に無いとき（サーバモードで未取得の行・今のセルが無い・列が無くなった）は、
  `aria-activedescendant` を付けない（存在しない id を指さない）。未取得の行は範囲の外に描かない。
- 見出しの行と選択のチェックボックスの列には今のセルは来ない（どちらも実際のフォーカスを受ける部品）。
- 今のセルが無いまま外枠そのものがフォーカスを受けたとき（Tab で入った・コードが外枠へ戻した）は、その時に見えている
  最初の行（グループ見出しの行ならその行）の最初の列へカーソルだけを置く。範囲の選択（`aria-selected`）・行の選択・
  スクロールの位置は変えない。0 件のとき、見えている行がまだ取得できていないとき、見出しのボタンや行のチェックボックス
  など子の要素がフォーカスを受けたときは置かない。入った時点で `aria-activedescendant` が無いと、NVDA はブラウズモードの
  まま表を全部読み上げ、矢印キーが grid に届かない。カーソルが先に置かれるので、Tab で入った後の最初の矢印はそこから動く。

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

## セルに小さな折れ線（sparkline）を描く例（#713）

sparkline は組み込みの `renderer` にしていない（`@banto/grid-svelte` は `@banto/charts` に依存しない）。
列の `render`（snippet）で、アプリの側から `@banto/charts` の `Sparkline` を描く。

```svelte
<script lang="ts">
	import { Sparkline } from '@banto/charts';
	import { BantoGrid, GridState, type GridColumn } from '@banto/grid-svelte';

	interface Line {
		id: number;
		name: string;
		/** 直近 7 日の出荷数（古い順）。 */
		shipped: number[];
	}

	let { rows }: { rows: Line[] } = $props();

	const columns: GridColumn<Line>[] = [
		{ id: 'name', header: '品名', accessor: 'name', width: 200 },
		{
			id: 'shipped',
			header: '出荷（7日）',
			// 並べ替え・コピー・CSV が使う値は、最新の 1 日分。snippet は描き方だけを変える。
			accessor: (row) => row.shipped.at(-1) ?? null,
			width: 160,
			render: trendCell
		}
	];
	const gridState = new GridState<Line>(columns);
</script>

{#snippet trendCell(row: Line)}
	<span class="trend">
		<Sparkline values={row.shipped} width={96} height={20} />
		<span>{row.shipped.at(-1) ?? '—'}</span>
	</span>
{/snippet}

<BantoGrid {rows} {columns} state={gridState} getRowId={(row) => row.id} />

<style>
	.trend {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
	}
</style>
```

- `Sparkline` は飾りの図（`aria-hidden`）なので、意味は文字でも出す（上の例は最新の値を横に置く）。
- 高さは行の高さ（`--banto-grid-row-height`。密度で 32〜52px）に収まる値にする。色は `--banto-chart-1`。
- `render` の列は編集できない。`tone` も効かない（上の「組み込みのセル表現」の節）。
- `@banto/charts` を入れないアプリは、snippet の中に `<svg>` を直接書けば同じことができる。

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

- props: `selectable`、`selectedRowIds`（bindable。`getRowId` の値を選んだ順に持つ配列）、`allMatchingSelected`（bindable。server モードの「絞り込んだ全件」。下の項目）、`onSelectionChange(ids)`、`getRowLabel(row)`（チェックボックスの名前に使う行の呼び名。既定は `render` でない先頭の表示列の文字、無ければ行の id）、`label`（grid の外枠の名前。既定は `messages.gridLabel`。帯を閉じたあとフォーカスが外枠に戻るので、名前が無いと読み上げが中身を全部読む）、`bulkActions`（バーに差し込む snippet。`{ ids, clear, allMatching, matchingCount }` を受け取る）。グリッドは一括の処理を持たず、選んだ id を渡すだけ。
- チェックボックスの列は `GridColumn` ではない。列メニュー・列の並べ替え（ドラッグ）・幅の変更・並び替え・絞り込み・セルの範囲選択・コピー / 貼り付け・CSV の対象にならず、`GridState`（保存ビュー）にも入らない。グループ化したときはグループ見出しの行にチェックボックスは出ない（行にだけ出る）。
- **全選択が対象にする行**はヘッダーのチェックボックスの名前とツールチップに出る。client モードは一覧の全行（絞り込み後。畳んだグループの中の行も含む）、server モードは**読み込み済みの行だけ**（「読み込み済みの 40 件をすべて選択（全 1200 件のうち）」）。読み込んでいない行まで含めて選ぶには、下の「該当する全件を選択」を使う。
- **該当する全件を選択（server モードだけ。`selectAllMatching` で明示したグリッドだけ）**。`selectAllMatching` は既定 false で、false のあいだはボタンが出ず、`allMatchingSelected` も常に false（選択は今までどおり `ids` だけ）。一括処理が `ids` しか見ない画面に出すと、バーは「全 100 件」と言うのに処理は読み込み済みの分だけになるので、**全件モードを条件で処理できる画面だけ** `selectAllMatching` を付ける。付けたら、全件モードの処理は利用側が条件で行う責任を持つ（下の 2 項）。読み込み済みの行がすべて選ばれていて、`totalRows` がその数より多いとき、バーに「該当する全 1200 件を選択」のボタンが出る。押すと全件モードに入り、バーは「該当する全 1200 件を選択中」になる。全件モードの間は、読み込み済みの行も、あとから読み込まれた行も選択済みとして描く。client モードには無い（全選択がもとから絞り込んだ全件を対象にする）。
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

## 行の右クリックメニュー（`onRowContextMenu`、#784）

```svelte
<BantoGrid {rows} {columns} {getRowId} onRowContextMenu={(row, { x, y }) => openMenu(row, x, y)} />
```

- 渡したときだけ働く。**渡さなければブラウザの既定のメニューのまま**（`preventDefault` しない）。
- 呼ばれるとき: データ行のセルの右クリック、または、グリッドにフォーカスがありアクティブなセルがデータ行にあるときの `ContextMenu` キー・Shift+F10（F10 単独は呼ばない）。位置は、マウスならポインタ、キーボードならアクティブなセルの左端・下端。
- 呼ばれないとき: グループ見出し・読み込み中の行・空のグリッド、セルの編集中。編集中のエディタ（input などのほか、注入したエディタのカレンダーのボタン・ポップオーバーも）の右クリックは、ブラウザの既定のメニューのまま。
- ポインター操作なしで届く: アクティブなセルがまだ無いグリッド（Tab で入った直後）では、矢印キー・Home・End・PageUp・PageDown・`ContextMenu`・Shift+F10 の最初の 1 回が、見えている最初のデータ行の先頭列をアクティブにする（その 1 回は移動しない）。`ContextMenu`・Shift+F10 は、そのうえでその行のコールバックを呼ぶ。見えている範囲にデータ行が無い（server モードで読み込み中など）ときは、矢印キーなどは表示順で最初のデータ行に入ってそこへスクロールし、`ContextMenu`・Shift+F10 は何もしない（画面に無い行でメニューを開かない）。この「最初のセルに入る」挙動は、`onRowContextMenu` を渡さないグリッドの矢印キーなどにも効く。
- フォーカス（アクティブなセル）は、コールバックの**前**にクリックしたセルへ移る（メニューへフォーカスを移しても引き戻されない）。範囲選択の内側を右クリックしたときは範囲を保ったままアクティブなセルだけが動き、外側ならクリックしたセルだけの選択に戻る。**行の選択（`selectedRowIds`）は変えない。**
- 行はそのまま渡す。その行だけを対象にするか、選択中の全行を対象にするか（`selectedRowIds`）は呼び出し側が決める。

## `columns` を後から変える（#890）

`columns` に**新しい配列**を渡せば、`BantoGrid` を作り直さずに列の定義が差し替わる（編集モードで `editable` を切り替える、データによって列が増減する、など）。`{#key}` で作り直す必要はない。利用者の列幅・並び順・並べ替え・絞り込み・固定・非表示・グループ化・セルの選択・スクロールは保つ。

- 列は `id` で突き合わせる。両方にある列は、定義（`editable`・`header`・`renderer` など）だけが新しくなる。定義の `width`・`hidden`・`pinned` は今までどおり初期値なので、既にある列で変えても効かない。
- 増えた列は、定義の `width`・`hidden`・`pinned` から始まり、`columns` の中で直前にある列のすぐ後ろに入る（先頭の定義なら先頭）。
- 消えた列は、並び順・非表示・固定・並べ替え・絞り込みから外れ、その列でのグループ化は解ける。幅だけは覚えていて、同じ `id` が戻れば幅が戻る（ほかは初期値から）。全列が非表示になるときは、表示順で先頭の列を出す。
  - 列でない項目（アプリがサーバーへ送る自前の条件など）の並べ替え・絞り込みは残す。
  - 並べ替え・絞り込みが変わったら、server モードでは `onParamsChange` を 1 回呼ぶ（ヘッダーで変えたときと同じ）。定義だけの差し替えでは呼ばない。外から `state.setColumns` を呼んで条件が落ちたときも呼ぶ。同じ更新の中で何度呼んでも、最後の条件で 1 回だけ。
  - 行の並びが変わったら、セルの選択は行の id で追う（アクティブなセルは同じ行へ移り、範囲はそのセル 1 つに縮む）。並びが変わらなければ選択はそのまま。追えない（外から `state.setColumns` を呼んだ、行が出ていない）ときは選択を外す。server モードでは、並べ替え・絞り込みが変わったら選択を外す。
- 列が消えなくても、並べ替え・絞り込み・グループ化をかけている列の定義を同じ `id` のまま差し替えたら（`accessor` が別のデータを読むなど）、行の並びが変わりうるので、セルの選択は上と同じく行の id で追う（外から `state.setColumns` を呼んだときは外す）。条件はそのままなので `onParamsChange` は呼ばない。
- `state.conditionsRevision`（`{ revision, paramsRevision }`）は、どちらも増えるだけの数: `revision` は条件が落ちたか条件をかけた列の定義が変わったとき、`paramsRevision` は並べ替え・絞り込みが落ちたときに進む。自分で `state.setColumns` を呼んで行を取ってくるアプリは、前に見た値と比べればよい。
  - 保存した状態を、その列の無い `columns` で `hydrate` したときも同じ: 保存時の `order` にあって今の列に無い列の並べ替え・絞り込み・グループ化は捨てる（幅は残るので、列が戻れば幅も戻る）。
- 開いている編集は、その列が編集不可になったとき（`editable` の関数がその行を断るときも）・消えたとき・非表示になったときに取り消す（下書きは捨て、保存しない）。編集できるままなら下書きを保って開いたまま。
- 外から `state`（`GridState`）を渡しているときも、`columns` の変化はその `state` に渡る（`state.setColumns(columns)` を直接呼んでもよい）。初めに渡した `columns` は `state` に押し込まない（今までどおり `state` を作ったときの列が使われる）。`state.columns` は今の定義（定義の順、非表示も含む）。
- 同じ配列を書き換えても（`push` など）反映しない。新しい配列を渡す。

## 行が 0 件のときの表示（`empty`、#712）

行が 1 件も無いとき、グリッドは `messages.emptyState` の文字を出す。次の一手のボタンなど、ページ側の表示に置き換えたいときは `empty`（snippet）を渡す。絞り込みで 0 件になったときも同じ場所に出るので、「本当に空」か「絞り込みの結果」かはページ側で見分ける（グリッドは理由を判断しない）。

```svelte
<BantoGrid {rows} {columns} {state}>
	{#snippet empty()}<MyEmptyState />{/snippet}
</BantoGrid>
```

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
- **状態**: `hidden` と同じく、`pinned` は初期値。以後は `GridState` が持つ（`pinned: string[]`、`isPinned(id)`・`setColumnPinned(id, pinned)`・`toggleColumnPinned(id)`・`pinnedCount`）。`serialize()` は `pinned` を書き出し、`hydrate()` は `pinned` の無い古い保存内容を受け付ける（そのときは列の定義の `pinned` のまま）。固定を解くと、列は `order` の元の位置に戻る。固定を切り替える UI は `ColumnsMenu` にある（下の「切り替える UI」）。自前のメニューからは `toggleColumnPinned` を呼ぶ。
- **切り替える UI**: `ColumnsMenu` の各行の右に、ピンのボタンがある（`toggleColumnPinned` を呼ぶ）。状態は `aria-pressed` で伝え、名前は固定中も同じ `messages.pinColumn(header)`（既定「〇〇を左端に固定」）。ツールチップは、固定中だけ `messages.unpinColumn(header)`（既定「〇〇の固定を解除」）。メニューの並びは `allColumns` のとおり固定した列が先頭なので、切り替えると行が動く（フォーカスは押したボタンに残す）。非表示の列も固定できる（再表示したときに固定の区画へ入る）。
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
