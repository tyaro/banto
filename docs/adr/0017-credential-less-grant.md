# ADR-0017: 資格情報なしのセッション発行は「grant」に一般化し、閲覧公開をその 1 種類目、派生アプリの試運転を 2 種類目にする（認証を迂回する口は banto に作らない）

> English: [0017-credential-less-grant.en.md](0017-credential-less-grant.en.md)

- 状態: Accepted（オーナー決定 2026-10-02。実装は v2.2.0 の PR。細目の未決は本文「未決」節に列挙し、実装 PR で決める）
- 日付: 2026-10-02
- 関連: [ADR-0012](0012-lan-public-viewer-synthetic-session.md)（閲覧公開 = viewer 固定の合成セッション。本 ADR はこれを一般化する。supersede はしない）/
  [ADR-0014](0014-account-bound-session-revocation.md)（アカウント照合。grant セッションは対象外）/
  [ADR-0016](0016-session-controller-single-writer.md)・[docs/session-controller-design.md](../session-controller-design.md) §4.7・§6.2・I-13・I-21（`adopt()`/`end()` を deprecated にする）/
  [docs/viewer-public-plan.md](../viewer-public-plan.md) §2.2 / conventions §1・§6・§10 /
  派生アプリ: tyaro/banto-industrial の banto-hub「試運転モード」
- 対象コード: banto v2.1.1（`25f2291`）。本文の `ファイル:行` はこの版のもの

## コンテキスト

banto には「資格情報なしでセッションを得る」入口が 1 つある。閲覧公開（ADR-0012）の
`POST /api/auth/public-viewer` で、`server.viewer_public` が ON のとき
`{ id: "public", role: "viewer" }` 固定の bearer トークンを発行する
（`crates/banto-server/src/routes/auth.rs:95-105`、`crates/banto-server/src/auth.rs:890-926`）。
発行後は通常のログインと同じ `require_auth` + `RoleGuard` + 監査に乗り、アカウント照合
（ADR-0014）だけを飛ばす（`auth.rs:1131-1135`）。実装は閲覧公開に特化している:

- `TokenRecord.public_viewer: bool`（`auth.rs:424-425`）と
  `AuthenticatedSession.public_viewer: bool`（`auth.rs:255-262`）という **1 ビット**の出自。
- 公開トークンだけの FIFO `Inner::public_tokens`（`auth.rs:577`）と上限
  `MAX_PUBLIC_VIEWER_SESSIONS = 256`（`auth.rs:154`）。
- 発行の条件は handler に直書き（`routes/auth.rs:98`、`SettingsService::server_config().viewer_public`）。
- OFF にしたときの失効は `revoke_public_viewer_tokens`（`auth.rs:936-953`）を
  アプリの `save_server_config_locked` が呼ぶ（`apps/admin-template/src-tauri/src/lib.rs:2155-2166`）。
- クライアントは `publicViewerFallback`（`packages/admin-core/src/sessionController.svelte.ts:1150-1218`）、
  `AuthProvider.enterPublicViewer`・`status().viewerPublic`（`packages/admin-core/src/provider.ts:129,166-168`、
  `providers/http.ts:537-562`）、`kindOfResolvedAuth` は `identity.publicViewer` の印で
  `kind: 'publicViewer'` を導く（`sessionController.svelte.ts:225-229`）。

派生アプリ banto-hub（tyaro/banto-industrial）の「試運転モード」は、同じ「資格情報なしで
セッションを得る」要求を**別の形**で解いている: サーバーがロックダウンされるまでの間、
**全要求を認証なしで合成 admin として通す**独自の認可を 34 か所に持ち、画面側は
`SessionController.adopt()`/`end()`（設計 §4.7 S-44〜S-46、§6.2 の policy runner）で
provider を介さずに試運転セッションを確定する。この形には 2 つの問題がある:

