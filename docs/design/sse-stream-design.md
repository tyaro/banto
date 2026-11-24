# アプリ独自の SSE の配信と読み口 設計書（草案） — Issue #935・#936

作成日: 2026-11-25
状態: **草案（オーナーの判断待ち。§10 の 1〜10）。実装はまだ無い。承認の後に S1 → S2 → S3 の順で別 PR にする**
トラック: 保守者向け（トラックA）
関連: Issue #935（server の配信の部品）、Issue #936（admin-core の読み口）、
#231 / [ADR-0014](../adr/0014-account-bound-session-revocation.md)（開いた配信の確かめ直し）、#239（`AuthState::revalidate` の公開）、
#241・#591（401・token の入れ替わり）、#283（停止の知らせ）、#289（つなぎ直しの後の読み直し）、#558（接続 n 台）、#637（切断の帯）、
conventions §3 / §4 / §5 / §6 / §12 / §13

この文書の `path` と型の名前は、2026-11-25 の main（`dc73f4c0`）で開いて確かめた。
**新しく足す型・関数・ファイルの名前は見込み**で、各 PR で決める（決めた形はこの文書へ書き戻す）。

## 1. 用語

- **配信**: 1 本の開いたままの SSE の応答（`GET`、`text/event-stream`）。
- **アプリの配信**: 派生アプリが `/api/events` とは別に作る配信（周期で変わる現在値、設定の反映の知らせなど）。
- **確かめ直し**: 開いた配信が、自分の token のセッションを一定間隔で確かめること（`AuthState::revalidate`）。
- **土台**: 確かめ直し・停止・接続数・keepalive の規則を 1 か所に持ち、渡された値の流れを SSE の応答にする関数（#935 の案 2）。
- **読み口**: `fetch` で配信を読み、つなぎ直し・401・token の入れ替わりを扱うフロントの関数（#936 の `createSseStream`）。
- **配信が止まった（stale）**: 接続は切れていないが、最後のイベントから決めた時間が過ぎた状態。切断（#637）とは別。

## 2. 背景と目的

### 2.1 いま（`dc73f4c0`）

server（`crates/banto-server`）:

- `events.rs` の `event_stream` が規則を全部持つ。停止（`ShutdownSignal`）→ 確かめ直しの期限 → イベントの順の `biased` な `select!`、
  `REVALIDATE_INTERVAL`（15 秒。keepalive と同じ）、`REVALIDATE_TIMEOUT`（5 秒）、`Ok(None)` でだけ閉じる、
  次の期限は確かめ**終わり**から（`Schedule::rearm`）。
- `ShutdownSignal`・`SseConnections`・`SseConnectionGuard`（`server.rs`）と、要求から token を取る `auth::routes::bearer_token` は `pub(crate)`。
  `BoundServer::serve` が前の 2 つを全要求の `Extension` に入れる。
- 公開されているのは `sse_route`・`ServerEvent`・`AuthState::revalidate`（#239）・`routes::bearer_token`（`HeaderMap` 版）・
  `RunningServer::sse_connections()`・`events::REVALIDATE_INTERVAL` / `REVALIDATE_TIMEOUT`。
- `RunningServer::stop` は `STOP_TIMEOUT`（5 秒）まで graceful shutdown を待ち、過ぎたらサーバーのタスクを abort する。
  停止の知らせを見ない配信が 1 本でも開いていると、毎回この 5 秒を待つ。

admin-core（`packages/admin-core`）:

- `createSseEventProvider`（`src/events.ts`）は `/api/events` と `AppEvent` に固定。規則は doc コメントのとおり:
  401 → その token を使うのをやめて `onUnauthorized` を 1 回、使っていた token が消えた → `onTokenCleared` を 1 回、
  ほかの失敗・配信の終わり → `reconnectDelayMs` の後につなぎ直す、開いている間に別の token になった → すぐ開き直す（#591）、
  同じセッションのつなぎ直し → `onReconnected`（#289）、開いた配信を失った → `onDisconnected`（#637）。
- `createSseParser`（`src/sse-parser.ts`）は `data:` だけを返し、`event:` / `id:` / `retry:` は捨てる。公開済み（`index.ts`）。

### 2.2 目的（両 Issue の完了の条件）

1. 派生アプリが、`events.rs` の仕組みを写さずに、自分の値の SSE を同じ規則（確かめ直し・停止・接続数）で出せる（#935）。
2. `RunningServer::stop` で、アプリの配信も `STOP_TIMEOUT` を待たずに閉じる（#935）。
3. 派生アプリが、独自の SSE を `createSseParser` から組み立てずに読める（#936）。
4. 既存の `createSseEventProvider` の振る舞い（試験）は変わらない（#936）。

### 2.3 やらないこと

