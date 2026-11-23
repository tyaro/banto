# レシピ: 3 ペインを dock に並べる（`ThreePaneDock`）

[three-pane-screen.md](three-pane-screen.md) の「ツリー + 一覧/設定 + 詳細」を、`@banto/dock-svelte` の
`ThreePaneDock` に載せる。左右のペインを**浮かせる・別の場所にドッキングし直す・タブにまとめる・端に
自動で隠す**ことを利用者に許したい画面（GX Works3 のような配置、監視アプリの図面 + ツリー + 詳細）で使う。
**動く見本は `/tree/workspace-dock`**（`apps/admin-template/src/routes/(app)/tree/workspace-dock/`。
`/tree/workspace` の部品をそのまま載せている）。部品単体の API は
[packages/dock-svelte/README.md](../../packages/dock-svelte/README.md) の「3 ペインを dock に並べる」、設計は
[../design/three-pane-dock-plan.md](../design/three-pane-dock-plan.md)。

## `ThreePaneLayout` との使い分け

| 見たいこと                 | `ThreePaneLayout`（`@banto/ui`） | `ThreePaneDock`（`@banto/dock-svelte`）                                          |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| 利用者が配置を変える       | 幅の調節と左右の収納だけ         | 浮かせる・ドッキングし直す・タブ・自動で隠す。配置は利用者ごとに保存             |
| 狭い幅（≤ 900px）          | 左右がドロワー                   | dock の中の「狭い表示」（中央だけ。左右は端の帯で、引き出しがドロワーの代わり）  |
| 帯（タイトル・開閉ボタン） | あり                             | **無い**。名前はパネルのタイトルバー、開閉はアプリのツールバーと「表示」メニュー |
| 追加のパネル（ログ等）     | 無い                             | `panels` で足せる                                                                |
| 費用                       | 軽い                             | 保存と復元の配線が要る（下記）。`@banto/dock-svelte` を使う                      |

配置を利用者に任せる必要が無いなら `ThreePaneLayout` のままでよい。使う部品はアプリが画面ごとに選ぶ
（利用者がモードを切り替える口は無い）。中身の `Workspace*.svelte` は枠に依存しないので、枠だけ差し替えられる。

## 最小の使い方

```svelte
<script lang="ts">
	import { ThreePaneDock, createDockState } from '@banto/dock-svelte';

	const dock = createDockState();
	let three: ReturnType<typeof ThreePaneDock> | undefined = $state();
	let leftOpen = $state(true);
	let rightOpen = $state(true);
	const viewItems = $derived(three?.viewMenuItems({ resetLayout: '既定に戻す' }) ?? []);
</script>

<ThreePaneDock
	bind:this={three}
	{dock}
	bind:leftOpen
	bind:rightOpen
	messages={{
		threePaneLeft: () => 'ツリー',
		threePaneCenter: () => '作業',
		threePaneRight: () => '詳細'
	}}
>
	{#snippet left()}<Tree />{/snippet}
	{#snippet right()}<Detail />{/snippet}
	<Workspace />
</ThreePaneDock>
```

- 親の要素に**高さ**を与える（部品は幅・高さとも 100%）。`left` / `right` を渡さなければそのペインは無い。
- `leftWidth`（既定 280）・`rightWidth`（既定 360）は**既定レイアウトの初期幅 px**。測った幅の比率にして保存される。
- `leftOpen` / `rightOpen` は「表示」メニューのチェックと同じ 1 か所の状態（bind 用）。✕・メニュー・メソッドのどれで
  閉じても書き戻る。アプリが書き換えると `setVisible` と同じ依頼になり、`beforePanelChange` が断れば本当の状態に戻る。
  **マウント時の値がそのまま既定レイアウトの開閉**になる。
- 左右のペインを出し入れするツールバーのボタンは `three.toggle('left')` / `three.toggle('right')` を呼び、
  `aria-pressed={leftOpen}` で状態を示す（トグルの帯は出ない。見本の `+page.svelte`）。
- 操作の口は `bind:this` のメソッド（`isVisible`・`setVisible`・`toggle`・`float`・`dockBack`・`move`・`resetLayout`・
  `restoreLayout`・`layoutSnapshot`・`viewMenuItems`）。変更系（`setVisible`・`toggle`・`float`・`dockBack`・`move`・
  `resetLayout`・`restoreLayout`）は、表示から外れる・作り直されるなど確認が要るパネルに対して `beforePanelChange` を
  通す。状態の取得（`isVisible`・`layoutSnapshot`・`viewMenuItems`）は通さない。