1. **認証の迂回が派生アプリの 34 か所に散っている。** banto の `require_auth`・`RoleGuard`・
   監査・SSE の再検証（`crates/banto-server/src/events.rs:210`）のどれも通らない要求が
   存在し、ロックダウンの判定漏れがそのまま無認証の admin 面になる。conventions §6 の
   「認可は明示」「認証をバイパスする公開ルータは作らない」（ADR-0012 の案 B・C を退けた理由）
   を派生アプリで破っている。
2. **画面側の `adopt()` はトークンを持たないセッション**なので、`resolve()` が provider に
   聞けず（I-13）、ticket は epoch だけ（I-21）、SSE の 401 でも確認に行けない（S-45）。
   SessionController の「provider が 1 往復で答える」原則（ADR-0016）の例外を、利用者
   1 つのために controller 本体に抱えている。

決めるべきは「**派生アプリが『資格情報なしの admin 相当セッション』を必要とするとき、
banto は何を提供するか**」。制約:

- 迂回の口（「この条件のとき認証を飛ばす」フック）を banto に作らない。認可の入口は
  bearer 1 本のままにする（ADR-0012 の決定を弱めない）。
- 閲覧公開の既存の利用者（`--preset display`、派生アプリ 2 本）を壊さない。v2.1.1 → **minor**。
- 発行の条件・上限・失効・寿命は閲覧公開と同じ型で表せる（違うのは identity と条件だけ）。

## 決定

**閲覧公開の「条件つき・資格情報なしのトークン発行」を `grant` として一般化し、閲覧公開を
その 1 種類目（`publicViewer`）、派生アプリの試運転を 2 種類目（アプリ定義、例 `commissioning`）
にする。** grant は「発行」だけを一般化し、発行後は従来どおり通常の bearer セッションとして
`require_auth` + `RoleGuard` + 監査 + SSE 再検証に乗る。迂回の口は作らない。
画面側は `adopt()`/`end()` を使わず、閲覧公開と同じ fallback（grant を取りに行き、provider が
答える）で試運転セッションを確定する。

### 1. 版と互換（minor、v2.2.0）

追加のみで、既存の名前はすべて薄いラッパ／エイリアスとして残す（一覧は「互換性」節）。
派生アプリは `@banto/admin-core`・`banto-server` を v2.2.0 に上げるだけで従来どおり動き、
grant を使う側だけが新 API に移る。

### 2. サーバー（`crates/banto-server`）

```rust
/// grant の種類。アプリが定義する開いた集合（閉じた enum にしない）。
/// `[A-Za-z][A-Za-z0-9_-]{0,31}`。URL・status・identity.kind・client の SessionKind で同じ文字列を使う。
pub struct GrantKind(/* Arc<str> */);
impl GrantKind { pub const PUBLIC_VIEWER: &str = "publicViewer"; }

pub type GrantCondition =
    Arc<dyn Fn() -> BoxFuture<'static, Result<bool, BantoError>> + Send + Sync>;

pub struct GrantSpec {
    pub kind: GrantKind,
    /// 固定。発行口は identity/role を受け取らない（ADR-0012 と同じ昇格経路なしの性質）。
    pub identity: Identity,
    /// 発行の条件。要求ごとに評価する（閲覧公開は `server_config().viewer_public`）。
    pub enabled: GrantCondition,
    /// 種別ごとの FIFO 上限。既定 256（`MAX_PUBLIC_VIEWER_SESSIONS` と同値）。超えたら最古を失効。
    pub max_sessions: usize,
    /// `None` = `AuthState` の既定 `token_policy`（8h / idle 1h）。remembered は常に false。
    pub policy: Option<TokenPolicy>,
    /// true なら発行口は peer が loopback でないとき 403。
    pub require_loopback_peer: bool,
}

impl AuthState {
    pub fn issue_grant_token(&self, spec: &GrantSpec) -> String;
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize;
}
```