- WebSocket・双方向の通信。`EventSource`（`Authorization` と `X-Banto-Client` を付けられない）。
- 切れていた間のイベントの送り直し（`id:` / `Last-Event-ID`）。つなぎ直しの後は読み直す（#289 と同じ）。
- Tauri の webview への橋渡し（`banto://event` に当たるもの）。アプリの配信は HTTP の画面のためのもの。
- admin-template に見本の配信を足すこと（[template-scope](../template-scope.md)）。見本はレシピと試験に置く。
- `/api/events` の線の上の形（`event:` なし、`data:` に `ServerEvent` の JSON）を変えること。

## 3. conventions との関係

本文を読んで、この設計が触れるものだけを挙げる。

| 節 | 触れ方 |
| --- | --- |
| §3 依存を足さない | **足さない**。`tokio-stream` は入れず、`watch` / `broadcast` から流れを作るのは、既にある `async-stream`・`futures-util` で書く。フロントも依存なし |
| §4・§5 逆依存・アプリ固有の import | `createSseStream` は admin-core の中で閉じ、アプリにもオプションのパッケージにも依存しない。セッションの制御（`getSessionController`）も読まない（配線は呼ぶ側。§5.4） |
| §6 セッションは要求ごとに照合（#204・ADR-0014） | 開く瞬間は `require_auth`、開いた後は土台の確かめ直し。**土台は `require_auth` の内側でしか使えない形にする**（§4.3 の `SseContext`）。保存先が答えられないときの扱いは今の `event_stream` と同じ（開く要求は `require_auth` が 500 で失敗させ、開いた後は閉じずに次の期限で確かめる。#230） |
| §6 grant | grant のセッション・`DisabledNoRevocation` は `revalidate` が保存先を読まないので、土台の上でも今と同じ（token が消えたときだけ閉じる）。土台は identity を受け取らない・作らない |
| §6 CSRF（`X-Banto-Client`） | アプリの配信も `/api` の層の内側に置く。読み口は今と同じヘッダーを必ず付ける。**token を URL に載せる口は作らない** |
| §1 REST と Tauri の対称 | 対象は mutating な操作。配信は読むだけなので当たらない（§2.3 のとおり Tauri への橋は作らない） |
| §12 doc コメント | 新しい公開の項目は、この設計書と ADR-0014 を参照する |
| §13 文言はキー経由 | admin-core は文言を持たない。「配信が止まった」の表示はアプリの層が Paraglide のキーで出す（読み口は真偽だけを知らせる） |

公開 API は**足すだけ**（既存のシグネチャは変えない）なので minor の見込み。`tests/public_api.rs` に固定を足す（§6）。

## 4. server 側（#935）

### 4.1 案の比較

|  | 案 1: 部品の公開 | 案 2: 配信の土台 |
| --- | --- | --- |
| 公開するもの | `ShutdownSignal::triggered()`・`SseConnections::open()`・`SseConnectionGuard` | 要求から取る文脈（`SseContext`）、1 件のイベント（`SseFrame`）、応答を作る関数（`sse_response`）、`watch` / `broadcast` からの変換 |
| 確かめ直しの規則 | **アプリごとに書き写す**（`select!` の順、`Ok(None)` だけで閉じる、時間切れ、`rearm`）。完了の条件 1 を満たさない | 1 か所（§4.4） |
| 停止 | アプリが `select!` に足し忘れると、また 5 秒待つ | 土台が必ず見る |
| 接続数 | guard を配信の状態に持たせ忘れると数がずれる。数える・数えないもアプリ任せ | 土台が持つ |
| 自由度 | 高い（SSE 以外の長い応答にも使える） | SSE に限る |
| 公開面の重さ | 型 3 つ。ただし `Extension` で届く、という内部の作りが契約になる | 型 3 つ + 関数 3 つ。内部の作りは隠れる |

**推奨: 案 2 だけを公開する。** 完了の条件 1（「仕組みを写さずに」）を満たすのは案 2 だけで、
案 1 を併せて出すと「土台を使わずに自分で組む」道が残り、規則がまた分かれる。
SSE でない長い応答（長いダウンロードなど）が停止を待たせる件は今回の要望に無いので、出てきたときに `ShutdownSignal` だけの公開を考える（§10 の 1）。

### 4.2 置き場所

新しいモジュール `crates/banto-server/src/sse.rs`（`pub mod sse`）。`events.rs` は「`/api/events` のルートと `ServerEvent`」だけに痩せる。

### 4.3 公開 API の案（Rust）

