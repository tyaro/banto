# レシピ: タッチパネル端末の画面内キー（`@banto/touch-keys-svelte`）

作成日: 2026-11-25（#937 T5。トラックB＝アプリ作者向け）

タッチパネルの端末（キーボードの無い現場の端末）で、入力欄のタップに **画面内のテンキー・文字キーボード** を出す。
確定で入力欄の `value` に書き、`input`・`change` を出すので、`bind:value` も `oninput` も `BantoForm` の検証もそのまま動く。
OS のタッチキーボードは出さない（`inputmode="none"`）。パッケージ単体の API は
[packages/touch-keys-svelte/README.md](../../packages/touch-keys-svelte/README.md)、設計と判断は
[設計書](../design/touch-keypad-design.md)・[ADR-0036](../adr/0036-touch-keys-package.md)。

> **テンプレートにはまだ配線されていない。** `apps/admin-template` は `@banto/touch-keys-svelte` に依存しない
> （`pnpm scaffold` も触れない）。配線は別の判断（#937 T7）で、それまでは下の手順を**自分のアプリで**行う。
> **タッチの実機・WebView2 での確かめも未実施**（設計書 §14.4）。出す前に、自分の端末で OS のキーボードが同時に出ないか・
> キーの大きさを必ず確かめる。

## 1. 依存を足す

利用するアプリの `package.json`（モノレポ内なら `workspace:*`、本リポジトリ外からは
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
	import { touchKeysMessages } from '#lib/touchKeysMessages'; // 6 節

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
  `touchKeys({ kind: 'text', masked: true })`（または `resolve`）で明示する。打てるのは ASCII の印字できる 95 文字だけ。
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
  **`resolve` で範囲を渡す**（書き忘れると範囲なしのテンキーになる）。**限界**: `DraftNumberField` は `input` では
  `draft.setRaw()` しか呼ばず、検証と値の確定は blur か Enter の `draft.commit()` で行う。盤の確定は入力欄へ書いて `input` を出す
  までで、フォーカスは入力欄に残るため、**盤を閉じた直後には forms の検証・確定は走らない**（次の blur・Enter・フォーム送信で走る）。
  grid のセルと同じ限界で、盤の範囲の知らせ（`resolve` の `min` / `max`）が、その場の唯一の検証になる。`input.id` はフィールド名（`DraftNumberField` は `id` を省くと `def.name`）。

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
入力欄が自分のものなら `touchKeys(...)` のほうが近くに書けて素直。日付・時刻の入力欄は文字の欄なので、何もしなければ
文字キーボードの対象になる。アプリの包み（`FormDateInput.svelte` など）に `data-touch-keys="off"` を付ける。

grid のセルの編集は、エディタが素の `<input>` なのでタップで盤が開くが、**編集の開始がダブルクリック**（タッチだけでは始められない）、
**確定の後にセルの確定が blur か Enter を待つ**ため、盤の確定だけでセルは確定しない。grid 側の対応は別の Issue（設計書 §18 の 7）。

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

```ts
// src/lib/touchKeysMessages.ts
import type { TouchKeysMessages } from '@banto/touch-keys-svelte';
import * as m from '#lib/paraglide/messages.js';

export function touchKeysMessages(): TouchKeysMessages {
	return {
		numberKeypad: () => m['touchKeys.numberKeypad'](),
		textKeyboard: () => m['touchKeys.textKeyboard'](),
		confirm: () => m['touchKeys.confirm'](),
		cancel: () => m['touchKeys.cancel'](),
		backspace: () => m['touchKeys.backspace'](),
		clearAll: () => m['touchKeys.clearAll'](),
		sign: () => m['touchKeys.sign'](),
		range: (min, max) => m['touchKeys.range']({ min: min ?? '', max: max ?? '' }),
		length: (length, max) => m['touchKeys.length']({ length, max: max ?? '' })
		// 使うものだけ書けばよい。残りは日本語の既定のまま
		// （step・required・alnum・symbol・kana・dakuten・handakuten・small・upper・lower・space・
		//  maxLength・minLength・lengthConflict・invalid）。
	};
}
```

- 全部の項目は `TouchKeysMessages`（`packages/touch-keys-svelte/src/messages.ts`）。**英語などに切り替えるアプリは、
  使う盤に出る項目を漏らさず書く**（書かなかった項目は日本語の既定が出る）。
- Paraglide のメッセージは呼び出しのたびに解決する閉包にする（`() => m[...]()`）。ロケールの切り替えに追従する。
- `messages/*.json` に足したら、`pnpm --filter <app> paraglide:compile` を走らせる。

## 7. トーストの逃がし方

下の固定の文字キーボードは、`LauncherBar`（z 200）・トースト（z 1000、右下）より**手前**に出て、開いている間はその下を隠す。
トーストが盤に隠れないよう、ホストは開いている間 `<html>` に盤の高さ（px）を `--banto-touch-keys-inset-bottom` として出す
（閉じたら外す）。`ToastHost` は `--banto-toast-bottom`（既定 `var(--banto-space-4)`）を読むので、これに足す。

```css
:root {
	--banto-toast-bottom: calc(var(--banto-space-4) + var(--banto-touch-keys-inset-bottom, 0px));
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
- **banto から外す**: [remove-optional-assets.md](remove-optional-assets.md) の「`@banto/touch-keys-svelte`」。

## 確かめ方

- `pnpm --filter @banto/touch-keys-svelte test` — 純粋な関数と jsdom の部品の試験。
- `pnpm e2e:touch-keys` — ブラウザーの fixture（Playwright のタッチの文脈で、本物の `@banto/ui` の `Modal` と組んで、外のタップ・
  層・数値の検証・実キーの Enter・文字キーボード・カナ・パスワードの 95 文字を確かめる）。
- **実機**: タッチパネルの端末で、OS のキーボードが同時に出ないこと・外のタップで盤が閉じること・キーの押しやすさ・
  5 行のカナの盤が収まることを自分の目で確かめる。
