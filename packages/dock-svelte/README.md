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

`FloatingWindowDef.icon` はレイアウトに保存される文字列。`DockHost` に
`iconContent` snippet を渡すと、タイトルバー・タブ・ドラッグ中のアイコンを
アプリ側の SVG やアイコン部品で描ける。省略時は従来どおり文字列をそのまま表示する。

```svelte
<DockHost {dock} {panel}>
	{#snippet iconContent(icon: string)}
		<MyIcon name={icon} />
	{/snippet}
</DockHost>
```

## host の縮小と浮動 window の到達性

浮動 window は「保存してある希望の配置（layout の x / y / width / height）」と「いま描く配置」を分けて扱う
（shared-primitives-upstream-plan §3.2、#434）。host が縮むと、描く配置だけが host 内に収まるよう補正され、
**保存した希望は書き換わない**（host が戻れば希望の位置へ戻る。`serialize()` の結果も縮小の前後で同じ）。
move / resize は描いている位置から始まり、確定した結果が新しい希望になる。

`DockHost` の `clamp` で、補正の方針を consumer が渡す（省略時は汎用の既定値 `DEFAULT_MIN_*`。アプリ固有の数値は
パッケージに固定しない）:

```svelte
<DockHost {dock} {panel} clamp={{ minW: 280, minH: 240, minVisible: 64, narrowHost: 'fit' }} />
```

- `minW` / `minH` — 最小の幅・高さ。
- `minVisible` — host 内に必ず残す px（タイトルバーを掴み直せる量）。
- `narrowHost` — host が最小寸法より狭いとき。`'overflow'`（既定。最小寸法を保ち、`minVisible` だけ到達可能）／
  `'fit'`（その軸は host の大きさに縮め、window 全体を見せる）。

純関数 `clampWindowToHost`（操作の結果の補正）と `displayWindowGeometry`（描画用。host が未計測の間は保存値のまま）も
export している。

## pane の能力（必須 pane の保護）

`DockHost` の `capabilities` で pane ごとに UI の操作を絞れる（省略時はすべて可）:

```svelte
<DockHost
	{dock}
	{panel}
	capabilities={(id) =>
		id === 'canvas' ? { close: false, move: false, undock: false } : undefined}
/>
```

- `close: false` — 閉じるボタンを出さない。
- `move: false` — タイトルバー / タブのドラッグによる移動・再配置をしない（浮動 window の resize は別）。
- `undock: false` — docked pane を浮動化・pop-out しない（空き領域へのドロップは無視され、pop-out ボタンも出ない）。
- `dropCenter: false` — **ドロップ先として**、その pane の十字のガイドに中央のボタンを出さない（ほかの pane をタブとして
  入れさせない。メイン区画向け）。タブの組は、中の pane がすべて許すときだけ出す。
- `dropSplit: false` — **ドロップ先として**、その pane の十字のガイドに上下左右のボタンを出さない（その pane の横に分割で
  入れさせない）。外周のボタン（下の「外周へのドッキング」）には効かない。タブの組の扱いは `dropCenter` と同じ。
- `autoHide: false` — その pane のいる区画の見出しにピン（自動で隠す、下の節）を出さない（メイン区画向け）。タブの組は、
  中の pane がすべて許すときだけ出す。`close`・`move`・`undock` がすべて `false` の pane の区画は「メイン区画」として、
  自動で隠す区画の入る縁を決める基準になる。
- `collapse: false` — その pane のいる区画の折りたたみボタンを押せなくする（帯にしない。メイン区画向け、#663 ④）。
  すでに畳まれている区画は展開できる。タブの組は、中の pane がすべて許すときだけ畳める。

これは UI の口であって権限の仕組みではない。`dock.close(id)` などをコードから呼べば動くので、守りたい pane は
アプリ側の呼び出しも絞ること。アプリ固定の標準配置は、独自の default layout を `createDockState(layout)` に渡す
（パッケージは SCADA などの panel ID を持たない）。

## 操作の確定と取消（ドラッグ・resize・divider）

`DockHost` の中のポインタ操作（タイトルバー / タブのドラッグ、浮動 window の resize、分割の
divider）は、host ごとに 1 つの持ち主が 1 回の操作として扱う（#433）。

- 同時に 1 つの操作だけ。操作中のほかの pointer（2 本目の指など）は動かさず、確定もさせない。
- **確定**は、操作を始めた pointer の `pointerup` だけ。確定の直前に host の寸法を測り直す
  （window の resize の通知が来る前に離しても、古い寸法では確定しない）。
- **取消**は、Esc（ほかの層が `preventDefault` 済みなら譲る。受けたら `preventDefault` する。IME 変換中は
  見ない）・`pointercancel`・`lostpointercapture`・window の `blur`・タブが隠れたとき・`DockHost` の
  unmount。resize は対象の window の位置と寸法だけ、divider は対象の split の比率だけを押す前に戻す
  （操作中にアプリが layout を変えていても、その変更は残る）。押した window が前面に来るのは押したこと
  （フォーカス）の結果なので、取消でも前面のまま。ドラッグは確定まで layout を書かないので、取消では何も変えない。
- 浮動 window は `pointerdown` に加えて `focusin`（Tab や中の入力欄へのフォーカス）でも前面に来る。
  前面化は `z-index` で行い、DOM の順（= Tab の順）は変えない。

## 十字のガイド（区画へのドッキング、#694）

浮動 window のタイトルバーや docked のタイトルバー・タブをドラッグすると、指している docked の区画（pane 1 つか
タブの組）の真ん中に十字のボタン（中央・左・右・上・下）が出る。**ボタンの上で離したときだけ**ドッキングする。

- 中央 = その区画にタブとして入る。左・右・上・下 = その区画を分割してその側に入る（比率は `[0.5, 0.5]`）。
  ボタンの上にいる間は、入る場所（区画の全体か半分）の枠が出て、ボタンが塗られる。
- **ボタンの外で離すと**、区画の上でも浮動になる（浮動 window はその位置へ動き、docked の pane は undock。
  `undock: false` の pane は何も起きない）。host の外で離したら何もしない。これまでの「区画の端 25% の帯へ落とすと
  分割、残りは中央」の判定はやめた（`computeDropRegion` は互換のために export だけ残る）。
- ボタンは 32px 角・間隔 4px（`GUIDE_BUTTON_SIZE` / `GUIDE_BUTTON_GAP`）。区画が小さいときは、十字と区画の縁の
  余白 8px（`GUIDE_INSET`）が収まるまで小さくし、16px（`GUIDE_BUTTON_MIN`）を下回るなら十字を出さない（その区画へは
  ドッキングできない。浮動になる）。
- 出せない方向のボタンは出さない: ドロップ先の pane の `dropCenter` / `dropSplit`（上の「pane の能力」）。
- 浮動 window の上・畳んだ区画の帯の上には十字は出ない（浮動 window の上は浮動の移動・undock、帯の上は何も起きない、
  は今までどおり）。自分のいる区画（タブの組）の中央のボタンで離すのは、今までどおり何もしない。
- ボタン・枠はドラッグ中だけ描かれ、`pointer-events: none`・`aria-hidden`。当たり判定はドラッグの計算の中で
  幾何的に行うので、ドラッグの外でポインタやフォーカスを奪わない。キーボードだけでドッキングする口は無い。
- 確認（`beforePanelChange`）は今までどおり（下の「押し出される pane にも聞く」）。

## 外周へのドッキング（#694）

浮動 window のタイトルバーや docked のタイトルバー・タブをドラッグして、host の四辺の真ん中に出る外周のボタンの
上で離すと、docked の木全体（根）を新しい分割で包み、その側に全高（左・右）／全幅（上・下）で入る。入る pane は
host の 1/4（`EDGE_DOCK_RATIO`。分割の比率は左・上なら `[0.25, 0.75]`、右・下なら `[0.75, 0.25]`）、残りの 3/4 が
元の木。根がすでに同じ向きの分割でも、その分割に足さずに常に包む。

- 外周のボタンは各辺の真ん中、辺から 8px 内側（十字と同じ大きさ。host が小さいときは十字と同じ規則で小さくなり、
  出ないこともある）。ボタンの外（辺の近くでも）で離しても外周には入らない。ボタンの上にいる間は、入る場所
  （host の 1/4）の枠が出る。
