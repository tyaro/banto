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
		version: 4,
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
  浮かせた時の分割・タブの組へ、その時の比率で戻る。浮かせている間にほかの pane を動かす・隠す・浮かせるを
  はさんでも、何枚かを戻す順を変えても、同じ形・同じ比率になる（浮かせた pane が居る間の移動・ドロップは、
  その pane の元の場所を残して組む。たとえば行から 2 枚を浮かせ、残りの 1 枚を別の pane の隣へ動かしても、
  2 枚は元の行へ戻る）。レイアウトを外から入れ替えて（`dock.layout = ...`・`panels` の変更）元いた分割・タブの組が
  無くなったら既定の位置へ戻り、それも無ければ項目を出さない（下の `replaceLayout` の節）。戻し先にもドラッグと同じ制約をかける: タブの組へ戻るなら組の
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
- **押し出される pane にも聞く（#666）**: docked の木へのドロップ（dock / move-docked。押し出される側は `tab-switch` / `reparent`）と `showPanel` でドックへ
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
  受け皿が mount されたら中身の要素を移し（`Element.moveBefore()` があればそれで、無ければ `appendChild`）、外れたら預かりへ戻す。undock / dock・外周への
  ドッキング・周りの組み替え（`reparent`）・自動で隠す / ピンで戻す・タブの切替のどれでも、同じ DOM 要素・
  同じ Svelte の部品のまま（mount は 1 回）。受け皿と中身の要素は `display: contents` なので、見た目は
  `persistent` でないときと同じ。
- `keepMounted` を兼ねる（✕ は hide、隠したタブ・浮動 window でも中身が残る）。`closePanel`（close）は中身を捨て、
  次に開くと新しく mount する。`beforePanelChange` には今までどおり聞くが、その pane の変更は `remount: false`
  で、周りの組み替えで親が変わるだけのときは聞かない（作り直さないので失うものがない）。`persistent` も
  `keepMounted` と同じく適用の直前に読み直し、聞いたときと `remount` が変わったら `stale`。
- **フォーカスは組み替えの間も中の要素に残る**（`Element.moveBefore()` のある環境: Chromium 133 以降・
  それに当たる WebView2。#763）。中にフォーカスがある pane は、木を更新する直前に中身を host の中の待避場所へ
  `moveBefore` で移し、更新でできた受け皿へもう一度移すので、フォーカス中の要素は文書から外れず、`blur` /
  `focusout` は出ない（選択範囲も残る）。blur で値を確定するフォームを置いても、組み替えで確定されない。
  待避するのは **受け皿が作り直されうる更新だけ**（どの pane がどのタブの組・分割・浮動 window・自動で隠す帯に
  あるか、開閉・畳み・選択中のタブが変わったとき）。別の浮動 window の移動・リサイズや分割の境界の
  ドラッグのように位置・大きさだけが変わる更新では、編集中の pane の中身に触れない（`moveBefore` でも、
  `connectedMoveCallback` を持たないカスタム要素は切断・再接続の処理が走るため）。
- **`moveBefore` の無い環境**（古い Chromium / WebView2、対応前の Firefox・Safari）では、組み替えのときに
  フォーカス中の要素へ `blur` → `focusout` が出て、移したあと（同じ更新の後の microtask）に dock がフォーカスを
  戻すので `focus` → `focusin` も出る（そのときフォーカスが `<body>` 以外 = host やアプリが別の場所へ移して
  いたら奪わない）。これは避けられないので、**blur で確定する処理は `isDockRearranging(node)` で見分ける**:
  組み替えの直前から、フォーカスを戻し終えるまでの間、その node が組み替え中の据え置き pane の中にあれば
  `true`（その間の `blur` / `focusout` / `focus` / `focusin` のどれの中でも読める。`moveBefore` のある環境でも
  同じ区間で `true` だが、その blur 自体が出ない）。Shadow DOM の中の node は host をたどって調べる
  （入れ子・closed でも可）。`null` / `undefined` は `false`（DOM の無い SSR でも例外にならない）。

  ```ts
  import { isDockRearranging } from '@banto/dock-svelte';

  function onBlur(event: FocusEvent) {
  	if (isDockRearranging(event.currentTarget as Node)) return; // 組み替えによる blur: 確定しない
  	commit();
  }
  ```

