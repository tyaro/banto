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