- 外周のボタンは区画の十字より先に判定する。host の縁に接する小さい区画で十字のボタンと外周のボタンが重なるときは、
  重なった十字のボタンを出さず、外周が勝つ。縁に重なった浮動 window の上でも外周のボタンが勝つ。
- 外周を出すのは、ドラッグしている pane のほかに docked の pane があるときだけ。docked が空（またはドラッグしている
  pane だけ）のときは縁にも何も出ず、ドロップは今までどおり（空き領域なら浮動の移動・undock）。
- `move: false` の pane はドラッグが始まらないので外周へも動かせない。外周へ動かすのは docked の木の中での再配置
  なので `undock: false` の pane も動かせる。
- 確認（`beforePanelChange`）は区画へのドロップと同じ: 包まれて作り直される pane の `reparent` が先、最後に
  動かす pane の `dock` / `move-docked`（上の「押し出される pane にも聞く」）。待つあいだに構造が変わったら `stale`。
- 包むと作り直される pane にフォーカスがあったときは、適用後、同じ区画（タブの組なら選択中のタブ、単独の pane
  なら本文の領域）へ戻す。その区画が無ければ動かした pane へ。`<body>` に落ちていないフォーカス（残った要素や、
  hook・ホストが移した先）は動かさない。
- コードからは `dock.dockPanelAtEdge(id, edge)`（浮動 window を外周へ）・`dock.dockExistingAtEdge(id, edge)`
  （docked の pane を外周へ。docked の pane がそれだけなら何もしない）。木の純粋な操作は `dockPanelAtEdge(root,
panel, edge)`。これらは確認（`beforePanelChange`）を通らない（`dock.dockPanel` などと同じ）。
- Tauri の pop-out した window からは host へドラッグできない（別の OS の window のため）。外周へ入れるには、
  host へ戻してからドラッグする。

## ドラッグせずに動かす（「パネルの操作」メニューと `movePanel`、#663 ④）

docked の pane のタイトルバー（タブの組なら選択中のタブ）と浮動 window のタイトルバーに「パネルの操作」の
ボタン（⋯）が出る。開くと、その pane をドラッグで置ける先が並ぶ: 「左端に／右端に／上端に／下端にドッキング」
（外周）、「〇〇とタブにまとめる」、「〇〇の隣にドッキング」（開くと「左に／右に／上に／下に」を選ぶ）、
「浮かせる」（docked の pane）、「元の場所に戻す」（この host で浮かせた window）。ポインタでも使える
（ドラッグの代わり）。移動のショートカットキーは割り当てない（キーボードの経路はこのメニューだけ）。

- キー（WAI-ARIA の menu button）: ボタンで Enter / Space / ↓ で開いて先頭へ、↑ で末尾へ。メニューの中は ↑ ↓
  （端で折り返す）・Home / End で移り、Enter / Space で選ぶ。「〇〇の隣に」は → か Enter で辺の一覧を開き、← か
  Esc で元の一覧のその項目へ戻る。Esc でメニューを閉じてボタンへフォーカスを戻す。Tab・外のクリックで閉じる。
  メニューの中のキーとポインタの押下は、周りのタブ（← →）やタイトルバーのドラッグに届かない。
- 項目は**ドラッグと同じ規則**で出し分ける: `move: false` の pane・錠（`locked`）のかかった浮動 window・
  帯に畳んだ区画・自動で隠した pane は動かない（ボタンを出さない。錠の window でも閉じる・前面化などは今のまま）。
  「浮かせる」は `undock` も要る。「とタブに」は相手の区画の `dropCenter`、「の隣に」は `dropSplit` が要る
  （十字のガイドと同じ）。外周は、ほかに docked の pane があるときだけ。自分と同じタブの組へ「タブにまとめる」は出ない。
- 選ぶと、先にメニューを閉じて（フォーカスはボタン）から移す。確認（`beforePanelChange`）は**ドラッグと同じ要求**:
  押し出される pane（前面のタブ・包まれる・作り直される隣）の `tab-switch` / `reparent` が先、最後に動かす pane の
  `dock` / `move-docked` / `undock`。拒否や、待つあいだに構造が変わった（`stale`）ときは何も変えない。
  待つあいだに錠がかかった・capabilities が変わったなどで、その移動がもう出せないものになったときも、
  適用の直前に確かめ直して `stale` にする（何も変えず、成功は読み上げない）。
- 結果は host の中の `aria-live="polite"` の領域で読み上げる（例「ツリーを右端にドッキングしました」
  「ツリーの移動は取り消されました」「移動できません: …」）。
- フォーカス: 移したら動かした pane のタイトルバー（タブの組ならそのタブ、ほかは ⋯ ボタン）へ。拒否・中断の
  ときはメニューのボタンへ戻す（ボタンが無ければ pane のタイトルバーへ）。ボタンが消える（錠をかけた、ほかの
  pane が無くなった）ときにフォーカスがあれば、そのタブか、タイトルバーの次のボタンへ移す。
- 「元の場所に戻す」の場所は、この host が mount されている間だけ覚える（保存するレイアウトには入れない）。
  その場所が無くなったら項目を出さない。戻し先にもドラッグと同じ制約をかける: タブの組へ戻るなら組の
  ほかの pane が全員 `dropCenter`、split へ戻るなら隣の区画のどちらかが `dropSplit` を許すときだけ出す。

アプリのツールバーなどからは `host.movePanel(id, target)` で同じことができる（ドラッグと同じ経路・同じ確認）:

```ts
await host.movePanel('tree', { edge: 'left' }); // 外周（host の 1/4）
await host.movePanel('tree', { tabWith: 'detail' }); // detail のタブの組へ
await host.movePanel('tree', { splitWith: 'main', side: 'bottom' }); // main の区画の下へ
await host.movePanel('tree', { float: true }); // 浮かせる
await host.movePanel('tree', { back: true }); // 浮かせた場所から元へ
// → 'applied' | 'refused' | 'stale' | 'superseded' | 'disposed' | 'unavailable'（ドラッグでは出さない移動。何も変えない）
```

`movePanel` はフォーカスを動かさない（移したことで `<body>` に落ちたフォーカスだけ、動かした pane のタイトルバーへ戻す）。
結果は同じく読み上げる。型は `DockMoveTarget` / `DockMoveOutcome`。

見える文言は `messages` の `panelMenu`（ボタンの `aria-label` とメニューの名前）・`moveToEdge`・`moveToTabs`・
`moveToSplit`・`splitSide`・`menuBack`・`floatPanel`・`dockBack`（項目）と、`movedToEdge`・`movedToTabs`・
`movedToSplit`・`floated`・`dockedBack`・`moveCancelled`・`moveStale`・`moveUnavailable`（読み上げ）で差し替える。
英語の例:

```ts
const side = { left: 'left', right: 'right', top: 'top', bottom: 'bottom' } as const;
const messages: Partial<DockMessages> = {
	panelMenu: (title) => `${title} panel actions`,
	moveToEdge: (edge) => `Dock at the ${side[edge]} edge`,
	moveToTabs: (target) => `Group as a tab with ${target}`,
	moveToSplit: (target) => `Dock next to ${target}`,
	splitSide: (s) => `To the ${side[s]}`,
	menuBack: () => 'Back',
	floatPanel: () => 'Float',
	dockBack: () => 'Dock back where it was',
	movedToEdge: (title, edge) => `${title} docked at the ${side[edge]} edge`,
	movedToTabs: (title, target) => `${title} grouped as a tab with ${target}`,
	movedToSplit: (title, target, s) => `${title} docked to the ${side[s]} of ${target}`,
	floated: (title) => `${title} floated`,
	dockedBack: (title) => `${title} docked back where it was`,
	moveCancelled: (title) => `Moving ${title} was cancelled`,
	moveStale: (title) => `Not moved: the layout changed while ${title} was being confirmed`,
	moveUnavailable: (title) => `Not moved: ${title} cannot go there`
};
```

## キーボード操作と操作の hook

キーは、フォーカスが dock の中の操作要素（divider・タブ・浮動 window のモードのボタン）にあるときだけ
受ける（window の keydown では受けない）。入力欄の中のキー、IME 変換中（`isComposing` / `keyCode 229`）、
Ctrl / Alt / Meta との組み合わせ、ほかが `preventDefault` 済みのキーは受けない。

