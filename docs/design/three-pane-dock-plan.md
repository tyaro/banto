# 3 ペインを dock に並べるモード 計画書

作成日: 2026-11-19
状態: **実装中**。PR-2（キーボードでの移動）を実装（#720）。PR-1 は #719 で並行中、残りは PR-3 以降。§8 の要確認は 2026-11-19 に推奨どおりで決定（§9）。
トラック: 保守者向け（トラックA）
Issue: [#663](https://github.com/tyaro/banto/issues/663) の段階 ④（①〜③ = #664・#665・#667・#672〜#674、穴埋め = #681・#683・#686・#687、ドッキングの操作 = #694）
関連: [shared-primitives-upstream-plan.md](shared-primitives-upstream-plan.md)（§3.3 gesture と keyboard、§3.5 `beforePanelChange`）、
[nav-menubar-plan.md](nav-menubar-plan.md)（メニューバーと「表示」メニューの置き場）、
[display-preset-plan.md](display-preset-plan.md)（kiosk）、[scaffold-presets-plan.md](scaffold-presets-plan.md)、
[ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui`）、
conventions §4 / §5 / §8 / §9 / §10 / §13 / §14、template-scope §3

## 1. 目的と範囲

#631 で 3 ペインの画面（左 = 対象を選ぶツリー、中央 = タブの作業、右 = 選んだ行の詳細）を固定の枠
`ThreePaneLayout`（`@banto/ui`）として用意した。この計画は、**同じ中身を `@banto/dock-svelte` の
`DockHost` の上に並べるモード**を足す。利用者は各ペインを浮かせ、別の場所にドッキングし直し、
3 ペイン以外のパネル（例: ログ）も開ける。固定の `ThreePaneLayout` は残し、どちらを使うかはアプリが選ぶ。

下流の temp-scada（中央に図面のキャンバスを持つ監視アプリ）の要望を受け入れ条件に入れる（§6）。

範囲に入れるもの: dock 版の部品と API、中央を再マウントしない仕組み、レイアウトの保存と既定へ戻す、
狭い幅・kiosk・touch の振る舞い、キーボードだけでの移動と読み上げ、未保存の確認との関係、
「表示」メニューとツールバーからの操作、テンプレートのデモ、scaffold での削除。

範囲に入れないもの: ネイティブ窓への pop-out（ダッシュボードの `onPopOut`）を 3 ペインに広げること
（ページが持つ下書きを別の窓へ渡す仕組みが無いので、別 Issue）。共有のレイアウト（全員で同じ配置）。

## 2. いまあるもの（2026-11-19 の main で確認）

| 何 | どこ | この計画との関係 |
| --- | --- | --- |
| 固定の 3 ペイン | `packages/ui/src/ThreePaneLayout.svelte`・`threePane.ts`（`ThreePaneLayoutProps`、`narrowBreakpoint` 既定 900） | props の名前を dock 版でもそろえる（§4.1） |
| 3 ペインのデモ | `apps/admin-template/src/routes/(app)/tree/workspace/`（`Workspace*.svelte` は枠を知らない。状態・下書きはすべて `+page.svelte` が持つ） | dock 版のデモはこの部品を使い回す（PR-6） |
| 未保存の確認 | 同 `+page.svelte`（`beforeNavigate` + `confirmAction`、`guardUnsavedChanges`） | ペインの開閉・移動では下書きが消えない根拠（§4.7） |
| ドック | `packages/dock-svelte`（`DockHost`・`DockState`・`capabilities`・`beforePanelChange`・`keepMounted`・auto-hide・`isLocked`/`setLocked`・`setPanelVisible`） | 土台。足りないのは §3 の 3 つ |
| 再マウントの扱い | `core/lifecycle.ts` の `DockPanelChange`（`dock`/`undock`/`move-docked`/`auto-hide`/`reparent`/`tab-switch`/`hide`/`close`）。`keepMounted` は「タブの切り替え・浮動の非表示」だけを守り、ドッキング ⇔ 浮動の移動は再マウントする | 中央のキャンバスの要望（§4.2） |
| 主領域 | `core/autohide.ts` の `mainRegionId`（`move`・`undock`・`close` がすべて `false` のペインの領域） | 中央をこの「主領域」にする |
| 「表示」メニュー | `apps/admin-template/src/lib/pageViewMenu.svelte.ts`（ページが中身を渡し、シェルが置き場を決める）。ダッシュボードが `dock.panels` からチェック項目と「レイアウトを既定に戻す」を作っている | 3 ペインでも同じ形で渡す（§4.8） |
| レイアウトの保存 | ダッシュボードの `+page.svelte`: localStorage（最初の描画用）+ `UiSettingsProvider` の `dock.dashboard`（ユーザーごと、#707 でキーごとに直列化済み） | 共通の小さな部品に出して使い回す（PR-5） |
| 下書きの守り | `lib/banto/dashboardMemo.svelte.ts` の `createPanelChangeHandler`（close だけ確かめ、ほかは capture） | ペインが自分で入力を持つ場合の型（§4.7） |
| scaffold | `scripts/scaffold.mjs`: `dock` と `tree` は別々の資産。minimal / display は両方、standard は `tree` を消す。対話モードでは片方だけ消せる | dock 版のデモはどちらを消しても消える場所に置く（§4.10） |

## 3. 制約（不変条件から）

- **パッケージどうしは import しない**（conventions §4「パッケージ間の `from '@banto/...'` import はゼロ」、§5）。
  `@banto/ui`（コア）の `ThreePaneLayout` は `@banto/dock-svelte`（オプション）を使えないし、逆も
  しない。だから「1 つの部品に `mode` を渡して切り替える」形はパッケージの中では作れない。
  切り替えるのはアプリの層（§4.1・§4.3）。
- **`apps/admin-template/src/lib/resource/` はオプションを import しない**（§4 rule `resource-no-optional`）。
  dock 版の配線は `lib/resource/` に置かない。
- **環境分岐は配線の層だけ**（§10）。dock 版の部品は Tauri / server / demo を知らない。保存先
  （`UiSettingsProvider`）はアプリが注入する。
- 生の値は theme のトークンだけ（§9）、文言は注入（パッケージの layer 1、アプリは Paraglide、§13）、
  `.svelte.ts` は dev optimizer から除外済み（§14、`@banto/dock-svelte` は `vite.config.ts` に載っている）。
- runes の落とし穴（§8）: 保存の `$effect` は `dock.serialize()` だけに依存させる（ダッシュボードと同じ）。

## 4. 設計

### 4.1 公開 API の形

案:

- (a) `ThreePaneLayout` に `mode="dock"` を足す → §3 の理由で不可。
- (b) **`@banto/dock-svelte` に別部品 `ThreePaneDock` を足し、`ThreePaneLayout` と意味が同じ props は同じ名前にする**。
- (c) アプリの層（`apps/admin-template`）にだけ作る → temp-scada などの下流が使い回せない（アプリの層は
  scaffold でコピーされたあとは各アプリの持ち物になり、パッケージのように git タグで更新されない）。

**推奨: (b)**。そろえる props と、そろえない props:

| props | `ThreePaneLayout` | `ThreePaneDock` |
| --- | --- | --- |
| `left` / `right` / `children`（snippet） | 同じ | 同じ（中央 = `children`） |
| `leftOpen` / `rightOpen`（bindable） | ペインがあるか | パネルが見えているか（「表示」メニューのチェックと同じ 1 か所の状態） |
| `leftWidth` / `rightWidth` | 幅 px | **既定レイアウトの**初期幅 px（測ったあと比率に直す。保存されるのは比率） |
| `narrowBreakpoint` / `narrow`（出力） | 同じ | 同じ（§4.5） |
| `messages` | `UiMessages` | `DockMessages` + 3 ペインの名前（`threePaneLeft` 等）。アプリが同じキーを両方に渡せる |
| `title` / `titleContent`、`*Collapsed`、`*Drawer*` | あり | **無し**（帯を出さない。名前はパネルのタイトルバー、対象名はページ見出しに出す） |
| `dock`（`DockState`）、`panels`（§4.9）、`capabilities`・`beforePanelChange`・`isEscapeBlocked` 等 | 無し | あり（`DockHost` へそのまま渡す） |
| `arrange`（§4.5） | 無し | `false` = 組み替え不可 |

操作の口は `bind:this` で得る部品のメソッド（`DockHost` の `setPanelVisible` と同じ流儀）:
`isVisible(id)` / `setVisible(id, v)` / `toggle(id)` / `float(id)` / `dockBack(id)` / `move(id, target)` /
`resetLayout()` / `viewMenuItems(labels)`。いずれも `beforePanelChange` を通る（`DockState` を直接いじる
抜け道を作らない）。`viewMenuItems` は `{ kind: 'checkbox' | 'action' | 'separator', id, label, checked?, onSelect }`
の素の配列を返す（`@banto/ui` の `HeaderNavMenuItem` と構造で互換。型は import しない）。

既定レイアウトは純関数 `threePaneDockLayout({ hostWidth, leftWidth, rightWidth, panels })` で作る
（単体テストできる・`resetLayout` と復元の失敗時に同じものを使う）。

### 4.2 中央を組み替えで再マウントしない（temp-scada）

いまは、ユーザーが左ペインを浮かせるだけで木の形が変わり、中央は `reparent`（`remount: true`）で
作り直される。キャンバス（描画のキャッシュ・ズーム・選択。将来の利用例では WebGL の文脈も）にとっては致命的。
temp-scada の現行の中央は SVG（`CanvasWorkspace` → `Renderer`）で、`iframe`・ネイティブの埋め込みは無い（2026-11-19 確認、§9 Q9）。

| 手段 | 守れる範囲 | 費用・弱点 |
| --- | --- | --- |
| A. 中央を `capabilities` で `move`/`undock`/`close`/`dropCenter` 禁止（主領域にする） | 中央を**動かす**操作は消える | 周りが動くと `reparent` で再マウントする。**単独では要望を満たさない** |
| B. 木の形の不変条件（中央は常に根の split の直下）を `normalize` で守る | 一部の組み替え | 外周へのドッキング（`dockPanelAtEdge`）は根を包み直すので崩れる。木の操作すべてに例外が入り脆い |
| C. **中央を DOM ごと預かる「据え置き」**: `DockHost` が該当パネルの snippet を木の外の預かり場所に 1 回だけ描き、木の中のパネルは空の受け皿だけ持つ。受け皿が mount されたら `{@attach}` で預かりの DOM 要素を `appendChild` で移す（外れたら預かりへ戻す） | 木の組み替え・ドッキング ⇔ 浮動・auto-hide・タブ切り替え・狭い幅の表示（§4.5）すべて | DOM の移動でフォーカスとスクロール位置が落ちる → 移す前に記録し、移したあとに戻す。`iframe` は移動で読み直す（文書に明記）。Svelte のコンポーネントは預かり側にいるので状態は残る |
| D. 中央を木の外の固定の層に描き、受け皿の矩形に `ResizeObserver` で重ねる | すべて | 浮動ウィンドウ・flyout との重なり順、1 フレームの遅れ、受け皿が隠れたときのクリックの抜け。見た目の不具合を作りやすい |

**推奨: A + C**。`DockHost` に `persistent?: (panelId) => boolean` を足し（`keepMounted` の上位互換。
`keepMounted` は残す）、`ThreePaneDock` は中央を既定で `persistent`、`capabilities` で主領域にする。
左右は既定で `persistent` にしない（中身は軽く、状態はページが持つ）。アプリが望めば
`persistent` を左右・追加パネルにも広げられる。

### 4.3 モードの切り替え（Issue の決めること 1）

案: (a) アプリが画面ごとに決める（使う部品を選ぶ）／(b) 利用者の操作（「表示」メニューの
「パネルを自由に配置」など）でも切り替えられる。

**推奨: (a) を既定、(b) はアプリが選んだときだけ出す口として後回し（PR-8、要確認 Q1）**。
切り替えは部品の差し替えなので中身はすべて再マウントする（下書きはページが持つので消えない。§4.7）。
(b) を作るなら、モードは `UiSettingsProvider` に画面ごと（`threePane.mode.<画面キー>`）に保存し、
`ThreePaneLayout` と `ThreePaneDock` の両方をアプリの層の小さなラッパー（§4.10 のデモのルート内）で選ぶ。

### 4.4 レイアウトの保存先と既定へ戻す（同 2）

- **保存先はユーザー設定（`UiSettingsProvider`）、画面ごとに 1 キー**（`dock.threePane.<画面キー>`）。
  最初の描画は localStorage の写しで出し、マウント後に provider と突き合わせる（ダッシュボードの M12 と同じ。
  書き込みは debounce、#707 でキーごとに直列化済み）。この仕組みはダッシュボードから
  `lib/banto/dockLayoutStore.svelte.ts` に出して共有する（PR-5）。
- 一覧の「ビュー」（`lib/resource/listViews.ts`、絞り込み・並び）には**入れない**。ビューは「何を見るか」、
  レイアウトは「どう並べるか」で、切り替えの単位が違う（ビューを変えるたびにパネルが動くのは不自然）。
  → 要確認 Q2。
- 保存する値: `{ schema: 1, panels: string[], layout: <DockState.serialize()> }`。復元のときは
  `validateDockLayout` に通し、**今のパネルの集合と照らし合わせる**: 知らない id は捨て、足りない
  パネルは既定の位置（追加パネルは閉じた浮動）に足し、中央が無い・壊れている値は既定に戻す
  （純関数 `reconcileThreePaneLayout`、単体テスト）。ピン（固定）・折りたたみ・auto-hide はレイアウトに含む。
- **保存値は利用者（セッション）に結び付ける**（クロスレビュー P2）。今のダッシュボードの方式（固定キーの localStorage、
  debounce の実行時に provider を呼ぶ）をそのまま共通化しない:
  - localStorage の写しは、利用者が確定してからその利用者のキー（`…:<userId>`）でだけ読み書きする。利用者が
    確定する前・ログイン不要モードで利用者が無いときは写しを使わず既定で描く（写しは省略してよい）。
  - provider の読み込み結果・debounce 中の書き込み・unmount 時の flush は、取得した時点のセッションの世代
    （`getSessionRevision`、#707 と同じ）を控え、世代が替わっていたら捨てる。前の利用者の配置を、設定の無い
    別の利用者に見せない・土台にして保存しない。
  - provider が `null`・エラーのときは既定に戻す（前の利用者の写しで代用しない）。
- 既定へ戻す: 「表示」メニューの「レイアウトを既定に戻す」（ダッシュボードと同じ文言キー）と
  `resetLayout()`。開いているパネル・浮動の位置・固定もすべて既定に戻す。確認は出さない（元に戻せる操作は
  無いが、失うのは配置だけ）→ 要確認 Q3。

### 4.5 狭い幅・kiosk・touch（同 3）

- **狭い幅（部品自身の幅 ≤ `narrowBreakpoint`、既定 900）**: 案 (a) アプリが `ThreePaneLayout` に
  差し替える（中央は再マウント = temp-scada の条件に反する）、(b) **`ThreePaneDock` の中で「狭い表示」に切り替える**:
  保存済みのレイアウトには触れず、一時的なレイアウトで表示する — 中央だけドッキング、左右は端の
  auto-hide の帯（flyout が引き出しの代わり）、浮動と追加パネルは隠し、「表示」メニューから選ぶと flyout で開く。
  狭い表示の間の操作は保存しない。幅が戻れば保存済みの配置に戻る。**推奨 (b)**（中央は §4.2 の据え置きで残る）。
- **kiosk**（`settings.kiosk`）: 操作員に配置を崩させない。**推奨: `arrange={false}`**（保存済みの配置で表示し、
  ドラッグ・浮かせる・✕・ピン・既定へ戻すを出さない。`capabilities` を全パネルで `move`/`undock`/`close` 禁止にするのと同じ）。
  kiosk で配置を変えたいときは管理者が通常の画面で整えて保存する → 要確認 Q4。
  `capabilities` の `move`/`undock`/`close` だけでは止まらない操作があるので、`arrange={false}` で止めるものを明記する（クロスレビュー P2）:

  | 操作 | kiosk |
  | --- | --- |
  | 分割線のリサイズ（ポインタ・キーボード） | 禁止 |
  | 浮動ウィンドウの移動・リサイズ（ポインタ・キーボード） | 禁止（全パネルを錠＝`locked` と同じ扱い） |
  | 折りたたみ・auto-hide（ピン）の切り替え | 禁止（保存済みの状態のまま） |
  | ドラッグでのドッキング・浮かせる・✕・タブの出し入れ | 禁止 |
  | 「パネルの操作」メニュー・「表示」メニューの開閉・「既定に戻す」 | 出さない |
  | 部品のメソッド（`toggle`・`float`・`dockBack`・`move`・`resetLayout`） | 拒否して状態を変えない（アプリのツールバーからも崩せない） |
  | タブの切り替え・前面化・auto-hide 済みのパネルの引き出し | 許す（見るための操作） |
- **touch 密度**: モードは変えない。ドッキングのガイドのボタン・タイトルバーのボタンの大きさを
  密度のトークンから取る（`guideButtonSize` の最小値を touch で引き上げる）。ドラッグは pointer events なので
  そのまま動く。長押しなどの専用の操作は作らない。

### 4.6 キーボードだけでの操作と読み上げ（同 4。#694 の拾い残し）

いまキーボードでできるのは、浮動の移動・大きさ（`DockWindow` の move/resize モード）、分割線（Window Splitter）、
タブの切り替え、✕・ピン。**ドッキング先を変える口が無い**。

- **推奨: パネルのタイトルバー（ドッキング中は領域の見出し）に「パネルの操作」メニューのボタンを足す**。
  中身: 「左に／右に／上に／下にドッキング」（外周）、「〇〇とタブにまとめる」（ほかのパネルの一覧）、
  「浮かせる」、「元の場所に戻す」（`dockSlot`）、「固定」、「折りたたみ」、「閉じる」。
  ポインタの利用者にも同じメニューが役に立つ（ドラッグの代わり）。メニューは `@banto/ui` の `Menu` を使えないので
  （§3）dock-svelte の中に最小の menu button（WAI-ARIA の menu button パターン）を持つ。
- `DockHost` に `movePanel(panelId, target)`（`target` = `{ edge }` | `{ tabWith }` | `{ float }` | `{ back }`）を
  足して export し、メニューと `ThreePaneDock.move` はこれを通す（`beforePanelChange` が効く）。
- 移動のあとのフォーカス: 動かしたパネルのタイトルバー（タブ）へ置く。拒否・中断のときはメニューのボタンへ戻す。
- 読み上げ: `DockHost` に `aria-live="polite"` の領域を 1 つ持ち、結果を文で知らせる（例「ツリーを左にドッキングしました」
  「ツリーを浮かせました」「閉じました」「変更は取り消されました」）。文言は `DockMessages` に足す（layer 1）。
- ショートカット（例 Alt+Shift+矢印）は作らない → 要確認 Q5。

### 4.7 未保存の確認（同 5）

- #631 の方針どおり**中身の状態（下書き含む）はページが持ち、ペインは表示だけ**。だからペインを閉じる・
  浮かせる・動かすことで下書きは消えない。`/tree/workspace` の確認（ほかの対象・タブ・ページへ移るとき）は
  そのまま効き、パネル操作では**確認を出さない**のが推奨（出すと、見た目を変えるだけの操作で毎回止まる）。
- 再マウントで失うのは、フォーカス・スクロール・IME の変換中の文字。IME は `DockHost` の既定
  （`isStructureChangeDeferred` = 変換中は保留）で守られる。中央は据え置き（§4.2）で全部残る。
- 中央は閉じられない（主領域）ので、「設定」タブの保存ボタンが見えなくなることは無い。そのために中央は
  `close` に加えて**折りたたみ・auto-hide も禁止**（`autoHide: false`）にし、浮かせない（`undock` 禁止）。
  既定の配置だけでなく、**復元した保存値**（`reconcileThreePaneLayout`）でも中央が閉じている・畳まれている・
  auto-hide の帯にいる・浮いているなら、中央をドッキングして開いた状態に直す（クロスレビュー P2）。
- **ペインが自分で入力を持つ場合**（アプリの追加パネルなど）: `beforePanelChange` にダッシュボードの
  `createPanelChangeHandler` の型（close は settle してから、ほかは capture）を渡す。`ThreePaneDock` はそのまま
  `DockHost` に渡すだけ。README にこの使い分けを書く。

### 4.8 「表示」メニューとツールバー（temp-scada）

- ページは `viewMenuItems()` の結果を `PageViewMenuDef` にして渡す（ダッシュボードと同じ）。並び:
  左・中央（チェック不可＝出さない）・右・追加パネル、区切り、「レイアウトを既定に戻す」。チェックの状態は
  `dock.panels` の `visible` から読む（拒否・中断のあとも本当の状態を示す）。閉じたパネルは前回の位置へ戻る（#694 で確認済み）。
- **トグルの帯は出さない**。アプリは自分のツールバーのボタンから `toggle('left')` などを呼び、
  `leftOpen`/`rightOpen` を bind して押された状態を表示する。

### 4.9 3 ペイン以外のパネル（例: ログ）

`panels?: ThreePaneExtraPanel[]`（`{ id, title, icon?, content: Snippet, initial?: 'hidden' | 'floating' | { edge } , width?, height? }`）。
初回は `initial` に従って置き、以後は保存したレイアウトに従う。「表示」メニューに並び、浮かせる・ドッキング・
固定・折りたたみは 3 ペインと同じ。id は `left`/`center`/`right` と重ならないこと（重なったら開発時に例外）。

### 4.10 テンプレートでの置き場と scaffold

- デモは新しいルート `apps/admin-template/src/routes/(app)/tree/workspace-dock/` に置き、`Workspace*.svelte` を
  `../workspace/` から使い回す。固定版の `/tree/workspace` は変えない（visual の基準画像も動かさない）。
- scaffold: `tree` を消せばルートごと消える（`tree/` 配下）。`dock` だけを消す場合のため、`removeDock` に
  このルートと `dockLayoutStore.svelte.ts` の削除を足す。ナビの項目を足すなら `tree` の下のリンク（ルート内のタブか
  `/tree` の索引）にとどめ、`nav.ts` の行は足さない（削除の手間を増やさない）。
- template-scope §3 の dock の行に「3 ペインの dock 版（`ThreePaneDock`）」を足し、削除手順
  （remove-optional-assets.md）を更新する。

## 5. 不採用・後回し

- `ThreePaneLayout` の `mode` 切り替え（§3、パッケージ間の import 禁止）。
- 中央を DOM の層で重ねる方式（§4.2 D）、木の不変条件で守る方式（§4.2 B）。
- 狭い幅で `ThreePaneLayout` に落とす方式（§4.5 (a)。中央が再マウントする）。
- ネイティブ窓への pop-out、共有レイアウト（§1）。
- キーボードのショートカット（§4.6、Q5）。

## 6. 受け入れ条件

temp-scada の要望:

1. 左右のペインを浮動へ切り離せ、ドッキングし直せる（ドラッグでもキーボードのメニューでも）。
2. トグルの帯を出さずに使え、開閉・浮かせる・既定へ戻すをアプリのツールバーから API で呼べる。
   押された状態は `leftOpen`/`rightOpen` の bind で読める。
3. 中央のキャンバスは、左右の切り離し・ドッキング・外周へのドッキング・auto-hide・タブ化・狭い表示への切り替え・
   既定へ戻す、のどれでも**再マウントしない**（e2e で同じ DOM 要素であること・mount の回数が 1 のままを確かめる）。
   移したあともフォーカス・スクロール・倍率・ポインタ操作が保たれる（実ブラウザで確認）。

全体:

4. 初期レイアウトは左・中央・右で `ThreePaneLayout` と同じ並び・同じ既定幅。
5. 「表示」メニューのチェックとパネルの ✕ が同じ状態を指し、閉じたパネルは前回の位置に戻る。
6. レイアウト（ピン・折りたたみ・auto-hide 含む）がユーザーごと・画面ごとに保存され、再読み込みで戻る。
   パネルの集合が変わった保存値も壊れずに読める。「既定に戻す」で初期に戻る。
   同じ端末で利用者が替わっても、前の利用者の配置を表示しない・保存しない（localStorage の写し、provider の
   読み込み、debounce、unmount の flush のどれでも。設定の無い別の利用者は既定で始まる）。
   中央は既定の配置でも復元した配置でも、閉じていない・畳まれていない・auto-hide されていない・浮いていない。
7. 900px 以下は狭い表示、kiosk は §4.5 の表のとおり組み替え不可（リサイズ・折りたたみ・auto-hide・メソッドからの変更も含む）、
   touch はボタンが touch の大きさ。
8. キーボードだけで全パネルの移動・浮かせる・戻すができ、結果が読み上げられる。axe の違反なし。
9. `/tree/workspace` の未保存の確認が今と同じに効き、パネル操作では確認が出ない。
10. scaffold の 4 プリセットと「dock だけ消す」組み合わせで型チェック・ビルドが通る。

## 7. PR の分け方

1 PR = 1 エージェントで任せられる大きさ。各 PR で `pnpm check`・`pnpm format:check`・該当パッケージの単体テスト、
CHANGELOG の `[Unreleased]` に 1 行、この文書の状態行の更新。

| PR | 中身 | 依存 | 終わりの条件 | 検証 |
| --- | --- | --- | --- | --- |
| PR-1 | dock-svelte: `DockHost` の `persistent`（据え置き、§4.2 C）。フォーカス・スクロールの記録と復元 | なし | `persistent` のパネルが undock / dock / 外周 / reparent / auto-hide / タブ切り替えで同じ DOM・mount 1 回。`keepMounted` の既存テストが通る | 単体（`DockHost*.test.ts` に追加）。visual は変化なし（既存が通る）。scaffold 不要 |
| PR-2 | dock-svelte: `movePanel` と「パネルの操作」メニュー、`aria-live` の通知、`DockMessages` の追加（§4.6） | なし（PR-1 と並行可） | キーボードだけで外周・タブ・浮動・元に戻すができ、拒否で状態が変わらない。読み上げ文が出る | 単体（`DockHostKeyboard.test.ts` 等）。e2e（ダッシュボードでキーボード移動 1 本）。visual: タイトルバーにボタンが増えるので基準画像を `visual-baselines.yml` の dispatch で再生成。scaffold 不要 |
| PR-3 | dock-svelte: `ThreePaneDock`、`threePaneDockLayout`、`reconcileThreePaneLayout`、操作の口、`viewMenuItems`、追加パネル（§4.1・§4.4・§4.8・§4.9）。README | PR-1・PR-2（`move` が `DockHost.movePanel` を通るため） | 純関数の単体テスト、部品のテスト（初期の並び・API・メニュー項目・中央が閉じられない・復元で中央が隠れた保存値を直す） | 単体。アプリに配線しないので e2e・visual・scaffold 不要 |
| PR-4 | dock-svelte: 狭い表示と `arrange={false}`、touch のボタンの大きさ（§4.5） | PR-3 | 境界をまたいでも保存値が変わらず、中央が再マウントしない。`arrange={false}` で §4.5 の表の禁止の操作がポインタ・キーボード・メソッドのどれでもできない | 単体。visual・scaffold 不要（配線前） |
| PR-5 | アプリ: `lib/banto/dockLayoutStore.svelte.ts` をダッシュボードから出し、保存値を利用者・セッションの世代に結び付ける（§4.4）。scaffold の `removeDock` に追加 | なし | ダッシュボードの保存・復元・既定へ戻すが今と同じ。利用者が替わったとき、前の利用者の写し・読み込み結果・保留中の書き込みを使わない（単体テスト） | 単体（store）、既存 e2e（dashboard）。**scaffold の 4 プリセットの dry-run 要**（`removeDock` が変わる） |
| PR-6 | アプリ: `/tree/workspace-dock` のデモ（表示メニュー、ツールバーのボタン例、kiosk・touch の配線、文言キー）。scaffold の `removeDock` に追加、template-scope §3 と remove-optional-assets.md | PR-2・PR-3・PR-4・PR-5 | §6 の 1〜10 を満たす | e2e 新規（切り離し・再ドッキング・中央の同一性・キーボード・既定へ戻す・狭い表示・未保存）、visual 新規の基準画像（Linux、dispatch）、**scaffold の 4 プリセット + dock だけ消す dry-run 要** |
| PR-7 | 文書: アプリ作者向けの recipe（`docs/recipes/`、temp-scada の使い方の例）と README の索引、この文書の状態を「完了」に | PR-6 | リンク切れなし | `pnpm format:check` |
| （PR-8） | 利用者の操作でのモード切り替え（§4.3 (b)）。Q1 で「作る」と決まったときだけ | PR-6 | | e2e・scaffold dry-run |

## 8. 要確認（オーナーの判断）

- **Q1** モードの切り替えは、アプリが画面ごとに選ぶだけでよいか（推奨）。利用者が「表示」メニューで切り替える口（PR-8）も要るか。
- **Q2** レイアウトはユーザー設定に画面ごとに 1 つ（推奨）でよいか。一覧の「ビュー」に含める・名前を付けて複数保存する必要はあるか。
- **Q3** 「レイアウトを既定に戻す」で確認の dialog を出さなくてよいか（推奨: 出さない。ダッシュボードと同じ）。
- **Q4** kiosk は組み替え不可（推奨）でよいか。kiosk でも利用者に動かさせたい現場はあるか。
- **Q5** キーボードはメニュー（推奨）だけでよいか。VS のような移動のショートカットも要るか（要るなら割り当て）。
- **Q6** 中央の据え置き（§4.2 C）を左右にも既定で効かせるか（推奨: 中央だけ。左右はアプリが選ぶ）。
- **Q7** 狭い幅で固定の `ThreePaneLayout` に落とさず、dock の中の「狭い表示」（推奨）にしてよいか。
- **Q8** デモを別ルート `/tree/workspace-dock`（推奨）にするか、`/tree/workspace` に切り替えを置くか。
- **Q9** temp-scada の中央のキャンバスに `iframe` やネイティブの埋め込みがあるか（ある場合、DOM の移動で読み直すので据え置きでは守れない）。

## 9. 決定の記録

2026-11-19 オーナー判断: **Q1〜Q8 は推奨どおり**。

- Q1: モードはアプリが画面ごとに選ぶ。利用者が切り替える口（PR-8）は作らない（要望が出たら起票）。
- Q2: レイアウトはユーザー設定に画面ごとに 1 つ。一覧の「ビュー」には含めず、名前つきの複数保存もしない。
- Q3: 「レイアウトを既定に戻す」で確認の dialog は出さない。
- Q4: kiosk は組み替え不可（`arrange={false}`）。
- Q5: キーボードの操作は「パネルの操作」メニューだけ。移動のショートカットは割り当てない。
- Q6: 据え置き（§4.2 C）を既定で効かせるのは中央だけ。左右・追加パネルはアプリが選ぶ。
- Q7: 狭い幅は dock の中の「狭い表示」にする（`ThreePaneLayout` には落とさない）。
- Q8: デモは別ルート `/tree/workspace-dock`。
- Q9: 確認済み（2026-11-19 クロスレビュー）。temp-scada の現行の中央（`App` → `CanvasWorkspace` → `Renderer` の SVG）に
  `iframe`・ネイティブの埋め込みは無い。据え置き（C）のまま進める。DOM を移したあとのフォーカス・スクロール・倍率・
  ポインタ操作は PR-1 と PR-6 の実ブラウザ検証に残す。

同日のクロスレビュー（P2×2・P3）を反映: 保存値のセッション分離（§4.4・§6-6・PR-5）、kiosk で止める操作の表と
中央が隠れない条件（§4.5・§4.7・§6-6/7・PR-3/4）、PR-3・PR-6 の依存に PR-2 を追加（§7）。
