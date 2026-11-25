# レシピ: タッチパネル端末の画面内キー（`@banto/touch-keys-svelte`）

作成日: 2026-11-25（#937 T5。トラックB＝アプリ作者向け）

タッチパネルの端末（キーボードの無い現場の端末）で、入力欄のタップに **画面内のテンキー・文字キーボード** を出す。
確定で入力欄の `value` に書き、`input`・`change` を出すので、`bind:value` も `oninput` も `BantoForm` の検証もそのまま動く（`DraftNumberField` は盤の確定で確定・検証する。grid のセルはホストに 2 つ書く。どちらも 4 節）。
OS のタッチキーボードは出さない（`inputmode="none"`）。パッケージ単体の API は
[packages/touch-keys-svelte/README.md](../../packages/touch-keys-svelte/README.md)、設計と判断は
[設計書](../design/touch-keypad-design.md)・[ADR-0036](../adr/0036-touch-keys-package.md)。

> **テンプレートの配線は `/ui-demo` の見本のカード 1 枚だけ**（#937 T7）。テンキー・英数・カナ・パスワードの欄を、マウスでも
> タッチでも触って確かめられる（`apps/admin-template/src/routes/(app)/ui-demo/+page.svelte` の `[scaffold:touch-keys]` の領域。
> `pnpm scaffold --preset minimal|standard|display` は外す）。**ルートのレイアウトにホストは置いていない**ので、
> アプリ全体で使うには下の手順を**自分のアプリで**行う。見本のホストはカードの中にあり、`resolve` でカードの中の欄だけを対象にしている。
> **ルートにホストを置くときは、見本のカードの `<TouchKeysHost>` を外す**（`[scaffold:touch-keys]` の markup の領域のホスト。束 `touchKeysMessages.ts` は残す）。
> ホストが 2 つあると、見本の欄を押したときに盤が 2 つ開く。
> **タッチの実機・WebView2 での確かめは未実施**（設計書 §14.4）。出す前に、自分の端末で OS のキーボードが同時に出ないか・
> キーの大きさを必ず確かめる。

## 1. 依存を足す

利用するアプリの `package.json`（テンプレートから作ったアプリで `full` のままなら、もう入っている。モノレポ内なら `workspace:*`、本リポジトリ外からは
[../publishing.md](../publishing.md) の git 依存と `path:` 指定）:

```jsonc
{ "dependencies": { "@banto/touch-keys-svelte": "workspace:*" } }
```

`.svelte.ts` を持たないので、`vite.config` の `optimizeDeps.exclude` への追加は要らない。
盤の色・枠・角は `--banto-*`（`@banto/theme` のトークン）を読むので、テンプレート外のアプリでは `@banto/theme` の CSS を
アプリ側で読み込んでおく（読まなくても動くのは、キーの大きさだけ）。

## 2. ルートに置く（`TouchKeysHost`・`touchKeys`）

`TouchKeysHost` は**アプリのルートのレイアウトに 1 つ**（`ToastHost`・`ConfirmHost` と同じ置き方）。`enabled`（必須）が
true の間だけ、数値の欄（`type="number"`・`inputmode="numeric" | "decimal"`）のタップでテンキーを、文字の欄
（`type="text"` など）とパスワードの欄のタップで文字キーボードを開く。`enabled` が false の間は何も聞かず、何も書き換えない。

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import { TouchKeysHost } from '@banto/touch-keys-svelte';
	import { deviceSettings } from '#lib/deviceSettings.svelte'; // 3 節
	import { touchKeysMessages } from '#lib/banto/touchKeysMessages.js'; // 6 節

	let { children } = $props();
</script>

{@render children()}
<!-- ToastHost・ConfirmHost などが既にあるなら、その並びに足す -->
<TouchKeysHost
	enabled={deviceSettings.touchKeys}
	messages={touchKeysMessages()}
	placement={{ number: 'popup', text: 'bottom' }}