| 対象                                                                                                                                                               | キー                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| divider（WAI-ARIA の Window Splitter。フォーカスできる `separator` で、`aria-valuenow` / `-valuemin` / `-valuemax` は区切る 2 つの pane のうち先の pane の割合 %） | 矢印（横並びは ← →、縦並びは ↑ ↓）で split の 2%、Shift で 10%。Home / End で最小 / 最大                                                                                                                                                            |
| タブ（roving tabindex。Tab で止まるのは選択中のタブだけ）                                                                                                          | ← →（端で折り返す）・Home / End で選んでフォーカスを移す                                                                                                                                                                                            |
| 浮動 window の移動 / サイズ変更                                                                                                                                    | タイトルバーのボタン（フォーカスが来たときだけ見える）でモードに入る → 矢印で 10px、Shift で 50px（サイズ変更は右下の角から）→ Enter かボタンをもう一度で確定、Esc で取消（その window の位置と寸法だけを戻す）。フォーカスがボタンから外れても取消 |

`DockHost` の props で、アプリが操作をつなげる（どれも省略できる）:

```ts
canStartGesture?: (kind: DockGestureKind, panelId: string | null) => boolean; // false で始めない
onGestureEnd?: (kind: DockGestureKind, outcome: 'commit' | 'cancel', reason?: DockCancelReason) => void; // 1 回だけ
isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean; // true で Esc を上位の層に譲る
```

- `canStartGesture` は操作が始まる前に聞く。タイトルバー / タブの押下はクリック（タブの選択）かもしれない
  ので、閾値を越えたときに `drag` として聞く（拒否したらその押下の残りは何もしない）。divider のキー 1 回は
  `divider` として聞く。
- `onGestureEnd` は操作が閉じた後（確定した、または対象を戻した後）に 1 回だけ呼ぶ。中で次の操作を
  始めても `DockHost` を unmount してもよい。
- `isEscapeBlocked` の `activeLayer` は、浮動 window の操作ならその root（`role="dialog"`）、docked の
  pane・divider なら `null`。浮動 window はどれも**非モーダルの** `role="dialog"` なので、どの dialog でも
  数える判定では Esc で取り消せなくなる。`@banto/ui` を使うアプリは次をつなぐ（dock-svelte は `@banto/ui`
  を import できないので、つなぐのはアプリ。apps/admin-template の `dockEscape.ts`）:

```ts
import { hasVisibleLayerAbove, hasVisibleMenuLayer, hasVisibleModalLayer } from '@banto/ui';
const isEscapeBlocked = (el: HTMLElement | null) =>
	el ? hasVisibleLayerAbove({ except: el }) : hasVisibleModalLayer() || hasVisibleMenuLayer();
```

見える文言（モードのボタンの `aria-label`）は `messages` の `moveWindow` / `resizeWindow` で差し替える。

## pane の lifecycle（構造変更の前の確認・中身の保持・hide と close）

中身の寿命に関わる**構造変更**（dock / undock / docked pane の移動 / タブの切替 / hide / close）の前に、アプリが
確かめて止められる（#432。設計は docs/design/shared-primitives-upstream-plan.md の §3.5・§4.2・D3・D4）。

```ts
type DockPanelChange =
	| { kind: 'dock' | 'undock' | 'move-docked'; panelId: string; remount: boolean }
	| { kind: 'auto-hide'; panelId: string; to: 'band' | 'tree'; remount: boolean } // 自動で隠す・ピンで戻す（#694 PR-3）
	| { kind: 'reparent'; panelId: string; cause: string; remount: boolean } // 動かしていない pane の親が変わり作り直される
	| { kind: 'tab-switch'; groupId: string; from: string; to: string; remount: boolean }
	| { kind: 'hide'; panelId: string; remount: boolean }
	| { kind: 'close'; panelId: string };

beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>; // true のときだけ変える
keepMounted?: (panelId: string) => boolean; // 見えないあいだも中身を mount したままにする pane
persistent?: (panelId: string) => boolean; // 中身を一度だけ描き、組み替えでも作り直さない pane（据え置き、下記）
isStructureChangeDeferred?: () => boolean; // true のあいだ構造変更を保留（省略時は IME 変換中）
arrange?: boolean; // false = 利用者が組み替えられない（キオスク、下記）。既定 true
```

- **`arrange={false}`**（#663 ④、three-pane-dock-plan §4.5）: `capabilities` の全項目を `false` として扱う（✕・ドラッグ・浮かせる・
  pop-out・ピン・折りたたみ・「パネルの操作」メニュー・ドロップ先を出さない）。分割線と浮動 window はポインタでもキーボードでも
  動かず（window はロックと同じ扱い）、折りたたみ・ロックのボタンと、引き出した pane のピン（戻す）ボタンも出さない。タブの
  切り替え・前面化・自動で隠れた pane の引き出しは許す。`movePanel` は `unavailable`、`autoHidePanel`・`pinPanel` は `refused`。
  アプリ自身の `showPanel`・`hidePanel`・`closePanel`・`setPanelVisible`・`replaceLayout`（と `DockState` の呼び出し）は止めない。
  実行中に `false` にすると、進行中のジェスチャは取り消し、承認待ち・保留中の変更はすべて `stale` にする。消えるボタンに
  フォーカスがあれば、その pane（タブか本文）へ移す。
- **touch の密度**: タイトルバーのボタンは `--banto-dock-button-size`、ドッキングのガイドのボタンは
  `--banto-dock-guide-button-size`（`@banto/theme` の touch 密度が小さい操作部品の高さ 40px を入れる）。ガイドはドラッグの
  開始時に host の値を読み、その大きさで描く。入りきらなければ既定の 32px までは縮め、それより小さくはしない
  （収まらない pane には十字を出さず、外周のボタンと空き場所へのドロップは残る）。純関数 `readGuideSizing(el)`。

- **`beforePanelChange`**: `true`（または `true` に解決）のときだけ layout を変える。`false`・ほかの値・例外・
  reject では変えない（変えないのは対象だけで、layout 全体を戻すことはしない）。確認の UI はアプリが出す。
  ドラッグでは、操作が閉じた後（確定の一点）に聞くので、確認を待つあいだ pointer の操作は残らない。拒否
  されると pane は元の場所のまま。**非同期の答え**は、適用の直前に確かめ直し、次のどれかなら採らずに
  `stale` を返す: 待つあいだに layout の構造（docked の形・選択中のタブ・浮動 window の有無と open）が一度でも
  変わった（`DockState.structureRevision` の世代で見るので、close → open やタブ A → B → A で同じ形に戻っても
  `stale`。位置・寸法・split の比率・前後関係の変化は数えない）、または今の状態で組み立て直した変更が聞いた
  ものと違う（`keepMounted` が変わって `remount` が変わった、`tab-switch` の `from` が変わった）。`DockHost` が
  unmount されたら、答えを待っている要求（解決しない Promise を含む）はすぐに `disposed` になる。
  **同じ要求**は、変更と行き先（ドロップ先と領域・undock の位置）が同じもの。答えを待つあいだの同じ要求
  （✕ の二度押し）はもう一度聞かない。行き先が違う要求（X へのドロップを待つあいだに Y へドロップ）は別に
  聞き、先に許可されたほうが適用され、もう一方は構造が変わったので `stale` になる。浮動 window の移動・
  resize・divider（幾何だけの変更）と、アプリが `DockState` を直接呼ぶ変更は聞かない。
- **`remount`**: `true` は中身がいったん unmount され、あとで別に mount されること（draft を capture しておけば
  次の mount で戻せる）。`false` は DOM が残ること。`tab-switch` では `from` の pane のこと。dock / undock は
  docked の木と浮動の層をまたぐので、`keepMounted` でも `true`。`persistent` の pane（下記）は、どの変更でも `false`
  （`reparent` としては聞かない）。
