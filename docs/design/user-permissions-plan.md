# ユーザーへ個別に付ける権限（permission）計画書 — Issue #697

作成日: 2026-11-19
状態: **決定（2026-11-19 オーナー: §8 は 6 点とも推奨どおり）**。§9 の順に PR を分けて実装する。
トラック: 保守者向け（トラックA）
関連: Issue #697、tyaro/banto-industrial#1177（2026-11-18 オーナー決定）、
banto-industrial `docs/hub/tag-server-design.md` §6.6 の 5「操作の権限」、
conventions §1（REST と Tauri の対称）・§2（サービス層は認可を知らない）・§6（セキュリティ）・§11（migration）、
[docs/recipes/add-role.md](../recipes/add-role.md)（ロールを足す手順。本書はロールを**足さない**側の答え）

## 1. 目的

SCADA（banto-industrial の temp-scada）で「設定を直す人」と「運転する人」を分ける。
今の `Role { Viewer < Editor < Admin }` は全順序なので、段を足すと上の段が自動で運転もできてしまう。
そこで、**ロールとは別の軸**として、ユーザーへ個別に付ける権限を足す。

- 最初の権限: `equipment.operate`（運転操作）、`alarm.ack`（警報の確認）。
- Admin も既定では持たない。付け外しできるのは Admin。
- 判定はサーバー側（REST の Axum と Tauri の Rust）で行う。画面の非表示だけには頼らない。
- 付け外しは監査に残す。
- 設備・画面ごとの細かい割当て（「この設備だけ運転できる」）は対象外。後から利用側で足せる形にしておく。

## 2. 今の仕組み（調査、2026-11-19）

- `Role` は `crates/banto-admin-services/src/rbac.rs`。`at_least` で判定する。
- REST: `crates/banto-server/src/routes/mod.rs` の `RoleGuard { auth, min, resource, audit }` と `require_role_at_least`。権限不足は 403 `forbidden`、監査は `record_denied_as`。
- Tauri: `apps/admin-template/src-tauri/src/lib.rs` の `require_role(state, min, resource)`。
- セッション: REST の `AuthState::authenticate`（`auth/state.rs`）は**要求ごとに users の行を読み直し、今の role を取る**（Issue #204）。Tauri は `DesktopSession::Account(UserIdentity)`。
- users の読み書きは `UsersService`（`users.rs`）。trait は無く、SQLite と PostgreSQL の `Db`。migration は 2 系統で、最新は 0012（`users.version`）。
- 監査: `AuditEntry`。ユーザーの更新は `action: "update"`, `resource: "users"`、detail は `{ username, role, changes }`。
- 「capabilities」という語は、すでに 2 か所で使われている。リソースの操作の可否（ADR-0030、`lib/resource/permissions.ts`）と、dock-svelte の pane の能力。

## 3. 方針の要点

1. **名前は permission**（Rust の型は `Permission`、表は `user_permissions`）。「capability」は上の 2 か所とぶつかるので使わない。フロントの `ResourcePermissions` とは別物と分かるように、型名は `UserPermission` にする（§8-1）。
2. **ロールとは独立**。判定は「その権限を持っているか」だけで、ロールの段は見ない。Viewer に `equipment.operate` を付けてもよく、Admin でも付けていなければ運転できない。
3. **語彙は利用側が登録する**。banto は仕組みと検証だけを持ち、どの権限があるかはアプリが起動時に登録する（カタログ）。`equipment.operate` と `alarm.ack` は banto-industrial が登録する（§8-2）。
4. **セッションには載せず、要求ごとに DB から読む**。role と同じ経路（Issue #204 の読み直し）に乗せる。外せば次の要求から効くので、`auth_epoch` は上げない。

## 4. データ

migration 0013（SQLite と PostgreSQL の両方）:

```sql
CREATE TABLE user_permissions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  granted_by TEXT    NOT NULL,   -- 付けた Admin の username（監査とは別に、今の状態の出どころ）
  granted_at TEXT    NOT NULL,   -- PostgreSQL は TIMESTAMPTZ（既存の列の流儀に揃える）
  PRIMARY KEY (user_id, permission)
);
```

- users の列（JSON の配列）にしない理由は 2 つ。「誰が `alarm.ack` を持っているか」を引けるようにするため。また、2 方言の JSON の扱いの差を避けるため。
- 付け外しでは `users.version` を +1 する（楽観ロック。ほかの Admin の編集と衝突を検出する）。
- カタログに無い権限が表に残っていても（アプリが登録をやめた場合）、判定では持っていないものとして扱う。読み込みは失敗させず、管理画面では「未登録」と出す。

