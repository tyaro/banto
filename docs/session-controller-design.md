# SessionController 設計（Issue #260）

- 状態: 設計案（実装前。§9 の判断点はオーナーの決定済み、2026-09-29）
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
| アプリ（`Header.svelte`・`commands.ts`）            | `endSession()`                      | `logout()` が完了した後                                                  |
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

| コマンド                                   | 行      | 直前の `.await`                                              | 書き方                                                                           |
| ------------------------------------------ | ------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `auth_login`                               | 646-647 | `users.verify(...)`（argon2 の検証、遅い）→ `record_ok(...)` | `*state.auth.lock() = Some(Account(identity))`：**無条件**                       |
| `auth_setup`                               | 622-623 | `users.setup_first_user(...)` → `record_ok(...)`             | 同上：**無条件**                                                                 |
| `auth_logout`                              | 690-691 | `settings.auth_config()`                                     | `previous = lock().clone()` → `*lock() = None`：**無条件**（2 回の別ロック）     |
| `auth_config_apply_body`（参考：正しい形） | 902-906 | `settings.set_auth_config(...)` ほか                         | `if auth.is_none() { *auth = Some(..) }` を 1 つのロックの中で（PR #182 の指摘） |
| `change_own_password`（参考：正しい形）    | 752-757 | `users.change_password(...)`                                 | `id` と `auth_epoch` が一致するときだけ `auth_epoch` を進める（compare-and-set） |
| `settle_session`（参考：正しい形）         | 309-326 | （`current_session` の DB 読み出しの後）                     | `unchanged`（`cached` と一致）のときだけ消す                                     |

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
読み直す。**フロントが合成する必要は無い**（オーナーの決定 4）。

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
| banto-hub   | `src/routes/(app)/+layout.ts`     | `fetchCommissioningStatusOrNull()` → 迂回なら `enterCommissioningMode()`、そうでなければガード → `sessionStore.load()`                                                                 |
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

## 2. 責務と原則（#260 本文の確定形）

責務の表は Issue 本文のとおり。ここでは、オーナーのコメント（2026-09-29）で明確化を求められた
2 点を確定する。

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
  確認できなかった（確定状態は変えていない。再試行できる）／新しい要求か遷移に追い越された
  （**この確認の結果は採用できない**。navigation が破棄されたとは限らない）」を返す。
  呼び出し元が `snapshot.lastError` を見て推理することはしない。
- `superseded` を受けた呼び出し元は、まだ有効なら**最新の確認に合流するか要求し直し**、
  **実際に確認できた結果の generation** だけを使う。今の generation を代わりに返さない
  （決定 5、I-16）。再確認には期限がある（§5.1 `resolveSettled`）。

### 2.2 原則 7 の範囲

> フロントの確定したセッションの状態（owner・generation・identity）を終了の状態に移すのは
> controller だけ。資格情報の破棄とバックエンドの失効の処理は、provider とバックエンドが担う。

具体的には:

- controller が担う: `status`・`owner`・`generation`・`identity`・`kind` の遷移、保存状態の
  全消去の指示（`end()`）、listener への通知。
- provider が担う: トークンの保存・消去（compare-and-set）、`resolve()` が `none` を確定した
  ときの**そのトークン**の消去、別タブの変化の検知。
- バックエンドが担う: セッションの失効の判定（ADR-0014）、Rust 側 `state.auth` の
  compare-and-set（§5.3）。
- provider が資格情報を消しても、controller の確定状態はそれだけでは変わらない。
  provider は `onCredentialChanged` で controller に**知らせ**、controller が §3 の
  I-5 に従って遷移する。
- 別タブの切り替え（#257）の処理で、controller も provider も**共有のトークンを勝手に消さない**
  （決定 8、I-17）。

## 3. 不変条件（テストから参照する番号）