```rust
// banto_server::sse（lib.rs から再輸出: SseContext, SseFrame, InvalidSseEventName,
// sse_response, watch_frames, broadcast_frames）

/// 配信 1 本ぶんの、要求から取る文脈（token・停止の知らせ・接続数）。中身は非公開。
/// `require_auth` の内側でだけ取り出せる: `require_auth` が要求に入れる
/// `AuthenticatedSession` が無ければ 500、`Authorization: Bearer` が無ければ 401。
pub struct SseContext { /* 非公開 */ }

impl<S: Send + Sync> FromRequestParts<S> for SseContext {
    type Rejection = Response;
    /* … */
}

impl SseContext {
    /// この配信を「接続 n 台」（`RunningServer::sse_connections`、#558）に数える。
    /// 既定は数えない（§4.6）。
    pub fn counted_as_client(self) -> Self;
}

/// 送るイベント 1 件。`event:` の名前（任意）と `data:` の本文。
#[derive(Debug, Clone, PartialEq)]
pub struct SseFrame { /* 非公開 */ }

impl SseFrame {
    /// `data:` に JSON を載せる。
    pub fn json<T: Serialize + ?Sized>(value: &T) -> Result<Self, serde_json::Error>;
    /// `data:` に文字列をそのまま載せる（改行は SSE の決まりどおり複数の `data:` 行になる）。
    pub fn text(data: impl Into<String>) -> Self;
    /// `event:` の名前を付ける。空・改行（CR / LF）を含む名前は `Err`
    /// （`SecurityHeaders::extra_connect_src` の `InvalidCspSource` と同じ流儀）。
    pub fn event(self, name: impl Into<String>) -> Result<Self, InvalidSseEventName>;
}

/// `frames` を、`/api/events` と同じ規則の SSE の応答にする（規則は §4.4）。
/// `auth` は、このルートの `require_auth` に渡したものと同じ `AuthState`。
/// `frames` が終わると配信も終わる（クライアントはつなぎ直す）。
pub fn sse_response<S>(context: SseContext, auth: &AuthState, frames: S) -> Response
where
    S: Stream<Item = SseFrame> + Send + 'static;

/// `watch` の値の流れ。**開いた直後にいまの値を 1 回**出し、その後は `send` のたびに出す
/// （値が同じでも出す。§4.5）。`encode` が `None` を返した値は送らない。送り手が消えたら終わる。
pub fn watch_frames<T, F>(rx: watch::Receiver<T>, encode: F) -> impl Stream<Item = SseFrame> + Send
where
    T: Send + Sync + 'static,
    F: FnMut(&T) -> Option<SseFrame> + Send + 'static;

/// `broadcast` のイベントの流れ。開いた後のものだけ（過去は送らない）。
/// 遅れて取りこぼした分（`Lagged`）は飛ばして続け、送り手が消えたら終わる（今の `/api/events` と同じ）。
pub fn broadcast_frames<T, F>(rx: broadcast::Receiver<T>, encode: F) -> impl Stream<Item = SseFrame> + Send
where
    T: Clone + Send + 'static,
    F: FnMut(&T) -> Option<SseFrame> + Send + 'static;
```

アプリの側（見本。レシピに載せる形）:

```rust
async fn plant_stream(context: SseContext, State(app): State<AppState>) -> Response {
    let frames = watch_frames(app.values.subscribe(), |values| {
        SseFrame::json(values).ok()?.event("values").ok()
    });
    sse_response(context, &app.auth, frames)
}

Router::new()
    .route("/api/plant/stream", get(plant_stream))
    .layer(/* アプリの追加の確かめ（PermissionGuard など） */)
    .layer(middleware::from_fn_with_state(auth, require_auth))
```

決めたこと（理由つき）:

- **入り口は `Stream<Item = SseFrame>` の 1 つ**にし、`watch` / `broadcast` は変換の関数で合わせる。
  1 本の配信に複数の出どころを混ぜる（§4.7）のは、アプリが `futures_util::stream::select` で流れを合わせればよい。
- **ルートごと作る関数（`sse_route` の汎用版）にはしない。** Issue のとおり、アプリは `require_auth` の内側に自分の確かめを重ねたいので、
  ハンドラーの中で呼ぶ形にする。その代わり、`require_auth` を掛け忘れたルートでは `SseContext` が取り出せず 500 になる
  （掛け忘れたまま、確かめていない token で最初の確かめ直しまで配信が開く、を防ぐ。fail closed）。
- **`auth` を渡し間違えても安全側に倒れる。** 別の `AuthState` を渡すと、その token は知られていないので最初の確かめ直しが
  `Ok(None)` になり、15 秒ほどで閉じる。
- **間隔と時間切れは設定にしない**（`REVALIDATE_INTERVAL`・`REVALIDATE_TIMEOUT` の定数のまま）。配信ごとに変えられると
  「失効は 1 間隔のうちに届く」（ADR-0014）が配信によって崩れる。定数は `sse.rs` へ移し、`events::` の今の path からも再輸出する。
