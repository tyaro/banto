# レシピ: 3 ペインの画面の型（ツリー + 一覧/設定タブ + 詳細）

「左のツリーで**対象**を選び、中央のタブ（**一覧**・**設定**）で作業し、右に選んだ行の**詳細**を出す」
画面の組み方。ライン／設備、フォルダ／ファイル、組織／メンバーのように、対象の階層があって、
対象ごとに一覧と設定を持つアプリで使う。**動く見本は `/tree/workspace`**
（`apps/admin-template/src/routes/(app)/tree/workspace/`。`/tree` のデモに含まれ、
`pnpm scaffold` でツリーデモを外すと一緒に消える）。

## 役割分担

| 場所                   | 役割                                                       | 部品                                                                    |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| メニューバー（ヘッダ） | **機能**（どの画面を開くか）。対象の選択はここに置かない   | アプリシェル（`HeaderNav`）                                             |
| 左ペイン               | **対象**の選択                                             | `BantoTree`（`@banto/tree-svelte`）                                     |
| 中央                   | 選んだ対象への作業。固定の 2 タブ「一覧」「設定」          | `Tabs`（`@banto/ui`）                                                   |
| 右ペイン               | **一覧で選んだ行**の詳細（未選択は空の表示）。補助は右だけ | 自前（例: `WorkspaceDetail.svelte`）                                    |
| 帯（中央の上）         | 選択中の対象名・左右ペインの開閉ボタン                     | `ThreePaneLayout`（`@banto/ui`、[README](../../packages/ui/README.md)） |

枠 `ThreePaneLayout` はレイアウトだけを持つ（左右の幅の調節と収納、枠自身の幅が 900px 以下で左右が
ドロワーになる）。中身はスニペットで渡す。

枠を外から扱う口（`onToggle`・`leftToggleEl`／`rightToggleEl`・`leftOpen`／`rightOpen`・
`rightDrawerModal`・`narrowOverride`、`data-three-pane-scrim`）は任意で、渡さなければ上の挙動のまま。
右ペインを「選んだときだけ出す」なら `right` を `undefined` にせず `rightOpen` で出し入れする
（帯のボタンで畳んだ状態 `rightCollapsed` は、出し入れで変わらない）。編集中も一覧とツリーを触れる右ペインは
`rightDrawerModal={false}`（Esc で閉じるのはフォーカスがドロワーの中にあるときだけ）、狭い幅の境をビューポートに合わせたいときは `narrowOverride` を使う。
`rightOpen` を `false` にしたとき、フォーカスがペインの中にあると `body` に落ちる。戻し先はアプリが決める（閉じたら一覧の選択行へ `focus()` など）。
詳細は [README](../../packages/ui/README.md) の ThreePaneLayout の節。

## 状態はページが持つ（URL が一次情報）

選んだ対象・タブ・行は URL の `?target=<id>&tab=list|settings&row=<id>` に持つ。再読み込み・
戻る/進む・リンクの共有で同じ画面に戻れる。見本の規則は `workspaceUrl.ts`（**純関数**で、
ルーターにも DOM にも触れず、`workspaceUrl.test.ts` で端の値を押さえている）:

- 不正な `tab`（欠落・大文字違い）は既定の `list`。存在しない `target` は未選択。同じキーが複数あれば最初の値。
- 対象がなければタブは `list`・行は無し。`row` は選んだ対象の一覧にある行だけ採り、設定タブでは持たない。
- 既定値（`tab=list`・行なし）は URL に出さない。
- 履歴: **対象の変更は push、タブと行の変更は replace**（戻るで対象を 1 つずつ辿れる）。

変更はすべて `goto(...)`（`replace`・`reset: false`）で行い、ページは `page.url` から状態を導く。
**SvelteKit の shallow `replaceState`／`pushState` は `page.url` を更新しない**ので、URL を状態の
一次情報にするなら `goto` を使う（shallow を使うなら `window.location` から読む）。

## 未保存の変更の確認

設定タブに未保存の変更があるとき、**タブの切り替え・ツリーでの別の対象の選択・戻る/進む・別ページへの
遷移**で `ConfirmDialog`（`confirmAction`）を出す。