| 番号 | 不変条件                                                                                                                                                                                                                                                                                                                                                     | 由来                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| I-1  | **単一の書き手**: 確定状態（`status`・`owner`・`generation`・`identity`・`kind`）を変える関数は controller 内部の `commit()` 1 つ。公開の入口は `resolve` の適用・`adopt`・`end`・資格情報の変化による保留（I-5）の 4 つだけ。参照・購読の API（`sessionGeneration`・`onSessionEnded` など）は独自の状態や確認処理を持たず controller に委譲する             | 原則 1・7、決定 1                    |
| I-2  | **世代**: `commit` で `status` か `owner` が変わるとき、`end`、`adopt`、保留（I-5）のとき `generation` は +1。同じ owner の active→active（再確認）は据え置き。単調増加                                                                                                                                                                                      | `transitionSessionScope`             |
| I-3  | **鮮度**: provider の答えは、その問い合わせを始めた時点の（controller の遷移回数, 資格情報の revision）が適用時点と同じで、かつ始めた後に signal が来ていないときだけ `commit` できる。違えば破棄して問い合わせ直す（上限あり）                                                                                                                              | 原則 1・`sessionEnded.ts`            |
| I-4  | **取得不能は状態を変えない**: 同じ資格情報で確認に失敗しても、確定状態と保存状態は変えない。変わるのは `verification` だけ                                                                                                                                                                                                                                   | 原則 2・#204                         |
| I-5  | **資格情報の切り替えで旧 owner は active でなくなる**: 切り替えを知った時点で `status: 'unknown'`・`owner: null`・`generation + 1` にする（保留）。その後の確認に失敗しても旧 owner の active には戻さない。保存状態は消さない（owner 照合で読めないだけ）                                                                                                   | 原則 6                               |
| I-6  | **`end()` だけが保存状態を全消去する**: `end()` は `status: 'none'`・`generation + 1`・`clearAllListViewState()`。他の遷移は全消去しない（新しい owner の確定で他人の分を purge するのは今のまま）                                                                                                                                                           | `endSession`                         |
| I-7  | **資格情報の書き込み・消去は compare-and-set**: provider（トークン）も Rust 側（`state.auth`）も、操作を始めたときの revision / seq と一致するときだけ書く。controller は資格情報を書かない                                                                                                                                                                  | 原則 4・#259                         |
| I-8  | **controller の `resolve()` は reject しない**: 3 つの `outcome` のどれかを必ず返す。待機の期限がある。`superseded` の後の再確認にも期限があり、いつまでも待たない・再試行し続けない                                                                                                                                                                         | オーナーのコメント 1、決定 5         |
| I-9  | **single-flight と鮮度の下限**: 同時の `resolve()` で provider への問い合わせは最大 1 本。signal を起点とする確認は、その signal より後に始めた問い合わせでしか満たされない。破棄した問い合わせを**出し直さないのは、画面からの待機要求も、未処理の背景の確認の必要（signal・資格情報の変化）も無いときだけ**。待機者の数だけで判断しない                    | 本文「single-flight と鮮度」、決定 6 |
| I-10 | **認証の操作は待ち行列に入れない**: `login`/`logout`/`setup`/`enterPublicViewer` は provider を直接呼ぶ。操作の戻り値を直接 `commit` せず、その後の `resolve()` で確定する                                                                                                                                                                                   | 本文「一律に順番待ちさせない」       |
| I-11 | **Rust 側の `state.auth` は seq 付き**: 書き込みは、コマンドが開始時に読んだ `seq` と一致するときだけ（一致しなければ書かず、追い越されたことを返す）                                                                                                                                                                                                        | §1.3                                 |
| I-12 | **スナップショットは丸ごと**: `SessionSnapshot` は凍結したオブジェクトで、使う側は `owner`・`generation`・`identity`・`kind` を別々のストアから読まない                                                                                                                                                                                                      | 原則 5                               |
| I-13 | **adopt したセッションは provider の答えで終わらない**: アプリが `adopt()` したセッション（派生アプリ固有の試運転など）は `end()` か別の `adopt()` でだけ終わる。`resolve()` は provider に問い合わせず `confirmed` を返す。公開閲覧の fallback と Tauri のログイン不要モードは `adopt()` の対象ではない（provider が答える）                                | 本文「ポリシーとして注入」、決定 4   |
| I-14 | **controller は SvelteKit を知らない**: `load` は `controller.resolve()` を await して結果を返すだけ。`{#key generation}` はアプリ層                                                                                                                                                                                                                         | 本文                                 |
| I-15 | **待機を打ち切った後の遅い答えは無効**: 期限で `unverified` を返した問い合わせの答えが後で届いても `commit` しない。provider 側の副作用（`none` でのトークン消去）は provider の compare-and-set の範囲で起こり、`onCredentialChanged` 経由で I-5 に入る                                                                                                     | オーナーのコメント                   |
| I-16 | **確認していない generation を画面に渡さない**: `superseded` を受けた呼び出し元は、その要求で**実際に確認できた**結果の generation しか返せない。今の generation を代わりに返さない。旧 owner のページデータを新しい世代へ引き継がない                                                                                                                       | 決定 5                               |
| I-17 | **別タブの切り替えの処理は、共有のトークンを消さず、他のタブをログアウトさせない**: 資格情報の変化を検知したタブがすることは、旧画面の操作を止める → 新しいセッションを確認する → 変更が確認できたら通知して作り直す（または、注入された方針でログインへ移す）まで。トークンの消去は provider の `resolve()` が `none` を確定したときの compare-and-set だけ | 決定 8                               |

## 4. 競合のシナリオ

記法: `A`/`B` はアカウント、`P` は公開閲覧、`C` は試運転。`probe(n)` は provider の
`resolve()` の n 本目、`→` は時間の順、`‖` は**同じターン（同じマイクロタスクの並び）で
解決する**ことを表す。「期待」は controller の最終スナップショットと、要求ごとの `outcome`。

### 4.1 #255 の既存シナリオ（そのまま保つ。`sessionRaces.test.ts` ほか）

| 番号 | 順序                                                                                                                    | 期待                                                                                                                    | 不変条件 | 元のテスト            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| S-1  | A の `resolve()` が probe(1) を待つ → `end()`（ログアウト）→ B の `resolve()` が probe(2) で確定 → probe(1) が A を返す | A の要求は `superseded`。B の owner・generation・保存状態は変わらない                                                   | I-1・I-3 | `sessionRaces` 117 行 |
| S-2  | A の `resolve()` が probe(1) を待つ → `end()` → probe(1) が A を返す（新しい要求は無い）                                | probe(1) は破棄、A の要求が待っているので probe(2) を出し直す。probe(2) の答えで確定                                    | I-3・I-9 | `sessionRaces` 129 行 |
| S-3  | A の確認（probe(1)）を待つ間に B が確定 → probe(1) が `none` を返す                                                     | B は終わらない。probe(1) は破棄                                                                                         | I-3      | `sessionRaces` 146 行 |
| S-4  | SSE の 401 の signal → probe(1) 待ち → B が確定 → probe(1) が `none`                                                    | B は終わらない。`onSessionEnded` は呼ばれない。B の資格情報で probe(2)                                                  | I-3・I-9 | `sessionRaces` 160 行 |
| S-5  | A が active → signal → probe(1) が `none`（遷移なし）                                                                   | `end` 相当の `commit(none)`、generation + 1、保存状態の全消去、listener 通知                                            | I-6      | `sessionRaces` 179 行 |
| S-6  | probe(1)（A の確認）と B のログイン後の `resolve()`（probe(2)）が在中 → probe(1) `none` ‖ probe(2) `B`                  | 最終 owner は B。どちらが先に適用されても、I-3 の照合が同じ継続で行われるので順序に依らない                             | I-1・I-3 | `sessionRaces` 197 行 |
| S-7  | S-6 の signal 版                                                                                                        | 同上。通知は出ない                                                                                                      | I-3      | `sessionRaces` 215 行 |
| S-8  | A が active → `resolve()` で provider が reject（500 / 到達不能）→ 再試行で A                                           | 1 回目は `unverified`、owner・generation・保存状態は不変。2 回目は `confirmed`（同じ generation）。保存状態は復元される | I-4      | `sessionRaces` 242 行 |
| S-9  | provider の `resolve()`: HTTP で `200 null` または `401`                                                                | `{ status: 'none' }`（reject ではない）。トークンを送っていたなら、そのトークンを compare-and-set で消す                | §2.1     | `sessionRaces` 284 行 |
| S-10 | A が active → id の無い identity で確定                                                                                 | owner は `null`（`unknown` ではなく active・owner なし）。A の保存状態は消さない。次に A が確定すれば読める             | I-6      | `sessionRaces` 289 行 |
| S-11 | `sessionGate`・`sessionEnded`・`sessionEndIntegration`・`sessionEndUnheard` の各テスト                                  | 期待は変えない。呼び口だけ controller に置き換える（§6.1）                                                              | —        | 各ファイル            |

