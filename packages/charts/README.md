# @banto/charts

Banto のチャート。依存ライブラリなしの SVG フルスクラッチ実装
（spec §6, §6.1）。折れ線/エリア・棒・円/ドーナツ・散布図・
スパークラインに加え、複合（棒+折れ線）・レーダー・ヒートマップ・
ゲージ、SPC 系（ヒストグラム・パレート図・箱ひげ図）、積立エリア・
ガントの全14種。

## 使用例

```svelte
<script lang="ts">
	import { LineChart } from '@banto/charts';

	interface Point {
		month: string;
		value: number;
	}

	const data: Point[] = [
		{ month: '1月', value: 10 },
		{ month: '2月', value: 14 }
	];
</script>

<LineChart
	{data}
	x={(d: Point) => d.month}
	series={[{ id: 'value', label: '売上', y: (d: Point) => d.value }]}
	label="月別売上"
/>
```

### 積立グラフ（積立エリア / 積立棒）

```svelte
<script lang="ts">
	import { StackedAreaChart, BarChart } from '@banto/charts';

	const data = [
		{ q: 'Q1', a: 10, b: 6 },
		{ q: 'Q2', a: 14, b: 9 }
	];
</script>

<!-- 積立折れ線（積立エリア）: series の値アクセサは `y` -->
<StackedAreaChart
	{data}
	x={(d) => d.q}
	series={[
		{ id: 'a', label: '製品A', y: (d) => d.a },
		{ id: 'b', label: '製品B', y: (d) => d.b }
	]}
	label="四半期売上（積立）"
/>

<!-- 積立棒は BarChart の stacked オプション: series の値アクセサは `value` -->
<BarChart
	{data}
	category={(d) => d.q}
	series={[
		{ id: 'a', label: '製品A', value: (d) => d.a },
		{ id: 'b', label: '製品B', value: (d) => d.b }
	]}
	stacked
	label="四半期売上（積立棒）"
/>
```

### ガントチャート

```svelte
<script lang="ts">
	import { GanttChart, type GanttTask } from '@banto/charts';

	const tasks: GanttTask[] = [
		{ id: 'design', label: '設計', start: '2026-01-05', end: '2026-01-15', progress: 1 },
		{ id: 'build', label: '実装', start: '2026-01-12', end: '2026-02-02', progress: 0.6 },
		{ id: 'test', label: '検証', start: '2026-01-28', end: '2026-02-10' }
	];
</script>

<GanttChart {tasks} label="プロジェクト工程" today="2026-01-25" />
```

`start`/`end` は `number`(epoch ms) / `Date` / 文字列のいずれでも可。行の高さは
`rowHeight`、全体の高さはタスク数から自動算出する。時間軸・ツールチップの表示は
`formatDate` で制御する（依存を足さないため日付ライブラリは同梱しない）。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §6](../../docs/ui-framework-spec.md)（チャート/グラフ仕様）