- **押し出される pane にも聞く（#666）**: docked の木へのドロップ（dock / move-docked。押し出される側は `tab-switch` / `reparent`）と `showPanel` で元の場所へ
  戻すときは、動かす pane のほかに、変わってしまう docked の pane にも先に聞く（木の順に 1 つずつ、最初の拒否で
  止めて何も変えない。最後に動かす pane 自身の `dock` / `move-docked`）。
  - タブの組へ落とす（戻す）と、それまで選択中だったタブが画面から外れる: `tab-switch`（`from` = そのタブ、
    `to` = 落とした pane。`remount` は `keepMounted` でなければ `true`）。単独の pane の真ん中へ落として新しい
    タブの組ができるときも、その pane からの `tab-switch`（`remount: true`。`groupId` はまだ無い組の仮の id）。ドロップでは仮の id `${落とした pane}:dropped` で、適用後の木の実際の id（適用時に作られる）とは一致しない。復帰（`show` で元のタブの組へ戻す）では、覚えていた元の組の id をそのまま使うので普通は適用後の木と一致するが、その id がもう木の中で使われているときだけ仮の id `${pane}:restored-tabs` になり、一致しない。新しくできる組への `tab-switch` の `groupId` で組を引かないこと。
  - 単独の pane（またはタブの組）の十字の上下左右のボタンへ落として新しい分割ができると、包まれる pane の中身は作り直される
    （Svelte の部品は別の親へ移せないので `keepMounted` でも同じ）: その pane の `reparent`（`remount: true`、`cause` = 動かす pane の id）。
    包まれるタブの組では、選択中のタブと `keepMounted` のタブのそれぞれ。docked の pane を動かして元の分割が
    1 つに縮むときに残る側も同じ。
  - host の外周へ落とす（下の「外周へのドッキング」）と、木の根が新しい分割で包まれ、根の中の pane は
    木の段が 1 つ深くなって作り直される: 中身が載っている各 pane（各タブの組の選択中のタブと `keepMounted` のタブ）の
    `reparent`（`cause` = 動かす pane の id）を木の順に聞き、最後に動かす pane の `dock` / `move-docked`。docked の
    pane を外周へ動かすときは、先に抜いた残りの木を包むので、抜いたことで段が変わらない pane（縮んだ分割の残る側が
    結果として同じ段に来るもの）は聞かない。
  - docked の pane を木から抜く操作（undock のドロップ・✕ / `closePanel` / `hidePanel` / `setPanelVisible(false)`、#682）で分割やタブの組が 1 枚に縮み、残る pane が作り直されるときも、先に残る側の `reparent`（`cause` = 抜かれる pane の id）を聞き、最後に抜かれる pane 自身の `undock` / `hide` / `close`。残る pane が作り直されない縮み方（3 枚以上から 1 枚抜く、など）は聞かない。
  - 答えはまとめて 1 つの判断: 最初に聞いたときの構造の世代のまま適用まで進み、途中で構造が変わったら
    `stale`。同期の答えだけなら同期で適用する。IME 変換中はタブのクリックと同じく保留する。
- **`keepMounted`**: その pane の中身を、表示していないタブのあいだ・hide した浮動 window のあいだ、
  `hidden` + `inert` で同じ DOM のまま残す（IME・選択・scroll・未完成の入力が残る）。そのぶんメモリと effect は
  常にかかる。`keepMounted` でない pane は今までどおり、見えなくなると unmount する。

### 据え置き（`persistent`、#663）

`persistent` が `true` の pane は、`keepMounted` の上位互換で、**どの組み替えでも中身を作り直さない**
（設計は docs/design/three-pane-dock-plan.md の §4.2 C）。キャンバス（描画のキャッシュ・ズーム・選択）のように
作り直しが致命的な中身に使う。

```svelte
<DockHost {dock} {panel} persistent={(id) => id === 'canvas'} />
```

- `DockHost` は、その pane の `panel` snippet を木の外（host の中の隠した預かり場所）に **1 回だけ** 描く。
  木の中（docked の pane・タブ・浮動 window・自動で隠した pane の引き出し）には空の受け皿だけを置き、
  受け皿が mount されたら中身の要素を `appendChild` で移し、外れたら預かりへ戻す。undock / dock・外周への
  ドッキング・周りの組み替え（`reparent`）・自動で隠す / ピンで戻す・タブの切替のどれでも、同じ DOM 要素・
  同じ Svelte の部品のまま（mount は 1 回）。受け皿と中身の要素は `display: contents` なので、見た目は
  `persistent` でないときと同じ。
- `keepMounted` を兼ねる（✕ は hide、隠したタブ・浮動 window でも中身が残る）。`closePanel`（close）は中身を捨て、
  次に開くと新しく mount する。`beforePanelChange` には今までどおり聞くが、その pane の変更は `remount: false`
  で、周りの組み替えで親が変わるだけのときは聞かない（作り直さないので失うものがない）。`persistent` も
  `keepMounted` と同じく適用の直前に読み直し、聞いたときと `remount` が変わったら `stale`。
- DOM を移すと失われるものは戻す: 移す前に中のフォーカスのある要素を控え、移したあと（同じ更新の後の
  microtask）にそこへ戻す。ただし、そのときフォーカスが `<body>` 以外（host やアプリが別の場所へ移した）なら
  奪わない。中の要素の scroll 位置は `scroll` イベントで控えておき、受け皿へ移すたびに戻す。受け皿が無く
  預かりへ戻った中身にはフォーカスを残さない（`<body>` へ外す）。
- **`iframe` は移すたびに読み直される**（ブラウザは移した `iframe` の文書を読み込み直す）。`iframe` や
  ネイティブの埋め込みを持つ中身は、据え置きでも状態を守れない。
- 位置・大きさ・倍率・ポインタ操作の状態は中身の部品が持つので残るが、`ResizeObserver` 等で受け皿の大きさを
  測る中身は、移した直後に大きさが変わることがある（新しい親の大きさになる）。

### hide と close（D4）

| 操作                              | 中身                                                                                                           | `beforePanelChange` |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| ✕ ボタン（`keepMounted` の pane） | **hide**: 浮動 window は中身を保ったまま隠す。docked の pane は閉じた浮動 window になる（そこで mount し直す） | `hide`              |
| ✕ ボタン（それ以外）              | **close**: 中身を捨てる（今までと同じ）                                                                        | `close`             |
| `host.hidePanel(id)`              | hide（上と同じ）                                                                                               | `hide`              |
| `host.closePanel(id)`             | close。`keepMounted` の pane でも中身を捨てる（隠れている中身も捨てる）。次に開くと新しく mount する           | `close`             |

どれも window の位置と寸法は残す（次の `dock.open(id)` で同じ場所に出る）。docked の pane は、ドックの中の
場所も覚える（次の「表示メニュー」節の `showPanel` で元の場所に戻る。`dock.open(id)` は従来どおり浮動で開く）。`hidePanel` / `closePanel` /
`resumeDeferredChange` は `bind:this` で得た `DockHost` から呼び、結果（`DockPanelChangeOutcome`:
`applied` / `refused` / `stale` / `superseded` / `disposed`）を返す。中身を捨てる close を ✕ 以外（メニュー・
コマンド）に置くのはアプリ。アプリでのつなぎ方（hide・tab-switch・dock は draft の capture だけ、close は
確認して apply / discard / cancel）は計画書 §3.5 の遷移ごとの表を見る。

### 表示メニュー（pane の一覧と表示・非表示、#663）

「表示」メニューに pane ごとのチェックボックスを並べるための口。メニューの部品はアプリ（または `@banto/ui`）が持ち、
dock-svelte は一覧と操作だけを出す（`@banto/ui` に依存しない）。

```svelte
<script lang="ts">
	let host: ReturnType<typeof DockHost> | undefined = $state();
</script>

<DockHost bind:this={host} {dock} {panel} />

{#each dock.panels as row (row.id)}
	<label>
		<input
			type="checkbox"
			checked={row.visible}
			onchange={(e) => host?.setPanelVisible(row.id, e.currentTarget.checked)}
		/>
		{row.title}
	</label>
{/each}
```

- **`dock.panels`**（reactive）: layout にあるすべての pane の `{ id, title, icon?, placement, visible }`。
  - `visible` — docked の木にある（裏のタブも含む）か、開いた浮動 window なら `true`。✕・`hidePanel`・ドラッグ・
    `hydrate` に追従する。
  - `placement` — `'docked'` は docked の木にあるか、ドックから隠した pane（戻す場所を覚えている）。`'floating'` は
    それ以外の浮動 window（開閉どちらも）。
  - 並び順は、その `DockState` が id を初めて見た順（最初の layout の docked の木を木の順に、続けて浮動 window を
    配列の順に。あとから増えた id は末尾）。前面化・ドック・隠す操作では並び替わらない。`hydrate` / `layout = ...`
    でも既知の id は位置を保ち、新しい id は末尾に付く。アプリ独自の順にしたいときは行をアプリで並べ替える。
