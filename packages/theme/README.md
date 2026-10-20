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

| トークン                                  | 値                        | 用途                                                                          |
| ----------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `--banto-shell-launcher-item-size`        | `44px`                    | 項目の基準寸法（狭い画面のタブバーでは最小の当たり判定）                      |
| `--banto-shell-launcher-magnify-max`      | `1.5`                     | 拡大の最大倍率（単位なし。部品が JS で読む。`1` で拡大しない）                |
| `--banto-shell-launcher-gap`              | `6px`                     | 項目の間隔                                                                    |
| `--banto-shell-launcher-padding`          | `6px`                     | バーの内側の余白                                                              |
| `--banto-shell-launcher-offset`           | `10px`                    | 画面端からの距離                                                              |
| `--banto-shell-launcher-reserve`          | `calc(...)`               | 本文の下に取る余白（item-size + padding × 2 + offset）                        |
| `--banto-shell-launcher-tabbar-reserve`   | `calc(...)`               | 900px 以下のタブバーで本文の下に取る余白（item-size + 0.5rem + safe-area）    |
| `--banto-z-launcher`                      | `200`                     | ランチャーのバー（ヘッダより上、狭幅サイドバーの覆い・Modal・トーストより下） |
| `--banto-shell-launcher-opacity`          | `50%`                     | バーの不透明度（アプリの設定で変えるのはこの値だけ）                          |
| `--banto-shell-launcher-bg`               | `surface-overlay` の 50%  | バーの半透明の地                                                              |
| `--banto-shell-launcher-backdrop`         | `blur(1px) saturate(1.5)` | バーの後ろのぼかし                                                            |
| `--banto-shell-launcher-tooltip-bg`       | `surface-raised` の 80%   | ツールチップの半透明の地                                                      |
| `--banto-shell-launcher-tooltip-backdrop` | `blur(5px)`               | ツールチップの後ろのぼかし                                                    |

半透明の 4 つは、`prefers-reduced-transparency: reduce` のときと `backdrop-filter` が使えないブラウザでは不透明（ぼかし無し）に戻る。
ルート要素に `data-banto-shell-nav="launcher"` が付いているあいだは、`--banto-toast-bottom` をバー（900px 以下はタブバー）の上に上げる（アプリのシェルがドック表示のときに付ける）。

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
