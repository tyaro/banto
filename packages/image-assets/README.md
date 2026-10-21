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
| PR-13 | 取込の検査: decode 前のヘッダ検査（PNG / JPEG の形式・寸法・画素数）と decode 後の確認、hash（`crypto.subtle` があれば使い、無ければ自前の SHA-256。同じ値）    | 入っている |
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
import { inspectImage, isImageAssetError, validateImageImportLimits } from '@banto/image-assets';

const limits = validateImageImportLimits({
	maxBytes: 8 * 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
});

try {
	const image = await inspectImage(file, limits); // file: File / Blob / Uint8Array / ArrayBuffer
	// image: { format, mimeType, width, height, transposed, byteLength, hasAlpha, sha256 }
} catch (e) {
	if (isImageAssetError(e)) showError(m[`imageAssets.error.${e.code}`](e.detail));
	else throw e;
}
```

## 取込の検査（PR-13）

| API                                              | 中身                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspectImage(input, limits, { decode? })`       | 下の 3 つを順に通す。`Blob` は `size` で `maxBytes` を見てから読む（大きすぎるファイルをメモリに載せない）。ヘッダで落ちたら decode しない                            |
| `inspectImageHeader(bytes, limits)`              | decode 前のヘッダ検査。順に bytes（`too-large`）→ 形式（`unsupported-format`）→ 構造（`malformed-header`）→ 辺（`dimensions-too-large`）→ 画素数（`too-many-pixels`） |
| `verifyDecodedImage(bytes, header, { decode? })` | ブラウザで実際に decode し、寸法がヘッダと一致するか確かめる（`decode-failed`・`dimensions-mismatch`）。decode した画像は必ず `close()` する                          |
| `sha256Hex(bytes)`                               | SHA-256 の 16 進（小文字 64 桁）。`crypto.subtle` があれば使い、無ければ（平文 HTTP の LAN）自前の SHA-256。同じ値（D11）                                             |

- **サーバーの検査の代わりではない**: 取込の画面で早く断るための検査。アップロードを受けるサーバーは自分で
  マジックバイトを判定する（docs/conventions.md §6）。
- **上限は毎回検証する**: `inspectImageHeader` と `inspectImage` は受け取った上限を
  `validateImageImportLimits` に通し直す。検証していない上限を渡しても無検査にはならない。
- **形式は中身で決める**: ファイル名や `Blob.type` は見ない。decode に渡す `Blob` の type もヘッダから決めた
  MIME にする。
- **decode の注入**: 既定は `createImageBitmap(blob, { imageOrientation: 'from-image' })`。テスト（node / jsdom）
  や別の decode を使うアプリは `decode: (blob) => Promise<{ width, height, close?() }>` を渡す。投げる・拒否する・
  正の整数でない寸法を返すのはどれも `decode-failed`。
- **hash の用途は重複排除のキー**: 改ざん検知や認証には使わない（ADR-0020「帰結」）。自前の SHA-256 は
  8MiB で約 50ms（node 25 / V8 の計測。`crypto.subtle` は約 13ms）。

### ヘッダ検査の範囲

- **PNG**: 静止画だけ。最初のチャンクが正しい IHDR（長さ 13、幅・高さが 1〜2^31-1、色の型とビット深度の
  組が仕様どおり、圧縮・フィルタが 0、インタレースが 0 か 1）。全チャンクの長さが範囲内で、IDAT があり、
  IEND で終わり、その後ろに何も無いこと。`acTL`（APNG）は `unsupported-format`。CRC は見ない（decoder が見る）。
  `hasAlpha` は色の型 4・6 か `tRNS` チャンクがあるとき `true`。
- **JPEG**: 最初のフレームヘッダ（SOFn）までマーカーを走査する。ベースライン（SOF0）・拡張シーケンシャル（SOF1）・
  **プログレッシブ（SOF2）を受け入れる**。8 ビットで成分数 1・3・4（グレー・YCbCr / RGB・**CMYK / YCCK を受け入れる**）。
  ロスレス・階層・算術符号化のフレームと 12 ビットは `unsupported-format`（ブラウザが decode しない）。
  セグメント長は 2 以上で残りの長さに収まること、フレームヘッダの長さは成分数と一致することを確かめ、
  壊れた・悪意のある入力でも範囲外を読まず、走査は必ず前に進む（無限ループしない）。高さ 0（DNL で後から
  決まる）は `malformed-header`。フレームヘッダより後ろ（スキャンのデータ）は decode 後の確認に任せる。
  `hasAlpha` は常に `false`。
- **EXIF の向きは読まない**: ヘッダ検査の寸法は保存された寸法。90 度の回転は幅と高さを入れ替えるだけで
  `maxEdge`（各辺に同じ上限）と `maxPixels` の判定は変わらない。decode 後の確認は入れ替わった寸法も一致と
  みなし、`transposed: true` で返す（`width` / `height` は表示される向きの寸法）。PNG の `eXIf` も同じ扱い。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ（docs/conventions.md §4・§5）。
SHA-256 も自前（docs/conventions.md §3。ADR-0020 §4）。`.svelte.ts` は持たないので `optimizeDeps.exclude`（docs/conventions.md §14）は要らない。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、外部リポジトリからは git
サブディレクトリ依存で消費する。詳細は [../../docs/publishing.md](../../docs/publishing.md) を参照。