- **axum の `Event` は公開面に出さない**（`SseFrame` で包む）。`Event::event` は改行で panic するので、名前の検査を `SseFrame::event` に置く。

### 4.4 規則の一本化と `events.rs` の載せ替え

規則は `sse.rs` の非公開の 1 つの関数（今の `event_stream` のループを、`broadcast::Receiver<ServerEvent>` の代わりに
`Stream<Item = SseFrame>` を取る形にしたもの）に置く。`sse_response` も `/api/events` も、これだけを通る。

| 規則 | 一本化する場所 | 今との違い |
| --- | --- | --- |
| 確かめ直しの間隔（15 秒）と時間切れ（5 秒） | `sse.rs` の定数 | なし（移すだけ） |
| `Ok(None)` で閉じる／`Err`・時間切れでは閉じない | ループ | なし |
| 次の期限は確かめ終わりから（`rearm`） | `Schedule`（`sse.rs` へ移す。`pub(crate)`） | なし |
| 順番: 停止 → 期限 → イベント（`biased`） | ループ | なし |
| 停止の知らせで閉じる | ループ（`SseContext` が `Extension` から取る。無ければ「知らせは来ない」） | なし |
| 接続数 | `SseContext` が guard を作り、配信の状態が持つ（どう終わっても減る） | アプリの配信は既定で数えない（§4.6） |
| keepalive（15 秒のコメント） | `sse_response` | なし |
| 流れが終わったら閉じる | ループ | `broadcast` の `Closed`・`Lagged` の扱いは `broadcast_frames` へ移る |

**`events.rs` は土台の上に載せ替える**（推奨。§10 の 2）。`sse_handler` は `SseContext`（数える）を取り、
`broadcast_frames(tx.subscribe(), |event| SseFrame::json(event).ok())` を土台へ渡すだけになる。載せ替えないと、
規則が `events.rs` と `sse.rs` の 2 か所に残り、片方だけ直す事故が起こる。

載せ替えで変えないこと（S1 の完了の条件）:

- 線の上の形: `event:` なし、`data: {JSON}`。keepalive のコメントも同じ。
- **`events.rs` と `server.rs` の既存の試験は、本文を変えずに全部通る**（試験の継ぎ目の `sse_route_with`・`Schedule::Manual`・
  `manual_ticks` は名前と意味を保つ。`Schedule` を `sse.rs` へ移すための `use` の行だけは変わってよい）。
- `sse_route`・`ServerEvent`・`RunningServer::sse_connections()` のシグネチャ。

### 4.5 「同じ値の送り直し」（任意の項目）

Issue の案は「値が変わらなくても、土台が一定間隔でいまの値を送り直す」。**土台には入れないことを推奨する**（§10 の 3）。

- 土台が送り直すと、届くのは「**配信のハンドラーが生きている**」ことで、「**値を作る側が生きている**」ことではない。
  値を作るタスク（周期の読み取りなど）が止まっても、古い値が新しいイベントとして届き続け、画面の「配信が止まった」の判定（§5.5）が
  効かなくなる。これは、見分けたい当の状況を隠す。
- 代わりに、**作る側が周期ごとに `watch` へ送る**（`send_replace`。値が同じでもよい）。`watch` は値が同じでも送るたびに
  「変わった」と知らせるので、`watch_frames` はそのまま画面へ届ける。作る側が止まれば、イベントも止まる。
  これなら土台に時計を 1 つも足さずに済む。レシピに「値に作った時刻を入れる」「周期ごとに送る」と書く。
- keepalive のコメントは読み口がイベントとして数えない（パーサーが捨てる）ので、止まったことの判定を邪魔しない。

### 4.6 接続数（#558）

`RunningServer::sse_connections()` は、デスクトップのヘッダーの「LAN 共有中・接続 n 台」に使われている（`src-tauri/src/lib.rs`）。
今は `/api/events` の本数 ≒ 開いている画面（タブ）の数。アプリの配信を同じ数に無条件で足すと、
`/api/events` とアプリの配信を両方開く画面が **1 つで 2 台**に数えられる。

**推奨**（§10 の 4）: 数は 1 つのまま、**アプリの配信は既定で数えず、`SseContext::counted_as_client()` で数える**。
`/api/events` を開かない画面（アプリの配信だけを読む監視画面など）を持つアプリが、画面ごとに 1 本だけ数える。
`/api/events` は今までどおり必ず数える。別案は「全部数える」（Issue の文字どおり。台数が膨らむ）、
「種類ごとに別の数を持つ」（`sse_connections()` はそのまま、アプリの配信の本数を別の口で返す。使い道が出てから）。

### 4.7 1 画面に配信を何本も開かない（気づき）

