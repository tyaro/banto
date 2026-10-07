# @banto/ui

Banto の汎用 UI 部品（Svelte 5）。管理画面のページ見出し・カード・状態表示など、
アプリのコードに依存しない小さな部品を共有する（Issue #220、
[ADR-0018](../../docs/adr/0018-shared-ui-package.md)）。文言・アイコン・状態・操作は
props / snippet / コールバックで受け取り、アプリのストア・`$app/*`・Tauri・他の `@banto/*`・
サードパーティのパッケージは import しない（`verify:architecture` の rule
`package-bare-imports` が `svelte`・`svelte/*`・相対パス以外を落とす）。

段階 1 の部品は次の 7 つ。今後の段階でメニュー・CommandPalette・ToastHost などを足す
（ADR-0018 §8）。

| 部品           | 役割                                                      | props / snippet                                   |
| -------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `PageHeader`   | ページの `<h1>` + 説明 + 操作（`view-transition-name`）   | `title` `description?` `actions?`(snippet)        |
| `SurfaceCard`  | 区画・カードの面（`<h2>` 見出し + 本文 + フッタ）         | `title?` `description?` `children` `footer?`      |
| `StatusBadge`  | 状態/ロールのバッジ（色だけに頼らず常にアイコンを出す）   | `variant` `label` `icon?`                         |
| `IconButton`   | アイコンだけのボタン（`label` が `aria-label`・`title`）  | `label` `icon` `size?`(`'sm'`/`'md'`) `onclick`   |
| `EmptyState`   | ページ単位の「データなし」                                | `icon?` `title` `description?` `action?`(snippet) |
| `ErrorState`   | ページ単位のエラー（`role="alert"`）                      | `icon?` `title` `description?` `action?`(snippet) |
| `LoadingState` | ページ単位の読み込み中（スケルトン + `aria-live` の文言） | `label?` `lines?`                                 |

`StatusBadgeVariant`（`'neutral' | 'success' | 'warning' | 'danger' | 'info'`）と
`UiIconComponent`（`icon` に渡せる部品の型）、`UiMessages` / `defaultUiMessages` も export する。

## 使用例

```svelte
<script lang="ts">
	import { PageHeader, StatusBadge, SurfaceCard, LoadingState, EmptyState } from '@banto/ui';
</script>

<PageHeader title="商品" description="登録済みの商品の一覧です。">
	{#snippet actions()}
		<button type="button">新規作成</button>
	{/snippet}
</PageHeader>

<SurfaceCard title="状態">
	<StatusBadge variant="success" label="稼働中" />
</SurfaceCard>

<LoadingState label="商品を読み込み中…" />
<EmptyState title="商品がありません" />
```

`LoadingState` の `label`（読み上げ文言）を省くとパッケージ既定の `defaultUiMessages.loading()`
（`'読み込み中…'`）になる。多言語化するアプリ（admin-template は Paraglide）は、
**既定に頼らず `label` を明示する**（英語表示で日本語が出ないように）。

## アイコン

`icon` には `size` と `aria-hidden` を受ける Svelte 部品なら何でも渡せる（型は
`UiIconComponent`）。`@lucide/svelte` の部品はそのまま渡せる。このパッケージは lucide に
依存しない。**既定のアイコン**（Inbox・OctagonAlert・Circle・CircleCheck・TriangleAlert・
CircleAlert・Info の 7 つ）は lucide の SVG を `src/icons/` に同梱したもので、アイコン集としては
公開しない。同梱アイコンは ISC（一部は Feather 由来の MIT）で、表記は各ファイルの先頭と
[src/icons/LICENSE](src/icons/LICENSE) にある。

## テーマ

スタイルは各部品のスコープ付き `<style>` に置き、`--banto-*` トークンだけを参照する。
消費側が `@banto/theme/css` を読み込むこと（無いとトークンが解決されず、色や寸法が
崩れる）。

```css
/* app.css 等 */
@import '@banto/theme/css';
```

## 依存

`dependencies`/`peerDependencies` は空。`svelte` も宣言しない（消費側の解決に任せる）。
`@banto/*` 間の import もゼロ（コアパッケージ、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 見本

admin-template の `/ui-demo`（デモモードのときだけナビに出る）に 7 部品の主要な状態を
並べてある。

## 関連ドキュメント

- [ADR-0018: 汎用 UI 部品は新パッケージ `@banto/ui` へ段階的に切り出す](../../docs/adr/0018-shared-ui-package.md)
- 本体リポジトリ: https://github.com/tyaro/banto
