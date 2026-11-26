# レシピ: アプリ独自の SSE（現在値などの配信）を足す

作成日: 2026-11-25（Issue #935・#936 S3。設計は [design/sse-stream-design.md](../design/sse-stream-design.md)、
server の部品は `banto_server::sse`（#943）、読み口は `@banto/admin-core` の `createSseStream`（#945））

対象読者: **利用側アプリの開発者・AI エージェント（トラックA）**。設備の現在値・状態のように、**値そのものを画面へ
流し続ける配信**を自分のアプリに足す手順。変更の合図（「読み直して」）だけなら `/api/events` で足りる
（[admin-core の README](../../packages/admin-core/README.md)）。値を運ぶ配信は、このレシピの形で足す。

この手順で出来るもの:

- **server**: 値を作る側が周期ごとに値を送り、ハンドラーが `SseContext` + `watch_frames` + `sse_response` でそれを配る。
  停止の知らせ・確かめ直し（失効したセッションを 15 秒ごとに閉じる）・keepalive・接続数は土台が持つ。自分で書かない。
- **画面**: `createSseStream` が読む。つなぎ直し・401・セッションの入れ替わり・止まった検出は読み口が持つ。
  画面が持つのは「値を消す」と「文言」だけ。

配信は **REST だけ**（`/api/events` と同じ。Tauri の画面は IPC で値を読む。conventions §1 の「両経路で同一の認可」は、
同じ値を返す Tauri コマンドを対にして守る。下の手順 7）。

## 手順

| #   | ステップ                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **値を作る側**を書く。周期ごとに `watch::Sender::send_replace` し、値に**作った印**（作った時刻）を入れる                                      |
| 2   | **配信のハンドラー**を書く: `SseContext` を受け、`watch_frames` の流れを `sse_response` に渡す。権限つきなら**層 + `require_permission` の組** |
| 3   | `api_router` に `merge` し、値を作る側を起動処理で動かす                                                                                       |
| 4   | **読み口を呼ぶ関数**を書く: `createSseStream` に `valueStamp`・`staleAfterMs`・`onSessionChange`・`onForbidden` を渡す                         |
| 5   | **画面**から呼び、値・古い・権限なしを出す（文言は Paraglide のキー）                                                                          |
| 6   | `/api/events` を開かない画面なら、401 の配線（`sessionStreamHooks()`）を**必ず**足す                                                           |
| 7   | `verify-architecture` の分類と、Tauri 側の対（現在値を返すコマンド）を足す                                                                     |
| 8   | テスト                                                                                                                                         |

## 1〜3. server（`apps/<アプリ>/core/src/rest/plant.rs`）

見本は 1 ファイルに収めている。このブロックは `crates/banto-server/tests/sse_recipe/plant.rs` と**同じ文字列**で、
そのまま `cargo test -p banto-server --test sse_recipe` が通る（ブロックを直したら、そのファイルも同じに直す。
食い違うと `the_recipe_shows_the_code_that_is_tested` が落ちる）。

