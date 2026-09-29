# SessionController 設計（Issue #260）

- 状態: 設計案（実装前。オーナーの判断待ち）
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
  `login`・`setup`・`enterPublicViewer` の `setToken(...)`（256・355・404 行）と `logout` の
  `setToken(null)`（267 行）は**無条件**。#259 はこの `enterPublicViewer` の無条件書き込みを
  指している。
- Tauri: `check()`/`getIdentity()` は `auth_check`/`auth_identity` を別々に呼ぶ
  （`providers/tauri.ts` 127-134 行）。答えは呼んだ時点の Rust 側 `state.auth` について。
- 「check は成功、identity だけ 500」は、この 2 往復から生まれる（`sessionRaces.test.ts`
  242-283 行が再現している）。

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

### 1.4 REST 側（`crates/banto-server/src/auth.rs`）には共有の 1 スロットが無い

`AuthState` はトークンごとの map（`tokens: RwLock<HashMap<String, TokenRecord>>`、495 行）。
`login`/`issue_*` は新しいトークンを**追加**し（858-890 行）、`logout(token)` は**そのトークン
だけ**を消す（904 行）。遅い応答で別のセッションを消す形は REST のサーバ側には無い。
REST 経路で「1 スロット」に当たるのは**ブラウザ側のトークンの保存先**（`setToken`、§1.2）で、
その compare-and-set が #259。

### 1.5 SvelteKit の `load` から状態を書いている

`apps/admin-template/src/routes/(app)/+layout.ts` は `resolveProtectedSession`（`endSession` を
呼びうる）と `sessionStore.load()`（`establishSession` → `beginSession` → `apply`）を `load` の
中で呼ぶ。SvelteKit は追い越された navigation の**結果**は捨てるが、`load` の中で走った
**副作用**は取り消せない（#255 の 5〜6 回目の指摘の 3 件はすべてこの形）。

### 1.6 派生アプリ（banto-industrial、`@banto/admin-core` は `v1.7.3` に固定）

| アプリ      | ファイル                          | 今の形                                                                                                                                                         |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| banto-hub   | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を**直接**呼ぶ（`establishSession` を使っていない＝所有者・世代の照合なし）。`enterCommissioningMode()` で合成 identity を直接代入 |
| banto-hub   | `src/lib/banto/sessionGuard.ts`   | `resolveProtectedSession` を包み `'session' / 'login' / 'unverified'` に写す                                                                                   |
| banto-hub   | `src/lib/banto/sessionRecheck.ts` | ストリーム切断後の再確認を**独自に**実装（開始時の token を覚えて終了時に照合、single-flight、10 秒の期限）＝ core と同じ照合の作り直し                        |
| banto-hub   | `src/routes/(app)/+layout.ts`     | `fetchCommissioningStatusOrNull()` → 迂回なら `enterCommissioningMode()`、そうでなければガード → `sessionStore.load()`                                         |
| chronogazer | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を直接呼ぶ                                                                                                                         |

派生アプリは `beginSession`/`endSession`/`sessionGeneration` を使っていないので、
一覧状態の所有者照合（#255）の恩恵も、世代ゲートも、まだ効いていない（v1.7.3 固定のため当然）。

## 2. 責務と原則（#260 本文の確定形）

責務の表は Issue 本文のとおり。ここでは、オーナーのコメント（2026-09-29）で明確化を求められた
2 点を確定する。

### 2.1 2 種類の `resolve()`

| 層         | 名前                          | 失敗の表し方                                                                                                                      | 答えの種類                                                        |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| provider   | `AuthProvider.resolve()`      | **reject する**（`ProviderError`）。取得できない＝サーバが確認できない（500）・到達不能・応答の形が違う                           | `{ status: 'none' }` / `{ status: 'active', identity }`（1 往復） |
| controller | `SessionController.resolve()` | **reject しない**。呼び出し元は戻り値の `outcome` で**今回の要求について**判断する。共有スナップショットの `lastError` は補助情報 | `confirmed` / `unverified` / `superseded`（§5.1）                 |

controller の `resolve()` は「この要求は、確認できた（none か active のどちらかが確定した）／
確認できなかった（確定状態は変えていない。再試行できる）／新しい要求か遷移に追い越された
（この要求の結果で画面を決めてはいけない）」を返す。呼び出し元が `snapshot.lastError` を
見て推理することはしない。

### 2.2 原則 7 の範囲

> フロントの確定したセッションの状態（owner・generation・identity）を終了の状態に移すのは
> controller だけ。資格情報の破棄とバックエンドの失効の処理は、provider とバックエンドが担う。

具体的には:

- controller が担う: `status`・`owner`・`generation`・`identity`・`kind` の遷移、保存状態の
  全消去の指示（`end()`）、listener への通知。
- provider が担う: トークンの保存・消去（compare-and-set）、`401`/`200 false` を受けたときの
  トークンの消去（今の `clearTokenIfCurrent`）、別タブの変化の検知。
- バックエンドが担う: セッションの失効の判定（ADR-0014）、Rust 側 `state.auth` の
  compare-and-set（§5.3）。
- provider が資格情報を消しても、controller の確定状態はそれだけでは変わらない。
  provider は `onCredentialChanged` で controller に**知らせ**、controller が §3 の
  I-5 に従って遷移する。

## 3. 不変条件（テストから参照する番号）