/>
```

- **ホストは 1 つだけ。** テンプレートの `/ui-demo` の見本を残しているアプリ（`full`）は、ルートに置くのと同時に、見本のカードの
  `<TouchKeysHost ... />`（`routes/(app)/ui-demo/+page.svelte` の `[scaffold:touch-keys]` の markup の領域）と、それだけが使う
  `touchKeysOn`・`touchKeysCard`・`touchKeysResolve`・`touchKeysConfirm`・スイッチを消す（見本の grid を残すなら、grid のセルの
  `resolve`・`onconfirm`（4 節）はルートのホストに書く）。束 `src/lib/banto/touchKeysMessages.ts` と `touchKeys.*` のキーは
  ルートのホストが使うので残す。2 つあると、どちらも document で押下を聞くので、見本の欄で盤が 2 つ開き、片方を閉じてももう片方が残る。
- 既定の出し方は、テンキーが中央のポップアップ（`popup`）、文字キーボードが下の固定（`bottom`）。`placement` で変える。
- 入力欄ごとの指定は attachment `touchKeys(...)`（入力欄が自分のアプリのものなら、これが一番素直）:

```svelte
<script lang="ts">
	import { touchKeys } from '@banto/touch-keys-svelte';
</script>

<!-- テンキー: 範囲・刻み・小数の桁。type="number" の min / max / step 属性があれば、それも読む -->
<input
	type="number"
	{@attach touchKeys({ kind: 'number', min: 0, max: 999, editKey: row.id })}
	bind:value={row.qty}
/>

<!-- 文字: 最大文字数（maxlength 属性との小さいほう）・配列 -->
<input
	type="text"
	{@attach touchKeys({ kind: 'text', maxLength: 20, layouts: ['alnum'] })}
	bind:value={row.lot}
/>

<!-- この欄だけ素のまま -->
<input type="text" {@attach touchKeys(false)} bind:value={row.memo} />
```

- **`editKey`**: 同じ `<input>` を別のレコードに使い回す画面（一覧の行編集など）では必ず渡す。開いたときと確定のときで違えば、
  何も書かずに `target-changed` で閉じる。値がたまたま同じ別のレコードに切り替わっても、これで検出できる（型では強いられない）。
- **カナは自分から書いた欄だけ**（opt-in）: `layouts` に `'kana'` を書いた欄・ホストだけにカナの配列が出る
  （`layouts: ['kana', 'alnum']`。先頭が最初に出る）。`layouts` を指定しない既定は `alnum` + `symbol`。
  五十音 + ー の 5 行 × 10 列で、濁点・半濁点・小書きのキーは直前の 1 文字を置き換える（`カ` → `ガ`、`ツ` → `ッ`）。
  **パスワードの盤には入らない**（`layouts` が何でも、英数 + 記号のまま）。
- **パスワード**（`type="password"`）は必ず伏せた文字キーボード。表示は `●` と文字数だけで、未確定の下書きは盤の外へ出ない（確定した値は入力欄へ書く）
  （`onconfirm` の `value`・`previous` と `note` の `draft` は `null`）。開いて何も打たずに確定しても既存の値は消えない
  （空にするのは「全部消す」の直後だけ）。「パスワードを表示」で `type="text"` になる欄は、属性からはパスワードと分からないので
  `touchKeys({ kind: 'text', masked: true })`（または `resolve`）で明示する。`@banto/forms` の `PasswordInput`（目玉のボタン付き）も同じで、**表示に切り替えた間は `type="text"` なので平文の盤になる**（利用者が見せると選んだ欄。表示中でも伏せたい欄は `masked: true` を付ける。盤は欄にフォーカスしたときに判定するので、盤を開いたまま切り替えても開いている盤の種類は変わらない）。打てるのは ASCII の印字できる 95 文字だけ。
- **外す印**: 入力欄、またはその祖先に `data-touch-keys="off"`（日付・時刻の入力欄の包みなど、カレンダーのボタンが別にある欄に付ける）。
  `readonly`・`disabled`・この印は、`touchKeys(...)`・`resolve` より先に見る。
- **挙動の約束**: 盤の外のタップは取り消しで、下の画面には届かない（下のボタンは 2 回のタップが要る）。実キーボード・スキャナの
  入力が入れば盤は閉じる。盤はフォーカスを取らず、Tab では辿れない。`Modal` の中から開いても、Esc 1 回で盤だけが閉じる。
- **合成した `input` を受け付けないコードに注意**: 値は合成した `input`・`change` で書く。アプリ自前の欄で `isTrusted` を見ていると
  値が入らない（`@banto/forms`・`@banto/grid-svelte` は見ていない）。

## 3. 端末ごとの設定（`enabled`）

パッケージは「タッチ端末か」を判定しない。`(pointer: coarse)` はマウスを挿したパネル PC で偽になり、`(any-pointer: coarse)` は
タッチ画面つきのノート PC で真になるなど、**持ち物からキーボードの有無は分からない**ため。アプリが**端末ごとの設定**を持ち、
その値を `enabled` に渡す。置き場は `localStorage`（`banto.kiosk`・`banto.density` のキャッシュと同じ側）で、
**provider（利用者ごとに保存される設定）には保存しない**。provider に入れると、パネル PC で有効にした利用者が遠隔のブラウザでも
盤を出してしまう。遠隔のブラウザは通常の入力欄のままにするのが前提。

```ts
// src/lib/deviceSettings.svelte.ts（見本。キー名は自分のアプリで決める）
const KEY = 'myapp.touchKeys';