```rust
// apps/<アプリ>/core/src/rest/plant.rs
use axum::response::Response;
use axum::routing::get;
use axum::{middleware, Extension, Router};
use banto_admin_services::audit::AuditLogService;
use banto_admin_services::permissions::PermissionKey;
use banto_server::routes::{require_permission, PermissionGuard};
use banto_server::{require_auth, sse_response, watch_frames, AuthState, SseContext, SseFrame};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

/// この配信を見る権限。層とハンドラーで同じ定数を使う（名前を 2 回書かない）。
pub const PLANT_VIEW: &str = "plant.view";

/// 権限の式。REST の層・ハンドラーも、Tauri コマンドの `require_permission` も、
/// マニフェストの `PERMISSION_PAIRS` も、この関数の呼び出し `plant_view()` をそのまま書く
/// （規則 8 は式の文字列を比べるだけで、関数の戻り値までは追わない）。
pub fn plant_view() -> PermissionKey {
    PermissionKey::parse(PLANT_VIEW).expect("a well-formed key")
}

/// 配信する値 1 件。`made_at` は作る側が入れる「作った印」（ミリ秒の時刻）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub made_at: u64,
    pub value: f64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 値を読む処理（アプリのもの。ここでは見本の代わりの固定値）。
async fn read_sensor() -> Option<f64> {
    Some(20.5)
}

/// 値を作る側。周期ごとに、値が同じでも `send_replace` する。
/// 読めなかった周期は送らない（止まったことを、新しい値が来ないことで見せる）。
/// チャネルの初期値は「値なし」（`None`）。最初の読み取りが成功するまで、
/// 作り物の値と今の時刻の印を配信しない。
pub fn spawn_producer(period: Duration) -> watch::Sender<Option<Reading>> {
    let (tx, _) = watch::channel(None);
    let sender = tx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(period);
        loop {
            tick.tick().await;
            if let Some(value) = read_sensor().await {
                sender.send_replace(Some(Reading {
                    made_at: now_ms(),
                    value,
                }));
            }
        }
    });
    tx
}

async fn plant_stream(
    context: SseContext,
    Extension(values): Extension<watch::Sender<Option<Reading>>>,
) -> Response {
    let frames = watch_frames(values.subscribe(), |reading| {
        // 値がまだ無い間（最初の読み取りの前）は送らない。
        SseFrame::json(reading.as_ref()?).ok()?.event("values").ok()
    });
    // 開いた後も権限を読み直す（外れたら次の確かめ直しで閉じる）。
    // この画面は /api/events を開かないので、接続 n 台に数える。
    sse_response(
        context.require_permission(plant_view()).counted_as_client(),
        frames,
    )
}

pub fn plant_router(
    values: watch::Sender<Option<Reading>>,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/plant/stream", get(plant_stream))
        .layer(Extension(values))
        // 開くときの拒否を監査（`denied`）に残すための層。開いた後は見ない。
        .layer(middleware::from_fn_with_state(
            PermissionGuard {
                auth: auth.clone(),
                permission: plant_view(),
                resource: "plant",
                audit,
            },
            require_permission,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
```

- **値を作る側（`spawn_producer`）は周期ごとに送る。** 値が前と同じでも `send_replace` する（`watch` は同じ値でも
  「変わった」と知らせる）。土台は送り直しをしない。作る側が止まれば、イベントも止まる。それを画面が「古い」と見分ける。
  読めなかった周期は送らない。チャネルの初期値は「値なし」（`None`）にし、最初の読み取りが成功するまで配信しない
  （作り物の値と今の時刻の印を、本物の新しい値として画面に出さない。読み取りが失敗し続けるなら、何も届かず stale になる）。
- **値に作った印を入れる。** `made_at`（作った時刻）のように、周期ごとに変わるもの。`watch_frames` は**つなぎ直すたびに
  最後に作られた値を 1 件出す**ので、作る側が止まっていても、画面を開き直すたびに古い値が「新しいイベント」として届く。
  それを画面が見分ける手がかりが印（下の「5. 古い値の見分け方」）。時刻はサーバーのものを使い、クライアントの時計とは比べない。
- **`SseContext` は `require_auth` の内側でしか取り出せない**（外では 500）。`require_auth` を掛け忘れたルートは、
  token を確かめないまま開く代わりに 500 で閉じたままになる。ハンドラーに `AuthState` は渡さない。
- **層 + `require_permission` は組で付ける。** 権限（`plant.view`）で守る配信は、
  - **層の `PermissionGuard`**: 開くときの拒否を `denied` の監査に残す。`verify-architecture` の規則 8 もこれを見る。
  - **ハンドラーの `context.require_permission(..)`**: **開いた後**も、確かめ直しのたび（15 秒ごと）に権限を読み直し、
    外れていたら配信を閉じる。層だけだと、権限を外しても開いている配信は続く（層が見るのは開く 1 回だけ）。
  - 権限の式は `plant_view()` 1 つを、層・ハンドラー・Tauri 側・マニフェストの全部で同じ文字列として書く。
  - 権限を持たない配信（誰でも見てよい値）なら、層もハンドラーの条件も要らない。