### 4.2 同じターンで解決する組み合わせ

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                        | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-12 | 旧い確認 probe(1)（`end()` の前に開始）‖ 新しい確立 probe(2)（`end()` の後に開始）が同時に解決 | probe(1) は遷移回数が変わっているので破棄。probe(2) の答えで確定。最終状態は probe(2) の答えだけで決まる                                                                                                    | I-3      |
| S-13 | 1 本の probe の答えを 2 つの `resolve()` 要求（navigation ×2）が待つ ‖ 答えが返る              | 両方 `confirmed`（同じ snapshot）。provider への問い合わせは 1 本（single-flight）                                                                                                                          | I-9      |
| S-14 | 2 つの要求が同じ probe を待つ → `end()` → probe が返る                                         | 両方 `superseded`。probe は破棄。**待機要求が残っていれば**（`resolveSettled` が合流し直す）、または未処理の signal・資格情報の変化があれば出し直す。どちらも無ければ出し直さない（次の navigation が出す） | I-3・I-9 |
| S-15 | `adopt(C)` ‖ 在中の probe が `none` を返す                                                     | C が active のまま。probe の答えは破棄（遷移回数が変わった）                                                                                                                                                | I-13     |

### 4.3 Tauri の Rust 側まで含めた両方向

| 番号 | 順序                                                                                                                      | 期待（Rust）                                                                                                                              | 期待（controller）                                                                                             | 不変条件  |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| S-16 | `auth_login(B)` 開始（`verify` 待ち）→ `auth_logout` 完了 → `auth_login` 再開                                             | `state.auth` は `None` のまま。`LoginResult { success: false, superseded: true }`（案）。監査は今のまま `login`（検証成功。§1.7、決定 7） | ログインの戻り値を `commit` しない（I-10）。`resolve()` → `none` → ログイン画面のまま                          | I-7・I-11 |
| S-17 | `auth_logout` 開始（`auth_config` 待ち）→ `auth_login(B)` 完了・`resolve()` で B 確定 → `auth_logout` 再開                | `state.auth` は `Some(B)` のまま。logout は何もせず `Ok`（監査に B の `logout` を**残さない**）                                           | B は active のまま。generation 不変                                                                            | I-7・I-11 |
| S-18 | `auth_setup` で S-16 と同じ順序                                                                                           | アカウントは作られる（DB）。セッションは入れない。戻り値は `superseded`                                                                   | 同 S-16                                                                                                        | I-11      |
| S-19 | `auth_setup` で S-17 と同じ順序（setup 中に別のログイン完了。初期化前なので実際には起きにくい。推測）                     | S-17 と同じ形で守る                                                                                                                       | 同 S-17                                                                                                        | I-11      |
| S-20 | HTTP: ガードが `none` を確定 → 公開閲覧の発行 `enterPublicViewer()` 待ち → ヘッダーからログイン B 完了 → 発行の応答が届く | （REST 側は map への追加。B のトークンは消えない）                                                                                        | provider の `setToken` は revision 不一致で**書かない**（#259）。`resolve()` → B。公開閲覧トークンは使われない | I-7       |
| S-21 | HTTP: ログアウト開始（`POST /logout` 待ち）→ ログイン B 完了（トークン書き込み）→ ログアウトの `setToken(null)`           | （サーバ側は旧トークンだけ失効）                                                                                                          | `setToken(null)` は revision 不一致で**消さない**。B は active のまま                                          | I-7       |
| S-22 | Tauri の自動ログイン（`run()` 起動時）とコマンドの競合                                                                    | 起動時に決まり、コマンド受付前。競合しない（事実 §1.3）                                                                                   | —                                                                                                              | —         |

S-16〜S-19 は Rust のテストで、S-20〜S-21 は provider のテストで、それぞれ**フロントの順序に
依らず**成り立つことを確かめる（§8.3）。

### 4.4 資格情報が切り替わった後に確認が失敗した場合

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                     | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-23 | A が active → 資格情報が B に切り替わる（`onCredentialChanged`）→ `resolve()` が reject（500） | 切り替えを知った時点で `unknown`・`owner: null`・generation + 1（保留）。要求は `unverified`。**A の active には戻らない**。A の画面は世代ゲートで消え、A の保存中の処理は書けない。再試行の状態に留める | I-5      |
| S-24 | S-23 の後、再試行で B が確定                                                                   | `confirmed`・active(B)・generation はさらに +1（unknown → active）。A の保存状態は purge                                                                                                                 | I-2・I-5 |
| S-25 | S-23 の後、再試行で `none`（B のトークンがすでに失効していた）                                 | `confirmed`・`none`。`end` 相当（保存状態の全消去）                                                                                                                                                      | I-6      |
| S-26 | A が active → **同じ資格情報**で `resolve()` が reject                                         | active(A) のまま、`verification.state: 'failed'`。要求は `unverified`。**S-23 と区別する**（原則 2）                                                                                                     | I-4      |
| S-27 | A が active → 切り替えの検知 → 確定前に A の画面から保存の書き込み                             | 書き込みは `isCurrent(scope)` が偽なので落ちる（今の `listViewState` の書き込み条件と同じ）                                                                                                              | I-5      |

### 4.5 鮮度と待機の期限

| 番号 | 順序                                                                                                                 | 期待                                                                                                                                                                                                                                | 不変条件 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-28 | probe(1) 開始 → 失効の signal（SSE 401）→ その signal を起点にした `resolve()` 要求 → probe(1) が `active(A)` を返す | probe(1) では要求を満たさない（signal より前に始めた）。probe(1) の答えは破棄し probe(2) を出す。probe(2) の答えで確定                                                                                                              | I-3・I-9 |
| S-29 | probe(1) 開始（navigation）→ signal → probe(1) が `active(A)` を返す（signal 起点の要求は無い）                      | probe(1) は破棄し、**未処理の signal があるので** probe(2) を出す（`createSessionEndConfirmation` の「答えが何であれ確かめ直す」を保つ）                                                                                            | I-3・I-9 |
| S-30 | `resolve()` が期限（既定 10 秒、`sessionEnded.ts` の `CONFIRM_TIMEOUT_MS` を引き継ぐ）を過ぎる                       | `unverified`（`error` は timeout）。確定状態は不変                                                                                                                                                                                  | I-8      |
| S-31 | S-30 の後、遅れて probe が `none` を返す                                                                             | `commit` しない（打ち切った問い合わせは破棄済み）。HTTP provider はトークンを送って `none` を受けたので `clearTokenIfCurrent` でそのトークンだけ消し、`onCredentialChanged` を出す → I-5 の保留 → 次の `resolve()` で `none` を確定 | I-15     |
| S-32 | S-30 の後、遅れて probe が `active(A)` を返す（A は今も同じ資格情報）                                                | `commit` しない。次の `resolve()`（新しい probe）で確定する。遅い答えで「確認済み」に見せない                                                                                                                                       | I-15     |
| S-33 | signal 起点の確認が `unverified` のまま                                                                              | 退避（backoff、`CONFIRM_RETRY_INITIAL_MS`→`CONFIRM_RETRY_MAX_MS`）で問い合わせ直す。`confirmed` になるまで。購読の終了で止める（今の `createSessionEndConfirmation` と同じ）                                                        | I-9      |
| S-34 | 保護レイアウトが購読する前に確定した `none`（unheard）                                                               | 購読時に**確かめ直す**（再生ではない）。その間に新しいログインがあれば通知しない（`sessionEndUnheard.test.ts` を保つ）                                                                                                              | I-3      |

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