- **スクロール位置は、組み替えとタブの切り替えの後に元へ戻る**（#768）。ブラウザは、描かれなくなった要素の
  スクロール位置を捨てる（作り直された受け皿、裏に回って `hidden` になったタブ、預かり場所）。dock は pane ごとに
  次の 2 つを控え、戻す:
  - **pane の本体**（dock が持つ、はみ出すとスクロールする枠。docked の pane・タブの組・浮動 window・自動で隠した
    pane の引き出し）の縦・横の位置。タブの組は本体を 1 つ共有するので、位置は **タブごと**: 裏へ回したタブを
    表へ戻すと、その pane の位置に戻る（一度もスクロールしていない pane は先頭。前に表にあったタブの位置を
    引き継がない）。まだ一度も画面に出ていない pane には控えが無いので、表に出した時点で先頭にする（前に表に
    あったタブの位置は、短い pane でブラウザが丸めた値も含めて引き継がない）。そのあとでアプリが設定した
    初期位置はそのまま残る。
  - **中身の側でスクロールしている要素**（`overflow: auto` の一覧など）の縦・横の位置。Shadow DOM の中の要素は
    対象外（中身の部品で扱う）。

  控えるのは **受け皿が作り直されうる更新・タブや畳みの切り替えの直前**（上のフォーカスの待避と同じ更新）で、
  そのとき画面にある据え置き pane の位置を読み（中身の要素を一巡する。要素ごとに位置を読むだけ）、その更新が
  DOM に反映された直後（同じ flush の中。`flushSync()` や `await tick()` から戻る前）に書き戻す（`float` /
  `dockBack` / `move` / `resetLayout` / `hide` → `show` / 自動で隠す・戻す / タブの切り替え / 畳む・開く）。
  `moveBefore` の有無によらない。書き戻すのは、**その更新で表に出た・移った pane だけ**: 同じ場所に出たままの
  pane には書かない（その更新で位置が失われて先頭を読むようになった要素だけを戻す）。だから、更新を反映した
  あとでアプリが設定した位置（先頭へ戻す、初期位置にする）は、どの pane でもそのまま残る。例外は、dock の更新の
  外で中身が移ったとき（受け皿より後から中身が描かれた、など）で、控えのある位置を次の microtask で戻す。
  利用者の側で控える必要はなく、そのための口もない。戻すのは控えた数値なので、移った先が広くてはみ出さない
  ときは、ブラウザが届く範囲に丸める。
  控えは pane の id ごとに `DockHost` が持ち、**layout には入らない**（保存されない。再読み込みの後は先頭から）。
  `closePanel` で中身を捨てたら控えも捨てる。据え置きでない pane は対象外（中身を作り直すので、位置は中身の
  部品が持つ状態と同じく失われる。`beforePanelChange` の `remount: true` で控える）。

- 受け皿が無く預かりへ戻った中身（hide した pane）にはフォーカスを残さない（`<body>` へ外す）。この blur の間も
  `isDockRearranging` は `true` で、フォーカスは戻らない。隠す前に確定・確認したい値は
  `beforePanelChange`（`hide`）で扱う。
- **`iframe` は移すと読み直されることがある**（ブラウザは `appendChild` で移した `iframe` の文書を読み込み
  直す）。読み直されないのは **実際に `moveBefore` で移せた移動だけ** で、`moveBefore` のある環境でも、
  事前に待避するのは中にフォーカスがある pane に限られる。それ以外の pane は、古い受け皿が先に文書から
  外れるので `appendChild` に落ち、`iframe` は読み直される。`moveBefore` の無い環境では移すたびに読み直す。
  `iframe` やネイティブの埋め込みを持つ中身は、据え置きでも状態が残るとは限らない前提で作る。
- 位置・大きさ・倍率・ポインタ操作の状態は中身の部品が持つので残るが、`ResizeObserver` 等で受け皿の大きさを
  測る中身は、移した直後に大きさが変わることがある（新しい親の大きさになる）。

### hide と close（D4）

| 操作                              | 中身                                                                                                           | `beforePanelChange` |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| ✕ ボタン（`keepMounted` の pane） | **hide**: 浮動 window は中身を保ったまま隠す。docked の pane は閉じた浮動 window になる（そこで mount し直す） | `hide`              |
| ✕ ボタン（それ以外）              | **close**: 中身を捨てる（今までと同じ）                                                                        | `close`             |
| `host.hidePanel(id)`              | hide（上と同じ）                                                                                               | `hide`              |
| `host.closePanel(id)`             | close。`keepMounted` の pane でも中身を捨てる（隠れている中身も捨てる）。次に開くと新しく mount する           | `close`             |

どれも window の位置と寸法は残す（次の `dock.open(id)` で同じ場所に出る）。docked の pane は、ドックから隠した
印と、隠す直前の比率だけを残す（次の「表示メニュー」節の `showPanel` で**既定の位置**に出る。隠した場所は覚えない。
`dock.open(id)` は従来どおり浮動で開く）。`hidePanel` / `closePanel` /
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

- **`dock.panels`**（reactive）: layout にあるすべての pane の `{ id, title, icon?, placement, visible, onScreen }`。
  - `visible` — docked の木にある（裏のタブ・畳んだ区画の中も含む）か、帯にしまった pane か、開いた浮動 window なら
    `true`（**「閉じていない」**の意味。メニューのチェック用）。✕・`hidePanel`・ドラッグ・`hydrate` に追従する。
  - `onScreen`（#792）— **実際に画面に出ている**とき `true`。畳んだ区画の中・タブの組の裏のタブ・引き出していない
    帯の pane・タイトルバーへ畳んだ浮動・閉じた浮動は `false`（そのとき `visible` は `true` のことがある）。
    表のタブ、畳んでいない開いた浮動、今引き出している帯の pane（`flyoutPanel`）が `true`。ホストの大きさや
    ブラウザのタブが隠れているかは見ない。「見えている間だけ購読する・読む」にはこちらを使う。
  - `placement` — `'docked'` は docked の木にあるか、ドックから隠した pane で、今 `showPanel` するとドックへ出るもの
    （`dock.showPlacement(id)` と同じ答え）。`'floating'` はそれ以外の浮動 window（開閉どちらも。今は浮動で開く
    隠した pane も: 既定の位置が無い、既定の兄弟も外周の側も無い）。
  - 並び順は、その `DockState` が id を初めて見た順（最初の layout の docked の木を木の順に、続けて浮動 window を
    配列の順に。あとから増えた id は末尾）。前面化・ドック・隠す操作では並び替わらない。`hydrate` / `layout = ...`
    でも既知の id は位置を保ち、新しい id は末尾に付く。アプリ独自の順にしたいときは行をアプリで並べ替える。
