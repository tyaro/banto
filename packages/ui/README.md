# @banto/ui

Banto の汎用 UI 部品（Svelte 5）。管理画面のページ見出し・カード・状態表示など、
アプリのコードに依存しない小さな部品を共有する（Issue #220、
[ADR-0018](../../docs/adr/0018-shared-ui-package.md)）。文言・アイコン・状態・操作は
props / snippet / コールバックで受け取り、アプリのストア・`$app/*`・Tauri・他の `@banto/*`・
サードパーティのパッケージは import しない（`verify:architecture` の rule
`package-bare-imports` が `svelte`・`svelte/*`・相対パス以外を落とす）。

段階 1 の部品は次の 7 つ。段階 2a でメニュー部品（4 つ、下の表の後）、段階 2b で
`CommandPalette`（その後）を足した。今後の段階で ToastHost を足す（ADR-0018 §8）。

| 部品           | 役割                                                      | props / snippet                                   |
| -------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `PageHeader`   | ページの `<h1>` + 説明 + 操作（`view-transition-name`）   | `title` `description?` `actions?`(snippet)        |
| `SurfaceCard`  | 区画・カードの面（`<h2>` 見出し + 本文 + フッタ）         | `title?` `description?` `children` `footer?`      |
| `StatusBadge`  | 状態/ロールのバッジ（色だけに頼らず常にアイコンを出す）   | `variant` `label` `icon?`                         |
| `IconButton`   | アイコンだけのボタン（`label` が `aria-label`・`title`）  | `label` `icon` `size?`(`'sm'`/`'md'`) `onclick`   |
| `EmptyState`   | ページ単位の「データなし」                                | `icon?` `title` `description?` `action?`(snippet) |
| `ErrorState`   | ページ単位のエラー（`role="alert"`）                      | `icon?` `title` `description?` `action?`(snippet) |
| `LoadingState` | ページ単位の読み込み中（スケルトン + `aria-live` の文言） | `label?` `lines?`                                 |

メニュー部品（段階 2a。`popover` API を前提にする）:

| 部品            | 役割                                                                                       | props / snippet                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `Menu`          | トリガーから開く 1 階層のドロップダウン（`popover="auto"` + `role="menu"`、↑↓・Home・End） | `label` `placement?`(`'bottom-start'`/`'bottom-end'`) `trigger`(snippet) `children` |
| `MenuGroup`     | 見出し付きの項目グループ（`role="group"`）                                                 | `label` `children`                                                                  |
| `MenuItem`      | メニュー項目（`role="menuitem"`、ローヴィングフォーカス。`disabled` は `aria-disabled`）   | `label` `icon?` `danger?` `disabled?` `onSelect`                                    |
| `MenuSeparator` | 区切り線                                                                                   | なし                                                                                |

`trigger` snippet は `aria-haspopup`・`aria-expanded`・`onclick`・`onkeydown` を props で受け取る
ので、ボタンに `{...props}` で展開する。項目を選ぶとメニューは閉じ、フォーカスはトリガーへ戻る。

コマンドパレット（段階 2b）:

| 部品             | 役割                                                                              | props                                                                                               |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `CommandPalette` | 検索欄 + グループ見出し付きの一覧のモーダル（`role="dialog"` + combobox/listbox） | `open`(bindable) `items` `search?` `recentIds?` `onExecute` `onClose?` `focusFallback?` `messages?` |

パッケージが持つのは**表示と操作だけ**。どのコマンドがあるか・実行のしかた・`Ctrl+K` の配線・
セッションごとの扱い・最近使った項目の記録・失敗の通知はアプリが持ち、props とコールバックで渡す。

- **項目**（`CommandPaletteItem`）: `id`・`title`・`group?`（見出し）・`keywords?`（検索だけに使う語）・
  `icon?`・`disabled?`（表示するが選べない。↑↓ で飛ばす）・`shortcut?`（右端の表示だけ）。
  `@banto/admin-core` の `PaletteCommand` と構造的に合うので、その配列をそのまま渡せる
  （`onExecute` には渡した同じオブジェクトが返る）。表示してよい項目だけを渡す（権限の判定はアプリ）。
- **検索**: 既定は `defaultCommandPaletteSearch`（`title`・`keywords` の大文字小文字を区別しない
  部分一致、並びは渡した順）。`search(query, items)` で差し替えられる（admin-template は admin-core の
  `searchCommands` で点数順・最近使ったものを優先）。結果はグループごとに、最初に出た順でまとめる。
- **最近使ったもの**: `recentIds` を渡すと、検索が空のときにその順で先頭へ「最近使ったもの」の
  見出しで出す（同じ項目は元のグループに重ねて出さない）。記録はアプリのストアで持つ。