| 番号 | 順序                                                                         | 保証すること                                                                                                                                                                                         | 保証しないこと                                                                                                                               |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S-35 | タブ 1 が A（remember）→ タブ 2 が B でログイン（remember）                  | タブ 1 は `storage` イベントで保留に入り A を active として使わない → `resolve()` で B を確定 → **通知**して B の権限で作り直す（既定）。A の未保存の入力は引き継がない。タブ 1 はトークンを消さない | イベントが届くまでの間（ミリ秒〜）に A の画面から送った要求が B のトークンで飛ぶことは止められない（送信時点のトークンを使うため。今もそう） |
| S-36 | S-35 で、`resolve()` が reject（500）                                        | タブ 1 は `unknown` のまま再試行の状態（再試行画面）。A へ戻さない。B のトークンは消さない                                                                                                           | —                                                                                                                                            |
| S-37 | S-35 で、アプリが `ownerChangePolicy: 'relogin'` を注入している              | 通知してログイン画面へ移す。**トークンは消さない**（タブ 2 の B はログインしたまま）。タブ 1 のログイン画面からの扱い（B として続けるか、再認証を求めるか）はそのアプリのログイン画面側の要件        | —                                                                                                                                            |
| S-38 | タブ 1 と タブ 2 が**同時に**別のユーザーでログイン（remember）              | 各タブは**自分のログインの戻り値ではなく**、その後の `resolve()`（保存されているトークン）で確定する。両タブが同じ owner に収束する                                                                  | どちらのトークンが残るか（`localStorage` の最後の書き込みが勝つ。タブ間の compare-and-set は原理的にできない）                               |
| S-39 | タブ 1 がログアウト（`localStorage` を消す）と同時に、タブ 2 が B でログイン | 両タブとも保存されている資格情報に従う（B が残れば両方 B、消えていれば両方ログイン画面）。旧 owner A のまま残るタブは無い                                                                            | タブ 1 が「ログイン画面で終わる」こと                                                                                                        |
| S-40 | 同じタブで、ログイン中に別タブが `localStorage` を書き換える                 | このタブのログインの `setToken` は revision 不一致で書かない（I-7）。`resolve()` で保存されているトークンの owner を確定                                                                             | このタブのログインが「勝つ」こと                                                                                                             |
| S-41 | `sessionStorage`（通常ログイン）のタブ同士                                   | 互いに影響しない（今のまま）                                                                                                                                                                         | —                                                                                                                                            |

原理的な限界: `localStorage` の読み→比較→書きはタブをまたいで原子的にできない（Web Locks API を
使えば近づくが、ADR-0002 の「依存を足さない」の範囲内でも実装が増え、Safari の対応も要確認。
**この設計では採らない**）。したがって保証するのは「**どのタブも、旧 owner を active として
使い続けない**」と「**各タブは自分の意図ではなく保存された資格情報に従う**」と「**切り替えの
処理が他のタブをログアウトさせない**」までで、「同時操作のどちらが勝つか」は保証しない。

### 4.7 公開閲覧への fallback と試運転（`adopt()`）

| 番号 | 順序                                                                                                               | 期待                                                                                                                                                                               | 不変条件   |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S-42 | `resolve()` → `confirmed`・`none` → アプリの方針が `enterPublicViewer()`（revision r0 を渡す）→ 成功 → `resolve()` | active(P)、`kind: 'publicViewer'`、owner `public-viewer`。`end` の後なので generation は +2（none → active）。`adopt()` は使わない（provider が答える）                            | I-10・I-13 |
| S-43 | S-42 の発行待ちの間にログイン B                                                                                    | 発行の `setToken` は書かない（S-20）。`resolve()` → active(B)                                                                                                                      | I-7        |
| S-44 | banto-hub: `fetchCommissioningStatusOrNull()` → 迂回 → `adopt(C, 'commissioning')`                                 | active(C)、`kind: 'commissioning'`、owner `commissioning:commissioning`。provider には問い合わせない。同じ C の再 `adopt` は generation 据え置き                                   | I-13・I-2  |
| S-45 | S-44 の後、SSE の 401 などの signal                                                                                | adopt 中は signal で provider に問い合わせない（`confirmed` のまま）。試運転の終了（lock-down）は**アプリの方針**が `end('commissioning-locked')` を呼んでから `resolve()`         | I-13       |
| S-46 | S-44 の後、`adopt` 中に別タブで A がログイン（`storage` イベント）                                                 | adopt 中の `onCredentialChanged` は**未処理の背景の確認**として記録だけして保留にしない（試運転はトークンで決まらない）。`end()` 後の `resolve()` で A を確定                      | I-13・I-9  |
| S-47 | Tauri のログイン不要モード（auth-disabled）                                                                        | Rust が合成した identity を `auth_resolve` が返す（`auth_identity` と同じく、そのたびにモードと権限を読み直す）。provider の `resolve()` で active。**`adopt()` しない**（決定 4） | I-13       |

### 4.8 `superseded` を受けた `load`

