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

## UI 設定の provider（`UiSettingsProvider`）と `updateUiSetting`

画面の記憶（テーマ・配置など）を、文字列のキーと値で読み書きする口（Issue #786）。実装は 3 つ:
`createLocalUiSettings`（localStorage）・`createTauriUiSettings`（Tauri のコマンド）・`createHttpUiSettings`（REST）。

```ts
interface UiSettingsProvider {
	get(key: string): Promise<{ value: string | null; revision: string }>;
	set(
		key: string,
		value: string,
		options?: { ifRevision?: string }
	): Promise<{ revision: string; superseded?: false } | { revision: null; superseded: true }>;
	remove(key: string, options?: { ifRevision?: string }): Promise<{ revision: string }>;
}
```

- `revision` は書き込みのたびに変わる、中身の決まっていない文字列。何も無いときは `"0"`
  （`UI_SETTING_ABSENT_REVISION`）。大小を比べない。`ifRevision` に返すだけにする。
- `ifRevision` を省いた書き込みは無条件（最後の書き込みが勝つ）。付けると、保存されている revision が同じ間だけ書く
  （`"0"` は「まだ無いこと」）。合わなければ `ProviderError`（`kind: 'conflict'`）で reject し、
  `uiSettingConflict(error)` が今の `{ value, revision }` を返す（`conflict` でなければ `null`）。
- **書き込みの直列化（Tauri・HTTP、#707）**: 同じキーの書き込みは同時に 1 つだけ送り、残りは受け付けた順に送る。
  - 待っている**無条件の `set`** は、次に来た無条件の書き込み（`set` か `remove`）に置き換えられる。置き換えられた値は
    送られず、その `set` は `{ revision: null, superseded: true }` で resolve する（「保存された」ではなく「送っていない」。
    結果は後の書き込みが持つ）。
  - **条件付きの書き込みは置き換えられない**（置き換えもしない）。必ず送り、サーバーの答えだけで決着する。
    `remove` も置き換えられない。
  - 受け付けた後にセッションが替わった書き込みは送らず、`unauthorized` で reject する。
  - `get` は、そのキーの書き込みが終わるのを待ってから読む。`get` 自体はセッションを見ない（送る時点のセッションで読む）。
    読んだ値を後の書き込みに持ち込むときは、`sessionGuard?.()`（今のセッションを覚え、「まだ同じか」を返す関数を返す。
    Tauri・HTTP の実装が持つ）で間の切り替えを確かめる。`updateUiSetting` はこれを行う。
- **`createLocalUiSettings` とタブ**: 書き込みは Web Locks API（`navigator.locks`）のロックの下で、判定と書き込みをまとめて行う。
  Web Locks API の無い環境（secure context でないページ・古いブラウザー）では、条件付きの書き込みは同じ文書の中だけで確かで、
  タブをまたいだ上書きの防止には使えない。ロックの仕組みはあるのに取れなかったときは、書かずに `storage` のエラーで断る。

### 別のタブの変更を上書きしない: `updateUiSetting`

```ts
import { updateUiSetting } from '@banto/admin-core';

const { value, revision } = await updateUiSetting(provider, 'items.pinned', (current) => {
	const pinned: string[] = current === null ? [] : JSON.parse(current);
	return pinned.includes(id) ? (current as string) : JSON.stringify([...pinned, id]);
});
```

読む → `apply(今の値)` → 条件付きで書く → `conflict` なら返ってきた今の値に当て直す、を繰り返す
（条件付きの書き込みは既定で 5 回まで。`{ maxAttempts }`。使い切ったら最後のエラーで reject）。
`apply` が渡された値をそのまま返したら、書かずに終える。

**`apply` は冪等であること**（契約）: 自分の結果にもう一度当てても、同じ値になること（キーの上書き・集合への追加・
欄の置き換え。「1 増やす」「末尾へ足す」は冪等ではない）。理由:

- 応答だけが失われた書き込み（通信の失敗・5xx）は、**同じ PUT を送り直さない**。読み直して、値が送ったものと同じなら
  成功として終える（以後の revision は読み直したもの）。違えば、その値に `apply` を当て直す。このとき、自分の書き込みが
  既に入り、その上に別のタブが書いた値に当たることがある。
- `conflict` の後も、今の値に当て直す。

冪等にできない変更は、値の中に操作の id を持って、`apply` の中で重複を落とす（サーバーに操作の記録は無い）。
断られた書き込み（`validation`・`unauthorized`・`forbidden` など）と、読み取りの失敗は、すぐ reject する。

