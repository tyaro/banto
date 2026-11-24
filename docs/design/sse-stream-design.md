# アプリ独自の SSE の配信と読み口 設計書 — Issue #935・#936

作成日: 2026-11-25
状態: **§10 の 1〜16 は推奨どおりで決定（2026-11-25、オーナー）。S1（server の土台、#935）は実装済み。S2（admin-core の読み口、#936）→ S3（レシピ）は別 PR**
トラック: 保守者向け（トラックA）
関連: Issue #935（server の配信の部品）、Issue #936（admin-core の読み口）、
#231 / [ADR-0014](../adr/0014-account-bound-session-revocation.md)（開いた配信の確かめ直し）、#239（`AuthState::revalidate` の公開）、
#241・#591（401・token の入れ替わり）、#283（停止の知らせ）、#289（つなぎ直しの後の読み直し）、#558（接続 n 台）、#637（切断の帯）、
conventions §3 / §4 / §5 / §6 / §12 / §13

この文書の `path` と型の名前は、2026-11-25 の main（`dc73f4c0`）で開いて確かめた。
**新しく足す型・関数・ファイルの名前は見込み**で、各 PR で決める（決めた形はこの文書へ書き戻す）。
server 側（§4）の名前は S1 で決まった（下の「S1 で決まった形」）。S2・S3 の分は見込みのまま。

### S1 で決まった形（設計とのずれと、未確定だった点）

- 公開したもの（`banto_server::sse`、`lib.rs` から再輸出）は §4.3 のとおり: `SseContext`（`counted_as_client`・
  `require_permission`・`reauthorize_with`）、`SseFrame`（`json`・`text`・`event`）、`InvalidSseEventName`、
  `sse_response`、`watch_frames`、`broadcast_frames`。`REVALIDATE_INTERVAL`・`REVALIDATE_TIMEOUT` は `sse` へ移し、
  `events::` の今の path からも再輸出する。
- **結びつけの型は `sse::SseAuthBinding`**（`pub(crate)`。`require_auth` がセッション・権限と並べて入れる）。
  中身は 1 回の認可の束: `AuthState`・**検証した token**・その認可が返したセッションと権限・**認可を終えた時刻**
  （#943 のレビュー）。`SseContext` はこの束だけから作り、`Authorization` ヘッダーも、要求の `Extension` の
  セッション・権限も読み直さない（ルートの内側のミドルウェアがヘッダーを書き換えても、確かめ直すのは検証した token）。
- **`SseContext` の拒否の本文は `ApiError` の形**: `require_auth` の外は 500 `{ "kind": "other", … }`、
  条件を満たさない開き方は 403 `{ "kind": "forbidden" }`（`PermissionGuard` の 403 と同じ本文）。token なし・無効の 401 は
  `require_auth` が返す（`SseContext` 自身は 401 を返さない）。
  `require_auth` の入れるセッション・権限だけが要求にあっても、結びつけが無ければ 500。
- **1 回目の確かめ直しの期限は、認可の時刻から数える**（#943 のレビュー）。`sse_response` を呼んだ時点からではなく、
  `require_auth` が認可を終えた時刻 + 15 秒。ハンドラーがその後に別の処理を待って期限を過ぎていれば、ループは
  最初のフレームを取る前に確かめ直す（`biased` で期限が先）。このとき開く判定（403）は `require_auth` の権限で済んでいるので、
  権限が外れていた配信は 200 で開いて、フレームを 1 件も流さずに閉じる（つなぎ直しが 403）。
- **権限を読んでいる間に終わった token を許可しない**（#943 のレビュー）。`authenticate_with_permissions` /
  `revalidate_with_permissions` は、権限を読んだ後に、同じ token がまだ生きていて（ログアウト・期限切れ・失効でない）
  結びつき（stamp・grant）も同じことを、メモリの表で idle を延ばさずに確かめてから許可する。認証モードの世代の照合だけでは
  ログアウト・期限切れを拾えないため。結びつきだけが変わっていた（自分のパスワード変更）ときは、いまの結びつきで
  もう 1 回だけ最初からやり直す（`authenticate` の `settle_lookup` と同じ形）。要求の認可も同じ関数なので同じに効く。
- **停止の保証の範囲**（#943 のレビュー）: 土台が保証するのは「ポーリングされている配信は停止の知らせで閉じる。
  確かめ直しの待ちも停止で止まる」まで。読まないクライアントへの送信が詰まって body がポーリングされない配信は
  ループが進まず、停止の分岐に届かない。これはサーバー全体の既存の停止の上限（`STOP_TIMEOUT` = 5 秒の後に
  サーバーのタスクを打ち切る）が受け持つ（§4.4）。
- **`watch_frames` の `T` に `Clone` は要らない**（`Send + Sync + 'static` だけ。値は借りて `encode` に渡す）。
- **`SseFrame::event` は `impl Into<String>` のまま**（`&'static str` には絞らない。設備ごとの名前など、実行時に決まる名前を断らない）。
  同じフレームに 2 度呼ぶと後の名前が勝つ。
- **`SseFrame::text` は改行を 1 種類に揃える**（CRLF・CR を LF にしてから載せる。axum は CR と LF のそれぞれで
  `data:` 行を切るので、CRLF をそのまま渡すと読み口では改行 2 つになる）。設計の「複数の `data:` 行になる」の中身を決めた。
- **権限の読み直しは `AuthState::revalidate_with_permissions`**（`pub(crate)`。`authenticate_with_permissions` と同じ
  1 つの関数を、idle を延ばさない指定で呼ぶ。認証モードの世代の照合（ADR-0034 §6）も同じに掛かる）。
- **grant のセッション**: 権限は「持たない」（要求と同じ読み方）なので、`require_permission` を付けた配信は 403 で開かない。
  条件の無い配信は今までどおり token だけで確かめ直す。
- **試験の継ぎ目**: 間隔と時間切れは `pub(crate)` の `SseTiming` を `Extension` で渡したときだけ変わる（crate の外からは
  作れないので、アプリの配信は必ず定数）。そのため `tests/sse_stream.rs`（crate の外）の確かめ直しを待つ試験は、
  本物の 15 秒を待つ（並べて走るので全体で 20 秒ほど）。手動の期限で細かく見る分は `src/sse/tests.rs`。
- **設計から足したもの**: `events::sse_route_with` を `pub(crate)` にした（`/api/events` の経路でも「確かめ直し中の停止」を
  `sse` の試験から見るため。名前・引数・意味は同じ）。`SseContext` に `Debug`（token は出さない）。
