# ADR-0031: ロールとは別の軸として、ユーザーへ個別に付ける権限（permission）を持つ

> English: [0031-user-permissions-separate-axis.en.md](0031-user-permissions-separate-axis.en.md)

- 状態: Accepted（2026-11-19）
- 日付: 2026-11-19
- 関連: Issue #697 / [design/user-permissions-plan](../design/user-permissions-plan.md) /
  実装 PR #701（PR-1 サーバー）・#702（PR-2a 管理画面）・#703（PR-2b ログイン不要モード）/
  conventions §1・§2・§6・§11 / [recipes/add-permission](../recipes/add-permission.md) /
  [recipes/add-role](../recipes/add-role.md) / [ADR-0014](0014-account-bound-session-revocation.md) /
  [ADR-0017](0017-credential-less-grant.md)

## コンテキスト

banto-industrial の SCADA（temp-scada）は、「設定を直す人」と「運転する人」を分けたい。
権限として `equipment.operate`（運転操作）と `alarm.ack`（警報の確認）が要り、
**Admin も既定では持たない**。付け外しは Admin が行い、監査に残す。

banto のロールは `Role { Viewer < Editor < Admin }` の全順序で、判定は `at_least`
（REST の `RoleGuard`、Tauri の `require_role`）。ここに段を足すと、上の段が自動で運転も
できてしまい、「Admin は運転できない」を表せない。また、ロールを足すと `Role` enum・DB の
CHECK 制約・両経路の認可床・選択 UI すべてに効く（[add-role](../recipes/add-role.md)）。
`equipment.operate` のような許可は、設備や運用ごとに増える利用側の語彙で、汎用テンプレートが
持つ筋のものでもない。

## 決定

ロールとは**独立した軸**として、ユーザーへ個別に付ける権限を持つ。詳細は
[計画書 §8](../design/user-permissions-plan.md) の決定 1〜8。

1. **名前は permission**（Rust は `Permission` 系の型、TS は `UserPermission`、表は
   `user_permissions`）。「capability」は、リソースの操作可否（ADR-0030、
   `lib/resource/permissions.ts`）と dock-svelte の pane の能力ですでに使っていてぶつかる。
2. **語彙は利用側がカタログで登録する**（`PermissionCatalog`、`admin_template_core::permission_catalog()`
   の 1 か所を banto-serve と Tauri が共有）。banto のテンプレートは何も登録しない（欄は出ない）。
   `equipment.operate`・`alarm.ack` は banto-industrial が登録する。
3. **監査は既存の `update` に相乗り**。付け外しはユーザー更新の `changes` に
   `{ field: "permissions", added, removed }`。別 action にはしない。拒否は `denied`。
4. **ログイン不要モードは、既定で権限なし**。設定 `auth.disabledPermissions`（`disabled_role` の隣）で付ける。
   閲覧公開（grant）のセッションは常に権限なし。
5. **Admin が自分に付けることを許す**（監査に残る。小さい現場では Admin が 1 人のため）。
6. **付け外しの入口はユーザー更新に相乗り**（`PUT /api/users/{id}` と Tauri `users_update` の
   `permissions?`。省略で変えない。`users.version` の楽観ロックが効く）。専用の入口は作らない。
7. **公開の構造体（`Identity`・`UserIdentity` など）にフィールドを足さない**。権限は別の型
   `SessionPermissions` で持ち、REST は request extension、Tauri は要求ごとに DB から読む。
   セッション応答の JSON に `permissions` を足すのはフィールドの追加で壊れない。
8. **ユーザーを作るときには付けない**。作った後に編集から付ける（`POST /api/users`・`users_create` は変えない）。

判定は**ロールの段を見ない**（Viewer に付けてよく、Admin でも付けなければ持たない）。
判定はサーバー側（`PermissionGuard`・`require_permission`・`has_permission`）で両経路対称に行い、
要求ごとに DB から読む（ADR-0014 / Issue #204 と同じ経路）ので、外せば次の要求から効く
（`auth_epoch` は上げない）。カタログに無いキーは持っていないものとして扱う。
データは migration 0013（`user_permissions`、両方言）。

## 検討した代替案

| 案                                                          | 退けた理由                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ロールを足す（`operator` など）                             | 全順序なので上の段が自動で運転できる。「Admin は運転できない」を表せず、非全順序は本モデルに載らない（add-role の前提）            |
| `Role` を非全順序（集合）にする                             | 全経路の認可床・CHECK 制約・42 か所の構造体リテラルに波及する破壊的変更。得るものに対して大きすぎる                                |
| banto が `equipment.operate` / `alarm.ack` を組み込みで持つ | 汎用テンプレートに SCADA の語が入る。利用側ごとに語彙が違う                                                                        |
| users の列に JSON の配列で持つ                              | 「誰が `alarm.ack` を持つか」を引けない。2 方言の JSON の扱いの差を持ち込む                                                        |
| `Identity` / `UserIdentity` に `permissions` を足す         | すべて pub のフィールドで、リポジトリ内 42 か所と利用側が構造体リテラルで組み立てている。足すとコンパイルできなくなり major になる |
| セッション（トークン）に権限を載せる                        | 外しても発行済みのセッションに効き続ける。`auth_epoch` を上げて全員を切る必要が出る                                                |
| 専用の `PUT /api/users/{id}/permissions`                    | 入口が増え、`version` の楽観ロックと監査を別に揃える必要がある。更新の相乗りで足りる                                               |
| capability という名前                                       | 既存の 2 か所の用法とまぎれる                                                                                                      |

## 帰結

- **版は minor**。既存の公開の型・関数のシグネチャは変えず、追加だけ（`SessionPermissions` などの新しい型、
  JSON のフィールドの追加、`SettingsService::set_auth_config_and_disabled_permissions`）。
  構造体リテラルで組み立てている派生アプリもそのままコンパイルできる。
- 利用側は、カタログへの登録・message key の i18n・判定の置き方を
  [add-permission](../recipes/add-permission.md) の手順で行う。ロールか権限かの判断は
  add-role と add-permission に相互に書いた。
- migration 0013 が増える（前進のみ。[upgrading](../upgrading.md) 4 節）。`user_permissions` は
  `users` の削除で消える（`ON DELETE CASCADE`）。
- `verify:architecture` rule 8 を権限のガードの対（`PERMISSION_PAIRS`）に広げた。
  `permissions_catalog` ↔ `GET /api/permissions` を登録した。
- ログイン不要モードの権限（`auth.disabledPermissions`）の入口はデスクトップ専用（REST の入口は無い）。
- 対象外: 設備・画面ごとの割当て（利用側が自分の表で判定する）、有効期限、グループ。
  必要になったら別の ADR で扱う。