- **`host.setPanelVisible(id, visible, { isCurrent? })`**: チェックを外す = ✕ と同じ（`keepMounted` の pane は hide、それ以外は close。
  `beforePanelChange` に聞き、拒否なら `refused`。`isCurrent` は適用の直前に読み直し、`false` なら `stale` で何も変えない
  — 承認待ちの間にアプリが逆を望み、それが今の状態と同じで新しく聞くことが無いときに、古い依頼を失効させる）。`capabilities` の `close: false` の pane は外さない（`refused`）。
  チェックを入れる = `showPanel`。外すときに既に隠れていれば聞かずに `applied`。拒否されたときはチェックボックスを
  `row.visible` に戻すのはメニュー側（変わらない値は Svelte が書き戻さない）。
- **`host.showPanel(id)`**: どこにあっても見える状態にする。
  - ドックから隠した pane（✕・`hidePanel` / `closePanel`・帯の pane の ✕）は、**既定のレイアウトでの位置に出す**
    （隠した場所へは戻さない）。既定のレイアウトは `dock.defaultLayout`（下の「既定の位置」）。
    - いまドックにある pane のうち、既定の木の並びでいちばん近い兄弟の隣に、既定と同じ側で入る（既定が
      `row[a, b, c]` で `a` と `c` だけあるなら、`b` はその間。タブの組の仲間がドックにあれば、その組へ既定と同じ側の
      タブとして入り、選択中のタブになる）。入れ子の既定では、兄弟が今まとまっている部分ごとの隣に入る
      （既定が `row[a, column[b, c]]` なら、`a` は `column[b, c]` の隣）。
    - 既定の兄弟が 1 つもドックに無ければ、既定の位置がある側の外周（既定で行の左端なら左の辺。`ThreePaneDock` の
      左パネルは左、`initial: { edge }` の追加パネルはその辺）に出す。
    - 既定のレイアウトが無い（`defaultLayout` を渡していない）、その pane が既定ではドックに無い、兄弟も外周の側も
      無い、のどれかなら浮動 window として開く（保存してある位置・寸法）。docked の木が空なら、木そのものになる。
    - 幅（比率）は、隠す直前にその pane が分割の中で持っていた比率 1 つだけを覚えていて、出た先の分割でその比率を
      取る（ほかの pane は互いの比を保つ）。覚えた比率が無いとき（木の全体だった、など）は、既定の比率から決める。
    - 既定の配置から隠しただけなら、**どの順で戻しても既定と同じ形**になる（比率まで元どおりになるのは、隠した逆の
      順に戻したとき）。pane を動かした後は、その時にドックにある「いちばん近い既定の兄弟」の隣に出るので、戻す順で
      形が変わることがある。
    - 浮かせた pane の「元の場所」は、ドックにある兄弟と同じに数える: 既定が `row[a, b, c]` で `b` を隠し、`a` を
      浮かせてから `b` を出すと、`b` は `a` の元の場所の隣（後ろ）に入り、`a` を元の場所へ戻すと `row[a, b, c]`。
      比率は、見えている pane の中で覚えた比率を取る（浮かせた pane の場所の分は、隠した時に増えた分だけ戻す）。
  - 閉じた浮動 window は開いて前面に、開いている浮動 window は前面に、docked の裏のタブは選択中のタブにする
    （`tab-switch` として聞く）。
  - タブグループへ選択中のタブとして戻すと、それまで選択中だった pane が画面から外れる（`keepMounted` でなければ
    unmount）。そこで先に、その pane から戻す pane への `tab-switch` として聞く（タブのクリックと同じ。拒否なら
    `refused` で隠れたまま、IME 変換中は変換が終わるまで待つ）。1 つになっていたタブグループを作り直すときは、
    残っていた pane が新しいグループに入って作り直されるので `remount: true`。
  - `keepMounted` で中身が残っている pane をドックへ戻すときは `dock` の変更（`remount: true`）としても聞く
    （`tab-switch` があればその後。2 つの答えは 1 つの判断で、`tab-switch` を許したときの構造が `dock` を
    当てるまでに変わったら（アプリが別のタブを選んだなど）`stale`）。分割へ出すときに新しい分割を隣の pane
    （またはタブの組）の周りに作ると、隣の中身は作り直されるので、先にその pane の `reparent` として聞く
    （#666、上の「押し出される pane にも聞く」）。それ以外（既にある分割へ戻す・木が空・浮動で開く）は
    `dock.open` と同じく聞かない。
  - DOM のフォーカスは動かさない（前面化・選択中のタブだけ）。メニューを閉じたあとのフォーカスはメニュー側の
    約束に従い、pane の中へ移すかはアプリが決める。