- **実行**: Enter かクリックで `onExecute(item)`。Promise を返せば終わるまで行を無効にし、その後に
  閉じる。失敗の扱い（通知など）は `onExecute` の中で行う（reject はパッケージで捕まえない）。
  実行の完了前に Esc で閉じて開き直した場合、古い実行の完了は新しいパレットを閉じない。
- **閉じる**: Esc・パレットの外の pointerdown・実行の後に `open` を `false` にし、`onClose(reason)`
  （`'escape' | 'outside' | 'execute'`）を呼ぶ。開くたびに中身を作り直す（検索語・選択は残らない）。
- **キーボード**: ↑↓ で選択（端で折り返す。`disabled` は飛ばす。選べる項目が無いときは何も選ばず Enter も何もしない）、Enter で実行。マウスを乗せた行が
  選択になる（キーボードの選択と同じ見た目、`--banto-surface-hover`）。Home/End は検索欄の
  カーソル移動のまま（奪わない）。
- **フォーカス（標準の振る舞い）**: 開いている間は**フォーカスを閉じ込める**（Tab は中で折り返し、
  外へ出たフォーカスは検索欄へ引き戻す）。閉じたら**開いた時にフォーカスがあった要素へ戻す**
  （消えている・`inert` の中・見えないなら `focusFallback()` の要素へ。無ければ動かさない）。
  **Esc は window で受ける**のでフォーカスの位置に関係なく閉じる。閉じるときは
  `preventDefault()` する（下の層は `event.defaultPrevented` を見て譲れる）。すでに消費された Esc と、
  手前に見えている層（`role="dialog"`・`role="menu"`・`data-esc-layer` で z-index が大きいもの、
  開いている popover、z-index が同じなら文書順で後ろのもの）があるときは譲る。
- **置き場所**: オーバーレイは `position: fixed`。`transform`・`filter`・`backdrop-filter` を持つ
  要素（glass のカードなど）の中に置くと、その要素が基準になって画面全体を覆わなくなるので、
  レイアウトの直下など外側に置く。

`StatusBadgeVariant`（`'neutral' | 'success' | 'warning' | 'danger' | 'info'`）と
`UiIconComponent`（`icon` に渡せる部品の型）、`UiMessages` / `defaultUiMessages`、
`CommandPaletteItem`・`CommandPaletteCloseReason`・`defaultCommandPaletteSearch` も export する。

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

```svelte
<script lang="ts">
	import { Menu, MenuGroup, MenuItem, MenuSeparator } from '@banto/ui';
</script>

<Menu label="ユーザーメニュー">
	{#snippet trigger(props)}
		<button {...props} type="button">メニュー</button>
	{/snippet}
	<MenuGroup label="アカウント">
		<MenuItem label="設定" onSelect={openSettings} />
	</MenuGroup>
	<MenuSeparator />
	<MenuItem label="ログアウト" danger onSelect={logout} />
</Menu>
```

```svelte
<script lang="ts">
	import { CommandPalette, type CommandPaletteItem } from '@banto/ui';

	let open = $state(false);
	const items: CommandPaletteItem[] = [
		{ id: 'nav.items', title: '商品', group: 'ナビゲーション', keywords: ['items'] },
		{ id: 'theme.dark', title: 'ダークテーマにする', group: 'テーマ', shortcut: 'Ctrl+D' }
	];
</script>

<button type="button" onclick={() => (open = true)}>コマンド</button>
<CommandPalette
	bind:open
	{items}
	onExecute={async (item) => {
		await runCommand(item.id);
	}}
/>
```

`LoadingState` の `label`（読み上げ文言）を省くとパッケージ既定の `defaultUiMessages.loading()`
（`'読み込み中…'`）になる。多言語化するアプリ（admin-template は Paraglide）は、
**既定に頼らず `label` を明示する**（英語表示で日本語が出ないように）。`CommandPalette` の
文言（`commandPaletteLabel`・`commandPalettePlaceholder`・`commandPaletteListLabel`・
`commandPaletteEmpty`・`commandPaletteRecent`）も同じで、既定は日本語。多言語化するアプリは
`messages` で渡す。

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
崩れる）。オーバーレイの背景と重なり順は `--banto-scrim`・`--banto-z-*` トークンを使う
（[@banto/theme](../theme/README.md)）。

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

admin-template の `/ui-demo`（デモモードのときだけナビに出る）に各部品の主要な状態を
並べてある（メニューとコマンドパレットはボタンから開く）。

## 関連ドキュメント

- [ADR-0018: 汎用 UI 部品は新パッケージ `@banto/ui` へ段階的に切り出す](../../docs/adr/0018-shared-ui-package.md)
- 本体リポジトリ: https://github.com/tyaro/banto