- **確かめられなければ閉じる。** `require_permission`（`reauthorize_with` も）を付けた配信は、確かめ直し（セッションと権限の読み取り）が
  失敗・時間切れのとき、1 回目で閉じる。保存先が答えない間に「許可」を残し続けない。つなぎ直しは `require_auth` が 500 を返し、
  保存先が戻れば開く。条件の無い配信（と `/api/events`）は、保存先の一時の不調では閉じない。
- **「20 秒」はサーバー側の上限で、画面の表示が消えるのは次の 403 を受け取ったとき。** 権限を外してから、サーバーが配信を閉じるまで
  最大 20 秒（確かめ直しの間隔 15 秒 + 時間切れ 5 秒）。画面の値が消えるのは、その後の**つなぎ直しが 403 で断られた**ときで、
  つなぎ直しは既定で 3 秒後。外してから表示が消えるまで、**通信が平常で、次の接続がすぐ 403 を返す場合の目安**として 23 秒ほど
  （外した直後に消えるわけではない）。通信断・応答待ちの間は、つなぎ直しも 403 も届かないので、**上限ではない**。
- **ルートの内側に別の条件（設備ごとなど）が要るときは `reauthorize_with(|session, permissions| ..)`**。同期の関数で、
  保存先を読まない（渡されるのは土台が読み直したセッションと権限）。

### 接続数（「LAN 共有中・接続 n 台」）

デスクトップのヘッダーの「接続 n 台」は、開いている画面（タブ）の数のつもりで `/api/events` の本数を数えている。アプリの配信を
無条件に足すと、`/api/events` と値の配信を両方開く画面が**1 つで 2 台**に数えられる。そこで**アプリの配信は既定で数えない**。
`/api/events` を開かない画面（監視画面など）の配信だけ、見本のように `counted_as_client()` を付けて 1 本だけ数える。
`/api/events` も開く画面の配信には付けない。

### 1 画面に配信を何本も開かない

`fetch` で読む SSE は、開いている間 HTTP の接続を 1 本占める。ブラウザーは HTTP/1.1 で同じ出どころへの同時の接続を
6 本ほどに制限する（一般に知られた値。banto では**未実測**）。`/api/events` に加えて値の種類ごとに配信を開くと、同じ PC で
タブを数枚開いただけで上限に届き、ふつうの要求まで待たされ得る。**配信は 1 画面 1 本にまとめ、種類は `event:` の名前で分ける。**

```rust
fn frames(&self) -> impl futures_util::Stream<Item = SseFrame> + Send + 'static {
    let values = watch_frames(self.values.subscribe(), |reading| {
        SseFrame::json(reading).ok()?.event("values").ok()
    });
    let alarms = broadcast_frames(self.alarms.subscribe(), |alarm| {
        SseFrame::text(alarm.clone()).event("alarm").ok()
    });
    futures_util::stream::select(values.boxed(), alarms.boxed())
}
```

読み口は `parse(data, event)` の第 2 引数で名前を受ける（見本の `event === 'values'`）。種類が増えたら `T` を和型にして、
`parse` が名前で作り分ける。この形は `crates/banto-server/tests/sse_stream.rs`（複数の名前を 1 本に混ぜて届ける試験）と同じ。

- **`watch<Option<Reading>>` を流用するときは、`None` を `null` で送らない。** `watch_frames` の `encode` が `None` を返した値は送られない
  （除外される）ので、`|reading| { let reading = reading.as_ref()?; … }` と書き、「値なし」の間は何も配信しない。`null` を `data:` に載せると、
  読み口の `parse` が「値なし」を値として扱う分岐を持つことになり、最初の読み取りの前に空の値が画面へ出る。
- **`onStale` は配信全体の指標。** どの `event:` の名前でも、最後に新しい値が届いてからの経過で決まる（`staleAfterMs`・`valueStamp` は上の「5.」）。
  種類ごとの鮮度（値は届くが、警報だけ長く来ない、など）は `onStale` では分からないので、種類ごとの最終受信の時刻や作った印を、アプリが種類ごとに持つ。

- **現在値は `watch_frames`。** `watch` は最新の値だけを持つので、遅い画面は途中の値を飛ばす（現在値の配信では望ましい）。
- **`broadcast_frames` は速報（欠けてもよい知らせ）だけに使う。** バッファを超えて遅れると、同じ接続のまま `Lagged` を飛ばして
  続く。接続は切れないので、**つなぎ直したときの読み直しでは抜けた分を回収できない**。
