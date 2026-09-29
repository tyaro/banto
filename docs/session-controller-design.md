# SessionController 設計（Issue #260）

- 状態: 設計案（実装前。§9 の判断点はオーナーの決定済み 2026-09-29、同日のレビュー 10 件を反映）
- 日付: 2026-09-29
- 関連: Issue #260・#255・#257・#258・#259・#241・#204 / ADR-0016 /
  ADR-0014（アカウントに結び付けた失効）/ ADR-0012（合成 viewer セッション）/
  spec §3.3・§8.1 / conventions §10
- 対象コード: banto `019f6e9`（#255 マージ後の main）

このドキュメントは、admin-core のセッションの確定を 1 か所（SessionController）に
寄せるための**設計**を書く。決定の記録は [ADR-0016](adr/0016-session-controller-single-writer.md)、
ここには不変条件・競合のシナリオ・API の案・移行と実装の分割・テストの設計を置く。
実装の PR は、このドキュメントのシナリオ番号（S-n）と不変条件番号（I-n）をテスト名から
参照する。

## 1. 今のコードの事実（診断の裏付け）

Issue #260 本文の診断を、`019f6e9` のコードで確かめた結果。**推測には（推測）と付ける。**

### 1.1 セッションの状態を書く場所が 4 か所ある

| 場所                                                | 書くもの                            | 何を根拠に書くか                                                         |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `sessionGate.ts` `resolveProtectedSession`          | `endSession()`                      | `check()` が `false`、かつ開始時の scope が今も current                  |
| `sessionLifecycle.ts` `establishSession`            | `beginSession(identity)` と `apply` | `getIdentity()` の答え、かつ sequence と scope が current                |
| `sessionEnded.ts` `runConfirmation`                 | `endSession()` と listener 通知     | `check()` が `false`、かつ scope が current、かつ通知の重複なし          |
| アプリ（`Header.svelte`・`commands.ts`）            | `endSession()`                      | `logout()` が完了した後（照合なし）                                      |
| アプリ（`session.svelte.ts` `sessionStore.load()`） | identity・role・publicViewer        | `establishSession` の `apply` の中（6 回目のレビューで同じ継続に移した） |

`transitionSessionScope` 自体は 1 か所（`sessionScope.svelte.ts`）だが、それを呼ぶ判断は
上の 4 か所に散っていて、それぞれが「開始時の scope を覚えて後で照合する」処理を持つ
（`sessionGate.ts` 51-68 行、`sessionLifecycle.ts` 114-125 行、`sessionEnded.ts` 121-165 行）。
#255 の 5〜6 回目の指摘は、この照合の抜け（別の継続に分かれていた）だった。

### 1.2 provider の答えは「どの資格情報についての答えか」を持たない

- HTTP: `check()`（`providers/http.ts` 285-289 行）と `getIdentity()`（298-313 行）は、
  それぞれ呼ばれた瞬間の `getToken()` で別々に往復する。`check()` は `401`/`200 false`
  で `clearTokenIfCurrent(token)` を呼ぶ（223・235 行）＝ **確認に資格情報を消す副作用がある**。
  `getIdentity()` は `200 null` でもトークンを消さない。
  `login`・`setup`・`enterPublicViewer` の `setToken(...)`（256・355・404 行）と `logout` の
  `setToken(null)`（267 行）は**無条件**。#259 はこの `enterPublicViewer` の無条件書き込みを
  指している。
- Tauri: `check()`/`getIdentity()` は `auth_check`/`auth_identity` を別々に呼ぶ
  （`providers/tauri.ts` 127-134 行）。答えは呼んだ時点の Rust 側 `state.auth` について。
- 「check は成功、identity だけ 500」は、この 2 往復から生まれる（`sessionRaces.test.ts`
  242-283 行が再現している）。

**REST の `GET /api/auth/identity` はすでに 1 往復で足りる答えを返している**
（`crates/banto-server/src/auth.rs` 1483-1509 行）。`identity_handler` は
`authenticated_session` → `AuthState::authenticate(token)` を通り、`require_auth` と同じ
再検証（#204、ADR-0014）を行う。答えは次の 3 つ:

- `200` で identity（`Identity & { publicViewer }`）: 有効。
- `200 null`: トークンが無い、または**失効している**（`authenticate` が `None`）。失効した
  トークンは `401` ではなく `200 null` で返る。
- それ以外（`500`・到達不能）: 確認できない。

つまり provider の `resolve()` は、この 1 ルートを 1 回呼べばよい（§2.1、§5.2。
オーナーの決定 3）。

### 1.3 Tauri の Rust 側：非同期の処理の後に認証状態を無条件で上書きしている箇所

`apps/admin-template/src-tauri/src/lib.rs`（`019f6e9`）。`AppState.auth` は
`Mutex<Option<DesktopSession>>`（67 行）で、書き込みの世代や操作の識別子は持たない。