| 番号 | 不変条件                                                                                                                                                                                                                                                   | 由来                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| I-1  | **単一の書き手**: 確定状態（`status`・`owner`・`generation`・`identity`・`kind`）を変える関数は controller 内部の `commit()` 1 つ。公開の入口は `resolve` の適用・`adopt`・`end`・資格情報の変化による保留（I-5）の 4 つだけ                               | 原則 1・7                      |
| I-2  | **世代**: `commit` で `status` か `owner` が変わるとき、`end`、`adopt`、保留（I-5）のとき `generation` は +1。同じ owner の active→active（再確認）は据え置き。単調増加                                                                                    | `transitionSessionScope`       |
| I-3  | **鮮度**: provider の答えは、その問い合わせを始めた時点の（controller の遷移回数, 資格情報の revision）が適用時点と同じで、かつ始めた後に signal が来ていないときだけ `commit` できる。違えば破棄して問い合わせ直す（上限あり）                            | 原則 1・`sessionEnded.ts`      |
| I-4  | **取得不能は状態を変えない**: 同じ資格情報で確認に失敗しても、確定状態と保存状態は変えない。変わるのは `verification` だけ                                                                                                                                 | 原則 2・#204                   |
| I-5  | **資格情報の切り替えで旧 owner は active でなくなる**: 切り替えを知った時点で `status: 'unknown'`・`owner: null`・`generation + 1` にする（保留）。その後の確認に失敗しても旧 owner の active には戻さない。保存状態は消さない（owner 照合で読めないだけ） | 原則 6                         |
| I-6  | **`end()` だけが保存状態を全消去する**: `end()` は `status: 'none'`・`generation + 1`・`clearAllListViewState()`。他の遷移は全消去しない（新しい owner の確定で他人の分を purge するのは今のまま）                                                         | `endSession`                   |
| I-7  | **資格情報の書き込み・消去は compare-and-set**: provider（トークン）も Rust 側（`state.auth`）も、操作を始めたときの revision / seq と一致するときだけ書く。controller は資格情報を書かない                                                                | 原則 4・#259                   |
| I-8  | **controller の `resolve()` は reject しない**: 3 つの `outcome` のどれかを必ず返す。待機の期限がある                                                                                                                                                      | オーナーのコメント 1           |
| I-9  | **single-flight と鮮度の下限**: 同時の `resolve()` で provider への問い合わせは最大 1 本。signal を起点とする確認は、その signal より後に始めた問い合わせでしか満たされない                                                                                | 本文「single-flight と鮮度」   |
| I-10 | **認証の操作は待ち行列に入れない**: `login`/`logout`/`setup`/`enterPublicViewer` は provider を直接呼ぶ。操作の戻り値を直接 `commit` せず、その後の `resolve()` で確定する                                                                                 | 本文「一律に順番待ちさせない」 |
| I-11 | **Rust 側の `state.auth` は seq 付き**: 書き込みは、コマンドが開始時に読んだ `seq` と一致するときだけ（一致しなければ書かず、追い越されたことを返す）                                                                                                      | §1.3                           |
| I-12 | **スナップショットは丸ごと**: `SessionSnapshot` は凍結したオブジェクトで、使う側は `owner`・`generation`・`identity`・`kind` を別々のストアから読まない                                                                                                    | 原則 5                         |
| I-13 | **adopt したセッションは provider の答えで終わらない**: アプリが `adopt()` したセッション（試運転など）は `end()` か別の `adopt()` でだけ終わる。`resolve()` は provider に問い合わせず `confirmed` を返す                                                 | 本文「ポリシーとして注入」     |
| I-14 | **controller は SvelteKit を知らない**: `load` は `controller.resolve()` を await して結果を返すだけ。`{#key generation}` はアプリ層                                                                                                                       | 本文                           |
| I-15 | **待機を打ち切った後の遅い答えは無効**: 期限で `unverified` を返した問い合わせの答えが後で届いても `commit` しない。provider 側の副作用（`401` でのトークン消去）は provider の compare-and-set の範囲で起こり、`onCredentialChanged` 経由で I-5 に入る    | オーナーのコメント             |

## 4. 競合のシナリオ

記法: `A`/`B` はアカウント、`P` は公開閲覧、`C` は試運転。`probe(n)` は provider の
`resolve()` の n 本目、`→` は時間の順、`‖` は**同じターン（同じマイクロタスクの並び）で
解決する**ことを表す。「期待」は controller の最終スナップショットと、要求ごとの `outcome`。

### 4.1 #255 の既存シナリオ（そのまま保つ。`sessionRaces.test.ts` ほか）

