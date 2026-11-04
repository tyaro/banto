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
保存結果の反映・検証・コールバックは既存のまま。

checkbox editor は `--banto-checkbox-size`（fallback `1.1rem`）で native の形を保ち、
セル全幅・全高へは伸ばさない。フォーカスは既存の編集セル枠で示す。
行高・列幅・仮想化・native の checked / Space / 即時確定は維持する。

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