function load(): boolean {
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		return false; // プライベートブラウジングなどで読めなくても、素の入力欄に倒す
	}
}

class DeviceSettings {
	touchKeys = $state(load());
	setTouchKeys(on: boolean) {
		this.touchKeys = on;
		try {
			localStorage.setItem(KEY, on ? '1' : '0');
		} catch {
			/* 保存できなくても、この画面の間は効く */
		}
	}
}
export const deviceSettings = new DeviceSettings();
```

設定画面に「画面内キーを使う（この端末のみ）」のスイッチを置き、`deviceSettings.setTouchKeys` を呼ぶ。
キオスクの端末は、起動のフラグ（環境変数など）から初期値を決めてもよい。`enabled` を同じ値で渡し直しても盤は閉じない。

OS のタッチキーボードが同時に出る環境があれば（`inputmode="none"` が効かない場合）、キオスクの設定で OS のキーボードの
自動表示を切る（設計書 §17）。

## 4. `BantoForm` と `resolve`

`BantoForm`・`@banto/forms` の入力欄は変えない。アプリが作っていない欄なので `touchKeys(...)` は付けられず、
属性からの推定（設計書 §5.4）と、ホストの `resolve` で指定する。

- `NumberField`（`type="number"`、`min` / `max` が属性にある）は推定だけで、範囲つきのテンキーになる。
- `TextField` は文字キーボードになる。
- **`DraftNumberField`**（`type="text"` + `inputmode="decimal"`）はテンキーになるが、`min` / `max` が DOM に無いので、
  **`resolve` で範囲を渡す**（書き忘れると範囲なしのテンキーになる）。`input.id` はフィールド名（`DraftNumberField` は `id` を省くと `def.name`）。
  **盤の確定で、値の確定と検証まで走る**（#964 F1）: `DraftNumberField` は blur・Enter に加えて `change` でも `draft.commit()` を呼び、
  盤の確定は `input` → `change` を出す。フォーカスは入力欄に残るが、確定値（`draft` の値）とエラーの表示は盤を閉じた時点で揃う
  （その後の blur は、文字が変わっていなければ確定し直さない。`onCommit` も 1 回）。配線は要らない。
  **実キーボードで打っている途中の保存は別**: 打った文字は blur・Enter まで確定しない（`DraftNumberField` は submit を見ず、標準の `BantoForm` の送信は
  `FormStore.validateAll()` で `FormDraft` を確定しない）。フォーカスが残ったまま送れる画面では、保存ハンドラーで `draft.commitAll()` が成功してから確定値を読む。
- **ほかの欄**: `TextField`・`NumberField`・`PasswordField` は `input` のたびに `FormStore` へ値が入るので、盤の確定で値が入る
  （エラーの表示は、実キーボードで打ったときと同じく blur の後）。`DraftDateField` と日付・時刻の欄は盤の対象にしない
  （下の `data-touch-keys="off"`。注入した日付の入力欄に盤で書いても、確定は blur・Enter を待つ）。

```svelte
<TouchKeysHost
	enabled={deviceSettings.touchKeys}
	messages={touchKeysMessages()}
	resolve={(input) => {
		switch (input.id) {
			case 'weight':
				return { kind: 'number', min: 0, max: 99.9, decimals: 1 };
			case 'staffCode':
				return { kind: 'text', maxLength: 8, layouts: ['alnum'] };
			case 'memoKana':
				return { kind: 'text', layouts: ['kana', 'alnum'] };
			case 'search':
				return false; // この欄には出さない
			default:
				return undefined; // 属性からの推定に任せる
		}
	}}