| 番号 | 順序                                                                                                                    | 期待                                                                                                                    | 不変条件 | 元のテスト            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| S-1  | A の `resolve()` が probe(1) を待つ → `end()`（ログアウト）→ B の `resolve()` が probe(2) で確定 → probe(1) が A を返す | A の要求は `superseded`。B の owner・generation・保存状態は変わらない                                                   | I-1・I-3 | `sessionRaces` 117 行 |
| S-2  | A の `resolve()` が probe(1) を待つ → `end()` → probe(1) が A を返す（新しい要求は無い）                                | probe(1) は破棄、probe(2) を出し直す。probe(2) の答えで確定                                                             | I-3      | `sessionRaces` 129 行 |
| S-3  | A の確認（probe(1)）を待つ間に B が確定 → probe(1) が `none` を返す                                                     | B は終わらない。probe(1) は破棄                                                                                         | I-3      | `sessionRaces` 146 行 |
| S-4  | SSE の 401 の signal → probe(1) 待ち → B が確定 → probe(1) が `none`                                                    | B は終わらない。`onSessionEnded` は呼ばれない。B の資格情報で probe(2)                                                  | I-3・I-9 | `sessionRaces` 160 行 |
| S-5  | A が active → signal → probe(1) が `none`（遷移なし）                                                                   | `end` 相当の `commit(none)`、generation + 1、保存状態の全消去、listener 通知                                            | I-6      | `sessionRaces` 179 行 |
| S-6  | probe(1)（A の確認）と B のログイン後の `resolve()`（probe(2)）が在中 → probe(1) `none` ‖ probe(2) `B`                  | 最終 owner は B。どちらが先に適用されても、I-3 の照合が同じ継続で行われるので順序に依らない                             | I-1・I-3 | `sessionRaces` 197 行 |
| S-7  | S-6 の signal 版                                                                                                        | 同上。通知は出ない                                                                                                      | I-3      | `sessionRaces` 215 行 |
| S-8  | A が active → `resolve()` で provider が reject（500 / 到達不能）→ 再試行で A                                           | 1 回目は `unverified`、owner・generation・保存状態は不変。2 回目は `confirmed`（同じ generation）。保存状態は復元される | I-4      | `sessionRaces` 242 行 |
| S-9  | provider の `resolve()`: HTTP で `401`                                                                                  | `{ status: 'none' }`（reject ではない）                                                                                 | §2.1     | `sessionRaces` 284 行 |
| S-10 | A が active → id の無い identity で確定                                                                                 | owner は `null`（`unknown` ではなく active・owner なし）。A の保存状態は消さない。次に A が確定すれば読める             | I-6      | `sessionRaces` 289 行 |
| S-11 | `sessionGate`・`sessionEnded`・`sessionEndIntegration`・`sessionEndUnheard` の各テスト                                  | 期待は変えない。呼び口だけ controller に置き換える（§6.1）                                                              | —        | 各ファイル            |

### 4.2 同じターンで解決する組み合わせ

| 番号 | 順序                                                                                           | 期待                                                                                                     | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| S-12 | 旧い確認 probe(1)（`end()` の前に開始）‖ 新しい確立 probe(2)（`end()` の後に開始）が同時に解決 | probe(1) は遷移回数が変わっているので破棄。probe(2) の答えで確定。最終状態は probe(2) の答えだけで決まる | I-3      |
| S-13 | 1 本の probe の答えを 2 つの `resolve()` 要求（navigation ×2）が待つ ‖ 答えが返る              | 両方 `confirmed`（同じ snapshot）。provider への問い合わせは 1 本（single-flight）                       | I-9      |
| S-14 | 2 つの要求が同じ probe を待つ → `end()` → probe が返る                                         | 両方 `superseded`。probe は破棄、出し直す（新しい要求が無ければ出し直さない。判断点 §9）                 | I-3      |
| S-15 | `adopt(C)` ‖ 在中の probe が `none` を返す                                                     | C が active のまま。probe の答えは破棄（遷移回数が変わった）                                             | I-13     |

### 4.3 Tauri の Rust 側まで含めた両方向

| 番号 | 順序                                                                                                                      | 期待（Rust）                                                                                                       | 期待（controller）                                                                                             | 不変条件  |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------- |
| S-16 | `auth_login(B)` 開始（`verify` 待ち）→ `auth_logout` 完了 → `auth_login` 再開                                             | `state.auth` は `None` のまま。`LoginResult { success: false, superseded: true }`（案）。監査は `login_superseded` | ログインの戻り値を `commit` しない（I-10）。`resolve()` → `none` → ログイン画面のまま                          | I-7・I-11 |
| S-17 | `auth_logout` 開始（`auth_config` 待ち）→ `auth_login(B)` 完了・`resolve()` で B 確定 → `auth_logout` 再開                | `state.auth` は `Some(B)` のまま。logout は何もせず `Ok`（監査に B の `logout` を**残さない**）                    | B は active のまま。generation 不変                                                                            | I-7・I-11 |
| S-18 | `auth_setup` で S-16 と同じ順序                                                                                           | アカウントは作られる（DB）。セッションは入れない。戻り値は `superseded`                                            | 同 S-16                                                                                                        | I-11      |
| S-19 | `auth_setup` で S-17 と同じ順序（setup 中に別のログイン完了。初期化前なので実際には起きにくい。推測）                     | S-17 と同じ形で守る                                                                                                | 同 S-17                                                                                                        | I-11      |
| S-20 | HTTP: ガードが `none` を確定 → 公開閲覧の発行 `enterPublicViewer()` 待ち → ヘッダーからログイン B 完了 → 発行の応答が届く | （REST 側は map への追加。B のトークンは消えない）                                                                 | provider の `setToken` は revision 不一致で**書かない**（#259）。`resolve()` → B。公開閲覧トークンは使われない | I-7       |
| S-21 | HTTP: ログアウト開始（`POST /logout` 待ち）→ ログイン B 完了（トークン書き込み）→ ログアウトの `setToken(null)`           | （サーバ側は旧トークンだけ失効）                                                                                   | `setToken(null)` は revision 不一致で**消さない**。B は active のまま                                          | I-7       |
| S-22 | Tauri の自動ログイン（`run()` 起動時）とコマンドの競合                                                                    | 起動時に決まり、コマンド受付前。競合しない（事実 §1.3）                                                            | —                                                                                                              | —         |

