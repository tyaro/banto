# タッチ向けの画面内テンキー・文字キーボード 設計書 — Issue #937

作成日: 2026-11-25
状態: **草案（実装は無い）。§18 の「確かめたい点」はオーナーの判断待ち**
トラック: 保守者向け（トラックA）
関連: Issue #937、[template-scope](../template-scope.md) §1・§3・§3.1、
[ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui` と層の補助）、
[ADR-0020](../adr/0020-image-assets-package.md)（デモを同梱しないオプションのパッケージの前例）、
[date-time-pickers](date-time-pickers.md)（入力欄から開くポップアップと注入の前例）、
[theme-dimension-tokens](theme-dimension-tokens.md)（寸法のトークン、部品の形）、
conventions §3 / §4 / §5 / §8 / §9 / §13 / §14

この文書の `path` と名前は、2026-11-25 の main（`682691ad`）で開いて確かめた。
**新しく足すパッケージ・部品・関数・CSS 変数の名前は見込み**で、各 PR で決める（決めた形はこの文書へ書き戻す）。

## 0. 入れる判断（4 条件）

オーナーは 2026-11-25 に「banto に入れる」と決めた。[template-scope §1](../template-scope.md#1-テンプレートの定義何であるか--何でないか) の 4 条件に照らすと次のとおり。

| #   | 条件       | 判定           | 理由                                                                                                                                                                         |
| --- | ---------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 横断性     | **弱い**       | 要るのは、タッチだけのパネル PC・キオスクで動かすアプリ。マウスとキーボードのある机の上の管理画面では要らない                                                                |
| 2   | 削除容易性 | 満たす         | 独立した部品。入力欄は素の `<input>` のままで、部品を外しても入力欄はそのまま動く（§16）                                                                                     |
| 3   | 代替不能性 | **一部**       | OS のタッチキーボードと npm のキーボード部品はある。ただし OS のものは画面を覆う・出ない・キオスク表示で使えないことがあり、npm のものはカナの直接入力と範囲つきの数値に穴 |
| 4   | 無ドメイン性 | 満たす       | 数値と短い文字の入力だけ。業種の知識（単位・タグ・設備）を持たない                                                                                                           |

1 と 3 が条件付きなので、**コアではなくオプション**として入れる（template-scope §1「1〜2 を条件付きで満たす → オプション」）。
入れる理由:

- 派生アプリ（工場の現場のパネル PC）に実際の利用先がある。表示専用のプリセット（`pnpm scaffold --preset display`）と
  タッチの密度（`[data-banto-density='touch']`、#624）は既に banto にあり、「タッチの端末で**読む**」までは揃っている。
  「タッチの端末で**入れる**」だけが欠けている。
- 層（Esc・フォーカス）とテーマのトークンの決まりに沿う部品を、派生アプリごとに作ると決まりが揃わない。
  banto の決まりを知っている場所で 1 度作るほうが安い。
- 業種の知識を持たないので、banto-industrial（ドメイン特化）に置く理由が無い（template-scope §3.1「別リポジトリへの分離は
  ドメイン特化に限る」）。

横断性の弱さは、**アプリに配線しない**（§4）ことで受ける。使わない利用者には、消す配線が無い。

## 1. 用語

- **テンキー**: 数値を入れる画面内の部品（0〜9・小数点・符号・消す・確定・取り消し）。
- **文字キーボード**: 英数字・カタカナ・記号を入れる画面内の部品。
- **盤**: テンキーと文字キーボードの総称。画面に出ている 1 枚のこと。
- **対象の入力欄**: 盤がいま値を入れようとしている `<input>`。
- **下書き**: 盤の中で組み立てている文字列。確定するまで対象の入力欄には書かない。
- **ホスト**: アプリのルートに 1 つ置き、盤を出す・閉じる・値を書くを受け持つ部品（`ToastHost`・`ConfirmHost` と同じ置き方）。
- **ポップアップ**: 画面の中央に、背景を暗くして出す盤。**下の固定**: 画面の下の端に、背景を暗くせずに出す盤。
- **遠隔のブラウザ**: マウスとキーボードのある PC から LAN 越しに同じ画面を開いたブラウザ。

## 2. 背景と目的

### 2.1 いま（`682691ad`）

無いもの:

- 画面内の入力の部品は、どのパッケージにも無い（`packages/` は admin-core・attachments・charts・dock-svelte・forms・
  grid-svelte・image-assets・report・scan-wedge・theme・tree-svelte・ui の 12 個）。
- `(pointer: coarse)` を読むコードは無い。タッチに近い判定は `LauncherBar.svelte` の `(hover: none)`（拡大をやめる）だけ。
- forms と grid の注入の口（`provideFieldInputs`・`provideCellEditors`）は `date` / `time` / `datetime`（grid は `dateRange` も）だけで、
  数値と文字の入力欄は差し替えられない（`packages/forms/src/fieldInputs.ts`、`packages/grid-svelte/src/cellEditors.ts`）。

あるもの（使い回す・合わせる）:

- **層の決まり**（`packages/ui/src/layering.ts`）: 重なった UI は Esc 1 回で手前から 1 枚ずつ閉じる。層は
  `[role="dialog"]`・`[role="alertdialog"]`・`[role="menu"]`・`[data-esc-layer]`（`LAYER_SELECTOR`）。
  **開いた popover（ブラウザの top layer）の中の層は、どの z-index の層よりも手前**と数える（`isInOpenPopover`）。
  役割の無い層は、開いている間だけ `data-esc-layer`（`LAYER_MARKER_ATTR`）を付ける。
- **`Modal` / `Drawer`**（`OverlayPanel.svelte`）: `position: fixed` + `z-index: var(--banto-z-modal)`（900）、`aria-modal="true"`、
  `attachFocusTrap`、開いたときのフォーカスの持ち主を覚えて閉じるときに `restoreFocus` で戻す。Esc は window で受け、
  `event.defaultPrevented` か手前の層（`hasVisibleLayerAbove`）があれば譲る。
- **入力欄から開くポップアップ**（`PickerDialog.svelte`。日付の部品が共有）: `popover="manual"` で top layer に出し、
  `role="dialog"` + `aria-modal="true"` + フォーカスの罠。フォーカスは**ポップアップの中へ移る**。
  `onmousedown` の `preventDefault` で、フォーカスを取れない所を押してもフォーカスが動かないようにしている。
- **z のトークン**（`packages/theme/src/css/banto.css`）: header 100、launcher 200、sidebar-scrim 850、sidebar 900、modal 900、
  overlay 1000、toast 1000。背景の暗幕は `--banto-scrim`。
- **タッチの密度**（同じファイルの `[data-banto-density='touch']`）: 本文 16px、`--banto-control-height` 48px（sm 40 / lg 52）、
  grid の行 52px。`@banto/theme` の `applyDensity('touch')` が `<html>` に付ける。admin-template の設定画面の外観で選べる
  （`settings.svelte.ts` の `theme.density`）。
- **部品の大きさを密度で変える前例**: `--banto-dock-button-size`・`--banto-tree-toggle-size` は theme の touch の区画だけが定義し、
  部品は自分の既定値を持つ（theme からオプションのパッケージへの import は無い。変数名で繋がるだけ）。
- **キオスク**: 見た目の `shell.kiosk`（`settings.svelte.ts`。シェルを畳む）と、認証無効モード / デスクトップ自動ログイン
  （template-scope §3 の表、[no-login-app](../recipes/no-login-app.md)）。どちらも入力の手段には触れない。
- **forms の入力欄**: `NumberField` は `<input type="number">` で `min` / `max` を属性に出す。`DraftNumberField` は
  `type="text"` + `inputmode="decimal"`（`min` / `max` は属性に出さない）。`TextField` は `<input>`。どれも `oninput` で
  `event.currentTarget.value` を読む。
- **grid の編集**（`edit.svelte.ts`・`CellEditor.svelte`・`BantoGrid.svelte`）: 編集の開始は**ダブルクリック**
  （`handleCellDoubleClick`）か Enter / F2。エディタは素の `<input>` / `<select>`。**エディタの blur で確定する**
  （`handleEditorBlur` → `commitFromEditor`）。
- **デモを同梱しないパッケージの前例**: `@banto/scan-wedge`（M21）・`@banto/image-assets`（ADR-0020）。admin-template は依存せず、
  scaffold は触れず、レシピで組み込み方を示す。`@banto/tree-svelte` は `/tree` のデモを配線した（基準画像の作り直しを受け入れた）。
- **`@banto/ui` の見本ページ**（`/ui-demo`）: ナビに出るのはデモのビルドだけ。`e2e/visual/visual.spec.ts` の
  `DIAGONAL_PAGES` に入っていて、カードを足すとこのページの基準画像が変わる。

### 2.2 目的（Issue の完了の条件）

1. マウス・キーボードなしで、数値と短い名前（英数字・カタカナ）を入力できる。
2. 遠隔のブラウザ（マウス・キーボードあり）では、通常の入力欄のまま使える（切り替えられる）。
3. 既存の入力欄（アプリ自身の `<input>`、`BantoForm` の入力欄）から、入力欄を作り直さずに呼び出せる。
4. 指で押せる大きさ（目安 12 mm 角以上）を既定にし、CSS 変数で変えられる。
5. ホバー・長押し・ダブルタップに頼らない。

### 2.3 やらないこと

- **かな漢字変換**（IME に当たるもの）。カタカナは直接入れる。ひらがな・漢字は入れられない。
- **複数行の入力**（`<textarea>`）。目的は「短い名前」。要望が出たら別に考える。
- **下書きの途中へのカーソルの移動**。下書きは末尾に足す・末尾から消すだけ（§9.4）。
- **OS のタッチキーボードの制御**（出す・隠すを OS に指示する）。盤が出る入力欄では `inputmode="none"` を付けて
  ブラウザに頼む所まで（§7.4）。
- **grid のセルの編集をタップで始めること**。今はダブルクリックで、Issue の「ダブルタップに頼らない」に当たるが、
  grid の操作の設計なので別の Issue にする（§6.4）。
- **日付・時刻の入力**。`DateInput` などのカレンダーのボタンがタッチで使える。
- **admin-template への配線**（第一案。§4）。見本はレシピと試験に置く。
- **npm のキーボード部品を引くこと**（conventions §3）。

## 3. conventions との関係

本文を読んで、この設計が触れるものだけを挙げる。

| 節                              | 触れ方                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3 依存を足さない               | **足さない**。カナの表・数値の下書きは自前（小さい・エッジが限られる）。`dependencies` / `peerDependencies` は空                                                                                                                                           |
| §4 コア → オプションの逆依存    | 新しいパッケージはオプション。コア（forms・grid-svelte・ui・theme・admin-core）は import しない。**新しいパッケージも `@banto/ui` を import できない**（パッケージ間の import はゼロ）。層の決まりは DOM の印（popover + `data-esc-layer`）で合わせる（§7） |
| §5 アプリ固有の import          | `#lib`・`$app/`・`@tauri-apps/` を import しない。素の import は `svelte`・`svelte/*` だけ（rule `package-bare-imports`）。設定の保存先・密度・キオスクは読まない（有効・無効は呼ぶ側が prop で渡す。§12）                                              |
| §8 runes の落とし穴             | 開く・閉じるの `$effect` は依存を絞り、副作用は `untrack`。対象の入力欄が消えた・替わったときの遅れた処理は、開いた回の番号で無効にする                                                                                                                     |
| §9 トークンのみ                 | 色・余白・文字サイズ・枠線幅は `var(--banto-*)`。キーの大きさは「部品の形」なので、部品の CSS 変数（既定値つき）にする（§10）。rule `raw-colors`・`raw-dimensions` は `packages/` を走査するので、新しいパッケージも対象                                   |
| §10 provider の分岐             | 環境（tauri / server / demo）で分けない。盤はどの形態でも同じ DOM の部品                                                                                                                                                                                    |
| §13 文言はキー経由              | パッケージは辞書を持たない。文言は `messages` の prop（関数の束、既定は日本語）で受ける（§13）。キーの字（数字・英字・カナ）は文言ではない                                                                                                                 |
| §14 `.svelte.ts` のソース配布   | admin-template は依存しないので、`optimizeDeps.exclude` の rule（`optimizedeps-svelte-source`）は当たらない。**`.svelte.ts` を持つと外部利用 fixture の rule（`external-consumer-fixture`）が当たる**（§17）                                                |
| §1・§2・§6（REST / Tauri・認可） | 当たらない。盤は入力欄に文字を入れるだけで、要求も保存もしない                                                                                                                                                                                              |

公開 API は足すだけなので minor の見込み。

## 4. 置き場所と提供の形（案の比較）

### 4.1 どのパッケージに置くか

| 案                                                         | 良い点                                                                                                                                                | 悪い点                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `@banto/ui` に足す（Issue の文字どおり）                | `layering.ts`・`anchoredPopover.ts`・`messages.ts`・`IconButton` をそのまま使える。パッケージの登録（fixture・版・公開）が増えない                    | `@banto/ui` は**コア**（template-scope §2.1、削除を想定しない）。横断性の弱い部品を全利用者が継承する。「要らなければ消す」が、パッケージの中のファイルを選んで消す作業になる。`UiMessages` にカナ・テンキーの文言が増え続ける |
| **B. 新しいオプションのパッケージ（推奨）**                | 4 条件の判定（オプション）と形が一致する。消すのはフォルダ 1 つ。`@banto/ui` の公開 API と版の重さを増やさない。scan-wedge・image-assets と同じ扱い | `@banto/ui` を import できないので、層の決まりを DOM の印で合わせ、足りない小さな補助（フォーカスを動かさない押し方など）を自分で持つ。登録の作業（§17 の T1）が要る                                                              |
| C. banto-industrial に置く                                 | banto の面積が増えない                                                                                                                                | 無ドメインなのにドメイン特化のリポジトリに置くことになる（template-scope §3.1）。オーナーの決定（banto に入れる）とも合わない                                                                                                     |

**推奨: B。名前は `touch-keys-svelte`（`@banto` のスコープの下、`packages/touch-keys-svelte`。まだ無いパッケージなので、この文書ではスコープを付けずに書く）。** Svelte の部品を持つオプションのパッケージの
名前の付け方（`dock-svelte`・`tree-svelte`・`grid-svelte`）に合わせる。

B の「悪い点」が小さいことは、実コードで確かめた:

- `Modal` の Esc は `hasVisibleLayerAbove({ except: panelEl })` で手前の層に譲る。盤を **popover（top layer）+
  `data-esc-layer`** で出せば、`@banto/ui` を import しなくても「手前の層」と数えられる（`LAYER_SELECTOR` と `isInOpenPopover`）。
  `Modal` 側は 1 行も変えない。
- 同じことを `@banto/tree-svelte` の `TreeSelect`（`popover="auto"` + `role="dialog"`）が、`@banto/ui` を import せずにやっている。
- 盤はフォーカスを取らない（§7.2）ので、フォーカスの罠（`attachFocusTrap`）と戻し（`restoreFocus`）は要らない。

### 4.2 アプリに配線するか

| 案                                              | 良い点                                                                                               | 悪い点                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **a. 配線しない（recipe-only。推奨・第一案）**  | 基準画像が 1 枚も変わらない。scaffold は触れない。template-scope §3 の「削除可能デモ」の義務を負わない | 実ブラウザでの確かめ（top layer・フォーカス・`inputmode`）が CI に無い（§14）。見本を触って確かめる場所が無い                                                                                                                      |
| b. `/ui-demo` にカードを 1 枚足す               | 実ブラウザの e2e を書ける。見本になる。サイドバーは変わらないので、変わる基準画像は `ui-demo` だけ   | admin-template が新しいパッケージに依存する（`package.json`・`optimizeDeps.exclude`）。scaffold に外す処理、template-scope §3 に行、`remove-optional-assets` に手順が要る。`ui-demo` の基準画像を `visual-baselines.yml` で作り直す |
| c. 設定に「画面内キーボードを使う」を足して全画面で効かせる | テンプレートのままタッチの端末で使える                                                               | シェルに常時の機能が入る（削除容易性が下がる）。設定・文言・試験・基準画像が増える。横断性が弱いのに全利用者が継承する                                                                                                             |

**推奨: a。** API が固まった後（T4 の後）で b を別の判断にする（§18 の 2）。c はしない。

## 5. 公開 API の案

Svelte 5（runes）。見込みの形で、名前は T1・T2 で決める。

```ts
// packages/touch-keys-svelte/src/index.ts（見込み）
export { default as TouchKeysHost } from './TouchKeysHost.svelte';
export { default as NumberKeypad } from './NumberKeypad.svelte';
export { default as TextKeyboard } from './TextKeyboard.svelte';
export { touchKeys } from './attach';
export { defaultTouchKeysMessages, type TouchKeysMessages } from './messages';
export type {
	TouchKeysOptions,
	NumberKeysOptions,
	TextKeysOptions,
	TouchKeysPlacement,
	TextLayout
} from './types';
```

### 5.1 `TouchKeysHost`（アプリのルートに 1 つ）

```ts
interface TouchKeysHostProps {
	/** 盤を使うか。false の間は何もしない（入力欄は素のまま）。§12 */
	enabled: boolean;
	/** 盤の出し方の既定。入力欄ごとの指定（touchKeys / resolve）が勝つ。 */
	placement?: { number?: TouchKeysPlacement; text?: TouchKeysPlacement };
	/** 文字キーボードの既定の配列と最初の配列。 */
	layouts?: TextLayout[];
	/**
	 * アプリが作っていない入力欄（BantoForm の中など）の指定を返す。
	 * `false` は「この欄には出さない」、`undefined` は属性からの推定に任せる。
	 */
	resolve?: (input: HTMLInputElement) => TouchKeysOptions | false | undefined;
	/** 文言の差し替え（レイヤ①）。既定は defaultTouchKeysMessages。 */
	messages?: TouchKeysMessages;
	onopen?: (input: HTMLInputElement) => void;
	/** 確定して値を書いた後。`value` は入力欄に書いた文字列。 */
	onconfirm?: (detail: { input: HTMLInputElement; value: string; previous: string }) => void;
	oncancel?: (input: HTMLInputElement) => void;
	/** 下書きの表示の下に足す 1 行（単位・注意書きなど）。 */
	note?: Snippet<[{ input: HTMLInputElement; draft: string }]>;
}

type TouchKeysPlacement = 'popup' | 'bottom';
type TextLayout = 'alnum' | 'kana' | 'symbol';
```

既定: `placement` は `{ number: 'popup', text: 'bottom' }`（テンキーは小さいので中央、文字キーボードは横に広いので下）、
`layouts` は `['alnum', 'kana', 'symbol']`。

### 5.2 `touchKeys`（入力欄ごとの指定。attachment）

```svelte
<input bind:value={qty} {@attach touchKeys({ kind: 'number', min: 0, max: 999, decimals: 1 })} />
<input bind:value={name} {@attach touchKeys({ kind: 'text', maxLength: 20, layouts: ['kana', 'alnum'] })} />
<input bind:value={memo} {@attach touchKeys(false)} />
```

```ts
type TouchKeysOptions = NumberKeysOptions | TextKeysOptions;

interface CommonKeysOptions {
	/** 盤の見出し。省くと入力欄の名前（aria-label → label[for] → placeholder）から取る。 */
	label?: string;
	placement?: TouchKeysPlacement;
}

interface NumberKeysOptions extends CommonKeysOptions {
	kind: 'number';
	min?: number;
	max?: number;
	/** 小数の桁。0（既定）は小数点のキーを出さない。 */
	decimals?: number;
	/** 負の数。省くと `min < 0` のときだけ可。 */
	allowNegative?: boolean;
}

interface TextKeysOptions extends CommonKeysOptions {
	kind: 'text';
	maxLength?: number;
	layouts?: TextLayout[];
	initialLayout?: TextLayout;
}
```

attachment は、要素を鍵にした `WeakMap` に指定を置くだけで、DOM のイベントは持たない（開く・閉じるはホストの 1 か所）。
`{@attach}` は `@banto/ui` が既に使っている（`stopPointerdown`）。属性で外す口 `data-touch-keys="off"` も読む
（attachment を付けられない、ほかの部品の中の入力欄のため）。

### 5.3 `NumberKeypad` / `TextKeyboard`（盤そのもの）

ホストが中で使う表示の部品。入力欄と結びつけずに、ページに置きっぱなしで使う用途（専用の入力画面）のために公開する。

```ts
interface NumberKeypadProps {
	/** 下書き。確定のときに呼ぶ側が読む。 */
	draft?: string; // $bindable
	min?: number;
	max?: number;
	decimals?: number;
	allowNegative?: boolean;
	label?: string;
	messages?: TouchKeysMessages;
	onconfirm?: (value: string) => void;
	oncancel?: () => void;
}
```

`TextKeyboard` も同じ形（`maxLength`・`layouts`・`initialLayout`・`masked`）。公開するかは §18 の 9。

### 5.4 推定（属性から読む）

指定（`touchKeys` → `resolve` の順）が無い入力欄は、属性から決める。

| 入力欄                                                                   | 盤             | 読む属性                                                                              |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------- |
| `type="number"`、または `inputmode="numeric"` / `"decimal"`              | テンキー       | `min`・`max`、`step`（小数の桁。`0.01` → 2、`any` → 上限まで）。`numeric` は小数なし |
| `type="text"` / `"search"` / `"tel"` / `"url"` / `"email"`・`type` なし  | 文字キーボード | `maxlength`                                                                           |
| `type="password"`                                                        | §18 の 6       | —                                                                                     |
| `readonly`・`disabled`・`data-touch-keys="off"`・`<textarea>`・`<select>`・日付や色などほかの `type` | 出さない       | —                                                                                     |

## 6. 入力欄からの呼び出し方

### 6.1 案の比較

| 案                                                              | アプリ自身の `<input>` | `BantoForm` の入力欄                             | grid のセル             | 評価                                                                                               |
| --------------------------------------------------------------- | ---------------------- | ------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------- |
| 1. 入力欄ごと置き換える部品（`<KeypadInput bind:value>`）       | 使える                 | 使えない（注入の口は date / time / datetime だけ） | 使えない（同じ）        | forms と grid に注入の口を足す変更が要る。入力欄が 2 種類になる                                    |
| 2. `use:` / `{@attach}` だけ                                    | 使える                 | 使えない（中の `<input>` に付けられない）        | 使えない                | 単独では足りない                                                                                   |
| **3. ホスト 1 つ + 任意の attachment（推奨）**                  | 使える                 | 使える（forms は変えない）                       | 開けば使える（§6.4）    | 入力欄は素のまま。値は `input` イベントで流すので `bind:value` も `oninput` もそのまま動く         |

`bind:value` か `use:` か、への答えは**どちらでもなく、ホストが対象の入力欄に値を書いて `input` イベントを出す**。
`bind:value` の入力欄も、`oninput` で `event.currentTarget.value` を読む forms の入力欄も、同じ経路で値を受け取る。
attachment は「この欄はこの範囲」を伝えるための任意の口。

### 6.2 開く・書く・閉じる

1. **開く**: 対象になる入力欄の `click`（タップ）で開く。`focus` では開かない（`Modal` が開いたときの最初のフォーカスや、
   ページを開いたときのフォーカスで勝手に盤が出るのを避ける）。`<label>` のタップはブラウザが入力欄の `click` にするので、同じ経路。
2. 盤を開く前に、対象の入力欄にフォーカスが無ければ入れる。**盤を開いている間、フォーカスは対象の入力欄に置いたまま**（§7.2）。
3. 下書きは、入力欄のいまの値から始める（§8.3・§9.4）。
4. **確定**: 下書きを正規の形にして入力欄の `value` に書き、`input`、続けて `change` を出す（どちらも `bubbles: true`）。盤を閉じる。
   フォーカスは入力欄に残す。
5. **取り消し**: 何も書かずに閉じる。フォーカスは入力欄に残す。
6. **盤の外をタップ**: 取り消し（§18 の 5）。別の対象の入力欄をタップしたら、いまの盤を取り消して、その欄の盤を開く。
7. **対象の入力欄が消えた・フォーカスを失った・`readonly` / `disabled` になった・ホストの `enabled` が false になった**: 取り消し。

`type="number"` の入力欄は、途中の文字列（`1.`・`-`）を `value` に持てない（ブラウザが空にする。`DraftNumberField` の
doc コメントが同じ理由で `type="text"` にしている）。**下書きを盤の中に持ち、確定のときだけ書く**ので、`type="number"` でも困らない。

### 6.3 実キーボードと同時に使われたとき

盤が開いている間に、対象の入力欄へ**実キーボード（やスキャナ）からの入力**が届いたら、盤は取り消しで閉じる
（`isTrusted` な `keydown`（修飾キーだけ・Esc を除く）か `beforeinput`）。値の持ち主を 2 つにしない。

- `@banto/scan-wedge` は window の `keydown` を読む。盤のキーは `keydown` を出さないので、盤の入力がスキャンと誤認されることは無い。
  盤が開いている欄にスキャンが来たら、盤が閉じてスキャンの文字が入る。
- `keepFocused`（scan-wedge。スキャン用の欄にフォーカスを戻し続ける）と併用しても、盤はフォーカスを動かさないので争わない。

### 6.4 既存の部品との繋ぎ方

- **アプリ自身の `<input>`**: そのまま。範囲などは `touchKeys(...)`。
- **`BantoForm` / forms の入力欄**: forms は変えない。`NumberField`（`type="number"`、`min` / `max` が属性にある）は推定だけで
  範囲つきのテンキーになる。`TextField` は文字キーボード。`DraftNumberField`（`inputmode="decimal"`）はテンキーになるが、
  `min` / `max` が DOM に無いので、範囲は `resolve`（`input.id` はフィールド名）で渡す。forms の検証は確定の後の `input` で今までどおり走る。
- **日付・時刻の入力欄**（`DateInput` など）: 文字の欄は `type="text"` なので、何もしなければ文字キーボードの対象になる。
  カレンダーのボタンがあるので、レシピではアプリの包み（`FormDateInput.svelte` など）に `data-touch-keys="off"` を付ける形を示す
  （§18 の 8）。
- **grid のセルの編集**: 編集に入れば、エディタは素の `<input>` なので、タップで盤が開く。盤はフォーカスを取らないので、
  開いている間に blur の確定（`handleEditorBlur`）は起きない。ただし 2 つ足りない:
  ① **編集の開始がダブルクリック**（タッチだけでは始められない）、② **確定の後、セルの確定は blur か Enter を待つ**
  （盤の「確定」は入力欄へ書く所まで）。どちらも grid の側の設計なので、**この Issue の範囲から外し、別の Issue にする**（§18 の 7）。
- **`ConfirmDialog` の入力欄・コマンドパレットの検索・ログイン**: 素の `<input>` なので、タップすれば同じように開く。

## 7. 層の扱い

### 7.1 出し方

盤は 2 つの出し方のどちらでも、**`popover="manual"` で top layer に出す**（`PickerDialog` と同じ手）。

- `Modal`（z 900）・コマンドパレット（overlay 1000）の中の入力欄から開いても、盤が必ず手前に出る。z のトークンを足さない。
- 祖先の `transform` / `filter` が固定配置の基準になる問題（ADR-0018 §10）を受けない。
- **ポップアップ**: 画面の中央。背景は `::backdrop` に `--banto-scrim`。**下の固定**: 下の端に幅いっぱい、背景は暗くしない。

`Modal` そのもの（`OverlayPanel`）は使わない。`Modal` は開くとフォーカスを中へ移し、罠を掛ける。盤でそれをすると、
対象の入力欄が blur し、grid の確定や forms の `onBlur` が盤を開いた瞬間に走る。

### 7.2 フォーカス

- 盤のキーは `<button type="button" tabindex="-1">`。盤の `mousedown`（と `pointerdown`）を `preventDefault` して、
  押してもフォーカスが対象の入力欄から動かないようにする（`PickerDialog` の `onmousedown` と同じ考え方）。
- 盤はフォーカスを取らないので、**フォーカスの戻しは要らない**（動いていない）。`Modal` の罠（`focusin` の引き戻し）にも掛からない。
- `Modal` の暗幕のクリック（`handleOverlayClick`）は、押された要素が暗幕そのもののときだけ閉じる。盤は top layer の別の要素なので、
  盤を押しても下の `Modal` は閉じない。

### 7.3 Esc

- 盤は、開いている間 `data-esc-layer` を付ける。`Modal`・`Drawer`・`PickerDialog`・コマンドパレットは、
  `hasVisibleLayerAbove` で「開いた popover の中の層」を手前と数えて Esc を譲る。
- 盤は window の `keydown` で Esc を受け、`event.defaultPrevented` なら譲り、そうでなければ `preventDefault` して取り消しで閉じる。
  盤より後に開く層（盤の上のメニューなど）は無いので、自分より手前の層の判定は持たない。
- IME の変換中の Esc（`isComposing` / `keyCode === 229`）は触らない（`PickerDialog` と同じ）。
- 盤は `aria-modal` を付けない（モーダルではない）。`hasVisibleModalLayer`（ショートカットの抑止）には数えられない。

### 7.4 OS のタッチキーボード

盤の対象になる入力欄には、ホストが `inputmode="none"` を付ける（元の値を覚え、`enabled` が false になったら戻す）。
付けるのは、フォーカスが入る前（対象の `pointerdown` の捕捉の段）。**WebView2・Chromium・Android で OS のキーボードが出ないことは、
実機で確かめる**（§17 の T2。効かない環境があれば `virtualkeyboardpolicy="manual"` を併せて試す）。

### 7.5 下の固定とページ

- 下の固定の盤は、`LauncherBar`（z 200、下の端）・トースト（z 1000、右下）より手前に出る。開いている間、その下は隠れる。
- ホストは、開いている間 `<html>` に盤の高さ（`--banto-touch-keys-inset-bottom`）を出す。アプリは、ページの下の余白や
  `--banto-toast-bottom`（`ToastHost` が読む）に使える。閉じたら外す。
- 開いたとき、対象の入力欄を `scrollIntoView({ block: 'nearest' })` で見える所へ寄せる。寄せられない配置（`Modal` の中など）でも、
  盤の表示の行に見出しと下書きが出るので、何を入れているかは分かる。

## 8. テンキー

### 8.1 キー

`0`〜`9`、`.`（`decimals > 0` のときだけ）、`±`（負の数が可のときだけ）、1 文字消す、全部消す、取り消し、確定。
表示の行に、見出し・下書き・範囲（`min 〜 max`）を出す。

### 8.2 範囲・小数・負の数

- **範囲**: 下書きを数にしたものが `min` 以上 `max` 以下でなければ、範囲の知らせを出し、**確定を押せなくする**。
  途中（`15` を入れる途中の `1` が `min = 10` を下回る）は打てる。止めるのは確定だけ。
- **小数の桁**: `decimals` を超える桁は打てない（キーを押しても入らない）。
- **負の数**: `±` は符号を入れ替える（どの位置でも押せる）。`allowNegative` が false ならキーを出さない。
- **桁の上限**: 有効な桁は 15 桁まで（`Number` で正確に比べられる範囲）。超える桁は打てない。
- **空**: 下書きが空のときは、入力欄が `required` でなければ確定でき、空を書く。`required` なら確定できない。
- 小数点は `.`、桁区切りは出さない（入力欄に書く形と同じ。表示の整形はアプリの側）。

### 8.3 確定と取り消し

- **最初の 1 打**: 開いたとき、下書きは入力欄のいまの値。**最初に数字を打つと、いまの値を置き換える**（HMI のテンキーの慣習）。
  最初に 1 文字消すを押したら、いまの値の末尾を消す（§18 の 4）。
- **確定で書く形**: 末尾の `.` を取る、先頭の余分な `0` を取る、`-0` は `0`。`decimals` に満たない桁は足さない（`1.5` は `1.5` のまま）。
- 1 文字消すは押すたびに 1 文字（押しっぱなしで連続して消すことはしない。§11）。全部消すが別にある。

## 9. 文字キーボード

### 9.1 配列

- **英数（`alnum`）**: 数字の段 + QWERTY の 3 段 + 空白。大文字・小文字は**切り替えのキー**（押すたびに入れ替わり、次に押すまで続く。
  1 文字だけ大文字にする動き・長押し・ダブルタップは使わない）。
- **カナ（`kana`）**: 五十音の表（ア〜ワ行 + ン・ー）+ 濁点・半濁点・小書き + 空白。
- **記号（`symbol`）**: 必要な分だけ。見込みは `- _ . , / : @ # ( ) + * = % & ! ?`。
- 配列の切り替えは、盤の端のキー（英数 / カナ / 記号）。`layouts` に 1 つしか無ければ切り替えのキーを出さない。

### 9.2 カナ

- **IME を通さず、全角のカタカナを直接入れる**。ひらがな・漢字は無い。
- **濁点・半濁点・小書きは、直前の 1 文字に後から掛ける**: `カ` の後に濁点 → `ガ`、もう 1 度 → `カ`。`ハ` → `バ` / `パ`、`ウ` → `ヴ`、
  `ツ` → `ッ`、`ヤユヨ` → `ャュョ`、`アイウエオ` → `ァィゥェォ`。掛けられない文字の後では、そのキーを押せない状態にする。
- 入れる文字は合成済みの 1 文字（`ガ` は U+30AC。`カ` + 結合用の濁点にはしない）。保存・検索・照合で形が割れない。
- 半角カナ（`ｶﾞ` は 2 文字）は入れない。要る案件はアプリが確定の後に変換する（§18 の 3）。

### 9.3 最大文字数

`maxLength`（指定 → `maxlength` 属性）に達したら、文字のキーは入らない。表示の行に `3 / 20` を出す。
数え方は HTML の `maxlength` と同じ（UTF-16 の符号単位）。盤が入れる文字はどれも 1 単位なので、文字数と一致する。

### 9.4 下書き

下書きは入力欄のいまの値から始め、**末尾に足す・末尾から消す**だけ（カーソルは動かせない）。短い名前が目的で、
指でカーソルを置く操作は長押しや細かいタップに頼りがちなため。全部消すがある。確定はそのまま書く（前後の空白も切らない）。

## 10. 大きさ

- キーの 1 辺は部品の CSS 変数 **`--banto-touch-key-size`**（既定 `48px`）、間隔は `--banto-touch-key-gap`（既定 `var(--banto-space-2)`）。
  部品は `var(--banto-touch-key-size, 48px)` と読むので、theme が何も定義しなくても動く。アプリは `:root` で上書きできる。
- **12 mm の目安**: CSS の `mm` は 96dpi を基準にした換算（1mm ≒ 3.78px、12mm ≒ 45.4px）で、実際の画面の上の長さではない。
  パネルの画素の細かさと OS の拡大率で変わる。既定の 48px は、換算で 12.7mm、タッチの密度の `--banto-control-height`（48px）と同じ。
  **実寸で 12 mm を保証する手段は CSS に無い**ので、端末ごとに変数を合わせる、とレシピに書く。
- [theme-dimension-tokens](theme-dimension-tokens.md) D7 の「部品の形は汎用の段に入れず、部品の CSS 変数にする。2 つ以上の部品・アプリが
  共有するときだけ theme に用途名で足す」に従い、**theme には足さない**（§18 の 10）。前例の `--banto-tree-toggle-size` と同じ形なので、
  後から theme の touch の区画に 1 行足すだけで密度に繋げられる。
- 幅が足りない画面では、キーを `min(キーの大きさ, 使える幅 ÷ 列の数)` に縮める（`PickerDialog` の `--banto-date-cell-size` と同じ考え方）。
  カナの表は 11 列で、48px のままなら約 600px の幅が要る。
- キーの字は `--banto-font-size-xl`、表示の行の下書きは `--banto-font-size-2xl`。色・枠・角は `--banto-*`。

## 11. ホバー・長押し・ダブルタップに頼らない

- 押せることをホバーでしか示さない飾りを持たない。押している間の見た目は `:active`。
- **長押しで別の字を出さない・押しっぱなしで繰り返さない**。1 回押すと 1 回入る。
- **ダブルタップで切り替えるもの（Caps Lock など）を持たない**。大文字・小文字は 1 回押すと切り替わるキー。
- 盤に `touch-action: manipulation`（ダブルタップの拡大と、その待ち時間を無くす）、`user-select: none`、
  長押しの文脈メニュー（`contextmenu`）は盤の上では出さない。
- キーは `click` で入れる（指を離したとき。押してからキーの外へ滑らせれば入らない）。
- 説明を `Tooltip`（ホバーと focus で出る）に置かない。キーの名前は字そのものか、見える文言で示す。

## 12. 遠隔のブラウザでは通常の入力欄のまま

| 案                                                   | 評価                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(pointer: coarse)` で自動                           | マウスを挿したパネル PC は `fine` になる。逆に `(any-pointer: coarse)` は、タッチ画面つきのノート PC（キーボードあり）で真になる。**端末の持ち物から「キーボードが無い」は分からない**              |
| タッチの密度（`theme.density = touch`）に連動        | 密度の設定は provider に保存され、利用者について回る。パネル PC で touch にした利用者が、遠隔のブラウザでも盤が出てしまう                                                                         |
| **明示の prop（推奨）**                              | `TouchKeysHost` の `enabled` をアプリが渡す。パッケージは判定を持たない（conventions §5。設定も密度も読まない）                                                                                  |

**推奨: `enabled` は必須の prop にし、既定の自動判定は持たない。** レシピでは、アプリが**端末ごとの設定**（`localStorage`。
`banto.kiosk` や `banto.density` のキャッシュと同じ置き場で、provider には保存しない）を作り、その値を渡す形を示す。
自動にしたいアプリのために、`(pointer: coarse)` を返す小さな補助（`coarsePointer.current`。`narrowViewport` と同じ `createSubscriber` の形）を
パッケージから出すかは §18 の 11。

`enabled` が false の間、ホストは何も聞かず、何も書き換えない（`inputmode` も触らない）。入力欄は素のまま。

## 13. a11y と i18n

- 盤は `role="group"` + `aria-label`（「テンキー」「文字キーボード」+ 見出し）。フォーカスは対象の入力欄にあるので、`role="dialog"` にはしない。
- キーは `<button>`。機能のキー（消す・確定・切り替えなど）は見える文言か `aria-label` を持つ。Tab では辿れない（`tabindex="-1"`）:
  実キーボードのある利用者は入力欄に直接打てる。画面内のキーボードの一般的な扱いに合わせる。
- 範囲外・文字数の上限の知らせは `role="status"`（`aria-live="polite"`）の行に出す。色だけで示さない（文言と、確定の `disabled`）。
- 対象の入力欄の `aria-invalid` や検証の文言は、今までどおり入力欄の側（forms・アプリ）が持つ。
- コントラスト・フォーカスの輪は theme のトークン。動きは `--banto-duration-*`（reduced motion で 0）。
- **文言**（conventions §13 のレイヤ①）: `TouchKeysMessages`（関数の束）を `messages` で受け、`defaultTouchKeysMessages` は日本語。
  見込みの項目: 盤の名前（テンキー / 文字キーボード）、確定、取り消し、1 文字消す、全部消す、符号、英数、カナ、記号、大文字、小文字、空白、
  濁点、半濁点、小書き、範囲の知らせ `(min, max) =>`、入力が必要、文字数 `(length, max) =>`。
  パッケージは辞書も Paraglide も持たない。アプリは Paraglide のキーから作った束を渡す（レシピに見本）。
- キーの字（`0`〜`9`・英字・カナ・記号）は文言ではないので、パッケージに直に持つ。

## 14. 試験の方針

- **単体（純粋な関数。vitest）**: 数値の下書き（1 打ごとの表を 1 行ずつ: 置き換え・小数の桁・符号・15 桁・末尾の `.`・`-0`・空）、
  範囲の判定（境界・`min` だけ・`max` だけ）、カナ（濁点・半濁点・小書きの表を全部、掛けられない文字、往復）、
  属性からの推定（§5.4 の表を 1 行ずつ、`step` から桁）、最大文字数。
- **部品（jsdom + `@testing-library/svelte`）**: タップで開く・`focus` では開かない／開いている間 `document.activeElement` が対象のまま／
  確定で `value` が書かれ `input` と `change` が 1 回ずつ出て `bind:value` に届く／`type="number"` でも同じ／取り消しは何も出さない／
  範囲外は確定が `disabled`／実キーボードの `keydown` で閉じる／対象が消えたら閉じる／`enabled` が false なら何もしない・`inputmode` を戻す／
  `touchKeys(false)` と `data-touch-keys="off"`／`resolve`／`messages` の差し替え。
  popover は jsdom に無いので、`@banto/ui` の試験と同じ代役（`showPopover` / `hidePopover` を足す）を使う。
- **層**: Esc を盤が消費する・`defaultPrevented` なら譲る・開いている間だけ `data-esc-layer` がある、まで。
  **`Modal` の中から開いて Esc 1 回で盤だけが閉じること**は、パッケージの試験では `@banto/ui` を import できないので確かめられない。
  配線しない間は、レシピの手順どおりに組んだ手元の確認と、下流のアプリの試験に任せる（§17 の危うい点。§4.2 の b を採れば e2e で確かめられる）。
- **e2e・visual**: 配線しない間は足さない（基準画像は変わらない）。b を採るときは、Playwright の `hasTouch: true` の文脈で
  「タップ → 盤 → 確定 → 値」と、`Modal` の中の Esc、axe の走査を足し、`ui-demo` の基準画像を作り直す。
- **実機**（T2 で 1 度、結果をこの文書に書く）: WebView2（Tauri）と Chromium のキオスク表示で、OS のキーボードが出ない・盤がフォーカスを動かさない・
  抵抗膜のパネルで取りこぼさない。
- `pnpm verify:architecture`（`raw-colors`・`raw-dimensions`・`package-bare-imports`・`no-app-import`）は、新しいパッケージにも自動で当たる。

## 15. PR の分け方

1 PR = 1 エージェントで済む大きさ。**T1 → T2 → T3 → T4 → T5** の順。T6・T7 は別の判断。

| PR   | 範囲                                                                                                                                                                                                                                     | 完了条件                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| T0   | この設計書（文書だけ）                                                                                                                                                                                                                   | `pnpm format:check`・`pnpm check:doc-links`                              |
| T1   | パッケージの新設（`packages/touch-keys-svelte`）と登録（版の検査・公開の手引き・template-scope §3 の行・`remove-optional-assets` の節・README の表・ADR）。純粋な関数（数値の下書き・範囲・属性からの推定）と `NumberKeypad`（表示だけ） | §14 の単体のうち数値の分。`verify:architecture`・`check:versions` が緑   |
| T2   | `TouchKeysHost` と `touchKeys`（テンキーだけ）: 開く・確定・取り消し・ポップアップと下の固定・層・`inputmode`・実キーボードとの同時                                                                                                      | §14 の部品と層の分。実機の確かめ                                         |
| T3   | `TextKeyboard`（英数・記号）と最大文字数。ホストに文字の経路                                                                                                                                                                             | §14 の文字の分                                                           |
| T4   | カナの配列（濁点・半濁点・小書き）                                                                                                                                                                                                       | カナの表の試験                                                           |
| T5   | レシピ `docs/recipes/touch-keys.md`（ルートへの置き方、端末ごとの設定、`BantoForm` と `resolve`、Paraglide の束、キーの大きさ、トーストの逃がし方、外し方）。README・AGENTS のレシピの一覧                                               | `check:doc-links`                                                        |
| T6   | （別の Issue）grid: タップで編集を始める・盤の確定でセルを確定する                                                                                                                                                                       | grid の設計で決める                                                      |
| T7   | （§18 の 2 を採るとき）`/ui-demo` のカード、scaffold の外す処理、e2e、基準画像                                                                                                                                                            | `template-acceptance` の dry-run、`visual-baselines.yml`                 |

T1 を小さく保つため、`NumberKeypad` は表示とキーの入力だけにし、入力欄との結びつけは T2 に置く。

## 16. 外す手順

配線しない（§4.2 の a）ので、テンプレートのアプリに外す配線は無い。scaffold はどのプリセットでも触れない。

- **banto から外す**: `packages/touch-keys-svelte/` を消し、`pnpm install` で lockfile を更新する。docs の参照
  （template-scope §3 の行・`remove-optional-assets` の節・レシピ・README の表・この設計書への参照）を外す。
  外部利用 fixture に入れていれば（§17）、その 3 か所（dependencies・`+page.svelte` の import・`optimizeDeps.exclude`）も外す。
- **派生アプリから外す**: ルートのレイアウトの `<TouchKeysHost>`、各入力欄の `{@attach touchKeys(...)}` と `data-touch-keys`、
  端末ごとの設定とその文言、`package.json` の依存と `optimizeDeps.exclude` の行を外す。**入力欄は素の `<input>` のままなので、
  外した後もそのまま動く**（値の経路を変えていない）。

## 17. 危うい点

- **OS のタッチキーボードが出てしまう**: `inputmode="none"` が効かない環境があると、盤と OS のキーボードが両方出る。T2 で実機を確かめる（§7.4）。
  効かなければ、キオスクの設定で OS のキーボードの自動表示を切る、とレシピに書く。
- **フォーカスが動く**: `mousedown` の `preventDefault` が効かない経路（タッチの合成イベントの順が違うエンジン）があると、
  盤を押した瞬間に入力欄が blur して盤が閉じる。T2 の実機で確かめ、効かなければ「blur の後、同じ回のうちに盤のキーが押されたら戻す」を足す。
- **`Modal` の中の Esc を CI で確かめられない**: パッケージの間で import できないので、層の約束は DOM の印だけで繋がる。
  `@banto/ui` の `LAYER_SELECTOR` や `isInOpenPopover` が変わると黙って壊れる。T2 で `@banto/ui` の `layering.test.ts` に
  「開いた popover の中の `data-esc-layer` は、`aria-modal` の層より手前」を 1 件足して、約束を `@banto/ui` の側で固定する。
- **合成した `input` イベントを受けない入力欄**: `isTrusted` を見るアプリのコードがあると値が入らない。banto の forms・grid は見ていない（確かめた）。
  レシピに書く。
- **外部利用 fixture**: `.svelte.ts` を持つパッケージは、rule `external-consumer-fixture` が fixture の dependencies・import・exclude を求める。
  fixture の ref は直近のタグ（いま `v8.0.0`）で、新しいパッケージはそのタグに無い。**T1 では `.svelte.ts` を持たない形**
  （共有の状態は素の `.ts` の登録と、`TouchKeysHost.svelte` の中の `$state`）にして rule に当たらないようにするか、
  image-assets を足したときの手順（ADR-0020 §6）に合わせるかを、T1 の最初に決める。
- **`type="number"` へ書く値**: ブラウザは正規の数の文字列しか受けない。確定で書く形（§8.3）がそこから外れると、値が空になる。単体の表で固定する。
- **範囲が DOM に無い入力欄**（`DraftNumberField`）: `resolve` を書き忘れると、範囲なしのテンキーになる（forms の検証は効くが、
  「その場で知らせる」にならない）。レシピの見本に入れる。forms が範囲を属性に出す形は、コアがオプションの都合を知ることになるので採らない。
- **下の固定の盤が入力欄を隠す**: 寄せられない配置では、入力欄そのものは見えない（盤の表示の行で補う。§7.5）。
- **カナの幅**: 11 列は、600px より狭い画面でキーが 12 mm を割る。狭い画面でカナを使う案件が出たら、行ごとに切り替える配列を考える。
- **横断性が弱いまま面積が増える**: 利用先が 1 つのままなら、オプションから外すことを見直す（image-assets と同じ合図）。

## 18. 確かめたい点（オーナーの判断）

| #   | 決めること                                                     | 推奨                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 置き場所（§4.1）                                               | **新しいオプションのパッケージ `touch-keys-svelte`**。`@banto/ui`（コア）には足さない。別案: `@banto/ui` に足す（登録が要らないが、コアが太る）                                                         |
| 2   | アプリへの配線（§4.2）                                         | **配線しない（recipe-only）**。T4 の後に、`/ui-demo` のカード（b）を別に判断する。b の利点は実ブラウザの e2e、代償は scaffold・template-scope の行・`ui-demo` の基準画像の作り直し                            |
| 3   | カナの形（§9.2）                                               | **全角のカタカナだけを、IME を通さず直接**。濁点・半濁点・小書きは直前の 1 文字に後から掛ける。ひらがな・漢字・半角カナは入れない。半角が要る案件はアプリが確定の後に変換する                                 |
| 4   | テンキーの最初の 1 打（§8.3）                                  | **いまの値を置き換える**（最初に「1 文字消す」を押したら、いまの値の末尾を消す）。別案: いつも末尾に足す                                                                                                       |
| 5   | 盤の外をタップしたとき（§6.2）                                 | **取り消し**（書くのは「確定」を押したときだけ。誤って触れて値が変わるのを避ける）。別案: 確定として書く／何もしない（閉じるには取り消しを押す）                                                               |
| 6   | パスワードの入力欄（§5.4）                                     | **T3 で対象にする**（下書きは伏せ字、配列は英数と記号だけ）。タッチだけの端末でログインできないと、認証無効モード以外で使えないため。別案: 対象にしない                                                         |
| 7   | grid のセルの編集（§6.4）                                      | **この Issue から外し、別の Issue を立てる**（タップで編集を始める・盤の確定でセルを確定する）。この設計の盤は、編集に入った後の入力欄にはそのまま出る                                                         |
| 8   | 日付・時刻の文字の欄（§6.4）                                   | **既定では対象のまま**にし、レシピでアプリの包みに `data-touch-keys="off"` を付ける形を示す（`@banto/ui` は変えない）。別案: `@banto/ui` の部品が自分で `data-touch-keys="off"` を出す（コアが印の名前を知る） |
| 9   | `NumberKeypad` / `TextKeyboard` を単体でも公開するか（§5.3）   | **公開する**（入力欄と結びつけずにページへ置く専用の入力画面のため）。別案: ホストだけ公開し、要望が出てから                                                                                                   |
| 10  | キーの大きさの変数（§10）                                      | **部品の CSS 変数 `--banto-touch-key-size`（既定 48px）にし、theme には足さない**。密度に繋げたくなったら、theme の touch の区画に 1 行足す                                                                    |
| 11  | 有効・無効の決め方（§12）                                      | **明示の `enabled`（必須）だけ**。自動判定は持たない。レシピで端末ごとの設定（`localStorage`）を示す。`coarsePointer` の補助は出さない（要望が出てから）                                                       |
| 12  | 既定の出し方（§5.1）                                           | **テンキーはポップアップ、文字キーボードは下の固定**。どちらも prop と入力欄ごとの指定で変えられる                                                                                                             |
| 13  | ADR を書くか                                                   | **T1 で書く**（新しいオプションのパッケージと、`@banto/ui` に足さない理由。ADR-0020 と同じ扱い）                                                                                                               |

未確定のまま残る点（実装で確かめる）: パッケージと公開の名前、`.svelte.ts` を持つか（§17）、`inputmode="none"` を付ける時機と実機での効き、
ポップアップの位置（中央か、対象の入力欄の近くか。`@banto/ui` の `anchoredPopover.ts` は公開されていないので、近くに出すなら自前の配置が要る）、
記号の中身、`change` を出すか（forms・grid は `input` だけで足りる。アプリの `onchange` のために出す見込み）、
`note` のスニペットが要るか、狭い画面でのカナの配列。