/>
```

`resolve` は `TouchKeysOptions | false | undefined` を返す。`false` は出さない、`undefined` は推定に任せる。
種類は推定のままオプションだけ足すなら、`kind` なしで返す（例: `{ openOnFocus: true }`）。

**`openOnFocus`**: ボタンやセルをタップすると入力欄が現れてフォーカスを受ける画面向けのオプション。付けた欄では、**ポインター由来の
`click` の続き（同じタスク）でフォーカスが入ると**、盤が OS のキーボードを抑えて開く（1 回のタップで済む）。付けない欄、
キーボード由来の `click`（Enter / Space）、自動フォーカス、あとからのフォーカスでは原則開かない（ポインター click 直後の短い判定窓での近似。キー・次の pointerdown で失効する。厳密なタスク境界ではない）。OS のキーボードの抑えは
フォーカスの後になるので、端末によっては一瞬出うる（実機で確かめる）。
入力欄が自分のものなら `touchKeys(...)` のほうが近くに書けて素直。日付・時刻の入力欄は文字の欄なので、何もしなければ
文字キーボードの対象になる。アプリの包み（`FormDateInput.svelte` など）に `data-touch-keys="off"` を付ける。

### grid のセル（`@banto/grid-svelte`）

grid と盤は互いを知らない。**繋ぐのはホストの 2 つの props だけ**（#964。grid はセルのエディタに印 `data-grid-editor` を付ける。
組み込みのエディタは `<input>` 自身、注入したエディタはその包み）:

```svelte
<script lang="ts">
	const isGridEditor = (input: HTMLInputElement) => input.closest('[data-grid-editor]') !== null;
</script>

<TouchKeysHost
	enabled={deviceSettings.touchKeys}
	messages={touchKeysMessages()}
	resolve={(input) => (isGridEditor(input) ? { openOnFocus: true } : undefined)}
	onconfirm={({ input }) => {
		if (isGridEditor(input)) input.blur();
	}}