| 番号 | 順序                                                                                                      | 期待                                                                                                                                                                                           | 不変条件  |
| ---- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-48 | `load` の `resolve()` が probe(1) 待ち → 別のログイン B → probe(1) 破棄 → `superseded`                    | `load` は今の generation を返さない。`resolveSettled` が最新の確認（probe(2)）に合流し、B が `confirmed` になったら**B の generation** を返す。旧 owner のページデータは作り直す（世代ゲート） | I-16      |
| S-49 | S-48 で、確認が期限（`resolveSettled` の `deadlineMs`）内に確定しない（遷移が続く、または reject が続く） | `unverified` として再試行画面へ。generation は返さない                                                                                                                                         | I-8・I-16 |
| S-50 | S-48 で、`load` を出した navigation を SvelteKit がすでに破棄している                                     | `resolveSettled` の結果は捨てられる（SvelteKit の挙動）。controller の状態はどの場合も最新の確認だけで決まっているので、破棄されても害は無い                                                   | I-1・I-16 |

## 5. 公開 API の案（型のスケッチ）

名前は仮。**確定するのは契約で、名前は実装の PR で直してよい。**

### 5.1 controller

```ts
export type SessionKind = 'account' | 'publicViewer' | (string & {}); // アプリが adopt で足す（'commissioning' など）

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

export type ResolveResult =
	| { outcome: 'confirmed'; snapshot: SessionSnapshot } // status は none か active
	| { outcome: 'unverified'; error: unknown; snapshot: SessionSnapshot } // 確定状態は変えていない
	| { outcome: 'superseded'; snapshot: SessionSnapshot }; // この確認の結果は採用できない（I-16）

export type SessionSignal = 'unauthorized' | 'credentialCleared' | 'credentialChanged' | 'app';

export interface SessionController {
	/** $state に裏打ちされた読み取り。凍結オブジェクト（I-12） */
	readonly snapshot: SessionSnapshot;
	subscribe(listener: (snapshot: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
	/**
	 * この要求について確定を試みる。reject しない（I-8）。
	 * `cause: 'signal'` は、呼んだ時点より後に始めた問い合わせでしか満たされない（I-9）。
	 * `superseded` は 1 回の要求の結果。合流し直すかは呼び出し元（通常は resolveSettled）。
	 */
	resolve(options?: {
		cause?: 'navigation' | 'signal';
		timeoutMs?: number;
	}): Promise<ResolveResult>;
	/** 失効の可能性の通知。退避付きで確認を回す（今の createSessionEndConfirmation）。同期 */
	signal(kind: SessionSignal): void;
	/** provider が答えられない、派生アプリ固有の合成セッション（試運転）をアプリの方針で確定する。同期 */
	adopt(identity: Identity, kind: SessionKind): SessionScope;
	/** 確定したセッションを終了の状態へ（I-6）。同期。reason は監査・ログ用 */
	end(reason: 'logout' | 'revoked' | 'policy' | (string & {})): void;
	/** 保存状態の API に渡す scope（今の currentSessionScope / isCurrentSessionScope） */
	scope(): SessionScope;
	isCurrent(scope: SessionScope): boolean;
}

/**
 * `load` 向け: `superseded` の間は最新の確認に合流し直し、`confirmed` か `unverified` だけを返す。
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
	/** end() で保存状態を全消去する関数。既定は listViewState.clearAllListViewState */
	onEnd?: () => void;
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
// 遷移のたびに +1。probe の鮮度の照合に使う（I-3）
let epoch = 0;
// 在中の問い合わせ（single-flight、I-9）
let inflight: { startedAt; epochAtStart; revisionAtStart; promise } | null;
// 直近の signal のスタンプ（I-9）と、まだ新しい probe で処理していない背景の確認の必要
let latestSignalAt = 0;
let pendingBackground = false; // signal / onCredentialChanged で true、確定した probe で false
```

`resolve()` の判定は**同じ継続の中**で行う（`await` を挟まない）:

1. 要求のスタンプ `requestedAt`、`epochAtRequest` を取る。adopt 中なら `confirmed` を即返す（I-13）。
2. 在中の probe があり、`cause !== 'signal'` または `probe.startedAt > latestSignalAt` なら合流。なければ新しい probe を出す。
3. probe の答えが返った継続で: `epoch !== probe.epochAtStart` か `provider.credentialRevision?.() !== probe.revisionAtStart` か `latestSignalAt > probe.startedAt` なら**破棄**。破棄したら、**待機要求が残っているか `pendingBackground` なら**出し直す（上限内。超えたら要求に `unverified`）。どちらも無ければ出し直さない（I-9、S-14）。
4. 破棄されなければ `commit()` し `pendingBackground = false`。その後、待っている要求それぞれに `epochAtRequest === epoch` なら `confirmed`、違えば `superseded`。
5. provider が reject したら `verification.failed` だけ更新して `unverified`。ただし revision が変わっていたら（切り替え後の失敗）I-5 の保留を先に `commit` する。

### 5.2 provider 契約（v2 の標準契約）

```ts
export interface AuthProvider {
	// 既存: login / logout / status? / setup? / changePassword? / enterPublicViewer?
	// v2 で削除: check / getIdentity（controller は呼ばない。互換 adapter だけが使う）

	/**
	 * 【必須】1 往復でセッションを答える。取得できないときは reject する（§2.1）。
	 * HTTP: GET /api/auth/identity を 1 回。200 で identity → active、200 null / 401 → none、
	 *       それ以外 → reject。トークンを送って none なら、そのトークンを compare-and-set で消す。
	 * Tauri: auth_resolve（§5.3）。
	 */
	resolve(): Promise<{ status: 'none' } | { status: 'active'; identity: Identity }>;

	/**
	 * 資格情報の revision（不透明な整数）。provider が資格情報を書く・消すたびに +1。
	 * HTTP: メモリ上のカウンタ + storage イベントでも +1。Tauri: auth_resolve が返す seq。
	 * 秘密（トークン本体）は返さない。無い provider では controller は遷移回数と signal だけで
	 * 鮮度を照合する（資格情報の切り替えの検知＝I-5 は効かない）。
	 */
	credentialRevision?(): number;

	/** 別タブや Rust 側の変化を含め、資格情報が変わったら呼ぶ（#257）。戻り値は購読解除 */
	onCredentialChanged?(listener: () => void): () => void;
}
```

`resolve` は**型で必須**にする（決定 2）。`check()`/`getIdentity()` は `AuthProvider` の
契約から外す（admin-core の中で呼ぶ場所が無くなる。互換 adapter の入力の型
`LegacyAuthProvider` にだけ残す）。

書き込みの compare-and-set（#259、I-7）は provider の**内部**で行い、公開の引数は増やさない:

- `login`/`setup`/`enterPublicViewer`: 呼び出しの開始時に `revision` を読み、応答を書くときに
  一致するときだけ `setToken`。一致しなければ書かず、戻り値は `{ success: false, superseded: true }`
  （`error` も付ける）。