- 「表示」メニュー: `viewMenuItems({ resetLayout })` は `{ kind, id, label, checked?, onSelect }` の素の配列
  （左・右・追加パネルのチェック、区切り、「既定に戻す」）。見本はこれを `PageViewMenu` に渡し、`reset-layout` の
  `onSelect` だけ自前（`resetLayout()` の結果を保存に反映する）に差し替えている。`$derived` の中で呼ぶ。
  「既定に戻す」に確認は出ない（失うのは配置だけ）。
- 中央（`children`）はメイン区画: 閉じない・畳まない・自動で隠さない・浮かせない・別のタブの組に入れない。
  保存値でそうなっていても復元で直る。

## レイアウトの保存

保存はアプリの仕事（部品は永続化を持たない）。**保存する値は `three.layoutSnapshot()`**
（`{ schema: 1, panels, layout }`）で、**`dock.serialize()` ではない**（狭い表示のあいだ `dock.layout` は一時の
レイアウトで、`layoutSnapshot()` は控えた本来の配置を返す）。

- 最初の描画の値は `initialLayout` に渡す（マウント時に 1 回だけ読む）。マウント後に届いた値（設定 DB の読み込み後）は
  `three.restoreLayout(saved)`。どちらも今のパネルの集合と照らされ、壊れた値は既定、知らない id は捨てる。
- 保存の部品は `@banto/dock-svelte` にある（#791）。見本は `createDockLayoutStore`（ダッシュボードと同じ部品）に
  `createThreePaneLayoutTarget`（`ThreePaneDock` を載せる薄い変換）を挟んで保存している:
  設定のキーは `dock.threePane.<画面キー>`（利用者ごと・画面ごとに 1 つ）、500ms の debounce、localStorage の写しは
  最初の描画だけに使う。**`scope: currentSessionScope()`・`isCurrent: isCurrentSessionScope` を渡すと、写しと provider の
  結果が利用者（セッション）に結び付く**: ログアウト・別の利用者に替わったあとに届いた読み込みや書き込みは捨てるので、
  前の利用者の配置が別の人に出ない（ログインの無いアプリは渡さなくてよい）。見本の配線を写して画面キーだけ替える。

  ```ts
  const layoutTarget = createThreePaneLayoutTarget(dock, () => three);
  const layoutStore = createDockLayoutStore({
  	dock: layoutTarget,
  	storageKey: 'banto.dock.threePane.<画面キー>',
  	settingKey: 'dock.threePane.<画面キー>',
  	provider: getUiSettings,
  	scope: currentSessionScope(),
  	isCurrent: isCurrentSessionScope,
  	defaultLayout: () => layoutTarget.defaultLayout
  });
  let restoreStatus: string | undefined; // `onRestore` が知らせた値（`beforeBaseline` を使わないなら省いてよい）
  $effect(() => {
  	if (!three) return;
  	untrack(() => {
  		layoutTarget.attach(restoreStatus);
  		void layoutStore.load();
  	});
  });
  $effect(() => () => layoutStore.dispose());
  // <ThreePaneDock bind:this={three} {dock} initialLayout={layoutTarget.initialLayout}
  //   onLayoutCommit={layoutStore.commit} onRestore={(status) => (restoreStatus = status)} ... />
  ```

- 保存のきっかけは `ThreePaneDock` の `onLayoutCommit(saved, reason)`（#791）。保存してよい配置が確定したときだけ
  届く（ドラッグの途中・狭い ⇄ 広いの切り替えの途中・復元では届かない）。`layoutStore.commit` をそのまま渡す。
  `'reset'`（「レイアウトを既定に戻す」が適用された）は既定を保存する（`reset: 'remove'` を渡すと保存を消す）。
  `$effect` で `layoutSnapshot()` を読む形は要らない。細かい約束は `@banto/dock-svelte` の README
  「保存してよい配置の確定」「配置の保存」。
- 一覧の「ビュー」（絞り込み・並び）には入れない。ビューは何を見るか、レイアウトはどう並べるか。

## 狭い表示・`arrange={false}`・touch

- **狭い表示**: 部品自身の幅が `narrowBreakpoint`（既定 900）以下、または `narrowOverride` が `true` のとき（`false` なら幅に関係なく広い表示）、保存済みの
  配置には触れずに一時のレイアウトで見せる。中央だけがドッキングされ、見えていた左右は端の帯になり、帯を押すと
  引き出し（flyout）が開く。浮動と追加パネルは隠れ、「表示」メニューで選ぶと帯から開く。狭いあいだの操作は保存しない
  （`layoutSnapshot()` は控えた配置）。幅が戻れば元の配置に戻る。今の表示は `bind:narrow`（読み取り専用）で読める。
  見本は、行を選んだら狭いときだけ `three.setVisible('right', true)` で詳細を引き出している。
