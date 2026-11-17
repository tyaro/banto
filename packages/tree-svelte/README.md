# @banto/tree-svelte

Banto の階層データツリービュー。依存ゼロのヘッドレスコア + 薄い Svelte 5 (Runes)
UI で、展開/折りたたみ・単一/複数選択・三状態チェックボックス・遅延読み込み・
ドラッグ並べ替え/親子変更・インライン名前変更に対応する。`columns` を渡すと
階層データグリッド（tree-grid）、`TreeSelect` はポップオーバー型の選択入力になる
（[docs/roadmap.md](../../docs/roadmap.md) M-review 2026-08 の利用者要望）。

## 使用例

```svelte
<script lang="ts">
	import { BantoTree, type TreeNode } from '@banto/tree-svelte';

	const nodes: TreeNode[] = [
		{ id: 'src', label: 'src', children: [{ id: 'app', label: 'app.ts' }] },
		{ id: 'readme', label: 'README.md' }
	];
</script>

<BantoTree {nodes} expanded={['src']} onSelectionChange={(ids) => console.log('selected', ids)} />
```

### ラベルのバッジ・右クリック・ルートの自動展開（任意の追加 prop）

```svelte
{#snippet badge(node, ctx)}
	{node.label} <span class="count">{node.children?.length ?? 0}</span>
{/snippet}

<BantoTree
	{nodes}
	label={badge}
	autoExpandNewRoots
	onContextMenu={(node, { x, y }) => openMenu(node, x, y)}
/>
```

`label` は見た目だけを差し替える（アクセシブル名は `node.label` のまま、編集中は入力欄、
`columns` 時は先頭列）。`onContextMenu` はマウス右クリック・ContextMenu キー・Shift+F10 で
呼ばれ、指定時だけ既定メニューを抑止する（選択は動かさない）。

`selection`（`NodeId[]`）を渡すとホスト主導の選択になる: クリック・キーは `onSelectionChange` で通知される
だけで、強調は常に `selection` に従う（ページが URL に選択を持つ、確認で拒否したら元に戻す、など）。
省略時は従来どおり（`selected` は初期値）。

複数選択 + 三状態チェックボックス・遅延読み込み・tree-grid・`TreeSelect`・
ドラッグ/リネームの各形態は
[docs/recipes/tree-svelte.md](../../docs/recipes/tree-svelte.md) を参照。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（`@banto/grid-svelte`/`forms` の型は構造ミラーで非 import、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。派生アプリで
`pnpm dev` する場合は消費側 Vite の `optimizeDeps.exclude` が必要
（`.svelte.ts` をソース配布するため。[ADR-0007](../../docs/adr/0007-derived-app-dev-optimizer-exclude.md)。
テンプレートは設定済み）。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- アプリへの組み込みレシピ: [docs/recipes/tree-svelte.md](../../docs/recipes/tree-svelte.md)
- ツリー演算のコア（依存ゼロ純関数）: `src/core/`、テスト: `tests/`