`fetch` で読む SSE は、開いている間 HTTP の接続を 1 本占める。ブラウザーは HTTP/1.1 で同じ出どころへの同時の接続を
6 本ほどに制限する（一般に知られた値。この設計では未実測）。`/api/events` に加えてアプリの配信を画面ごとに 1 本開くと、
同じ PC で 3 タブ開いた時点で上限に届き、ふつうの要求まで待たされる。配信が増える見込み（#935 の補足）なので、
**アプリの配信は 1 画面 1 本にまとめ、種類は `event:` の名前で分ける**ことをレシピに書く（`SseFrame::event` と、
読み口の `parse(data, event)` はそのためのもの）。S1 の統合試験で、複数の名前を 1 本に混ぜる形を確かめる。

## 5. admin-core 側（#936）

### 5.1 パーサーに `event:` の名前を足す（後方互換）

`createSseParser`（`push(chunk): string[]`）は公開済みで、下流が使っている。**形を変えず、隣に新しいものを足す。**

```ts
// src/sse-parser.ts
export interface SseMessage {
	/** `data:` の本文（複数行は `\n` でつなぐ。今と同じ）。 */
	data: string;
	/** `event:` の名前。行が無い・空のときは `undefined`。 */
	event?: string;
}
export interface SseMessageParser {
	push(chunk: string): SseMessage[];
}
export function createSseMessageParser(): SseMessageParser;
```

- `createSseParser` は `createSseMessageParser` の上に載せ、`data` だけを返す（今の 10 本の試験は本文を変えずに通る）。
- `data:` の無いイベント（`event:` だけ、コメントだけ）は今と同じく出さない。`event:` が複数あれば最後のもの（SSE の決まり）。
  `id:` / `retry:` は引き続き捨てる（§2.3）。
- 別案の「`SseParser` にメソッドを足す」は、公開済みの interface を広げるので採らない。

### 5.2 `createSseStream<T>` のシグネチャ

```ts
// src/sse-stream.ts（index.ts から輸出）
export interface SseStreamOptions<T> {
	/** `baseUrl` の後ろに付ける path（`/` で始まる）。token などの秘密を query に載せない。 */
	path: string;
	baseUrl?: string;
	fetchFn?: typeof fetch;
	getToken: () => string | null;
	/** 1 件を値にする。`null` を返す・例外を投げると、その 1 件は捨てる（接続は保つ）。 */
	parse: (data: string, event: string | undefined) => T | null;
	onEvent: (value: T) => void;
	/** 配信が開いた（true）・開いていた配信が終わった（false）。理由を問わない。 */
	onConnection?: (connected: boolean) => void;
	/** 以下の 4 つは `EventSubscriptionHooks` と同じ意味・同じ回数。 */
	onUnauthorized?: () => void;
	onTokenCleared?: () => void;
	onReconnected?: () => void;
	onDisconnected?: () => void;
	/** 渡すと、最後のイベントからこの時間が過ぎたときに `onStale(true)`、次のイベントで `onStale(false)`。 */
	staleAfterMs?: number;
	onStale?: (stale: boolean) => void;
	reconnectDelayMs?: number; // 既定 3000
	tokenWaitDelayMs?: number; // 既定 500
}
/** 呼んだ時点で読み始める。戻り値は止める関数（今の `subscribe` の戻り値と同じ）。 */
export function createSseStream<T>(options: SseStreamOptions<T>): () => void;
```

- 401・token の入れ替わり・token が消えたときの規則は、今の `createSseEventProvider` の doc コメントの規則を**そのまま移す**
  （#241・#591・#289・#637。書き直さず、関数の中身を動かす）。
- Issue の案にある `onConnection` に加えて、既存の 4 つのフックをそのまま持つ。既存の provider を上に載せるのに要る（§5.3）うえ、
  `onDisconnected` / `onReconnected` は「同じセッションの間だけ」という細かい条件を持っていて、`onConnection` からは作れない。
- 403（アプリの追加の確かめで断られた）は、今の「401 以外はつなぎ直す」のまま。権限は要求ごとに読み直されるので、付けば次のつなぎ直しで開く。
  状態コードを知らせる口は足さない（§10 の 8）。

### 5.3 既存の provider を上に載せる

```ts
export function createSseEventProvider(options: SseEventProviderOptions): EventProvider {
	return {
		subscribe: (handler, hooks) =>
			createSseStream<AppEvent>({
				...options, // baseUrl・getToken・fetchFn・reconnectDelayMs・tokenWaitDelayMs
				path: '/api/events',
				parse: (data) => {
					const parsed: unknown = JSON.parse(data);
					return isAppEvent(parsed) ? parsed : null;
				},
				onEvent: handler,
				...hooks
			})
	};
}
```

振る舞いが変わらないことの担保（S2 の完了の条件）:

- **`packages/admin-core/tests/` の既存のファイルを 1 行も変えずに全部通る**（`events.test.ts` 17 本・`eventsResync.test.ts`・
  `sse-parser.test.ts`・`connectionMonitor.test.ts`・`sessionEndIntegration.test.ts`・`sessionEndUnheard.test.ts`）。
  PR で `git diff --stat main -- packages/admin-core/tests` に既存のファイルが出ないことを確かめる。
- **時計の数と順番を変えない。** 既存の試験は偽の時計で進めるので、つなぎ直しの `setTimeout`・token の見張りの `setInterval`
  （`tokenWaitDelayMs`）は今の形のまま移す。`staleAfterMs` を渡さないときは時計を 1 つも足さない。`onConnection` を渡さないときは何も呼ばない。
- `/api/events` は `event:` を付けないが、仮に付いていても今は無視しているので、provider の `parse` は名前を見ない（今と同じ結果）。
- `SseEventProviderOptions`・`EventSubscriptionHooks`・`EventProvider` の型は変えない。

### 5.4 セッションの制御・切断の帯（#637）との関係

- `createSseStream` は `getSessionController` も `createConnectionMonitor` も知らない（§4・§5 の規約。試験もしやすい）。配線は呼ぶ側。
- **401・消えた token**: `/api/events` の `connectEvents` が既に `signal('unauthorized')` / `signal('credentialCleared')` を出す。
  アプリの配信も同じ 2 行を渡してよい（2 本から重ねて出たときに確かめが増えないことは、S2 の試験で確かめる）。`/api/events` を開かない画面では**必ず渡す**。
  毎回書かずに済むよう、`{ onUnauthorized, onTokenCleared }` を返す小さな関数（`sessionStreamHooks()`）を足すかは §10 の 7。
- **切断の帯**: 帯は `/api/events` の `onDisconnected` / `onReconnected` から出る。アプリの配信は**既定では帯へ知らせない**。
  `ConnectionState.streamLost` は 1 つの真偽なので、2 本の配信が別々に知らせると、片方が戻っただけで「戻った」になる。
  サーバーに届かなくなれば 2 本とも切れるので、`/api/events` の 1 本で足りる。`/api/events` を開かない画面だけ、
  アプリの配信の 2 つのフックを `StreamConnectionListener` へつなぐ（形は同じ）。
- **「配信が止まった」は帯に出さない。** 帯は「サーバーに届かない」の表示で、止まったのは値を作る側。アプリが値のそばに出す
  （古い値を現在値として見せない）。文言はアプリの Paraglide のキー（§13）。

### 5.5 `staleAfterMs` / `onStale`

**入れることを推奨する**（§10 の 6）。時計 1 つと真偽 1 つの小さな規則だが、入れないと下流がまた同じものを書き、
つなぎ直し・止める・token の入れ替わりとの噛み合わせ（下の表）をアプリごとに決めることになる。

| いつ | すること |
| --- | --- |
| `staleAfterMs` が無い | 何もしない（時計を作らない。§5.3） |
| 配信が初めて開いた | 時計を掛ける（開いたのに 1 件も来ない、も「止まった」に数える） |
| `parse` が `null` でない値を返した | 時計を掛け直す。止まっていたなら `onStale(false)` |
| 時計が切れた | `onStale(true)` を 1 回 |
| 切断・つなぎ直しの待ち | 時計はそのまま進める（切れている間も、画面の値は古くなる）。つなぎ直しただけでは戻さず、次の値で戻す |
| 別の token で開き直した・401・token が消えた | 時計はそのまま（画面の値の古さはセッションと関係がない） |
| 止めた | 時計を消す。何も呼ばない |

- 数えるのは「画面に出す値」になったもの（`parse` が値を返したもの）。keepalive のコメントや捨てた 1 件では戻さない。
- 判定は配信 1 本ごと。1 本に種類を混ぜる（§4.7）ときに種類ごとの古さが要るなら、アプリが値の時刻で見る（レシピに書く）。
- `staleAfterMs` の目安は「作る側の周期の 3 倍ほど」。server の側の前提は §4.5（作る側が周期ごとに送る）。

## 6. 試験の方針

- **Rust の単体（`sse.rs`）**: `SseFrame`（JSON・文字列・名前の検査で空 / CR / LF を断る）、`watch_frames`（開いた直後にいまの値・
  同じ値の `send` でも出る・`encode` が `None` なら出ない・送り手が消えたら終わる）、`broadcast_frames`（`Lagged` を飛ばす・`Closed` で終わる）。
  土台のループは、アプリの配信（`watch` の流れ + 名前つき）で、手動の期限（`Schedule::Manual`）を使って
  `Ok(None)` で閉じる／`Err`・時間切れでは閉じない／期限は終わりから／流れの終わりで閉じる、を確かめる。
  `SseContext`: `require_auth` の外では 500、内側で取り出せる、`counted_as_client` を呼んだときだけ数が増え、どう終わっても減る。