- **既定の位置（`dock.defaultLayout`）**: `DockState` の欄 `defaultLayout: DockLayout | null`（既定は `null`）に、
  アプリの既定のレイアウトを入れておく。読むのは `docked` の木だけで、`layout` には入らず、**保存されない**
  （`serialize()` / `hydrate()` を通らない。マウントのたびにアプリが入れる）。既定の木の分割・タブの組の id は、
  重ならない固定の値にする（戻すときに同じ id の分割・組を作り直す。id が今の木で使われていれば新しく振る）。
  `ThreePaneDock` は自分の既定（左右とも開いた形）を入れるので、アプリは何もしなくてよい。`DockHost` を直に使う
  アプリが入れなければ、ドックから隠した pane は浮動で開く。
  ```ts
  const dock = createDockState();
  dock.defaultLayout = myDefaultLayout(); // reset / 初回に入れるのと同じ DockLayout
  ```
- ドックから隠した pane は、閉じた浮動 window に `dockShare`（隠す直前の比率。`0 <= n <= 1`、`1` は「覚えた比率
  なし」）を持つ。これが「ドックから隠した」印で、`serialize()` / `hydrate()` を通る。`dockShare` の無い閉じた
  window は浮動で開く。**前の版の `dockSlot`（戻す場所）は廃止**（破壊的変更）: 型から消え、古い JSON にあっても
  読まずに捨てる（その pane は浮動で開く。layout 全体は読める）。
- **保存する配置の `version` は 4 だけ**（#782 PR8b、破壊的変更）。`DockLayout['version']` の型は `4` で、`dock.layout` に
  入れるたび・`serialize()`・`layoutSnapshot()` は 4 を書く。`validateDockLayout` は 1〜3 を `version` の issue で断る
  （`hydrate` は `false`、`createDockState(layout)` は空の配置）。前の版で保存した配置は読まれず、既定に戻る。
  端の帯（自動で隠す）の区画は slot を持たない: 戻る場所は配置の欄 `dockedWithAutoHidden` に入る（下の「自動で隠す」）。
- `DockState` だけで扱う口もある（`beforePanelChange` には聞かない）: `dock.dismiss(id)`（隠す。docked・帯の pane なら
  `dockShare` を残す）・`dock.show(id)`（上の `showPanel` の layout の部分。戻り値は `'docked'` / `'floating'` / `null`）・
  `dock.showPlacement(id)`（`show` がどこに出すか）・`dock.showTabSwitch(id)`（`show` が選択中から外す pane）・
  `dock.shownTree(id)`（`show` がドックへ出すときの木。`null` は浮動で開く。この 3 つは同じ計算を読む）・
  `dock.isVisible(id)`（閉じていないか）・`dock.isOnScreen(id)`（実際に画面に出ているか、#792。reactive）。
- `dock.isOpen(id)` / `dock.open(id)` / `dock.close(id)` は従来どおり**浮動 window だけ**を見る（docked の id には
  `false` / 何もしない）。`dock.open(id)` でドックから隠した pane を開くと浮動で開き、`dockShare` は捨てる（次に閉じて `show` しても浮動）。
  `dock.ensureWindow` は docked の id を浮動として足さなくなった（id の重複を作っていた）。

### 錠（浮動 window の位置と大きさの固定）

浮動 window のタイトルバーの錠のボタン（`aria-pressed`、🔓／🔒）を押すと、その window の位置と大きさが固定される。固定中は
タイトルバーのドラッグ・リサイズのハンドル・キーボードの移動 / サイズ変更ができない（ハンドルと両ボタンは出ない）。
中のタブの出し入れ・閉じる・前面に出すは効く。画面内に収める補正（`clamp`）も固定中に効く。#694 PR-3 まではピンのアイコンだったが、
ピンは「自動で隠す」（ドッキング中の区画、下の節）の意味に変わったので、錠に替えた。

- `dock.isLocked(id)` / `dock.setLocked(id, locked)`。`FloatingWindow.locked?: boolean` は `true` のときだけ書き出す
  （`false` は項目ごと消す）。無い古い JSON は「固定なし」で読める。
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
  （`false` は項目ごと消す）。無い古い JSON は「展開」で読める。保存の `height` は畳んでも変えない。
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
  `true` のときだけ書き出す（無い配置は「展開」で読める）。
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
  ドックから隠した閉じた浮動 window になる（次に `showPanel` すると既定の位置に出る。帯へは戻らない）。`show(id)` / `showPanel(id)` は、帯の pane を引き出す（聞かない）。
- ドラッグ: 帯と引き出した pane はドラッグ元にならず、ドロップ先にもならない（`data-dock-no-drop`。そこへのドロップは何も起きない）。
  外周のボタン・ほかの区画の十字はそのまま使える（ドラッグを始める押下で、引き出した pane は引っ込む）。帯の pane を動かすときは、
  ピンで戻してからドラッグする。引き出した pane に pop-out のボタンは出さない。