- **`arrange={false}`**（キオスク）: 保存済みの配置を見せるだけで、組み替えられない。ドラッグ・浮かせる・✕・ピン・分割線・
  メニュー（「表示」と「パネルの操作」）が消え、`setVisible`・`toggle`・`float`・`dockBack`・`move`・`resetLayout` は
  何も変えずに断る（`viewMenuItems` は空）。`restoreLayout` と狭い表示への切り替えは効く。タブの切り替えや、帯に
  隠れたパネルを引き出すのは許す。見本は `settings.kiosk` から `arrange` を決め、ツールバーも出さない。
  kiosk で配置を変えたいときは、管理者が通常の画面で整えて保存する。
- **touch**: モードは変わらない。タイトルバーのボタンとドッキングのガイドのボタンの大きさは `@banto/theme` の密度
  （`data-banto-density="touch"`）のトークン `--banto-dock-button-size` / `--banto-dock-guide-button-size` に従う。
  アプリが渡すものは無い。

## 中央の据え置き（`persistent`）

中央は**据え置き**: 中身を木の外で 1 回だけ描き、受け皿へ DOM ごと移す。組み替え・浮動・自動で隠す・狭い表示の
切り替えのどれでも作り直さないので、キャンバスの描画キャッシュ・ズーム・選択・下書きが残る。

- DOM を動かす（`appendChild`）ので、**フォーカスとスクロール位置は記録して戻す**（動かす前に記録し、移したあとに戻す。
  別の所へ動いていたフォーカスは奪わない）。
- **`iframe` は移るたびに文書を読み直す**（ブラウザの仕様で、部品では防げない）。中央に `iframe`・ネイティブの埋め込みを
  置くアプリは、組み替えのたびに読み直されると承知しておく。
- 左右と追加パネルは既定では据え置きにしない（作り直される。状態はページが持つ）。作り直されて困るなら
  `persistent={(id) => id === 'log'}` のように選ぶ。

## キーボードだけでの操作

docked のパネルのタイトルバー（浮動はそのウィンドウのバー）の「パネルの操作」ボタン（⋯）から、Enter / Space / ↓ で
メニューを開く。「左端に／右端に／上端に／下端にドッキング」「〇〇とタブにまとめる」「〇〇の隣にドッキング」「浮かせる」
「元の場所に戻す」が選べる（ポインタの利用者のドラッグの代わりにもなる）。↑ ↓・Home / End で移り、Enter で選び、
Esc で閉じる。結果は `aria-live` で読み上げられる。移動のショートカットキーは無い。浮動ウィンドウの移動・大きさ変更と
分割線のリサイズには、それぞれのキー操作がある（[dock-svelte の README](../../packages/dock-svelte/README.md)）。
中央は `move: false` なので「パネルの操作」ボタンが出ない。

## 例: ツリー + 一覧 + 詳細（temp-scada のような監視アプリ）

- 左 = 設備・系統のツリー（`BantoTree`、[tree-svelte.md](tree-svelte.md)）、中央 = 図面のキャンバスか一覧と設定のタブ、
  右 = 選んだ要素の詳細、`panels` にアラームやログ（`initial: { edge: 'bottom' }`）。
- 選択・タブ・行の状態は**ページが持つ**（URL が一次情報、[three-pane-screen.md](three-pane-screen.md) の「状態はページが持つ」）。
  ペインを閉じる・浮かせる・動かすことで下書きは消えず、未保存の確認はペインの操作では出さない（出すのは別の対象・タブ・
  ページへ移るとき）。ペインが自分で入力を持つなら `beforePanelChange` で下書きを控える。
- ツリーで選んでもペインの配置は変わらない。狭い表示でツリーの引き出しを閉じたいときは `dock.closeFlyout()`
  （見本は対象の変更に追従して閉じる）。

## scaffold で外す・自分のアプリへ

- `pnpm scaffold` でツリーを外す（`minimal` / `standard`）とルートごと消える。dock だけ外すときは、`removeDock` が
  `workspace-dock/` と、`/tree` の索引の「dock 版」リンクとその文言を外す
  （手順は [remove-optional-assets.md](remove-optional-assets.md)）。固定版の `/tree/workspace` は残る。
- 自分のアプリへは、`workspace-dock/` を手本にコピーし、`Workspace*.svelte` を
  自分の部品に、画面キー（`DOCK_STORAGE_KEY`・`DOCK_SETTING_KEY`）と文言キーを置き換える。依存は
  `"@banto/dock-svelte": "workspace:*"`（外部リポジトリなら [consume-as-git-dependency.md](consume-as-git-dependency.md)）。