- **警報の履歴のような、欠けてはいけないものは `broadcast_frames` だけに頼らない。** 次のどちらかにする。
  - 永続の記録（DB など）を正とし、配信は「新しいものがある」合図にして、画面はカーソル（最後に見た id・時刻）から記録を取り直す。
  - 取りこぼしを検知したら、再同期の知らせ（専用の `event:`）を送る。画面はそれを受けて、記録から読み直す。

## 4〜5. 画面（`apps/<アプリ>/src/lib/banto/plantStream.ts` と画面）

読み口を呼ぶ関数。このブロックは `packages/admin-core/tests/fixtures/plantStream.ts` と同じ文字列で
（`'@banto/admin-core'` だけ試験では相対 path に置き換える）、`pnpm --filter @banto/admin-core test` が通る
（食い違うと `node --test scripts/permission-guards.test.mjs` が落ちる）。

```ts
// apps/<アプリ>/src/lib/banto/plantStream.ts
import { createSseStream, sessionStreamHooks } from '@banto/admin-core';

/** サーバーが配信する値 1 件（`madeAt` は作る側が入れた「作った印」）。 */
export interface Reading {
	madeAt: number;
	value: number;
}

/** 画面が持つ状態。`reading` は配信から受けた値だけで、消すときは `null` にする。 */
export interface PlantView {
	reading: Reading | null;
	/** 作る側が止まっている（値は古い）。 */
	stale: boolean;
	/** 見る権限が無い（文言は画面のキーで出す）。 */
	forbidden: boolean;
}

export function openPlantStream(
	getToken: () => string | null,
	onChange: (view: PlantView) => void,
	transport: { baseUrl?: string; fetchFn?: typeof fetch } = {}
): () => void {
	let view: PlantView = { reading: null, stale: false, forbidden: false };
	const set = (next: Partial<PlantView>) => {
		view = { ...view, ...next };
		onChange(view);
	};
	return createSseStream<Reading>({
		...transport,
		path: '/api/plant/stream',
		getToken,
		parse: (data, event) => (event === 'values' ? (JSON.parse(data) as Reading) : null),
		onEvent: (reading) => set({ reading, forbidden: false }),
		// 値を作った印。つなぎ直しで送り直された古い値では、stale を解かない。
		valueStamp: (reading) => reading.madeAt,
		staleAfterMs: 15_000, // 作る側の周期（5 秒）の 3 倍
		onStale: (stale) => set({ stale }),
		// 値を消すのは呼ぶ側の仕事。前のセッションの値も、見る権限の外れた値も残さない。
		onSessionChange: () => set({ reading: null, forbidden: false }),
		onForbidden: () => set({ reading: null, forbidden: true }),
		forbiddenRetryDelayMs: 30_000,
		// 401・消えた token をセッションの制御へ知らせる（/api/events を開かない画面では必須）。
		...sessionStreamHooks()
	});
}
```

画面（Svelte）から呼ぶ。`getToken` は、ほかの `*Admin.ts` と同じく認証 provider から取る。

```svelte
<script lang="ts">
	import { getAuthProvider, sessionGeneration } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { openPlantStream, type PlantView } from '#lib/banto/plantStream.js';

	const empty: PlantView = { reading: null, stale: false, forbidden: false };
	let view = $state<PlantView>(empty);

	// セッションが変わるたび（ログアウト・別の人のログイン）に、この効果が走り直る。
	// 読み口の onSessionChange だけに任せない（切断後の再試行を待つ間・応答待ちの間は呼ばれない）。
	$effect(() => {
		sessionGeneration(); // 読むだけ。値は使わず、変化を追う印にする。
		// 1 前の購読は下の戻り値（cleanup）で止まっている。先に表示と保持している値を消す。
		view = empty;
		const auth = getAuthProvider() as { getToken?: () => string | null };
		// 新しいセッションで購読し直す。戻り値は止める関数で、次の実行の前と画面を離れるときに呼ばれる。
		return openPlantStream(
			() => auth.getToken?.() ?? null,
			(next) => (view = next)
		);
	});
</script>

{#if view.forbidden}
	<p>{m.plant_forbidden()}</p>
{:else if view.reading}
	<p>{view.reading.value}</p>
	<p>{new Date(view.reading.madeAt).toLocaleTimeString()}</p>
	{#if view.stale}<p>{m.plant_stale()}</p>{/if}
{/if}
```

