# @banto/touch-keys-svelte

タッチパネル端末向けの画面内キー（テンキー・文字キーボード）。**オプション・テンプレート未配線（recipe-only）**。
設計は [docs/design/touch-keypad-design.md](../../docs/design/touch-keypad-design.md)、判断は
[ADR-0036](../../docs/adr/0036-touch-keys-package.md)。

## 状態

T1（本パッケージの新設）まで。入力欄との結びつけ（`TouchKeysHost`・`touchKeys`）・文字キーボード・カナ・
レシピは後の段階（設計書 §15）。

- `NumberKeypad` — テンキーの表示とキーの入力だけ。`draft`（`bind:`）・`min`・`max`・`step`・`decimals`・
  `allowNegative`・`required`・`label`・`messages`・`onconfirm`・`oncancel`。
- `resolveNumberRules(attrs, spec)` — 入力欄の属性（`type="number"`・`inputmode`・`min`・`max`・`step`・`value`）と
  明示の指定から、範囲・刻み・小数の桁を読む（HTML の `type=number` の検証に合わせる）。
- `classifyDraft(text, rules)` — 下書きを「空・途中・確定できない・確定できる値」に分ける。範囲と刻みは
  10 進の整数で判定する（浮動小数の誤差を持ち込まない）。
- `pressNumberKey`・`normalizeDraft`・`isWritableNumber`・`inferTouchKind` — キー 1 打の遷移、書く形、書く前の検査、
  属性から盤の種類の推定。
- `TouchKeysMessages` / `defaultTouchKeysMessages` — 文言は関数の束（日本語の既定）。アプリが Paraglide から作って渡す。

## 大きさ

キーの 1 辺は CSS 変数 `--banto-touch-key-size`（既定 `48px`）、間隔は `--banto-touch-key-gap`。`:root` で上書きする。
CSS の `mm` は実寸を保証しないので、端末ごとに合わせる。

## 外す

`packages/touch-keys-svelte/` を消す。手順は [remove-optional-assets](../../docs/recipes/remove-optional-assets.md)。