- キャンセル（「編集に戻る」）: 何も変わらない。URL・ツリーの強調・タブ・下書きに加えて**フォーカスも**
  表示中の側へ戻す（クリックした行・タブに残さない）。ツリーは `selection` prop（後述）で強調を
  ホストの状態に固定している。
- 破棄して移動: 下書きを捨てて続行。
- 再読み込み・タブを閉じる・デスクトップのウィンドウを閉じる: ブラウザ既定（`beforeunload`）／
  ウィンドウ閉じのガード。`@banto/forms` の `guardUnsavedChanges`（レジストリ）を併用し、
  アプリ内の移動だけを自前の `beforeNavigate` でダイアログに置き換える。
- 落とし穴: ルートの `ConfirmHost` は自身の `beforeNavigate` で開いている質問を「キャンセル」
  にする。ページの `beforeNavigate` から同期的に質問を出すと同じ遷移の中で打ち消されるので、
  `navigation.cancel()` のあと**1 マイクロタスク待ってから**出す。

## ツリーの `selection`（ホスト主導の選択）

`BantoTree` の `selected` は初期値だけで、クリックすると内部の選択が動く。「拒否されたら元に戻す」
「URL に追従する」ページは `selection`（`NodeId[]`）を渡す。クリック・キーは `onSelectionChange` で
通知されるだけで、強調は常に `selection` に従う（ホストが更新すれば動き、更新しなければ戻る。
ロービングの tabindex も追従）。省略すれば従来どおり。

## 右クリックメニュー

`onContextMenu` で受けた位置に `Menu` を出すには、`position: fixed` の幅 0 のボタンを `Menu` の
`trigger` にして、その位置に置いてから `click()` する（見本の `WorkspaceTree.svelte`）。
メニューが開いている間の再度の右クリックは、光る閉じ（light dismiss）の `toggle` イベントが
`Menu` に届くのを待ってからでないと開き直せない。メニューが閉じたらフォーカスは行へ戻す。

## 狭い幅（900px 以下）

枠自身の幅（ビューポートではない）が 900px 以下だと左・右ペインはドロワーになる。開いたドロワーはモーダルのダイアログで、ペインの外（枠の外のヘッダーやサイドバーも）は操作できない（#1055。上端の ✕・Esc・背景のクリックで閉じる。✕ の文言は `messages` の `overlayClose`）。ツリーを選んだあとに
ドロワーを閉じる場合は、**選択が実際に反映された（URL が変わった）あと**に閉じる（確認でキャンセル
されたら開いたまま）。確認ダイアログはドロワーの上に出る。帯には選択中の対象名が残る。
行を選んだら右ドロワーを開く（見本は狭い幅のときだけ）。

## ドッキング可能なパネルへ

各ペインの中身（`WorkspaceTree` / `WorkspaceList` / `WorkspaceSettings` / `WorkspaceDetail`）は
**枠に依存しない独立した部品**にしてある（`ThreePaneLayout` の context も型も使わず、状態は
プロップで受けてイベントで返す）。状態を持つのはページだけ。これは、GX Works3 のように各ペインを
自由に配置できるパネルにする将来（`@banto/dock-svelte` の初期レイアウト 左・中央・右に同じ部品を
並べるモード）のため。新しい画面でもこの分け方を保つと、枠の差し替えで済む。
**実装済み**: 並べ方・保存・狭い表示は [three-pane-dock.md](three-pane-dock.md)（見本 `/tree/workspace-dock`）。

## 作り方（自分のアプリへ）

1. `routes/(app)/tree/workspace/` を手本にコピーし、`workspaceSample.ts` を自分のデータ（DataProvider）に
   置き換える。文言は `messages/{ja,en}.json` の `tree.workspace.*` を自分のキーへ。
2. `workspaceUrl.ts` の `WorkspaceLookup`（対象・行の実在判定）だけデータ側に合わせる。
3. 設定の保存先（見本はページ内のメモリ）と、保存済みの比較（`settingsEqual`）を実データに合わせる。