- 戻る場所と比率（#782 PR8b）: ピンで戻すと、区画は帯へ送ったときの分割・タブの組へ、**その分割の中で持っていた取り分**で
  戻る（浮かせた pane の「元の場所に戻す」と同じ規則）。帯に居る間にほかの pane を動かす・隠す・浮かせる・戻す、仕切りを
  ドラッグする（見えている pane どうしの比だけが変わる）をはさんでも、何をどの順で戻しても同じ木・同じ比率になる。タブの組は
  組ごと帯へ入り、同じ id の組として戻る（帯の間に、その組の既定の位置へほかの pane を出すと、その pane は帯の組の場所の隣に
  入り、帯の区画を戻すと 1 つの組になる。帯のものでない pane が 2 枚そろって木に組として出ている間は、木の組が id を持ち、
  `dock.autoHidden[].node.id` は `<id>:band` になる。帯の区画は pane の id で引く: `restoreAutoHidden(paneId)`）。元の分割・タブの組が外からの代入（`dock.layout = ...`）で無くなったとき、場所の
  無い配置を読んだときは、区画の pane を 1 枚ずつ既定の位置（`dock.defaultLayout`）へ入れ、既定の位置の無い pane はまとめて
  帯の縁（`edge`）に沿って入れる（比率は入れた先で配り直す）。
- 保存: `DockLayout.autoHidden?: DockAutoHidden[]`（`{ node, edge, size? }`）。空なら書き出さない。`validateDockLayout` は
  区画の形・縁・`size`（0 より大きく 1 以下）と、木・浮動と id が重ならないことを確かめる。引き出しているかどうかは保存しない。
  戻る場所は、配置の欄 `dockedWithAutoHidden?`（ドッキングの木に、帯の区画の pane を `away: true`・`band: true` の葉として
  元の場所に入れた木。分割の `sizes` はその葉の取り分も含む。浮かせた pane の場所は入らない）。`DockState` が代入のたびに
  書き、帯に場所のある区画が無ければ書かない。**アプリは組み立てない・書き換えない**（`serialize()` の値をそのまま保存する）。
  `hydrate`・`createDockState(saved)`・`replaceLayout(layout, { saved: true })` は、この木から印の付いた葉を除くと `docked` と
  同じ形（id と入れ子）になるときだけ読み、違えばこの欄だけを捨てる（区画は既定の位置 → 帯の縁へ戻る）。`dock.layout = ...`
  の代入では読まない。
- API: `dock.autoHidden` / `dock.isAutoHidden(id)` / `dock.autoHideRegion(id, { edge?, size?, mainId? })` / `dock.restoreAutoHidden(id)`
  （どちらも聞かない）、`dock.flyoutPanel` / `dock.openFlyout(id)` / `dock.closeFlyout()`、`host.autoHidePanel(id)` / `host.pinPanel(id)`
  （`beforePanelChange` を通す）。`dock.panels` の行は `autoHidden: true`（`placement: 'docked'`・`visible: true`）。純関数 `autoHideEdge` /
  `mainRegionId` / `regionOf` / `removeRegion` と定数 `AUTO_HIDE_FLYOUT_RATIO`（引き出す幅の既定 0.3）。
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
  左右を縮める）。マウント時の `leftOpen`/`rightOpen` が `false` の側は隠れた状態で始まる（開くと既定の位置＝中央の隣に出る）。
  `ThreePaneDock` は、左右とも開いた形の既定を `dock.defaultLayout` に入れる（パネルの集合が変わるたびに入れ直す）。
  左右を開閉しても、動かした後に隠しても、開くときは既定の側に出る。隠す前に広げた幅は覚えている。初期が `hidden` /
  `floating` の追加パネルは既定ではドックに無いので、ドックへ入れてから隠しても、開くと浮動で出る。
- **左右を px で保つ**（#892）: `sideWidthUnit="px"` を渡すと、部品の幅が変わっても左右の区画は px のまま、中央が
  伸び縮みする（既定の `'share'` は比率のままで、左右も一緒に伸び縮みする）。対象は中央を含む行（根の行、または
  下の外周の追加パネルなど列の下にある一番外側の行）の、中央の区画以外の区画。中央は 320px を保ち、足りなければ左右を
  同じ割合で縮める（どれも 120px か自分の幅を下回らない。それでも入らない幅では中央が 1 割まで縮む）。利用者が仕切りを
  動かすとその px を新しい幅として保つ。片側を隠すと残りの区画は px のまま中央が広がり、戻すと前の px で出る（マウント時に
  隠れていた側は `leftWidth` / `rightWidth`）。狭い表示の間は何もせず、広い表示へ戻るときに当てる。保存形式は変わらない
  （version 4 の比率）: 復元・`resetLayout` のときは、その時の部品の幅で比率から px を読む（保存した時と幅が違えば px も
  違う）。幅の変化だけによる直しは `onLayoutCommit` に報告しない（利用者の操作に伴う直しは、その操作の報告に含まれる）。
  窓の幅が変わるたびに `dock.layout` を代入する回り道は要らない。