- **Rust の既存の試験**: `events.rs`（確かめ直し・grant・時間切れ・飢えさせない、など）と `server.rs`（停止・接続数）は本文を変えずに通る（§4.4）。
- **Rust の統合（`tests/` の新しいファイル。crate の外から）**: 本物の `start` でアプリの配信を開き、
  ① `stop()` が `STOP_TIMEOUT` よりずっと短く戻る（完了の条件 2）、② 失効させた token の配信が次の確かめ直しで閉じ、
  つなぎ直しは 401、③ 複数の名前を 1 本に混ぜて届く、④ `/api/events` と並べて開いたときの `sse_connections()`。
  `tests/public_api.rs` に、`SseContext`・`SseFrame`・`sse_response`・`watch_frames`・`broadcast_frames` の可視性とシグネチャの固定を足す。
- **TS の単体（新しいファイル）**: `sse-message-parser`（名前あり・なし・複数の `event:`・CRLF・chunk をまたぐ・`data:` なしは出さない）、
  `sseStream`（任意の path・`parse` に名前が渡る・`null` と例外は捨てて続ける・401 / 消えた token / 入れ替わり / つなぎ直しの規則を
  `/api/events` 以外の path でもう一度・`onConnection` の真偽の順・止めた後は何も呼ばない）、stale（§5.5 の表を 1 行ずつ、偽の時計で）。
  既存の試験のファイルは触らない（§5.3）。
- **e2e**: 足さない見込み。admin-template にアプリの配信が無く（§2.3）、`/api/events` の経路は今の e2e（つなぎ直し・切断の帯）が
  provider の載せ替えの後も通ることで確かめる。S2 では `pnpm e2e` を回して緑を完了の条件にする。
- **Tauri**: `src-tauri` は触らない（`sse_connections()` の意味も既定では変わらない）。

## 7. PR の分け方

1 PR = 1 エージェントで済む大きさ。順序は **S1（#935）→ S2（#936）→ S3**。S1 と S2 は触るファイルが重ならないが、
下流は server から移る（§8）ので server を先に出す。

| PR | 範囲 | 完了条件 |
| --- | --- | --- |
| S0 | この設計書（文書だけ） | `pnpm format:check` |
| S1（#935） | `crates/banto-server/src/sse.rs`（`SseContext`・`SseFrame`・`sse_response`・`watch_frames`・`broadcast_frames`、規則のループ、`Schedule` の引っ越し）。`events.rs` を土台の上へ。`lib.rs` の再輸出。`tests/public_api.rs`・統合試験 | §6 の Rust の全部。既存の試験の本文を変えない。`cargo test -p banto-server`・`cargo fmt --check`・`cargo clippy`。依存を足さない（`Cargo.toml` が変わらない）。CHANGELOG [Unreleased]（追加） |
| S2（#936） | `sse-parser.ts`（`createSseMessageParser`）、`sse-stream.ts`（`createSseStream`・stale）、`events.ts` の provider を上へ、`index.ts` の輸出、admin-core の README に 1 節 | §6 の TS の全部。`packages/admin-core/tests` の既存のファイルが差分に出ない。`pnpm check`・`pnpm lint`・`pnpm format:check`・`pnpm e2e`。external-consumer が緑。CHANGELOG [Unreleased]（追加） |
| S3 | `docs/recipes/app-sse-stream.md`（server とフロントを通した見本、1 画面 1 本・名前で分ける、作る側が周期ごとに送る、stale の出し方、401 の配線、接続数）。README からの案内。この設計書へ決めた形を書き戻す | `pnpm format:check`。レシピのコードは S1・S2 の試験と同じ形（写して動くこと） |

S1 は `sse.rs` の新設と `events.rs` の載せ替えを 1 つの PR にする（分けると、規則が 2 か所にある期間ができる）。
大きすぎれば「新設（`events.rs` は触らない）→ 載せ替え」の 2 つに割ってよいが、2 つ目を必ず同じリリースに入れる。

## 8. 下流（banto-industrial・temp-scada）が移る手順の概略

下流は今、停止の知らせ・確かめ直しのループ・読み口（`createSseParser` + 自前の `fetch` とつなぎ直し）・stale の判定を自前で持っている。
server とフロントは別々に移せる（線の上の形は変わらない）。

