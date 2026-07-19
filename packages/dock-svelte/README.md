# @banto/dock-svelte

Banto のフローティングウィンドウ/ドッキングレイアウト（spec §5）。
分割・タブ化・ドラッグでの再配置・スナップ、レイアウトの JSON
保存/復元を提供する。M7 でフローティングウィンドウ、M8 でドッキング
ツリー（分割/タブ）を追加した。

## 使用例

```svelte
<script lang="ts">
	import { DockHost, createDockState } from '@banto/dock-svelte';

	const dock = createDockState({
		version: 2,
		floating: [
			{ id: 'trend', title: 'トレンド', x: 40, y: 40, width: 360, height: 240, open: true }
		],
		docked: null
	});
</script>

<DockHost {dock}>
	{#snippet panel(content)}
		<p>{content.title} の中身</p>
	{/snippet}
</DockHost>
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
- 仕様: [docs/ui-framework-spec.md §5](../../docs/ui-framework-spec.md)（フローティングウィンドウ/ドッキングレイアウトシステム仕様）
