# ADR-0036: タッチ向けの画面内キーは、新しいオプションのパッケージ `@banto/touch-keys-svelte` に置く

> English: [0036-touch-keys-package.en.md](0036-touch-keys-package.en.md)

- 状態: Accepted
- 日付: 2026-11-25（オーナー決定: [設計書 §18](../design/touch-keypad-design.md) の 17 件を推奨どおり）
- 関連: Issue #937 / [touch-keypad-design.md](../design/touch-keypad-design.md) §0・§4・§15・§17 /
  [conventions.md](../conventions.md) §3・§4・§5・§13 / [template-scope.md](../template-scope.md) §1・§3・§3.1 /
  [ADR-0018](0018-shared-ui-package.md)・[ADR-0020](0020-image-assets-package.md)

## コンテキスト

タッチパネルの端末（キオスク・現場の画面）では、OS のキーボードが出ない・大きすぎる・業務の入力に合わない。
画面の中にテンキーと文字キーボードを出し、入力欄の値を安全に書き込む部品を足したい（Issue #937）。
`@banto/ui` は**コア**（template-scope §2.1、削除を想定しない）で、横断性の弱い部品を全利用者に継承させたくない。

## 決定

### 1. 新しいオプションのパッケージ `@banto/touch-keys-svelte`（`packages/touch-keys-svelte`）に置く

- `@banto/ui` には足さない。消すのはフォルダ 1 つ。名前は `dock-svelte`・`tree-svelte`・`grid-svelte` に合わせる。
- `dependencies` / `peerDependencies` は空。素の import は `svelte`・`svelte/*` と相対パスだけ
  （conventions §4・§5。`@banto/ui` は import できないので、層の約束は DOM の印で合わせる。設計書 §4.1）。
- 文言は関数の束 `TouchKeysMessages`（日本語の既定つき）を `messages` で受ける。辞書も Paraglide も持たない（conventions §13）。
- キーの大きさは部品の CSS 変数 `--banto-touch-key-size`（既定 48px）。theme には足さない（設計書 §10）。

### 2. テンプレートのアプリには配線しない（recipe-only）

アプリは依存しない。scaffold はどのプリセットでも触れず、基準画像も変わらない（設計書 §4.2 の a）。
外す手順は [remove-optional-assets](../recipes/remove-optional-assets.md) に書く。

### 3. 外部利用 fixture（rule `external-consumer-fixture`）の扱い

fixture の ref は直近のタグ（v8.0.0）で、このパッケージはそのタグに無い。T1 は **`.svelte.ts` を持たない形**
（純粋な `.ts` の関数と `.svelte` だけ）にして、rule の対象外にする（オーナー決定 2026-11-25）。
後の段階（T2 以降）で `.svelte.ts` が要るときは、ADR-0020 §6 の手順（fixture の dependencies・import・
`optimizeDeps.exclude` を同じ PR で足す。ref のタグにパッケージが無い間の扱いはその PR で決める）に従う。

### 4. 段階

T1（本 ADR・登録・数値の純粋な関数・`NumberKeypad` の表示）→ T2（ホストと `touchKeys`）→ T3（文字キーボード）→
T4（カナ）→ T5（レシピ）。範囲は設計書 §15。

## 帰結

- `@banto/*` のパッケージが 1 つ増える（13 個目）。版は他と揃える（`check:versions`）。
- 利用先が 1 つのままなら、オプションから外すことを見直す（image-assets と同じ合図）。
