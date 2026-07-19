# @banto/charts

Banto のチャート。依存ライブラリなしの SVG フルスクラッチ実装
（spec §6, §6.1）。折れ線/エリア・棒・円/ドーナツ・散布図・
スパークラインに加え、複合（棒+折れ線）・レーダー・ヒートマップ・
ゲージ、SPC 系（ヒストグラム・パレート図・箱ひげ図）の全12種。

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