- **`host.setPanelVisible(id, visible, { isCurrent? })`**: チェックを外す = ✕ と同じ（`keepMounted` の pane は hide、それ以外は close。
  `beforePanelChange` に聞き、拒否なら `refused`。`isCurrent` は適用の直前に読み直し、`false` なら `stale` で何も変えない
  — 承認待ちの間にアプリが逆を望み、それが今の状態と同じで新しく聞くことが無いときに、古い依頼を失効させる）。`capabilities` の `close: false` の pane は外さない（`refused`）。
  チェックを入れる = `showPanel`。外すときに既に隠れていれば聞かずに `applied`。拒否されたときはチェックボックスを
  `row.visible` に戻すのはメニュー側（変わらない値は Svelte が書き戻さない）。
- **`host.showPanel(id)`**: どこにあっても見える状態にする。
  - ドックから隠した pane は**覚えている元の場所に戻す**（VS Code / Visual Studio のツールウィンドウと同じ）。
    タブだった pane は同じタブグループの同じ位置に（選択中のタブにする）、分割の片側だった pane は同じ側に、
    もとの割合で戻る。同じ分割から何枚か隠したときは、まだ隠れている pane の分を空けて戻すので、どの順で戻しても
    全部戻せば元の割合になる（#733）。元のタブグループ・分割が消えていれば、隣にあった pane を目印にして同じ関係で戻す。
    入れ子の分割では、目印の pane だけでなく、それを含む入れ物（同じ側にあった pane だけでできたもの）ごと包んで
    戻す（`column[row[a,b], c]` の `c` は `b` の隣でなく `row[a,b]` の隣へ。#727）。目印も入れ物も無ければ、
    入れ物があった場所へ、それも無ければさらに外側の入れ物があった場所へ戻す（#721・#727）。
    どれもドックに無ければ浮動 window として開く（保存してある位置・寸法）。docked の木が空なら、木そのものになる。
  - 閉じた浮動 window は開いて前面に、開いている浮動 window は前面に、docked の裏のタブは選択中のタブにする
    （`tab-switch` として聞く）。
  - タブグループへ選択中のタブとして戻すと、それまで選択中だった pane が画面から外れる（`keepMounted` でなければ
    unmount）。そこで先に、その pane から戻す pane への `tab-switch` として聞く（タブのクリックと同じ。拒否なら
    `refused` で隠れたまま、IME 変換中は変換が終わるまで待つ）。1 つになっていたタブグループを作り直すときは、
    残っていた pane が新しいグループに入って作り直されるので `remount: true`。
  - `keepMounted` で中身が残っている pane をドックへ戻すときは `dock` の変更（`remount: true`）としても聞く
    （`tab-switch` があればその後。2 つの答えは 1 つの判断で、`tab-switch` を許したときの構造が `dock` を
    当てるまでに変わったら（アプリが別のタブを選んだなど）`stale`）。分割へ戻すときに新しい分割を隣の pane
    （またはタブの組）の周りに作り直すと、隣の中身は作り直されるので、先にその pane の `reparent` として聞く
    （#666、上の「押し出される pane にも聞く」）。それ以外（既にある分割へ戻す・木が空・浮動で開く）は
    `dock.open` と同じく聞かない。
  - DOM のフォーカスは動かさない（前面化・選択中のタブだけ）。メニューを閉じたあとのフォーカスはメニュー側の
    約束に従い、pane の中へ移すかはアプリが決める。
- 戻す場所は閉じた浮動 window の `dockSlot` として layout に入り、`serialize()` / `hydrate()` を通る（layout の
  `version` は 2 のまま（slot は 4 段まで。それより深いと下の `version: 3`）。`dockSlot` の無い古い JSON はそのまま読め、その pane は浮動で開く）。
- 入れ子の入れ物から隠すと、`dockSlot`（と端の帯の `slot`）は外側の入れ物の場所を `outer` で入れ子に覚える
  （#727。slot 自身を含めて最大 8 段）。**5 段以上の slot を 1 つでも含む layout は `version: 3`** になり、
  #727 より前の版では読めない（`validateDockLayout` が `version` で拒み、その利用者の layout は既定に戻る）。
  4 段までなら今までどおり `version: 2` で、前の版でも読める。版は中身から毎回決まる（`dock.layout` に入れるたび・
  `serialize()`・`layoutSnapshot()`。深い slot が消えれば 2 に戻る）。読むときは `version: 2`（と 1）の slot は
  4 段まで、`version: 3` だけ 8 段まで受ける。`DockLayout['version']` の型は `2 | 3` なので、`version` で分岐する
  コードは 3 の分岐も足す（`{ version: 2, ... }` と書いて渡す既存のコードはそのまま通る）。
- `DockState` だけで扱う口もある（`beforePanelChange` には聞かない）: `dock.dismiss(id)`（隠す。docked なら場所を
  覚える）・`dock.show(id)`（上の `showPanel` の layout の部分。戻り値は `'docked'` / `'floating'` / `null`）・
  `dock.showPlacement(id)`（`show` がどこに出すか）・`dock.showTabSwitch(id)`（`show` が選択中から外す pane）・
  `dock.isVisible(id)`。
- `dock.isOpen(id)` / `dock.open(id)` / `dock.close(id)` は従来どおり**浮動 window だけ**を見る（docked の id には
  `false` / 何もしない）。`dock.open(id)` でドックから隠した pane を開くと浮動で開き、覚えた場所は捨てる。
  `dock.ensureWindow` は docked の id を浮動として足さなくなった（id の重複を作っていた）。

### 錠（浮動 window の位置と大きさの固定）

浮動 window のタイトルバーの錠のボタン（`aria-pressed`、🔓／🔒）を押すと、その window の位置と大きさが固定される。固定中は
タイトルバーのドラッグ・リサイズのハンドル・キーボードの移動 / サイズ変更ができない（ハンドルと両ボタンは出ない）。
中のタブの出し入れ・閉じる・前面に出すは効く。画面内に収める補正（`clamp`）も固定中に効く。#694 PR-3 まではピンのアイコンだったが、
ピンは「自動で隠す」（ドッキング中の区画、下の節）の意味に変わったので、錠に替えた。

- `dock.isLocked(id)` / `dock.setLocked(id, locked)`。`FloatingWindow.locked?: boolean` は `true` のときだけ書き出す
  （`false` は項目ごと消す）。無い古い JSON は「固定なし」で読め、layout の `version` は 2 のまま。
- 固定中の `dock.move` / `dock.resize` は何もしない。ドラッグ・リサイズの最中に固定されたら、その操作は取り消して
  操作前の位置と大きさに戻る。window がドックに入ると `locked` は消え、あとで引き出した pane は固定なしで始まる。
- ボタンのラベルは `messages.lockWindow(title)` / `messages.unlockWindow(title)`。
- **非推奨（次の major で消す）**: `dock.isPinned` / `dock.setPinned` は `isLocked` / `setLocked` の別名。
  `FloatingWindow.pinned` は書き出さない。古い JSON の `pinned: true` は `validateDockLayout`（`hydrate` も）が `locked: true` として読む。
  `messages.pinWindow` / `unpinWindow` は、`lockWindow` / `unlockWindow` を渡さないときだけ使われる。

### 折りたたみ（浮動 window をタイトルバーだけにする）

浮動 window のタイトルバーの折りたたみのボタン（`aria-expanded` / `aria-controls`、▾／▸）を押すと、タイトルバーだけに畳まれ、
もう一度押すと元の大きさに戻る。錠とは独立で、固定したまま畳める・畳んだまま固定できる。ドック中の領域の折りたたみは次の節。

- `dock.isCollapsed(id)` / `dock.setCollapsed(id, collapsed)`。`FloatingWindow.collapsed?: boolean` は `true` のときだけ書き出す
  （`false` は項目ごと消す）。無い古い JSON は「展開」で読め、layout の `version` は 2 のまま。保存の `height` は畳んでも変えない。