- `TokenRecord.public_viewer: bool` → `grant: Option<GrantKind>`（`auth.rs:424-425`）。
  `Inner::public_tokens: VecDeque<String>`（`auth.rs:577`）→ `HashMap<GrantKind, VecDeque<String>>`
  （種別ごとの FIFO。閲覧公開の上限・最古追い出し・「実ログインは巻き込まない」
  `auth.rs:2641-2690` のテストはそのまま種別ごとに成り立つ）。
- `AuthenticatedSession`（`auth.rs:255-262`）は `grant: Option<GrantKind>` を持ち、
  `GET /api/auth/identity` の JSON は `Identity & { publicViewer: bool, kind: string }`
  （`publicViewer = grant == PUBLIC_VIEWER`、`kind = grant の文字列 | "account"`）。
  Rust の struct リテラルの互換は「未決 1」。
- アカウント照合の分岐（`auth.rs:1131-1135` の `if session.public_viewer`）は
  `if session.grant.is_some()` に。grant セッションは stamp を持たず、`SessionLookup` を
  引かない（ADR-0014 の対象外。固定 identity なので再読の対象が無い）。
  SSE の再検証 `revalidate`（`auth.rs:1114-1119`、`events.rs:210`）は同じ関数を通るので、
  `revoke_grant_tokens` の後の次の再検証でストリームが終わる（`events.rs:702-713` のテストを
  grant に一般化）。
- `change-password` の拒否（`routes/auth.rs:227`）は `grant.is_some()` に。
  grant セッションは資格情報の持ち主ではない（同名のアカウントがあっても対象にしない）。
- **発行口** `POST /api/auth/grant/{kind}`（新設。`X-Banto-Client` 必須は `crate::csrf` で従来どおり）。
  順に: 登録されていない `kind` → 404 `not_found`；`require_loopback_peer` かつ peer が
  loopback でない**または peer が分からない** → 403 `forbidden`（fail closed）；
  `enabled()` が `Ok(false)` → 403、`Err` → その `BantoError`（`ApiError`）；
  通れば `issue_grant_token` → `{ success: true, token }`（閲覧公開と同じ応答形）。
  **発行は監査しない**（既存方針、`routes/auth.rs:88-94`）。
  `POST /api/auth/public-viewer` は `/api/auth/grant/publicViewer` のエイリアスとして残す。
- **peer の検査**: `ConnectInfo<SocketAddr>` は `BoundServer::serve` が
  `into_make_service_with_connect_info::<SocketAddr>()` で常に供給する
  （`crates/banto-server/src/server.rs:128-131`）。到達経路は 3 つで全部これを通る —
  banto-serve の `server::start`（`server.rs:174`）、Tauri 組み込みサーバ
  （`apps/admin-template/src-tauri/src/lib.rs:1887` の `bound.serve(router)`）、
  テストの `BoundServer`。**供給されないのは `tower::oneshot` で直接 router を叩くテストだけ**
  （`auth.rs:1515-1536` の `MaybePeerAddr` が `None` を返す経路）。だから設計上は
  「peer 不明 = 403」で閉じてよく、`rest/tests.rs` 側は `req.extensions_mut().insert(ConnectInfo(addr))`
  で明示する。loopback 判定は IPv4 射影 IPv6（`::ffff:127.0.0.1`）も loopback に数える
  （`server.rs:264` 付近の正規化と同じ扱い。IPv6 自体は対象外）。
- `/api/auth/status`（`routes/auth.rs:37-66`）に `grants: { <kind>: bool }` を追加。各 kind の
  値は「**この要求がいま発行を受けられるか**」= `enabled()` かつ（`require_loopback_peer` なら）
  peer が loopback。`viewerPublic` は `grants.publicViewer` と同値のまま残す（エイリアス）。
  `enabled()` の `Err` はその kind を `false` にする（status は失敗させない。閲覧公開の
  「読めなければ発行しない」と同じ fail closed）。