S-16〜S-19 は Rust のテストで、S-20〜S-21 は provider のテストで、それぞれ**フロントの順序に
依らず**成り立つことを確かめる（§8.3）。

### 4.4 資格情報が切り替わった後に確認が失敗した場合

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                               | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-23 | A が active → 資格情報が B に切り替わる（`onCredentialChanged`）→ `resolve()` が reject（500） | 切り替えを知った時点で `unknown`・`owner: null`・generation + 1（保留）。要求は `unverified`。**A の active には戻らない**。A の画面は世代ゲートで消え、A の保存中の処理は書けない | I-5      |
| S-24 | S-23 の後、再試行で B が確定                                                                   | `confirmed`・active(B)・generation はさらに +1（unknown → active）。A の保存状態は purge                                                                                           | I-2・I-5 |
| S-25 | S-23 の後、再試行で `none`（B のトークンがすでに失効していた）                                 | `confirmed`・`none`。`end` 相当（保存状態の全消去）                                                                                                                                | I-6      |
| S-26 | A が active → **同じ資格情報**で `resolve()` が reject                                         | active(A) のまま、`verification.state: 'failed'`。要求は `unverified`。**S-23 と区別する**（原則 2）                                                                               | I-4      |
| S-27 | A が active → 切り替えの検知 → 確定前に A の画面から保存の書き込み                             | 書き込みは `isCurrent(scope)` が偽なので落ちる（今の `listViewState` の書き込み条件と同じ）                                                                                        | I-5      |

### 4.5 鮮度と待機の期限

| 番号 | 順序                                                                                                                 | 期待                                                                                                                                                                                                       | 不変条件 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-28 | probe(1) 開始 → 失効の signal（SSE 401）→ その signal を起点にした `resolve()` 要求 → probe(1) が `active(A)` を返す | probe(1) では要求を満たさない（signal より前に始めた）。probe(1) の答えは破棄し probe(2) を出す。probe(2) の答えで確定                                                                                     | I-3・I-9 |
| S-29 | probe(1) 開始（navigation）→ signal → probe(1) が `active(A)` を返す（signal 起点の要求は無い）                      | probe(1) は破棄し、probe(2) を出す（`createSessionEndConfirmation` の「答えが何であれ確かめ直す」を保つ）                                                                                                  | I-3      |
| S-30 | `resolve()` が期限（既定 10 秒、`sessionEnded.ts` の `CONFIRM_TIMEOUT_MS` を引き継ぐ）を過ぎる                       | `unverified`（`error` は timeout）。確定状態は不変                                                                                                                                                         | I-8      |
| S-31 | S-30 の後、遅れて probe が `none` を返す                                                                             | `commit` しない（打ち切った問い合わせは破棄済み）。HTTP provider は `401` なら `clearTokenIfCurrent` でそのトークンだけ消し、`onCredentialChanged` を出す → I-5 の保留 → 次の `resolve()` で `none` を確定 | I-15     |
| S-32 | S-30 の後、遅れて probe が `active(A)` を返す（A は今も同じ資格情報）                                                | `commit` しない。次の `resolve()`（新しい probe）で確定する。遅い答えで「確認済み」に見せない                                                                                                              | I-15     |
| S-33 | signal 起点の確認が `unverified` のまま                                                                              | 退避（backoff、`CONFIRM_RETRY_INITIAL_MS`→`CONFIRM_RETRY_MAX_MS`）で問い合わせ直す。`confirmed` になるまで。購読の終了で止める（今の `createSessionEndConfirmation` と同じ）                               | I-9      |
| S-34 | 保護レイアウトが購読する前に確定した `none`（unheard）                                                               | 購読時に**確かめ直す**（再生ではない）。その間に新しいログインがあれば通知しない（`sessionEndUnheard.test.ts` を保つ）                                                                                     | I-3      |

### 4.6 別のタブ（#257）と、複数タブでの同時のログイン・ログアウト

前提: 「Remember me」のトークンは `localStorage`（タブ間で共有）、通常のトークンは
`sessionStorage`（タブごと）。タブ間の検知は provider の adapter が `storage` イベントで行い、
`onCredentialChanged` を controller に渡す。

| 番号 | 順序                                                                         | 保証すること                                                                                                                                                                                           | 保証しないこと                                                                                                                               |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S-35 | タブ 1 が A（remember）→ タブ 2 が B でログイン（remember）                  | タブ 1 は `storage` イベントで I-5 の保留に入り、A を active として使わない。次の `resolve()` で B を確定（アプリの方針で「別ユーザーでログインされました」の表示に替えてもよい。#257 のオーナー判断） | イベントが届くまでの間（ミリ秒〜）に A の画面から送った要求が B のトークンで飛ぶことは止められない（送信時点のトークンを使うため。今もそう） |
| S-36 | タブ 1 と タブ 2 が**同時に**別のユーザーでログイン（remember）              | 各タブは**自分のログインの戻り値ではなく**、その後の `resolve()`（保存されているトークン）で確定する。両タブが同じ owner に収束する                                                                    | どちらのトークンが残るか（`localStorage` の最後の書き込みが勝つ。タブ間の compare-and-set は原理的にできない）                               |
| S-37 | タブ 1 がログアウト（`localStorage` を消す）と同時に、タブ 2 が B でログイン | 両タブとも保存されている資格情報に従う（B が残れば両方 B、消えていれば両方ログイン画面）。旧 owner A のまま残るタブは無い                                                                              | タブ 1 が「ログイン画面で終わる」こと                                                                                                        |
| S-38 | 同じタブで、ログイン中に別タブが `localStorage` を書き換える                 | このタブのログインの `setToken` は revision 不一致で書かない（I-7）。`resolve()` で保存されているトークンの owner を確定                                                                               | このタブのログインが「勝つ」こと                                                                                                             |
| S-39 | `sessionStorage`（通常ログイン）のタブ同士                                   | 互いに影響しない（今のまま）                                                                                                                                                                           | —                                                                                                                                            |