1 回の更新は、始めたときのセッションのもの。読み取り・書き込み・読み直しのどれを待っている間でも、セッションが替わったら
`unauthorized` で止まる（前のアカウントで読んだ値を、次のアカウントの設定に当てない・書かない・返さない。`"0"` はどの
アカウントでも同じ revision なので、条件だけでは止まらない）。前のセッションで既に送った書き込みは、そのセッションの値として
入っていることがある。

## UI 設定の現在値と保存済みの値を分ける（`createSavedSetting`）

`UiSettingsProvider`（Local / Tauri / HTTP）の上に乗る helper。provider は置き換えない
（shared-primitives-upstream-plan §3.4）。書き込みは既定で無条件（`merge` を渡したときだけ revision で条件付きにする）。「今編集している値（`current`）」と「保存に成功した最後の値
（`saved`）」を分け、保存が失敗しても編集中の値と前の保存値を守る。通知の文言・適用対象・標準値は
アプリの責務（`error` / `save()` の結果を見て出す）。

```ts
import { createSavedSetting } from '@banto/admin-core';

const layout = createSavedSetting({
	provider: uiSettingsProvider,
	key: 'dashboard.floating',
	parse: (raw) => parseLayout(raw), // 破損・未知の version は undefined（throw でもよい）
	serialize: (value) => JSON.stringify(value), // 同じ値は同じ文字列（dirty の判定に使う）
	fallback: () => DEFAULT_LAYOUT, // 保存値が無い・壊れているときの標準値
	mode: 'explicit' // 'immediate' なら set() のたびに送る
});

const result = await layout.load(); // 'loaded' | 'missing' | 'invalid' | 'failed' | 'stale'
if (result === 'invalid') toast(m.settings_reset_to_default()); // 文言はアプリ

layout.set(next); // current を変える（explicit では送らない）
if (!(await layout.save())) toast(m.settings_save_failed()); // layout.error に ProviderError など
layout.revert(); // current を saved へ（無ければ標準値へ）。保存はしない
layout.resetToDefault(); // current を標準値へ。保存はしない（残すなら save()）
onDestroy(() => layout.dispose());
```

- `current` / `saved` / `saving` / `loading` / `error` / `dirty` は reactive。`saved` は provider の
  `set` が成功した後だけ、**実際に送った snapshot** に変わる。保存中の編集は保存済みにならず `dirty` のまま。
- **並行保存の契約**: 送信は同時に 1 つだけ（直列）。送信中の `save()`・即時保存の `set()` は後続を 1 つだけ
  待たせ、待っている `save()` は全部その結果を共有する（合流）。待たせた分の snapshot は**送り始める時点**の
  `current`（最新）。失敗しても後続は送る（最新の値での再送になる）。`save()` は reject せず、失敗は
  `false` と `error`。`dirty` でなくても送る（`'invalid'` の保存値を明示保存で上書きできる）。
- `load()` は読み込み中の編集を上書きしない（保存値は `saved` に入る）。新しい `load()`・保存・`dispose()` で
  古い読み込みの結果は捨てる（`'stale'`）。古い応答の破棄は `createRequestOwner` で行う。
- 破損・未知の version は `parse` に任せる（`'invalid'` で `current` は `fallback()`、例外は外へ出さない）。
- **再送（`retry`、既定は無効。`retry: {}` で有効）**: 「一時的な失敗」だけ、同じ snapshot を間隔を延ばしながら送り直す（計 3 回・待ちは 500ms →
  1s、上限 5s）。無条件の書き込みの再送は古い snapshot の繰り返しなので、別のタブが後から保存した値を上書きしうる（`merge` を渡せば条件付きになる）。既定の「一時的」は `isNetworkError`（サーバーに届かない・タイムアウト）だけ。サーバーの 4xx/5xx、Tauri の
  失敗、`conflict` は送り直さない（Tauri は一時的かどうかを見分けられず、5xx は繰り返して無害とは限らない）。見分け方は
  `retry: { isTransient }` で差し替える（投げれば「一時的でない」）。送り始めたときのセッション（`provider.sessionGuard()`）が待ちの間に
  替われば、送らずに `unauthorized` で止める（別のアカウントの設定に書かない）。待っている間に `save()` が来たら、待ちを
  打ち切って最新の値をすぐ送る。
- **`merge`（競合の解決）**: `merge: (server, current) => T` を渡すと、書き込みが `ifRevision` つきになる（直近の `load()`・書き込みの
  revision を使う。読んでいなければ `"0"`＝「何も無いときだけ」なので、既にある値は黙って上書きされず、`merge` に渡る）。
  `conflict` になったら、今の保存値を `parse` して `merge(server, current)` を呼び（`current` は送信を始めた時点の編集。競合が続いても、前回の統合結果ではなく元の編集）、結果を返ってきた revision で書く
  （最大 `MAX_CONFLICT_ATTEMPTS` = 5 回）。壊れた値・消された値は `merge` せず snapshot をそのまま書く。保存後、保存中に編集していなければ
  `current` も統合後の値になる。`merge` は何度も呼ばれうるので純粋に保つ。投げれば保存は失敗（`error` にその例外）。
  応答だけが失われた書き込みの送り直しは `conflict`（保存値が送った値と同じ）になり、「保存された」と数える。
