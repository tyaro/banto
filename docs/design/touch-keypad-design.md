# タッチ向けの画面内テンキー・文字キーボード 設計書 — Issue #937

作成日: 2026-11-25
状態: **§18 はオーナー決定済み（2026-11-25、推奨どおり）。T1〜T3 実装済み、T4〜T7 未着手**（T1 = パッケージ登録・数値の純粋な関数・`NumberKeypad` の表示、PR #951。T2 = `TouchKeysHost`・`touchKeys`（テンキー）・ブラウザーの fixture、PR #954。T3 = `TextKeyboard`（英数・記号）・最大文字数・ホストの文字の経路・パスワードの入力欄。T2 で決めた形は §15.1、T3 で決めた形は §15.2、実機の確かめ（§14.4）は未実施）
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
| **a. 配線しない（recipe-only。推奨・第一案）**  | 基準画像が 1 枚も変わらない。scaffold は触れない。template-scope §3 の「削除可能デモ」の義務を負わない | 実ブラウザでの確かめは、パッケージの中の専用の fixture で行う（§14.3）。見本を触って確かめる場所は無い                                                                                                                      |
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
	/**
	 * 確定して値を書いた後。`value` は入力欄に書いた文字列、`previous` は開いたときの値。
	 * **パスワードの入力欄では、どちらも `null`**（平文を渡さない。§5.5）。
	 */
	onconfirm?: (detail: {
		input: HTMLInputElement;
		value: string | null;
		previous: string | null;
	}) => void;
	/** `reason` は、なぜ閉じたか（§6.2）。下書きは渡さない。 */
	oncancel?: (detail: { input: HTMLInputElement; reason: TouchKeysCancelReason }) => void;
	/**
	 * 下書きの表示の下に足す 1 行（単位・注意書きなど）。
	 * **パスワードの入力欄では `draft` は `null`**（§5.5）。
	 */
	note?: Snippet<[{ input: HTMLInputElement; draft: string | null }]>;
}

type TouchKeysCancelReason =
	| 'cancel-key' // 取り消しのキー・Esc
	| 'outside' // 盤の外のタップ
	| 'hardware-input' // 実キーボード・スキャナ（§6.3）
	| 'target-gone' // 対象が消えた・フォーカスを失った・readonly / disabled・フォームの送信
	| 'target-changed' // 開いたときと、対象の値か編集の世代が違う（§6.5）
	| 'disabled'; // ホストの enabled が false になった

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
	/**
	 * いま、この入力欄が編集しているもの（レコードの id、編集の世代など）。
	 * 開いたときと確定の直前で比べ、違えば書かずに取り消す（§6.5）。
	 * 同じ `<input>` を別のレコードに使い回す画面では渡す。
	 */
	editKey?: string | number | (() => string | number | null | undefined);
}

