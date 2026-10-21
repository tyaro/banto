# @banto/admin-core

Banto の refine ライクなヘッドレスコア。リソース登録、`DataProvider`/
`AuthProvider` の抽象、Runes ベースのコンポーザブル（`createListResource`/
`createFormResource` 等）を提供する。バックエンドは Tauri `invoke()` を
既定に、InMemory/HTTP 実装へ差し替え可能（spec §3）。

## 使用例

```ts
import { initBanto, createInMemoryDataProvider, createListResource } from '@banto/admin-core';
import type { AuthProvider } from '@banto/admin-core';

const authProvider: AuthProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	check: async () => true,
	getIdentity: async () => ({ id: '1', name: 'demo' })
};

initBanto({
	dataProvider: createInMemoryDataProvider({ items: { rows: [{ id: 1, name: 'ペン' }] } }),
	authProvider,
	resources: [{ name: 'items', label: '商品' }]
});

const items = createListResource('items');
await items.load();
console.log(items.rows, items.totalCount);
```

## ブロック読み込みの一覧の失敗（`WindowedListResource`・`SnapshotListResource`）

`createWindowedListResource(resource, options)` と
`createSnapshotListResource(fetcher, options)`（spec §4.1、
[ADR-0015](../../docs/adr/0015-snapshot-list-resource.md)）は、失敗を同じ形で
出す。`failures` はブロック順・ブロックごとに 1 件の `ListBlockErrorFailure`
（`{ block, kind: 'error', code, error }`。`SnapshotListResource` はこれに
`{ block, kind: 'expired' }` が加わる）。種類は `code`（`ListBlockFailureCode`:
`'request'`・`'timeout'`・`'malformed'`、`SnapshotListResource` だけ
`'boundaryMismatch'` も）で見分け、文言は比べない。データソース（`getList` や
取得関数）が投げた `ProviderError` は同じオブジェクトのまま `error` に入る
（`code: 'request'`）。それ以外の値と、リソースが自分で作る失敗は
`ListBlockError`（`isListBlockError()` で判定）。リソースが自分で作る失敗の
文言は `messages` で差し替え（既定は英語）、失敗ごとのトーストは `notify` で
止められる。

```ts
import { createWindowedListResource } from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';

const items = createWindowedListResource('items', {
	messages: {
		timeout: (ms) => m['items.loadTimeout']({ seconds: Math.round(ms / 1000) }),
		malformed: () => m['items.malformedResult']()
	}
});

// `refresh()` の間も表示中の行は保たれ、`failures` は取り直しが済んだブロックから更新される。
const loadFailed = $derived(items.failures.length > 0);
```

`SnapshotListResource` は `messages` に `boundaryMismatch` も渡せる。

```ts
import { createSnapshotListResource } from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';

const list = createSnapshotListResource(fetchBlock, {
	messages: {
		timeout: (ms) => m['list.timeout']({ seconds: Math.round(ms / 1000) }),
		boundaryMismatch: () => m['list.boundaryMismatch'](),
		malformed: () => m['list.malformed']()
	},
	// 画面に出すのでトーストは出さない（述語で失敗ごとに決めてもよい）。
	notify: false
});

// 種類ごとに最も前のブロックの失敗を出す。
const timedOut = $derived(list.failures.find((f) => f.kind === 'error' && f.code === 'timeout'));
```

`expired` は今の世代が失効して続きを読まないことを示す（`failures` の
`kind: 'expired'` は、そのブロックの取得が成功するまで前の世代の分も残る）。

## 古い非同期結果を捨てる（`createRequestOwner`）

画像の読み込み・ファイルの読込・保存の応答待ちのあいだに対象や画面が変わったとき、古い結果を
反映せず、途中で作った一時資源（object URL・ImageBitmap など）を一度だけ解放するための部品
（shared-primitives-upstream-plan §3.1）。画面・controller ごとに 1 つ作り、unmount で `dispose()` する。

```ts
import { createRequestOwner } from '@banto/admin-core';

const requests = createRequestOwner();
let busy = $derived(requests.busy('image'));

async function loadImage(file: File) {
	const request = requests.begin('image'); // 同じ key の前の要求は失効し、signal が abort される
	try {
		// abort できない処理は最後まで走る。得た資源は hold して寿命を要求に預ける
		const bitmap = request.hold(await createImageBitmap(file), (b) => b.close());
		// 失効していたら adopt は false（model もエラーも上書きしない。bitmap は finish で閉じる）
		if (request.adopt(bitmap)) model.image = bitmap; // 採用した資源は model へ移る（閉じられない）
	} catch (error) {
		if (request.isCurrent()) model.error = error;
	} finally {
		request.finish(); // 未採用の資源を解放。旧要求の finish は新要求の busy を解かない
	}
}

// 対象が変わったら（どの変化で失効させるかはアプリが決める）
function onCropChanged() {
	requests.invalidate('image');
}
// unmount で
onDestroy(() => requests.dispose());
```

- `signal` は取り消せる処理（`fetch` など）に渡す。取り消せない処理は `isCurrent()` で結果を捨てる。
- 完了済みの副作用（OS の clipboard への書き込みなど）は巻き戻さない。失効で約束するのは、
  古い結果をもとに次の操作（切り取り元の削除など）をしないことまで。
- 認証の credential revision（`sessionController`）の代わりにはしない。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コア → オプションの逆依存禁止、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §3](../../docs/ui-framework-spec.md)（フレームワークコア仕様）