- **入れなかったもの**: `verify-architecture` での `require_permission` の付け忘れの検査（§9。S3 までに確かめる、のまま）。

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
| §6 セッションは要求ごとに照合（#204・ADR-0014） | 開く瞬間は `require_auth`、開いた後は土台の確かめ直し。**土台は `require_auth` の内側でしか使えない形にし、確かめ直しは開く要求を認証したその `AuthState` で行う**（§4.3 の `SseContext`。ハンドラーは `AuthState` を渡さない）。権限つきの配信は、開いた後も権限を読み直す（§4.3.1）。保存先が答えられないときの扱いは今の `event_stream` と同じ（開く要求は `require_auth` が 500 で失敗させ、開いた後は閉じずに次の期限で確かめる。#230。権限つきの配信だけは、確かめられなければ閉じる。§4.3.1） |
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
| 公開するもの | `ShutdownSignal::triggered()`・`SseConnections::open()`・`SseConnectionGuard` | 要求から取る文脈（`SseContext`。開いた後の認可の条件もここに持つ）、1 件のイベント（`SseFrame`）、応答を作る関数（`sse_response`）、`watch` / `broadcast` からの変換 |
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

/// 配信 1 本ぶんの、要求から取る文脈（token・**開く要求を認証した `AuthState`**・その時点の
/// セッションと権限・停止の知らせ・接続数）。中身は非公開で、アプリの側からは作れない。
/// `require_auth` の内側でだけ取り出せる: `require_auth` が要求に入れる非公開の結びつけ
/// （下の「決めたこと」）が無ければ 500。token も結びつけから取り、`Authorization` ヘッダーは読み直さない
/// （token なし・無効の 401 は `require_auth` が返す）。
pub struct SseContext { /* 非公開 */ }

impl<S: Send + Sync> FromRequestParts<S> for SseContext {
    type Rejection = Response;
    /* … */
}

impl SseContext {
    /// この配信を「接続 n 台」（`RunningServer::sse_connections`、#558）に数える。
    /// 既定は数えない（§4.6）。
    pub fn counted_as_client(self) -> Self;

    /// 権限つきの配信（§4.3.1）: `permission` を持つ間だけ開いておく。開くときに 1 回
    /// （持たなければ `sse_response` が 403 を返し、フレームは 1 件も流れない）、開いた後は
    /// セッションの確かめ直しのたびに権限を読み直し、外れていたら閉じる。**読み直せなかったとき
    /// （`Err`・時間切れ）も閉じる**（確かめられた許可だけで配信する）。何度呼んでもよい（全部が要る）。
    pub fn require_permission(self, permission: PermissionKey) -> Self;

    /// ルートより細かい条件（設備ごと、など）の版。`allow` が `false` を返したら閉じる。
    /// 呼ばれる時機は `require_permission` と同じ。`allow` は同期で、保存先を読まない
    /// （渡されるのは、土台が読み直したセッションと権限）。
    pub fn reauthorize_with<F>(self, allow: F) -> Self
    where
        F: Fn(&AuthenticatedSession, &SessionPermissions) -> bool + Send + Sync + 'static;
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
/// 確かめ直しに使う `AuthState` は `context` が持っている（引数に取らない）。
/// `frames` が終わると配信も終わる（クライアントはつなぎ直す）。
pub fn sse_response<S>(context: SseContext, frames: S) -> Response
where
    S: Stream<Item = SseFrame> + Send + 'static;

/// `watch` の値の流れ。**開いた直後にいまの値を 1 回**出し、その後は `send` があるたびに、
/// **次に読み取れた最新の値**を出す（値が同じでも出す。§4.5。読むのが遅ければ途中の値は飛び得る。§9）。
/// 開いた直後の 1 件は「最後に作られた値」で、**新しいとは限らない**
/// （つなぎ直すたびに同じものが出る。新しさの見分け方は §4.5・§5.5）。`encode` が `None` を返した値は送らない。送り手が消えたら終わる。
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
    // 開いた後も PLANT_VIEW を読み直す（外れたら次の確かめ直しで閉じる）。
    sse_response(context.require_permission(PLANT_VIEW), frames)
}

Router::new()
    .route("/api/plant/stream", get(plant_stream))
    // 開くときの拒否を監査（`denied`）に残すための層。開いた後は見ない（§4.3.1）。
    .layer(middleware::from_fn_with_state(plant_view_guard, require_permission))
    .layer(middleware::from_fn_with_state(auth, require_auth))