- `extra_auth_router`（`routes/auth.rs:296-320`）に `grants: Vec<GrantSpec>` を渡す新しい版を
  足す（Rust に多重定義は無いので別名。例 `extra_auth_router_with_grants`。名前は実装 PR で）。
  旧シグネチャは `vec![GrantSpec::public_viewer(settings.clone())]` を補うラッパ。
  `GrantSpec::public_viewer(settings: SettingsService) -> GrantSpec` は閲覧公開の仕様
  （identity `public`/`viewer`、条件 `server_config().viewer_public`、上限 256、
  `require_loopback_peer: false`）をそのまま持つ。派生アプリは `extra_auth_router` を
  **コピーして持っている**（banto-hub `core/src/rest.rs`、chronogazer `core/src/rest.rs`）ので、
  発行口と status の `grants` を組み立てる部品（grant の registry と router）は
  `pub` にし、コピー側が merge できる形にする。
- `issue_public_viewer_token()` / `revoke_public_viewer_tokens()`（`auth.rs:890,936`）は
  `issue_grant_token(&GrantSpec::public_viewer_fixed())` / `revoke_grant_tokens(&PUBLIC_VIEWER)`
  の薄いラッパ。`PUBLIC_VIEWER_ID`・`MAX_PUBLIC_VIEWER_SESSIONS` は残す。
- **失効と監査**: 条件を閉じる操作（閲覧公開 OFF、試運転のロックダウン）が
  `revoke_grant_tokens(kind)` を呼び、戻り値 `usize` を自分の監査 `detail` に
  `revokedGrants: n` として足せるようにする（発行は監査しない代わりに、閉じた側に件数を残す）。
  テンプレートの `save_server_config_locked`（`src-tauri/src/lib.rs:2160-2165`）は
  `revoke_grant_tokens(&PUBLIC_VIEWER)` に置き換える。

### 3. ユーザー削除の自己削除ガード

`routes/users.rs:69-84` の `acting_user` は token → `identity_for` → `users.get_by_username`
で呼び手の行を解決するが、grant セッションの固定 identity はアカウントを持たないので
`Unauthorized` になり、admin 相当の grant（試運転）がユーザーを削除できない。
**grant セッションは「acting id を持たない」扱いで自己削除ガードを通す**分岐を banto に入れる:
`require_auth` が extensions に入れた `AuthenticatedSession`（`auth.rs:1562-1573`）を読み、
`grant.is_some()` なら acting id を `None` に、そうでなければ従来どおり行 id を引く。
`UsersService::delete_user(id, acting_user_id: i64)`（`crates/banto-admin-services/src/users.rs:843`）
は `Option<i64>` を取る版を足し、既存のシグネチャはラッパで残す。「最後の admin は消せない」
ガード（`ensure_admin_removal_allowed`）は grant でも効く。

### 4. クライアント（`@banto/admin-core`）

- `AuthProvider.status()` → `{ initialized, viewerPublic?, grants?: Record<string, boolean> }`。
  HTTP provider（`providers/http.ts:434-456`）は `grants` が無い古いサーバーでは
  `grants: {}`（`viewerPublic` と同じ fail closed）。
- `AuthProvider.enterGrant?(kind, { expectRevision })` を追加。HTTP provider は
  `POST /api/auth/grant/{kind}` を叩き、`enterPublicViewer`（`http.ts:537-562`）と**同じ
  compare-and-set**（開始時に token が無いこと・revision が `expectRevision` のまま）で
  保存する。`enterPublicViewer` は `enterGrant('publicViewer', …)` のラッパ。
  Tauri provider・demo provider は従来どおり未実装（閲覧公開と同じ理由、`provider.ts:154-164`）。
- `publicViewerFallback(controller, provider, ticket, { maxRetries })`
  （`sessionController.svelte.ts:1150-1218`）を
  `grantFallback(controller, provider, ticket, { kind, available?, maxRetries? })` に一般化。
  `available(status)` は既定 `status.grants?.[kind] === true`。ループの形（`status()` →
  `isCurrent(ticket)` → `enterGrant({ expectRevision })` → `resolveSettled()`、失敗は再試行しない、
  `superseded` のときだけ上限つきでやり直す）は変えない。`publicViewerFallback` は
  `kind: 'publicViewer'`、`available: s => s.viewerPublic === true || s.grants?.publicViewer === true`
  のラッパ。