/>
```

`resolve` を欄ごとに書き分けているなら、その `default` の枝を `isGridEditor(input) ? { openOnFocus: true } : undefined` にする。
ホスト 1 つで、アプリの中の全部の grid に効く（grid ごとの配線は無い）。テンプレートの見本は `/ui-demo` の TouchKeysHost のカード。

- **1 回のタップで編集と盤が始まる。** タッチ・ペンは、編集できるセルのタップで編集が始まり（grid の `editOnTap`、既定 `true`）、
  その続きでエディタがフォーカスを受けるので、`openOnFocus` で盤が開く。マウスのダブルクリックで始めた編集でも開く。
  キーボード（Enter / F2）で始めた編集では開かない。`openOnFocus` を書かないと 2 回のタップになる（1 回目で編集、2 回目で盤）。
- **盤の確定でセルが確定する。** `onconfirm` の `blur()` が grid の「blur で確定」の経路に入る。**次のセルへは動かない**
  （編集したセルがアクティブのまま、フォーカスは grid に戻る。矢印キーはそこから続く）。blur するのは grid のエディタだけにする
  （全部の欄で blur すると、フォーカスが外れると閉じるポップアップの中の欄で、盤の確定がポップアップを閉じる）。
- **確定に失敗したとき**（列の `validate`・`onCellEdit` の拒否）は、セルの編集は開いたまま、下書きとエラーが残り、フォーカスは
  エディタに戻る。エディタをタップすれば、盤がいまの下書きで開く。保存を待つ間に利用者が別の場所を操作したら、保存が終わっても
  フォーカスは取り返さない。
- **盤の取り消し（取り消しのキー・外のタップ）は盤だけを閉じる。** セルの編集は開いたまま、下書きは盤を開く前のまま。
  **実キーボードの Esc は 1 回で両方を閉じる**（セルの編集を取り消し、盤は対象が消えて閉じる。値は変わらない）。
- **数値の列はテンキー、文字の列は文字キーボード**（推定のまま）。grid の数値のエディタは `min` / `max` を DOM に出さないので、
  **盤に範囲は付かない**。範囲は列の `validate` が確定のときに見る（盤で範囲も見せたいなら、`resolve` で
  `{ kind: 'number', min, max, openOnFocus: true }` を返す。どの列かは `input.closest('[data-cell-field]')` などアプリの印で引く）。
- **日付・時刻の列**は、注入したエディタの包みに `data-touch-keys="off"`（上と同じ）。`<select>`・checkbox は盤の対象でない。
- 盤が開いている間は、別のセルのタップは届かない（1 回目は盤を閉じるだけ。「挙動の約束」の外のタップ）。

## 5. キーの大きさ

キーの 1 辺は CSS 変数 `--banto-touch-key-size`（既定 `48px`）、間隔は `--banto-touch-key-gap`。`:root` で上書きする。

```css
:root {
	--banto-touch-key-size: 56px; /* 手袋の現場などで大きくする */
}
```

- **12 mm は保証できない**: CSS の `mm` は 96dpi 基準の換算で、画面の上の実寸ではない。パネルの画素の細かさと OS の拡大率で変わる。
  端末ごとに変数を合わせる（実機で定規を当てる）。
- **狭い画面ではキーが縮む**: 盤は 10 列で、幅が足りなければキーが `使える幅 ÷ 列` に縮む。**幅 400px では、キーは約 30px**
  （盤の内側の余白 2 × 12px・枠・間隔 9 × 8px を引いた残りを 10 で割った値）。360px ではさらに小さい。指で押すには小さいので、
  狭い端末・小さなウィンドウでは、文字キーボードを `bottom` にして幅いっぱいを使い、`--banto-touch-key-gap` を詰めるか、
  配列を 1〜2 種に絞る。カナの配列も同じ 10 列。5 行なので、下の固定でも高さが足りるか実機で確かめる。
- ブラウザーの試験は 360px と 320px で、盤が画面からはみ出さないことまでを確かめている（キーの押しやすさは実機で）。

## 6. Paraglide の束

パッケージは辞書も Paraglide も持たない。文言は**関数の束**（`TouchKeysMessages`。既定は日本語）で、アプリが Paraglide のキーから
作って `messages` に渡す（conventions §13 のレイヤ①・②。`apps/admin-template/src/lib/banto/i18n.ts` の `gridMessages()` などと同じ形）。
キーの字（`0`〜`9`・英字・カナ・記号）は文言ではないので束に入れない。

**テンプレートには、全部の項目を写した束がもうある**: `apps/admin-template/src/lib/banto/touchKeysMessages.ts` の
`touchKeysMessages()` と、`messages/{ja,en}.json` の `touchKeys.*` のキー（`/ui-demo` の見本が使う。scaffold で見本を
外したアプリでは、このファイルとキーも消えているので、下の形で足し直す）。抜粋:

```ts
// src/lib/banto/touchKeysMessages.ts（抜粋。キーの名前は実物と同じ）
import type { TouchKeysMessages } from '@banto/touch-keys-svelte';
import * as m from '#lib/paraglide/messages.js';