- `logout`: 開始時の revision と一致するときだけ `setToken(null)`。一致しなければ消さない
  （別のログインが済んでいる）。`POST /api/auth/logout` は開始時のトークンで送る（今の
  `headers(false)` は送信時の `getToken()` を読むので、**開始時に固定する**）。
- `resolve()` の `none` でのトークン消去は `clearTokenIfCurrent(token)`（今の `check()` と同じ）。

**互換 adapter**（`adaptLegacyAuthProvider(legacy: LegacyAuthProvider): AuthProvider`、別の
export。自前の `AuthProvider` を持つ派生アプリ向け。決定 2）:

| 保証すること                                                                                                                              | 保証しないこと                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve()` の 3 値の形（`check()` が `false` → `none`、`true` → `getIdentity()` を呼び identity → `active`、どちらかの reject → reject） | **1 往復ではない**: `check()` と `getIdentity()` の間に資格情報が変わりうる。`credentialRevision` を旧 provider は持たないので、adapter は検知できない（2 往復の答えが別の資格情報についてのものになりうる） |
| `check()` の `true` と `getIdentity()` の `null` の組み合わせは reject にする（「id の無い active」に潰さない）                           | **`check()` の副作用の安全性**: 旧 `check()` がトークンを消す・別のことをするかは adapter には分からない。compare-and-set も保証しない                                                                       |
| `login`/`logout`/`setup`/`enterPublicViewer` はそのまま通す                                                                               | それらの書き込みが compare-and-set であること（#259 の型の競合は残る）                                                                                                                                       |
| `credentialRevision`/`onCredentialChanged` は**提供しない**（undefined のまま）                                                           | 別タブの切り替えの検知（I-5・I-17 の既定の流れは効かない）                                                                                                                                                   |

adapter は「型を通すための移行の足場」であり、**旧実装を完全対応として扱わない**。
使う派生アプリは、移行の手順（§6.2）に従って自前の provider に `resolve()` を実装するか、
admin-core の provider に乗り換える。

### 5.3 Tauri の Rust 側の API の変更の案

```rust
/// state.auth の置き換え。書き込みのたびに seq を進める。
struct AuthSlot {
    session: Option<DesktopSession>,
    seq: u64,
}
// AppState { auth: Mutex<AuthSlot>, .. }

/// 1 つのロックの中で「期待した seq のときだけ書く」。戻り値は書いたかどうかと今の seq。
fn cas_session(state: &AppState, expected_seq: u64, next: Option<DesktopSession>) -> (bool, u64);

/// フロントの provider.resolve() の相手。current_session() の再検証を通した identity と seq。
/// auth_identity と同じく、ログイン不要モードの合成 identity もそのたびにモードと権限を読み直す。
#[tauri::command]
async fn auth_resolve(state) -> Result<AuthResolveResult, BantoError>;
// AuthResolveResult { identity: Option<Identity>, seq: u64 }

// 既存コマンドの変更: 開始時に seq を読み、書くときに cas_session。
// auth_login  : verify().await の前に seq を読む → 成功なら cas_session(seq, Some(Account)) →
//               書けなければ LoginResult { success: false, superseded: true, error: .. }。
//               監査は今のまま「検証に成功した」時点で "login"（§1.7、決定 7）。
// auth_setup  : 同上（アカウントの作成は行い、セッションだけ入れない）。
// auth_logout : auth_config().await の前に seq を読む → cas_session(seq, None) →
//               書けなければ Ok（何もしない。監査も残さない）。
// auth_config_apply_body / change_own_password / settle_session: すでに照合しているので
//               seq に乗せ替えるだけ。
```

`LoginResult` に `superseded: bool` を足すのは wire の追加（既定 `false`。TS 側は無ければ
`false` と読む）。REST の `/api/auth/login` は変えない（REST 側には 1 スロットが無い、§1.4）。

「Rust が世代の不一致でセッションの確定を拒否した」ことの観測（画面側が応答を捨てただけの場合や
通常の認証失敗とは別のイベント）は**任意・後で**（決定 7）。入れるなら `login` とは別の action に
し、REST 側と `login` の意味を揃える議論（§1.7）を先にする。

フロント側の `createTauriAuthProvider` は `auth_resolve` の `seq` を `credentialRevision()` と
して返し、`login`/`logout`/`setup` の完了後に `auth_resolve` を 1 回呼んで seq を更新し
`onCredentialChanged` を出す（Tauri は別タブが無いので、これが唯一の変化の源）。

### 5.4 既存の公開名の移行（決定 1）

| 今の公開名                                                                                           | v2.0.0 での扱い                                                                                                                        | 理由                                                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `resolveProtectedSession`                                                                            | **削除**（`resolveSettled()` + アプリの方針に分かれる）                                                                                | `enterPublicViewer` の呼び出しを core から外す。意味が変わる    |
| `establishSession`・`beginSession`・`endSession`                                                     | **削除**（`resolve()`・`adopt()`・`end()`）                                                                                            | 呼び出し側に状態更新の組み立てを求める入口。単一の書き手（I-1） |
| `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`・`SessionEndConfirmation` | **削除**（`controller.signal()` に格下げ。`connectEvents` は内部で `signal` を呼ぶ）                                                   | 本文「signal の入口に格下げ」                                   |
| `SessionChangedError`・`MAX_STALE_RETRIES`                                                           | **削除**（`unverified` の `error` に同名のエラーを入れる。上限は deps）                                                                | reject しない契約（I-8）                                        |
| `ProtectedSessionOutcome`                                                                            | **削除**                                                                                                                               | `resolveProtectedSession` と一緒                                |
| `AuthProvider.check` / `getIdentity`                                                                 | **契約から削除**（`LegacyAuthProvider` と互換 adapter にだけ残る）                                                                     | controller が呼ばない（§5.2）                                   |
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
  const result = await resolveSettled(controller, { cause: 'navigation' }); // superseded は中で合流し直す
  if (result.outcome === 'unverified') error(503, ...); // 再試行の画面（今のまま。期限切れも同じ）
  let snapshot = result.snapshot;
  if (snapshot.status === 'none') {
  	snapshot = await publicViewerFallback(controller, authProvider); // アプリの方針（下）
  	if (snapshot.status !== 'active') redirect(307, `${base}/login`);
  }
  if (snapshot.kind === 'publicViewer') { /* 許可リストの redirect（今のまま） */ }
  return { sessionGeneration: snapshot.generation }; // この load で確認できた generation だけ（I-16）
  ```

  `load` の副作用は `controller.resolve()`（と方針の `enterPublicViewer`）だけ。`sessionStore` への
  代入は `load` から消える。`superseded` のまま `sessionGeneration()` を返す今の 105 行の形は
  **無くす**（S-48〜S-50）。