- `Identity.kind?: string` を追加（発行元が返す。`identity.publicViewer` と同じく発行元の印）。
  `kindOfResolvedAuth`（`sessionController.svelte.ts:225-229`）は **サーバーの `identity.kind`
  を最優先**、無ければ従来の順（`identity.publicViewer === true` → `'publicViewer'`、
  provider の `kind`、`'account'`）。Tauri の `'local'` は identity に `kind` が無いので従来どおり。
- `sessionOwnerKey`（`sessionController.svelte.ts:200-213`）: grant の kind（`identity.kind` が
  `publicViewer`・`account` 以外）は **kind 単独のキー**（例 `commissioning`。固定 identity なので
  id を足しても情報が増えない）。`publicViewer` → `public-viewer`、`local` → `local`、
  `account:${id}` は不変。`adopt()` で確定した kind（`identity.kind` が無い）は v3 まで
  従来の `${kind}:${id}`。banto-hub が adopt → grant に移ると保存状態の owner が
  `commissioning:commissioning` → `commissioning` に 1 回だけ変わる（一覧の保持状態が
  1 回読めなくなるだけで、消えはしない）。
- owner 変化の比較は `kind === 'account'` の active だけ（S-108、v2.1.1 #308）なので変更なし。
  grant セッションは「端末／アプリの状態」であり「別のユーザー」ではない。
- **`adopt()`/`end()` は v2.2 で `@deprecated`**（利用者は banto-hub の
  `commissioningPolicy.ts` だけ）、**v3 で削除**。I-13・I-21 と §4.7 S-44〜S-46・§6.2 の
  policy runner は「grant に置き換え、adopt は deprecated」の注記を付ける
  （[session-controller-design.md](../session-controller-design.md)）。grant 化した試運転は
  S-42 と同じ経路（provider が答える、ticket は revision を持つ、SSE 401 で確認に行ける）に
  なり、controller の adopt 専用分岐（§5.1 手順 0〜7 の「adopt 中」列）は v3 で消える。

### 5. 派生アプリ側の取り決め（参考。banto の規約ではない）

banto-hub がこの ADR で決めた形（banto には規約として置かない。移行 PR の設計の出発点）:

- ロックダウンは「フラグ保存の直後、**同じ関数内**で `revoke_grant_tokens("commissioning")`」
  （閲覧公開 OFF の `save_server_config_locked` と同じ型。保存と失効の間に要求を挟ませない）。
- ログアウトはトークンを捨てるだけ。試運転中は次の遷移で `grantFallback` が無言で再発行する
  （試運転は「ログアウト」で終わらない。終わるのはロックダウンだけ）。
- elev（昇格）で試運転に戻しても、既存トークンは失効させない。
- bootstrap の自己発行（Rust 側）は試運転の admin grant を `issue_grant_token` で行う。
- `max_sessions` は閲覧公開の 256 より小さくしてよい（admin 相当のトークンの数は少ないほどよい）。

## セキュリティ

- **入口が 1 ルートに縮む。** 「認証なしで通る要求」は `POST /api/auth/grant/{kind}` の
  発行だけになり、その後は bearer として既存の `require_auth`・`RoleGuard`・監査・SSE 再検証
  （`events.rs:210`）に例外なく乗る。派生アプリの 34 か所の迂回は、trust の判断を
  1 か所（`GrantSpec.enabled`）に集めることで消せる。
- **条件が明示される。** 何が発行を許すかは `GrantSpec`（kind・固定 identity・条件・上限・
  寿命・loopback）に全部書いてあり、レビューはまずそこを見る。閲覧公開の「identity/role を
  引数に取らない」（`auth.rs:872-877`）はそのまま: 発行口はクライアントから identity も role も
  受け取らない。