interface NumberKeysOptions extends CommonKeysOptions {
	kind: 'number';
	min?: number;
	max?: number;
	/**
	 * 刻み。与えると、確定できる値は「基点 + 刻みの整数倍」だけ（§8.2）。
	 * 基点は `min`（無ければ 0）。省くと、属性から読む（§5.4）。
	 */
	step?: number;
	/** 小数の桁。0（既定）は小数点のキーを出さない。省くと `step` の桁。 */
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

`TextKeyboard` も同じ形（`maxLength`・`required`・`layouts`・`initialLayout`・`masked`・`onlength`）。公開するかは §18 の 9
（公開した。T3 で決めた形は §15.2）。

### 5.4 推定（属性から読む）

指定（`touchKeys` → `resolve` の順）が無い入力欄は、属性から決める。

| 入力欄                                                                   | 盤             | 読む属性                                                                              |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------- |
| `type="number"`、または `inputmode="numeric"` / `"decimal"` | テンキー | `min`・`max`・`step`（下の「数値の属性」）。`numeric` は小数なし |
| `type="text"` / `"search"` / `"tel"` / `"url"` / `"email"`・`type` なし  | 文字キーボード | `maxlength`                                                                           |
| `type="password"` | 文字キーボード（§5.5。対象にするかは §18 の 6） | `maxlength` |
| `readonly`・`disabled`・`data-touch-keys="off"`・`<textarea>`・`<select>`・日付や色などほかの `type` | 出さない       | —                                                                                     |

**数値の属性**（[HTML の `type=number`](<https://html.spec.whatwg.org/multipage/input.html#number-state-(type=number)>) の決まりに合わせる）:

- **`type="number"`**: ブラウザが実際に検証に使う値をそのまま使う。`step` 属性が無ければ刻みは 1、`any` なら刻みなし、
  正の数でなければ 1。**基点（step base）は `min` 属性、無ければ `value` 属性（初期値）、どちらも無ければ 0**。
  例: `min="0.05" step="0.10"` で確定できるのは `0.05`・`0.15`・`0.25`…で、`0.10` は範囲内・2 桁でも確定できない。
  小数の桁は、刻みと基点の桁の大きいほう（`any` なら上限まで）。
- **`type="text"` + `inputmode`**: ブラウザは `min`・`max`・`step` を検証しない。属性があれば同じ読み方で使い、無ければ制約なし
  （`inputmode="decimal"` の小数の桁は上限まで、`numeric` は 0）。
- 指定（`touchKeys`・`resolve`）の `min`・`max`・`step` は属性より先に見る。ただし **`type="number"` では、属性の制約も必ず満たす**
  （指定で緩めることはできない。ブラウザの `validity` と食い違う値を書かないため）。

### 5.5 パスワードの入力欄

対象にするなら（§18 の 6）、表示を伏せるだけでなく、**平文を盤の外へ出さない**ことを契約にする。

- 下書きの表示は、全部の文字を伏せ字にする（直前の 1 文字を見せることもしない）。文字数だけ出す。
- **汎用の口に平文を渡さない**: `onconfirm` の `value`・`previous` は `null`、`note` の `draft` は `null`（§5.1）。
  `oncancel` は元から下書きを受けない。`resolve` が受けるのは要素だけ。開発用の記録（`console`）にも下書きを出さない。
  単体の `TextKeyboard` を `masked` で使うときも、`draft` を外から読める形（`$bindable`）にはせず、`onconfirm` の 1 回だけで渡す。
- **下書きを残さない**: 確定・取り消し・別の入力欄への切り替え・`enabled` が false・ホストの破棄のどれでも、閉じるときに下書きを空にする。
  閉じた盤の状態に文字列を持ち越さない（次に開いた盤が前の下書きを見せない）。パスワードの入力欄では、開いたときの下書きも空から始める
  （いまの値を写さない。§6.5 の照合は値そのものを比べるが、外には出さない）。
- 知らせの行（`aria-live`）に下書きを入れない。
- **配列**: 英数と記号だけ（カナは出さない）。記号は、ASCII の印字できる記号の全部（32 個）と空白。
  **ASCII の印字できる文字（U+0020〜U+007E）の全部を打てる**ことを受け入れの試験にする（既にある認証情報を入れられること）。
  ASCII の外の文字を含むパスワードは打てない（レシピに書く）。
- `type="password"` かどうかは、**開いたとき**に決める。開いている間に `type` が変わったら（「表示する」の切り替え）、取り消す。

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
3. 下書きは、入力欄のいまの値から始める（§8.3・§9.4）。このとき、**開いたときの値と編集の世代を覚える**（§6.5）。
4. **確定**: 確定できる下書き（§8.2）のときだけ押せる。押したら、①対象が開いたときと同じかを照合し（§6.5）、
   ②下書きを正規の形にして入力欄の `value` に書き、③書いた値が入力欄に残ったことを確かめてから（§8.3）、
   `input`、続けて `change` を出す（どちらも `bubbles: true`）。盤を閉じる。フォーカスは入力欄に残す。
   ①か③で外れたら、**書かず・イベントも出さず**に取り消す（`target-changed`）。
5. **取り消し**: 何も書かずに閉じる。フォーカスは入力欄に残す。
6. **盤の外をタップ**: 取り消し（§18 の 5）。**そのタップは盤の受け面が受け、下の画面には届かない**（§7.2.1）。
   タップした所が別の対象の入力欄だったときだけ、いまの盤を取り消して、その欄の盤を開く。
7. **対象の入力欄が消えた・フォーカスを失った・`readonly` / `disabled` になった・`type` が変わった・対象のフォームが送信された・
   ホストの `enabled` が false になった**: 取り消し。親（`Modal`・ページ）が閉じる・移るときは、この経路で盤も閉じる。
   **盤が親を閉じさせない・引き止めないし、閉じる途中で下書きを書くこともしない**。

`type="number"` の入力欄は、途中の文字列（`1.`・`-`）を `value` に持てない（ブラウザが空にする。`DraftNumberField` の
doc コメントが同じ理由で `type="text"` にしている）。**下書きを盤の中に持ち、確定のときだけ書く**ので、`type="number"` でも困らない。

### 6.3 実キーボードと同時に使われたとき

盤が開いている間に、対象の入力欄へ**実キーボード（やスキャナ）からの入力**が届いたら、盤は取り消しで閉じる
（`keydown`（修飾キーだけ・Esc を除く。Enter は下の表）か、対象の入力欄の `beforeinput`）。値の持ち主を 2 つにしない。
**`isTrusted` は見ない**（T2 で決めた）: 盤のキーは `keydown` も `beforeinput` も出さないので、届いたものは盤の外からの入力と分かる。
見ないことで、jsdom の部品の試験でも同じ経路を確かめられる。

- `@banto/scan-wedge` は window の `keydown` を読む。盤のキーは `keydown` を出さないので、盤の入力がスキャンと誤認されることは無い。
  盤が開いている欄にスキャンが来たら、盤が閉じてスキャンの文字が入る。
- `keepFocused`（scan-wedge。スキャン用の欄にフォーカスを戻し続ける）と併用しても、盤はフォーカスを動かさないので争わない。
- **実キーボードの Enter**（盤が開いているとき）は、**盤に未確定の変更があるか**で分ける。
  未確定の変更 = 開いてから盤のキーで下書きを変え、いまの下書きが開いたときの値と違うこと（パスワードの入力欄では、下書きが空でないこと）。

  | 盤の状態 | その Enter | 入力欄・フォーム |
  | --- | --- | --- |
  | **未確定の変更がある** | **盤を取り消しで閉じるだけ**。ホストが捕捉の段で `preventDefault` し、伝播も止める | 書かない・送信しない。入力欄の `keydown` の処理（forms の確定、grid のセルの確定）も走らない |
  | 未確定の変更が無い（開いただけ） | 盤を閉じ、Enter はそのまま通す | 入力欄のいまの値で、通常どおり送信 |
  | 盤が閉じている | 盤は関わらない | 通常どおり |

  未確定の変更があるのに Enter をそのまま通すと、**盤に見えている値で送れたように見えて、実際には開く前の値が送られる**。
  1 回目の Enter は盤を閉じる（下書きが消えて、入力欄の元の値が見える）だけにし、**もう 1 度の Enter か保存のボタン**で通常どおり送信する。
  盤の下書きを Enter で確定に読み替えることはしない（Enter 1 回で「書いて、送る」まで進むのは、タッチと実キーボードを併せて使う
  操作者には強すぎる。確定は盤の「確定」だけ）。
- Enter より先に、**ほかの実キーやスキャナの入力が盤を閉じていた**ときは、Enter の時点で盤は閉じているので、通常どおり通る
  （スキャナは文字の後に Enter を送る。文字の 1 打目で盤が閉じ、最後の Enter でフォームが送られる。今までどおり）。
  実キーの文字で盤が閉じるときは、未確定の変更があっても、その文字はそのまま入力欄に入る（利用者が入力欄に直接打ち始めた）。
- 盤の「確定」は、フォームを送信しない（入力欄に書くだけ）。送信は、利用者が保存のボタンを押す。
- **押したままの Enter（自動リピート、`event.repeat`）では送らない**（T2 の受け入れ）。盤を閉じた Enter（未確定の変更があったとき）の
  後に続くリピートは、キーを離す（`keyup`）まで捕捉の段で止める。盤が開いているときに届いたリピートの Enter は、未確定の変更が無くても
  通さない（盤を閉じるだけ）。「もう 1 度の Enter」は、離してから押し直した Enter のこと。

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

### 6.5 開いたときと確定の直前の照合

盤が開いている間に、対象の入力欄の**意味**が変わることがある: 同じ `<input>` のノードを使い回す画面で別のレコードに切り替わる、
サーバーから読み直した値が入る、ほかのコードが `value` を書く。ノードが残り、フォーカスも動かないので、§6.2 の 7 では見つからない。
古い下書きを新しいレコードに書かないよう、**確定の直前に 2 つを照合し、どちらかが違えば書かずに取り消す**（`target-changed`）。

| 照合するもの | 開いたとき | 確定の直前 |
| --- | --- | --- |
| **値** | `input.value` を覚える | `input.value` が同じ文字列か。違えば、誰かが書き換えた |
| **編集の世代**（`editKey`。§5.2） | 値（関数なら呼んだ結果）を覚える | 同じか（`Object.is`）。違えば、別のレコード・別の編集になった |

- `editKey` は、アプリが「いま何を編集しているか」を渡す口（レコードの id、`FormDraft` の世代、編集の開始ごとに増える番号など）。
  **値がたまたま同じ別のレコード**（どちらも `0`）は値の照合では見つからないので、ノードを使い回す画面では `editKey` を渡す、とレシピに書く。
  `resolve` で返す指定にも同じ項目がある（`BantoForm` を別のレコードに使い回す画面は、ここでレコードの id を返す）。
- 照合は確定の直前に必ず行う。加えて、開いている間に attachment の指定が変わった（Svelte が attachment を付け直した）ときと、
  対象のフォームの `reset` でも、同じ照合をして外れたら取り消す。プログラムからの `value` の代入はイベントが出ないので、
  開いている間は見張らない（確定の直前の照合が受ける）。
- 取り消したときは、盤を閉じ、`oncancel` に `reason: 'target-changed'` を渡す。アプリは、知らせ（トーストなど）を出せる。
  盤そのものは閉じるので、文言は持たない。
- 遅れて届く処理（閉じた盤の後始末、付け直された attachment）は、開いた回の番号で無効にする（conventions §8）。

## 7. 層の扱い

### 7.1 出し方

盤は 2 つの出し方のどちらでも、**`popover="manual"` で top layer に出す**（`PickerDialog` と同じ手）。

- `Modal`（z 900）・コマンドパレット（overlay 1000）の中の入力欄から開いても、盤が必ず手前に出る。z のトークンを足さない。
- 祖先の `transform` / `filter` が固定配置の基準になる問題（ADR-0018 §10）を受けない。
- **ポップアップ**: 画面の中央。背景は暗くする（`--banto-scrim`）。**下の固定**: 下の端に幅いっぱい、背景は暗くしない。
- どちらも、popover の要素そのものを**画面いっぱいの受け面**にし、盤はその中に置く（§7.2.1）。
  標準の `::backdrop` は使わない（popover の `::backdrop` は `pointer-events: none` で、ポインターを下へ通す。
  [HTML の描画規則](https://html.spec.whatwg.org/multipage/rendering.html#the-popover-attribute)）。

`Modal` そのもの（`OverlayPanel`）は使わない。`Modal` は開くとフォーカスを中へ移し、罠を掛ける。盤でそれをすると、
対象の入力欄が blur し、grid の確定や forms の `onBlur` が盤を開いた瞬間に走る。

### 7.2 フォーカス

- 盤のキーは `<button type="button" tabindex="-1">`。盤の `mousedown`（と `pointerdown`）を `preventDefault` して、
  押してもフォーカスが対象の入力欄から動かないようにする（`PickerDialog` の `onmousedown` と同じ考え方）。
- 盤はフォーカスを取らないので、**フォーカスの戻しは要らない**（動いていない）。`Modal` の罠（`focusin` の引き戻し）にも掛からない。
- `Modal` の暗幕のクリック（`handleOverlayClick`）は、押された要素が暗幕そのもののときだけ閉じる。盤は top layer の別の要素なので、
  盤を押しても下の `Modal` は閉じない。

#### 7.2.1 盤の外のタップを下へ通さない

`popover="manual"` は手前に**見える**だけで、盤の外のタップは下の画面に届く。取り消しのつもりで盤の外をタップした同じ操作が、
下の「保存」に当たると、**確定していない古い値のままフォームが送られる**。「閉じる」に当たると、親ごと閉じる。これを止める。

- popover の要素は `position: fixed; inset: 0` の**受け面**（下の固定では透明、ポップアップでは `--banto-scrim`）。
  盤はその子。受け面は `pointer-events: auto` なので、盤の外のポインターの操作は受け面が的になり、下の要素は
  `pointerdown`・`click` を受けない（`Modal` の暗幕と同じ仕組み。捕捉の段で止めるのではなく、的そのものを受け面にする）。
- 受け面は、押してもフォーカスを取らない（`mousedown`・`pointerdown` を `preventDefault`。盤のキーと同じ。§7.2）。対象の入力欄は `blur` しないので、§6.2 の 7（フォーカスを失ったら取り消し）が `click` より先に走って受け面が消えることは無い。
- 受け面の `click`: 取り消しで閉じる。**同じ操作では、下の画面に何も起きない**（保存も、親の `Modal` を閉じることも、
  リンクの移動も）。下のボタンを押すには、もう 1 度タップする。
- **例外は 1 つ: 別の対象の入力欄**。受け面を押した位置の下（`document.elementsFromPoint` で受け面を除いた先頭）が盤の対象になる
  入力欄なら、いまの盤を取り消し、その入力欄にフォーカスを入れて、その欄の盤を開く。入力欄から入力欄へ 1 回のタップで移れる。
  対象でない入力欄・ボタン・リンクは例外にしない。
- 開いている間、指でのページのスクロールは受け面が止める（`touch-action: none`）。開いたときに対象を見える所へ寄せる（§7.5）。
- 親が自分で閉じる場合（保存の完了・時間切れ・セッションの失効で `Modal` やページが消える）は、§6.2 の 7 で盤も取り消しで閉じる。
- `Modal` の `handleOverlayClick` は「押された要素が暗幕そのもの」のときだけ閉じるので、受け面への `click` では閉じない
  （受け面は top layer の別の要素で、`Modal` の暗幕の子でもない）。
- 受け入れ: 保存のボタンと、対象の入力欄を持つ画面で、**「盤を開く → 保存のボタンの位置をタップ → 盤だけが閉じ、入力欄の値は変わらず、
  `input`・`change`・`submit` は 1 度も出ない」**。`Modal` の中でも同じ（`Modal` は開いたまま）。jsdom は当たり判定を持たないので、
  ブラウザーの fixture で確かめる（§14）。

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
実機で確かめる**（§14.4。効かない環境があれば `virtualkeyboardpolicy="manual"` を併せて試す）。

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

### 8.2 下書きの状態と、確定できる値

**「入力の途中」と「確定できる値」を分ける。** 打てるかどうか（キーが入るか）と、確定できるかどうかは別の判定にする。
下書きは、次の 4 つのどれか 1 つ（純粋な関数 1 つが決める。盤の表示・確定のキー・書き込みは、この結果だけを見る）:

| 状態 | 例 | 確定 | 知らせ |
| --- | --- | --- | --- |
| **空** | `""` | `required` でなければ可（空を書く）。`required` なら不可 | `required` のときだけ「入力が必要」 |
| **途中**（数になっていない） | `-`・`.`・`-.` | **不可** | 出さない（打っている途中） |
| **数だが確定できない** | 範囲の外、刻みに合わない | **不可** | 範囲、または刻みの知らせ |
| **確定できる値** | `12`・`0.15`・`1.`（→ `1`）・`-0`（→ `0`） | 可 | — |

- 途中の状態は**打てる**（`15` を入れる途中の `1` が `min = 10` を下回る、`-` の後に数字を打つ）。止めるのは確定だけ。
- 末尾の `.`（`1.`）・先頭の `.`（`.5`）は、正規の形（`1`・`0.5`）にすれば数なので、数として判定する。
- **範囲**: 数が `min` 以上 `max` 以下か。
- **刻み**: 刻みがあるとき（§5.4）、`(値 − 基点)` が刻みの整数倍か。浮動小数の誤差を避けるため、値・基点・刻みを
  小数の桁で 10 の累乗倍した**整数どうし**で割り切れるかを見る（`0.15 − 0.05` を `0.1` で割る、を `15 − 5` と `10` で見る）。
  合わないときは、近い 2 つの値（すぐ下・すぐ上）を知らせに出す（ブラウザの検証の文言と同じ考え方）。
  **値を勝手に丸めて書くことはしない。**
- **小数の桁**: `decimals` を超える桁は打てない（キーを押しても入らない）。
- **負の数**: `±` は符号を入れ替える（どの位置でも押せる。空に押すと `-`）。`allowNegative` が false ならキーを出さない。
- **桁の上限**: 有効な桁は 15 桁まで（`Number` で正確に比べられる範囲）。超える桁は打てない。
- 小数点は `.`、桁区切りは出さない。指数の書き方（`1e3`）は打てない（キーが無い）。

### 8.3 確定と取り消し

- **最初の 1 打**: 開いたとき、下書きは入力欄のいまの値。**最初に数字を打つと、いまの値を置き換える**（HMI のテンキーの慣習）。
  最初に 1 文字消すを押したら、いまの値の末尾を消す（§18 の 4）。
- **符号キー**: 開いた直後に押すと、**いまの値に符号を付け、置き換えの扱いを終える**（続けて打つ数字は後ろに付く）。
  いまの値が `7` なら、`±` で `-7`、続けて `3` で `-73`。もう 1 度押すと符号が外れる。
- **確定で書く形**: 末尾の `.` を取る、先頭の `.` には `0` を足す、先頭の余分な `0` を取る、`-0` は `0`。
  `decimals` に満たない桁は足さない（`1.5` は `1.5` のまま）。
- **書く前の検査**: 書く文字列は、空か、HTML の「正しい浮動小数点数」（`-?\d+(\.\d+)?`。盤は指数を作らない）に限る。
  途中の状態（`-`・`.`）は §8.2 で確定できないので、ここには来ない。来たら書かない（二重の守り）。
- **書いた後の確かめ**: `type="number"` の入力欄は、受け付けない文字列を**黙って空に置き換える**。書いた直後に `input.value` を読み、
  書いた文字列と違えば、**開いたときの値に戻し、`input`・`change` を出さず**に、取り消しで閉じる（`target-changed`）。
  「空に化けた値が、変更としてフォームに流れる」ことを起こさない。
- 確定の直前に、ブラウザの検証も見る（`type="number"` のとき）: 書いた後に `input.validity` の `rangeUnderflow`・`rangeOverflow`・
  `stepMismatch`・`badInput` のどれかが立ったら、同じく戻して取り消す。盤の判定とブラウザの判定が食い違ったときに、ブラウザを正にする。
- 1 文字消すは押すたびに 1 文字（押しっぱなしで連続して消すことはしない。§11）。全部消すが別にある。

## 9. 文字キーボード

### 9.1 配列

- **英数（`alnum`）**: 数字の段 + QWERTY の 3 段 + 空白。大文字・小文字は**切り替えのキー**（押すたびに入れ替わり、次に押すまで続く。
  1 文字だけ大文字にする動き・長押し・ダブルタップは使わない）。
- **カナ（`kana`）**: 五十音の表（ア〜ワ行 + ン・ー）+ 濁点・半濁点・小書き + 空白。
- **記号（`symbol`）**: 必要な分だけ。見込みは `- _ . , / : @ # ( ) + * = % & ! ?`。
  パスワードの入力欄では、ASCII の印字できる記号の全部（§5.5）。
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
パスワードの入力欄だけは、空の下書きから始める（§5.5）。

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
  濁点、半濁点、小書き、範囲の知らせ `(min, max) =>`、刻みの知らせ `(lower, upper) =>`、入力が必要、文字数 `(length, max) =>`。
  パッケージは辞書も Paraglide も持たない。アプリは Paraglide のキーから作った束を渡す（レシピに見本）。
- キーの字（`0`〜`9`・英字・カナ・記号）は文言ではないので、パッケージに直に持つ。

## 14. 試験の方針

確かめる場所を 4 つに分ける。**jsdom は、当たり判定・top layer・フォーカスの動き・ブラウザの数値の検証を持たない**ので、
そこに頼る約束は jsdom の試験に書かない（通っても何も確かめていないため）。

### 14.1 単体（純粋な関数。vitest）

- 数値の下書き（1 打ごとの表を 1 行ずつ: 置き換え・小数の桁・符号・15 桁）。
- **下書きの状態**（§8.2 の表を 1 行ずつ）: 空（`required` あり・なし）、途中（`-`・`.`・`-.`）、範囲の外、刻みに合わない、確定できる値
  （`1.`・`.5`・`-0`・`007`）。
- **刻みと基点**: `min=0.05, step=0.10` で `0.10` は不可・`0.05` と `0.15` は可／`min` 無し・`value` 属性ありの基点／どちらも無ければ 0／
  `step` 無しは 1／`any` は刻みなし／負の基点／浮動小数の誤差が出る組（`0.1`・`0.2`・`0.3`）を整数の計算で正しく判定する。
- 確定で書く形と、書く前の検査（正しい浮動小数点数だけ）。
- 属性からの推定（§5.4 の表と「数値の属性」を 1 行ずつ。`type="number"` は指定で緩められない）。
- カナ（濁点・半濁点・小書きの表を全部、掛けられない文字、往復）、最大文字数。
- パスワードの記号: 英数と記号の配列で、U+0020〜U+007E の 95 文字を全部作れる（表から機械的に数える）。

### 14.2 部品（jsdom + `@testing-library/svelte`）

DOM の出入りと、呼ぶ・呼ばないだけを見る。

- タップで開く・`focus` では開かない／確定で `value` が書かれ `input` と `change` が 1 回ずつ出て `bind:value` に届く／取り消しは何も出さない／
  確定できない状態では確定が `disabled`／実キーボードの文字の `keydown` で閉じ、キーは `preventDefault` されない／**Enter**（§6.3）: 未確定の変更があれば盤が閉じて `preventDefault` され、入力欄の `keydown` の処理が呼ばれず、値も変わらない。開いただけなら `preventDefault` されない。文字の `keydown` で閉じた後の Enter は `preventDefault` されない／対象が消えたら閉じる／
  `enabled` が false なら何もしない・`inputmode` を戻す／`touchKeys(false)` と `data-touch-keys="off"`／`resolve`／`messages` の差し替え。
- **照合**（§6.5）: 開いた後に `input.value` を書き換えてから確定 → 書かれない・`input` も `change` も出ない・`oncancel` に `target-changed`／
  `editKey` が変わってから確定 → 同じ／値が同じで `editKey` だけ違う → 同じ／どちらも同じ → 書かれる／`reset`・フォームの送信で閉じる。
- **書いた後の確かめ**（§8.3）: `value` の setter が受け付けずに空にする入力欄の代役で、開いたときの値に戻り、イベントが出ない。
- **パスワード**（§5.5）: `onconfirm` の `value`・`previous` が `null`／`note` の `draft` が `null`／表示と知らせの行に平文が無い
  （盤の `textContent` に打った文字が現れない）／取り消し・別の欄への切り替え・`enabled` を false・ホストの破棄の後、
  次に開いた盤の下書きが空／開いている間に `type` を変えると閉じる。
- 層: Esc を盤が消費する・`defaultPrevented` なら譲る・開いている間だけ `data-esc-layer` がある、まで。
- popover は jsdom に無いので、`@banto/ui` の試験と同じ代役（`showPopover` / `hidePopover` を足す）を使う。

### 14.3 ブラウザーの fixture（Playwright。テンプレートには配線しない）

パッケージの中に、**専用の最小の画面**を 1 つ置く（見込み: `packages/touch-keys-svelte/tests/browser/`。素の Svelte の 1 ページを
vite で出し、Playwright の `hasTouch: true` の文脈で開く）。admin-template に依存させず、ナビも基準画像も変えない。
`@banto/ui` を import できないので、**fixture の画面だけ**が `@banto/ui` の `Modal` と `@banto/theme` の CSS を使う。
**T2 で決めた形: devDependency は足さず、相対パスで読む**（`tests/browser/App.svelte` が `../../../ui/src/Modal.svelte` と
`../../../theme/src/css/banto.css` を import する）。`package.json` も lockfile も変わらず、conventions §4 の
「`dependencies` / `peerDependencies` は空」「パッケージの間の `from '@banto/...'` は無い」「`src` の素の import は svelte だけ」は
文字どおり保たれる（rule `package-bare-imports`・`raw-colors`・`raw-dimensions` は `/src/` の下だけを見るので、fixture は `src` という
名前のフォルダを作らない）。Playwright と axe はルートの devDependency を使う（`fixtures/external-consumer` と同じ）。
実行はルートで `pnpm e2e:touch-keys`（設定は `tests/browser/playwright.config.ts`、試験は vitest が拾わないよう `*.e2e.ts`）。
CI は `ci.yml` のジョブ `touch-keys-browser`（§18 の 14）。`packages/touch-keys-svelte/`・`packages/ui/`・`packages/theme/` を触る PR と
main への push で走り、ほかの PR では飛ばす。

確かめること（jsdom では確かめられないもの）:

- **外のタップ**（§7.2.1）: 盤を開く → 保存のボタンの位置をタップ → 盤だけが閉じ、入力欄の値は変わらず、`input`・`change`・`submit` が
  1 度も出ない。もう 1 度タップすると保存が押される。`Modal` の中でも同じ（`Modal` は開いたまま）。
  別の対象の入力欄をタップ → 1 回で、その欄の盤に替わる。
- **層**: `Modal` の中から開いて Esc 1 回で盤だけが閉じ、2 回目で `Modal` が閉じる。盤が `Modal` とトーストより手前に見える。
- **フォーカス**: キーをタップしても `document.activeElement` が対象のまま。`<input>` の `blur` が 1 度も出ない。
- **受け面とフォーカス**: 受け面（盤の外）を押した `pointerdown` で、対象の入力欄のフォーカスが奪われない（`blur` が出ない）。`blur` を合図に盤が先に閉じて、`click` が届く前に受け面が消え、同じタップが下の画面に抜ける、が起きない（押してから離すまでの間、受け面が残っている）。取り消しは `click` で 1 回だけ起きる。
- **数値とブラウザの検証**: `type="number"`・`min="0.05"`・`step="0.10"` で `0.10` は確定できず、`0.15` を確定した後の `validity.valid` が真。
  確定の後、`value` が空に化けていない。
- **実キーボードの Enter**（§6.3）: 盤で値を変えてから Enter → 盤だけが閉じ、入力欄の値は開く前のまま、`submit` は出ない。もう 1 度 Enter → 開く前の値で 1 回だけ送信される。開いただけ（変更なし）で Enter → 盤が閉じ、1 回だけ送信される。盤で値を変えた後、実キーで文字を打ってから Enter（スキャナの形）→ 打った文字が入り、1 回だけ送信される。
- **パスワード**: ASCII の印字できる 95 文字を盤で打って確定し、入力欄の値が一致する。
- axe の走査（盤が開いた状態）。

### 14.4 実機（T2・T3 で 1 度ずつ。結果をこの文書に書く）

Playwright の `hasTouch` は合成のタッチで、OS のキーボードも実物のパネルも持たない。次は**実機でしか確かめられない**:

- **WebView2（Tauri）のタッチの実機**と、Chromium のキオスク表示: `inputmode="none"` で OS のタッチキーボードが出ない／
  盤のキーを指で押してもフォーカスが動かない（タッチの合成イベントの順）／外のタップが下に抜けない／抵抗膜のパネルで取りこぼさない。
- キーの実寸（定規で測り、`--banto-touch-key-size` をいくつにすれば 12 mm になるかをレシピの例にする）。

**T2・T3 の時点では未実施**（開発の環境にタッチの実機・WebView2 のキオスクが無い）。確かめる項目は T2・T3 の PR の本文に並べ、
実機の確かめの Issue（#757）に足す。結果が出たら、ここに書く。T3 で足す項目: 文字キーボード（下の固定）を指で続けて打っても
フォーカスが動かず取りこぼさない／パスワードの入力欄で OS のキーボードも、OS・ブラウザーのパスワードの補完の吹き出しも盤に重ならない／
幅の狭いパネルで 10 列のキーが押せる大きさに収まる／`\` のキーが日本語のフォントで `¥` の形に見えても、入る文字は U+005C。

### 14.5 そのほか

- **e2e・visual**（admin-template）: 配線しない間は足さない（基準画像は変わらない）。§4.2 の b を採るときは、`ui-demo` の基準画像を作り直す。
- `pnpm verify:architecture`（`raw-colors`・`raw-dimensions`・`package-bare-imports`・`no-app-import`）は、新しいパッケージにも自動で当たる。

## 15. PR の分け方

1 PR = 1 エージェントで済む大きさ。**T1 → T2 → T3 → T4 → T5** の順。T6・T7 は別の判断。

| PR   | 範囲                                                                                                                                                                                                                                     | 完了条件                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| T0   | この設計書（文書だけ）                                                                                                                                                                                                                   | `pnpm format:check`・`pnpm check:doc-links`                              |
| T1   | パッケージの新設（`packages/touch-keys-svelte`）と登録（版の検査・公開の手引き・template-scope §3 の行・`remove-optional-assets` の節・README の表・ADR）。純粋な関数（数値の下書き・範囲・属性からの推定）と `NumberKeypad`（表示だけ） | §14.1 の数値の分。`verify:architecture`・`check:versions` が緑   |
| T2 | `TouchKeysHost` と `touchKeys`（テンキーだけ）: 開く・確定・取り消し・ポップアップと下の固定・受け面（外のタップ）・層・`inputmode`・実キーボードとの同時・照合（`editKey`）・書いた後の確かめ。ブラウザーの fixture とその CI のジョブ | §14.2 と §14.3 のテンキーの分。§14.4 の実機 |
| T3 | `TextKeyboard`（英数・記号）と最大文字数。ホストに文字の経路。パスワードの入力欄（§5.5。§18 の 6 を採るとき） | §14.1〜§14.3 の文字とパスワードの分。§14.4 の実機 |
| T4   | カナの配列（濁点・半濁点・小書き）                                                                                                                                                                                                       | カナの表の試験                                                           |
| T5   | レシピ `docs/recipes/touch-keys.md`（ルートへの置き方、端末ごとの設定、`BantoForm` と `resolve`、Paraglide の束、キーの大きさ、トーストの逃がし方、外し方）。README・AGENTS のレシピの一覧                                               | `check:doc-links`                                                        |
| T6   | （別の Issue）grid: タップで編集を始める・盤の確定でセルを確定する                                                                                                                                                                       | grid の設計で決める                                                      |
| T7   | （§18 の 2 を採るとき）`/ui-demo` のカード、scaffold の外す処理、e2e、基準画像                                                                                                                                                            | `template-acceptance` の dry-run、`visual-baselines.yml`                 |

T1 を小さく保つため、`NumberKeypad` は表示とキーの入力だけにし、入力欄との結びつけは T2 に置く。

### 15.1 T2 で決めた形

- **ファイル**: `src/TouchKeysHost.svelte`（ホスト。開いている回の状態は中の `$state`）、`src/attach.ts`（`touchKeys` と要素を鍵にした
  `WeakMap`）、`src/target.ts`（どの入力欄にどの規則で出すか・`inputmode` の出し入れ・確かめつきの書き込み）、`src/types.ts`。
  `.svelte.ts` は持たない（§17）。
- **公開する名前**: `TouchKeysHost`・`touchKeys`、型 `TouchKeysOptions`（T2 は `NumberKeysOptions` だけ。T3 で `TextKeysOptions` との
  合併にする）・`CommonKeysOptions`・`TouchKeysPlacement`・`TouchKeysCancelReason`・`TouchKeysEditKey`・`TouchKeysConfirmDetail`・
  `TouchKeysCancelDetail`。`NumberKeysOptions` は `NumberSpec`（`min`・`max`・`step`・`decimals`・`allowNegative`・`required`）を継ぐ。
- **ホストの prop**: `enabled`（必須）・`placement`（T2 は `{ number }` だけ）・`resolve`・`messages`・`onopen`・`onconfirm`・`oncancel`・
  `note`。`layouts` は T3。`note` は `NumberKeypad` の `note`（範囲の行の下）に出る。
- **T2 の対象はテンキーの入力欄だけ**。文字の入力欄・パスワードには何もしない（`inputmode` も触らない）。T3 で足す。
- **外す印は包みにも付けられる**: `data-touch-keys="off"` は、入力欄そのものか、その祖先のどれかにあれば効く（§6.4 の日付の包み）。
  off の祖先そのものを探すので、間に別の印（`data-touch-keys="on"` など）があっても外れる。
  `readonly`・`disabled`・この印は、`touchKeys(...)`・`resolve` の指定より先に見る。
- **`inputmode="none"`**: 対象の入力欄（とその `<label>`）の `pointerdown` の捕捉の段と、開くときに付ける。元の値を覚え、
  推定（§5.4）は元の値で行う。`enabled` が false になったとき・ホストの破棄で戻す（アプリがその間に書き換えた欄は触らない）。
  ホストが有効なまま欄が対象外になった（`touchKeys(false)`・`resolve` が `false`・外す印・`readonly` など）ときは、その欄の次の
  `pointerdown` の捕捉の段で、ホストが付けた `none` のときだけ元に戻す（戻さないと、OS のキーボードも出ない欄になる）。
- **確定の直前に、規則も最新で確かめる**: 開いた後に規則が変わることがある（attachment の `max` が下がる、`required` が付く）。
  §6.5 の照合に続けて、確定する値を**そのときに解決した規則**で判定し直し、確定できない値なら書かずに `target-changed` で取り消す
  （範囲・符号・刻み・`required` に加えて、小数の桁数も見る。桁数は、開いたときの値をそのまま確定するときだけ見ない）
  （盤の表示は開いたときの規則のまま。規則が変わっただけでは閉じない）。
- **押し続けた Enter**: 盤を閉じた Enter（未確定の変更があって止めたものも、変更が無くて通したものも）に続く自動リピートは、
  `keyup` まで捕捉の段で止める。変更が無いときに通るのは最初の 1 回だけ（押し続けで何度も送信されない）。
- **閉じる合図**: `focusout`（対象から）・`submit`（対象のフォーム）・`MutationObserver`（対象が外れた・`readonly`・`disabled`・`type`・
  祖先の `inert`・`data-layer-inactive` = 閉じる途中の `Modal` / `Drawer`）は `target-gone`。`reset` は、値が戻った後（次のタスク）に
  照合して、違えば `target-changed`。attachment の付け直しは、その直後（マイクロタスク）に照合する。
- **確定は、値が同じでも書いて `input`・`change` を出す**（開いて、そのまま確定を押したとき。利用者が「この値でよい」と押した）。
- **受け面を押した位置の下が、いまの対象の入力欄そのもの**のときは、取り消しで閉じるだけ（開き直さない）。
- **下の固定**: 受け面は透明、盤は下の端の幅いっぱいの帯の中央。`<html>` の `--banto-touch-keys-inset-bottom` は帯の高さ（px）。
- **`enabled` を同じ値で渡し直しても閉じない**（値が変わったときだけ聞き手を付け外しする）。ホストの破棄は `disabled` で取り消す。
- **ブラウザーの fixture**: §14.3。`pointerdown`・`mousedown` の `preventDefault` を外すと「外のタップ」の 4 件が落ちることを確かめた
  （試験が約束を実際に見ている）。

### 15.2 T3 で決めた形

- **ファイル**: `src/TextKeyboard.svelte`（盤）、`src/core/text.ts`（配列の表・1 打の遷移・最大文字数・確定できるかの純粋な関数）。
  `src/target.ts` の `resolveNumberTarget` は `resolveTarget` になり、テンキーの対象と文字の対象の合併（`kind`）を返す。
  `.svelte.ts` は持たないまま。
- **公開する名前**: `TextKeyboard`、型 `TextKeysOptions`（`TouchKeysOptions` は `NumberKeysOptions | TextKeysOptions`）・`TextLayout`、
  純粋な関数 `resolveTextRules`・`resolveTextLayouts`・`textKeyRows`・`reachableChars`・`pressTextKey`・`classifyText`・`TEXT_LAYOUTS`。
  **`TextLayout` は T3 では `'alnum' | 'symbol'`**（`'kana'` は T4 で足す。知らない名前は捨て、空になれば全部に戻す）。
- **ホストの prop**: `placement` に `text`（既定 `'bottom'`）、`layouts`（文字キーボードの配列の既定。入力欄ごとの `layouts` が勝つ）を足した。
- **文字の経路はテンキーと同じ規則**: 開くのは `click`、`inputmode="none"`、外のタップ、実キー・Enter・リピート、`focusout`・`submit`・`reset`・
  `MutationObserver`、確定の直前の照合（値・`editKey`）と**その時点の規則での再検証**（`maxLength`・`required`。開いた後に種類が変わった
  ——テンキー ↔ 文字、パスワード ↔ 文字——ときも `target-changed`）、書いた後の確かめ（`type="email"`・`"url"` は前後の空白を削るので、
  書いた値がそのまま残らなければ戻して、イベントを出さない）。テンキーの欄と文字の欄は、外のタップ 1 回で盤ごと替わる。
- **推定と指定**: `type="text"` などは文字キーボード（§5.4）。`touchKeys({ kind: 'text' })`・`resolve` で、`inputmode="numeric"` の欄を
  文字キーボードにもできる。**`type="number"` に `kind: 'text'` は出さない**（ブラウザーが数でない文字列を空にするため。欄は素のまま）。
- **最大文字数**: 指定の `maxLength` と `maxlength` 属性の**小さいほう**（指定で狭められるが、属性より緩められない。`type="number"` の
  数値の属性と同じ考え方。§9.3 の「指定 → 属性」の順をこの形に決めた）。開いたときの値が上限を超えているときは、文字は入らず、
  上限に収まるまで確定できない。`required`（属性か指定）で空の下書きは確定できない。知らせは `role="status"` の行（`maxLength` の文言）。
- **文言**: `textKeyboard`・`alnum`・`symbol`・`upper`・`lower`・`space`・`length(length, max)`・`maxLength(max)` を足した。
  大文字・小文字のキーは、押すと切り替わる先の名前を見せる。配列のキーは `aria-pressed` でいまの配列を示す。
- **配列**: 英数は数字の段 + QWERTY の 3 段。記号は 17 個（§9.1）、パスワードでは ASCII の印字できる記号の 32 個。空白・1 文字消す・
  全部消すは、どの配列でも同じ位置。行は最大 10 列で、幅が足りなければキーが縮む（盤の幅は 10 列ぶんを CSS で明示する）。
- **パスワード**（§5.5）:
  - `type="password"` の欄は、**指定の種類が何であっても伏せた文字キーボード**になる（`kind: 'number'` を付けても、テンキーにはしない。
    テンキーは下書きをそのまま見せ、`onconfirm` に値を渡すため）。出さないのは `touchKeys(false)`・`resolve` の `false`・外す印だけ。
    配列は常に英数 + 記号（全部）。`maxlength`・`required`・`label`・`placement`・`editKey`・`initialLayout` は効く。
  - **下書きは盤（`TextKeyboard`）の中だけにある**。`masked` のとき、盤は `draft`（`$bindable`）を読みも書きもせず、空から始め、
    外へは `onlength`（文字数だけ）と、確定の 1 回の `onconfirm` で渡す。ホストが持つのは文字数だけ（Enter の「未確定の変更」は
    文字数 > 0）。盤は開いた回ごとに作り直す（`{#key}`）ので、閉じ方がどれでも、次の盤に前の下書きは無い。
    `masked` は盤を作ったときに 1 度だけ読む（後から外しても、下書きは見えない）。
  - 表示は `●` を文字数ぶんと、文字数の行（`6 文字`、上限があれば `6 / 20`）。`note` の `draft` は `null`、`onconfirm` の
    `value`・`previous` は `null`。記録（`console`）には何も出さない。
  - 空の下書きも確定できる（見えているとおり、空を書く。`required` があれば確定できない）。
  - 受け入れの試験: 盤の `outerHTML`（表示・属性を含む）に打った文字列が無い／口（`onopen`・`onconfirm`・`oncancel`・`resolve`・`note`）の
    引数に平文が無い／`console` に出ない／取り消し・別の欄への切り替え・`enabled` を false・ホストの破棄の後、次の盤が空／
    `type` を変えると閉じる（部品）。95 文字を盤で打って値が一致する・`onconfirm` が `null`・ページのどこにも下書きが無い（ブラウザー）。
- **試験の置き場**: 単体 `tests/text.test.ts`、部品 `tests/TextKeyboard.test.ts`・`tests/TouchKeysHostText.test.ts`、
  ブラウザー `tests/browser/text.e2e.ts`（fixture の画面にメモ・コード・パスワードの欄を足した）。

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
- **層の約束が DOM の印だけで繋がる**: パッケージの間で import できない。
  `@banto/ui` の `LAYER_SELECTOR` や `isInOpenPopover` が変わると黙って壊れる。T2 で `@banto/ui` の `layering.test.ts` に
  「開いた popover の中の `data-esc-layer` は、`aria-modal` の層より手前」を 1 件足して、約束を `@banto/ui` の側で固定し、ブラウザーの fixture（§14.3）で本物の `Modal` と組んで確かめる。
- **合成した `input` イベントを受けない入力欄**: `isTrusted` を見るアプリのコードがあると値が入らない。banto の forms・grid は見ていない（確かめた）。
  レシピに書く。
- **外部利用 fixture**: `.svelte.ts` を持つパッケージは、rule `external-consumer-fixture` が fixture の dependencies・import・exclude を求める。
  fixture の ref は直近のタグ（いま `v8.0.0`）で、新しいパッケージはそのタグに無い。**T1 では `.svelte.ts` を持たない形**
  （共有の状態は素の `.ts` の登録と、`TouchKeysHost.svelte` の中の `$state`）にして rule に当たらないようにするか、
  image-assets を足したときの手順（ADR-0020 §6）に合わせるかを、T1 の最初に決める。
- **`type="number"` へ書く値**: ブラウザは正規の数の文字列しか受けず、外れると黙って空にする。書く前の検査と、書いた後の確かめ（違えば戻してイベントを出さない）の 2 段で守る（§8.3）。
- **盤の刻みの判定とブラウザの判定の食い違い**: 基点の決め方（`min` → `value` 属性 → 0）や小数の計算がブラウザと違うと、盤は確定できると言い、ブラウザは `stepMismatch` を立てる。ブラウザを正にして戻す（§8.3）うえで、ブラウザーの fixture で突き合わせる。
- **`editKey` を渡し忘れる**: ノードを使い回す画面で、値がたまたま同じ別のレコードに切り替わると、値の照合だけでは見つからない（§6.5）。型では強いられないので、レシピの見本を `editKey` つきにする。
- **外のタップの受け面が、下の画面の操作を 1 回ぶん奪う**: 盤が開いている間、下のボタンは 2 回のタップが要る（1 回目は盤を閉じる）。意図した動き（§7.2.1）だが、利用者には「効かなかった」と見えうる。ポップアップは暗幕で伝わる。下の固定は暗くしないので、実機で確かめて、分かりにくければ下の固定でも薄い暗幕を掛ける。
- **パスワードの平文が漏れる口の取りこぼし**: 口を足すたびに「パスワードでは渡さない」を確かめる必要がある。§14.2 の「盤の `textContent` に打った文字が現れない」「口の引数が `null`」を、口を足す PR の受け入れにする。
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
| 5 | 盤の外をタップしたとき（§6.2・§7.2.1） | **取り消し。そのタップは下の画面に届かせない**（書くのは「確定」を押したときだけ。同じ操作で下の保存や閉じるが押されない。別の対象の入力欄へ移るときだけ 1 回で替わる）。別案: 確定として書く／何もしない（閉じるには取り消しを押す） |
| 6 | パスワードの入力欄（§5.5） | **T3 で対象にする**（下書きは全部伏せ字、英数と ASCII の記号の全部、汎用の口には平文を渡さない、閉じるたびに下書きを消す）。タッチだけの端末でログインできないと、認証無効モード以外で使えないため。別案: 対象にしない |
| 7   | grid のセルの編集（§6.4）                                      | **この Issue から外し、別の Issue を立てる**（タップで編集を始める・盤の確定でセルを確定する）。この設計の盤は、編集に入った後の入力欄にはそのまま出る                                                         |
| 8   | 日付・時刻の文字の欄（§6.4）                                   | **既定では対象のまま**にし、レシピでアプリの包みに `data-touch-keys="off"` を付ける形を示す（`@banto/ui` は変えない）。別案: `@banto/ui` の部品が自分で `data-touch-keys="off"` を出す（コアが印の名前を知る） |
| 9   | `NumberKeypad` / `TextKeyboard` を単体でも公開するか（§5.3）   | **公開する**（入力欄と結びつけずにページへ置く専用の入力画面のため）。別案: ホストだけ公開し、要望が出てから                                                                                                   |
| 10  | キーの大きさの変数（§10）                                      | **部品の CSS 変数 `--banto-touch-key-size`（既定 48px）にし、theme には足さない**。密度に繋げたくなったら、theme の touch の区画に 1 行足す                                                                    |
| 11  | 有効・無効の決め方（§12）                                      | **明示の `enabled`（必須）だけ**。自動判定は持たない。レシピで端末ごとの設定（`localStorage`）を示す。`coarsePointer` の補助は出さない（要望が出てから）                                                       |
| 12  | 既定の出し方（§5.1）                                           | **テンキーはポップアップ、文字キーボードは下の固定**。どちらも prop と入力欄ごとの指定で変えられる                                                                                                             |
| 13  | ADR を書くか                                                   | **T1 で書く**（新しいオプションのパッケージと、`@banto/ui` に足さない理由。ADR-0020 と同じ扱い）                                                                                                               |
| 14 | ブラウザーの fixture（§14.3） | **T2 で足す**（パッケージの中の最小の画面 + Playwright。テンプレートには配線しない）。外のタップ・層・フォーカス・ブラウザの数値の検証は jsdom では確かめられないため。代償は CI のジョブが 1 つ増えること。別案: 足さず、実機と下流のアプリの確認に任せる |
| 15 | 刻み（`step`）に合わない値（§8.2） | **確定できなくし、近い 2 つの値を知らせる**（丸めて書かない）。`type="number"` では属性の制約を指定で緩められない。別案: 近い値に丸めて書く |
| 16 | 開いたときと違う対象・値になっていたとき（§6.5） | **書かずに取り消し、`oncancel` に理由を渡す**（知らせはアプリ）。`editKey` は任意（ノードを使い回す画面では渡す、とレシピに書く）。別案: `editKey` を必須にする（素の入力欄でも毎回書くことになる） |
| 17 | 盤が開いているときの実キーボードの Enter（§6.3） | **未確定の変更があるときは、盤を閉じるだけ（書かない・送信しない）。もう 1 度の Enter か保存で通常の送信**。変更が無いとき・盤が閉じているとき・スキャナの文字が先に盤を閉じたときは、そのまま通す。別案: いつも通す（盤に見えている値で送れたように見えて、開く前の値が送られる）／Enter を確定に読み替える（1 回で書いて送るまで進む） |

未確定のまま残る点（実装で確かめる）: パッケージと公開の名前、`.svelte.ts` を持つか（§17）、`inputmode="none"` を付ける時機と実機での効き、
ポップアップの位置（中央か、対象の入力欄の近くか。`@banto/ui` の `anchoredPopover.ts` は公開されていないので、近くに出すなら自前の配置が要る）、
記号の中身（パスワード以外）、ブラウザーの fixture の置き場と CI のジョブ（§14.3）、`change` を出すか（forms・grid は `input` だけで足りる。アプリの `onchange` のために出す見込み）、
`note` のスニペットが要るか、狭い画面でのカナの配列。