- `publicViewerFallback`（admin-core の**任意の**ヘルパー。controller の外）:
  `status?.()` → `viewerPublic` なら `enterPublicViewer()`（provider 内部の compare-and-set）→
  `resolveSettled()` を返す。失敗なら `none` のまま返す。`adopt()` は使わない。
- `sessionStore`（`$lib/session.svelte.ts`）: `identity`・`role`・`publicViewer` は
  `controller.snapshot` からの `$derived` にする。`authDisabled` は今のまま Tauri だけ別読み。
  派生アプリの `sessionStore` も同じ形（`load()` は無くなる）。
- `Header.svelte`・`commands.ts` のログアウト: `await provider.logout(); controller.end('logout'); goto(login)`。
  `end()` は同期で、`logout()` の完了を待ってから呼ぶ（provider の compare-and-set が書けなかった
  ときは `end()` を呼ばず `resolve()` に任せる。戻り値で判断）。
- `events.ts` `connectEvents`: `onUnauthorized` → `controller.signal('unauthorized')`、
  `onTokenCleared` → `controller.signal('credentialCleared')`。退避は controller の中。
- `+layout.svelte`: `{#if data.sessionGeneration === controller.snapshot.generation}{#key ...}` は
  **そのまま**（I-14）。`onSessionEnded(() => void invalidateAll())` もそのまま。
- **別タブの切り替え（#257）の既定**: `+layout.svelte` が `controller.subscribe` で
  「active(A) → unknown → active(B)（owner が変わった）」を見たら、`notify('info', 別のユーザーで
ログインされました)` を出し、`invalidateAll()`。世代ゲートが画面を作り直す。旧ユーザーの
  未保存の入力は `{#key}` で捨てる。トークンには触れない（I-17）。
  `ownerChangePolicy`（アプリが `initBanto` か layout で注入。`'rebuild'`（既定）| `'relogin'`）:
  `'relogin'` は通知して `goto(login)` する。**トークンは消さない**（他のタブをログアウトさせない）。
- `login/+page.svelte`: `login()` 成功後の `goto(dashboard)` はそのまま（`load` の `resolveSettled()`
  で確定）。`superseded: true` が返ったら「別のセッションが確定しました」を出して `goto(dashboard)`
  （`load` が確定する）。

### 6.2 派生アプリ（banto-industrial）の移行の手順の案

A′ 案のとおり、**候補版で検証したうえで、正式版への参照の更新まで 1 本の移行 PR** で行う。
両アプリとも `github:tyaro/banto#v1.7.3&path:...` → `#v2.0.0`。