- **種別ごとの失効。** `revoke_grant_tokens(kind)` は該当 kind だけを消し、実ログイン・他の
  grant を巻き込まない（`auth.rs:2595-2612` のテストの一般化）。`AuthState` はサーバー
  再起動をまたいで共有される（`lib.rs:2162` のコメント）ので、条件を閉じる操作は必ず失効も行う。
- **寿命は既定のまま**（8h / idle 1h、remembered にしない）。切れたら画面が黙って取り直す
  （閲覧公開と同じ。`auth.rs:2629` のテストの一般化）。長生きトークンを配らない。
- **ストリームの再検証は 1 経路。** `revalidate` → `authenticate_with` → `session_for_with`
  なので、失効後の次の再検証で grant のストリームも閉じる。adopt 方式ではここが効かなかった。
- **注意点 1: ブラウザに admin 相当の bearer が保存される。** 試運転 grant のトークンは
  閲覧公開と同じく `sessionStorage` に入る。ロックダウン後にそれが使えてはならないので、
  **派生アプリは「ロックダウン → 直後の要求が 401 → SSE が閉じる」をテストで固定する**
  （banto 側は `revoke_grant_tokens` の単体テストと SSE の再検証テストまで）。
- **注意点 2: `require_loopback_peer` を付けないと、保護は起動時の bind 制約だけ。**
  試運転 grant を `require_loopback_peer: false` で LAN bind のサーバーに載せると、LAN の
  誰でも admin 相当のトークンを得る。banto は条件を強制しない（アプリの `GrantSpec` が決める）
  ので、ADR の帰結として派生アプリの移行 PR のレビュー項目に置く。
- **注意点 3: リバースプロキシ（ADR-0003）の背後では peer はプロキシ。** 同一ホストの
  プロキシ経由だと全要求が loopback に見え、`require_loopback_peer` は保護にならない。
  `X-Forwarded-For` は偽装できるので見ない。→「未決 3」。
- 監査: 発行は監査しない（既存方針）。grant セッションの操作は固定 identity の id が actor
  として残る（閲覧公開の `public` と同じ）。ui-settings は `ui.<identity.id>.*` を同じ kind の
  端末で共有する（`routes/ui_settings.rs:31-36`。閲覧公開の `ui.public.*` と同じ性質）。

## 互換性

**判定: minor（v2.2.0）。** 追加・一般化のみで、ワイヤ・TS・Rust の既存の名前はすべて残す。