```

決めたこと（理由つき）:

- **入り口は `Stream<Item = SseFrame>` の 1 つ**にし、`watch` / `broadcast` は変換の関数で合わせる。
  1 本の配信に複数の出どころを混ぜる（§4.7）のは、アプリが `futures_util::stream::select` で流れを合わせればよい。
- **ルートごと作る関数（`sse_route` の汎用版）にはしない。** Issue のとおり、アプリは `require_auth` の内側に自分の確かめを重ねたいので、
  ハンドラーの中で呼ぶ形にする。その代わり、`require_auth` を掛け忘れたルートでは `SseContext` が取り出せず 500 になる
  （掛け忘れたまま、確かめていない token で最初の確かめ直しまで配信が開く、を防ぐ。fail closed）。
- **確かめ直しは、開く要求を認証したその `AuthState` に結びつける（ハンドラーは `AuthState` を渡さない）。**
  草案は `sse_response(context, &auth, frames)` で、「渡し間違えても 15 秒ほどで閉じる」としていたが、これは開くときの
  fail closed ではない（`watch_frames` はいまの値を最初に送るので、閉じる前に 1 件目が流れている）。そこで
  `require_auth` が、セッション・権限と並べて**非公開の結びつけ**（自分の `AuthState` の写し・検証した token・
  認可が返したセッションと権限・認可を終えた時刻を 1 つの束にした `pub(crate)` の型。
  `AuthState` は `Arc` の持ち手なので写しは軽い）を要求の `Extension` に入れ、`SseContext` の取り出しはそれを取るだけにする
  （`Authorization` ヘッダーを読み直さない。初回の判定に使うセッション・権限と、後で確かめ直す token が必ず対応する）。
  型が非公開なので、アプリが別の `AuthState` を差し込む道は無い。`SseContext` が「`require_auth` の内側」を判定する目印も、
  `AuthenticatedSession` ではなくこの結びつけにする（無ければ 500）。`require_auth` の公開のシグネチャは変わらない。
- **間隔と時間切れは設定にしない**（`REVALIDATE_INTERVAL`・`REVALIDATE_TIMEOUT` の定数のまま）。配信ごとに変えられると
  「失効は 1 間隔のうちに届く」（ADR-0014）が配信によって崩れる。定数は `sse.rs` へ移し、`events::` の今の path からも再輸出する。
- **axum の `Event` は公開面に出さない**（`SseFrame` で包む）。`Event::event` は改行で panic するので、名前の検査を `SseFrame::event` に置く。

#### 4.3.1 開いた後の権限の取り消し

いま（`dc73f4c0`）の作りでは、権限つきの配信を素直に書くと、**権限が外れても配信が続く**。

- `PermissionGuard`（`require_permission`）は要求の入り口の層で、見るのは開くときだけ。
- `AuthState::revalidate` が確かめるのはセッションの有効性（失効・期限・アカウントの削除・role / パスワードの変更）で、
  個別の権限は読み直さない。
- banto は権限の変更だけではセッションを終わらせない（要求ごとに読み直す前提。ふつうの要求は次の 1 回から断られる）。
  開きっぱなしの配信だけが、この前提から外れる。

**決めたこと: 土台に、開いた後の認可を読み直す口を持たせる**（`SseContext::require_permission` / `reauthorize_with`。§10 の 11）。

| 時機 | 土台がすること |
| --- | --- |
| 開くとき（`sse_response` の中、最初のフレームより前） | `require_auth` が要求に入れたセッションと権限で条件を評価する。満たさなければ **403**（フレームは 1 件も流れない。fail closed）。層の `PermissionGuard` を付け忘れても開かない |
| 確かめ直しのたび（15 秒ごと） | `revalidate` が `Ok(Some(session))` を返したら、続けて同じ `AuthState` でそのセッションの権限を読み直し（`authenticate_with_permissions` と同じ読み方。idle の期限は延ばさない）、条件を評価する。満たさなければ**閉じる** |
| 条件を付けた配信で、確かめ直し（`revalidate` または権限の読み直し）が `Err`・時間切れ | **閉じる**（下の「確かめられない間の上限」）。時間切れ（5 秒）は `revalidate` と権限の読み直しを合わせた 1 回ぶんに掛ける |
| 条件を付けていない配信（`/api/events` を含む） | 権限を読まない。**今の規則と 1 行も変わらない**（`Err`・時間切れでは閉じない。#230。保存先を読む回数も増えない） |

**確かめられない間の上限。** 条件を付けた配信が流してよいのは、**最後に確かめられた許可が、次の確かめ直しの終わりまで**。
`/api/events` の「`Err`・時間切れでは閉じない」（#230）を権限つきの配信にも当てると、保存先が答えない間は最後の許可が
いつまでも残り、「外れたら閉じる」と言えなくなる。そこで、権限つきの配信だけは**確かめられなければ閉じる**（1 回目の失敗で。
何回まで見逃す、の数は持たない）。

- 上限: 許可を最後に確かめ終えてから、**確かめ直しの間隔（15 秒）+ 時間切れ（5 秒）= 最大 20 秒**で、配信は
  「いまも許可がある」と確かめ直されているか、閉じている。権限が外れた・保存先が答えなくなった、のどちらから数えても 20 秒以内
  （間隔は前の確かめの終わりから数え、確かめ直しの処理の時間は時間切れの 5 秒に含まれる）。
  **1 回目の「前の確かめ」は `require_auth` の認可**で、`sse_response` を呼んだ時点ではない: ハンドラーが認可の後に
  別の処理を待っても上限は延びず、期限を過ぎていれば最初のフレームより先に確かめ直す（結びつけが認可の時刻を持つ。§4.3）。
  「確かめられた」と数えるのは、権限を読み終えた後にも同じ token が生きていて結びつきが同じときだけ
  （読んでいる間のログアウト・期限切れは、認証モードの世代を変えないので、token そのものを見直す）。
- 閉じた後のつなぎ直しは、保存先が答えない間 `require_auth` が 500 を返す（今と同じ。開く側は元から fail closed）。
  読み口は「401 以外はつなぎ直す」で待ち、保存先が戻れば開く。保存先の一時の不調で権限つきの配信が 1 度切れて
  すぐ戻る、は受け入れる（表示は切断・stale の扱いで、値を消すのは 403 のときだけ。§5.2.2）。
- `/api/events` と、条件の無いアプリの配信は #230 のまま（保存先の不調で全部の配信を落とさない）。
  規則が配信の種類で分かれるのは、この 1 点だけ（§4.4 の表）。
- 権限が外れてから閉じるまでも同じ上限（最大 20 秒）。ADR-0014 の「失効は 1 間隔のうちに届く」に、
  権限つきの配信の上限と、確かめられないときに閉じることを 1 段落で足す（S1）。
- 閉じた後、クライアントはつなぎ直して 403 を受ける。このとき層の `PermissionGuard` が監査に `denied` を残す
  （開いた後に閉じたこと自体は監査に書かない。書くかは §10 の 11 の補足）。403 のつなぎ直しの間隔は §5.2・§10 の 13。
- 層の `PermissionGuard` は**残すことを推奨**（開くときの拒否の監査と、`verify-architecture` の規則 8 のため）。
  層とハンドラーで権限の名前を 2 回書くことになるので、レシピの見本は同じ定数を使う。
- `allow` を同期の関数に絞るのは、確かめ直しのループに「アプリの、いつ終わるか分からない待ち」を入れないため
  （停止・時間切れの規則を土台の中だけで言い切れる）。DB を引く条件が要るという要望が出たら、そのとき非同期の版を考える。
- **S1 の完了の条件**に統合試験を足す: セッションは有効なまま権限だけを外すと、次の確かめ直しで配信が閉じ、
  つなぎ直しは 403。同じ試験の中で、条件を付けていない `/api/events` は開いたまま、も見る（§6）。

### 4.4 規則の一本化と `events.rs` の載せ替え

規則は `sse.rs` の非公開の 1 つの関数（今の `event_stream` のループを、`broadcast::Receiver<ServerEvent>` の代わりに
`Stream<Item = SseFrame>` を取る形にしたもの）に置く。`sse_response` も `/api/events` も、これだけを通る。

| 規則 | 一本化する場所 | 今との違い |
| --- | --- | --- |
| 確かめ直しの間隔（15 秒）と時間切れ（5 秒） | `sse.rs` の定数 | なし（移すだけ） |
| `Ok(None)` で閉じる／`Err`・時間切れでは閉じない | ループ | なし |
| 開いた後の認可（条件を付けた配信だけ。§4.3.1） | ループ（確かめ直しの続きで権限を読み直す） | **新しい規則**。条件を満たさない・**確かめられない（`Err`・時間切れ）なら閉じる**（最大 20 秒）。条件の無い配信（`/api/events`）には掛からず、`Err`・時間切れでは閉じないまま |
| 次の期限は確かめ終わりから（`rearm`） | `Schedule`（`sse.rs` へ移す。`pub(crate)`） | なし |
| 順番: 停止 → 期限 → イベント（`biased`） | ループ | なし |
| **確かめ直しの途中でも停止を優先する** | ループ（確かめ直しの待ちを、停止の知らせと `select!` する） | **変わる（直す）**。今の `events.rs` は `Step::Recheck` に入ると `revalidate` を最大 5 秒待ち、その間は停止を見ない。`/api/events` もこの直しを受ける |
| 停止の知らせで閉じる | ループ（`SseContext` が `Extension` から取る。無ければ「知らせは来ない」） | なし。**ポーリングされている配信に限る**（下の「停止の保証の範囲」） |
| 1 回目の期限は認可の時刻から | `Schedule`（結びつけの持つ時刻で 1 回目の期限を置き直す） | アプリの配信で、ハンドラーが認可の後に待つ場合だけ違いが出る。`/api/events` のハンドラーは待たないので変わらない |
| 接続数 | `SseContext` が guard を作り、配信の状態が持つ（どう終わっても減る） | アプリの配信は既定で数えない（§4.6） |
| keepalive（15 秒のコメント） | `sse_response` | なし |
| 流れが終わったら閉じる | ループ | `broadcast` の `Closed`・`Lagged` の扱いは `broadcast_frames` へ移る |

**`events.rs` は土台の上に載せ替える**（推奨。§10 の 2）。`sse_handler` は `SseContext`（数える）を取り、
`broadcast_frames(tx.subscribe(), |event| SseFrame::json(event).ok())` を土台へ渡すだけになる。載せ替えないと、
規則が `events.rs` と `sse.rs` の 2 か所に残り、片方だけ直す事故が起こる。

**確かめ直しの途中の停止。** 外側の `select!` は停止を先に見るが、今の `events.rs` は確かめ直しに入った後、
`timeout(5 秒, revalidate)` を待つ間は停止を見ない。そのまま土台にすると、「`stop()` が 5 秒待たない」（完了の条件 2）が
確かめ直しの最中にだけ成り立たない。土台では、確かめ直し（`revalidate` と、あれば権限の読み直し）の待ちを
`select! { biased; 停止 => 閉じる, 結果 = timeout(..) => 判定 }` にする。途中で捨てるのは、今も時間切れのときに捨てている
同じ future なので、新しい危うさは足さない（`revalidate` は読むだけ。捨てても token の状態は変わらない）。
試験は「確かめ直しが保存先の答えを待っている」ことを同期で確かめてから `stop()` を呼び、5 秒を待たずに戻ることを見る（§6）。

**停止の保証の範囲。** 上の 2 つ（停止の知らせで閉じる・確かめ直しの待ちも停止で止まる）は、どちらも**配信のループが
ポーリングされている**ことが前提になる。アプリの配信は任意の大きさのフレームを出せるので、読まない（遅い）クライアントへの
送信が詰まると、hyper は body をポーリングせず、ループは停止の分岐まで進まない。この場合を閉じるのは土台ではなく、
サーバー全体の既存の停止の上限（`RunningServer::stop` の `STOP_TIMEOUT` = 5 秒の後にサーバーのタスクを打ち切る。#283）。
したがって言えるのは「**確かめ直しの待ちは停止で止まる**（`stop()` は確かめ直しを待たない）」と
「**それ以外で終わらない接続は `STOP_TIMEOUT` で打ち切る**」の 2 つで、「どの配信も停止で即座に閉じる」ではない
（rustdoc・CHANGELOG・ADR-0014 もこの 2 つに分けて書く）。

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
- **ただし、つなぎ直しはこの前提の外にある。** `watch_frames` は開くたびに最後の値を出すので、作る側が止まっていても、
  クライアントがつなぎ直すたびに**古い値が新しいイベントとして 1 件届く**。「届いた = 作る側が生きている」は、
  開いた直後の 1 件には言えない。土台はここを隠さず、**値の新しさは値そのものが運ぶ**ことにする: 作る側は値に
  「作った印」（作った時刻。周期ごとに `send_replace` するたびに変わるもの）を入れ、読み口はその印が**変わったときだけ**
  「新しい値が届いた」と数える（§5.5 の `valueStamp`。§10 の 12）。土台が封筒（印つきの包み）を強いることはしない
  （`data:` の形はアプリのもの。印の取り出し方は読み口に関数で渡す）。
- 印は「前と違うか」だけを見る（大小は比べない）。作った時刻を使えば、サーバーの再起動で数え直しになっても同じ印に戻らない。
  クライアントの時計とは比べないので、PC ごとの時計のずれは判定に入らない。
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
	/**
	 * 値を届けていたセッションが終わった・入れ替わった（401・token が消えた・別の token になった）。
	 * 変わるたびに 1 回、新しいセッションの最初の `onEvent` より必ず前に呼ぶ。呼ばれたら、呼ぶ側は
	 * **この配信から受けて表示している値を無効にする**（前のセッションの値を次の利用者に見せない）。
	 * 止めたとき・同じ token のままの切断とつなぎ直しでは呼ばない。
	 */
	onSessionChange?: () => void;
	/**
	 * 同じ token のまま、開く要求が 403 で断られた（権限が無い・外れた。§5.2.2）。断られた状態に入るたびに 1 回
	 * （断られている間のつなぎ直しでは呼び直さない）。呼ばれたら、呼ぶ側は `onSessionChange` と同じく
	 * **この配信から受けて表示している値を無効にする**（見る権限の無い値を残さない）。
	 */
	onForbidden?: () => void;
	/** 403 の後のつなぎ直しの間隔。既定は `reconnectDelayMs` と同じ。 */
	forbiddenRetryDelayMs?: number;
	/** 配信が開いた（true）・開いていた配信が終わった（false）。理由を問わない。 */
	onConnection?: (connected: boolean) => void;
	/** 以下の 4 つは `EventSubscriptionHooks` と同じ意味・同じ回数。 */
	onUnauthorized?: () => void;
	onTokenCleared?: () => void;
	onReconnected?: () => void;
	onDisconnected?: () => void;
	/** 渡すと、最後の「新しい値」からこの時間が過ぎたときに `onStale(true)`、次の「新しい値」で `onStale(false)`（§5.5）。 */
	staleAfterMs?: number;
	onStale?: (stale: boolean) => void;
	/**
	 * 値の「作った印」（作る側が入れた時刻など）。渡すと、印が前と変わった値だけを「新しい値」と数える
	 * （つなぎ直しで送り直された同じ値では stale を解かない）。渡さないと、届いた値はすべて「新しい値」で、
	 * `onStale` は**受信が止まったこと**だけの指標になる（§5.5）。
	 */
	valueStamp?: (value: T, event: string | undefined) => string | number;
	reconnectDelayMs?: number; // 既定 3000
	tokenWaitDelayMs?: number; // 既定 500
}
/** 呼んだ時点で読み始める。戻り値は止める関数（今の `subscribe` の戻り値と同じ）。 */
export function createSseStream<T>(options: SseStreamOptions<T>): () => void;
```