文言（`plant_forbidden`・`plant_stale`）は `messages/{ja,en}.json` の両方に足す（conventions §13。読み口は文言を持たない）。

### 5. 古い値の見分け方（`valueStamp` と stale）

通信が戻ったことと、値が新しくなったことは別。`watch_frames` はつなぎ直すたびに最後の値を出すので、「値が届いた」だけで
「止まった」を解くと、作る側が止まったままでも、つなぎ直しのたびに「復旧」に見える。

- **`valueStamp` を渡す**（見本は `madeAt`）。印が前と変わった値だけを「新しい値」と数え、時計（`staleAfterMs`）を掛け直す。
  送り直された同じ値は画面へは渡す（害は無い）が、**時計は掛け直さず、stale も解かない**。印は `event` の名前ごとに覚える。
- **`staleAfterMs` は作る側の周期の 3 倍ほど**（見本は 5 秒の周期に 15 秒）。切れると `onStale(true)`、新しい値で `onStale(false)`。
- `valueStamp` を渡さないと、`onStale` は**受信が止まったことだけ**の指標になる（つなぎ直しの送り直しで解ける）。
  印を持たない知らせ（`broadcast_frames` のように、開いた直後の送り直しが無いもの）なら渡さなくてよい。
- **残る限界。** 画面を開いて最初の 1 件は、比べる前の印が無いので新しいと数える。作る側が止まっているときに画面を開くと、
  `staleAfterMs` が過ぎるまで古い値が現在値に見える。困る値（操作の判断に使う値）は、**作った時刻を値のそばに表示する**
  （見本のとおり）か、サーバーの時刻と比べる。読み口はクライアントの時計と比べない（PC の時計のずれを判定に入れないため）。
- 「配信が止まった」は**切断の帯には出さない**。帯は「サーバーに届かない」の表示で、止まったのは値を作る側。値のそばに出す。

### セッションと権限: 値を消す

`onSessionChange`（401・token が消えた・別の token でログインし直した）と `onForbidden`（同じ token のまま 403）は、
**呼ぶ側が、その配信から受けて表示・保持している値を消す**合図。読み口が止められるのは「これから届く値」だけで、
もう画面に出ている値は消せない。

- 前のセッションの値を、次にログインした人に見せない（`onSessionChange`）。
- 見る権限の外れた値を残さない（`onForbidden`）。stale は鮮度の知らせで、閲覧の権限の代わりにはならない（stale の印が付いても値は読める）。
- 権限が戻れば、つなぎ直しが開き、**最初の値が `onEvent` に届き直す**。見本は `onEvent` で `forbidden: false` にして出し直す。
- 403 の後のつなぎ直しは `forbiddenRetryDelayMs`（見本は 30 秒）。既定は `reconnectDelayMs`（3 秒）と同じで、
  そのままだと、権限の無い画面が 3 秒ごとに `denied` を監査へ足し続ける。30 秒ほどを勧める。
- **権限つきの配信を `onForbidden` なしで読まない。** 値が残る。
- stale の時計は、403 でもセッションの入れ替わりでも変えない（値の古さは作る側のもの）。

**`onSessionChange` だけに任せない。画面の側でもセッションの変化を見る。** 読み口がトークンの変化に気づくのは、配信が
つながっている間の周期（`tokenWaitDelayMs`）だけ。切断後の再試行を待つ間や、応答待ちの接続中は、呼ばれるまで前のユーザーの値が
画面に残る。同じ画面を新しいユーザーが引き継ぐアプリでは、見本のように `sessionGeneration()`（admin-core。セッションが変わると
`generation` が進む。リアクティブ）を `$effect` で読み、変わったら**先に表示と保持している値を消し**、前の購読を止めて
（`$effect` の戻り値）、新しく購読し直す。