| 既存の名前                                                                           | v2.2 での扱い                                                                                    | v3                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `POST /api/auth/public-viewer`                                                       | `/api/auth/grant/publicViewer` のエイリアス                                                      | 残す（閲覧公開の名前として）               |
| `GET /api/auth/status` の `viewerPublic`                                             | `grants.publicViewer` と同値で残す                                                               | 残す                                       |
| `GET /api/auth/identity` の `publicViewer`                                           | `kind === "publicViewer"` と同値で残す。`kind` を追加                                            | 残す                                       |
| `AuthState::issue_public_viewer_token` / `revoke_public_viewer_tokens`               | `issue_grant_token` / `revoke_grant_tokens` の薄いラッパ                                         | 削除候補                                   |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`               | 新版（`grants: Vec<GrantSpec>` 付き）を呼ぶラッパ。`GrantSpec::public_viewer(settings)` を補う   | 削除候補                                   |
| `AuthenticatedSession.public_viewer`                                                 | 「未決 1」                                                                                       | `grant` のみ                               |
| `UsersService::delete_user(id, i64)`                                                 | `Option<i64>` 版へのラッパ                                                                       | 削除候補                                   |
| `publicViewerFallback` / `DEFAULT_PUBLIC_VIEWER_RETRIES`                             | `grantFallback` のラッパ                                                                         | 削除候補                                   |
| `AuthProvider.enterPublicViewer` / `status().viewerPublic`                           | `enterGrant('publicViewer')` / `grants.publicViewer` のラッパ・エイリアス                        | 残す（provider 契約の一部）                |
| `Identity.publicViewer`                                                              | 残す（`kind` を追加。`kindOfResolvedAuth` は `kind` 優先）                                       | 残す                                       |
| `SessionController.adopt()` / `end()`                                                | **`@deprecated`**（利用者は banto-hub の `commissioningPolicy.ts` だけ）                         | **削除**（I-13・I-21 と adopt 中の分岐も） |
| `verify-architecture` rule 8 の `REST_ONLY`（`scripts/verify-architecture.mjs:326`） | `POST /api/auth/grant/{kind}` を足す（Tauri 窓に「grant に入る」操作は無い。閲覧公開と同じ理由） | —                                          |

`conventions §6` の「合成 viewer セッション」項と `viewer-public-plan §2.2` の規約本文は、
実装 PR で「grant（閲覧公開はその 1 種類）」に書き換える（本 ADR は判断、規約本文は conventions）。

## 検討した代替案

- **案 A（採用）: 閲覧公開の発行を grant に一般化し、試運転を 2 種類目にする。**
  利点: 認証なしの入口が発行の 1 ルートに縮む。条件・上限・失効・寿命・再検証が閲覧公開と
  同じコードで効き、テスト（`auth.rs:2550-2700`、`rest/tests.rs:3023-3160`、
  `events.rs:702`）が kind をパラメータにした一般化で済む。画面側は `adopt()` の例外経路が
  消えて S-42 の 1 本になる。欠点: admin 相当の bearer がブラウザに置かれる（注意点 1）。
  `GrantSpec` に書かれた条件が弱ければそのまま弱い（注意点 2・3）— ただしそれは「迂回が
  34 か所にある」今より検査しやすい。
- **案 B（不採用）: `require_auth` に「条件が真なら認証を飛ばして合成 identity を入れる」
  フックを足す**（banto-hub の今の形を banto に移す）。
  ADR-0012 の案 C と同じ理由で退ける: ミドルウェアに「暗黙の identity」分岐が入り、
  `actor_identity`/`identity_for`（`routes/mod.rs:93`）がトークン前提で書かれている所に
  第 2 の経路が生える。SSE の再検証（トークン単位）が効かず、ロックダウンの「即時失効」が
  `revoke_*` 1 回で表せない。失効の対象（トークン）が無いので「切れたら取り直す」も無い。
  verify-architecture の外側が増える。
- **案 C（不採用）: 何もしない（派生アプリが独自に持ち続ける）。**
  34 か所の迂回と `adopt()` の controller 内の例外分岐（§5.1 手順 0〜7 の「adopt 中」列、
  I-13・I-21、S-44〜S-71）を banto が利用者 1 つのために保守し続ける。試運転の終了が
  SSE の再検証・401 で確認できないまま（S-45）。banto-industrial の「重複実装は banto に
  寄せる」方針にも反する。
- **案 D（不採用）: 試運転専用の 2 本目の発行口（`/api/auth/commissioning`）を banto に足す。**
  閲覧公開と条件・identity 以外が同じコードの複製になり、3 種類目が来たらまた複製する。
  banto が派生アプリのドメイン語（試運転）を持つことにもなる。一般化（案 A）の方が小さい。

## 帰結

- **grant の発行口はクライアントから identity も role も受け取らない。** `GrantSpec.identity`
  は固定で、発行口は `kind` しか受けない。レビューはまずここを見る（ADR-0012 と同じ）。
- **条件を閉じる操作は必ず `revoke_grant_tokens(kind)` を同じ関数内で呼ぶ。** 発行の条件
  （`enabled`）と失効の呼び出しは対になる（テンプレートは閲覧公開 OFF、派生アプリは
  ロックダウン）。監査の detail に `revokedGrants: n` を足せる。
- **admin 相当の grant は `require_loopback_peer: true` と小さい `max_sessions` を既定にする**
  （派生アプリの移行 PR のレビュー項目）。
- 画面側の試運転は `grantFallback` + provider の答えで確定する。`adopt()`/`end()` は
  deprecated。v3 で削除するまで controller の adopt 分岐はそのまま保つ（v2.2 では挙動を
  変えない）。
- 新しい kind を足すのは `GrantSpec` を 1 つ足すだけで、banto のルート・verify-architecture の
  分類は増えない（`/api/auth/grant/{kind}` が 1 本）。
- テスト（S 番号の方針）: session-controller-design.md の S 番号は **S-109 以降**を
  grant に充てる（S-42 の kind 一般化、S-44〜S-46 の grant 版、「失効 → 401 → fallback が
  黙って取り直す」、「条件 false → 403 → `none` のまま」）。Rust は `auth.rs` の
  `public_viewer_*` テストを kind パラメータ化、`rest/tests.rs` に `grant/{kind}` の
  404／loopback 403／条件 403／発行 → identity の `kind`、`users_delete` を grant セッションで、
  `events.rs` に revoke 後の再検証でストリームが閉じること。E2E
  `e2e/tests-public-viewer/public-viewer.spec.ts` は従来どおり通る（エイリアス）。

## 未決（実装 PR で決める。勝手に決めない）

1. **`AuthenticatedSession.public_viewer` フィールドの扱い。** オーナー決定は
   `public_viewer: bool → grant: Option<GrantKind>` だが、`AuthenticatedSession` は全フィールド
   `pub` の struct で、**派生アプリが struct リテラルで構築している箇所がある**
   （banto-hub `core/src/stream.rs:1670-1676` のテスト）。フィールドの改名・追加はどちらも
   外部のリテラル構築を壊すので、Rust 側は厳密には minor でない。候補: (a) 改名して
   `pub fn public_viewer(&self) -> bool` を足し、リテラル構築の破壊は CHANGELOG に明記して
   受け入れる（banto-hub の 1 か所だけ。移行 PR で直す）；(b) `public_viewer` を残し
   `grant` を**追加**する（追加でもリテラルは壊れる。整合性の負担が増える）；
   (c) `#[non_exhaustive]` + コンストラクタ（これも 1 回は壊れる）。推奨は (a)。