- 401・token の入れ替わり・token が消えたときの規則は、今の `createSseEventProvider` の doc コメントの規則を**そのまま移す**
  （#241・#591・#289・#637。書き直さず、関数の中身を動かす）。そのうえで、**待ちの直後の持ち主の照合**を足す（§5.2.1）。
- Issue の案にある `onConnection` に加えて、既存の 4 つのフックをそのまま持つ。既存の provider を上に載せるのに要る（§5.3）うえ、
  `onDisconnected` / `onReconnected` は「同じセッションの間だけ」という細かい条件を持っていて、`onConnection` からは作れない。
- 403（アプリの追加の確かめで断られた）は、今の「401 以外はつなぎ直す」のまま。権限は要求ごとに読み直されるので、付けば次のつなぎ直しで開く。
  ただし、開いた後に権限が外れて閉じる（§4.3.1）ようになると、403 は「めったに無い設定の誤り」ではなく**ふつうの経路**になり、
  3 秒ごとのつなぎ直しが、そのたびに監査へ `denied` を 1 行足す。403 の扱いは §5.2.2 で決める（§10 の 8・13）。

#### 5.2.1 前のセッションの読み取りを、次のセッションに渡さない

いまの `events.ts` は、開いている間 `tokenWaitDelayMs`（500ms）ごとに token を見て、別の token になっていたら開き直す。
しかし `await fetchFn(...)` と `await reader.read()` の**待ちが明けた直後**には、その応答・そのフレームがいまのセッションのものかを
照合していない。`/api/events` の中身は「読み直しの合図」なので実害が小さかったが、汎用の読み口が運ぶのは**画面に出す値**で、
アカウントの切り替え・token の消去・停止の直後に、前のセッションの値が次の利用者の画面に届き得る。契約として次を決める。