- **`onSettled`**: 送信が終わるたび（再送のあと・状態の更新のあと）に `{ ok, value, error, attempts }` で呼ぶ。rune の外
  （通知・ログ）へ結果を渡す口。`dispose()` 後は呼ばない。投げても握りつぶす。中から `save()` / `set()` しても、後続と重ならず待ち行列に入る。
- セッション: 待ち行列の後続は、受理したときのセッションに紐づく（替わっていれば送らず `unauthorized`）。保存の成功・`load()` の結果も、
  セッションが替わっていれば反映しない。
- 即時保存のテーマ設定など既存の画面は載せ替えていない。

## 切断を見分ける（`isNetworkError`・`createConnectionMonitor`）

LAN のブラウザ（`server` モード）でサーバーに届かないことを、フロントだけで判定する（#637。Tauri の
`invoke` は切れないので作らない。どのモードで作るかは呼び出し側が決める）。

- `isNetworkError(e)`: `fetch` の reject かタイムアウトなら true（`e.networkFailure` が `'network'` か
  `'timeout'`）。4xx/5xx（サーバーの応答）と、呼び出し側が自分で中断した要求は false。`ErrorBody` の
  kind は増やしていない（`{ kind: 'other' }` のまま）。
- HTTP のデータ要求は既定 20 秒（`timeoutMs`、本文の読み込みまで含む、`0` で無効）で打ち切る。SSE には効かない。

```ts
import {
	connectEvents,
	createConnectionMonitor,
	createHttpAuthProvider,
	createHttpDataProvider,
	createSseEventProvider,
	invalidateAll
} from '@banto/admin-core';

const connection = createConnectionMonitor();
const auth = createHttpAuthProvider({ onRequestResult: connection.reportRequest });
createHttpDataProvider({ getToken: auth.getToken, onRequestResult: connection.reportRequest });
connectEvents(createSseEventProvider({ getToken: auth.getToken }), { connection });

connection.status; // 'online' | 'reconnecting' | 'offline'（reactive）
connection.onRecovered(() => invalidateAll()); // 切断から戻ったとき 1 回
```

- 切断（`reconnecting`）: 開いていた SSE を失った、またはネットワーク失敗が 2 回続いた（`failureThreshold`）。
  `offline`: ブラウザの `offline` イベント（起動時の `navigator.onLine === false` も）。
- 復帰: サーバーの応答（状態コードは問わない）か SSE の再接続。`online` イベントだけでは戻らない。
  古い要求の結果（最後の反対向きの証拠より前に送った要求）は捨てる。判定は純関数
  `nextConnectionState`・`connectionStatusOf`。
- 自分では再接続もポーリングもしない（SSE の再接続・セッション確認のバックオフ・利用者の操作で戻る）。
- SSE の再接続は `connectEvents` が既に `invalidateAll()` するので、`onRecovered` で読み直すと二重になりうる。

## アプリ独自の SSE を読む（`createSseStream`）

`/api/events`（変更の知らせ）とは別に、アプリが自分で出す配信（現在値など。server 側は
`banto_server::sse` の `sse_response`、#935）を読む汎用の読み口（#936。
[設計書 §5](../../docs/design/sse-stream-design.md)）。つなぎ直し・401・token の消去と入れ替わりの規則は
`createSseEventProvider` と同じもの（`createSseEventProvider` はこの上に載っている）。

```ts
import { createSseStream, sessionStreamHooks } from '@banto/admin-core';

type Reading = { value: number; at: number }; // at = 作る側が入れた時刻（印）

const stop = createSseStream<Reading>({
	path: '/api/app/values', // token などの秘密を query に載せない
	getToken: auth.getToken,
	parse: (data, event) => (event === 'reading' ? (JSON.parse(data) as Reading) : null),
	onEvent: (reading) => show(reading),
	onSessionChange: () => clearShown(), // 前のセッションの値を消す
	onForbidden: () => clearShown(), // 見る権限が外れた値を消す
	forbiddenRetryDelayMs: 30_000,
	staleAfterMs: 15_000, // 作る側の周期の 3 倍ほど
	valueStamp: (reading) => reading.at,
	onStale: (stale) => markStale(stale),
	...sessionStreamHooks() // 401・消えた token をセッションの制御へ
});
// 画面を離れるとき: stop()
```