- 畳んでいる間、本体は破棄せず `hidden` + `inert` で隠す（中の状態は保たれ、`beforePanelChange` / `keepMounted` は関係しない: 畳むのは閉じるではない）。
  リサイズのハンドルとキーボードのサイズ変更ボタンは出ず、`dock.resize` も何もしない。移動・閉じる・前面に出す・別ウィンドウで開くは効く。
  中のタブ帯を使う外へのドラッグは、本体が隠れているあいだはできない。
- 本体の中（またはサイズ変更ボタン）に DOM のフォーカスがあるときに畳むと、フォーカスは折りたたみのボタンへ移る（API から畳んでも同じ。
  ほかへ移したフォーカスは奪わない）。サイズ変更の最中（ポインタ・キーボードのモード）に畳まれたら、その操作は取り消して操作前の大きさに戻る。
- 画面内に収める補正（`clamp`）は保存の高さで考える（畳んでも位置は変わらず、展開すると元のとおり）。描く高さだけがタイトルバーになる。
- window がドックに入ると `collapsed` は消え、あとで引き出した pane は展開で始まる。閉じて開き直しても `collapsed` は残る。
- ボタンのラベルは `messages.collapseWindow(title)` / `messages.expandWindow(title)`。

### 折りたたみ（ドッキング中の区画を帯にする）

分割（split）の子になっている区画（panel 1 つ、または tab グループ 1 つ）は、見出し（panel の見出し／tab 帯）の端の折りたたみのボタン
（`aria-expanded` / `aria-controls`、▾／▸）で、帯に畳める。もう一度押すと元に戻る。split そのものは畳まない。

- 帯の形: column の split の中では見出しの高さの横帯、row の split の中では同じ幅の縦帯（題名は `writing-mode: vertical-rl`）。
  アイコン・題名（tab グループは前面のタブの題名）・展開ボタンだけが出る。見出しの要素は畳んでも同じなので、ボタンはフォーカスを保つ。
- 空いた場所は同じ split の開いている区画へ、今の比のまま分かれる。保存の `sizes` は書き換えない（展開すると元の比に戻る）。
  畳んだ区画に接する境界線（divider）はドラッグ・キーボードとも動かせない（`aria-disabled`）。ほかの divider の移動量は、帯を除いた
  開いている区画が分け合う幅で比に直す。
- 全部は畳めない: split の中で最後に開いている区画と、親が split でない区画（木のいちばん上の単独の区画）は畳めない（ボタンは disabled）。
  隣が閉じるなどで畳んだ区画が開いている兄弟を失う、または親が split でなくなったときは、`collapsed` を自動で外す（`layout` を代入するたびに整える）。
- `dock.isDockedCollapsed(nodeId)` / `dock.canCollapseDocked(nodeId)` / `dock.setDockedCollapsed(nodeId, collapsed)`（浮動の `isCollapsed` / `setCollapsed` とは別）。
  `nodeId` は panel または tab グループの id。畳めないときの `setDockedCollapsed(…, true)` は何もしない。`DockPanelNode.collapsed?` / `DockTabGroupNode.collapsed?: boolean` は
  `true` のときだけ書き出す（古い JSON は「展開」で読め、`version` は 2 のまま）。
- 畳んでいる間、中身は破棄せず `hidden` + `inert`（`beforePanelChange` / `keepMounted` は関係しない）。中にあった DOM のフォーカスは折りたたみのボタンへ移る
  （API から畳んでも同じ。ほかのフォーカスは奪わない）。divider の操作の最中にそれに接する区画が畳まれたら、その操作は取り消して元の比に戻る。
- 帯はドロップ先にならず（そこへのドロップは何も起きない）、帯からのドラッグもできない。畳んでいる間はタブが見えないので、中のタブは引き出せない。
  隣の区画の十字や外周のボタンへのドロップはできる。中身のタブが閉じられて 1 枚になっても畳んだままで、タブを足す（中央へのドロップ）と展開される。
- `dock.show(id)` / `host.showPanel(id)` / `host.setPanelVisible(id, true)` で、畳んだ区画にある pane（や、そこへ戻す pane）を出すと、その区画は展開される。
- 浮動 ⇔ ドッキングの移動、閉じて開き直し、表示メニューで隠して戻すとき、`collapsed` は持ち越さない（引き出した pane は展開で始まる。元の置き場所の記憶（slot）にも持たない）。
- ボタンのラベルは `messages.collapsePane(title)` / `messages.expandPane(title)`。見た目が変わるので、docked の pane を写す visual の基準画像は再生成が要る。

### 自動で隠す（ピン、#694 PR-3）

Visual Studio・GX Works3 の「自動的に隠す」と同じ。ドッキング中の区画（panel 1 つ、またはタブの組）の見出しのピン（📌）を
押すと、その区画は木から抜けて host の縁の帯に入る。帯のタブを押すと、その pane が縁からドッキング中の木の上に重なって
引き出される。引き出した pane の見出しのピン（横に寝た 📌）を押すと、元の場所へ戻る。

- どの縁に入るか: メイン区画（`capabilities` の `close`・`move`・`undock` がすべて `false` の pane の区画。無ければ木の中心）から
  見た区画の中心の向き。分割の比から測り（DOM は見ない）、ずれの大きい軸の側。左右の帯は縦（題名は縦書き）、上下は横。
  帯のある縁の分だけ、ドッキング中の木は内側に寄る。タブの組は帯の中でタブが並んで入る。
- 引き出す: 帯のタブを押す（載せるだけでは開かない。タッチを考えて押して開く）。フォーカスは引き出した pane の中へ移る。
  もう一度押す・外を押す・Esc・フォーカスが外へ出る、で引っ込める。引っ込めるときフォーカスが中にあれば、押した帯のタブへ戻す
  （ほかへ移ったフォーカスは奪わない）。top layer（開いている `dialog`・`[popover]`。メニューや確認ダイアログ）の中のクリックや
  フォーカスは「外」と見なさない。消費済み（`defaultPrevented`）・IME 変換中・top layer の中の Esc では引っ込めない。
- 中身: 引き出している pane と `keepMounted` の pane だけを描く（`keepMounted` は引っ込めても `hidden` + `inert` で残る）。それ以外は
  引き出すたびに作り直す。**引き出す・引っ込めるは `beforePanelChange` に聞かない**（畳んだ帯の展開と同じ「見せる」操作）。
  下書きを守りたい pane は `keepMounted` にする。
- `beforePanelChange`: 木から帯へ・帯から木へは構造の変更なので聞く。押し出される pane（縮む分割の残る側、戻すときに包まれる隣）を
  `reparent` で先に、次に区画の中で中身を描いている pane を `{ kind: 'auto-hide', to: 'band' | 'tree', remount: true }` で聞く
  （木と帯では描く親が違うので、`keepMounted` でも作り直す）。承認と適用の間に構造（引き出している pane も含む）が変わったら `stale`。
- 帯の pane の ✕ は、ほかの pane と同じく hide / close（`beforePanelChange` の `hide` / `close`、`remount: true`）。その pane は帯から抜け、
  区画の元の場所を覚えた閉じた浮動 window になる。`show(id)` / `showPanel(id)` は、帯の pane を引き出す（聞かない）。
- ドラッグ: 帯と引き出した pane はドラッグ元にならず、ドロップ先にもならない（`data-dock-no-drop`。そこへのドロップは何も起きない）。
  外周のボタン・ほかの区画の十字はそのまま使える（ドラッグを始める押下で、引き出した pane は引っ込む）。帯の pane を動かすときは、
  ピンで戻してからドラッグする。引き出した pane に pop-out のボタンは出さない。
- 保存: `DockLayout.autoHidden?: DockAutoHidden[]`（`{ node, edge, slot, size? }`）。空なら書き出さない。古い JSON はそのまま読める
  （`version` は 2 のまま）。`validateDockLayout` は区画の形・縁・slot・`size`（0 より大きく 1 以下）と、木・浮動と id が重ならないことを確かめる。
  引き出しているかどうかは保存しない。
- API: `dock.autoHidden` / `dock.isAutoHidden(id)` / `dock.autoHideRegion(id, { edge?, size?, mainId? })` / `dock.restoreAutoHidden(id)`
  （どちらも聞かない）、`dock.flyoutPanel` / `dock.openFlyout(id)` / `dock.closeFlyout()`、`host.autoHidePanel(id)` / `host.pinPanel(id)`
  （`beforePanelChange` を通す）。`dock.panels` の行は `autoHidden: true`（`placement: 'docked'`・`visible: true`）。純関数 `autoHideEdge` /
  `mainRegionId` / `regionOf` / `removeRegion` / `captureRegionSlot` / `restoreRegionSlot` と定数 `AUTO_HIDE_FLYOUT_RATIO`（引き出す幅の既定 0.3）。
