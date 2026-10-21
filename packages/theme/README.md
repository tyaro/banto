# @banto/theme

Banto のテーマ基盤。`--banto-*` の CSS 変数トークン一式（`./css` エクスポート
= `src/css/banto.css`）と、`ThemeMode`（light/dark/system）を
`<html data-theme="...">` へ解決・反映するランタイム、Glass/Compact の
プリセット・密度切り替えを提供する（spec §8.2）。UI 側は生値を書かず
`var(--banto-*)` トークンのみを参照する（docs/conventions.md §9）。

## 使用例

```ts
import { applyTheme, watchSystemTheme, applyPreset, applyDensity } from '@banto/theme';

applyTheme('system'); // <html data-theme="light|dark"> を反映
applyPreset('standard'); // <html data-banto-preset="...">
applyDensity('standard'); // <html data-banto-density="...">

const stop = watchSystemTheme((resolved) => {
	console.log('OS テーマが変化:', resolved);
});
// 不要になったら stop() で購読解除
```

```css
/* app.css 等で読み込む */
@import '@banto/theme/css';
```

TS / Svelte の `<script>` から副作用の import（`import '@banto/theme/css';`）で読み込んでもよい。
`./css` の export には空のモジュールの型（`src/css/banto.css.d.ts`、`export {};` だけ）を
`types` 条件で付けてあるので、TypeScript 6 の副作用 import の検査
（`noUncheckedSideEffectImports`）に対して、利用する側が `declare module` を足す必要はない
（v4.0.0 から。#325）。値は何も export しない（実行時の挙動は CSS の読み込みだけ）。
型の解決は exports の条件を読む `moduleResolution: "bundler"`（SvelteKit 3 の
`$app/tsconfig` の既定）を前提にしている。

## オーバーレイのトークン（v6.1.0 から）

モーダル的な重ね表示が使う背景と重なり順のトークン（ADR-0018 §8）。値は light・dark・glass
で共通で、プリセットごとの上書きは無い。z-index は今までアプリが直書きしていた値と同じで、
重なり順は変わらない。

| トークン                  | 値                  | 用途                                                     |
| ------------------------- | ------------------- | -------------------------------------------------------- |
| `--banto-scrim`           | `rgb(0 0 0 / 0.35)` | オーバーレイ（CommandPalette など）の背後を暗くする背景  |
| `--banto-z-header`        | `100`               | 固定ヘッダ（ページ内の浮動要素より上、サイドバーより下） |
| `--banto-z-sidebar-scrim` | `850`               | 狭幅でサイドバーを開いたときの背後の覆い                 |
| `--banto-z-sidebar`       | `900`               | 狭幅のサイドバー（ドロワー）                             |
| `--banto-z-modal`         | `900`               | Modal / Drawer 用（ADR-0018 段階 3 で使う予約値）        |
| `--banto-z-overlay`       | `1000`              | 全画面のオーバーレイ（CommandPalette）                   |
| `--banto-z-toast`         | `1000`              | トースト                                                 |

```css
.my-overlay {
	position: fixed;
	inset: 0;
	z-index: var(--banto-z-overlay);
	background: var(--banto-scrim); /* 生の rgba() は rule `raw-colors` に掛かる */
}
```

## ランチャーのトークン（v6.8.0 から）

`@banto/ui` の `LauncherBar`（ドック風のランチャー、[nav-launcher-plan.md](../../docs/design/nav-launcher-plan.md) §5.2）が
使う寸法と重なり順。シェルの名前空間に置く（`--banto-dock-*` は `@banto/dock-svelte` のもの）。