- **試行ごとの世代。** つなぎに行くたびに世代を 1 つ進め、その試行は自分の世代と、使った token を持つ。
  「いまも自分の番か」= 止められていない・世代がいまのもの・`getToken()` が自分の token と同じ。
- **コールバックの直前に必ず照合する。** 待ちが明けるたび（`fetch` の応答・`reader.read()` の 1 回ごと）、
  そして 1 回の読み取りから複数の値が出るときは**値ごと**に、`onEvent`・`onConnection(true)`・`onReconnected`・
  `onDisconnected`・`onUnauthorized` を呼ぶ直前に照合する。自分の番でなければ、その応答・フレームは**捨てる**
  （本体は cancel する）。時計は足さない（照合は同期。500ms の見張りはそのまま残し、開き直しを起こす役のまま）。
- **遅れて届いた 401 は、いまの token のものとして扱わない。** 待っている間に token が別のものになっていたら、その 401 は
  前のセッションのものなので `onUnauthorized` を呼ばず、新しい token でつなぎ直す。token が消えていたら、
  今の「token が消えた」の経路（`onTokenCleared`）に任せる。token が同じままなら、今と同じ（`onUnauthorized` を 1 回）。
- **`onSessionChange`。** 401・token が消えた・別の token になった、のどれでも、その配信が値を届けていたセッションは終わっている。
  読み口はそこで `onSessionChange` を 1 回呼び、呼ぶ側は表示中の値を無効にする（照合は「これから届く値」を止めるだけで、
  **もう表示されている値**は読み口からは消せないため）。新しいセッションの最初の `onEvent` より必ず前に呼ぶ。
  `valueStamp` の「前の印」は持ち越す（印は作る側のもので、セッションと関係がない。§5.5）。
- **既存の回数は変えない。** つなぎ直し・401・切断の知らせ（`onReconnected`・`onUnauthorized`・`onTokenCleared`・`onDisconnected`）は、
  既存の試験が固定している順番と回数のまま（§5.3 の「既存のファイルを 1 行も変えない」）。照合が変えるのは、
  今は試験が無い「待ちの途中でセッションが変わった」の継ぎ目だけ。もし既存の試験がこの継ぎ目の今の振る舞い
  （変わった後のセッションへ届ける）を固定していたら、試験を直さずに止めてオーナーに確かめる（§10 の 14）。
- **新しい試験で固定する**（S2 の完了の条件。§6）: ① `fetch` の応答（200）が、token の入れ替わり・消去・停止の後に届く →
  `onConnection(true)` も `onEvent` も呼ばれない、② 同じく遅れた 401 → `onUnauthorized` は呼ばれず、新しい token を拒否済みにしない、
  ③ `reader.read()` が、token の入れ替わりから 500ms の見張りが回るまでの間に明ける → そのフレームは捨てる、
  ④ 1 回の読み取りに 2 件入っていて、1 件目の `onEvent` の中で token が変わる → 2 件目は届かない、
  ⑤ `onSessionChange` は変わるたびに 1 回で、次のセッションの最初の値より前。

#### 5.2.2 403: 権限が外れたら、表示中の値も消す

権限を外しても token は有効なままなので、サーバーが配信を閉じ（§4.3.1）、次の要求に 403 を返しても、**`onSessionChange` は呼ばれない**
（セッションは変わっていない）。つなぎ直しを待つだけだと、見る権限の無くなった値が画面に残る。stale は値の新しさの知らせで、
閲覧の権限の代わりにはしない（stale の印が付いても値は読める）。そこで 403 を、読み口の規則として次のように扱う。

| いつ | すること |
| --- | --- |
| 開く要求が 403（token は自分のもののまま。§5.2.1 の照合の後） | 断られた状態に入る。`onForbidden` を 1 回。`forbiddenRetryDelayMs` の後につなぎ直す |
| 断られている間のつなぎ直しがまた 403 | 何も呼ばない（`onForbidden` は状態に入るときだけ）。同じ間隔で続ける |
| 断られている間に開けた（権限が戻った） | 断られた状態を出る。`onConnection(true)`、最初の値が `onEvent` に届く（`watch_frames` のいまの値）。`onReconnected` は今の規則のまま（同じセッションのつなぎ直しなので、前に開けていれば呼ばれる。403 のための特別な扱いは足さない） |
| 断られている間に 401・token が消えた・別の token | それぞれの今の経路（`onSessionChange` も呼ぶ）。断られた状態は出る |
| 止めた | 何も呼ばない |

- **呼ぶ側の責務**（doc コメントとレシピに書く）: `onForbidden` で、その配信から受けて持っている値（表示・キャッシュ）を
  消すか見えなくし、「見る権限が無い」を出す（文言はアプリの Paraglide のキー）。権限が戻れば、次に届いた値で出し直す。
  `onSessionChange` と `onForbidden` の両方で同じ「消す」を呼べばよい（レシピの見本は 1 つの関数にまとめる）。
- stale の時計は 403 でも変えない（§5.5。値は消えているので、出す先が無いだけ）。
- 既存の provider（`/api/events`）は `onForbidden`・`forbiddenRetryDelayMs` を渡さない。`/api/events` は 403 を返さず、
  既定の間隔は `reconnectDelayMs` と同じなので、時計の数も順番も今のまま（§5.3）。