原理的な限界: `localStorage` の読み→比較→書きはタブをまたいで原子的にできない（Web Locks API を
使えば近づくが、ADR-0002 の「依存を足さない」の範囲内でも実装が増え、Safari の対応も要確認。
**この設計では採らない**）。したがって保証するのは「**どのタブも、旧 owner を active として
使い続けない**」と「**各タブは自分の意図ではなく保存された資格情報に従う**」までで、
「同時操作のどちらが勝つか」は保証しない。

### 4.7 公開閲覧への fallback と試運転（`adopt()`）

| 番号 | 順序                                                                                                               | 期待                                                                                                                                                                       | 不変条件  |
| ---- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-40 | `resolve()` → `confirmed`・`none` → アプリの方針が `enterPublicViewer()`（revision r0 を渡す）→ 成功 → `resolve()` | active(P)、`kind: 'publicViewer'`、owner `public-viewer`。`end` の後なので generation は +2（none → active）                                                               | I-10      |
| S-41 | S-40 の発行待ちの間にログイン B                                                                                    | 発行の `setToken` は書かない（S-20）。`resolve()` → active(B)                                                                                                              | I-7       |
| S-42 | banto-hub: `fetchCommissioningStatusOrNull()` → 迂回 → `adopt(C, 'commissioning')`                                 | active(C)、`kind: 'commissioning'`、owner `commissioning:commissioning`。provider には問い合わせない。同じ C の再 `adopt` は generation 据え置き                           | I-13・I-2 |
| S-43 | S-42 の後、SSE の 401 などの signal                                                                                | adopt 中は signal で provider に問い合わせない（`confirmed` のまま）。試運転の終了（lock-down）は**アプリの方針**が `end('commissioning-locked')` を呼んでから `resolve()` | I-13      |
| S-44 | S-42 の後、`adopt` 中に別タブで A がログイン（`storage` イベント）                                                 | adopt 中の `onCredentialChanged` は**記録だけ**して保留にしない（試運転はトークンで決まらない）。`end()` 後の `resolve()` で A を確定                                      | I-13      |
| S-45 | Tauri のログイン不要モード（auth-disabled）                                                                        | Rust が合成した identity を `auth_resolve` が返すので、provider の `resolve()` で active になる。`adopt()` は不要（判断点 §9）                                             | —         |

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
	| { outcome: 'superseded'; snapshot: SessionSnapshot }; // 新しい要求か遷移に追い越された

export type SessionSignal = 'unauthorized' | 'credentialCleared' | 'credentialChanged' | 'app';