- **`leftOpen` / `rightOpen`（bindable）は「表示」メニューのチェックと同じ 1 か所の状態**（`dock.panels` の `visible`）。
  ✕・メニュー・メソッドのどれで変わっても書き戻る。アプリが書き換えると `setVisible` と同じ依頼になり、
  `beforePanelChange` が断ったら本当の状態が書き戻る。承認待ちの間に元の値へ戻すと（`false` → `true` など）、
  古い依頼は承認されても適用しない（`stale`）。
- **操作の口**（`bind:this` のメソッド。すべて `DockHost` を通るので `beforePanelChange` が効く）:

  | メソッド                           | 中身                                                                                                         | 戻り値                                                 |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
  | `isVisible(id)`                    | 閉じていないか（reactive）                                                                                   | `boolean`                                              |
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
  隠れているパネルは場所を覚えないので、知らない id として捨てても、残る隠れたパネルには影響しない。
  保存のきっかけは `onLayoutCommit(saved, reason)`（#791。下の「保存してよい配置の確定」）。届く `saved` は
  `layoutSnapshot()` と同じ値で、`dock.serialize()` ではない（狭い表示のあいだ `dock.layout` は一時のレイアウト）。
  `dock.layout` を `$effect` で見て `layoutSnapshot()` を保存する形も動く（狭い表示の控えは、配置を入れるのと同じ
  ステップで確定するので、確定前の値は読めない）が、ドラッグの途中の配置も保存することになる。
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

`DockHost` 単体でも、`replaceLayout(layout, { focusPanel?, isCurrent?, saved?, commit?, applied? })`（`commit`・`applied` は下の「保存してよい配置の確定」。レイアウト全体の置き換えを `beforePanelChange` を通して
行う。不正な値は `invalid`。`isCurrent` は各依頼の前と適用の直前に読み直し、`false` なら `stale` で何も変えない。保存した値（`serialize()` /
`savedLayout()`）を入れるときは `saved: true` を渡す。浮かせたパネルの「元の場所に戻す」の控えを、`hydrate` と同じく入れるのと同時に捨てる。
`saved` を付けないときは、今の `dock.layout` から作った値として `dock.layout = ...` と同じに入れる（#741）: 控えは残す。
浮かせたパネルの「元の場所に戻す」は、置き換えが何を動かしたかを推し量らない（#782 PR7）: 元いた分割・タブの組が、置き換えの後の木に
同じ id で残っていれば、その中の元の位置（子が減っていれば端）へ、そこで持っていた比率で戻る。残っていなければ既定の位置
（`dock.defaultLayout`）へ戻り、既定の位置も無ければ項目を出さない。置き換えで外した・動かしたパネルの取り分を、浮かせたパネルへ配り直すことは
しない。分割・タブの組の id は、置き換えのたびに振り直さず、そのまま渡す。保存した値を `saved` なしで渡すと、今の配置の控えが保存値の木に当てはめられる）と `canMovePanel(id, target)`（`movePanel` が今できるか。何も聞かず、読み上げない）を使える。

`DockHost.cancelGesture(): boolean`（#796）は、進行中の操作（ドラッグ・リサイズ・仕切りの移動）を取り消して対象を元に戻す。取り消したら `true`、
無ければ `false` で何も起こらない。`onGestureEnd` へは `('cancel', 'api')` で 1 回届く。`replaceLayout`（`ThreePaneDock` の `resetLayout` / `restoreLayout`
を含む）は、不正でない値なら `beforePanelChange` に聞く前にこれを呼ぶ（操作中の配置ではなく、元に戻った配置に対して聞く）。拒否・`stale` になっても
取り消した操作は戻らない。`invalid` のときは取り消さない。
`replaceLayout` が処理中（`beforePanelChange` の承認待ちを含む）の間は、新しい操作も始まらない（`canStartGesture` を呼ぶ前に止める）。並行して複数あれば、最後の 1 件が返るまで続く。

### 保存してよい配置の確定（`onLayoutCommit`、#791）

`DockHost` と `ThreePaneDock` の prop `onLayoutCommit` は、「保存してよい配置が確定した」ときに呼ばれる。保存の
きっかけはこれで受ける（`dock.serialize()` / `layoutSnapshot()` を `$effect` で読むと、ドラッグの途中の配置も拾う）。

| 部品            | 形                                                                                                                     | 渡る値                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `DockHost`      | `(layout: DockLayout, reason: DockLayoutCommitReason) => void`（`'user' \| 'reset'`）                                  | `dock.serialize()` と同じ配置（素のコピー） |
| `ThreePaneDock` | `(saved: ThreePaneSavedLayout, reason: ThreePaneLayoutCommitReason) => void`（`'user' \| 'reset' \| 'narrow-switch'`） | `layoutSnapshot()` と同じ値                 |

- **呼ばれる時機**: 確定点で、保存する値が**前回の通知（または最後の復元・マウント時の値）から変わっていたら 1 回**。
  確定点は、ポインターとキーボードの操作の終わり（`onGestureEnd` の直前。ドラッグ 1 回につき 1 回、仕切りのキーボード
  操作は 1 押しごと）と、操作中でないときの変更の次の tick（部品のメソッド `showPanel`・`setPanelVisible`・`movePanel`
  など、✕・タブ・ピン・畳む・ロックのボタン、アプリが `DockState` を直接呼んだ変更。`hydrate` も含む）。同じ tick の
  複数の変更は 1 回にまとまる。部品が外れるときにまだ通知していない変更があれば、そこで通知する。