export function touchKeysMessages(): Required<TouchKeysMessages> {
	return {
		numberKeypad: () => m['touchKeys.numberKeypad'](),
		textKeyboard: () => m['touchKeys.textKeyboard'](),
		confirm: () => m['touchKeys.confirm'](),
		cancel: () => m['touchKeys.cancel'](),
		backspace: () => m['touchKeys.backspace'](),
		clearAll: () => m['touchKeys.clearAll'](),
		sign: () => m['touchKeys.sign'](),
		// 片方だけの範囲は文が変わるので、キーを分ける（`{min} 〜 {max}`・`{min} 以上`・`{max} 以下`）
		range: (min, max) =>
			min !== null && max !== null
				? m['touchKeys.range.both']({ min, max })
				: min !== null
					? m['touchKeys.range.min']({ min })
					: max !== null
						? m['touchKeys.range.max']({ max })
						: '',
		length: (length, max) =>
			max !== null
				? m['touchKeys.length.max']({ length, max })
				: m['touchKeys.length.count']({ length })
		// 続き: step（`touchKeys.step.both`・`.one`・`.none`）・required・alnum・symbol・kana・dakuten・
		// handakuten・small・upper・lower・space・maxLength・minLength・lengthConflict・invalid
		// （キーは `touchKeys.<項目>`）。
	};
}
```

- 全部の項目は `TouchKeysMessages`（`packages/touch-keys-svelte/src/messages.ts`）。**英語などに切り替えるアプリは、
  使う盤に出る項目を漏らさず書く**（書かなかった項目は日本語の既定が出る。テンプレートの束は戻り値を
  `Required<TouchKeysMessages>` にして、項目が増えたときに型で気付けるようにしている）。
- Paraglide のメッセージは呼び出しのたびに解決する閉包にする（`() => m[...]()`）。ロケールの切り替えに追従する。
- `messages/*.json` に足したら、`pnpm --filter <app> paraglide:compile` を走らせる。

## 7. トーストの逃がし方

下の固定の文字キーボードは、`LauncherBar`（z 200）・トースト（z 1000、右下）より**手前**に出て、開いている間はその下を隠す。
トーストが盤に隠れないよう、ホストは開いている間 `<html>` に盤の高さ（px）を `--banto-touch-keys-inset-bottom` として出す
（閉じたら外す）。`ToastHost` は `--banto-toast-bottom`（既定 `var(--banto-space-4)`）を読むので、これに足す。

ランチャー使用中は `packages/theme/src/css/banto.css` が、`:root` より詳細度の高い
`:root[data-banto-shell-nav='launcher']`（位置の属性つきと、900px 以下の `@media` 内を含む）で同じ変数を宣言する。
`:root` だけの上書きは負けるので、**それらのセレクターも上書きする**。盤の高さの変数は閉じていれば未設定（`0px`）なので、
盤の開閉を表す属性やクラスは要らず、閉じているときはランチャーの余白（`--banto-shell-launcher-reserve`・
`--banto-shell-launcher-tabbar-reserve`）がそのまま残る（touch-keys-svelte は開閉の属性やクラスを `<html>` に出さない）。

```css
:root {
	--banto-toast-bottom: calc(var(--banto-space-4) + var(--banto-touch-keys-inset-bottom, 0px));
}

/* ランチャーの下バー（既定の位置・bottom）。余白を保ったまま盤の高さを足す */
:root[data-banto-shell-nav='launcher'] {
	--banto-toast-bottom: calc(
		var(--banto-shell-launcher-reserve) + 1rem + var(--banto-touch-keys-inset-bottom, 0px)
	);
}