- 文言: `messages.autoHidePane(title)` / `pinPane(title)` / `autoHideBand(edge)`。
- 狭い幅・キオスク・Tauri の pop-out では特別な扱いをしない（帯と引き出しはそのまま。pop-out 中の pane は木にいないのでピンも出ない）。
  引き出した pane の幅は、隠したときの区画の幅（無ければ既定）で、ドラッグでは変えられない。

### IME 変換中は構造変更を保留する

`isStructureChangeDeferred()` が `true` のあいだ（省略時: document で `compositionstart` があって
`compositionend` がまだ来ておらず、その要素がまだ文書にあってフォーカスを持つあいだ）:

- `drag`（dock / undock になりうるドラッグ）は始めない。浮動 window の resize・キーボードの移動 / サイズ変更・
  divider は始める（中身の DOM を壊さない）。
- 構造変更の要求（タブのクリック・✕・`closePanel` など、変換中に確定したドラッグも）は、聞かず・変えずに 1 つ
  だけ持っておき（要求を作った順で新しいほうを残し、古いほうは `superseded`。遅れて許可が返った古い要求が、持っている新しい要求を追い出すことはない。すでに古くなった許可は持たずに `stale`）、document の `compositionend` / `focusout` の次の
  タスクで改めて `beforePanelChange` に聞いて進める。独自の判定を渡したときは、判定が `false` になったら
  `resumeDeferredChange()` を呼ぶ（`compositionend` / `focusout` でも試す）。DOM を壊して変換を戻せるとは仮定しない。
- 保留は、非同期の答えが返ったときにも確かめ直す。答えを待つあいだに変換が始まったら、許可は同じように持って
  おき、変換が終わってから（聞き直さずに）適用する。持っているあいだにアプリが構造を変えたら、その要求は
  `stale` になる（保留した時点の構造の世代と比べる）。

### どれが先に効くか

1. `capabilities` — 操作の口そのもの（✕ を出さない・ドラッグにしない）。
2. `isStructureChangeDeferred` — `drag` を始めない（変換中）。
3. `canStartGesture` — 操作を始めるか（`drag` は閾値を越えたとき）。
4. `beforePanelChange` — 操作が確定したとき・ボタンを押したときに、layout を変えるか。

## 3 ペインを dock に並べる（`ThreePaneDock`、#663 ④）

`@banto/ui` の固定の `ThreePaneLayout` と同じ中身（左 = 対象を選ぶ・中央 = 作業・右 = 詳細）を dock のパネルとして
並べる部品（[three-pane-dock-plan](../../docs/design/three-pane-dock-plan.md) §4.1）。利用者は左右を浮かせ・別の場所に
ドッキングし直し・タブにまとめ・自動で隠せる。`ThreePaneLayout` と意味が同じ props は同じ名前。

```svelte
<script lang="ts">
	import { ThreePaneDock, createDockState } from '@banto/dock-svelte';

	const dock = createDockState(); // 保存したいときは自分で持つ（下の「保存」）
	let threePane: ReturnType<typeof ThreePaneDock> | undefined = $state();
	let leftOpen = $state(true);
	const viewItems = $derived(
		threePane?.viewMenuItems({ resetLayout: m['dashboard.resetLayout']() }) ?? []
	);
</script>

<ThreePaneDock
	bind:this={threePane}
	{dock}
	bind:leftOpen
	panels={[{ id: 'log', title: 'ログ', content: log, initial: { edge: 'bottom' } }]}
	messages={{
		threePaneLeft: () => '一覧',
		threePaneCenter: () => '作業',
		threePaneRight: () => '詳細'
	}}
>
	{#snippet left()}…{/snippet}
	{#snippet right()}…{/snippet}
	<Workspace />
</ThreePaneDock>
```

- **中央（`children`）はメイン区画**: 据え置き（`persistent`、中身の DOM を作り直さない）で、capabilities は
  `close`・`move`・`undock`・`dropCenter`・`autoHide`・`collapse` がすべて `false`（アプリの `capabilities` より優先）。
  閉じない・畳まない・自動で隠さない・浮かせない。左右と追加パネルはアプリの `capabilities` / `persistent` に従う。
- **パネルの id** は `left`・`center`・`right` に固定。追加パネル（`panels`、`ThreePaneExtraPanel`）の id がこれと重なる・
  重複すると例外（開発時の誤り）。追加パネルは `initial` で最初の置き場を決める（`hidden` = 閉じた浮動〔既定〕・
  `floating` = 開いた浮動・`{ edge }` = 外周にドッキング）。以後は保存したレイアウトに従う。
- **`panels` を後から変えたとき**: タイトル・アイコンだけの違いは聞かずに直す。構造が変わる（追加パネルを外して、
  それを包んでいた split が消え、残りが組み直される・パネルを足す）ときは `resetLayout` と同じく
  `DockHost.replaceLayout` を通す（`beforePanelChange` と IME の変換中の保留が効く。消えた区画にあったフォーカスは
  中央へ）。拒否されたら（`invalid` / `disposed` も）レイアウトはそのまま: 外したパネルは中身の無い区画として残り、
  自動では再試行しない。次に `panels`・文言が変わったとき、または `resetLayout` / `restoreLayout` で照らし直す。
  承認待ちの間に構造が変わった（`stale`）ときは、新しいレイアウトに照らして聞き直す。承認待ちの間にまた `panels` が
  変わると、新しいほうが引き継ぐ: 行き先が同じなら同じ依頼のまま、違えば古い依頼は適用の直前に `stale` になる。
  外したパネルを承認の前に元へ戻した（今の配置のままでよくなった）ときも、古い依頼は承認されても適用しない。
- **既定レイアウト**は純関数 `threePaneDockLayout({ hostWidth, leftWidth, rightWidth, panels })`: 左 | 中央 | 右の行で、
  `leftWidth`（既定 280）・`rightWidth`（既定 360）の px をマウント時に測った幅の比率に直す（中央が 320px を下回るなら
  左右を縮める）。マウント時の `leftOpen`/`rightOpen` が `false` の側は隠れた状態で始まる（元の場所を覚える）。
- **`leftOpen` / `rightOpen`（bindable）は「表示」メニューのチェックと同じ 1 か所の状態**（`dock.panels` の `visible`）。
  ✕・メニュー・メソッドのどれで変わっても書き戻る。アプリが書き換えると `setVisible` と同じ依頼になり、
  `beforePanelChange` が断ったら本当の状態が書き戻る。承認待ちの間に元の値へ戻すと（`false` → `true` など）、
  古い依頼は承認されても適用しない（`stale`）。
- **操作の口**（`bind:this` のメソッド。すべて `DockHost` を通るので `beforePanelChange` が効く）:

  | メソッド                           | 中身                                                                                                         | 戻り値                                                 |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
  | `isVisible(id)`                    | 画面にあるか（reactive）                                                                                     | `boolean`                                              |
  | `setVisible(id, v)` / `toggle(id)` | 表示・非表示（`DockHost.setPanelVisible`）。中央を隠すのは `refused`。隠したパネルにあったフォーカスは中央へ | `DockPanelChangeOutcome \| 'unavailable'`              |
  | `float(id)` / `move(id, target)`   | 浮かせる・移す（`DockHost.movePanel`）                                                                       | `DockMoveOutcome`                                      |
  | `dockBack(id)`                     | 開いた浮動のパネルを戻す（下記）                                                                             | `DockMoveOutcome`                                      |
  | `resetLayout()`                    | 既定のレイアウトに戻す（確認は出さない）                                                                     | `DockPanelChangeOutcome \| 'invalid' \| 'unavailable'` |
  | `restoreLayout(saved)`             | 保存値をマウント後に読み込む                                                                                 | `{ status, outcome }`                                  |
  | `layoutSnapshot()`                 | 保存する値                                                                                                   | `ThreePaneSavedLayout`                                 |
  | `viewMenuItems(labels)`            | 「表示」メニューの項目                                                                                       | `ThreePaneViewMenuItem[]`                              |

  同じ変更を承認待ちの間にもう一度呼ぶ（`toggle` の連打）と、同じ 1 つの依頼を共有する。`setVisible` を承認待ちの間に
  逆の値で呼ぶと、最新の値が勝つ: 古い依頼は適用の直前に `stale` になる（逆の値が今の状態と同じで、新しく聞くことが
  無くても）。`resetLayout` の承認待ちの間に
  ほかの操作でレイアウトが変わると、`resetLayout` は `stale` で何も変えない。`restoreLayout` を承認待ちの間に別の値で
  もう一度呼ぶと（聞く変更の一覧が同じでも、行き先のレイアウトが違えば）別々に聞き、先に適用されたほうが勝って、
  もう一方は `stale`。行き先が同じなら 1 つの依頼を共有する。