- **理由**: `'user'` は「復元でも reset でもない確定」（API 経由の変更も含む）。`'reset'` は
  `ThreePaneDock.resetLayout()` が適用されたとき（`DockHost` では `replaceLayout(next, { commit: 'reset' })`）で、
  **値が同じでも毎回 1 回**届く。消費側は既定を保存するか、保存を消すかを選べる（値が同じでも届くのは `'reset'` だけ。
  `replaceLayout(next, { commit: 'user' })` は、ほかの `'user'` と同じく値が変わっていたときだけ届く）。`'narrow-switch'` は狭い ⇄ 広いの
  切り替えで保存する値が変わったとき（控えが既定で、戻った幅で測り直したとき。値が同じなら呼ばない）。
- **呼ばれない場合**: 操作の途中（ドラッグ中の 1 歩ごと）、取り消し・`beforePanelChange` の拒否・`stale`（配置が
  変わらない）、復元（`initialLayout`・`restoreLayout`、`DockHost` では `commit` なしの `replaceLayout`。その値が次の
  比較の基準になる）、マウント時の既定の測り直し、`ThreePaneDock` の `panels`・文言の変更への追従、狭い表示への操作
  （保存しない配置）。
- `DockHost` を直接使い、マウント後に `dock.hydrate(saved)` で復元すると `'user'` で 1 回届く（`DockState` の直接の
  変更と見分けられない）。通知なしで入れるなら `replaceLayout(layout, { saved: true })`、またはマウント前に入れる。
- `replaceLayout` の `applied`（`options.applied?: () => void`）は、配置を入れたのと同じステップで、通知の前に呼ばれる。
  配置の横に状態を持つ呼び出し側（`ThreePaneDock` の狭い表示の控え）が、新しい配置と古い状態の組を誰にも読ませない
  ために使う。
- **同じ配置への `replaceLayout` が重なったとき**: 承認待ちの間に同じ配置をもう一度頼んだ呼び出しが、待っている 1 件を
  共有するのは、配置を入れる以外にすることも同じ（`commit`・`saved` が同じで、`applied`・`isCurrent` を渡していない）ときだけ。
  違えば別々に聞き、先に適用されたほうが勝って、もう一方は `stale` になる（自分の `applied`・通知が走っていない
  呼び出しに `applied` は返らない）。`ThreePaneDock` の `resetLayout`・`restoreLayout` は後から頼んだほうを残す
  （承認待ちの復元に reset を重ねると、復元が `stale`、reset が適用されて `'reset'` が届く。狭い表示で、同じ表示に写る
  別々の広い配置を続けて復元したときも、控えに残るのは後のほう）。
- **`onLayoutCommit`・`applied` が例外を投げたとき**: 配置はもう入っているので、結果は変えない。例外は握りつぶさず、
  捕まえられなかった例外として報告する（`reportError`。`window` の `error` イベントとコンソールに出る）。
  `onGestureEnd` は続けて呼ばれ、`replaceLayout` は `applied` で返り、次の操作を始められる。

```svelte
<ThreePaneDock
	bind:this={three}
	onLayoutCommit={(saved, reason) => {
		if (reason === 'reset')
			settings.remove(KEY); // 既定を保存してもよい
		else settings.set(KEY, JSON.stringify(saved)); // まとめ書き（debounce）はアプリ側で
	}}
	...
/>
```

まとめ書き・読み込みとの順序・利用者の切り替えまで含めて任せたいときは、下の `createDockLayoutStore` に
`onLayoutCommit={store.commit}` と渡す。

### 配置の保存（`createDockLayoutStore`、#791）

`onLayoutCommit` が届ける配置を、アプリが渡す設定の provider に保存する部品。保存先そのものは持たない
（provider は形で受ける。`@banto/admin-core` を import しない）。

```ts
import { createDockLayoutStore, createDockState } from '@banto/dock-svelte';

const dock = createDockState();
const store = createDockLayoutStore({
	dock,
	settingKey: 'dock.dashboard',
	provider: () => settings, // { get(key) → { value }, set(key, value), remove?(key), sessionGuard?() }
	defaultLayout: () => (hostWidth === 0 ? null : defaultLayout(hostWidth, hostHeight))
});
$effect(() => store.seedIfEmpty()); // 既定を作れるようになったら 1 回だけ入れる
$effect(() => untrack(() => void store.load())); // provider の値を読む（最初の描画より優先）
$effect(() => () => store.dispose()); // 残りの書き込みを flush
// <DockHost {dock} onLayoutCommit={store.commit} ... />
```

- **provider（`DockLayoutSettings`）**: `get(key)` は `{ value: string | null }` を解決する Promise、`set(key, value)` は
  Promise。`remove(key)` と `sessionGuard()` は省略できる。`@banto/admin-core` の `UiSettingsProvider`
  （`getUiSettings` の戻り値）・`createLocalUiSettings()` はそのまま渡せる。`provider` は関数で、使うたびに呼ぶ。
