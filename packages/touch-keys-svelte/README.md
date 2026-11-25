# @banto/touch-keys-svelte

タッチパネル端末向けの画面内キー（テンキー・文字キーボード）。**オプション・テンプレート未配線（recipe-only）**。
設計は [docs/design/touch-keypad-design.md](../../docs/design/touch-keypad-design.md)、判断は
[ADR-0036](../../docs/adr/0036-touch-keys-package.md)。

## 状態

T5 まで（テンキー、文字キーボード（英数・記号・カナ）、パスワードの入力欄、[レシピ](../../docs/recipes/touch-keys.md)）。**タッチの実機・WebView2 での確かめは
まだ**（設計書 §14.4）。

- `TouchKeysHost` — アプリのルートに 1 つ置く。`enabled`（必須。既定の自動判定は持たない）が true の間、数値の入力欄
  （`type="number"`、`inputmode="numeric"` / `"decimal"`）のタップでテンキーを、文字の入力欄（`type="text"` など）と
  パスワードの入力欄のタップで文字キーボードを開く。確定で入力欄の `value` に書き、`input`・`change` を
  出すので、`bind:value` も `oninput` もそのまま動く。フォーカスは入力欄に置いたまま。盤の外のタップは取り消しで、下の画面には届かない。
  `placement`（`{ number, text }`。既定はテンキーが `popup`、文字が `bottom`）・`layouts`・`resolve`・`messages`・`onopen`・`onconfirm`・
  `oncancel`・`note`。
- 入力欄の指定（`touchKeys` / `resolve`）には共通で `openOnFocus`（既定 `false`）がある。ボタンやセルのタップ（ポインター由来の
  `click`）の続き（同じタスク）でフォーカスが入ったその欄に、盤を OS のキーボードを抑えて開く（入力欄を出してフォーカスする画面向け。
  キーボード由来の `click`〔Enter / Space〕・自動フォーカス・あとのフォーカスでは原則開かない。「同じタスク」は厳密なタスク境界ではなく、ポインター click 直後の短い判定窓（0 ms タイマー）での近似で、キー・次の pointerdown・キーボード由来の click で即失効する）。種類は属性から推定のままにしたいときは
  `kind` なしで `{ openOnFocus: true }` を返す（型 `InferredKeysOptions`）。
- `touchKeys(options | false)` — 入力欄ごとの指定（`{@attach touchKeys({ kind: 'number', min: 0, max: 999, editKey: row.id })}`）。
  同じ `<input>` を別のレコードに使い回す画面では `editKey` を渡す（開いたときと違えば書かない）。外すのは `touchKeys(false)` か、
  入力欄・その包みの `data-touch-keys="off"`。
- **パスワードの入力欄**（`type="password"`）は、必ず伏せた文字キーボードになる。表示は `●` と文字数だけで、平文は盤の外へ出ない
  （`onconfirm` の `value`・`previous` と `note` の `draft` は `null`。下書きは閉じれば残らない。空から始まり、確定で欄の値を置き換える）。**開いて何も打たずに確定しても、既存の値は消えない**
  （空で確定できるのは、盤の「全部消す」を押した直後だけ）。「パスワードを表示」で `type="text"` になる欄は、属性からは
  パスワードと分からないので、`touchKeys({ kind: 'text', masked: true })`（または `resolve`）で明示する。
  打てるのは ASCII の印字できる 95 文字（それ以外を含むパスワードは打てない）。
- `touchKeys({ kind: 'text', maxLength: 20, layouts: ['alnum'] })` — 文字キーボードの指定。最大文字数は `maxlength` 属性との
  小さいほう。`minLength` は `minlength` 属性との大きいほう（空でない下書きに掛かる。最小が最大を超える設定では、空でない下書きは確定できない）。配列は `alnum`（英数）・`symbol`（記号）・`kana`（カナ。`layouts` に書いた欄・ホストだけに出る opt-in。既定は英数 + 記号で、パスワードの盤には入らない）。
  1 つだけなら切り替えのキーは出ない。`masked: true` で、`type` が password でない欄も伏せた盤にする。
- **入力欄そのものの制約**: 文字の確定は、書いた後に入力欄の `validity`（`type="email"`・`"url"` の形式、`pattern`）を見る。
  合わなければ値を元に戻し、`input`・`change`・`onconfirm` を出さず、盤は開いたまま「入力の形式が合いません」を出す。
- `TextKeyboard` — 文字キーボードの表示とキーの入力だけ（単体でも使える）。`draft`（`bind:`）・`maxLength`・`minLength`・`required`・
  `rejected`（持ち主が直前の確定を断った。知らせを出す）・`layouts`・`initialLayout`・`masked`・`label`・`messages`・`note`・
  `onedit({ length, cleared })`・`onconfirm`・`oncancel`。`masked` では `draft` を読み書きせず、文字列は `onconfirm` の 1 回だけで
  渡す（空の確定は「全部消す」の直後だけ）。
- `NumberKeypad` — テンキーの表示とキーの入力だけ（単体でも使える）。`draft`（`bind:`）・`rules`・`min`・`max`・`step`・`decimals`・
  `allowNegative`・`required`・`label`・`messages`・`note`・`onconfirm`・`oncancel`。
- `resolveNumberRules(attrs, spec)` — 入力欄の属性（`type="number"`・`inputmode`・`min`・`max`・`step`・`value`）と
  明示の指定から、範囲・刻み・小数の桁を読む（HTML の `type=number` の検証に合わせる）。
- `classifyDraft(text, rules)` — 下書きを「空・途中・確定できない・確定できる値」に分ける。範囲と刻みは
  10 進の整数で判定する（浮動小数の誤差を持ち込まない）。
- `pressNumberKey`・`normalizeDraft`・`isWritableNumber`・`inferTouchKind` — キー 1 打の遷移、書く形、書く前の検査、
  属性から盤の種類の推定。
- `TouchKeysMessages` / `defaultTouchKeysMessages` — 文言は関数の束（日本語の既定）。アプリが Paraglide から作って渡す。

## 試験

- `pnpm --filter @banto/touch-keys-svelte test` — 純粋な関数と、jsdom の部品の試験。
- `pnpm e2e:touch-keys`（リポジトリのルートで）— ブラウザーの fixture（`tests/browser/`。Playwright のタッチの文脈で、本物の
  `@banto/ui` の `Modal` と組んで、外のタップ・層・フォーカス・ブラウザーの数値の検証・実キーの Enter・文字キーボード・
  パスワードの 95 文字を確かめる）。

## 大きさ

キーの 1 辺は CSS 変数 `--banto-touch-key-size`（既定 `48px`）、間隔は `--banto-touch-key-gap`。`:root` で上書きする。
CSS の `mm` は実寸を保証しないので、端末ごとに合わせる。

## 外す

`packages/touch-keys-svelte/` を消す。手順は [remove-optional-assets](../../docs/recipes/remove-optional-assets.md)。