1. banto を S1・S2 の入った版へ上げる（追加だけなので、上げるだけでは何も変わらない）。
2. **server**: 配信のハンドラーを `SseContext` + `watch_frames`（または `broadcast_frames`）+ `sse_response` に置き換える。
   自前の確かめ直しのループ・keepalive・`RunningServer::stop` の前に自分で閉じる処理と、そのための停止の知らせを消す。
   作る側が周期ごとに `watch` へ送っていること（§4.5）を確かめる。自前で「送り直し」をしていたなら、作る側へ移す。
3. **server の確かめ**: 下流の試験で、`stop()` が 5 秒待たないこと、失効させた token の配信が閉じることを見る。
   「接続 n 台」に数えるかを決める（`/api/events` を開かない画面があるなら、その配信で `counted_as_client()`）。
4. **フロント**: 自前の読み口を `createSseStream` に置き換える。`event:` を使うなら `parse(data, event)` で分ける。
   stale の判定を `staleAfterMs` / `onStale` へ移す。401 の配線（§5.4）を入れる。
5. 配信が複数あるなら、1 画面 1 本にまとめる（§4.7）。これは急がない（別の PR でよい）。
6. 自前の仕組みと、その試験を消す。

移る前後で、下流の画面から見える違い: 確かめ直しの間隔が banto の定数（15 秒）になる、
`require_auth` の外に置いていた配信があれば 500 になる（内側へ入れる）。

## 9. 危うい点

- **載せ替えで `/api/events` の規則を崩す**: 既存の試験の本文を変えないことを S1 の完了の条件にする（§4.4）。レビューは `select!` の順と `rearm` の位置を見る。
- **provider の載せ替えで時計の順が変わる**: 既存の試験のファイルを触らないことを S2 の完了の条件にする（§5.3）。
- **`SseContext` の「`require_auth` の内側」の判定**が `AuthenticatedSession` の `Extension` に寄りかかる:
  `require_auth` がそれを入れなくなると全部 500 になる（開きすぎる側には倒れない）。単体試験で固定する。
- **`watch_frames` と遅い画面**: `watch` は最新の値だけを持つので、遅い画面は途中の値を飛ばす（現在値の配信では望ましい）。
  1 件も落とせない知らせは `broadcast_frames`（それでも `Lagged` は飛ばす）で、つなぎ直しの後は読み直す。レシピに書く。

## 10. 確かめたい点（オーナーの判断）

| # | 決めること | 推奨 |
| --- | --- | --- |
| 1 | server は案 1（部品の公開）か案 2（土台）か（§4.1） | **案 2 だけ**。`ShutdownSignal`・`SseConnections` は `pub(crate)` のまま。SSE でない長い応答の要望が出たら `ShutdownSignal` だけの公開を考える |
| 2 | `events.rs` を土台の上に載せ替えるか（§4.4） | **載せ替える**（規則を 1 か所に）。既存の試験の本文を変えないことが条件 |
| 3 | 土台に「同じ値の送り直し」を入れるか（§4.5） | **入れない**。作る側が周期ごとに `watch` へ送る（土台が送り直すと、作る側が止まったことを隠す）。レシピに書く |
| 4 | アプリの配信を「接続 n 台」に数えるか（§4.6） | **既定は数えない、`counted_as_client()` で数える**。別案: 全部数える（Issue の文字どおり。1 画面が 2 台になる）／種類ごとに別の数 |
| 5 | 確かめ直しの間隔・時間切れを配信ごとに変えられるようにするか（§4.3） | **しない**（定数のまま。失効が届く時間をどの配信でも同じにする） |
| 6 | `staleAfterMs` / `onStale` を入れるか（§5.5） | **S2 に入れる**。帯（#637）には出さず、アプリが値のそばに出す |
| 7 | 401・消えた token をセッションの制御へつなぐ小さな関数（`sessionStreamHooks()`）を足すか（§5.4） | **足す**（2 行だが、`/api/events` を開かない画面で忘れると失効に気づかない）。`createSseStream` 自体は制御を知らないまま |
| 8 | 403 などの状態コードを読み口から知らせるか（§5.2） | **今は足さない**（401 以外はつなぎ直す、のまま）。要望が出たら `onHttpError(status)` を足す |
| 9 | パーサーの足し方（§5.1） | **`createSseMessageParser` を隣に足す**（`createSseParser` はその上に載せ、形を変えない） |
| 10 | 「1 画面 1 本・名前で分ける」を指針にするか（§4.7） | **する**（レシピに書く）。同時接続の上限は S3 までに実機で 1 度確かめる |

未確定のまま残る点（実装で確かめる）: `SseContext` の拒否の本文の形（`ApiError` に合わせる）、`watch_frames` の `T` の境界（`Clone` が要るか）、
`SseFrame::event` を `&'static str` に絞れるか、`sessionStreamHooks` の置き場（`events.ts` か別ファイルか）、
HTTP/1.1 の同時接続の上限の実測（§4.7）。
