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

`selectionFollowsFocus={false}`（単一選択のみ。既定 `true`）にすると、上下・Home・End などの移動キーは
フォーカスだけを動かし `onSelectionChange` を呼ばない。Space・Enter・クリックで選ぶ（WAI-ARIA の
「選択がフォーカスに付いてこない」形。狭い画面のドロワーを選択で閉じる、選択のたびに重い読み込みが走る、
といった画面向け）。Enter は選んだうえで従来の動作（枝の開閉・葉の `onActivate`）も行う。

`emptyChildren` スニペット（`(node, { depth })`）を渡すと、`children` が空配列の枝を開いたときに案内行
（「項目がありません」など）を出す。渡したときだけ、その枝に開閉の三角が付く。案内行は上下キーの
フォーカスが止まらず、選択・チェックの対象にならず、`aria-disabled` の `treeitem` として読み上げられる。
遅延読み込みの枝は、読み込みが終わって 0 件だったときだけ「空」とみなす（未読み込み・読み込み中・失敗は別）。

### 行末のボタン・展開を外から決める・ドロップの可否（#821）

```svelte
{#snippet actions(node, ctx)}
	<button type="button" aria-label={`${node.label} を隠す`} onclick={() => hide(node.id)}>…</button>
{/snippet}

<BantoTree
	nodes={query ? matchedNodes : nodes}
	rowActions={actions}
	expansion={query ? ancestorIdsOfMatches : undefined}
	onExpandedChange={(ids) => (openWhileSearching = ids)}
	draggable
	canDrop={({ dragged, target, position, parent }) =>
		parent?.id === 'locked' ? { allowed: false, reason: 'ロック中のフォルダー' } : true}
	onDropTargetChange={(hover) => (hint = hover && !hover.allowed ? hover.reason : '')}
/>
```

- `rowActions`（`(node, ctx)`、`ctx` は `label` と同じ）: 木の列の末尾にボタンなどを置く。中のクリック・
  ダブルクリック・ドラッグは行の選択・名前変更・ドラッグにならない。キーボードは、木のタブ位置を持つ行の
  ボタンだけが Tab で届き（行 → その行のボタン → 木の外）、ほかの行のボタンは `tabindex="-1"` にされ、タブ位置が戻ると利用側が書いた tabindex（自前のロービングも）がそのまま戻る
  （行ごとにタブ位置は増えない）。ボタンの中では木のキー（矢印・Enter・Space・F2 …）は効かず、Escape で
  行に戻る。各ボタンには `node.label` を含むアクセシブル名を付けること。行のアクセシブル名は `node.label`。
- `expansion`（`NodeId[]`）: 渡している間はちょうどその id が開く。開閉の操作は `onExpandedChange` で
  求める一覧が通知されるだけ。`undefined` に戻すと木が自分で持っていた展開に戻る（「検索の間だけ一致の
  先祖を開き、やめたら元に戻す」）。`onExpandedChange` は省略時（木が持つ展開）でも呼ばれる。
- `canDrop`（`TreeDropRequest` → `boolean | { allowed, reason? }`）: 木の形の検査（自分自身・自分の子孫へは
  落とせない）を通った候補ごとに、ドラッグ中に 1 回だけ聞かれる。拒むとその行に `data-drop-denied` が付き、
  離しても何も起きない。`onDropTargetChange` で候補と可否・理由を受け取り、画面に出せる。

#### 外から当ててよい属性（公開の約束）

各行（`role="treeitem"`）には `data-depth`（0 始まり。`aria-level` - 1 と同じ）が付く。階層ごとに
見た目を変えるときは、行クラスの上書きではなくこの属性を CSS で当てる:

```css
[role='tree'] [data-depth='0'] {
	background: var(--banto-surface-subtle);
}
```

`emptyChildren` の案内行にも `data-depth`（その枝の深さ + 1）と `data-empty-children`（枝の id）が付く。
内部のクラス名（`.tree-row` など）は公開の約束ではない。

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