- **試験で固定する**（S2 の完了の条件。§6）: 値が届いている → 同じ token のまま配信が閉じ、つなぎ直しが 403 →
  `onForbidden` が 1 回で、`onSessionChange`・`onUnauthorized` は呼ばれない → 403 が続いても呼び直さない →
  権限が戻って開く → 値がもう一度 `onEvent` に届く。レシピの見本の「消す → 出し直す」も、同じ流れで
  `値あり → 403 → 値が見えない → 権限が戻って再表示` を確かめる（S3。見本の画面の単体試験）。

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
  持ち主の照合（§5.2.1）は同期の比較だけで、時計を足さない。provider は `onSessionChange`・`valueStamp` を渡さない。
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
| **新しい値**が届いた（下の定義） | 時計を掛け直す。止まっていたなら `onStale(false)` |
| 新しくない値が届いた（`valueStamp` の印が前と同じ） | `onEvent` には渡す（同じ値なので害が無い）。**時計は掛け直さず、stale も解かない** |
| 時計が切れた | `onStale(true)` を 1 回 |
| 切断・つなぎ直しの待ち | 時計はそのまま進める（切れている間も、画面の値は古くなる）。つなぎ直しただけでは戻さず、次の新しい値で戻す |
| 別の token で開き直した・401・token が消えた（`onSessionChange`） | 時計も stale の真偽もそのまま（値の古さは作る側のもので、セッションと関係がない）。前の印も持ち越す |
| 403（`onForbidden`。§5.2.2） | 時計も stale の真偽もそのまま。値を消すのは呼ぶ側（stale は権限の代わりにしない） |
| 止めた | 時計を消す。何も呼ばない |

**「通信が戻った」と「値が新しくなった」を分ける**（§4.5 の続き。§10 の 12）。`watch_frames` はつなぎ直すたびに最後の値を出すので、
「`parse` が値を返した」だけで stale を解くと、作る側が止まったままでも、つなぎ直しのたびに古い値が「復旧」に見える。

- **推奨: `valueStamp` を渡す。** 「新しい値」= `valueStamp(value, event)` が、同じ名前（`event`。無ければ名前なしで 1 つ）で
  前に見た印と違う値。印は名前ごとに覚える（1 本に種類を混ぜても、種類ごとに送り直しを見分けられる）。
  作る側が止まったまま何度つなぎ直しても、印が同じなので時計は掛け直されず、stale は解けない。
- **`valueStamp` を渡さないとき**: 「新しい値」= `parse` が値を返したもの全部。このとき `onStale` は
  **「受信が止まった」だけの指標**で、値の新しさは保証しない（つなぎ直しの送り直しで解ける）。doc コメントとレシピに
  そう書き、レシピの見本は `valueStamp` を渡す形にする。印を持たない配信（`broadcast_frames` の知らせなど、
  開いた直後の送り直しが無いもの）は、渡さなくてよい。
- **残る限界**: 画面を開いて最初の 1 件は、比べる「前の印」が無いので新しいと数える。作る側が止まっているときに画面を開くと、
  `staleAfterMs` が過ぎるまでは古い値が現在値に見える。これが困る値（操作の判断に使う値など）は、アプリが値の中の
  作った時刻を表示する・サーバーの時刻と比べる、をレシピに書く（読み口はクライアントの時計と比べない。PC の時計のずれを判定に入れないため）。
- 数えるのは「画面に出す値」になったもの（`parse` が値を返したもの）。keepalive のコメントや捨てた 1 件では戻さない。
- stale の真偽は配信 1 本ごと（どれかの種類の新しい値で戻る）。1 本に種類を混ぜる（§4.7）ときに種類ごとの古さが要るなら、アプリが値の時刻で見る（レシピに書く）。
- `staleAfterMs` の目安は「作る側の周期の 3 倍ほど」。server の側の前提は §4.5（作る側が周期ごとに送る）。

## 6. 試験の方針

- **Rust の単体（`sse.rs`）**: `SseFrame`（JSON・文字列・名前の検査で空 / CR / LF を断る）、`watch_frames`（開いた直後にいまの値・
  同じ値の `send` でも出る・`encode` が `None` なら出ない・送り手が消えたら終わる）、`broadcast_frames`（`Lagged` を飛ばす・`Closed` で終わる）。
  土台のループは、アプリの配信（`watch` の流れ + 名前つき）で、手動の期限（`Schedule::Manual`）を使って
  `Ok(None)` で閉じる／`Err`・時間切れでは閉じない／期限は終わりから／流れの終わりで閉じる、を確かめる。
  `SseContext`: `require_auth` の外では 500、内側で取り出せる、`counted_as_client` を呼んだときだけ数が増え、どう終わっても減る。
  結びつけ（§4.3）: `AuthState` を 2 つ立て、`SseContext` が確かめ直しに使うのは `require_auth` に渡したほうだけ、を確かめる。
  認可（§4.3.1）: 開くときに条件を満たさなければ 403 でフレームが 1 件も流れない／読み直しで外れたら閉じる／
  **条件を付けた配信は、`revalidate` または権限の読み直しが `Err`・時間切れなら 1 回目で閉じる**／同じ保存先の不調が続いても、
  条件の無い配信（`/api/events`）は開いたまま（連続の `Err` を受け入れの場合にする）／条件の無い配信は権限を読まない（読み取りの回数を数える）。
  上限（最大 20 秒）: 手動の期限と偽の時計で、最後に確かめ終えてから間隔 + 時間切れのうちに閉じていることを見る。
  停止（§4.4）: 確かめ直しが答えを待っている（待ちに入ったことを同期で知らせる保存先の代役）間に停止の知らせを出すと、
  時間切れ（5 秒）を待たずに閉じる。`/api/events` の経路でも同じ。
  #943 のレビューで足した分: 権限の読み取りを待たせたままログアウトすると、その確かめ直しで閉じる（同期の試験。
  同じ待ちの間に結びつきだけが変わった token は開いたまま）／開く処理（ハンドラー）を間隔より長く待たせ、その間に権限を外すと、
  200 で開いてもフレームは 1 件も流れずに閉じる／ルートの内側でヘッダーを別の token に書き換えても、確かめ直すのは
  `require_auth` が検証した token。`auth/tests.rs` でも、要求の認可と確かめ直しの両方で「権限の読み取り中の
  ログアウト・期限切れは許可しない」を見る。
- **Rust の既存の試験**: `events.rs`（確かめ直し・grant・時間切れ・飢えさせない、など）と `server.rs`（停止・接続数）は本文を変えずに通る（§4.4）。
- **Rust の統合（`tests/` の新しいファイル。crate の外から）**: 本物の `start` でアプリの配信を開き、
  ① `stop()` が `STOP_TIMEOUT` よりずっと短く戻る（完了の条件 2）。確かめ直しが保存先を待っている最中の `stop()` も同じ、
  ② 失効させた token の配信が次の確かめ直しで閉じ、つなぎ直しは 401、③ 複数の名前を 1 本に混ぜて届く、
  ④ `/api/events` と並べて開いたときの `sse_connections()`、⑤ **セッションを保ったまま権限だけを外す**と、
  `require_permission` を付けた配信は次の確かめ直しで閉じ、つなぎ直しは 403。並べて開いた `/api/events` は開いたまま（§4.3.1）。
  保存先が答えない状態を続けると、権限つきの配信は閉じ、つなぎ直しは 500、`/api/events` は開いたまま、
  ⑥ **作る側を止めたまま**つなぎ直すと、届く 1 件の印（作った時刻）が前と同じ（`watch_frames` の送り直しの契約。§4.5）。
  `tests/public_api.rs` に、`SseContext`・`SseFrame`・`sse_response`・`watch_frames`・`broadcast_frames` の可視性とシグネチャの固定を足す。
