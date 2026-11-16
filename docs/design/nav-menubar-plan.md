# ナビゲーションの「メニューバー」表示（ヘッダー統合）計画書

作成日: 2026-11-16
状態: **計画（決定済み）**。論点 D1〜D10 は 2026-11-16 にオーナー決定済み（D3=c、D7=b、D8=b、ほかは a）。§9 に記録。
トラック: 保守者向け（トラックA）
関連: [nav-launcher-plan.md](nav-launcher-plan.md)（ドック。切り替えの仕組みと D1〜D7）、
[visual-refresh-design.md](visual-refresh-design.md)（§7 Menu、§8 シェル）、
[display-preset-plan.md](display-preset-plan.md)（D1-b キオスクシェル）、
[ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui`、§11 段階 5 LauncherBar）、ADR-0005（i18n）、
ADR-0012（閲覧公開）、ADR-0030 §8（リソースから導くナビ）、
conventions §4 / §5 / §8 / §9 / §13 / §14、template-scope §2.2 / §7

## 1. 目的と範囲

3 ペインの画面（左ナビ + ツリー + グリッド / 図面）を持つアプリ（banto-industrial の banto-hub、
temp-scada）では、サイドバー（`--banto-shell-sidebar-width: 240px`、たたんでも 56px）が本文の幅を食う。
ナビを**今あるヘッダーの行（48px）に入れる**と、高さを増やさずに横幅を取り戻せる。

そこで、サイドバー・ドック（launcher、v6.8.0）に続く**選べる第 3 の形**として「メニューバー」を足す。
既定はサイドバーのままにする（既存の見た目も visual の基準画像も動かさない）。ドックの「上」は
ヘッダーの下に別のバーを置いて余白を取るので、今回の目的（縦も横も食わない）には合わない。

あふれの扱いは**両方**持つ（オーナー希望）:

1. **グループ**: ナビ定義に任意のグループを足せるようにし、グループはドロップダウン、
   グループに入らない項目は単独のリンクとして並べる。
2. **「その他 ▾」**: 幅が足りないとき、右端からあふれた上段の項目（単独もグループも）を
   「その他」にまとめる。

範囲に入れるもの: 切り替えの設定（ドックの仕組みの拡張）、ナビ定義のグループ、メニューバーの部品と配線、
テーマのトークン、テスト、文書。
入れないもの: （サイドバーのグループ見出しとドックの区切り線は D8-b で入れる。PR-5、§4.10）、
ホバーで開くドロップダウン、項目の並べ替え・ピン留め、ヘッダーの高さを変える二段組み、
サイドバー自体の `@banto/ui` への移設。

## 2. 現状の調査結果

### 2.1 ナビの定義（`apps/admin-template/src/lib/navigation.ts`）

- `NavItem` は `path` / `labelKey`（固定のページ）か `label`（リソースのエントリ、関数）/ `icon`（キーか部品）/
  `adminOnly` / `badgeResource` / `publicViewer` / `demoOnly` / `pageTitleResource` / `pageTitles` を持つ。
  **平らな配列で、グループの概念は無い**。
- リソースのエントリは `resourceNavItems()` が `resources` の `nav`（`lib/resource/types.ts` の `ResourceNav`:
  `icon` / `label` / `publicViewer` / `badge` / `adminOnly`）から導く（ADR-0030 §8）。
- `navItems` は `demoOnly` をデモのビルド（`isDemoBuild()`）でだけ残す。`publicNavItems()` は閲覧公開の許可リスト。
- `navSections({ publicViewer, role })` が「主要（`main`）/ 管理（`admin`）」の 2 区画を返す純粋関数
  （ドックの PR-1 で切り出した）。サイドバー・ドック・コマンドパレット（`lib/commands.ts` の
  `isNavItemVisible()`）の 3 か所が同じ関数で絞り込む。
- `pageTitle()` は全エントリ（`allNavItems`）から現在のページ名を引く。

### 2.2 scaffold の文字列一致の書き換え（`scripts/scaffold.mjs`）

`NAV`（navigation.ts）に対して、remover が**行の完全一致**で書き換える箇所がある:

- charts: `{ path: '/chart-gallery', labelKey: 'nav.chartGallery', icon: 'chart-gallery', demoOnly: true },` の行と
  `DemoNavIconKey` / `DemoNavLabelKey` の union。
- tree: `` `\t{ path: '/tree', labelKey: 'nav.tree', icon: 'tree' },\n` `` の行と、union の `'tree' | ` / `'nav.tree' | `。
- adminPages: `/users` と `/audit-log` の行、union の語。
- display（`displayDefaults` など。**順序依存**）: `/dashboard` の行を `/monitor` に置き換え、
  `NavIconKey = 'dashboard' | ` と `\n\t'nav.dashboard' | ` を書き換え、`publicViewer` の doc コメントの 1 行も書き換える。

→ **既存のエントリの行に `group: ...` を足すと、これらのアンカーがすべて外れる**。グループの付け方は
この制約に合わせて決める（§4.10、D7-b: アンカーの行を書き換え、remover も同じ PR で直す）。

### 2.3 シェルとヘッダー

- **シェル** `routes/(app)/+layout.svelte`: `settings.navLayout === 'launcher'` のとき `ShellLauncher`、
  それ以外は `Sidebar` + 900px 以下の幕（`overlayOpen`）。ドックのときだけルートに
  `data-banto-shell-nav="launcher"` と `data-banto-shell-launcher-position` を付ける（トーストの位置のため）。
- **サイドバー** `lib/components/Sidebar.svelte`: 2 つの `<nav>`（`shell.mainNav` / `shell.adminNav`）、
  未読バッジ（`navBadges.count(path)`、99+ で頭打ち、名前は `shell.navUpdates`）、`aria-current="page"`、
  管理ナビの見出し（`shell.adminHeading`、`aria-hidden`）。900px 以下は固定のドロワー。
- **ドックの配線** `lib/components/ShellLauncher.svelte`（57 行）: `navSections()` を `@banto/ui` の
  `LauncherBar` のグループに変えて渡すだけ。メニューバーの配線もこの形に合わせる。
- **ヘッダー** `lib/components/Header.svelte`（`<header>`、sticky、`--banto-shell-header-height` 48px、
  キオスクでは `-compact` 40px）。左から:
  ドロワーのボタン（900px 以下、サイドバー表示のとき）または**ブランド**（ドック表示のとき）→
  **ページ名**（`pageTitle()`、省略記号で切れる）→ spacer →
  **状態チップ**（デモ・LAN 共有・役割。768px 以下で隠れる）→
  **検索ピル**（768px 以下でアイコンだけ。キオスクでは全画面ボタンに替わる）→
  **テーマの切り替え** → **ユーザーメニュー**（`@banto/ui` の `Menu`。閲覧公開ではログインボタン）。
  ヘッダーのブレークポイントは 768px、シェル（ドロワー）は 900px（`narrowViewport`）で、値が違う。
- **ページ名と本文の見出し**: 本文の `PageHeader` は `hideTitle` で見出しを視覚的に隠し
  （`sr-only` の `<h1>`）、見た目のページ名はヘッダーだけが出している（10 ページ）。
  → メニューバー表示でもヘッダーのページ名を消すと、画面のどこにもページ名が見えなくなる（§4.6、D6）。
- **e2e** は 8 ファイル・19 か所でナビを `getByRole('navigation', { name: '主要ナビゲーション' })` で掴む
  （`e2e/tests/smoke.spec.ts`・`tests-public-viewer/public-viewer.spec.ts`・`visual/launcher.spec.ts` ほか）。

### 2.4 外観の設定（ドックで入れた仕組み）

- `lib/settings.svelte.ts`: `NavLayout = 'sidebar' | 'launcher'`、`NAV_LAYOUT_DEFAULT = 'sidebar'`、
  `isNavLayout()`、localStorage `banto.navLayout` と `UiSettingsProvider` の `shell.navLayout` の 2 層、
  `syncFromProvider()`（プロバイダに値が無ければ既定に戻す。`#changedSinceSync` で読み戻し中の変更を守る）。
- `routes/(app)/settings/AppearanceSection.svelte`: 「ナビゲーション」カードにラジオ 2 択
  （プレビュー `data-nav-layout` 付き）。ドックを選んだときだけ位置（上下左右）と透け具合を出す。
  説明文 `settings.navLayoutDesc` は「左のサイドバーか、画面の端のドック」と 2 択を前提に書いてある。

### 2.5 `@banto/ui` の Menu

- `Menu.svelte`（261 行）: 1 段のドロップダウン。`popover="auto"`（最上位の層、外のクリックと Esc で閉じる）、
  `role="menu"`、矢印・Home・End・Tab のキーボード、位置は `anchoredPopover.ts`（DateInput と共有）。
  トリガーは snippet で、`aria-haspopup="menu"` と `aria-expanded` を受け取る。
- `MenuItem.svelte`: **`<button role="menuitem">` だけで、`href` を持てない**（`onSelect` で動く）。
  `MenuGroup.svelte`: `role="group"` + `aria-label` + 見た目の見出し（`aria-hidden`）。
- **入れ子のサブメニューは無い**。

→ ナビのリンクを `MenuItem` に載せると、リンクではなくボタンになる（中クリック・新しいタブ・
`aria-current`・e2e の `getByRole('link')` が効かない）。§4.7 と D3 で扱う。

### 2.6 テーマのトークン（`packages/theme/src/css/banto.css`）

シェル: `--banto-shell-sidebar-width(-collapsed)`、`--banto-shell-header-height(-compact)`、
`--banto-shell-launcher-*`。z: `--banto-z-header: 100`、`--banto-z-launcher: 200` ほか。
ヘッダーは glass で `backdrop-filter` を持つ（`--banto-shell-header-backdrop`）。
→ `backdrop-filter` のある要素は、子孫の `position: fixed` の基準になる。ヘッダーの中に
`position: fixed` だけのドロップダウンを置くと glass で位置がずれる。**ドロップダウンは
`popover`（最上位の層）で出す**こと（Menu はすでにそうしている）。

### 2.7 ResizeObserver の前例

`@banto/grid-svelte`・`@banto/charts`・`@banto/dock-svelte` が使っている。jsdom には無いので、
テストは `globalThis.ResizeObserver` を差し替えている（`packages/dock-svelte/tests/DockHost.test.ts`・
`packages/charts/tests/messages-reactive.test.ts`）。`@banto/ui` のテストは既定が node 環境で、
部品のテストだけファイル単位で jsdom にする。

## 3. 切り替えの方法（設定と保存先）

ドックで入れた仕組みを**値を 1 つ増やす形で**広げる。新しいキーは足さない。

- `NavLayout = 'sidebar' | 'launcher' | 'menubar'`。`isNavLayout()` に `'menubar'` を足す。
  保存先は今のまま（localStorage `banto.navLayout`、プロバイダの `shell.navLayout`）。
  サーバーはキーを知らない汎用の保存なので、Rust の変更は無い。
- 既定は `NAV_LAYOUT_DEFAULT = 'sidebar'` のまま。アプリ作者が「うちはメニューバーが既定」にしたいときは
  この定数だけを変える（ドックと同じ。README に 1 行）。
- 古い版のアプリが `'menubar'` を読んでも、`isNavLayout()` が知らない値として既定のサイドバーに戻す
  （下げても壊れない）。
- 「プロバイダに値が無ければ既定に戻す」「読み戻し中の変更を守る」の規則はそのまま効く（値が増えるだけ）。
- **画面**: 外観の「ナビゲーション」カードのラジオを 3 択「サイドバー / ドック / メニューバー」にする。
  プレビューに `data-nav-layout="menubar"`（上の帯に短い線が並ぶ絵。トークンだけで描く）を足す。
  位置と透け具合の副設定はドックのときだけ出す（今のまま）。メニューバーには副設定を足さない。
  説明文 `settings.navLayoutDesc` を 3 択に合わせて書き直す（例「ページへのリンクを、左のサイドバー・
  画面の端のドック・ヘッダーのメニューバーのどれで表示するか選びます。」）。
  → `settings-*` の基準画像は作り直しになる。

## 4. メニューバーの見た目と振る舞い

### 4.1 並び（900px 超）

ヘッダーの 1 行の中で、左から:

```
[ブランド] [主要ナビ: 項目 項目 グループ▾ 項目 … その他▾] [管理▾] [ページ名] ─spacer─ [状態] [検索] [テーマ] [ユーザー]
```

- **ブランド**はドックと同じくヘッダーの左端に出す（サイドバーが無いので）。ドロワーのボタンは出さない。
- **主要ナビ**は `<nav aria-label="主要ナビゲーション">`。上段の項目は単独のリンクかグループの開閉ボタン。
  入りきらない分は右端の「その他 ▾」へ（§4.3）。
- **管理ナビ**は `<nav aria-label="管理ナビゲーション">` の中に「管理 ▾」の 1 つのグループとして出す
  （見出しのキー `shell.adminHeading` を流用）。サイドバーで見出し付きの別区画だったのと同じ意味で、
  上段では 1 つ分の幅しか取らない。管理ナビは「その他」に入れず、いつも出す（D4）。
- 上段の項目は**文字だけ**にし、ドロップダウンの中は**アイコン + 文字**にする（D5）。
- **アクティブの表示**: 項目の下端に 3px の線（部品の形の縁。conventions §9 で許される）と文字色
  `--banto-primary-hover`（サイドバーと同じ理由のコントラスト）。

### 4.2 グループ（ドロップダウン）

- 上段にはグループ名と ▾ のボタンを出し、押すと下にそのグループのリンクの一覧を出す。
- 中の項目が今のページなら、ボタンにもアクティブの表示を付ける（`aria-current` はリンクにだけ付ける。§4.8）。
- 出し方は `popover="auto"`（外のクリック・Esc で閉じる、ほかのドロップダウンを開くと閉じる）。
  位置は `@banto/ui` の内部の `anchoredPopover.ts` を使う（下に出し、入らなければ上、横ははみ出さない）。
- 開くのは**クリック（タップ）だけ**。ホバーでは開かない（D9。工場のタッチパネルで誤って開くのを避け、
  キーボードと同じ操作にそろえる）。

### 4.3 あふれ（「その他 ▾」）

- 主要ナビの幅に入りきらないとき、**右端から順に**上段の項目（単独もグループも）を「その他」に移す。
  「その他」のボタンの幅を差し引いて計算する。全部入れば「その他」は出さない。
- 「その他」の中は、移した順（もとの並び）で並べる。**グループは見出しで区切り、中のリンクを平らに並べる**
  （D2-a。Menu に入れ子のサブメニューが無いので。見た目は `MenuGroup` の見出しと同じ）。
  グループに入らない項目は見出しの無いかたまりとして並べる。
- アクティブの項目が「その他」に入ったら、「その他」のボタンにアクティブの表示を付ける。
- 未読バッジ（§4.5）が中にあれば、ボタンに点を出す。

### 4.4 あふれの検出（ResizeObserver）

- **測る行を別に持つ**: 全部の上段の項目（と「その他」のボタン）を、見えない測定用の行に描く
  （`position: absolute; visibility: hidden; pointer-events: none`、`aria-hidden="true"`、`inert`。
  中は `<a>` ではなく `<span>` にして、リンクやボタンが二重に a11y ツリーと e2e に出ないようにする）。
  測定用の行は流れの外に置くので、その幅は「何個見せるか」の結果に左右されない（ResizeObserver の
  ループが起きない）。
- **使える幅**: 主要ナビの入れ物を `flex: 1 1 0; min-width: 0` にして、その幅を ResizeObserver で見る。
  入れ物の幅も中身に左右されない（中身が増えても入れ物は広がらない）。
- **項目の幅**: 測定用の行の各項目の `getBoundingClientRect().width` を読む。測定用の行にも
  ResizeObserver を付けると、**言語の切り替え**（文言の長さが変わる）・フォントの読み込み・
  **文字だけの拡大（200%）**で幅が変わったときにも測り直せる。
- **計算は純粋関数**: `fitCount(widths, available, moreWidth, gap)` → 上段に残す個数。
  部品から切り離して表でテストする（§7.1）。
- **ちらつき防止**: (1) 最初の測定が済むまで見える行を `visibility: hidden` にする（行の高さは残すので
  ヘッダーは跳ねない）。(2) 個数が変わったときだけ状態を書き換える。(3) ResizeObserver の通知は
  レイアウトの後・描画の前に来るので、ふつうは 1 フレームで落ち着く。
- **文字 200%**: ヘッダーの高さは 48px のままなので、項目の行の高さは `--banto-control-height` に合わせ、
  文字が増えた分は「その他」に回る（WCAG 1.4.4 では、見えなくなる項目が「その他」から届けば足りる）。
  ブラウザ全体の拡大（ズーム）は CSS の px ごと大きくなるので、ふつうに幅が狭くなったのと同じ扱い。
- CSS だけの方法（折り返して 2 行目を隠す・IntersectionObserver）は、「その他」に何を入れるかを
  別に知る必要があり、結局 JS が要るので採らない。

### 4.5 未読バッジ

- 上段の単独の項目: サイドバーと同じ数字のバッジ（99+ で頭打ち、名前に `shell.navUpdates`）。
- グループと「その他」のボタン: 中の件数の合計があれば小さな点を出し、ボタンの名前に
  `shell.navUpdates`（合計）を足す（例「その他、3件の未確認の更新」）。
- ドロップダウンの中の項目: 数字のバッジ（上段と同じ）。

### 4.6 ヘッダーの中の幅の取り合い

ヘッダーの 1 行に入る要素の**最後まで残る順**（上ほど優先）:

1. ブランドのマーク、ユーザーメニュー（閲覧公開ではログイン）、テーマの切り替え — 縮めない。
2. 管理 ▾ と「その他 ▾」 — 縮めない。
3. 主要ナビの項目 — 入らない分は「その他」へ（§4.3）。
4. ページ名 — 最大幅をトークン `--banto-shell-menubar-title-max`（例 12rem）で抑え、省略記号で切る
   （全文は `title` 属性）（D6）。
5. 検索ピル — 今の 768px の切り替えに加え、メニューバー表示では**いつもアイコンだけ**にする
   （キーの表示 `Ctrl+K` はツールチップに出す）（D6）。
6. 状態チップ — 今のまま（768px 以下で隠れる）。メニューバー表示で幅を取りすぎるなら、
   チップを点にする案は実装時に見た目で決める。

ブランドの文字「Banto」は、幅が足りないとき（例 1100px 以下）マークだけにしてよい
（コンテナクエリか、ヘッダーの幅の ResizeObserver。実装時に決める）。

### 4.7 キーボード操作とアクセシビリティの型

**決定（D3-c）: ナビゲーションのリンク列 + 開閉ボタン（APG の disclosure navigation）の上に、
上段の矢印キーの補助を最初から入れる**。
WAI-ARIA の `menubar` の型（`role="menubar"` / `menuitem`、矢印で移動、ロービング tabindex）は使わない。

- 上段の単独の項目はふつうの `<a href>`、グループと「その他」は `<button aria-expanded aria-controls>`。
  Tab の順にそのまま並ぶ（ドックの §4.7 と同じ考え）。
- 開いた一覧は `<ul>` の `<a href>`（`role` を付けない）。Tab で中のリンクへ進み、最後のリンクから
  Tab で出ると閉じる。Esc で閉じてボタンにフォーカスを戻す。矢印の上下で中のリンクを移る補助を付ける
  （APG の例も任意で持っている）。
- **矢印の補助（D3-c、最初から入れる）**: 上段の「リンク・開閉ボタン」の間を、矢印の左右で移る
  （先頭で左なら末尾へ、末尾で右なら先頭へ回る。「その他」も 1 つの項目として含める）。Home / End で
  上段の先頭 / 末尾へ移る。Tab はこれまでどおり上段を 1 つずつ進める（ロービング tabindex にはしない。
  すべての項目が Tab 停止のまま）。開いたドロップダウンの中は、矢印の上下で移り、Home / End で先頭 / 末尾、
  左右の矢印は閉じて上段の隣の項目へ移る（開いたまま隣のグループを開くかは実装時に APG の例に合わせる）。
  `role="menubar"` / `menuitem` は使わない。
- 「その他」の中のグループの見出しは、`<ul>` を `role="group"` + `aria-labelledby`（見出しの id）で包む。
- **理由**: (1) 中身はページへのリンクで、アプリのコマンドではない。APG もサイトのナビには
  `menubar` ではなく disclosure を勧めている。(2) リンクのままなので、中クリック・新しいタブ・
  `aria-current="page"`・SvelteKit のクライアント遷移がそのまま効く。(3) e2e が
  `getByRole('navigation', { name: '主要ナビゲーション' })` の中の `getByRole('link', …)` で掴めるまま
  （ドロップダウンの中も同じ `<nav>` の子孫。popover は DOM の位置を変えない）。
  `menuitem` にするとリンクとして見つからない。(4) Menu の `MenuItem` に `href` を足す改修が要らない。
- `Ctrl+K`（コマンドパレット）は今のまま。メニューバー固有のショートカットは足さない。
- DOM の順は「ブランド → ナビ → ページ名 → … → ユーザー」になり、ナビが本文より先に来る
  （サイドバーと同じ体験）。

### 4.8 アクセシビリティのまとめ

- ランドマーク 2 つ（主要・管理。`<header>` の中に置く）。名前はサイドバーと同じキー。
- `aria-current="page"` はリンクにだけ付ける（上段でもドロップダウンの中でも）。開閉ボタンには付けず、
  見た目のアクティブ表示だけにする（ボタンは「ページ」ではないため）。
- 開閉ボタンの名前は実テキスト（グループ名、「その他」）+ 未読の件数。▾ は `aria-hidden`。
- フォーカスの輪は既存のトークン（`--banto-focus-ring`）。
- 動き: ドロップダウンの出入りは duration トークン経由（reduced-motion で 0ms）。
- axe（`e2e/visual/a11y.spec.ts`）にメニューバー表示の走査を足す（閉じた状態と、グループを開いた状態）。

### 4.9 狭い画面（900px 以下）

**推奨（D10-a）: ハンバーガーで既存のサイドバーのドロワーに戻す**。

- 900px 以下では、メニューバーを描かず、ヘッダーにドロワーのボタンを出し、今のサイドバーを
  ドロワーとして使う（サイドバー表示の 900px 以下と同じ画面）。ドロワーの中は今のサイドバーなので、
  D8-b のグループ見出しが付く。
- 900px を越えて広げたときにドロワーが開いていたら閉じる（今のサイドバー表示と同じ動き）。
- 理由: 900px 以下ではメニューバーの上段にほとんど入らず、ほぼ全部が「その他」になる。
  ドロワーの方が慣れていて、新しい実装も要らない。ドックの D5（タブバー）と違い、設定と見た目が
  画面の幅で変わるが、メニューバーは「横幅を取り戻す」ための形なので、狭い画面では意味が薄い。

### 4.10 グループの定義と、ほかの表示での扱い

- `NavItem` に任意の `group?: NavGroupKey` を足す（`NavGroupKey` は辞書のキーの union。新しい型で、
  scaffold の remover が触る `NavIconKey` / `NavLabelKey` / `Demo*` の union とは分ける）。
  リソースのエントリは `ResourceNav` に `group?: NavGroupKey` を足して `resourceNavItems()` が渡す。
- グループの位置は**最初のメンバーの位置**。メンバーが離れていても、そこに集める（並びはもとの順）。
- `adminOnly` の項目の `group` はメニューバーでは無視する（管理ナビ全体が 1 つのグループのため）。
- 上段の並びを作るのは、navigation.ts に足す純粋関数 `navBarEntries(items)`
  （`{ kind: 'item', item } | { kind: 'group', key, items }` の配列）。UI に依存せず、表でテストする。
- **サイドバー・ドック（D8-b）**: サイドバーは `group` をグループの見出しにする（PR-5。グループを付けた
  アプリだけ見た目が変わる）。ドックはグループの境目に区切り線を入れる。グループの無いナビは今のまま。
  グループの位置と並びはメニューバーと同じ規則（最初のメンバーの位置に集める。`navBarEntries()` を共用）。
- **コマンドパレット**: パレットの分類（`commandPalette.groupNavigation`）は今のまま。グループ名を
  `keywords` に足し、グループ名で探しても出るようにする（小さな変更。PR-1 に含める）。
- **scaffold との衝突**: 既存のエントリの行に `group` を書くと §2.2 のアンカーが外れる。
  → **決定（D7-b）**: デモ専用の項目 `/ui-demo`・`/chart-gallery`（`demoOnly`）に同じ `group`
  （「見本」。辞書のキーは `nav.group.demo` など。実装時に決める）を付け、グループを 1 つ作る。
  `/chart-gallery` の行が変わるので、charts の remover の完全一致の文字列も**同じ PR で直す**
  （`scripts/scaffold.mjs`。ほかのアンカーの行 — tree・adminPages・display — には `group` を足さない）。
  4 プリセットの `--dry-run` で確かめる。
  - **デモと本番でナビの形が変わる**: `demoOnly` は `navItems` の段階で外れるので、本番のアプリには
    「見本」グループが出ない（上段は単独のリンクだけ）。`isDemoBuild()`（`VITE_BANTO_DEMO=1`）のビルドでだけ出る。
    e2e の `chromium`（smoke）・`public-viewer`・`visual` の各プロジェクトは本番と同じビルドなので**出ない**。
    出るのは `vite dev` に `VITE_BANTO_DEMO=1` を付けた `demo` プロジェクト（`e2e/demo`）だけ（`e2e/playwright.config.ts`）。
  - 利点: `e2e/demo` で、実物のグループ（開閉・`aria-current`・「その他」の中の見出し）を試せる。
  - `/ui-demo` のカードと単体テストの見本は、そのまま残す。使い方は README / recipes に書く。

### 4.11 キオスク・閲覧公開・demoOnly

- **キオスク**（`shell.kiosk`）: ヘッダーが 40px になるだけで、メニューバーはその高さに合わせる。
  検索ピルはもともと出ない（全画面ボタン）。特別な処理は入れない。display プリセットの既定は変えない。
- **閲覧公開**: `navSections()` の絞り込みをそのまま使う（許可リストだけ、管理ナビ無し）。
  ヘッダーの右端はログインボタン。
- **demoOnly**: `navItems` の段階で外れているので、メニューバーで何もしなくてよい。

## 5. 部品の分け方と置き場

### 5.1 共有 UI（`@banto/ui`）に置くもの — 推奨（D1-a / D2 の置き場）

ADR-0018 の基準（文言・アイコン・状態・操作を props / snippet / コールバックで受ける、`svelte` 以外を
import しない、CSS は `--banto-*` だけ、ナビ定義を知らない汎用の部品として切れる）に照らして、
**表示と操作は `@banto/ui` の `HeaderNav`**（仮名。D1）に置く。

- `HeaderNav.svelte`（表示・開閉・あふれ）と `headerNav.ts`（型と純粋関数 `fitCount`）。
- props（案）:
  - `entries: HeaderNavEntry[]`。
    `HeaderNavLink = { id; href; label; icon?: UiIconComponent; active?: boolean; badge?: { text; label } }`、
    `HeaderNavEntry = ({ kind: 'link' } & HeaderNavLink) | { kind: 'group'; id; label; items: HeaderNavLink[] }`
  - `ariaLabel: string`（`<nav>` の名前）、`moreLabel: string`（「その他」）、
    `updatesLabel?: (count: number) => string`（ボタンに足す未読の名前）
  - `overflow?: boolean`（既定 `true`。管理ナビは `false` で 1 グループだけ渡す）
- 主要と管理で **2 回使う**（`<nav>` が 2 つになる）。
- 文言は全部 props で受けるので `UiMessages` は増やさない。`.svelte.ts` を足さない（状態は `.svelte` の
  `$state`。conventions §14 の同期の対象を増やさない）。
- ドロップダウンの位置は内部の `anchoredPopover.ts` を再利用する（パッケージの外に出さない）。

**理由**: (1) あふれの検出・開閉・Esc とフォーカスの戻し・a11y の約 300 行を派生アプリが写さずに済む
（コピー面積、template-scope §7）。(2) banto-hub と temp-scada は自前の Sidebar とシェルを持つので、
アプリ側に置くと使えない。パッケージなら経路 A のタグ上げで届く（§10）。(3) ナビ定義（`NavItem`）を
知らない「リンクとグループの並び」として切れる（conventions §5）。

`Menu` を拡張して使う案（`MenuItem` に `href` を足し、`menu` の型で作る）は D3-b だったが、採らなかった。
矢印の補助（D3-c）は `HeaderNav` の中に持つ（`headerNav.ts` に、移動先を求める純粋関数を足して表でテストする）。

### 5.2 アプリ側（admin-template、コピーされる側）

- `lib/navigation.ts`: `NavGroupKey`、`NavItem.group`、`navBarEntries()`（§4.10）。
- `lib/resource/types.ts`: `ResourceNav.group`。
- `lib/components/ShellMenubar.svelte`（新規、約 60 行）: `navSections()` → `navBarEntries()` →
  `HeaderNav` の `entries` に変えて 2 つ描く。`ShellLauncher` と同じ形の配線だけ。
- `lib/settings.svelte.ts`: `NavLayout` に `'menubar'`。
- `routes/(app)/+layout.svelte`: メニューバーのときは、900px 超でサイドバーを描かない
  （900px 以下は今のサイドバーのドロワー）。
- `Header.svelte`: メニューバーのときブランド + `ShellMenubar` を出し、900px 以下はドロワーのボタンに戻す。
  ページ名と検索ピルの縮め方（§4.6）。
- `AppearanceSection.svelte`: 3 つ目のラジオとプレビュー、説明文。
- `lib/commands.ts`: グループ名を `keywords` に足す。
- デモ専用の項目（`/ui-demo`・`/chart-gallery`）に `group` を付ける（D7-b。`scripts/scaffold.mjs` の charts の remover も同じ PR）。
- `Sidebar.svelte` とドックの配線: グループを見出し / 区切り線にする（D8-b、PR-5）。
- `messages/{ja,en}.json`: `settings.navLayoutMenubar`（ja「メニューバー」/ en「Menu bar」）、
  説明文の書き直し、`shell.navMore`（ja「その他」/ en「More」）、デモのグループ名（ja「見本」/ en「Samples」）。
  グループを使う派生アプリは自分のグループ名のキーを足す。

### 5.3 テーマ（`@banto/theme`）

`banto.css` の `:root` にシェルの名前空間で足す（色は足さない）:

| トークン | 例 | 用途 |
|---|---|---|
| `--banto-shell-menubar-item-padding-x` | `var(--banto-space-3)` | 上段の項目の左右の余白 |
| `--banto-shell-menubar-gap` | `var(--banto-space-1)` | 上段の項目の間隔（`fitCount` も同じ値を読む） |
| `--banto-shell-menubar-indicator` | 3px | アクティブの下線の太さ |
| `--banto-shell-menubar-title-max` | 12rem | メニューバー表示のページ名の最大幅（§4.6） |
| `--banto-shell-menubar-popover-min-width` | 12rem | ドロップダウンの最小幅 |

背景・枠・影・角丸は既存のトークン（`Menu` と同じ `--banto-surface-raised` など）。
重なり順は popover の最上位の層なので、z のトークンは要らない。トーストの位置も変わらないので、
ルートの `data-banto-shell-nav` は付けない（付けるなら `menubar` の値を足すだけ）。

### 5.4 ADR

新しい ADR は作らず、ADR-0018 に「§12 段階 6: HeaderNav」を足す（置き場の判断・props の形・
disclosure の型にした理由・`Menu` を使わない理由・`.svelte.ts` を持たない理由）。

## 6. scaffold のプリセットとコピー面積

- **推奨（ドックの D3-a と同じ）: コアの機能として全プリセットに残す**。
  アプリ側に足すのは約 120〜150 行（ShellMenubar 約 60、navigation.ts 約 30、設定 約 5、
  レイアウトとヘッダーの分岐 約 25、外観カード 約 10、辞書のキー 約 5 × 2）。重い部分はパッケージにある。
- 外したいアプリ作者は外観カードのラジオを 1 つ消せば選べなくなる（README / recipes に 1 行。
  ドックの手順と同じ場所）。
- **アンカーの確認**: 触るファイルの多く（`navigation.ts`・`Header.svelte`・`(app)/+layout.svelte`・
  `AppearanceSection.svelte`・`settings.svelte.ts`）が scaffold のアンカーの対象。各 PR で
  **4 プリセットの `--dry-run`** をコピーに対して走らせる（フロントだけの変更では template-acceptance が
  走らないことがあるので、PR の中で自分で確かめる）。
- `NavItem.group` を足すのは `demoOnly` の 2 項目の行だけ（D7-b）。その行を書き換える charts の remover の
  文字列を同じ PR で直す。tree・adminPages・display のアンカーの行と、display の remover が書き換える
  `publicViewer` の doc コメントの行には触らない。
- template-scope §2.2 の「ナビの表示形式」の行を「サイドバー / ドック / メニューバー」にする。

## 7. テストの方針

### 7.1 単体（vitest）

- `packages/ui/tests/headerNav.test.ts`（node）: `fitCount` の表 — 全部入る（「その他」無し）、
  1 つあふれる（「その他」の幅を引いて計算し直す）、全部あふれる、幅 0、間隔の扱い、
  「その他」を足すと 1 つ減る境目。
- `packages/ui/tests/HeaderNav.test.ts`（`// @vitest-environment jsdom`、`@testing-library/svelte`）:
  - ResizeObserver は**差し替えのクラスで、コールバックをテストから呼べる形**にする
    （`DockHost.test.ts` の形を広げる）。幅は `vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')` で、
    測定用の項目の `data-*` から返す。入れ物の幅を変えて通知を送り、上段の個数と「その他」の中身を確かめる。
  - popover は jsdom に無いので、`showPopover` / `hidePopover` を Menu のテストと同じ方法で差し替える。
  - 見るもの: `<nav>` と名前、リンクの `href` と名前、`active` → `aria-current="page"`（上段とドロップダウンの中）、
    開閉ボタンの `aria-expanded` / `aria-controls`、Esc で閉じてボタンにフォーカスが戻る、
    「その他」の中のグループの見出しと `role="group"`、アクティブが「その他」に入るとボタンにクラス、
    バッジの名前、**測定用の行が `aria-hidden` で `<a>` を持たない**、個数が同じなら書き換えない。
- `apps/admin-template/src/lib/navigation.test.ts`: `navBarEntries()` の表（グループ無し、
  離れたメンバーを最初の位置に集める、`adminOnly` の `group` を無視、閲覧公開の絞り込みの後でも成り立つ）。
- 設定ストア: `'menubar'` を読める・書ける、知らない値は既定、プロバイダに値が無ければ既定（既存のテストに行を足す）。
- コマンドパレット: グループ名が `keywords` に入る。
- `headerNav.ts` の矢印の移動（D3-c）の表: 左右の回り込み、Home / End、「その他」を含む、開いた一覧の中の上下。
  `HeaderNav.test.ts` にも、矢印の左右・Home / End で上段のフォーカスが移ることを足す。
- charts の remover: scaffold のテスト（あれば）か `--dry-run` で、`group` 付きの行が正しく消えることを確かめる。
- Sidebar（D8-b）: グループの見出しが出る・グループが無ければ今のまま。ドックの区切り線。

### 7.2 e2e（`pnpm e2e`、banto-serve）

`e2e/tests/smoke.spec.ts` に足す:

1. 外観でメニューバーを選ぶ → ヘッダーの中に主要ナビ（同じロケーター）があり、サイドバーが無い →
   リンクで移れて `aria-current` が移る → 再読み込みしても保たれる → サイドバーに戻す。
2. 幅を狭める（例 1000×800）→「その他」が出る → 開いて中のリンクで移れる。**個数は数えない**
   （フォントで幅が OS ごとに違うため）。「上段 + その他の中」が全部の項目と同じ集合であることを見る。
3. キーボード: Tab で「その他」へ → Enter で開く → Tab で中のリンクへ → Esc で閉じてボタンに戻る。
   矢印（D3-c）: 上段で右 / 左 / Home / End を押すとフォーカスが移る（グループの無い本番の項目と管理ナビで見る）。
4. 768×1024 でハンバーガーが出て、サイドバーのドロワーが開く。

`e2e/tests-public-viewer` に、メニューバー表示でも許可リストの項目だけが出ることを 1 本足す。
「見本」グループ（D7-b）は `demoOnly` の項目なので、smoke（`chromium`）や visual のビルドには出ない。
グループの e2e は **`e2e/demo` に新しい spec を足す**（`demo` プロジェクト。`vite dev` + `VITE_BANTO_DEMO=1`）:
外観でメニューバーを選ぶ →「見本」グループを開閉 → 中のリンクで移って `aria-current` とグループのボタンの
「現在地」表示を見る → 矢印の上下で中を移る → 幅を狭めて「その他」の中の見出しを見る → サイドバーに戻して
見出し（D8-b、PR-5）・ドックの区切り線を見る。テストはデモの項目に依存する（派生アプリでは使えない）。

### 7.3 visual（基準画像は Linux でだけ作る）

- 既定はサイドバーのまま。visual は本番と同じビルドで「見本」グループ（`demoOnly`）が出ないので、
  D7-b・D8-b でもサイドバー・ドックを写す既存の基準画像（`dashboard-*`・`launcher-*`）は**動かない見込み**
  （動いたら原因を調べる）。グループの見た目は visual では写せないので、`e2e/demo` の e2e と ui-demo の
  カード（`ui-demo-*` は visual が写す）で確かめる。ただし外観カードのラジオと説明文が
  変わるので `settings-light-standard` / `settings-dark-glass` は作り直し。ui-demo にカードを足すなら `ui-demo-*` も。
- 足すもの: `dashboard-menubar-light-standard-1440x900`、`dashboard-menubar-dark-glass-1440x900`、
  `dashboard-menubar-light-standard-1024x768`（あふれ。「その他」を開いた状態も撮るかは安定性を見て決める）。
  ドックと同じく localStorage を事前に入れて撮る（`e2e/visual/launcher.spec.ts` の形）。
- 作業機には WSL / Docker が無いので、`.github/workflows/visual-baselines.yml` を PR のブランチに
  dispatch して作り、差分が「増えた・変えたつもりの画像だけ」であることを PR の説明で確かめる。
- axe: メニューバー表示の dashboard（light-standard / dark-glass、閉じた状態と開いた状態）。

### 7.4 そのほかの検証

`pnpm check`・`pnpm lint`・`pnpm verify:architecture`（raw-colors・raw-dimensions・package-bare-imports・
no-app-import・raw-jp-in-app）・`pnpm format:check`。Rust の変更は無い。外部利用 fixture は
`.svelte.ts` を足さないので変更不要の見込み（external-consumer のワークフローで確かめる）。

## 8. PR の分け方と順番

| # | PR | 中身 | 画面の変化 / 基準画像 | モデル |
|---|---|---|---|---|
| 0 | 計画（本書） | 本書の追加。オーナー決定を §9 に書き込む | なし | — |
| 1 | ナビのグループ | `NavGroupKey`・`NavItem.group`・`ResourceNav.group`・`navBarEntries()`・パレットの `keywords`・表のテスト。デモ専用の 2 項目に「見本」グループを付け、charts の remover を直す（D7-b） | 本番の画面は変わらない（基準画像は動かない見込み）。`e2e/demo` にグループの確認を足すのは PR-3 | sonnet |
| 2 | トークン + `HeaderNav` | `banto.css` に §5.3、`@banto/ui` に `HeaderNav` / `headerNav.ts`、単体テスト、README、ADR-0018 §12。矢印の補助（D3-c）、ui-demo のカード（グループとあふれの見本） | `ui-demo-*` 作り直し（カードを足すとき） | 上位 |
| 3 | シェルへの配線と設定 | `'menubar'` の値、`ShellMenubar`、レイアウトとヘッダーの分岐（ページ名・検索の縮め方、900px 以下のドロワー）、外観カード、辞書、e2e、a11y、visual 追加 | `settings-*` 作り直し + `dashboard-menubar-*` 追加 | 上位 |
| 4 | 文書 | README / recipes（既定にする・外す）、template-scope §2.2、CHANGELOG、upgrading.md、本書の状態行 | なし | sonnet |
| 5 | サイドバーのグループ見出しとドックの区切り線（D8-b） | Sidebar でグループを見出しにし、ドックは区切り線にする。`navBarEntries()` を共用 | デモ版だけ見た目が変わる（基準画像は動かない見込み）。`e2e/demo` の spec に見出し・区切り線の確認を足す | sonnet |

- 1 と 2 は独立なので並べて進められる。3 は 1 と 2 の後。5 は 1 の後（3 と並べてよい）。4 は 3 と 5 の後（CHANGELOG は各 PR で 1 行ずつ足してよい）。
- 各 PR で 4 プリセットの scaffold `--dry-run` を確かめる（§6）。自作の PR はセルフマージしない。
- 版: パッケージの公開 API の追加と、設定の値の追加だけなので minor。

## 9. 論点とオーナー決定（2026-11-16）

各論点の（決定）が採った案。

| 論点 | 決定 |
|---|---|
| D1 名前 | 設定の値 `menubar`、画面の表示 ja「メニューバー」/ en「Menu bar」、部品 `@banto/ui` の `HeaderNav` と配線 `ShellMenubar`、トークン `--banto-shell-menubar-*` |
| D2 「その他」の中のグループ | 見出しで区切って平らに並べる |
| D3 キーボードと a11y の型 | **c**: リンク列 + 開閉ボタン（disclosure）の上に、矢印の左右・Home / End の補助を最初から入れる。`role="menubar"` は使わない |
| D4 管理ナビ | 別の `<nav>` に「管理 ▾」の 1 グループ。「その他」に入れない |
| D5 上段のアイコン | 上段は文字だけ、ドロップダウンの中はアイコン + 文字 |
| D6 ページ名と検索 | ページ名は残して最大幅で切る。検索はメニューバー表示ではいつもアイコンだけ |
| D7 テンプレートのグループ | **b**: デモ専用の項目を「見本」グループにまとめる。charts の remover のアンカーを同じ PR で直す |
| D8 ほかの表示でのグループ | **b**: サイドバーでもグループを見出しにする（PR-5）。ドックは区切り線。パレットは `keywords` に足す |
| D9 開き方 | クリック（タップ）だけ。ホバーでは開かない |
| D10 900px 以下 | ハンバーガーで既存のサイドバーのドロワーに戻す |

### D1. 名前

- **a（推奨・決定）**: 値 `menubar`、表示「メニューバー」、部品 `HeaderNav` / `ShellMenubar`。
  部品名に `MenuBar` を使わないのは、ARIA の `menubar` の型（D3-b。採らなかった）を連想させるため。
  実装の前に `HeaderNav` / `menubar` が既存の名前とぶつからないことを grep で確かめる。
- b: 部品も `MenuBar`（表示と名前がそろうが、`role="menubar"` を持たないのに紛らわしい）。

### D2. 「その他」の中のグループ

- **a（推奨・決定）**: 見出し（`MenuGroup` と同じ見た目）で区切って、中のリンクを平らに並べる。
  入れ子の操作が無いので、タッチでもキーボードでも迷わない。項目が多いと縦に長くなるが、
  ドロップダウンは高さを抑えて中でスクロールする（`anchoredPopover.ts` の既存の動き）。
- b: 入れ子のサブメニュー（「その他 ▸ グループ ▸ 項目」）を足す。見た目は締まるが、`@banto/ui` の
  Menu に無い仕組み（横に開く位置決め・矢印の左右・ホバーの猶予・タッチでの開閉）を新しく作ることになり、
  部品が大きくなる。D3（disclosure）の上で入れ子にするのは APG にも例が無い。

### D3. キーボードと a11y の型

- a（推奨）: リンク列 + 開閉ボタン（disclosure navigation）。理由は §4.7（リンクのまま・e2e の
  ロケーターが効く・APG がサイトのナビに勧める形・Menu の改修が要らない）。
- b: WAI-ARIA の `menubar` の型。`MenuItem` に `href` を足し、上段も `menuitem` にする。アプリの
  メニュー（ファイル・編集…）に近い操作感だが、リンクとして扱えず、e2e のロケーター（`getByRole('link')`）
  を全部見直すことになる。上段を矢印で動く操作に慣れていない利用者も多い。
- **c（決定）**: a の上段に、矢印の左右で項目を移る補助を**最初から**足す（Home / End も。§4.7）。
  `role="menubar"` は使わず、Tab で全項目に止まるのも a と同じ。a の後から足しても API は壊れないが、
  最初から入れて e2e とテストを一度で固める。

### D4. 管理ナビ

- **a（推奨・決定）**: 別の `<nav aria-label="管理ナビゲーション">` に「管理 ▾」の 1 グループ。いつも出す。
- b: 管理の項目を主要ナビの末尾に区切り線つきで並べる（ランドマークは 2 つのまま）。あふれやすくなる。

### D5. 上段のアイコン

- **a（推奨・決定）**: 上段は文字だけ（幅を節約するのが目的のため）。ドロップダウンの中はアイコン + 文字。
- b: 上段もアイコン + 文字（サイドバーに近い見た目だが、項目が 1.3 倍ほど広くなる）。

### D6. ページ名と検索

- **a（推奨・決定）**: ページ名は残し、`--banto-shell-menubar-title-max` で切る。本文の `PageHeader` は
  `hideTitle` のままでよく、ページを書き換えなくて済む。検索はメニューバー表示ではアイコンだけ。
- b: メニューバー表示ではヘッダーのページ名を消し、本文の見出しを見せる。幅は最も空くが、
  10 ページの `hideTitle` をシェルの形で切り替える仕組み（`PageHeader` への props か、ルートの属性）が要る。
- c: 検索ピルは今のまま（768px で切り替え）。ナビの幅が減る。

### D7. テンプレートのグループ

- a（推奨）: テンプレートの既定のナビにはグループを付けない。scaffold のアンカー（§2.2）を守り、
  既存のアプリの見た目も変えない。グループの見本は ui-demo のカードと単体テスト、使い方は recipes。
- **b（決定）**: デモ専用の項目（`/ui-demo`・`/chart-gallery`）を「見本」グループにまとめる。`e2e/demo`
  （`demo` プロジェクト）で実物のグループを試せる（smoke・visual は本番と同じビルドなので出ない）。charts の remover のアンカーを同じ PR で直す必要があり、デモと本番でナビの形が変わる
  （本番には「見本」が出ない）。§4.10。

### D8. ほかの表示でのグループ

- a（推奨）: サイドバーとドックはグループを無視する（平らなまま）。パレットはグループ名を
  `keywords` に足すだけ。見出しの要望が出たら別計画。
- **b（決定）**: サイドバーでもグループを見出しにする（PR-5）。ドックは区切り線にする。見た目が変わるのは
  グループを付けたアプリだけ。D7-b の「見本」グループはデモ版にだけ出て、visual は本番と同じビルドなので
  既存の基準画像は動かない見込み。確認は `e2e/demo` で行う。パレットは `keywords` に足す。

### D9. 開き方

- **a（推奨・決定）**: クリック（タップ）だけで開く。
- b: ホバーでも開く（デスクトップのサイトに多い）。誤って開く・閉じる猶予の調整・タッチとの食い違いが増える。

### D10. 900px 以下

- **a（推奨・決定）**: ハンバーガーで既存のサイドバーのドロワーに戻す（§4.9）。
- b: 900px 以下でもメニューバーのまま（ほぼ全部が「その他」に入る）。
- c: ドックの 900px 以下と同じ下端のタブバー。項目が多いアプリでは入りきらない。

## 10. 派生アプリへの届け方

- **banto-hub・temp-scada**（自前の Sidebar とシェルを持つ）: 主に**経路 A**。`@banto/ui` のタグを上げ、
  自分のヘッダーに `HeaderNav` を置き、自分のナビ定義からグループと項目を渡す配線を書く（矢印の補助は `HeaderNav` に入っている。
  サイドバーのグループ見出し・ドックの区切り線（D8-b）は自前のサイドバーなら自分で足す）
  （`ShellMenubar` を手本にする）。切り替えの設定は自分のシェルに合わせて足す（設定キー
  `shell.navLayout` は汎用の保存なので、サーバーの変更は要らない）。
- **admin-template から作った派生アプリ**: **経路 A + B**。`@banto/ui` / `@banto/theme` のタグを上げ（A）、
  §5.2 のファイルの差分を手で取り込む（B）。scaffold のアンカーの対象のファイルなので、派生側で
  ヘッダーやレイアウトを変えていれば人が合わせる。デモ専用の項目への `group`（D7-b）は
  派生側の `navigation.ts` の行に当たるので、取り込みで衝突したら人が合わせる。
- **経路 C は無い**（DB・設定キーの追加なし。既存の `shell.navLayout` に値が増えるだけ）。
- CHANGELOG の未リリース節には「`@banto/ui` に `HeaderNav` を追加（A）」「ナビの表示形式にメニューバー、
  `NavItem.group`、サイドバーのグループ見出し・ドックの区切り線（B）」を分けて書く。upgrading.md には §10 の例 5（v6.8.0 のドック）と同じ形で、
  A と B の手順と「既定はサイドバーのまま。何もしなければ見た目は変わらない」を書く。

## 11. 委譲するときの注意（実装の指示に入れる）

- ファイルは grep で位置を探してから行の範囲を指定して読む（Header.svelte・Sidebar.svelte・scaffold.mjs・
  banto.css・Menu.svelte・設計書は丸ごと読まない）。
- テストは名前で絞って走らせ、全体は最後に 1 回。ビルド・テストの出力は `tail` / `grep` で絞る。
- `pnpm format:check` も回す。scaffold の 4 プリセットの `--dry-run` を確かめる。
- 部品の CSS に生値を書かない（§9。3px の下線は部品の形として許される）、`svelte` 以外を import しない（§5）、
  app の `.svelte` に生の日本語を書かない（§13）、`.svelte.ts` を足さない（§14）。
- charts の remover の文字列は `group` を付ける PR（PR-1）で必ず直し、4 プリセットの `--dry-run` で `/chart-gallery` の行が消えることを確かめる。
- 矢印の補助は `role="menubar"` / ロービング tabindex にしない（Tab で全項目に止まる）。
- ドロップダウンは `popover` で出す（glass のヘッダーの `backdrop-filter` の中で `position: fixed` がずれるため、§2.6）。
- 測定用の行に `<a>` やボタンを置かない（e2e の strict モードで二重に見つかる、§4.4）。