- **`dockBack(id)` が戻れないとき**（[#721](https://github.com/tyaro/banto/issues/721)）: まず浮かせる前の場所
  （`movePanel(id, { back: true })`）へ戻す。覚えている場所が無い（この部品のマウント前に浮かせた・同じ入れ物の
  パネルを全部外して入れ物が消えた）ときは、そのパネルの**既定の側の外周**（左 = `left`、右 = `right`、追加パネルは
  `initial` の `edge`）にドッキングする。どちらもできない（`edge` の無い追加パネル）・開いた浮動でないときは
  `unavailable` を返し、浮動のまま何も変えない。
- **「表示」メニュー**: `viewMenuItems({ resetLayout })` は `{ kind: 'checkbox' | 'action' | 'separator', id, label, checked?, onSelect }`
  の素の配列（`@banto/ui` の `HeaderNavMenuItem` と構造で互換。型は import しない）。並びは左・右・追加パネル（中央は
  出さない）、区切り、「レイアウトを既定に戻す」。チェックは `dock.panels` の `visible` から読む（`$derived` の中で呼ぶ）。
  id は `panel:<パネルの id>`・`separator`・`reset-layout`。トグルの帯は出さない（ツールバーから `toggle` を呼ぶ）。
- **文言**: `messages` は `DockMessages` に `threePaneLeft`・`threePaneCenter`・`threePaneRight`（パネルのタイトルと
  メニューの項目名）を足したもの。`@banto/ui` の `UiMessages` と同じキーなので、同じ関数を両方に渡せる。
- **保存**（実際の読み書きはアプリ、three-pane-dock-plan §4.4）: 保存する値は `layoutSnapshot()` の
  `{ schema: 1, panels, layout }`。最初の描画で使う値は `initialLayout` に渡す（`ThreePaneSavedLayout`・`DockLayout`・
  それらの JSON 文字列のどれでもよい。マウント時に 1 回だけ読む）。マウント後に届いた値は `restoreLayout(saved)`。
  どちらも `reconcileThreePaneLayout` で今のパネルの集合と照らす: `validateDockLayout` に通らない値は既定、知らない id は
  捨てる、足りない左右は既定の側に、足りない追加パネルは閉じた浮動で足す、タイトルは今の文言に直す、中央が畳まれて
  いるなら展開し、タブの組に入っている（裏でも表でも）なら組から抜いて組の隣に分割で置く（組の場所と比率は保ち、
  左のパネルを含む組なら中央はその右、ほかは左。`dropCenter: false` は新しい合流しか止めないので、組のままだと
  別のタブを押して中央を隠せてしまう）、中央が木に無い（浮動・閉じている・自動で隠れている）なら既定（`status: 'default'`）。
  隠れている（元の場所を覚えた）パネルを知らない id として捨てたときは、残る隠れたパネルの `share` からその分を除く
  （#741。結果は保存値と同じ形なので、`initialLayout` / `hydrate` / `replaceLayout(..., { saved: true })` で入れる。
  元にした `dock.layout` へ `dock.layout = ...` で書き戻すと、setter がもう一度除く）。
  保存のきっかけは、自分で持った `dock` の `dock.layout` を `$effect` で見る。保存するのは `layoutSnapshot()` で、
  `dock.serialize()` ではない（狭い表示のあいだ `dock.layout` は一時のレイアウト）。
- **パネル自身が入力を持つ**（追加パネルのフォームなど）ときは、`beforePanelChange` で下書きを控える（下の「pane の
  lifecycle」）。`resetLayout`・`restoreLayout` は、画面から外す・作り直す pane ごとに `hide` / `dock` / `undock` /
  `move-docked` / `tab-switch` / `auto-hide` として聞く（`DockHost.replaceLayout`）。画面に残る据え置きの pane は聞かない。
  据え置きの pane のうち、閉じた浮動 window として残るものは `hide`（`remount: false`、中身は保たれる）、置き換え先の
  レイアウトから消えるものは `close`（中身は破棄される。`closePanel` と同じ）。
- **狭い表示**（three-pane-dock-plan §4.5・§9 Q7）: 部品自身の幅が `narrowBreakpoint`（既定 900）以下、または
  `narrowOverride` が `true` のとき、保存済みの配置には触れずに一時のレイアウト（純関数 `threePaneNarrowLayout`）で表示する:
  中央だけをドッキングし、見えていた左右は端の自動で隠す帯へ（引き出しがドロワーの代わり）、浮動と追加パネルは隠す。
  「表示」メニューで帯の pane を選ぶと引き出し、隠れた pane を選ぶと帯へ置いて引き出す。狭い表示のあいだの操作は保存しない
  （`layoutSnapshot()` は控えた配置を返す。`resetLayout`・`restoreLayout` は控えを置き換える）。幅が戻れば控えた配置に戻す
  （控えが既定なら、その幅で測り直す）。切り替えは `replaceLayout` を通るので、動かす pane は `beforePanelChange` に聞く。
  拒否されたら今の表示のまま、次に境界をまたぐまで試さない。マウント直後の最初の測定が狭いときだけは聞かずに入れる
  （まだ状態が無い）。中央は据え置きなので、どちらの切り替えでも作り直さない。`narrow`（bind 用の出力）で今の表示を読める。
- **組み替え不可**（`arrange={false}`、キオスク、§9 Q4）: `DockHost` の `arrange`（上）に加えて、部品のメソッドのうち配置を
  変えるもの（`setVisible`・`toggle`・`leftOpen`/`rightOpen` の書き込み・`resetLayout` は `refused`、`float`・`dockBack`・`move` は
  `unavailable`）は何も変えない。`viewMenuItems` は空。`restoreLayout` と狭い表示への切り替えは効く（保存済みの配置を見せる
  ための操作で、利用者の組み替えではない）。

`DockHost` 単体でも、`replaceLayout(layout, { focusPanel?, isCurrent?, saved? })`（レイアウト全体の置き換えを `beforePanelChange` を通して
行う。不正な値は `invalid`。`isCurrent` は各依頼の前と適用の直前に読み直し、`false` なら `stale` で何も変えない。保存した値（`serialize()` /
`savedLayout()`）を入れるときは `saved: true` を渡す。浮かせたパネルの「元の場所に戻す」の控えを、`hydrate` と同じく入れるのと同時に捨てる。
`saved` を付けないときは、今の `dock.layout` から作った値として `dock.layout = ...` と同じに入れる（#741）: 控えは残し、木の外にある（浮かせた・隠した）
パネルを置き換えが無くしたときは、残る隠れたパネルの `share` からその分を除く。保存した値を `saved` なしで渡すと、この調整が保存値にかかって比率がずれる）と `canMovePanel(id, target)`（`movePanel` が今できるか。何も聞かず、読み上げない）を使える。

## 保存の約束（serialize / hydrate と書き込みは別）

`serialize()` は文字列を返すだけで、`hydrate(json)` は文字列を検証して layout に採るだけ。**実ストレージへの書き込み
（localStorage・設定 DB など）はアプリの責任**で、このパッケージは永続化を持たない。

- 書き込みが失敗したら「保存済み」の印（最後に成功した snapshot）を更新しない。失敗した内容を保存済みとして
  扱うと、次の起動や再試行で古い内容を新しいものと取り違える。
- 失敗した書き込みは、次の変更または再試行で最新の `serialize()` を改めて書く。成功した snapshot だけを
  読み戻しの元にする。
- `hydrate` の戻り値（`boolean`）が `false` のときは現行 layout が残っている。読み込み元（ストレージ）の値を
  「保存済み」と見なしてよいかは、この戻り値で決める。

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