/* top・left・right のバーは下に余白を取らない */
:root[data-banto-shell-nav='launcher'][data-banto-shell-launcher-position='top'],
:root[data-banto-shell-nav='launcher'][data-banto-shell-launcher-position='left'],
:root[data-banto-shell-nav='launcher'][data-banto-shell-launcher-position='right'] {
	--banto-toast-bottom: calc(1rem + var(--banto-touch-keys-inset-bottom, 0px));
}

/* 900px 以下はどの位置でも下のタブバー */
@media (max-width: 900px) {
	:root[data-banto-shell-nav='launcher'],
	:root[data-banto-shell-nav='launcher'][data-banto-shell-launcher-position] {
		--banto-toast-bottom: calc(
			var(--banto-shell-launcher-tabbar-reserve) + 1rem + var(--banto-touch-keys-inset-bottom, 0px)
		);
	}
}
```

ページの下の余白にも同じ変数を使える（盤の下に隠れる入力欄を作らない）:

```css
.page {
	padding-bottom: var(--banto-touch-keys-inset-bottom, 0px);
}
```

ポップアップ（テンキーの既定）は中央に出るので、この変数は付かない。盤が開く入力欄は `scrollIntoView({ block: 'nearest' })` で
見える所へ寄せられるが、`Modal` の中など寄せられない配置でも、盤の表示の行に見出しと下書きが出る。

## 8. 外し方

**入力欄は素の `<input>` のままなので、外した後もそのまま動く**（値の経路を変えていない）。

- **一時的に切る**: `deviceSettings.touchKeys` を false にする（`enabled` が false になり、盤が開いていれば `disabled` で
  取り消す。ホストが付けた `inputmode="none"` は元に戻る）。
- **一部の欄だけ**: `touchKeys(false)`・`data-touch-keys="off"`・`resolve` の `false`。
- **アプリから外す**: ルートのレイアウトの `<TouchKeysHost>`、各入力欄の `{@attach touchKeys(...)}` と `data-touch-keys`、
  端末ごとの設定とその文言（`touchKeysMessages` と Paraglide のキー）、`--banto-toast-bottom` の上書き、
  `package.json` の依存を外す。
- **テンプレートの見本（`/ui-demo` のカード）を外す・banto から外す**: `pnpm scaffold --preset minimal|standard|display`、
  または [remove-optional-assets.md](remove-optional-assets.md) の「`@banto/touch-keys-svelte`」の手順。

## 確かめ方

- `pnpm --filter @banto/touch-keys-svelte test` — 純粋な関数と jsdom の部品の試験。
- `pnpm e2e:demo` — テンプレートの `/ui-demo` のカードの配線（`e2e/demo/touch-keys.spec.ts`。テンキー・英数・カナ・
  パスワード・切り替え・カードの外の欄）と、grid のセルとの組み合わせ（`e2e/demo/touch-keys-grid.spec.ts`。タッチの文脈で、
  1 回のタップで盤が開く・確定でセルが確定して grid にフォーカスが戻る・保存の拒否・取り消し・実キーボードの Esc）。
- `pnpm e2e:touch-keys` — ブラウザーの fixture（Playwright のタッチの文脈で、本物の `@banto/ui` の `Modal` と組んで、外のタップ・
  層・数値の検証・実キーの Enter・文字キーボード・カナ・パスワードの 95 文字を確かめる）。
- **実機**: タッチパネルの端末で、OS のキーボードが同時に出ないこと・外のタップで盤が閉じること・キーの押しやすさ・
  5 行のカナの盤が収まることを自分の目で確かめる。grid を使う画面では、セルのタップで OS のキーボードが一瞬も出ないこと・
  スクロールの始まりで編集が始まらないことも見る（項目は設計書 §14.4）。