| 対象                                                     | 置き換え                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/*/src/lib/session.svelte.ts` の `load()`           | 削除。`identity`/`role` は `getSessionController().snapshot` からの `$derived`                                                                                                                                                                                                                                                                                                                                 |
| `apps/*/src/lib/banto/sessionGuard.ts`                   | `resolveProtectedSession` → `resolveSettled(controller)`。`'unverified'` は `outcome === 'unverified'`、`'login'` は `confirmed && status === 'none'`                                                                                                                                                                                                                                                          |
| `apps/*/src/routes/(app)/+layout.ts`                     | §6.1 の形（公開閲覧の fallback は両アプリとも無い）。返す generation はこの `load` で確認できたものだけ                                                                                                                                                                                                                                                                                                        |
| banto-hub `sessionStore.enterCommissioningMode()`        | `controller.adopt(COMMISSIONING_IDENTITY, 'commissioning')`。lock-down の検知で `controller.end('commissioning-locked')`。`adopt()` を使うのはこれだけ                                                                                                                                                                                                                                                         |
| banto-hub `sessionRecheck.ts`                            | `recheckSessionAfterStreamClose` → `controller.signal('app')` + `invalidateAll()`。`probeSessionAfterReconnectFailures` → `resolveSettled(controller, { cause: 'signal' })` の結果を `SessionProbeResult` に写す（`confirmed/none → 'login'`、`confirmed/active → 'session'`、`unverified → 'unverified'`）。独自の token 照合・single-flight・期限・`/api/auth/check` の直接 `fetch` は削除                   |
| banto-hub `(app)/+layout.svelte`・`monitor/+page.svelte` | 呼び口の変更に追従。#257 の既定の流れ（通知して作り直す）を入れる                                                                                                                                                                                                                                                                                                                                              |
| 各アプリの `Header`/ログアウト                           | `controller.end('logout')` を足す（今は `endSession` 相当を呼んでいない）                                                                                                                                                                                                                                                                                                                                      |
| **自前の `AuthProvider` を持つ場合**                     | v2 の `AuthProvider` は `resolve` が必須なので**型エラーになる**。対応は 2 つ: (a) `resolve()` を実装する（推奨。HTTP なら `GET /api/auth/identity` 1 回、§2.1）、(b) 一時的に `adaptLegacyAuthProvider(...)` で包む（保証しない範囲を §5.2 の表で確認し、移行 PR の本文に「adapter 使用中」と明記する）。banto-industrial の 2 アプリは admin-core の provider を使っているので該当しない見込み（§1.6、推測） |
| `#216` の `lan_urls` 3 か所・`#248` の監査ログ           | 同じ移行 PR に含める（Issue #260「進め方」3）。セッションとは独立                                                                                                                                                                                                                                                                                                                                              |

試運転の `adopt` については、banto-hub の `commissioning.ts` の `shouldBypassLoginForCommissioning`
の判断そのものは変えない（アプリの方針のまま）。

## 7. 実装の分割と、候補版での検証

### 7.1 実装の PR

| PR     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 受け入れ条件                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 実装-1 | **provider とバックエンド**: `AuthProvider.resolve`（この PR では任意で追加、実装-3 で必須化）/`credentialRevision?`/`onCredentialChanged?`、HTTP provider の `resolve()`（`GET /api/auth/identity` 1 回、`none` で compare-and-set 消去）と書き込みの compare-and-set（#259）と `storage` 監視、`adaptLegacyAuthProvider`、Rust に `AuthSlot`（seq）・`auth_resolve`・`auth_login`/`auth_setup`/`auth_logout` の compare-and-set。**REST のルートは足さない** | S-9・S-16〜S-21・S-40 のテスト（Rust は `cargo test`、TS は vitest）、adapter の保証する範囲のテスト。既存テスト全緑。controller はまだ無く、公開 API は追加だけ。**タグは打たない** |
| 実装-2 | **controller**: `sessionController.svelte.ts`（`commit`・`resolve`・`signal`・`adopt`・`end`・deps 注入）、`resolveSettled`、テストのハーネス（§8.1）、S-1〜S-15・S-23〜S-34・S-42〜S-50 のテスト。既存の `establishSession` 等は**この PR では controller への委譲に書き換えて残す**（admin-template を壊さないため）                                                                                                                                         | 全シナリオが S 番号付きで通る。既存の `sessionRaces`/`sessionGate`/`sessionEnded*` テストが呼び口の変更だけで通る                                                                    |
| 実装-3 | **admin-template の配線と v2.0.0**: §6.1、`connectEvents` の `signal` 化、公開閲覧 fallback のヘルパー、#257 の既定の流れと `ownerChangePolicy`、§5.4 の削除と `resolve` の必須化、S-35〜S-39 のテスト（`storage` イベントのモック）、E2E（`session-check-outage`・`public-viewer` を保つ）、CHANGELOG の「挙動の互換性が変わる変更」と移行表（自前 provider の型エラーの対応を含む）                                                                          | `pnpm check`/`test`/`e2e`/`e2e:public-viewer` 全緑。Tauri check 緑。CHANGELOG に §5.4 の表と §6.2 の自前 provider の項                                                               |
| 移行   | **banto-industrial**（候補版の検証後）: §6.2 と参照の `v2.0.0` 化を 1 本で                                                                                                                                                                                                                                                                                                                                                                                     | 両アプリの `check`/`test`/E2E、実機 smoke（banto-hub のローカル smoke 手順）、試運転の入退場、ストリーム切断後の再確認、別タブでの切り替えの通知                                     |

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
- 「同じターン」（S-6・S-7・S-12〜S-15）は、複数の `deferred` を**同じ同期ブロックで**解決してから
  `await` する。既存テストと同じ書き方。
- `resolveSettled`（S-48〜S-50）は、`superseded` の後に合流し直すこと、返す generation が
  合流先の確認のものであること、`deadlineMs` で `unverified` になることを `scheduler` を進めて確かめる。
- 出し直しの条件（I-9、S-14・S-29・S-46）は、「待機要求なし・`pendingBackground` なし」で
  probe が増えないこと、どちらかがあれば増えることを、`probes.length` で確かめる。
- テスト名は `S-n: ...` で始め、`describe` に `I-n` を書く。表と食い違ったら表を直す
  （表が正）。

### 8.2 provider のテスト

- HTTP `resolve()`: `fetchFn` のモックで `200 identity` / `200 null` / `401` / `500` / 通信例外の
  5 通り。`200 null` と `401` でトークンを送っていたときだけ `clearTokenIfCurrent` が効くこと、
  応答待ちの間に別のトークンに変わっていたら消さないこと。
- HTTP の書き込み: 応答の解決の前に別の `setToken`（別のログイン）や `storage` イベントを入れ、
  書き込みが起きないこと（S-20・S-21・S-40）を `storage` の中身で確かめる。
- 互換 adapter: `check() true` + `getIdentity() null` が reject になること、`credentialRevision` が
  `undefined` であること（保証しない範囲を「テストで固定」する）。
- Tauri provider: `invoke` のモックで `auth_resolve` の `seq` が `credentialRevision()` に
  反映されることと、`onCredentialChanged` が `login`/`logout` の完了後に 1 回呼ばれること。

### 8.3 Rust 側の競合のテスト（`apps/admin-template/src-tauri/src/lib.rs` の `#[cfg(test)]`）

`UsersService` は具象型（`crates/banto-admin-services/src/users.rs`）で、`verify()` の完了を
テストから止められない。そこで**コマンドの本体を 2 段に分け**、順序を関数の呼び順で決める:

```rust
// auth_login の本体を、検証（await あり）と設置（同期、CAS）に分ける
async fn verify_for_login(state, username, password) -> Result<Option<UserIdentity>, BantoError>;
fn install_session_if_unchanged(state, expected_seq: u64, next: Option<DesktopSession>) -> bool;
```

- S-16: `let seq = current_seq(&state)` → `logout_body(&state).await`（`None` にする）→
  `install_session_if_unchanged(&state, seq, Some(B))` が `false`、`state.auth` は `None`。
- S-17: `let seq = current_seq(&state)` → `install_session_if_unchanged(&state, seq, Some(B))`
  （別のログインが先に完了）→ `clear_session_if_unchanged(&state, seq)` が `false`、B が残る。
- S-18/S-19: `auth_setup` の設置も同じ関数を使うので、同じテストで覆う（`setup_first_user` は
  実 DB で 1 回だけ）。
- 監査: 書けなかった logout が**記録されない**ことを `audit` の内容で確かめる
  （今の `auth_config_apply_is_recorded_as_settings_change` と同じ手法）。login の監査は
  今のまま検証成功の時点なので、S-16 でも `login` が 1 件残る（§1.7）。
- `auth_resolve`: ログイン不要モードで、`auth_config` を書き換えた後に呼ぶと新しい権限を返すこと
  （S-47）。
- 統合の確認として、`tokio::join!` で `auth_login` と `auth_logout` の本体を同時に走らせ、
  終わったあとの `state.auth` が「`None`」か「`Some(B)` かつ login の戻りが `success`」の
  **どちらか**であること（復活・消失のどちらも起きない）を複数回回す。順序は決められないので
  性質のテストとして置く。

### 8.4 E2E

- 既存の `e2e/tests/session-check-outage.ts`（500 の再試行）と `e2e/tests-public-viewer/` は保つ。
- 追加: 「別タブで B がログイン → 元タブが通知を出して B の権限で作り直され、A の未保存入力が
  残らない。B のタブはログインしたまま」（S-35、I-17）を Playwright の 2 ページ（同じ
  context）で。`storage` イベントは同じ origin の 2 ページで実際に飛ぶ。
- 追加: 「identity の 500 の後、別タブでログイン → 元タブが旧ユーザーの画面を出さず再試行の状態」
  （S-36）。

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
