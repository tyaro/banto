# @banto/image-assets

ブラウザ側で画像を取り込み、原本の bytes のまま持ち回るための部品（オプション扱い、
[ADR-0020](../../docs/adr/0020-image-assets-package.md)・Issue #438）。取込の前にヘッダを検査し、
原本を hash で重複排除して保持し、表示用の object URL の寿命を所有者が管理する。
デザイナのように「取り込んだ画像を原本のまま保存・再利用する」画面のためのもので、サーバーへの
添付（`@banto/attachments`）とは目的が違う。テンプレート本体には配線しておらず、使うアプリが
直接組み込む。

## 状態（段階的に入る）

| PR    | 中身                                                                                                                                                            | 状態       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| PR-12 | 骨格: 形式（`IMAGE_FORMATS`）、上限の型と検証（`ImageImportLimits`・`validateImageImportLimits`）、エラーコード（`ImageAssetError`・`IMAGE_ASSET_ERROR_CODES`） | 入っている |
| PR-13 | 取込の検査: decode 前のヘッダ検査（PNG / JPEG の形式・寸法・画素数）と decode 後の確認、hash（`crypto.subtle` があれば使い、無ければ自前の SHA-256。同じ値）    | 未         |
| PR-14 | 原本と URL の寿命: 原本 bytes の保持、hash による重複排除、object URL の共有と解放、pin / release、要求の失効の契約                                             | 未         |

計画は [docs/design/shared-primitives-upstream-plan.md](../../docs/design/shared-primitives-upstream-plan.md) §3.7・§5。

## 約束

- **上限は呼び出し側が渡す**: bytes・辺長・画素数・許可形式は必須の引数で、パッケージは既定値を持たない
  （「上限なし」も既定にしない）。渡された上限は `validateImageImportLimits` で検証し、不正なら
  `ImageAssetError('invalid-limits', { field })` を投げる。
- **文言を持たない**: 失敗は `ImageAssetError` の `code` と `detail`（上限・実際の値など）で返す。
  画面の文言はアプリが Paraglide のキーで決める（docs/conventions.md §13）。`message` はコードと同じ
  文字列で、そのまま画面に出すものではない。

```ts
import { isImageAssetError, validateImageImportLimits } from '@banto/image-assets';

const limits = validateImageImportLimits({
	maxBytes: 8 * 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
});

try {
	// PR-13 以降の取込の検査に limits を渡す
} catch (e) {
	if (isImageAssetError(e)) showError(m[`imageAssets.error.${e.code}`](e.detail));
	else throw e;
}
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ（docs/conventions.md §4・§5）。
`.svelte.ts` は持たないので `optimizeDeps.exclude`（docs/conventions.md §14）は要らない。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、外部リポジトリからは git
サブディレクトリ依存で消費する。詳細は [../../docs/publishing.md](../../docs/publishing.md) を参照。
