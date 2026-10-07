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