## 5. サーバー側の API（Rust）

- `banto-admin-services`:
  - `PermissionKey`（newtype）。形式は `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`（`equipment.operate` 型）。
  - `PermissionCatalog`: 登録された権限の一覧（キー、表示名の message key、説明）。アプリが起動時に組み立てて state に置く。
  - `UsersService::permissions_of(user_id)`、`set_permissions(user_id, &[PermissionKey], version, actor)`。後者は差分（追加・削除）を返す。サービス層は認可を知らない（conventions §2）。
- セッション（2026-11-19 オーナー決定 §8-7: **公開の構造体にフィールドを足さない**）: REST の `Identity` と、`banto-admin-services` の `UserIdentity` は、すべてのフィールドが pub の構造体です。リポジトリの中だけでも 42 か所で `Identity { .. }` の形で直接組み立てていて、利用側（banto-industrial のテストなど）も同じ書き方をしています。フィールドを足すとこれがコンパイルできなくなる（破壊的変更）ので、権限は**別の型**で持ちます。
  - REST: `require_auth` が認証のときに読んだ権限を、別の型 `SessionPermissions`（`BTreeSet<PermissionKey>` の newtype）として、リクエストの extension に入れる。ガードと `has_permission` はこれを見る。`AuthenticatedSession` などの公開の構造体には足さない（足すなら非公開のフィールドにして、外から組み立てられない型だけに限る）。
  - Tauri: `require_permission` が、コマンドのたびに DB から読む（`UsersService::permissions_of`）。`UserIdentity` には足さない。
  - セッション取得の応答（JSON）に `permissions` を足すのは、フィールドの追加なので壊れない。Rust の型の側は、応答用の別の型で組み立てる。
  - どちらも要求ごとに DB から読むので、外せば次の要求から効く。
  - **要確認（実装の最初に調べる）**: Tauri の `require_role` がコマンドごとに users の行を読み直しているか。読み直していなければ、権限だけは読み直す。
- ガード（両経路で対称、conventions §1）:
  - REST: `PermissionGuard { auth, permission, resource, audit }` とミドルウェア `require_permission`。拒否は 403 `forbidden`、監査は `record_denied_as`（ロールの拒否と同じ形、detail は `{method, path}`）。
  - Tauri: `require_permission(state, permission, resource) -> Result<UserIdentity, BantoError>`。拒否は `BantoError::Forbidden` と監査 `denied`。
  - 経路やコマンドの中で細かく分けたいとき（設備ごと）のために、REST は extractor で取り出せる `SessionPermissions::has(&PermissionKey)`、Tauri は読み出し関数（例 `session_permissions(state)`）を公開する。
- `verify:architecture` の rule 8（REST と Tauri の認可床の対称）を、権限のガードにも広げる。

### 権限を持たないセッション

- **閲覧公開（viewer-public など grant のセッション）**: 常に権限なし（読み取り専用の設計を崩さない）。
- **ログイン不要モード（`AuthDisabledLocal`）**: 既定は権限なし。設定 `auth.disabledPermissions`（`disabled_role` の隣）で付けられるようにする（§8-4）。

## 6. 管理画面と REST の入口

- 付け外しは**ユーザー更新と同じ入口**にする。`PUT /api/users/{id}` の body に `permissions?: string[]` を足し、Tauri の `users_update` も同じにする。省略したときは変えない（今の版のクライアントは壊れない）。同じ `version` で楽観ロックが効く。
- カタログ: `GET /api/permissions`（Admin のみ）と Tauri の `permissions_catalog`。
- 自分のセッションの権限は、既存のセッション取得（`/api/auth/session` 相当と `current_session`）に `permissions` として足す。画面の出し分け用で、判定はサーバーが行う。
- 管理画面 users の編集ダイアログ: カタログの権限をチェックボックスで並べる。カタログが空なら、その欄ごと出さない（汎用のテンプレートの見た目は変わらない）。一覧の列には出さない。
- i18n: 権限の表示名は、アプリが登録する message key で引く。banto の messages に足すのは、欄の見出し・「未登録」の表示・説明文だけ。

## 7. 監査

- 付け外しは、ユーザー更新の監査 `action: "update"` の detail の `changes` に `permissions: { added: [...], removed: [...] }` として入れる。ロールの変更と同じ並びに置く。
- 検索しやすさを優先するなら、別の action `permissions_update` に分ける案もある（§8-3）。
- 権限による拒否は `denied`（今の拒否と同じ形）。