2. **`extra_auth_router` の新版の名前と、コピー側が merge する部品の形**
   （`GrantRegistry` + `grant_router(auth, registry)` か、`extra_auth_router_with_grants` 一本か）。
   banto-hub・chronogazer は `extra_auth_router` をコピーして持つので、部品が `pub` でないと
   handler を再複製することになる。
3. **同一ホストのリバースプロキシ配下の `require_loopback_peer`。** 全 peer が loopback に
   見えて保護にならない。候補: 文書化のみ（「admin 相当の grant をプロキシ配下で有効にしない」）／
   `trusted_proxies` を `GrantSpec` に足して `X-Forwarded-For` を信頼する（依存は増えないが
   面が増える）。推奨は文書化のみ（IPv6 と同じく実需が出るまで）。
4. **grant kind の識別子**を URL・status・`identity.kind`・client の `SessionKind` で
   同じ文字列（`publicViewer` のような camelCase）にすること。URL に camelCase が入るのが
   既存ルートの流儀（kebab-case）と違う。エイリアス `/api/auth/public-viewer` を残すので
   実害は無いが、`/api/auth/grant/public-viewer` のような kebab を別に受けるかは実装 PR で。
5. **`status().grants` を `require_loopback_peer` 込みで評価すること**（本文では「この要求が
   発行を受けられるか」と決めた）。条件だけを返す方が単純だが、LAN の端末が 403 を取りに
   行く無駄が出る。本文の形を推奨。
6. `UsersService::delete_user` の `Option<i64>` 版の名前（`delete_user_by`／既存を変えて
   ラッパ）。派生アプリは `UsersService` もコピーしている（banto-hub `core/src/users.rs:634`）
   ので、banto 側の変更はテンプレート取り込み（経路 B）で届く。