| コマンド                                   | 行      | 直前の `.await`                                              | 書き方                                                                                                                                     |
| ------------------------------------------ | ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth_login`                               | 646-647 | `users.verify(...)`（argon2 の検証、遅い）→ `record_ok(...)` | `*state.auth.lock() = Some(Account(identity))`：**無条件**                                                                                 |
| `auth_setup`                               | 622-623 | `users.setup_first_user(...)` → `record_ok(...)`             | 同上：**無条件**                                                                                                                           |
| `auth_logout`                              | 690-691 | `settings.auth_config()`                                     | `previous = lock().clone()` → `*lock() = None`：**無条件**（2 回の別ロック）                                                               |
| `auth_config_apply_body`（参考：正しい形） | 902-906 | `settings.set_auth_config(...)` ほか                         | `if auth.is_none() { *auth = Some(..) }` を 1 つのロックの中で（PR #182 の指摘）                                                           |
| `change_own_password`（参考：正しい形）    | 752-757 | `users.change_password(...)`                                 | `id` と `auth_epoch` が一致するときだけ `auth_epoch` を進める（compare-and-set）                                                           |
| `settle_session`（参考：正しい形）         | 309-326 | （`current_session` の DB 読み出しの後）                     | `unchanged`（`cached` と一致）のときだけ消す。**有効なら毎回 `*auth = valid.clone()` で refresh する**（同じ結び付きの role・name の更新） |

壊れる順序（オーナーの指摘。Rust 側だけで成立する。フロントの await の有無に依らない）:

1. **遅いログインが、完了済みのログアウトを取り消す**:
   `auth_login(B)` が `verify().await` で待つ → `auth_logout` が完了（`auth = None`）→
   `auth_login` が再開し 646 行で `auth = Some(B)`。Rust 側のセッションが復活する。
   フロントはログイン画面にいるが、次に保護ルートへ行くと `auth_check` が `true` を返す。
2. **遅いログアウトが、その後に確定したログインを消す**:
   `auth_logout` が `auth_config().await` で待つ → `auth_login(B)` が完了（`auth = Some(B)`、
   フロントは B として画面を出す）→ `auth_logout` が再開し 690-691 行で `previous = Some(B)`、
   `auth = None`。B の Rust 側セッションが消え、次のコマンドが `Unauthorized` になる
   （監査には B の `logout` が記録される）。
3. `auth_setup` は 1 と同じ形（初回のセットアップだけなので頻度は低いが、コードは同じ）。

いずれも、**書き込みが「操作を始めたときの状態」と照合していない**ことが原因で、
`auth_config_apply_body`・`change_own_password`・`settle_session` はすでに照合している。
同じ形に揃えるのが §5.3 の案。

Tauri には公開閲覧のセッションの発行は無い（`auth_status` は `viewer_public: false` 固定、
594-600 行。`createTauriAuthProvider` は `enterPublicViewer` を持たない）。
`run()` の起動時の自動ログイン（2367 行〜）はコマンドを受け付ける前に決まるので、競合しない。
ログイン不要モード（auth-disabled）の合成 identity は Rust が持ち、`auth_identity` は
呼ばれるたびに `current_session` → `read_session_source`（270-279 行）でモードと権限を
読み直す。**フロントが合成する必要は無い**（オーナーの決定 4）。一方、フロントの
`sessionStore.authDisabled` は `load` の中で `getAuthSettings()` を await した後に**照合なしで代入**
している（`session.svelte.ts` 91-95 行）＝ §4.9 の洗い出しで見つけた同じ型（S-61）。

### 1.4 REST 側（`crates/banto-server/src/auth.rs`）には共有の 1 スロットが無い

`AuthState` はトークンごとの map（`tokens: RwLock<HashMap<String, TokenRecord>>`、495 行）。
`login`/`issue_*` は新しいトークンを**追加**し（858-890 行）、`logout(token)` は**そのトークン
だけ**を消す（904 行、`logout_handler` 1471-1476 行）。遅い応答で別のセッションを消す形は
REST のサーバ側には無い。REST 経路で「1 スロット」に当たるのは**ブラウザ側のトークンの保存先**
（`setToken`、§1.2）で、その compare-and-set が #259。

### 1.5 SvelteKit の `load` から状態を書いている

`apps/admin-template/src/routes/(app)/+layout.ts` は `resolveProtectedSession`（`endSession` を
呼びうる）と `sessionStore.load()`（`establishSession` → `beginSession` → `apply`）を `load` の
中で呼ぶ。SvelteKit は追い越された navigation の**結果**は捨てるが、`load` の中で走った
**副作用**は取り消せない（#255 の 5〜6 回目の指摘の 3 件はすべてこの形）。
また、`load` の中からは「この navigation はもう追い越されたか」を知る手段が無い。

### 1.6 派生アプリ（banto-industrial、`@banto/admin-core` は `v1.7.3` に固定）

| アプリ      | ファイル                          | 今の形                                                                                                                                                                                 |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| banto-hub   | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を**直接**呼ぶ（`establishSession` を使っていない＝所有者・世代の照合なし）。`enterCommissioningMode()` で合成 identity を直接代入                         |
| banto-hub   | `src/lib/banto/sessionGuard.ts`   | `resolveProtectedSession` を包み `'session' / 'login' / 'unverified'` に写す                                                                                                           |
| banto-hub   | `src/lib/banto/sessionRecheck.ts` | ストリーム切断後の再確認を**独自に**実装（開始時の token を覚えて終了時に照合、single-flight、10 秒の期限）＝ core と同じ照合の作り直し。`/api/auth/check` を `fetch` で直接呼んでいる |
| banto-hub   | `src/routes/(app)/+layout.ts`     | `fetchCommissioningStatusOrNull()` を **await した後**に `enterCommissioningMode()`（照合なし）、そうでなければガード → `sessionStore.load()`                                          |
| chronogazer | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を直接呼ぶ                                                                                                                                                 |

派生アプリは `beginSession`/`endSession`/`sessionGeneration` を使っていないので、
一覧状態の所有者照合（#255）の恩恵も、世代ゲートも、まだ効いていない（v1.7.3 固定のため当然）。
どちらも admin-core の `createHttpAuthProvider`/`createTauriAuthProvider` を使っていて、
自前の `AuthProvider` 実装は持たない（`session.svelte.ts`・`sessionGuard.ts` が
`getAuthProvider()` の戻り値をそのまま使っていることからの推測。`setup.ts` の全文は未読）。

### 1.7 ログインの監査は、REST と Tauri のどちらも「資格情報の検証に成功した」時点で記録している

オーナーの決定 7 の前提として調べた。

| 経路  | 場所                                                                                | 記録する時点                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST  | `crates/banto-server/src/routes/audit.rs` `audited_credential_verifier`（15-64 行） | `users.verify()` が成功した直後、**トークンを発行する前**（`origin: "rest"`）。REST にはスロットが無いので、検証の成功＝セッションの発行と同じ                          |
| Tauri | `apps/admin-template/src-tauri/src/lib.rs` `auth_login`（645 行）                   | `users.verify()` が成功した直後、**`state.auth` を書く前**（`origin: "tauri"`）。今は無条件に書くので検証の成功＝確定と同じだが、§5.3 の compare-and-set の後は違いうる |

つまり今はどちらも「検証に成功した」を `login` として記録していて、意味は揃っている。
§5.3 で Tauri に compare-and-set を入れると、「検証には成功したが、世代の不一致で確定を
拒否した」場合が生まれ、`login` の記録と実際のセッションが食い違う。これをどう記録するかは
今回の必須要件から外す（決定 7、§9）。ログアウトの監査は、REST は middleware で
（`routes/audit.rs` 150-172 行、トークンの有効性に関わらず記録）、Tauri は `previous` が
あるときだけ記録する（`auth_logout` 692-701 行）。

REST の `audited_credential_verifier` は **検証処理を closure として `AuthState::new` に注入**
している（`banto-serve` と Tauri の組み込みサーバが共有）。Tauri の `auth_login` は
`state.users.verify()` を直接呼ぶ。§8.3 の「制御できる非同期の境界」は、この REST 側の形を
Tauri のコマンドにも持ち込む。

## 2. 責務と原則（#260 本文の確定形）

責務の表は Issue 本文のとおり。ここでは、オーナーのコメント（2026-09-29）で明確化を求められた
2 点と、レビューで求められた共通の原則（ticket）を確定する。

### 2.1 2 種類の `resolve()`

| 層         | 名前                          | 失敗の表し方                                                                                                                      | 答えの種類                                                        |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| provider   | `AuthProvider.resolve()`      | **reject する**（`ProviderError`）。取得できない＝サーバが確認できない（500）・到達不能・応答の形が違う                           | `{ status: 'none' }` / `{ status: 'active', identity }`（1 往復） |
| controller | `SessionController.resolve()` | **reject しない**。呼び出し元は戻り値の `outcome` で**今回の要求について**判断する。共有スナップショットの `lastError` は補助情報 | `confirmed` / `unverified` / `superseded`（§5.1）                 |

- provider の `resolve()`（HTTP）は `GET /api/auth/identity` を**1 回だけ**呼ぶ（§1.2 の事実。
  `GET /api/auth/session` は新設しない、決定 3）: `200` で identity → `active`、`200 null`
  または `401` → `none`、それ以外 → reject。**トークンを送って `none` が返ったら失効が確定した**
  とみなし、compare-and-set で**そのトークンだけ**を消す（今の `check()` の
  `clearTokenIfCurrent` と同じ副作用を `resolve()` に移す）。Tauri は `auth_resolve`（§5.3）。
- controller の `resolve()` は「この要求は、確認できた（none か active のどちらかが確定した）／
  確認できなかった（確定状態は変えていない。再試行できる）／**外からの遷移**に追い越された
  （**この確認の結果は採用できない**。navigation が破棄されたとは限らない）」を返す。
  呼び出し元が `snapshot.lastError` を見て推理することはしない。
- `superseded` は、要求が待っている間に**外からの遷移**（`end`・`adopt`・資格情報の変化による
  保留・別の probe による別 owner の確定）が起きたときに、その時点で決まる。要求自身が待って
  いた probe が確定して epoch が進むことは「追い越し」ではない（I-20、S-57）。
- `superseded` を受けた呼び出し元は、まだ有効なら**最新の確認に合流するか要求し直し**、
  **実際に確認できた結果の generation** だけを使う。今の generation を代わりに返さない
  （決定 5、I-16）。再確認には期限がある（§5.1 `resolveSettled`）。
- `confirmed` の結果は、その確定を表す `ticket`（§2.3）を持つ。後続の非同期の方針
  （公開閲覧の fallback など）はこの ticket を最後まで持ち回る。

### 2.2 原則 7 の範囲

> フロントの確定したセッションの状態（owner・generation・identity）を終了の状態に移すのは
> controller だけ。資格情報の破棄とバックエンドの失効の処理は、provider とバックエンドが担う。

具体的には:

- controller が担う: `status`・`owner`・`generation`・`identity`・`kind` の遷移、保存状態の
  全消去の指示（`end` 相当の遷移）、listener への通知。
- provider が担う: トークンの保存・消去（compare-and-set）、`resolve()` が `none` を確定した
  ときの**そのトークン**の消去、別タブの変化の検知、**自分が行った操作の結果の revision を
  操作の応答から確定して即座に通知すること**（I-19）。
- バックエンドが担う: セッションの失効の判定（ADR-0014）、Rust 側 `state.auth` の
  compare-and-set（§5.3）、操作の応答で `seq` を返すこと。
- provider が資格情報を消しても、controller の確定状態はそれだけでは変わらない。
  provider は `onCredentialChanged` で controller に**知らせ**、controller が §3 の
  I-5 に従って遷移する。**ログアウトも同じ経路**で終わる: アプリは `logout()` の後に `end()` を
  呼ばず、`resolve()` で `none` を確定する（I-10、S-51）。
- 別タブの切り替え（#257）の処理で、controller も provider も**共有のトークンを勝手に消さない**
  （決定 8、I-17）。

### 2.3 共通の原則: ticket（原則 1・4 の具体化）

> **非同期の判定・操作は、始めたときに ticket を取り、結果を適用する直前に、同期で
> `isCurrent(ticket)` を照合する。** ticket は層ごとに中身が違うが、「何と照合するか」を
> 開始時に固定し、`await` をまたいで持ち回り、適用と照合を同じ継続で行う点は同じ。

| 層           | ticket の中身                                                                                   | 取る場所                                                      | 照合する場所（同期）                                                   | 照合に失敗したら                                           |
| ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| controller   | probe: `{ epochAtStart, revisionAtStart, startedAt }` / 要求: `{ epochAtRequest, requestedAt }` | probe を出す前 / `resolve()` の入口                           | probe の fulfill・reject・timeout の**すべて**の継続の先頭             | 答えを捨てる（状態も `verification` も変えない）           |
| provider     | `revision`（操作の開始時、または呼び出し元から渡された `expectRevision`）                       | `login`/`logout`/`setup`/`enterPublicViewer`/`resolve` の入口 | トークンを書く・消す直前（compare-and-set）                            | 書かない。`superseded: true` を返す                        |
| アプリの方針 | `SessionTicket`（controller の `epoch` と `revision`）                                          | 非同期の判定（`status()`・試運転状態の取得）を始める前        | `adopt(…, ticket)`・`end(…, ticket)`・発行の直前の `isCurrent(ticket)` | 何もしない（`false`）。`resolveSettled()` で今の状態を確定 |
| Rust         | `seq`                                                                                           | コマンドの入口（最初の `.await` の前）                        | `cas_session(expected_seq, …)` の 1 つのロックの中                     | 書かない。`superseded: true` / no-op                       |

この原則を破る形（「`await` の後に無条件で書く」「戻り値の boolean だけで判断する」「照合と適用が
別の継続」）は、#255 の 6 往復と今回のレビュー 10 件のすべてに共通する。§4.9 に
「状態を書き換える入口 × 非同期の境界」の表を置き、実装の PR のレビューでも同じ表で洗う。

## 3. 不変条件（テストから参照する番号）

| 番号 | 不変条件                                                                                                                                                                                                                                                                                                                                                                                               | 由来                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| I-1  | **単一の書き手**: 確定状態（`status`・`owner`・`generation`・`identity`・`kind`）を変える関数は controller 内部の `commit()` 1 つ。公開の入口は `resolve` の適用・`adopt(…, ticket)`・`end(…, ticket)`・資格情報の変化による保留（I-5）の 4 つだけ。参照・購読の API（`sessionGeneration`・`onSessionEnded` など）は独自の状態や確認処理を持たず controller に委譲する                                 | 原則 1・7、決定 1                     |
| I-2  | **世代**: `commit` で `status` か `owner` が変わるとき、`end`、`adopt`、保留（I-5）のとき `generation` は +1。同じ owner の active→active（再確認）は据え置き。単調増加                                                                                                                                                                                                                                | `transitionSessionScope`              |
| I-3  | **鮮度**: provider の答え（fulfill・reject・timeout の**いずれも**）は、その問い合わせを始めた時点の（controller の遷移回数, 資格情報の revision）が適用時点と同じで、かつ始めた後に signal が来ていないときだけ状態に触れられる。違えば**状態も `verification` も変えずに**捨てる。捨てた後の出し直しは I-9                                                                                           | 原則 1・`sessionEnded.ts`、レビュー 6 |
| I-4  | **取得不能は状態を変えない**: 同じ資格情報で確認に失敗しても、確定状態と保存状態は変えない。変わるのは `verification` だけ                                                                                                                                                                                                                                                                             | 原則 2・#204                          |
| I-5  | **資格情報の切り替えで旧 owner は active でなくなる**: 切り替えを知った時点で `status: 'unknown'`・`owner: null`・`generation + 1` にする（保留）。その後の確認に失敗しても旧 owner の active には戻さない。保存状態は消さない（owner 照合で読めないだけ）                                                                                                                                             | 原則 6                                |
| I-6  | **`none` への遷移だけが保存状態を全消去する**: `commit(none)`（`resolve` が none を確定、または `end(…, ticket)`）は `generation + 1`・`clearAllListViewState()`。他の遷移は全消去しない（新しい owner の確定で他人の分を purge するのは今のまま）                                                                                                                                                     | `endSession`                          |
| I-7  | **資格情報の書き込み・消去は compare-and-set**: provider（トークン）も Rust 側（`state.auth`）も、操作を始めたとき（または呼び出し元が渡した ticket の時点）の revision / seq と一致するときだけ書く。controller は資格情報を書かない                                                                                                                                                                  | 原則 4・#259                          |
| I-8  | **controller の `resolve()` は reject しない**: 3 つの `outcome` のどれかを必ず返す。待機の期限がある。`superseded` の後の再確認にも期限があり、いつまでも待たない・再試行し続けない                                                                                                                                                                                                                   | オーナーのコメント 1、決定 5          |
| I-9  | **single-flight と鮮度の下限**: 同時の `resolve()` で provider への問い合わせは最大 1 本。`cause: 'signal'` の要求は**その要求の時点**（`requestedAt`）より後に始めた問い合わせでしか満たされない（要求自体が signal の stamp を進める）。破棄した問い合わせを**出し直さないのは、画面からの待機要求も、未処理の背景の確認の必要（signal・資格情報の変化）も無いときだけ**。待機者の数だけで判断しない | 本文、決定 6、レビュー 9              |
| I-10 | **認証の操作は待ち行列に入れず、結果は `resolve()` で確定する**: `login`/`logout`/`setup`/`enterPublicViewer` は provider を直接呼ぶ。操作の戻り値を直接 `commit` せず、**ログアウトの後も `end()` を呼ばず**、その後の `resolve()` で確定する                                                                                                                                                         | 本文、レビュー 1                      |
| I-11 | **Rust 側の `state.auth` は seq 付き**: `seq` は**結び付きを変える意図の操作**（login/setup/config-apply の設置、logout/settle の消去、password change の rebind）で、**値が変わらなくても**（logout の None→None を含む）+1 する。**同じ結び付きの refresh**（`settle_session` の role・name の更新）では進めない。書き込みは、コマンドが最初の `.await` の前に読んだ `seq` と一致するときだけ        | §1.3、レビュー 4                      |
| I-12 | **スナップショットは丸ごと**: `SessionSnapshot` は凍結したオブジェクトで、使う側は `owner`・`generation`・`identity`・`kind` を別々のストアから読まない                                                                                                                                                                                                                                                | 原則 5                                |
| I-13 | **adopt したセッションは provider の答えで終わらない**: アプリが `adopt(…, ticket)` したセッション（派生アプリ固有の試運転など）は `end(…, ticket)` か別の `adopt` でだけ終わる。`resolve()` は provider に問い合わせず `confirmed` を返す。`adopt`/`end` は ticket が current でなければ何もしない。公開閲覧の fallback と Tauri のログイン不要モードは `adopt()` の対象ではない（provider が答える） | 本文、決定 4、レビュー 3              |
| I-14 | **controller は SvelteKit を知らない**: `load` は `controller.resolve()` を await して結果を返すだけ。`{#key generation}` はアプリ層                                                                                                                                                                                                                                                                   | 本文                                  |
| I-15 | **待機を打ち切った後の遅い答えは無効**: 期限で `unverified` を返した問い合わせの答えが後で届いても `commit` しない（I-3 の照合で捨てる）。provider 側の副作用（`none` でのトークン消去）は provider の compare-and-set の範囲で起こり、`onCredentialChanged` 経由で I-5 に入る                                                                                                                         | オーナーのコメント                    |
| I-16 | **確認していない generation を画面に渡さない**: `superseded` を受けた呼び出し元は、その要求で**実際に確認できた**結果の generation しか返せない。今の generation を代わりに返さない。旧 owner のページデータを新しい世代へ引き継がない                                                                                                                                                                 | 決定 5                                |
| I-17 | **別タブの切り替えの処理は、共有のトークンを消さず、他のタブをログアウトさせない**: 資格情報の変化を検知したタブがすることは、旧画面の操作を止める → 新しいセッションを確認する → 変更が確認できたら通知して作り直す（または、注入された方針でログインへ移す）まで。トークンの消去は provider の `resolve()` が `none` を確定したときの compare-and-set だけ                                           | 決定 8                                |
| I-18 | **ticket の原則**: 非同期の判定・操作は開始時に ticket（controller: epoch/revision/signal、provider: revision、方針: `SessionTicket`、Rust: `seq`）を取り、最後まで持ち回り、適用の直前に同期で照合する。照合と適用の間に `await` を置かない。照合に失敗した結果は捨てる                                                                                                                               | §2.3、レビュー 1〜5                   |
| I-19 | **資格情報の変化の通知は、追加の確認の成功に依存しない**: provider は、状態を変えた操作（login/logout/setup/enterPublicViewer）の**応答**から revision（Tauri は `seq`）を確定し、その継続で `onCredentialChanged` を出す。応答が得られない（invoke/fetch の失敗）ときも revision を進めて通知する（安全側）。identity の再確認はその後の独立した処理で、失敗しても通知は済んでいる                    | レビュー 5                            |
| I-20 | **自分の確定で自分を追い越さない**: 要求が満たされるかは、probe の `epochAtStart`（= 要求時の epoch）で判定し、確定後の snapshot を `confirmed` として返す。`superseded` は、要求が待つ間に**外からの遷移**が起きた時点で決まる                                                                                                                                                                        | レビュー 8                            |

## 4. 競合のシナリオ

記法: `A`/`B` はアカウント、`P` は公開閲覧、`C` は試運転。`probe(n)` は provider の
`resolve()` の n 本目、`→` は時間の順、`‖` は**同じターン（同じマイクロタスクの並び）で
解決する**ことを表す。「期待」は controller の最終スナップショットと、要求ごとの `outcome`。

### 4.1 #255 の既存シナリオ（そのまま保つ。`sessionRaces.test.ts` ほか）

| 番号 | 順序                                                                                                                       | 期待                                                                                                                    | 不変条件       | 元のテスト            |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------- |
| S-1  | A の `resolve()` が probe(1) を待つ → `end()`（ログアウト）→ B の `resolve()` が probe(2) で確定 → probe(1) が A を返す    | A の要求は `superseded`（`end()` の時点で決まる）。B の owner・generation・保存状態は変わらない。probe(1) は捨てる      | I-1・I-3・I-20 | `sessionRaces` 117 行 |
| S-2  | A の `resolve()` が probe(1) を待つ → 資格情報の変化（provider に `onCredentialChanged` が無い場合）→ probe(1) が A を返す | probe(1) は revision 不一致で破棄、A の要求が待っているので probe(2) を出し直す。probe(2) の答えで確定                  | I-3・I-9       | `sessionRaces` 129 行 |
| S-3  | A の確認（probe(1)）を待つ間に B が確定 → probe(1) が `none` を返す                                                        | B は終わらない。probe(1) は破棄                                                                                         | I-3            | `sessionRaces` 146 行 |
| S-4  | SSE の 401 の signal → probe(1) 待ち → B が確定 → probe(1) が `none`                                                       | B は終わらない。`onSessionEnded` は呼ばれない。背景の確認が未処理なので B の資格情報で probe(2)                         | I-3・I-9       | `sessionRaces` 160 行 |
| S-5  | A が active → signal → probe(1) が `none`（遷移なし）                                                                      | `commit(none)`、generation + 1、保存状態の全消去、listener 通知                                                         | I-6            | `sessionRaces` 179 行 |
| S-6  | probe(1)（A の確認）と B のログイン後の `resolve()`（probe(2)）が在中 → probe(1) `none` ‖ probe(2) `B`                     | 最終 owner は B。どちらが先に適用されても、I-3 の照合が同じ継続で行われるので順序に依らない                             | I-1・I-3       | `sessionRaces` 197 行 |
| S-7  | S-6 の signal 版                                                                                                           | 同上。通知は出ない                                                                                                      | I-3            | `sessionRaces` 215 行 |
| S-8  | A が active → `resolve()` で provider が reject（500 / 到達不能）→ 再試行で A                                              | 1 回目は `unverified`、owner・generation・保存状態は不変。2 回目は `confirmed`（同じ generation）。保存状態は復元される | I-4            | `sessionRaces` 242 行 |
| S-9  | provider の `resolve()`: HTTP で `200 null` または `401`                                                                   | `{ status: 'none' }`（reject ではない）。トークンを送っていたなら、そのトークンを compare-and-set で消す                | §2.1           | `sessionRaces` 284 行 |
| S-10 | A が active → id の無い identity で確定                                                                                    | owner は `null`（`unknown` ではなく active・owner なし）。A の保存状態は消さない。次に A が確定すれば読める             | I-6            | `sessionRaces` 289 行 |
| S-11 | `sessionGate`・`sessionEnded`・`sessionEndIntegration`・`sessionEndUnheard` の各テスト                                     | 期待は変えない。呼び口だけ controller に置き換える（§6.1）                                                              | —              | 各ファイル            |

### 4.2 同じターンで解決する組み合わせ

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                                          | 不変条件       |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S-12 | 旧い確認 probe(1)（`end()` の前に開始）‖ 新しい確立 probe(2)（`end()` の後に開始）が同時に解決 | probe(1) は遷移回数が変わっているので破棄。probe(2) の答えで確定。最終状態は probe(2) の答えだけで決まる                                                                                                                      | I-3            |
| S-13 | 1 本の probe の答えを 2 つの `resolve()` 要求（navigation ×2）が待つ ‖ 答えが返る              | 両方 `confirmed`（同じ snapshot）。provider への問い合わせは 1 本（single-flight）                                                                                                                                            | I-9            |
| S-14 | 2 つの要求が同じ probe を待つ → `end()` → probe が返る                                         | `end()` の時点で両方に `superseded` を返す（待機者はいなくなる）。probe の答えは破棄。未処理の signal・資格情報の変化があれば出し直し、無ければ出し直さない（`resolveSettled` が要求し直せば、その要求が新しい probe を出す） | I-3・I-9・I-20 |
| S-15 | `adopt(C, ticket)` ‖ 在中の probe が `none` を返す                                             | C が active のまま。probe の答えは破棄（遷移回数が変わった）                                                                                                                                                                  | I-13           |

### 4.3 Tauri の Rust 側まで含めた両方向

| 番号 | 順序                                                                                                                                                | 期待（Rust）                                                                                                                             | 期待（フロント）                                                                                                                                                                    | 不変条件        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| S-16 | `auth_login(B)` 開始（`verify` 待ち）→ `auth_logout` 完了 → `auth_login` 再開                                                                       | `state.auth` は `None` のまま。`LoginResult { success: false, superseded: true, seq }`。監査は今のまま `login`（検証成功。§1.7、決定 7） | ログインの戻り値を `commit` しない（I-10）。provider は応答の `seq` で revision を更新（I-19）。`resolve()` → `none` → ログイン画面のまま                                           | I-7・I-11・I-19 |
| S-17 | `auth_logout` 開始（`auth_config` 待ち）→ `auth_login(B)` 完了・`resolve()` で B 確定 → `auth_logout` 再開 → **ログアウトを始めた画面の継続が再開** | `state.auth` は `Some(B)` のまま。logout は何もせず `{ seq }` を返す（監査に B の `logout` を**残さない**）                              | ログアウトの継続は `end()` を呼ばず `resolveSettled()`（S-51）。provider の revision は logout の応答で更新されるが CAS 不成立なので変わらない。B は active のまま、generation 不変 | I-7・I-10・I-11 |
| S-18 | `auth_setup` で S-16 と同じ順序                                                                                                                     | アカウントは作られる（DB）。セッションは入れない。戻り値は `superseded`                                                                  | 同 S-16                                                                                                                                                                             | I-11            |
| S-19 | `auth_setup` で S-17 と同じ順序（setup 中に別のログイン完了。初期化前なので実際には起きにくい。推測）                                               | S-17 と同じ形で守る                                                                                                                      | 同 S-17                                                                                                                                                                             | I-11            |
| S-20 | HTTP: ガードが `none` を確定 → 公開閲覧の発行 `enterPublicViewer()` 待ち → ヘッダーからログイン B 完了 → 発行の応答が届く                           | （REST 側は map への追加。B のトークンは消えない）                                                                                       | provider の `setToken` は revision 不一致で**書かない**（#259）。`resolve()` → B。公開閲覧トークンは使われない                                                                      | I-7             |
| S-21 | HTTP: ログアウト開始（`POST /logout` 待ち）→ ログイン B 完了（トークン書き込み）→ ログアウトの `setToken(null)`                                     | （サーバ側は旧トークンだけ失効）                                                                                                         | `setToken(null)` は revision 不一致で**消さない**。B は active のまま                                                                                                               | I-7             |
| S-22 | Tauri の自動ログイン（`run()` 起動時）とコマンドの競合                                                                                              | 起動時に決まり、コマンド受付前。競合しない（事実 §1.3）                                                                                  | —                                                                                                                                                                                   | —               |

S-16〜S-19 は Rust の**コマンド本体**のテストで完了の順序を固定して（§8.3）、S-20〜S-21 は
provider のテストで、それぞれ**フロントの順序に依らず**成り立つことを確かめる。

### 4.4 資格情報が切り替わった後に確認が失敗した場合

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                     | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-23 | A が active → 資格情報が B に切り替わる（`onCredentialChanged`）→ `resolve()` が reject（500） | 切り替えを知った時点で `unknown`・`owner: null`・generation + 1（保留）。要求は `unverified`。**A の active には戻らない**。A の画面は世代ゲートで消え、A の保存中の処理は書けない。再試行の状態に留める | I-5      |
| S-24 | S-23 の後、再試行で B が確定                                                                   | `confirmed`・active(B)・generation はさらに +1（unknown → active）。A の保存状態は purge                                                                                                                 | I-2・I-5 |
| S-25 | S-23 の後、再試行で `none`（B のトークンがすでに失効していた）                                 | `confirmed`・`none`。全消去                                                                                                                                                                              | I-6      |
| S-26 | A が active → **同じ資格情報**で `resolve()` が reject                                         | active(A) のまま、`verification.state: 'failed'`。要求は `unverified`。**S-23 と区別する**（原則 2）                                                                                                     | I-4      |
| S-27 | A が active → 切り替えの検知 → 確定前に A の画面から保存の書き込み                             | 書き込みは `isCurrent(scope)` が偽なので落ちる（今の `listViewState` の書き込み条件と同じ）                                                                                                              | I-5      |

### 4.5 鮮度と待機の期限

| 番号 | 順序                                                                                                                 | 期待                                                                                                                                                                                                                 | 不変条件 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-28 | probe(1) 開始 → 失効の signal（SSE 401）→ その signal を起点にした `resolve()` 要求 → probe(1) が `active(A)` を返す | probe(1) では要求を満たさない（要求より前に始めた）。probe(1) の答えは破棄し probe(2) を出す。probe(2) の答えで確定                                                                                                  | I-3・I-9 |
| S-29 | probe(1) 開始（navigation）→ signal → probe(1) が `active(A)` を返す（signal 起点の要求は無い）                      | probe(1) は破棄し、**未処理の signal があるので** probe(2) を出す（`createSessionEndConfirmation` の「答えが何であれ確かめ直す」を保つ）                                                                             | I-3・I-9 |
| S-30 | `resolve()` が期限（既定 10 秒、`sessionEnded.ts` の `CONFIRM_TIMEOUT_MS` を引き継ぐ）を過ぎる                       | `unverified`（`error` は timeout）。確定状態は不変。その probe は「打ち切り済み」に印を付ける                                                                                                                        | I-8      |
| S-31 | S-30 の後、遅れて probe が `none` を返す                                                                             | I-3 の照合（打ち切り済み）で捨てる。HTTP provider はトークンを送って `none` を受けたので `clearTokenIfCurrent` でそのトークンだけ消し、`onCredentialChanged` を出す → I-5 の保留 → 次の `resolve()` で `none` を確定 | I-15     |
| S-32 | S-30 の後、遅れて probe が `active(A)` を返す（A は今も同じ資格情報）                                                | 捨てる。次の `resolve()`（新しい probe）で確定する。遅い答えで「確認済み」に見せない                                                                                                                                 | I-15     |
| S-33 | signal 起点の確認が `unverified` のまま                                                                              | 退避（backoff、`CONFIRM_RETRY_INITIAL_MS`→`CONFIRM_RETRY_MAX_MS`）で問い合わせ直す。`confirmed` になるまで。購読の終了で止める（今の `createSessionEndConfirmation` と同じ）                                         | I-9      |
| S-34 | 保護レイアウトが購読する前に確定した `none`（unheard）                                                               | 購読時に**確かめ直す**（再生ではない）。その間に新しいログインがあれば通知しない（`sessionEndUnheard.test.ts` を保つ）                                                                                               | I-3      |

### 4.6 別のタブ（#257）と、複数タブでの同時のログイン・ログアウト

前提: 「Remember me」のトークンは `localStorage`（タブ間で共有）、通常のトークンは
`sessionStorage`（タブごと）。タブ間の検知は provider の adapter が `storage` イベントで行い、
`onCredentialChanged` を controller に渡す。

**既定の流れ**（決定 8）: ① 資格情報の変更を検知したら旧画面の操作を止める（I-5 の保留）→
② 新しいセッションを確認する（`resolve()`）→ ③ 別のユーザーへの変更が確認できたら**通知**し、
新しい権限で画面を作り直す（世代ゲート）→ ④ 旧ユーザーの未保存の入力や選択は引き継がない →
⑤ 確認に失敗したら旧画面へ戻さず、再試行の状態に留める → ⑥ この処理で**共有のトークンを
勝手に消さず、別のタブまでログアウトさせない**。共用の端末などで再認証が必要なアプリは、
「通知してログインへ移す」方針を注入できる（§6.1 `ownerChangePolicy`）。
画面側の配線は 3 本に分ける（§6.1、レビュー 7）: **generation の変化 → 再 load**、
**owner の差分 → 通知**、**再 load の `unverified` → 再試行画面**。

| 番号 | 順序                                                                         | 保証すること                                                                                                                                                                                                                         | 保証しないこと                                                                                                                               |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S-35 | タブ 1 が A（remember）→ タブ 2 が B でログイン（remember）                  | タブ 1 は `storage` イベントで保留に入り A を active として使わない → generation の変化で再 load → `resolve()` で B を確定 → owner の差分で**通知**、B の権限で作り直す。A の未保存の入力は引き継がない。タブ 1 はトークンを消さない | イベントが届くまでの間（ミリ秒〜）に A の画面から送った要求が B のトークンで飛ぶことは止められない（送信時点のトークンを使うため。今もそう） |
| S-36 | S-35 で、`resolve()` が reject（500）                                        | 保留の generation の変化で再 load が走り、`resolveSettled` が `unverified` → **503 の再試行画面**（空画面にしない）。A へ戻さない。B のトークンは消さない                                                                            | —                                                                                                                                            |
| S-37 | S-35 で、アプリが `ownerChangePolicy: 'relogin'` を注入している              | 通知してログイン画面へ移す。**トークンは消さない**（タブ 2 の B はログインしたまま）。タブ 1 のログイン画面からの扱い（B として続けるか、再認証を求めるか）はそのアプリのログイン画面側の要件                                        | —                                                                                                                                            |
| S-38 | タブ 1 と タブ 2 が**同時に**別のユーザーでログイン（remember）              | 各タブは**自分のログインの戻り値ではなく**、その後の `resolve()`（保存されているトークン）で確定する。両タブが同じ owner に収束する                                                                                                  | どちらのトークンが残るか（`localStorage` の最後の書き込みが勝つ。タブ間の compare-and-set は原理的にできない）                               |
| S-39 | タブ 1 がログアウト（`localStorage` を消す）と同時に、タブ 2 が B でログイン | 両タブとも保存されている資格情報に従う（B が残れば両方 B、消えていれば両方ログイン画面）。旧 owner A のまま残るタブは無い                                                                                                            | タブ 1 が「ログイン画面で終わる」こと                                                                                                        |
| S-40 | 同じタブで、ログイン中に別タブが `localStorage` を書き換える                 | このタブのログインの `setToken` は revision 不一致で書かない（I-7）。`resolve()` で保存されているトークンの owner を確定                                                                                                             | このタブのログインが「勝つ」こと                                                                                                             |
| S-41 | `sessionStorage`（通常ログイン）のタブ同士                                   | 互いに影響しない（今のまま）                                                                                                                                                                                                         | —                                                                                                                                            |

原理的な限界: `localStorage` の読み→比較→書きはタブをまたいで原子的にできない（Web Locks API を
使えば近づくが、ADR-0002 の「依存を足さない」の範囲内でも実装が増え、Safari の対応も要確認。
**この設計では採らない**）。したがって保証するのは「**どのタブも、旧 owner を active として
使い続けない**」と「**各タブは自分の意図ではなく保存された資格情報に従う**」と「**切り替えの
処理が他のタブをログアウトさせない**」までで、「同時操作のどちらが勝つか」は保証しない。

### 4.7 公開閲覧への fallback と試運転（`adopt()`）

| 番号 | 順序                                                                                                                                                                                                 | 期待                                                                                                                                                                                                                  | 不変条件         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| S-42 | `resolve()` → `confirmed`・`none`（ticket t0 = `{ epoch e0, revision r0 }`）→ 方針が `status()` を await → `isCurrent(t0)` → `enterPublicViewer({ expectRevision: r0 })` → 成功 → `resolveSettled()` | active(P)、`kind: 'publicViewer'`、owner `public-viewer`。`none` の後なので generation は +2。`adopt()` は使わない（provider が答える）。t0 は none を確認した時点のもので、`status()` の後と発行の中の両方で照合する | I-10・I-13・I-18 |
| S-43 | S-42 の発行待ちの間にログイン B                                                                                                                                                                      | 発行の `setToken` は `expectRevision: r0` と不一致で書かない（S-20）。`resolveSettled()` → active(B)                                                                                                                  | I-7              |
| S-44 | banto-hub: ticket t0 を取る → `fetchCommissioningStatusOrNull()` を await → 迂回 → `adopt(C, 'commissioning', t0)`                                                                                   | active(C)、`kind: 'commissioning'`、owner `commissioning:commissioning`。provider には問い合わせない。同じ C の再 `adopt`（ticket は current）は generation 据え置き                                                  | I-13・I-2・I-18  |
| S-45 | S-44 の後、SSE の 401 などの signal                                                                                                                                                                  | adopt 中は signal で provider に問い合わせない（`confirmed` のまま）。試運転の終了（lock-down）は**アプリの方針**が、判定の前に取った ticket で `end('commissioning-locked', ticket)` を呼んでから `resolveSettled()` | I-13             |
| S-46 | S-44 の後、`adopt` 中に別タブで A がログイン（`storage` イベント）                                                                                                                                   | adopt 中の `onCredentialChanged` は**未処理の背景の確認**として記録だけして保留にしない（試運転はトークンで決まらない）。`end()` 後の `resolve()` で A を確定                                                         | I-13・I-9        |
| S-47 | Tauri のログイン不要モード（auth-disabled）                                                                                                                                                          | Rust が合成した identity と `kind: 'local'` を `auth_resolve` が返す（`auth_identity` と同じく、そのたびにモードと権限を読み直す）。provider の `resolve()` で active。**`adopt()` しない**（決定 4）                 | I-13             |

### 4.8 `superseded` を受けた `load`

| 番号 | 順序                                                                                                      | 期待                                                                                                                                                                                   | 不変条件  |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-48 | `load` の `resolve()` が probe(1) 待ち → 別のログイン B（provider が通知 → 保留）→ 要求は `superseded`    | `load` は今の generation を返さない。`resolveSettled` が要求し直し（probe(2)）、B が `confirmed` になったら**B の generation** を返す。旧 owner のページデータは作り直す（世代ゲート） | I-16      |
| S-49 | S-48 で、確認が期限（`resolveSettled` の `deadlineMs`）内に確定しない（遷移が続く、または reject が続く） | `unverified` として再試行画面へ。generation は返さない                                                                                                                                 | I-8・I-16 |
| S-50 | S-48 で、`load` を出した navigation を SvelteKit がすでに破棄している                                     | `resolveSettled` の結果は捨てられる（SvelteKit の挙動）。controller の状態はどの場合も最新の確認だけで決まっているので、破棄されても害は無い                                           | I-1・I-16 |

### 4.9 レビュー（2026-09-29）で加わった順序と、「状態を書き換える入口 × 非同期の境界」の洗い出し

| 番号 | 順序                                                                                                                                                                                            | 期待                                                                                                                                                                                                                                      | 不変条件   | レビュー |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| S-51 | ヘッダーのログアウト: `await provider.logout()`（遅い）→ その間にログイン B が完了し `resolve()` で B 確定 → ログアウトの継続が再開                                                             | 継続は `end()` を**呼ばない**。`resolveSettled()` を呼ぶ → B が `confirmed` → `goto(login)` もしない（`snapshot.status === 'active'` なので画面はそのまま）。provider の logout は CAS 不成立でトークンを消していない。B の保存状態も残る | I-10・I-18 | 1        |
| S-52 | `resolve()` → `none`（t0）→ `status()` 待ち → ログイン B 完了・`resolve()` で B 確定 → `status()` が `viewerPublic: true` を返す                                                                | 発行を**始める前**の `isCurrent(t0)` が偽 → 発行しない → `resolveSettled()` → B のまま。仮に照合を通ってしまっても `enterPublicViewer({ expectRevision: r0 })` の CAS が B のトークンを守る（二重の防御）                                 | I-7・I-18  | 2        |
| S-53 | banto-hub: ticket t0 → `fetchCommissioningStatusOrNull()` 開始 → 別の判定が lock-down を確定し `end('commissioning-locked', t1)` → 古い取得が「迂回可」を返す → `adopt(C, 'commissioning', t0)` | `adopt` は t0 が current でない（`end` で epoch が進んだ）ので**何もしない**（`false`）。試運転は復活しない。方針は `resolveSettled()` で今の状態（none → ログイン画面）を確定する                                                        | I-13・I-18 | 3        |
| S-54 | 同じセッション A で `resolve()` を続けて 3 回呼ぶ（Tauri。`auth_resolve` のたびに `settle_session` が refresh で `*auth = valid.clone()` を書く）                                               | 3 回とも `confirmed`、generation は同じ。`seq` は refresh では進まないので `credentialRevision` は不変、probe は破棄されない。（`seq` を書き込みごとに進めると、自分の応答を破棄し続けて上限に達する）                                    | I-11       | 4        |
| S-55 | Tauri: `auth_login(B)` が成功（応答に `seq`）→ provider は応答の `seq` で revision を更新し `onCredentialChanged` → 続く `auth_resolve` が 500 / 無応答                                         | 通知は済んでいるので controller は保留（`unknown`、gen+1）。`resolve()` は `unverified`。**A は active に残らない**（S-23 と同じ）。再試行で B が確定                                                                                     | I-5・I-19  | 5        |
| S-56 | A の probe(1) 待ち → 資格情報が B に → probe(2) で B 確定 → **古い probe(1) が reject（500）で遅れて届く**                                                                                      | probe(1) は I-3 の照合（epoch・revision 不一致）で捨てる。B の確定状態も `verification` も変えない（`unknown` に戻さない、`failed` にしない）。期限切れの probe の reject も同じ                                                          | I-3        | 6        |
| S-57 | 起動直後（epoch 0）に最初の `resolve()` → probe(1) が A を返す → `commit` で epoch 1                                                                                                            | 要求は `confirmed`（判定は probe の `epochAtStart` = 要求時の epoch で行う）。返す snapshot は commit 後（generation 1、owner A）。`superseded` にならない                                                                                | I-20       | 8        |
| S-58 | 最後の signal → probe(1) 開始 → `resolve({ cause: 'signal' })` を**直接**呼ぶ（banto-hub の `probeSessionAfterReconnectFailures` の移行の形）                                                   | 要求自体が signal の stamp を進めるので、probe(1) には合流しない。probe(2) を出し、その答えで確定                                                                                                                                         | I-9        | 9        |
| S-59 | 別タブで**同じ A** として再ログイン（remember の書き換え）                                                                                                                                      | 保留（unknown、gen+1）→ generation の変化で再 load → A を確定（gen+2）→ 画面は新しい generation で作り直される。owner は同じなので**通知しない**。世代ゲートが画面を隠し続けない                                                          | I-2・I-5   | 7        |
| S-60 | A → B の背景の確認（`storage` イベント起点）が 500                                                                                                                                              | 保留の generation の変化で再 load → `resolveSettled` が `unverified` → `error(503)` の再試行画面。空画面で止まらない（S-36 と同じ）                                                                                                       | I-5        | 7        |
| S-61 | Tauri: `load` が `getAuthSettings()`（`auth_config_get`）を await → その間にログイン不要モードが切り替わる → 古い応答で `sessionStore.authDisabled` を代入                                      | `authDisabled` を別読みしない。`auth_resolve` が `kind: 'local'` を返し、`authDisabled` は `snapshot.kind === 'local'` からの `$derived` にする（§5.3、§6.1）。洗い出しで見つけた同じ型                                                   | I-12・I-18 | §4.9 表  |

**「状態を書き換える入口 × 非同期の境界」の表**（今回の 10 件と同じ型が残っていないかを洗った。
実装の PR のレビューでも同じ表を使う）:

| 入口（状態を書く場所）                             | 直前の非同期の境界                          | ticket / 照合                                                    | シナリオ             |
| -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| controller `commit`（probe の fulfill）            | provider `resolve()`                        | probe ticket（epoch・revision・signal・打ち切り）                | S-1〜S-7・S-12・S-28 |
| controller `commit`（probe の reject / timeout）   | 同上                                        | 同上（**失敗も同じ照合**）                                       | S-56・S-30〜S-32     |
| controller `commit`（保留、`onCredentialChanged`） | provider の操作の応答 / `storage` イベント  | provider が応答から revision を確定（再確認に依存しない）        | S-55・S-35           |
| controller `adopt`                                 | 試運転状態の取得                            | `SessionTicket`                                                  | S-44・S-53           |
| controller `end`                                   | lock-down の判定                            | `SessionTicket`                                                  | S-45・S-53           |
| （旧）ログアウト後の `endSession()`                | `provider.logout()`                         | **入口を無くす**（`resolve()` で確定）                           | S-17・S-51           |
| provider `setToken`（login / setup）               | `fetch` / `invoke`                          | 開始時の revision                                                | S-40・S-21           |
| provider `setToken`（enterPublicViewer）           | `status()` → `fetch`                        | **呼び出し元の ticket の revision**（`expectRevision`）          | S-20・S-42・S-52     |
| provider `setToken(null)`（logout）                | `fetch` / `invoke`                          | 開始時の revision                                                | S-21・S-17           |
| provider `clearTokenIfCurrent`（resolve が none）  | `fetch`                                     | 送ったトークンとの一致                                           | S-9・S-31            |
| provider revision の更新（操作の応答）             | 操作の応答                                  | 応答の `seq` / 自分の書き込み。応答が無いときは進めて通知        | S-55                 |
| Rust `install`（login / setup）                    | `verify` / `setup_first_user` / `record_ok` | 入口の `seq`                                                     | S-16・S-18           |
| Rust `clear`（logout）                             | `auth_config`                               | 入口の `seq`（None→None でも進める）                             | S-17・S-19           |
| Rust `refresh`（settle_session、同じ結び付き）     | `users.get_by_username` / `auth_config`     | `unchanged` の照合（既存）。**`seq` は進めない**                 | S-54                 |
| Rust `clear`（settle_session、失効）               | 同上                                        | `unchanged` の照合（既存）。`seq` は進める                       | S-5（Rust 側）       |
| Rust `install`（auth_config_apply_body）           | `set_auth_config`                           | `is_none()` を 1 ロック内で（既存）→ `seq` に乗せ替え            | —                    |
| Rust `rebind`（change_own_password）               | `change_password`                           | id + auth_epoch（既存）→ `seq` も進める                          | —                    |
| アプリ `sessionStore.authDisabled`                 | `auth_config_get`                           | **入口を無くす**（snapshot の `kind` から導く）                  | S-61                 |
| アプリ `load` が返す `sessionGeneration`           | `resolveSettled`                            | 確認できた結果の generation だけ                                 | S-48〜S-50           |
| アプリ `listViewState` の書き込み                  | 画面の操作・保存の応答                      | `isCurrent(scope)`（既存）                                       | S-27                 |
| アプリ `settings.syncFromProvider()`（M12 の設定） | UiSettings の読み                           | セッション状態ではないが同じ型。**範囲外**（別 issue 候補、§10） | —                    |

## 5. 公開 API の案（型のスケッチ）

名前は仮。**確定するのは契約で、名前は実装の PR で直してよい。**

### 5.1 controller

```ts
export type SessionKind = 'account' | 'publicViewer' | 'local' | (string & {}); // 'local' = Tauri ログイン不要モード。アプリは adopt で足す（'commissioning' など）

export interface SessionSnapshot {
	/** unknown = 起動直後、または資格情報の切り替えを知って確認待ち（I-5） */
	readonly status: 'unknown' | 'none' | 'active';
	readonly owner: string | null; // sessionOwnerKey()。active でも id の無い identity なら null
	readonly generation: number;
	readonly identity: Identity | null;
	readonly kind: SessionKind | null;
	/** 直近の確認の状況。確定状態とは別に持つ（原則 2） */
	readonly verification: {
		readonly state: 'idle' | 'verifying' | 'failed';
		readonly lastError: unknown | null;
	};
}

/** SessionScope は今のまま（{ generation, owner }）。保存状態の API との互換のため残す */
export type SessionScope = { readonly generation: number; readonly owner: string | null };

/**
 * 非同期の方針が持ち回る ticket（I-18）。不透明。`epoch`（controller の遷移回数）と
 * `revision`（取った時点の credentialRevision）を持つ。`isCurrent(ticket)` は両方の一致。
 */
export type SessionTicket = { readonly epoch: number; readonly revision: number | undefined };

export type ResolveResult =
	| { outcome: 'confirmed'; snapshot: SessionSnapshot; ticket: SessionTicket } // status は none か active。ticket はこの確定の時点
	| { outcome: 'unverified'; error: unknown; snapshot: SessionSnapshot } // 確定状態は変えていない
	| { outcome: 'superseded'; snapshot: SessionSnapshot }; // 外からの遷移に追い越された（I-16・I-20）

export type SessionSignal = 'unauthorized' | 'credentialCleared' | 'credentialChanged' | 'app';

export interface SessionController {
	/** $state に裏打ちされた読み取り。凍結オブジェクト（I-12） */
	readonly snapshot: SessionSnapshot;
	subscribe(listener: (snapshot: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
	/**
	 * この要求について確定を試みる。reject しない（I-8）。
	 * `cause: 'signal'` は signal の stamp を進め、この呼び出しより後に始めた問い合わせでしか
	 * 満たされない（I-9）。`superseded` は待つ間に外からの遷移が起きたときに、その時点で返る。
	 */
	resolve(options?: {
		cause?: 'navigation' | 'signal';
		timeoutMs?: number;
	}): Promise<ResolveResult>;
	/** 失効の可能性の通知。退避付きで確認を回す（今の createSessionEndConfirmation）。同期 */
	signal(kind: SessionSignal): void;
	/** 非同期の方針を始める前に取る ticket（I-18）。同期 */
	ticket(): SessionTicket;
	isCurrent(ticket: SessionTicket | SessionScope): boolean;
	/**
	 * provider が答えられない、派生アプリ固有の合成セッション（試運転）をアプリの方針で確定する。
	 * 同期。`ticket` が current でなければ何もせず `false`（I-13・I-18）。
	 */
	adopt(identity: Identity, kind: SessionKind, ticket: SessionTicket): boolean;
	/**
	 * アプリの方針で確定したセッションを終了の状態へ（I-6）。同期。`ticket` が current で
	 * なければ何もせず `false`。**ログアウトには使わない**（logout は resolve で確定する、I-10）。
	 */
	end(reason: 'policy' | (string & {}), ticket: SessionTicket): boolean;
	/** 保存状態の API に渡す scope（今の currentSessionScope / isCurrentSessionScope） */
	scope(): SessionScope;
}

/**
 * `load` 向け: `superseded` の間は要求し直し、`confirmed` か `unverified` だけを返す。
 * `deadlineMs`（既定 timeoutMs と同じ 10 秒）を過ぎたら `unverified`（error は deadline）。
 * 返す generation は、この呼び出しで実際に確認できたものだけ（I-16）。
 */
export function resolveSettled(
	controller: SessionController,
	options?: { cause?: 'navigation' | 'signal'; deadlineMs?: number }
): Promise<Exclude<ResolveResult, { outcome: 'superseded' }>>;

export interface SessionControllerDeps {
	scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
	/** 単調増加のスタンプ。既定は内部カウンタ。テストが順序を決めるために差し替える */
	clock?: () => number;
	timeoutMs?: number; // 既定 10_000
	maxStaleRetries?: number; // 既定 3（今の MAX_STALE_RETRIES）
	retry?: { initialMs: number; maxMs: number }; // 既定 1_000 / 30_000
	/** none への遷移で保存状態を全消去する関数。既定は listViewState.clearAllListViewState */
	onNone?: () => void;
}

export function createSessionController(
	provider: AuthProvider,
	deps?: SessionControllerDeps
): SessionController;

/** initBanto({ authProvider }) が作る既定の controller。アプリは通常これを使う */
export function getSessionController(): SessionController;
```

内部の骨格（実装の指針。公開しない）:

```ts
// 1 つの書き手（I-1）。同期。ここ以外で status/owner/generation/identity/kind を書かない。
function commit(next: { status; owner; identity; kind }, cause: string): void;
// 遷移のたびに +1。probe と ticket の鮮度の照合に使う（I-3・I-18）
let epoch = 0;
// 在中の問い合わせ（single-flight、I-9）。abandoned = 期限で打ち切った（I-15）
let inflight: {
	startedAt;
	epochAtStart;
	revisionAtStart;
	abandoned: boolean;
	waiters: Request[];
} | null;
// 直近の signal のスタンプ（I-9）と、まだ新しい probe で処理していない背景の確認の必要
let latestSignalAt = 0;
let pendingBackground = false; // signal / onCredentialChanged で true、確定した probe で false
```

`resolve()` の判定は**同じ継続の中**で行う（`await` を挟まない）:

1. 要求のスタンプ `requestedAt`、`epochAtRequest` を取る。`cause: 'signal'` なら
   `latestSignalAt = requestedAt` にする（I-9、S-58）。adopt 中なら `confirmed` を即返す（I-13）。
2. 在中の probe があり、`probe.epochAtStart === epoch` かつ `probe.startedAt > latestSignalAt`
   かつ `!abandoned` なら合流（waiters に加える）。なければ新しい probe を出す（`epochAtStart = epoch`、
   `revisionAtStart = provider.credentialRevision?.()`）。
3. **外からの遷移**（`commit` を伴う `end`・`adopt`・保留・別 owner の確定）が起きたら、その
   `commit` の中で、在中の probe の waiters すべてに `superseded`（今の snapshot）を返して空にする
   （I-20、S-14）。probe 自体はそのまま返ってくるのを待ち、4 で捨てる。
4. probe が**fulfill・reject・timeout のどれで**終わっても、まず同じ照合をする:
   `abandoned`、`epoch !== epochAtStart`、`provider.credentialRevision?.() !== revisionAtStart`、
   `latestSignalAt > startedAt` のどれかなら**捨てる**（状態も `verification` も触らない。S-56）。
   捨てたら、waiters が残っているか `pendingBackground` なら出し直す（上限 `maxStaleRetries`。
   超えたら waiters に `unverified`、error は `SessionChangedError`）。どちらも無ければ出し直さない。
5. 照合を通った fulfill: `commit()`（世代の規則は I-2）、`pendingBackground = false`、waiters 全員に
   `confirmed`（commit 後の snapshot と `ticket()`）。**自分の commit で epoch が進んでも
   superseded にはしない**（判定は 4 の `epochAtStart` で済んでいる。S-57）。
6. 照合を通った reject: `verification = failed` だけ更新し、waiters に `unverified`。
   資格情報の切り替え後の失敗（S-23・S-55）は、provider の `onCredentialChanged` が**先に**保留を
   `commit` している（I-19）ので、ここで保留を判断しない。`onCredentialChanged` を持たない provider
   では、この reject は 4 の revision 不一致で捨てられ、出し直しの probe が確定を担う。
7. timeout: `abandoned = true` にして waiters に `unverified`（error は timeout）。遅れて届く答えは
   4 で捨てる（S-31・S-32）。

`onCredentialChanged` の受け口（provider から同期に呼ばれる）: adopt 中でなければ
`commit(unknown)`（保留、I-5、waiters は `superseded`）、`pendingBackground = true`、退避付きの
背景の確認を始める。adopt 中は `pendingBackground = true` だけ（S-46）。

### 5.2 provider 契約（v2 の標準契約）

```ts
export interface AuthProvider {
	// 既存: login / logout / status? / setup? / changePassword?
	// v2 で削除: check / getIdentity（controller は呼ばない。互換 adapter だけが使う）

	/**
	 * 【必須】1 往復でセッションを答える。取得できないときは reject する（§2.1）。
	 * HTTP: GET /api/auth/identity を 1 回。200 で identity → active、200 null / 401 → none、
	 *       それ以外 → reject。トークンを送って none なら、そのトークンを compare-and-set で消す。
	 * Tauri: auth_resolve（§5.3）。kind を返す（'account' | 'local'）。
	 */
	resolve(): Promise<
		{ status: 'none' } | { status: 'active'; identity: Identity; kind?: SessionKind }
	>;

	/**
	 * 資格情報の revision（不透明な整数）。provider が資格情報を書く・消すたびに +1。
	 * HTTP: メモリ上のカウンタ + storage イベントでも +1。Tauri: 操作の応答と auth_resolve が返す seq。
	 * 秘密（トークン本体）は返さない。無い provider では controller は遷移回数と signal だけで
	 * 鮮度を照合する（資格情報の切り替えの検知＝I-5 は効かない）。
	 */
	credentialRevision?(): number;

	/**
	 * 資格情報が変わったら呼ぶ（#257、I-19）: 自分の操作の応答を受けた継続で即座に、
	 * 別タブの storage イベントで、Rust 側の seq の変化で。戻り値は購読解除
	 */
	onCredentialChanged?(listener: () => void): () => void;

	/**
	 * 公開閲覧の発行（HTTP だけ）。`expectRevision` を渡すと、その revision のときだけトークンを
	 * 書く（呼び出し元の ticket に結び付ける、S-42・S-52）。省略時は呼び出しの開始時の revision。
	 */
	enterPublicViewer?(options?: {
		expectRevision?: number;
	}): Promise<{ success: boolean; superseded?: boolean }>;
}
```

`resolve` は**型で必須**にする（決定 2）。`check()`/`getIdentity()` は `AuthProvider` の
契約から外す（admin-core の中で呼ぶ場所が無くなる。互換 adapter の入力の型
`LegacyAuthProvider` にだけ残す）。`enterPublicViewer` の戻り値は `boolean` から
`{ success, superseded? }` に変える（**公開引数を 1 つ足す**。前の版の「公開引数は増やさない」は
S-52 の保証と両立しないので改める。レビュー 2）。

書き込みの compare-and-set（#259、I-7）は provider の**内部**で行う:

- `login`/`setup`: 呼び出しの開始時に `revision` を読み、応答を書くときに一致するときだけ
  `setToken`。一致しなければ書かず、戻り値は `{ success: false, superseded: true }`（`error` も付ける）。
- `enterPublicViewer`: `expectRevision`（無ければ開始時の revision）と一致するときだけ `setToken`。
- `logout`: 開始時の revision と一致するときだけ `setToken(null)`。一致しなければ消さない
  （別のログインが済んでいる）。`POST /api/auth/logout` は開始時のトークンで送る（今の
  `headers(false)` は送信時の `getToken()` を読むので、**開始時に固定する**）。戻り値は
  `Promise<void>` のまま（アプリは戻り値で判断せず `resolve()` で確定する、I-10）。
- `resolve()` の `none` でのトークン消去は `clearTokenIfCurrent(token)`（今の `check()` と同じ）。
- **revision の更新と通知**（I-19）: 自分が `setToken` した継続で revision を +1 し
  `onCredentialChanged` を呼ぶ。Tauri は操作の応答の `seq` で revision を置き換えて呼ぶ。
  操作の応答が得られない（`fetch` が送信後に失敗、`invoke` が reject）ときは、状態が変わったかも
  しれないので revision を +1 して呼ぶ（安全側。controller は保留 → `resolve()` で確定する）。

**互換 adapter**（`adaptLegacyAuthProvider(legacy: LegacyAuthProvider): AuthProvider`、別の
export。自前の `AuthProvider` を持つ派生アプリ向け。決定 2）:

| 保証すること                                                                                                                              | 保証しないこと                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve()` の 3 値の形（`check()` が `false` → `none`、`true` → `getIdentity()` を呼び identity → `active`、どちらかの reject → reject） | **1 往復ではない**: `check()` と `getIdentity()` の間に資格情報が変わりうる。`credentialRevision` を旧 provider は持たないので、adapter は検知できない（2 往復の答えが別の資格情報についてのものになりうる） |
| `check()` の `true` と `getIdentity()` の `null` の組み合わせは reject にする（「id の無い active」に潰さない）                           | **`check()` の副作用の安全性**: 旧 `check()` がトークンを消す・別のことをするかは adapter には分からない。compare-and-set も保証しない                                                                       |
| `login`/`logout`/`setup`/`enterPublicViewer` はそのまま通す（`enterPublicViewer` の `boolean` は `{ success }` に写す）                   | それらの書き込みが compare-and-set であること（#259 の型の競合は残る）。`expectRevision` は無視される                                                                                                        |
| `credentialRevision`/`onCredentialChanged` は**提供しない**（undefined のまま）                                                           | 別タブの切り替えの検知（I-5・I-17・I-19 の既定の流れは効かない）                                                                                                                                             |

adapter は「型を通すための移行の足場」であり、**旧実装を完全対応として扱わない**。
使う派生アプリは、移行の手順（§6.2）に従って自前の provider に `resolve()` を実装するか、
admin-core の provider に乗り換える。

### 5.3 Tauri の Rust 側の API の変更の案

```rust
/// state.auth の置き換え。
struct AuthSlot {
    session: Option<DesktopSession>,
    /// 結び付きを変える意図の操作で +1（I-11）。同じ結び付きの refresh では進めない。
    seq: u64,
}
// AppState { auth: Mutex<AuthSlot>, .. }

/// 1 つのロックの中で「期待した seq のときだけ書き、seq を進める」。値が同じでも進める
/// （logout の None→None は、先に始まった login を無効にするために必要）。
fn cas_session(state: &AppState, expected_seq: u64, next: Option<DesktopSession>) -> (bool, u64);

/// settle_session の refresh 用: 今の session と同じ結び付き（same_binding）なら値だけ
/// 置き換え、seq は進めない。結び付きが違えば何もしない。
fn refresh_same_binding(state: &AppState, fresh: DesktopSession) -> bool;

/// フロントの provider.resolve() の相手。current_session() の再検証を通した identity・kind・seq。
/// ログイン不要モードの合成 identity もそのたびにモードと権限を読み直し、kind = "local" を返す。
#[tauri::command]
async fn auth_resolve(state) -> Result<AuthResolveResult, BantoError>;
// AuthResolveResult { identity: Option<Identity>, kind: Option<SessionKind>, seq: u64 }

// 状態を変えるコマンドの応答は seq を含む（I-19）:
// LoginResult { success, error, superseded: bool, seq: u64 }   -- auth_login / auth_setup
// LogoutResult { seq: u64 }                                    -- auth_logout（今の () から変更）

// 既存コマンドの変更: 最初の .await の前に seq を読み、書くときに cas_session。
// auth_login  : seq を読む → verify().await → 成功なら cas_session(seq, Some(Account)) →
//               書けなければ LoginResult { success: false, superseded: true, seq: now }。
//               監査は今のまま「検証に成功した」時点で "login"（§1.7、決定 7）。
// auth_setup  : 同上（アカウントの作成は行い、セッションだけ入れない）。
// auth_logout : seq を読む → auth_config().await → cas_session(seq, None) →
//               書けなければ LogoutResult { seq: now }（何もしない。監査も残さない）。
// settle_session: 有効なら refresh_same_binding（seq 不変）、失効なら cas_session(seq_at_read, None)。
// auth_config_apply_body: is_none() の照合を cas_session に乗せ替え（seq は進む）。
// change_own_password: id + auth_epoch の照合はそのまま、rebind で seq を進める。
```

`LoginResult` の `superseded`/`seq` と `LogoutResult` は wire の追加（TS 側は無ければ
`false`/undefined と読む）。REST の `/api/auth/login` は変えない（REST 側には 1 スロットが無い、§1.4）。

「Rust が世代の不一致でセッションの確定を拒否した」ことの観測（画面側が応答を捨てただけの場合や
通常の認証失敗とは別のイベント）は**任意・後で**（決定 7）。入れるなら `login` とは別の action に
し、REST 側と `login` の意味を揃える議論（§1.7）を先にする。

フロント側の `createTauriAuthProvider` は、`login`/`logout`/`setup` の**応答の `seq`** で
`credentialRevision()` を置き換え、その継続で `onCredentialChanged` を呼ぶ（I-19、S-55）。
`invoke` が reject したら revision を +1 して呼ぶ。`auth_resolve` の `seq` でも更新する（refresh では
変わらないので、通常は同じ値）。

### 5.4 既存の公開名の移行（決定 1）

| 今の公開名                                                                                           | v2.0.0 での扱い                                                                                                                        | 理由                                                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `resolveProtectedSession`                                                                            | **削除**（`resolveSettled()` + アプリの方針に分かれる）                                                                                | `enterPublicViewer` の呼び出しを core から外す。意味が変わる    |
| `establishSession`・`beginSession`・`endSession`                                                     | **削除**（`resolve()`・`adopt(…, ticket)`・`end(…, ticket)`。ログアウト後の `endSession()` は `resolveSettled()` に）                  | 呼び出し側に状態更新の組み立てを求める入口。単一の書き手（I-1） |
| `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`・`SessionEndConfirmation` | **削除**（`controller.signal()` に格下げ。`connectEvents` は内部で `signal` を呼ぶ）                                                   | 本文「signal の入口に格下げ」                                   |
| `SessionChangedError`・`MAX_STALE_RETRIES`                                                           | **削除**（`unverified` の `error` に同名のエラーを入れる。上限は deps）                                                                | reject しない契約（I-8）                                        |
| `ProtectedSessionOutcome`                                                                            | **削除**                                                                                                                               | `resolveProtectedSession` と一緒                                |
| `AuthProvider.check` / `getIdentity`                                                                 | **契約から削除**（`LegacyAuthProvider` と互換 adapter にだけ残る）                                                                     | controller が呼ばない（§5.2）                                   |
| `AuthProvider.enterPublicViewer`                                                                     | **形を変える**（`(options?) => Promise<{ success, superseded? }>`）                                                                    | ticket に結び付けた発行（S-52）                                 |
| `onSessionEnded`                                                                                     | **残す**: `subscribe` の上の薄い関数（active/unknown → none の遷移だけを通知）。独自のカウンタ・unheard 管理は持たず controller に委譲 | アプリの `invalidateAll()` 配線がそのまま使える                 |
| `sessionGeneration`・`currentSessionScope`・`isCurrentSessionScope`・`isSessionEstablished`          | **残す**: 既定の controller の `snapshot`/`scope()`/`isCurrent()` への委譲。読み取りだけ                                               | `listViewState` と画面の書き込み条件が使う。意味は変わらない    |
| `sessionOwnerKey`                                                                                    | **残す**。`kind` ごとの名前空間を足す（`publicViewer` は `public-viewer` のまま。adopt は `${kind}:${id}`）                            | 保存状態の互換                                                  |

参照・購読の API は**独自の状態や確認処理を持たない**（I-1）。`sessionScope.svelte.ts` の
モジュール変数は controller の中に移り、これらの関数は既定の controller を読むだけになる。

## 6. SvelteKit との接続と、派生アプリの移行

### 6.1 admin-template の配線（v2.0.0 の形）

- `(app)/+layout.ts` の `load`:

  ```ts
  const controller = getSessionController();
  const result = await resolveSettled(controller, { cause: 'navigation' }); // superseded は中で要求し直す
  if (result.outcome === 'unverified') error(503, ...); // 再試行の画面（今のまま。期限切れも同じ）
  let snapshot = result.snapshot;
  if (snapshot.status === 'none') {
  	snapshot = await publicViewerFallback(controller, authProvider, result.ticket); // アプリの方針（下）
  	if (snapshot.status !== 'active') redirect(307, `${base}/login`);
  }
  if (snapshot.kind === 'publicViewer') { /* 許可リストの redirect（今のまま） */ }
  return { sessionGeneration: snapshot.generation }; // この load で確認できた generation だけ（I-16）
  ```

  `load` の副作用は `controller.resolve()`（と方針の `enterPublicViewer`）だけ。`sessionStore` への
  代入は `load` から消える（`authDisabled` の別読みも消える、S-61）。`superseded` のまま
  `sessionGeneration()` を返す今の 105 行の形は**無くす**（S-48〜S-50）。

- `publicViewerFallback(controller, provider, ticket)`（admin-core の**任意の**ヘルパー。controller の
  外。**ticket を最後まで持ち回る**、S-42・S-52）:

  ```ts
  const status = await provider.status?.();
  if (!controller.isCurrent(ticket)) return (await resolveSettled(controller)).snapshot; // 同期の照合、この後 await まで無し
  if (!status?.viewerPublic) return controller.snapshot;
  const issued = await provider.enterPublicViewer?.({ expectRevision: ticket.revision }); // 発行の中の CAS も ticket の revision
  return (await resolveSettled(controller)).snapshot; // issued の成否に依らず、今の資格情報で確定
  ```

  `adopt()` は使わない。

- `sessionStore`（`$lib/session.svelte.ts`）: `identity`・`role`・`publicViewer`・`authDisabled` は
  `controller.snapshot` からの `$derived`（`authDisabled = snapshot.kind === 'local'`）。
  派生アプリの `sessionStore` も同じ形（`load()` は無くなる）。
- `Header.svelte`・`commands.ts` のログアウト（I-10、S-17・S-51）:

  ```ts
  await provider.logout(); // 消せたなら provider が revision を進めて通知 → controller は保留
  const result = await resolveSettled(controller); // none なら commit(none) = 保存状態の全消去
  if (result.outcome === 'confirmed' && result.snapshot.status === 'none') goto(`${base}/login`);
  // active のまま（別のログインが確定していた）なら何もしない。unverified なら再試行の表示
  ```

  `end()` は呼ばない。

- `events.ts` `connectEvents`: `onUnauthorized` → `controller.signal('unauthorized')`、
  `onTokenCleared` → `controller.signal('credentialCleared')`。退避は controller の中。
- `+layout.svelte` の配線は **3 本に分ける**（レビュー 7、S-36・S-59・S-60）:

  ```ts
  let lastActiveOwner: string | null = null;
  $effect(() =>
  	controller.subscribe((s, prev) => {
  		if (s.generation !== prev.generation) void invalidateAll(); // ① 世代が変わったら再 load（保留・確定・終了のすべて）
  		if (s.status === 'active') {
  			if (lastActiveOwner !== null && s.owner !== lastActiveOwner) ownerChanged(s); // ② owner の差分だけ通知
  			lastActiveOwner = s.owner;
  		}
  		if (s.status === 'none') lastActiveOwner = null;
  	})
  );
  ```

  ① により、同じ A の再ログイン（S-59）も、切り替え後の確認の失敗（S-60、再 load の
  `resolveSettled` が `unverified` → `error(503)`）も、画面が空のまま止まらない。同じ generation を
  確認し直す `load` は状態を変えないので、① は 1 回で止まる。世代ゲート
  `{#if data.sessionGeneration === controller.snapshot.generation}{#key ...}` は**そのまま**（I-14）。
  `onSessionEnded(() => void invalidateAll())` は ① に含まれるので、admin-template では使わなくなる
  （公開名としては残す、§5.4）。
  ③ `ownerChanged(s)` は `ownerChangePolicy`（`initBanto` か layout で注入。`'rebuild'`（既定）|
  `'relogin'`）: `'rebuild'` は `notify('info', 別のユーザーでログインされました)` だけ（作り直しは ① が
  する）。`'relogin'` は通知して `goto(login)`。**どちらもトークンは消さない**（I-17）。

- `login/+page.svelte`: `login()` 成功後の `goto(dashboard)` はそのまま（`load` の `resolveSettled()`
  で確定）。`superseded: true` が返ったら「別のセッションが確定しました」を出して `goto(dashboard)`
  （`load` が確定する）。

### 6.2 派生アプリ（banto-industrial）の移行の手順の案

A′ 案のとおり、**候補版で検証したうえで、正式版への参照の更新まで 1 本の移行 PR** で行う。
両アプリとも `github:tyaro/banto#v1.7.3&path:...` → `#v2.0.0`。

| 対象                                                     | 置き換え                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/*/src/lib/session.svelte.ts` の `load()`           | 削除。`identity`/`role`/`authDisabled` は `getSessionController().snapshot` からの `$derived`                                                                                                                                                                                                                                                                                                                                            |
| `apps/*/src/lib/banto/sessionGuard.ts`                   | `resolveProtectedSession` → `resolveSettled(controller)`。`'unverified'` は `outcome === 'unverified'`、`'login'` は `confirmed && status === 'none'`                                                                                                                                                                                                                                                                                    |
| `apps/*/src/routes/(app)/+layout.ts`                     | §6.1 の形（公開閲覧の fallback は両アプリとも無い）。返す generation はこの `load` で確認できたものだけ                                                                                                                                                                                                                                                                                                                                  |
| banto-hub `sessionStore.enterCommissioningMode()`        | **ticket を先に取る**: `const t = controller.ticket(); const status = await fetchCommissioningStatusOrNull(); if (bypass) { if (!controller.adopt(COMMISSIONING_IDENTITY, 'commissioning', t)) return resolveSettled(...) } else if (controller.snapshot.kind === 'commissioning') { controller.end('commissioning-locked', t); } await resolveSettled(...)`（S-44・S-45・S-53）。`adopt()` を使うのはこれだけ                           |
| banto-hub `sessionRecheck.ts`                            | `recheckSessionAfterStreamClose` → `controller.signal('app')` + `invalidateAll()`。`probeSessionAfterReconnectFailures` → `resolveSettled(controller, { cause: 'signal' })`（要求自体が signal の stamp を進める、S-58）の結果を `SessionProbeResult` に写す（`confirmed/none → 'login'`、`confirmed/active → 'session'`、`unverified → 'unverified'`）。独自の token 照合・single-flight・期限・`/api/auth/check` の直接 `fetch` は削除 |
| banto-hub `(app)/+layout.svelte`・`monitor/+page.svelte` | §6.1 の 3 本の配線（世代 → 再 load、owner → 通知、unverified → 再試行）                                                                                                                                                                                                                                                                                                                                                                  |
| 各アプリの `Header`/ログアウト                           | `await provider.logout(); await resolveSettled(controller)`（`end()` は呼ばない、S-51）                                                                                                                                                                                                                                                                                                                                                  |
| **自前の `AuthProvider` を持つ場合**                     | v2 の `AuthProvider` は `resolve` が必須なので**型エラーになる**。対応は 2 つ: (a) `resolve()` を実装する（推奨。HTTP なら `GET /api/auth/identity` 1 回、§2.1）、(b) 一時的に `adaptLegacyAuthProvider(...)` で包む（保証しない範囲を §5.2 の表で確認し、移行 PR の本文に「adapter 使用中」と明記する）。banto-industrial の 2 アプリは admin-core の provider を使っているので該当しない見込み（§1.6、推測）                           |
| `#216` の `lan_urls` 3 か所・`#248` の監査ログ           | 同じ移行 PR に含める（Issue #260「進め方」3）。セッションとは独立                                                                                                                                                                                                                                                                                                                                                                        |

試運転の `adopt` については、banto-hub の `commissioning.ts` の `shouldBypassLoginForCommissioning`
の判断そのものは変えない（アプリの方針のまま）。

## 7. 実装の分割と、候補版での検証

### 7.1 実装の PR

| PR     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 受け入れ条件                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装-1 | **provider とバックエンド**: `AuthProvider.resolve`（この PR では任意で追加、実装-3 で必須化）/`credentialRevision?`/`onCredentialChanged?`/`enterPublicViewer` の新しい形、HTTP provider の `resolve()`（`GET /api/auth/identity` 1 回、`none` で compare-and-set 消去）と書き込みの compare-and-set（#259）と `storage` 監視と**操作の応答での revision 更新と通知**、`adaptLegacyAuthProvider`、Rust に `AuthSlot`（seq の規則 I-11）・`refresh_same_binding`・`auth_resolve`（kind 込み）・`LoginResult`/`LogoutResult` の `seq`・login/setup/logout の compare-and-set・**検証と設定取得の注入点**（§8.3）。**REST のルートは足さない** | S-9・S-16〜S-21・S-40・S-54・S-55（provider 側）のテスト（Rust は `cargo test` でコマンド本体の順序を固定、TS は vitest）、adapter の保証する範囲のテスト。既存テスト全緑。controller はまだ無く、公開 API は追加だけ。**タグは打たない** |
| 実装-2 | **controller**: `sessionController.svelte.ts`（`commit`・`resolve`・`signal`・`ticket`・`adopt`・`end`・deps 注入、§5.1 の手順 1〜7）、`resolveSettled`、テストのハーネス（§8.1）、S-1〜S-15・S-23〜S-34・S-42〜S-50・S-53・S-56〜S-58 のテスト。既存の `establishSession` 等は**この PR では controller への委譲に書き換えて残す**（admin-template を壊さないため）                                                                                                                                                                                                                                                                         | 全シナリオが S 番号付きで通る。既存の `sessionRaces`/`sessionGate`/`sessionEnded*` テストが呼び口の変更だけで通る                                                                                                                         |
| 実装-3 | **admin-template の配線と v2.0.0**: §6.1（`load`、`publicViewerFallback` の ticket、ログアウトの `resolveSettled`、3 本の配線、`authDisabled` の導出）、`connectEvents` の `signal` 化、`ownerChangePolicy`、§5.4 の削除と `resolve` の必須化、S-35〜S-39・S-51・S-52・S-59〜S-61 のテスト（`storage` イベントのモック）、E2E（`session-check-outage`・`public-viewer` を保つ。同じアカウントの再ログインと S-36 を追加）、CHANGELOG の「挙動の互換性が変わる変更」と移行表                                                                                                                                                                  | `pnpm check`/`test`/`e2e`/`e2e:public-viewer` 全緑。Tauri check 緑。CHANGELOG に §5.4 の表と §6.2 の自前 provider の項                                                                                                                    |
| 移行   | **banto-industrial**（候補版の検証後）: §6.2 と参照の `v2.0.0` 化を 1 本で                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 両アプリの `check`/`test`/E2E、実機 smoke（banto-hub のローカル smoke 手順）、試運転の入退場（S-53 を含む）、ストリーム切断後の再確認（S-58）、別タブでの切り替えの通知                                                                   |

実装-1 と実装-2 は並列に進められる（実装-2 は interface だけに依存）。実装-3 は両方の後。

### 7.2 候補版で派生アプリ 2 本を検証する手順

publishing.md は git タグ参照なので、候補版は**タグではなくコミット参照**で試す
（タグを打つのはオーナー）:

1. 実装-3 のマージ後、banto の main のコミット `X` を候補にする。
2. banto-industrial に**マージしない**検証ブランチを切り、両アプリの `package.json` の 5 パッケージを
   `github:tyaro/banto#X&path:...` に変え、`pnpm install`。
3. §6.2 の置き換えを行い、`pnpm check` → `pnpm test` → E2E → 実機 smoke（1 本ずつ）。
4. 見つかった問題は banto 側で直し、`X` を進めて 2 からやり直す。
5. 問題が無くなったら、オーナーが `v2.0.0` を打つ → 検証ブランチの参照を `v2.0.0` に置き換えて
   移行 PR にする（同じ PR に #216・#248 の分も入れる）。

## 8. テストの設計

### 8.1 順序をテストから決める仕組み（TS）

- `createSessionController(provider, { scheduler, clock })` に、テストの `scheduler`（手動で
  進めるタイマー）と `clock`（手動のカウンタ）を渡す。vitest の fake timers に頼らず、
  「どの順で解決するか」をテストの文で書けるようにする。
- `makeProbeProvider()`（`sessionRaces.test.ts` の `makeAuth` の後継）:
  - `resolve()` の答えを `deferred` の配列に積む（`probes[n].resolve({ status: 'active', identity })`
    / `.reject(err)`）。
  - `revision` をテストが上げ下げでき、`emitCredentialChanged()` で listener を呼べる。
  - `login`/`logout`/`setup`/`enterPublicViewer` も `deferred` で、完了のタイミングを決められる。
    `enterPublicViewer` は受け取った `expectRevision` を記録する（S-52）。
- 「同じターン」（S-6・S-7・S-12〜S-15）は、複数の `deferred` を**同じ同期ブロックで**解決してから
  `await` する。既存テストと同じ書き方。
- `resolveSettled`（S-48〜S-50）は、`superseded` の後に要求し直すこと、返す generation が
  要求し直した確認のものであること、`deadlineMs` で `unverified` になることを `scheduler` を進めて確かめる。
- 出し直しの条件（I-9、S-14・S-29・S-46）は、「待機要求なし・`pendingBackground` なし」で
  probe が増えないこと、どちらかがあれば増えることを、`probes.length` で確かめる。
- 失敗の鮮度（S-56）: B 確定後に古い probe を `reject` し、`snapshot` と `verification` が
  **同一参照**のままであることを確かめる。
- 最初の 1 往復（S-57）: 新しい controller で `resolve()` → probe を fulfill → `confirmed`。
- ticket（S-52・S-53）: `ticket()` → `end`/`adopt`/保留を起こす → `adopt(…, t)`/`end(…, t)` が
  `false` で状態が変わらないこと。`publicViewerFallback` は `status` の `deferred` を B の確定の後に
  解決し、`enterPublicViewer` が**呼ばれない**ことを確かめる。
- テスト名は `S-n: ...` で始め、`describe` に `I-n` を書く。表と食い違ったら表を直す
  （表が正）。

### 8.2 provider のテスト

- HTTP `resolve()`: `fetchFn` のモックで `200 identity` / `200 null` / `401` / `500` / 通信例外の
  5 通り。`200 null` と `401` でトークンを送っていたときだけ `clearTokenIfCurrent` が効くこと、
  応答待ちの間に別のトークンに変わっていたら消さないこと。
- HTTP の書き込み: 応答の解決の前に別の `setToken`（別のログイン）や `storage` イベントを入れ、
  書き込みが起きないこと（S-20・S-21・S-40）を `storage` の中身で確かめる。`enterPublicViewer`
  は `expectRevision` が今の revision と違えば書かないこと（S-52）。
- revision と通知（I-19）: `login` の応答の継続で `credentialRevision()` が進み listener が 1 回
  呼ばれること。`fetch` が送信後に失敗しても進んで呼ばれること。
- 互換 adapter: `check() true` + `getIdentity() null` が reject になること、`credentialRevision` が
  `undefined` であること（保証しない範囲を「テストで固定」する）。
- Tauri provider: `invoke` のモックで `login`/`logout` の**応答の `seq`** が `credentialRevision()` に
  反映され、その継続で `onCredentialChanged` が 1 回呼ばれること。続く `auth_resolve` が reject しても
  通知が済んでいること（S-55）。`auth_resolve` の `seq` が同じなら listener は呼ばれないこと（S-54）。

### 8.3 Rust 側の競合のテスト（`apps/admin-template/src-tauri/src/lib.rs` の `#[cfg(test)]`）

レビュー 10 のとおり、**コマンド本体で完了の順序を固定する**。そのために、コマンドが
`.await` する 2 つの処理に**注入点**を設ける（REST の `audited_credential_verifier` が
`AuthState::new` に closure を注入しているのと同じ形、§1.7）:

```rust
/// login/setup が await する検証。production は UsersService を包む。テストは gate 付きの実装を渡す。
type CredentialVerifier = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<Option<UserIdentity>, BantoError>> + Send + Sync>;
/// logout が await する設定の読み。production は SettingsService::auth_config。
type AuthModeSource = Arc<dyn Fn() -> BoxFuture<'static, Result<AuthSettings, BantoError>> + Send + Sync>;
// AppState { verifier: CredentialVerifier, auth_mode: AuthModeSource, .. }

// コマンドは薄い adapter、本体はテストから呼べる関数:
async fn login_body(state: &AppState, username: &str, password: &str) -> Result<LoginResult, BantoError>;
async fn logout_body(state: &AppState) -> Result<LogoutResult, BantoError>;
async fn resolve_body(state: &AppState) -> Result<AuthResolveResult, BantoError>;
```

テストの gate: `tokio::sync::oneshot` を持つ verifier / auth_mode。`tokio::spawn` で本体を走らせ、
gate を**テストが決めた順**で開ける。

- **S-16**（復活しない）: `login_body(B)` を spawn（verifier の gate で止まる）→ `logout_body()` を
  完了させる（`None`、`seq` 進む）→ gate を開ける → `login_body` の戻りが
  `{ success: false, superseded: true }`、`state.auth.session` は `None`、監査は `login`（検証成功）
  1 件と `logout` 0 件（`previous` が無かった場合）。
- **S-17**（消えない）: `logout_body()` を spawn（auth_mode の gate で止まる）→ `login_body(B)` を
  完了させる（`Some(B)`）→ gate を開ける → `logout_body` の戻りは `{ seq }`、`state.auth.session` は
  `Some(B)`、監査に `logout` が**無い**。
- **配線の検出**: `seq` を `.await` の後に読む誤りを検出するため、gate が開くまでの間に
  `cas_session` を 1 回進める（別の操作）→ 正しい配線なら CAS は失敗する。この「gate の間に seq を
  進める」テストを S-16/S-17 それぞれに持つ。
- **S-18/S-19**: `auth_setup` の本体（`setup_body`）で同じ 2 本（`setup_first_user` は実 DB で 1 回）。
- **S-54**: `resolve_body` を 3 回続けて呼び、`seq` が変わらないこと。間に `users` の role を変えて
  `resolve_body` を呼ぶと identity の role は変わるが `seq` は変わらないこと（refresh）。
- **S-47**: ログイン不要モードで `auth_config` を書き換えた後の `resolve_body` が新しい権限と
  `kind: "local"` を返すこと。
- **補助（非決定的）**: `tokio::join!` で `login_body` と `logout_body` を同時に走らせ、終わった
  あとの `state.auth` が「`None` かつ login が `superseded`」か「`Some(B)` かつ logout が no-op」の
  **どちらか**であることを複数回回す。順序を固定する上のテストの補助として置く（これだけでは
  修正前の不具合も通るので、単独では受け入れ条件にしない）。

### 8.4 E2E

- 既存の `e2e/tests/session-check-outage.ts`（500 の再試行）と `e2e/tests-public-viewer/` は保つ。
- 追加: 「別タブで B がログイン → 元タブが通知を出して B の権限で作り直され、A の未保存入力が
  残らない。B のタブはログインしたまま」（S-35、I-17）を Playwright の 2 ページ（同じ
  context）で。`storage` イベントは同じ origin の 2 ページで実際に飛ぶ。
- 追加: 「別タブで**同じ A** として再ログイン → 元タブが作り直され、通知は出ない」（S-59）。
- 追加: 「identity の 500 の後、別タブでログイン → 元タブが旧ユーザーの画面を出さず、503 の
  再試行画面になる」（S-36・S-60）。
- 追加: 「ログアウトを押した直後に（別タブで）ログイン → 元タブはログイン画面に行かず、
  新しいセッションの画面になる」（S-51。`logout` の応答を route の遅延で遅らせる）。

## 9. オーナーの決定（2026-09-29。第三者のレビューを受けて採用）

設計の PR（#261）の判断点に対する決定。本文の各節はこの決定に合わせてある。

1. **旧 API は v2 で削除する。** 状態を更新する旧 API（`establishSession` / `beginSession` /
   `endSession` / `resolveProtectedSession` / `confirmSessionEnded` / `SessionChangedError` など、
   呼び出し側に状態更新の組み立てを求める入口）は削除。参照・購読の API（`sessionGeneration` /
   `onSessionEnded` など）は残すが、独自の状態や確認処理は持たせず controller への委譲に統一する
   （§5.4、I-1）。
2. **`AuthProvider.resolve` は v2 の標準契約で必須（型で必須）。** 旧 provider への対応は明示的な
   互換 adapter に分離する。旧 `check()`/`getIdentity()` を包むだけでは資格情報との対応や副作用の
   安全性は保証できないので、保証する範囲・しない範囲を明記し（§5.2 の表）、旧実装を黙って
   完全対応扱いしない。派生アプリの自前 provider が型エラーになることを移行手順に書く（§6.2）。
3. **`GET /api/auth/session` は新設しない。** 既存の `GET /api/auth/identity` が `require_auth` と
   同じ再検証（#204）を通るので、HTTP の `resolve()` はこれを 1 回だけ呼ぶ: `200` で identity →
   active、`200 null` または `401` → none、それ以外 → reject。無効なトークンは `401` ではなく
   `200 null` で返る。トークンを送って none が返ったら失効が確定したとみなし、compare-and-set で
   そのトークンを消す（§1.2・§2.1・§5.2）。実装-1 の範囲から `GET /api/auth/session` を外す。
   **新設を判断する条件**: 既存ルートで満たせない具体的な要件が出たとき（例: identity と一緒に
   返さなければ整合が取れない値が増えたとき）。それまでは足さない。
4. **Tauri のログイン不要モードは provider の `resolve()` に任せる**（Rust の `auth_identity` は
   そのたびにモードと権限を読み直す、§1.3）。アプリ側で合成 admin を `adopt()` しない。`adopt()` は
   派生アプリ固有の試運転などに限り、公開閲覧の fallback とは分ける（I-13、S-42・S-47）。
5. **`superseded` になった `load` に今の generation を返さない。** `superseded` は「この確認結果は
   採用できない」であって、navigation が破棄されたとは限らない。まだ有効な `load` は最新の確認に
   合流するか要求し直し、実際に確認できた結果の generation を返す。確認できなければ再試行画面へ。
   旧ユーザーのページデータを新しい世代へ引き継がない。再確認には期限を設ける
   （I-16、S-48〜S-50、`resolveSettled` §5.1）。
6. **確認を出し直さないのは、画面からの待機要求も、背景の確認の必要（SSE の失効通知や資格情報の
   変更の後の、まだ処理していない確認）も無いときだけ。** 待機者の数だけで判断しない
   （I-9、S-14・S-29・S-46、§5.1 の `pendingBackground`）。
7. **`login_superseded` の監査は今回の必須要件から外す。** 今の login の監査は REST・Tauri とも
   「資格情報の検証に成功した」時点で記録している（§1.7）。Tauri に compare-and-set を入れると
   「検証成功・確定拒否」が生まれるので、記録の意味を REST と揃える議論を先にする。観測が必要なら、
   「Rust が世代の不一致で確定を拒否した」ことを、画面側が応答を捨てただけの場合や通常の認証失敗とは
   区別した別のイベントとして記録する（任意、後で）。
8. **別タブでユーザーが切り替わったとき（#257）の既定の流れ**: 検知したら旧画面の操作を止める →
   新しいセッションを確認する → 別のユーザーへの変更が確認できたら通知し、新しい権限で画面を
   作り直す → 旧ユーザーの未保存の入力や選択は引き継がない → 確認に失敗したら旧画面へ戻さず
   再試行の状態に留める → 共有のトークンを勝手に消さず、別のタブまでログアウトさせない。
   共用の端末などで再認証が必要なアプリのために「通知してログインへ移す」方針も注入で選べる
   （I-17、§4.6、§6.1 `ownerChangePolicy`）。

### 9.1 オーナーのレビュー（2026-09-29、`63ca79d` 対象、10 件）への対応

| #   | 指摘                                             | 対応                                                                                                                                                           | 反映先                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | logout 後の `end` にも照合が要る                 | ログアウト後に `end()` を呼ぶ入口を無くし、`resolveSettled()` で今の資格情報を確定する契約に統一。`end` は方針専用で ticket 必須                               | I-10、S-17・S-51、§5.1、§6.1       |
| 2   | none 確認時の対象を fallback 全体に結び付ける    | `confirmed` の結果に `ticket` を含め、`status()` の後の同期の照合と `enterPublicViewer({ expectRevision })` の両方で照合。「公開引数は増やさない」を改めた     | I-18、S-42・S-52、§5.2、§6.1       |
| 3   | 非同期の試運転判定からの `adopt` に鮮度の条件    | `adopt(identity, kind, ticket)`・`end(reason, ticket)`。判定の前に `ticket()` を取り、stale なら何もしない                                                     | I-13・I-18、S-44・S-45・S-53、§6.2 |
| 4   | 同値 refresh で `seq` を進めない                 | `seq` の規則を「結び付きを変える意図の操作で進める（値が同じでも）、同じ結び付きの refresh では進めない」と定義。`refresh_same_binding` を分けた               | I-11、S-54、§5.3、§8.3             |
| 5   | 変更の通知を追加の確認の成功に依存させない       | 操作の応答に `seq` を含め、provider は応答の継続で revision を確定して通知。応答が無いときも進めて通知。identity の再確認は独立                                | I-19、S-55、§5.2、§5.3、§8.2       |
| 6   | reject も同じ鮮度の判定を通す                    | fulfill・reject・timeout のすべてを同じ照合（手順 4）に通し、古い失敗は状態も `verification` も変えずに捨てる                                                  | I-3、S-56、§5.1                    |
| 7   | owner 変更の通知とは別に画面の再確認を配線       | 配線を 3 本に分けた（世代 → 再 load、owner の差分 → 通知、`unverified` → 503）                                                                                 | S-36・S-59・S-60、§6.1、§8.4       |
| 8   | 自分の commit で自分を superseded にしない       | 判定は probe の `epochAtStart` で行い、`superseded` は外からの遷移の時点で決める                                                                               | I-20、S-14・S-57、§2.1、§5.1       |
| 9   | `cause: 'signal'` の合流判定に要求の時点を含める | `cause: 'signal'` の要求自体が signal の stamp を進める                                                                                                        | I-9、S-58、§5.1                    |
| 10  | Rust のテストでコマンド本体の完了順序を固定      | 検証と設定の読みを注入点にし（REST と同じ形）、gate 付きの実装でコマンド本体の順序を固定。「gate の間に seq を進める」で配線の誤りも検出。非決定的テストは補助 | §1.7、§8.3                         |
| —   | 全体の確認（共通の原則・洗い出し）               | ticket の原則を §2.3 と I-18 に定義。「状態を書き換える入口 × 非同期の境界」の表を §4.9 に置き、同じ型を 1 件追加で見つけた（`authDisabled` の別読み、S-61）   | §2.3、§4.9                         |

## 10. 未確認の点

- Rust の壊れる順序（§1.3）は**コードの読みで特定**した。実機・テストでの再現はしていない
  （実装-1 の S-16/S-17 のテストが再現を兼ねる）。
- `GET /api/auth/identity` が `401` を返す経路は、コードの読みでは見つからなかった
  （`bearer_token` が無ければ `200 null`）。決定 3 のとおり `401` も none として扱うので、
  実装には影響しない。
- `sessionRecheck.ts` の `probeSessionAfterReconnectFailures` の 3 値を `resolveSettled()` の結果に
  写す対応（§6.2）は、`monitor/+page.svelte` の使い方（`streamClose.ts`）を読み切っていない。
  移行 PR で確認する。
- banto-industrial の 2 アプリが自前の `AuthProvider` を持たないことは、`session.svelte.ts` と
  `sessionGuard.ts` が admin-core の provider を使っていることから推測した。`setup.ts` の全文は
  読んでいない。
- `storage` イベントの発火は同じ origin の**別の**ドキュメントに限られる（同じタブでは飛ばない）。
  同じタブの別ログインは provider 自身の `setToken` で revision を上げるので問題ないはずだが、
  Tauri の webview（WebView2）での `storage` イベントの挙動は未確認（Tauri は `sessionStorage`
  も使わないので影響は無いはず。推測）。
- Web Locks API による `localStorage` の原子化は不採用としたが（§4.6）、対応ブラウザの
  範囲は調べていない。
- §4.9 の表で `settings.syncFromProvider()`（M12 の UI 設定の同期）も「`await` の後に照合なしで
  ストアを書く」型に当たるが、セッションの状態ではないので範囲外にした。別の issue の候補。
- Rust の注入点（`CredentialVerifier`・`AuthModeSource`）を `AppState` に足すと、`run()` の
  bootstrap と既存の 23 本のテストの `AppState` 構築が変わる。実装-1 で規模を見る。