- 切断の帯や stale の表示は、**権限の確認の代わりにならない**。帯は「サーバーに届かない」、stale は「作る側が止まった」の表示で、
  どちらが出ていても、前の値を読む権限があるかは何も言っていない。値を出す・消すのは、セッションと `onForbidden` で決める。

### 6. 401 の配線

`/api/events` を開かない画面（アプリの配信だけを読む画面）は、`...sessionStreamHooks()` を**必ず**渡す。渡さないと、
失効したセッションにセッションの制御が気づかない。`/api/events` と並べて渡してもよい（同時に走る確かめは 1 件、
セッションの終わりは 1 回）。切断の帯は `/api/events` の 1 本に任せ、アプリの配信からは既定では知らせない。

## 7. verify-architecture と Tauri 側の対

`PermissionGuard` の層を付けたルートは、`scripts/verify-architecture.mjs` の規則 8 が**両経路の対**を求める。
配信は REST だけなので、**同じ値を返す Tauri コマンド**（例 `plant_current`。`require_permission(state, &perm, ..)` を同じ権限で呼ぶ）を作り、次を足す
（[add-permission.md](add-permission.md) の手順 4、conventions §1）:

- `rest/mod.rs` の Route table（doc）に `GET /api/plant/stream` の行。
- `verify-architecture.mjs` の `REST_READ` に `'GET /api/plant/stream'`、`TAURI_READ` に `plant_current`、
  `PERMISSION_PAIRS` に `{ tauri: 'plant_current', rest: 'GET /api/plant/stream', permission: 'plant_view()' }`。
  検査は式の**文字列**（空白・先頭の `&`・末尾の `.clone()` を除いた形）を比べるだけで、関数の戻り値までは追わない。
  そのため REST の層は `permission: plant_view()`、Tauri は `require_permission(&state, &plant_view(), "plant")`、
  マニフェストは `'plant_view()'` と、**同じ共有の式（見本の `pub fn plant_view()`）**を 3 か所に書く。
  `PLANT_VIEW`（定数）と `plant_view()` を混ぜると、同じ権限でも規則 8 が食い違いとして落とす。
  この組み合わせが検査を通ることは `scripts/permission-guards.test.mjs` が固定している。

また規則 8 は、**権限の層の内側で `sse_response` を呼ぶハンドラーが、`require_permission`（または `reauthorize_with`）を
呼んでいない**ものを落とす（開いた後に権限が外れても配信が続く付け忘れ。同じファイルにあるハンドラーだけを見る）。

## 8. テスト

- **server**: `crates/banto-server/tests/sse_recipe.rs` が見本の形（権限の無い呼び出しは 403 + `denied` の監査、持つ呼び出しは
  周期ごとに新しい印の値を受ける）の写しを動かしている。権限だけを外して配信が閉じ、つなぎ直しが 403 になること・`stop()` が
  すぐ戻ること・保存先が答えないときに閉じることは `crates/banto-server/tests/sse_stream.rs`（土台の側の試験）が見ている。
  アプリの試験では、自分の作る側（値と印）と、層 + `require_permission` の組を見る。
- **画面**: 読み口の試験の形は `packages/admin-core/tests/sseRecipe.test.ts`。**値あり → 403 → 値が見えない → 権限が戻って再表示**、
  送り直された古い値で stale が解けない、新しいログインで前の値が出ない、を確かめている。画面の試験でも同じ流れを書く。

```bash
cargo test -p banto-server --test sse_recipe
pnpm --filter @banto/admin-core test
pnpm verify:architecture
```

## やってはいけないこと

- 値を作る側を持たずに、土台に値を送り直させる（作る側が止まったことが隠れる。土台は送り直さない）。
- 層の `PermissionGuard` だけで権限を守る（開いた後に外しても続く）。`require_permission` の無い、権限つきの配信。
- `onForbidden` / `onSessionChange` で値を消さない。
- 値の種類ごとに配信を何本も開く（1 画面 1 本、名前で分ける）。
- token などの秘密を `path` の query に載せる（`Authorization` ヘッダーで送られる。読み口は別の origin への `path` も断る）。
- `/api/events` を開かない画面で、`sessionStreamHooks()` を渡さない。