- **TS の単体（新しいファイル）**: `sse-message-parser`（名前あり・なし・複数の `event:`・CRLF・chunk をまたぐ・`data:` なしは出さない）、
  `sseStream`（任意の path・`parse` に名前が渡る・`null` と例外は捨てて続ける・401 / 消えた token / 入れ替わり / つなぎ直しの規則を
  `/api/events` 以外の path でもう一度・`onConnection` の真偽の順・止めた後は何も呼ばない）、stale（§5.5 の表を 1 行ずつ、偽の時計で）。
  持ち主の照合（§5.2.1 の ①〜⑤。`fetch` と `reader.read()` を手で明ける代役で、遅れた応答・遅れた読み取りを作る）。
  403（§5.2.2 の表を 1 行ずつ: 値あり → 同じ token で 403 → `onForbidden` が 1 回 → 続く 403 では呼ばない → 権限が戻って値が届き直す。
  `forbiddenRetryDelayMs` を渡さなければ間隔は `reconnectDelayMs`）。
  新しさ（§5.5）: 作る側を止めたまま（印が同じまま）つなぎ直しを繰り返しても `onStale(false)` が出ず、時計も掛け直されない／
  印が変われば戻る／名前ごとに印を覚える／`valueStamp` を渡さないときは送り直しで解ける（doc に書いた限界を、そのとおりに固定する）。
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
| S1（#935） | `crates/banto-server/src/sse.rs`（`SseContext`・`SseFrame`・`sse_response`・`watch_frames`・`broadcast_frames`、規則のループ、`Schedule` の引っ越し）。`require_auth` が非公開の結びつけを入れる（§4.3）。開いた後の認可（§4.3.1）。確かめ直しの途中の停止（§4.4）。`events.rs` を土台の上へ。`lib.rs` の再輸出。`tests/public_api.rs`・統合試験。ADR-0014 に権限の読み直しの 1 段落 | §6 の Rust の全部（権限だけを外す統合試験・確かめ直しの途中の `stop()` を含む）。既存の試験の本文を変えない。`cargo test -p banto-server`・`cargo fmt --check`・`cargo clippy`。依存を足さない（`Cargo.toml` が変わらない）。CHANGELOG [Unreleased]（追加） |
| S2（#936） | `sse-parser.ts`（`createSseMessageParser`）、`sse-stream.ts`（`createSseStream`・持ち主の照合と `onSessionChange`・403 と `onForbidden`・stale と `valueStamp`）、`events.ts` の provider を上へ、`index.ts` の輸出、admin-core の README に 1 節 | §6 の TS の全部（遅れた旧応答・旧読み取り、止めたままのつなぎ直しを含む）。`packages/admin-core/tests` の既存のファイルが差分に出ない。`pnpm check`・`pnpm lint`・`pnpm format:check`・`pnpm e2e`。external-consumer が緑。CHANGELOG [Unreleased]（追加） |
| S3 | `docs/recipes/app-sse-stream.md`（server とフロントを通した見本、1 画面 1 本・名前で分ける、作る側が周期ごとに送る・値に作った印を入れる、`valueStamp` と stale の出し方、`onSessionChange`・`onForbidden` で表示を消して権限が戻れば出し直す、権限つきの配信（層 + `require_permission`。確かめられなければ閉じる）、401 の配線、接続数）。README からの案内。この設計書へ決めた形を書き戻す | `pnpm format:check`。レシピのコードは S1・S2 の試験と同じ形（写して動くこと） |

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
   権限で守っている配信は、ハンドラーで `context.require_permission(..)` を付ける（付けないと、開いた後に権限が外れても続く。§4.3.1）。
4. **フロント**: 自前の読み口を `createSseStream` に置き換える。`event:` を使うなら `parse(data, event)` で分ける。
   stale の判定を `staleAfterMs` / `onStale` へ移し、値に作った印があれば `valueStamp` を渡す（無ければ作る側で入れる。§5.5）。
   `onSessionChange` と `onForbidden` で、その配信から受けた表示中の値を消す（§5.2.1・§5.2.2）。401 の配線（§5.4）を入れる。
5. 配信が複数あるなら、1 画面 1 本にまとめる（§4.7）。これは急がない（別の PR でよい）。
6. 自前の仕組みと、その試験を消す。

移る前後で、下流の画面から見える違い: 確かめ直しの間隔が banto の定数（15 秒）になる、
`require_auth` の外に置いていた配信があれば 500 になる（内側へ入れる）。

## 9. 危うい点

- **載せ替えで `/api/events` の規則を崩す**: 既存の試験の本文を変えないことを S1 の完了の条件にする（§4.4）。レビューは `select!` の順と `rearm` の位置を見る。
- **provider の載せ替えで時計の順が変わる**: 既存の試験のファイルを触らないことを S2 の完了の条件にする（§5.3）。
- **`SseContext` の「`require_auth` の内側」の判定**が、`require_auth` の入れる非公開の結びつけ（§4.3）に寄りかかる:
  `require_auth` がそれを入れなくなると全部 500 になる（開きすぎる側には倒れない）。単体試験で固定する。
- **権限つきの配信で `require_permission` を付け忘れる**: 層の `PermissionGuard` だけだと、開いた後に権限が外れても続く（§4.3.1）。
  型では防げないので、レシピの見本を「層 + `require_permission`」の組にし、S3 までに `verify-architecture` で
  「`require_permission` の層の内側で `sse_response` を呼ぶなら `SseContext::require_permission` も呼ぶ」を機械で見られるか確かめる。
- **権限が外れた画面が 403 のつなぎ直しを続ける**: 3 秒ごとに監査へ `denied` が積もる（§5.2.2。間隔は §10 の 13 で決める）。
- **呼ぶ側が `onForbidden` で値を消し忘れる**: 見る権限の無い値が残る。読み口からは表示を消せないので、レシピの見本と
  その試験（§5.2.2）で形を示す。`onForbidden` を渡さずに権限つきの配信を読む使い方は、レシピで「しない」と書く。
- **保存先の一時の不調で権限つきの配信が切れる**: 確かめられなければ閉じる（§4.3.1）ので、不調のたびに 1 度切れてつなぎ直す。
  値は消えない（切断・stale の扱い）。`/api/events` は切れないので、切断の帯（#637）は出ない。
- **持ち主の照合が既存の回数を変える**: 照合は「待ちの途中でセッションが変わった」継ぎ目だけに効くはずだが、既存の試験が
  その継ぎ目を固定していたら止めて確かめる（§5.2.1。§10 の 14）。