## 8. 決めたこと（2026-11-19 オーナー: すべて推奨どおり）

| # | 論点 | 推奨（既定） | 代わりの案 |
| - | ---- | ------------ | ---------- |
| 1 | 名前 | `permission`（Rust は `Permission`、TS は `UserPermission`）。capability は既存の 2 か所とぶつかる | Issue のとおり capability（既存とまぎれる） |
| 2 | 語彙の持ち方 | 利用側がカタログで登録する。banto のテンプレートは何も登録しない（欄は出ない）。`equipment.operate`・`alarm.ack` は banto-industrial が登録 | banto が 2 つを組み込みで持つ（汎用のテンプレートに SCADA の語が入る） |
| 3 | 監査の action | 既存の `update` の detail に `permissions` の差分 | 別の action `permissions_update` |
| 4 | ログイン不要モード | 既定は権限なし。`auth.disabledPermissions` で付けられる | 常に権限なし（キオスクで運転できない） / 常に全部持つ（危ない） |
| 5 | Admin が自分に付けること | 許す（監査に残る。小さい現場で Admin が 1 人のため） | 禁止（職務の分離を強める。Admin が 2 人以上要る） |
| 6 | 付け外しの入口 | ユーザー更新（`PUT /api/users/{id}`）に相乗り | 専用の `PUT /api/users/{id}/permissions` |


追加の決定（2026-11-19、別のセッションの見直しを受けて）:

| # | 論点 | 決定 |
| - | ---- | ---- |
| 7 | 公開の構造体（`Identity`・`UserIdentity`）にフィールドを足すか | **足さない**。別の型 `SessionPermissions` で持ち、破壊的変更を避ける（§5）。版は minor のまま |
| 8 | ユーザーを作るときに権限を付けられるか | **付けない**。作った後に、編集から付ける。`POST /api/users` と `users_create` は変えない |

### 見直しで拾った点（どの PR で扱うか）

- **PR-1**: 0013 より前のバックアップを戻したとき、migration で `user_permissions` ができることをテストで確かめる（`backup.rs` の `REQUIRED_TABLES` は settings・users・audit_log しか見ていない）。
- **PR-1**: カタログの真実源を 1 か所にする。banto-serve（REST）と Tauri が同じ `PermissionCatalog` を使うように、組み立てる場所（`admin-template-core` の 1 つの関数）を決め、両方からそれを呼ぶ。
- **PR-1**: 新しい入口（`GET /api/permissions`、Tauri の `permissions_catalog`）を、`verify:architecture` の rule 8（`DUAL_PATH` など）に載せる。scaffold.mjs はこの一覧を名前で書き換えるので、4 プリセットの dry-run で確かめる。
- **PR-2**: 監査ログの画面（`audit-log/+page.svelte`）は `changes` を表示している。`permissions: { added, removed }` が、表示と i18n で崩れないことを確かめる。
- **PR-3**: 「ロールとは別の軸を足す」は add-role.md の判断を変えるので、ADR-0031 として残す。

確認済み: SQLite は `foreign_keys(true)`（`banto-storage/src/sqlite.rs`）なので、ユーザーを削除したときの ON DELETE CASCADE は効く。

## 9. PR の分け方（minor）

1. **PR-1 サーバー**: migration 0013（2 方言）、`PermissionKey`・`PermissionCatalog`・`UsersService` の読み書き、セッションへの搭載（REST・Tauri）、`PermissionGuard`・`require_permission`・`has_permission`、監査、`verify:architecture` の拡張。単体テストと、PostgreSQL の統合テスト。
2. **PR-2 管理画面**: カタログとセッションの `permissions` の入口、users の編集ダイアログのチェックボックス、i18n、e2e（付けて外し、拒否と監査を見る）。テンプレートに「例」の権限を 1 つ登録するかは、PR-2 で決める（e2e のため）。
3. **PR-3 文書**: recipe「権限を足す」（`add-permission.md`。add-role.md と、どちらを使うかの判断を相互に書く）、README、CHANGELOG、upgrading。

scaffold への影響: users と auth はコアなので、プリセットでは消えない。display は users の画面を外すので、そのプリセットでは画面から付け外しできない（表示専用なので問題ない）。PR-2 で 4 プリセットの dry-run を確かめる。

## 10. 対象外

- 設備・画面ごとの割当て（`equipment.operate` を設備 A だけに付ける）。必要になったら利用側で、`has_permission` に加えて自分の表で判定する。
- Hub への `on_behalf_of` の記録（banto-industrial 側）。
- 権限の有効期限・グループ（ロールのような束）。