| トークン                                    | 値                        | 用途                                                                                                         |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--banto-shell-launcher-item-size`          | `44px`                    | 項目の基準寸法（狭い画面のタブバーでは最小の当たり判定）                                                     |
| `--banto-shell-launcher-magnify-max`        | `1.5`                     | 拡大の最大倍率（単位なし。部品が JS で読む。`1` で拡大しない）                                               |
| `--banto-shell-launcher-gap`                | `6px`                     | 項目の間隔                                                                                                   |
| `--banto-shell-launcher-padding`            | `6px`                     | バーの内側の余白                                                                                             |
| `--banto-shell-launcher-offset`             | `10px`                    | 画面端からの距離                                                                                             |
| `--banto-shell-launcher-reserve`            | `calc(...)`               | 本文の下に取る余白（item-size + padding × 2 + offset）                                                       |
| `--banto-shell-launcher-tabbar-reserve`     | `calc(...)`               | 900px 以下のタブバーで本文の下に取る余白（item-size + 0.5rem + safe-area）                                   |
| `--banto-z-launcher`                        | `200`                     | ランチャーのバー（ヘッダより上、狭幅サイドバーの覆い・Modal・トーストより下）                                |
| `--banto-shell-launcher-opacity`            | `50%`                     | バーの不透明度（アプリの設定で変えるのはこの値だけ）                                                         |
| `--banto-shell-launcher-tabbar-opacity-min` | `85%`                     | 900px 以下のタブバーの不透明度の下限（設定がこれより低くても、この濃さで描く）                               |
| `--banto-shell-launcher-bg`                 | `surface-overlay` の 50%  | バーの半透明の地                                                                                             |
| `--banto-shell-launcher-backdrop`           | `blur(1px) saturate(1.5)` | バーの後ろのぼかし                                                                                           |
| `--banto-shell-launcher-tooltip-bg`         | `surface-raised` の 80%   | ツールチップの半透明の地                                                                                     |
| `--banto-shell-launcher-tooltip-backdrop`   | `blur(5px)`               | ツールチップの後ろのぼかし                                                                                   |
| `--banto-shell-launcher-tooltip-max-width`  | `10rem`                   | 左右のバーのツールチップの最大幅（これを超えると折り返す。バーはこの幅ぶん本文側を空けて切れないようにする） |
| `--banto-shell-launcher-inset-top`          | `0px`                     | 上のバーの上に空ける量（上にヘッダーがあるシェルはヘッダーの高さを入れ、バーをヘッダーの下に置く）           |

半透明の 4 つは、`prefers-reduced-transparency: reduce` のときと `backdrop-filter` が使えないブラウザでは不透明（ぼかし無し）に戻る。
ルート要素に `data-banto-shell-nav="launcher"` が付いているあいだは、`--banto-toast-bottom` をバー（900px 以下はタブバー）の上に上げる（アプリのシェルがドック表示のときに付ける）。あわせて `data-banto-shell-launcher-position` が `top` / `left` / `right` のときは下を空けたままにし、`right` ではトーストを `--banto-toast-right` でバーの左へ逃がす（900px 以下はどの位置でもタブバーの上）。

## 寸法のトークン（次の版から）

余白・文字サイズ・枠線幅の段階（[theme-dimension-tokens.md](../../docs/design/theme-dimension-tokens.md) §5.2）。
追加のみで、既存の値と画面は変わらない。生の `rem` / `px` から**任意で**置き換えられる。値はすべて `rem`
（枠線幅は `px`）なので、root の `--banto-font-size`（既定 14px）に追従する。密度（compact）では切り替えない。
部品の形（幅・高さ・列幅・アイコンの大きさ）は段階に入れない。

| トークン                      | 値         | 用途                                   |
| ----------------------------- | ---------- | -------------------------------------- |
| `--banto-space-1`             | `0.25rem`  | 余白（序数。値は名前に含めない）       |
| `--banto-space-2`             | `0.5rem`   | 余白                                   |
| `--banto-space-3`             | `0.75rem`  | 余白                                   |
| `--banto-space-4`             | `1rem`     | 余白                                   |
| `--banto-space-5`             | `1.25rem`  | 余白                                   |
| `--banto-space-6`             | `1.5rem`   | 余白                                   |
| `--banto-space-7`             | `2rem`     | 余白                                   |
| `--banto-space-8`             | `3rem`     | 余白（空状態など）                     |
| `--banto-font-size-xs`        | `0.7rem`   | バッジ・極小ラベル                     |
| `--banto-font-size-sm`        | `0.8rem`   | caption                                |
| `--banto-font-size-md`        | `0.875rem` | 補足・表の副情報（本文より一段小さい） |
| `--banto-font-size-lg`        | `1.125rem` | 見出し                                 |
| `--banto-font-size-xl`        | `1.75rem`  | display（KPI の数値など）              |
| `--banto-border-width`        | `1px`      | 枠線の幅                               |
| `--banto-border-width-strong` | `2px`      | 選択・強調の縁                         |

本文（body）は root の `1rem` を継承するので、本文用のトークンは無い。

```css
.my-card {
	padding: var(--banto-space-4);
	border: var(--banto-border-width) solid var(--banto-border);
	font-size: var(--banto-font-size-md);
}
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §8.2](../../docs/ui-framework-spec.md)（含まれる雛形 — テーマ切替）
