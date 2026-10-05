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