- **画面を開いて最初の 1 件の新しさ**は読み口では判定できない（§5.5 の「残る限界」）。レシピに書く。
- **`watch_frames` と遅い画面**: `watch` は最新の値だけを持つので、遅い画面は途中の値を飛ばす（現在値の配信では望ましい）。
  1 件も落とせない知らせは `broadcast_frames`（それでも `Lagged` は飛ばす）で、つなぎ直しの後は読み直す。レシピに書く。

## 10. 確かめたい点（オーナーの判断）

**決定（2026-11-25、オーナー）: 1〜16 のすべてを「推奨」の列のとおりにする。** 下の表は判断の記録として残す。

| # | 決めること | 推奨 |
| --- | --- | --- |
| 1 | server は案 1（部品の公開）か案 2（土台）か（§4.1） | **案 2 だけ**。`ShutdownSignal`・`SseConnections` は `pub(crate)` のまま。SSE でない長い応答の要望が出たら `ShutdownSignal` だけの公開を考える |
| 2 | `events.rs` を土台の上に載せ替えるか（§4.4） | **載せ替える**（規則を 1 か所に）。既存の試験の本文を変えないことが条件 |
| 3 | 土台に「同じ値の送り直し」を入れるか（§4.5） | **入れない**。作る側が周期ごとに `watch` へ送る（土台が送り直すと、作る側が止まったことを隠す）。レシピに書く |
| 4 | アプリの配信を「接続 n 台」に数えるか（§4.6） | **既定は数えない、`counted_as_client()` で数える**。別案: 全部数える（Issue の文字どおり。1 画面が 2 台になる）／種類ごとに別の数 |
| 5 | 確かめ直しの間隔・時間切れを配信ごとに変えられるようにするか（§4.3） | **しない**（定数のまま。失効が届く時間をどの配信でも同じにする） |
| 6 | `staleAfterMs` / `onStale` を入れるか（§5.5） | **S2 に入れる**。帯（#637）には出さず、アプリが値のそばに出す。新しさの判定は 12 |
| 7 | 401・消えた token をセッションの制御へつなぐ小さな関数（`sessionStreamHooks()`）を足すか（§5.4） | **足す**（2 行だが、`/api/events` を開かない画面で忘れると失効に気づかない）。`createSseStream` 自体は制御を知らないまま |
| 8 | 403 などの状態コードを読み口から知らせるか（§5.2） | 草案は「今は足さない」。開いた後の権限の取り消し（11）で 403 がふつうの経路になったので、**13 で決め直す** |
| 9 | パーサーの足し方（§5.1） | **`createSseMessageParser` を隣に足す**（`createSseParser` はその上に載せ、形を変えない） |
| 10 | 「1 画面 1 本・名前で分ける」を指針にするか（§4.7） | **する**（レシピに書く）。同時接続の上限は S3 までに実機で 1 度確かめる |
| 11 | 開いた後に権限が外れた配信をどうするか（§4.3.1） | **土台に読み直しの口を足す**（`SseContext::require_permission` / `reauthorize_with`。開くときは 403、開いた後は確かめ直しのたびに権限を読み直して閉じる。上限は 16。`/api/events` の規則は変えない）。別案: 権限つきの配信を S1 の対象外と明記し、口は後で足す（下流の配信が権限で守られているなら採れない）。補足: 開いた後に閉じたことを監査に書くか — **書かない**を推奨（つなぎ直しの 403 が `denied` を残す） |
| 12 | つなぎ直しで送り直された古い値を「復旧」にしない方法（§4.5・§5.5） | **読み口に `valueStamp` を足し、印が変わった値だけを「新しい値」と数える**（作る側が値に作った時刻を入れる。土台は封筒を強いない）。渡さないときの `onStale` は「受信が止まった」だけの指標と明記。別案: 明記とレシピだけ（判定をアプリごとに書くことになる）／土台が封筒（世代つき）を付ける（線の上の形を土台が決めることになる） |
| 13 | 403 を受けた読み口（§5.2.2・§9） | `onForbidden`（呼ぶ側が表示中の値を消す）は**入れる**（11 を採るなら要る。値を残さないため）。判断が要るのは間隔: **`forbiddenRetryDelayMs` を足し、既定は `reconnectDelayMs` と同じ**（既存の provider の時計は変わらない）にして、レシピで 30 秒ほどを勧める。別案: 既定から長くする（権限が戻ってから出るまでが延びる）／今のまま 3 秒ごとだけ（監査に `denied` が積もる）／403 でつなぎ直しを止める（権限が戻っても画面を開き直すまで戻らない） |
| 14 | 持ち主の照合と `onSessionChange`（§5.2.1） | **入れる**（S2）。遅れて届いた 401 は、token が変わっていれば `onUnauthorized` を呼ばない。既存の試験がこの継ぎ目の今の振る舞いを固定していた場合は、試験を直さずに止めて確かめる |
| 15 | 確かめ直しの途中でも停止を優先する直し（§4.4） | **S1 に入れる**（`/api/events` も受ける。今は確かめ直しの最中の `stop()` が最大 5 秒待つ） |
| 16 | 権限を確かめられない間（保存先の `Err`・時間切れ）の、権限つきの配信の上限（§4.3.1） | **1 回目の失敗で閉じる**（最後に確かめ終えてから最大 20 秒 = 間隔 15 秒 + 時間切れ 5 秒）。`/api/events` と条件の無い配信は #230 のまま閉じない。別案: 1 回は見逃して 2 回続いたら閉じる（最大 40 秒。一時の不調で切れにくいが、上限が延びる） |

決めた点（クロスレビュー `dd2b550c` を受けて。オーナーの判断は要らない見込み）:

- 確かめ直しに使う `AuthState` は `require_auth` が内部で結びつけ、`sse_response` は `AuthState` を引数に取らない（§4.3）。
- 開くときの認可の条件は、最初のフレームより前に評価する（fail closed。§4.3.1）。
- 読み口は、待ちが明けるたびに世代と token を照合してからコールバックを呼ぶ（§5.2.1）。
- 403 では `onSessionChange` が呼ばれないので、`onForbidden` で表示中の値を消す。stale は権限の代わりにしない（§5.2.2。再レビュー `b2e2090d`）。

未確定のまま残る点（実装で確かめる）: `SseContext` の拒否の本文の形（`ApiError` に合わせる）、`watch_frames` の `T` の境界（`Clone` が要るか）、
`SseFrame::event` を `&'static str` に絞れるか、`sessionStreamHooks` の置き場（`events.ts` か別ファイルか）、
HTTP/1.1 の同時接続の上限の実測（§4.7）、grant のセッションの権限の読み直し（`revalidate` は grant では保存先を読まない。
`require_permission` を付けた配信を grant で開いたときに、要求ごとの読み方と同じ結果になること）、
結びつけの型の名前と置き場（`auth` か `sse` か）、`require_permission` の付け忘れを `verify-architecture` で見られるか（§9）。