- **何を書くか**: 部品が自分で入れた配置（最初の描画の写し・provider の値・入れた既定）は基準で、書き戻さない
  （`DockHost` はそれも `'user'` で報告するが、基準と同じ文字列なので書かない）。基準と違う `commit` を、最後の
  報告から 500ms（`debounceMs`）後に 1 回書く。`dispose()` は残りを flush する。`dispose()` の後に届いた報告
  （ページの後始末の後で `DockHost` が unmount の報告をする）は、その場で書く。
- **読み込み**: `load()` は 1 回だけ。provider の値が、最初の描画にも、答えが届く前の利用者の操作にも勝つ。
  ただし、答えを待つ間に届いた `'reset'`（利用者の「既定に戻す」）には勝たない: 答えを捨て、reset の書き込み
  （または削除）をそのまま送る。
  `null`・エラー・検証に通らない値は既定に戻す（localStorage の写しで代用しない）。`validate(json)` で保存値を
  直す・断ることができる（その後に dock 自身の `hydrate` の検証が走る）。
- **`'reset'`**（`replaceLayout(既定, { saved: true, commit: 'reset' })`、`ThreePaneDock` の `resetLayout()`）:
  既定（`reset: 'save'`）では、届いた配置を利用者の変更として書く（既定が出ている間でも書く。書かないと、次に
  読めたときに古い配置が戻る）。`reset: 'remove'` は provider の `remove(settingKey)` と localStorage の写しの削除に
  なる（provider に `remove` が無ければ既定を書く）。`'reset'` は 1 回だけ届く（`'user'` と重ならない）。
- **持ち主（`scope`・`isCurrent`）**: 省くと「キー 1 つ、持ち主なし」。渡すと（`@banto/admin-core` なら
  `scope: currentSessionScope()`・`isCurrent: isCurrentSessionScope`）、読み込みの結果・待っている書き込み・
  `dispose()` の flush は `isCurrent(scope)` が真の間だけ使い、セッションが替わった後のものは捨てる（前の利用者の
  配置を、次の利用者に見せない・基準にしない）。`isCurrent` を省いたときは provider の `sessionGuard()` で見る
  （無ければ常に同じセッション）: 部品を作った時点のものに加えて、読み込みを始めた時点・書き込みを待たせた時点の
  provider からも取り、その読み込み・書き込みはその provider とセッションに結び付ける（`provider` を後から
  差し替えるアプリでも、待っている間にセッションが替わった分は捨てる。書き込みは、待たせた時点の provider へ送る）。
- **localStorage の写し（`storageKey`）**: provider の答えを待たずに最初の描画へ使う写し。省くと持たない
  （localStorage から答える provider なら要らない）。`scope` があるときのキーは `${storageKey}:${scope.owner}` で、
  `owner` が `null`（持ち主が確かめられない）なら読み書きしない。素の `storageKey` は誰のものでもないので、読まずに
  消す。`scope` が無いときは素の `storageKey` を使う。
- **`beforeBaseline`**: 部品が既定を入れた直後（`seedIfEmpty`、保存が無い・使えないときの `load`。
  `ThreePaneDock` では既定が実際に入った後）、基準を取る直前に呼ぶ。ここで同期に直した配置（低い画面ではログの
  pane を帯で始める、など）は基準に含まれ、利用者の変更として書かれない。保存した配置を入れたときと、利用者の
  「既定に戻す」では呼ばない。
- **別のタブとの競合**: 書き込みは無条件（`ifRevision` を使わない）。配置は最後の操作が勝つ。別のタブの変更は、
  次の読み込み（ページを開き直す）まで見えない。
- **書き込みの順序**: 1 つの部品の書き込み（`set`・`remove`）は、前のものが終わって（失敗も含む）から次を送る。
  provider に順序の保証は求めない（遅い `set` が、後の `remove` より後に届いて古い値が戻ることはない）。
- **`ThreePaneDock`** は `createThreePaneLayoutTarget(dock, () => three)` を `dock` に渡す（保存する値が
  `layoutSnapshot()` になり、復元は `restoreLayout` を通る）。`initialLayout={target.initialLayout}`、マウント後に
  `target.attach(status)` → `store.load()`、`defaultLayout: () => target.defaultLayout`。`status` は `ThreePaneDock` の
  `onRestore` が知らせた値で、省略できる（`beforeBaseline` を使うときは渡す: 最初の描画の写しが使えず、部品が
  既定で始めたことが伝わる。マウント後の復元が既定になったこと（`restoreLayout` の `status: 'default'`）は、
  渡さなくても伝わる。どちらも、置き換えが実際に入った（`outcome: 'applied'`）ときだけ: `beforePanelChange` に
  断られた・`stale` になった復元では、前の配置が残るので `beforeBaseline` は呼ばない）。配線の全体は
  [docs/recipes/three-pane-dock.md](../../docs/recipes/three-pane-dock.md)「レイアウトの保存」。

## 保存の約束（serialize / hydrate と書き込みは別）

`serialize()` は文字列を返すだけで、`hydrate(json)` は文字列を検証して layout に採るだけ。**実ストレージへの書き込み
（localStorage・設定 DB など）はアプリの責任**で、このパッケージは保存先を持たない（`createDockLayoutStore` も、
アプリが渡す provider へ書く）。自分で保存を書くときの約束:

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