- **前のセッションの値を次のセッションに渡さない。** 応答・フレームを受け取るたび（1 回の読み取りに複数の値が
  あれば値ごと）に「止められていない・自分の試行・token が同じ」を照合し、違えば捨てる。遅れて届いた 401 は
  いまの token のものとして扱わない（`onUnauthorized` を呼ばない）。
- **`onSessionChange`**（401・token が消えた・別の token になった。変わるたびに 1 回、次のセッションの最初の
  `onEvent` より前）と **`onForbidden`**（同じ token のまま 403。断られた状態に入るたびに 1 回）では、
  呼ぶ側が**この配信から受けて表示・保持している値を消す**。読み口が止められるのは「これから届く値」だけで、
  もう画面に出ている値は消せない。権限つきの配信を `onForbidden` なしで読まない。権限が戻れば値は `onEvent` に届き直す。
- **`onStale`** は「通信が戻った」と「値が新しくなった」を分ける。`valueStamp` を渡すと、印が前（同じ `event` 名）と
  変わった値だけを新しい値と数えるので、作る側が止まったままつなぎ直して同じ値が送り直されても解けない。
  渡さないときの `onStale` は**受信が止まったこと**だけの指標（送り直しで解ける）。時計は切断・セッションの
  切り替え・403 でも止めない。作った後の最初の 1 件は比べる印が無いので新しいと数える。
- `parse` が `null` を返す・例外を投げた 1 件は捨てる（接続は保つ）。`event:` の名前は `parse` の第 2 引数
  （`createSseMessageParser` が `{ data, event? }` を返す。`createSseParser` の形は変わらない）。
- 文言は持たない（「配信が止まった」「権限が無い」の表示はアプリの Paraglide のキー）。`getSessionController` も
  `createConnectionMonitor` も知らない。`/api/events` を開かない画面では `sessionStreamHooks()` を**必ず**渡す
  （渡さないと失効に気づかない。`/api/events` と並べて渡してもよい: 同じ失効を 2 本が知らせると、先の確かめを
  中断して確かめ直すので、同時に走る確かめは 1 件・セッションの終わりは 1 回。確かめの要求そのものは配信の本数まで
  続けて出る）。切断の帯は `/api/events` の 1 本に任せ、アプリの配信からは既定では知らせない。
- `path` は `/` 1 つで始まり、`baseUrl + path` を URL として解決した先が `baseUrl`（空ならページ）の origin に
  留まるもの以外は `TypeError`（要求を 1 つも出さない。`Authorization` を別のホストへ送らない。タブ・改行を挟んで
  `//host` になる path もここで断る）。
- `parse`・`valueStamp`・`onEvent`・各フックの中で配信を止める・ログインし直す・ログアウトするのは構わない。
  読み口は呼ぶ側のコードから戻るたびに照合し直し、旧いセッションの分は値・印・鮮度の時計・`onUnauthorized` を
  それ以上進めずに、いまの token で開き直す。配信が終わった時点で token が変わっていれば、そこで `onSessionChange` を呼ぶ。

## トークンを web storage に置かない（`createHttpAuthProvider` の `storage: 'memory'`）

`createHttpAuthProvider` は、既定（`storage: 'web'`）ではトークンを `sessionStorage`（Remember me のときは
`localStorage`）の `storageKey`（既定 `banto.auth.token`）に置く。同じオリジンに複数のアプリを置く配信
（GitHub Pages のデモなど）では、アプリどうしでこのキーが重なる。`storage: 'memory'` を渡すと、トークンを
provider の中だけに持つ（#838）。

```ts
const auth = createHttpAuthProvider({ storage: 'memory' });
```

- `localStorage`・`sessionStorage` を読まず、書かない。`window` の `storage` イベントも購読しない。`storageKey` は使わない。
- トークンは再読み込みで消える（もう一度ログインする）。ほかのタブとは共有しない。同じ文書の中では、
  `credentialRevision()`・`onCredentialChanged`・書き込みの追い越しの防止は `'web'` と同じに働く。
- `login({ ..., remember: true })` はエラーにしないが、覚えない。サーバーへ送る本文も `remember: false` にする
  （再読み込みで手元から消えるトークンに、長い期限のセッションをサーバーへ残さない）。ログイン画面から
  「ログイン状態を保持」のチェックを外すのはアプリの側。
- 選べるのは `'web'` と `'memory'` だけ（保存先の実装は渡せない。ほかの値は例外）。
- 変わるのはトークンの置き場所だけ。同じオリジンのほかのキー（`createLocalUiSettings` の `banto.ui.*`、
  テーマ、一覧の表示状態など）はそのまま。`createLocalUiSettings` には `storage`（`Storage`）を渡せる。
- Tauri の provider（`createTauriAuthProvider`）には対の口が無い（web storage にトークンを持たないため）。

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