export interface SessionController {
	/** $state に裏打ちされた読み取り。凍結オブジェクト（I-12） */
	readonly snapshot: SessionSnapshot;
	subscribe(listener: (snapshot: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
	/**
	 * この要求について確定を試みる。reject しない（I-8）。
	 * `cause: 'signal'` は、呼んだ時点より後に始めた問い合わせでしか満たされない（I-9）。
	 */
	resolve(options?: {
		cause?: 'navigation' | 'signal';
		timeoutMs?: number;
	}): Promise<ResolveResult>;
	/** 失効の可能性の通知。退避付きで確認を回す（今の createSessionEndConfirmation）。同期 */
	signal(kind: SessionSignal): void;
	/** provider が答えられない合成セッションをアプリの方針で確定する（試運転）。同期 */
	adopt(identity: Identity, kind: SessionKind): SessionScope;
	/** 確定したセッションを終了の状態へ（I-6）。同期。reason は監査・ログ用 */
	end(reason: 'logout' | 'revoked' | 'policy' | (string & {})): void;
	/** 保存状態の API に渡す scope（今の currentSessionScope / isCurrentSessionScope） */
	scope(): SessionScope;
	isCurrent(scope: SessionScope): boolean;
}

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
// 直近の signal のスタンプ（I-9）
let latestSignalAt = 0;
```

`resolve()` の判定は**同じ継続の中**で行う（`await` を挟まない）:

1. 要求のスタンプ `requestedAt`、`epochAtRequest` を取る。adopt 中なら `confirmed` を即返す（I-13）。
2. 在中の probe があり、`cause !== 'signal'` または `probe.startedAt > latestSignalAt` なら合流。なければ新しい probe を出す。
3. probe の答えが返った継続で: `epoch !== probe.epochAtStart` か `provider.credentialRevision?.() !== probe.revisionAtStart` か `latestSignalAt > probe.startedAt` なら**破棄**。上限内なら出し直し、超えたら要求に `unverified`（`SessionChangedError` 相当を `error` に入れる）。
4. 破棄されなければ `commit()`。その後、待っている要求それぞれに `epochAtRequest === epoch` なら `confirmed`、違えば `superseded`。
5. provider が reject したら `verification.failed` だけ更新して `unverified`。ただし revision が変わっていたら（切り替え後の失敗）I-5 の保留を先に `commit` する。

### 5.2 provider 契約への追加

```ts
export interface AuthProvider {
	// 既存: login / logout / check / getIdentity / status? / setup? / changePassword? / enterPublicViewer?

	/**
	 * 1 往復でセッションを答える。取得できないときは reject する（§2.1）。
	 * HTTP: GET /api/auth/session（新設。check + identity を 1 応答に。判断点 §9）。
	 * Tauri: auth_resolve（新設。§5.3）。
	 */
	resolve?(): Promise<{ status: 'none' } | { status: 'active'; identity: Identity }>;

	/**
	 * 資格情報の revision（不透明な整数）。provider が資格情報を書く・消すたびに +1。
	 * HTTP: メモリ上のカウンタ + storage イベントでも +1。Tauri: auth_resolve が返す seq。
	 * 秘密（トークン本体）は返さない。
	 */
	credentialRevision?(): number;

	/** 別タブや Rust 側の変化を含め、資格情報が変わったら呼ぶ（#257）。戻り値は購読解除 */
	onCredentialChanged?(listener: () => void): () => void;
}
```

書き込みの compare-and-set（#259、I-7）は provider の**内部**で行い、公開の引数は増やさない:

- `login`/`setup`/`enterPublicViewer`: 呼び出しの開始時に `revision` を読み、応答を書くときに
  一致するときだけ `setToken`。一致しなければ書かず、戻り値は `{ success: false, superseded: true }`
  （`error` も付ける）。
- `logout`: 開始時の revision と一致するときだけ `setToken(null)`。一致しなければ消さない
  （別のログインが済んでいる）。`POST /api/auth/logout` は開始時のトークンで送る（今の
  `headers(false)` は送信時の `getToken()` を読むので、**開始時に固定する**）。
- `check()` の `clearTokenIfCurrent` は今のまま（すでに compare-and-set）。

`resolve` を持たない古い provider（派生アプリが自前で `AuthProvider` を書いている場合）には、
controller が `check()` → `getIdentity()` の 2 往復で代替する**互換の adapter** を用意する
（`status` の照合は 2 往復の間に `credentialRevision` が変わっていないことで担保。無ければ
照合なしで、今と同じ強さ）。v2.0.0 では `resolve` を**必須にしない**（判断点 §9）。

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
#[tauri::command]
async fn auth_resolve(state) -> Result<AuthResolveResult, BantoError>;
// AuthResolveResult { identity: Option<Identity>, seq: u64 }

// 既存コマンドの変更: 開始時に seq を読み、書くときに cas_session。
// auth_login  : verify().await の前に seq を読む → 成功なら cas_session(seq, Some(Account)) →
//               書けなければ LoginResult { success: false, superseded: true, error: .. }。
//               監査は書けたときだけ "login"（書けなければ "login_superseded"。判断点 §9）。
// auth_setup  : 同上（アカウントの作成は行い、セッションだけ入れない）。
// auth_logout : auth_config().await の前に seq を読む → cas_session(seq, None) →
//               書けなければ Ok（何もしない。監査も残さない）。
// auth_config_apply_body / change_own_password / settle_session: すでに照合しているので
//               seq に乗せ替えるだけ。
```

`LoginResult` に `superseded: bool` を足すのは wire の追加（既定 `false`。TS 側は無ければ
`false` と読む）。REST の `/api/auth/login` は変えない（REST 側には 1 スロットが無い、§1.4）。

フロント側の `createTauriAuthProvider` は `auth_resolve` の `seq` を `credentialRevision()` と
して返し、`login`/`logout`/`setup` の完了後に `auth_resolve` を 1 回呼んで seq を更新し
`onCredentialChanged` を出す（Tauri は別タブが無いので、これが唯一の変化の源）。

### 5.4 既存の公開名の移行

| 今の公開名                                                                                  | v2.0.0 での扱い（案）                                                                                       | 理由                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `resolveProtectedSession`                                                                   | **削除**（`controller.resolve()` + アプリの方針に分かれる）                                                 | `enterPublicViewer` の呼び出しを core から外す。意味が変わる |
| `establishSession`・`beginSession`・`endSession`                                            | **削除**（`resolve()`・`adopt()`・`end()`）                                                                 | 単一の書き手（I-1）。委譲で残すと 2 つ目の入口になる         |
| `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`                  | **削除**（`controller.signal()` に格下げ。`connectEvents` は内部で `signal` を呼ぶ）                        | 本文「signal の入口に格下げ」                                |
| `onSessionEnded`                                                                            | **残す**（`subscribe` の上の薄い関数: active/unknown → none の遷移だけを通知）                              | アプリの `invalidateAll()` 配線がそのまま使える              |
| `sessionGeneration`・`currentSessionScope`・`isCurrentSessionScope`・`isSessionEstablished` | **残す**（既定の controller への委譲。読み取りだけ）                                                        | `listViewState` と画面の書き込み条件が使う。意味は変わらない |
| `sessionOwnerKey`                                                                           | **残す**。`kind` ごとの名前空間を足す（`publicViewer` は `public-viewer` のまま。adopt は `${kind}:${id}`） | 保存状態の互換                                               |
| `SessionChangedError`・`MAX_STALE_RETRIES`                                                  | **削除**（`unverified` の `error` に同名のエラーを入れる。上限は deps）                                     | reject しない契約（I-8）                                     |
| `ProtectedSessionOutcome`                                                                   | **削除**                                                                                                    | `resolveProtectedSession` と一緒                             |

「委譲して残す」を選ぶなら `establishSession`/`endSession`/`resolveProtectedSession` だけが候補
だが、**意味が変わる（reject しなくなる・`enterPublicViewer` を呼ばない）ので、同じ名前で
残すと誤用の源になる**。A′ 案（v2.0.0 で一度だけ移行）に合わせ、削除を推す（判断点 §9）。

## 6. SvelteKit との接続と、派生アプリの移行

### 6.1 admin-template の配線（v2.0.0 の形）

- `(app)/+layout.ts` の `load`:

  ```ts
  const controller = getSessionController();
  const result = await controller.resolve({ cause: 'navigation' });
  if (result.outcome === 'unverified') error(503, ...); // 再試行の画面（今のまま）
  if (result.outcome === 'superseded') return { sessionGeneration: controller.snapshot.generation }; // 画面は世代ゲートが決める
  let snapshot = result.snapshot;
  if (snapshot.status === 'none') {
  	snapshot = await publicViewerFallback(controller, authProvider); // アプリの方針（下）
  	if (snapshot.status !== 'active') redirect(307, `${base}/login`);
  }
  if (snapshot.kind === 'publicViewer') { /* 許可リストの redirect（今のまま） */ }
  return { sessionGeneration: snapshot.generation };
  ```

  `load` の副作用は `controller.resolve()`（と方針の `enterPublicViewer`）だけ。`sessionStore` への
  代入は `load` から消える。

- `publicViewerFallback`（admin-core の**任意の**ヘルパー。controller の外）:
  `status?.()` → `viewerPublic` なら `enterPublicViewer()`（provider 内部の compare-and-set）→
  `controller.resolve()` を返す。失敗なら `none` のまま返す。
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
- `login/+page.svelte`: `login()` 成功後の `goto(dashboard)` はそのまま（`load` の `resolve()` で確定）。
  `superseded: true` が返ったら「別のセッションが確定しました」を出して `resolve()`（判断点）。

### 6.2 派生アプリ（banto-industrial）の移行の手順の案

A′ 案のとおり、**候補版で検証したうえで、正式版への参照の更新まで 1 本の移行 PR** で行う。
両アプリとも `github:tyaro/banto#v1.7.3&path:...` → `#v2.0.0`。

| 対象                                                     | 置き換え                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/*/src/lib/session.svelte.ts` の `load()`           | 削除。`identity`/`role` は `getSessionController().snapshot` からの `$derived`                                                                                                                                                                                                                                                                  |
| `apps/*/src/lib/banto/sessionGuard.ts`                   | `resolveProtectedSession` → `controller.resolve()`。`'unverified'` は `outcome === 'unverified'`、`'login'` は `confirmed && status === 'none'`。`superseded` は「何もしない」                                                                                                                                                                  |
| `apps/*/src/routes/(app)/+layout.ts`                     | §6.1 の形（公開閲覧の fallback は両アプリとも無い）                                                                                                                                                                                                                                                                                             |
| banto-hub `sessionStore.enterCommissioningMode()`        | `controller.adopt(COMMISSIONING_IDENTITY, 'commissioning')`。lock-down の検知で `controller.end('commissioning-locked')`                                                                                                                                                                                                                        |
| banto-hub `sessionRecheck.ts`                            | `recheckSessionAfterStreamClose` → `controller.signal('app')` + `invalidateAll()`。`probeSessionAfterReconnectFailures` → `controller.resolve({ cause: 'signal' })` の結果を `SessionProbeResult` に写す（`confirmed/none → 'login'`、`confirmed/active → 'session'`、それ以外 → `'unverified'`）。独自の token 照合・single-flight・期限は削除 |
| banto-hub `(app)/+layout.svelte`・`monitor/+page.svelte` | 呼び口の変更に追従                                                                                                                                                                                                                                                                                                                              |
| 各アプリの `Header`/ログアウト                           | `controller.end('logout')` を足す（今は `endSession` 相当を呼んでいない）                                                                                                                                                                                                                                                                       |
| `#216` の `lan_urls` 3 か所・`#248` の監査ログ           | 同じ移行 PR に含める（Issue #260「進め方」3）。セッションとは独立                                                                                                                                                                                                                                                                               |

試運転の `adopt` については、banto-hub の `commissioning.ts` の `shouldBypassLoginForCommissioning`
の判断そのものは変えない（アプリの方針のまま）。

## 7. 実装の分割と、候補版での検証

### 7.1 実装の PR

| PR     | 内容                                                                                                                                                                                                                                                                                                        | 受け入れ条件                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装-1 | **provider とバックエンド**: `AuthProvider.resolve?`/`credentialRevision?`/`onCredentialChanged?` の追加、HTTP provider の compare-and-set（#259）と `storage` 監視、REST に `GET /api/auth/session`、Rust に `AuthSlot`（seq）・`auth_resolve`・`auth_login`/`auth_setup`/`auth_logout` の compare-and-set | S-9・S-16〜S-21 のテスト（Rust は `cargo test`、TS は vitest）。既存テスト全緑。controller はまだ無く、公開 API は追加だけ（この時点では minor 相当）。**タグは打たない** |
| 実装-2 | **controller**: `sessionController.svelte.ts`（`commit`・`resolve`・`signal`・`adopt`・`end`・deps 注入）、テストのハーネス（§8.1）、S-1〜S-15・S-23〜S-34・S-40〜S-45 のテスト。既存の `establishSession` 等は**この PR では controller への委譲に書き換えて残す**（admin-template を壊さないため）        | 全シナリオが S 番号付きで通る。既存の `sessionRaces`/`sessionGate`/`sessionEnded*` テストが呼び口の変更だけで通る                                                         |
| 実装-3 | **admin-template の配線と v2.0.0**: §6.1、`connectEvents` の `signal` 化、公開閲覧 fallback のヘルパー、§5.4 の削除、S-35〜S-39 のテスト（`storage` イベントのモック）、E2E（`session-check-outage`・`public-viewer` を保つ）、CHANGELOG の「挙動の互換性が変わる変更」と移行表                             | `pnpm check`/`test`/`e2e`/`e2e:public-viewer` 全緑。Tauri check 緑。CHANGELOG に §5.4 の表                                                                                |
| 移行   | **banto-industrial**（候補版の検証後）: §6.2 と参照の `v2.0.0` 化を 1 本で                                                                                                                                                                                                                                  | 両アプリの `check`/`test`/E2E、実機 smoke（banto-hub のローカル smoke 手順）、試運転の入退場、ストリーム切断後の再確認                                                    |

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
- テスト名は `S-n: ...` で始め、`describe` に `I-n` を書く。表と食い違ったら表を直す
  （表が正）。

### 8.2 provider のテスト

- HTTP: `fetchFn` のモックで、応答の解決の前に別の `setToken`（別のログイン）や `storage`
  イベントを入れ、書き込みが起きないこと（S-20・S-21・S-38）を `storage` の中身で確かめる。
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
- 監査: 書けなかったときに `logout`/`login` が**記録されない**ことを `audit` の内容で確かめる
  （今の `auth_config_apply_is_recorded_as_settings_change` と同じ手法）。
- 統合の確認として、`tokio::join!` で `auth_login` と `auth_logout` の本体を同時に走らせ、
  終わったあとの `state.auth` が「`None`」か「`Some(B)` かつ login の戻りが `success`」の
  **どちらか**であること（復活・消失のどちらも起きない）を複数回回す。順序は決められないので
  性質のテストとして置く。

### 8.4 E2E

- 既存の `e2e/tests/session-check-outage.ts`（500 の再試行）と `e2e/tests-public-viewer/` は保つ。
- 追加: 「identity の 500 の後、別タブでログイン → 元タブが旧ユーザーの画面を出さない」
  （S-23）を Playwright の 2 コンテキストで。`storage` イベントは同じ origin の 2 ページで実際に飛ぶ。

## 9. オーナーに判断してほしい点

1. **既存の公開名の削除か委譲か**（§5.4）。推奨は削除（reject しなくなる・`enterPublicViewer` を
   呼ばなくなるので同名で残すと誤用の源）。
2. **`AuthProvider.resolve` を v2.0.0 で必須にするか**（§5.2）。推奨は任意＋互換 adapter
   （派生アプリの自前 provider を壊さない）。
3. **REST に `GET /api/auth/session` を新設するか**、`check` + `identity` の 2 往復のままにするか。
   1 往復にしないと「check は成功、identity だけ 500」は消えないので新設を推す。
   `banto-server` の routes への追加（ADR-0001 の両経路対称: Tauri は `auth_resolve`）。
4. **Tauri のログイン不要モードを `adopt()` にするか、provider の `resolve()` に任せるか**（S-45）。
   推奨は provider（Rust が合成している事実に合う。issue 本文の「3 つ」からは 1 つ減る）。
5. **`superseded` を受け取った `load` の扱い**（§6.1）: 何も決めずに今の generation を返す（推奨）か、
   `resolve()` を呼び直すか。
6. **S-14 で、待つ要求が無くなった probe を出し直すか**。推奨は出し直さない（次の navigation が出す）。
7. **Rust の監査**: `login_superseded` を残すか、記録しないか（§5.3）。
8. **#257 の方針**（別タブの切り替えを検知したら、黙って新しい owner で作り直すか、知らせて
   ログイン画面へ送るか）。controller はどちらにも対応する（`subscribe` で owner の変化を見る）。

## 10. 未確認の点

- Rust の壊れる順序（§1.3）は**コードの読みで特定**した。実機・テストでの再現はしていない
  （実装-1 の S-16/S-17 のテストが再現を兼ねる）。
- `sessionRecheck.ts` の `probeSessionAfterReconnectFailures` の 3 値を `resolve()` の結果に写す
  対応（§6.2）は、`monitor/+page.svelte` の使い方（`streamClose.ts`）を読み切っていない。
  移行 PR で確認する。
- `storage` イベントの発火は同じ origin の**別の**ドキュメントに限られる（同じタブでは飛ばない）。
  同じタブの別ログインは provider 自身の `setToken` で revision を上げるので問題ないはずだが、
  Tauri の webview（WebView2）での `storage` イベントの挙動は未確認（Tauri は `sessionStorage`
  も使わないので影響は無いはず。推測）。
- Web Locks API による `localStorage` の原子化は不採用としたが（§4.6）、対応ブラウザの
  範囲は調べていない。
