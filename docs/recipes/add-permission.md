# レシピ: ユーザーへ個別に付ける権限を追加する（`equipment.operate` 型）

> English: [add-permission.en.md](add-permission.en.md)

作成日: 2026-11-19（Issue #697 PR-3。[add-role.md](add-role.md) の姉妹編。
設計は [design/user-permissions-plan.md](../design/user-permissions-plan.md)、判断は
[ADR-0031](../adr/0031-user-permissions-separate-axis.md)）

対象読者: **利用側アプリの開発者・AI エージェント（トラックA）**。「設定を直す人」と
「運転する人」を分けたい、のように、ロール（`viewer < editor < admin`）の段では
表せない許可を足したいときの手順。**banto のテンプレートは権限を 1 つも登録しない**
（カタログは空で、管理画面に権限の欄も出ない）。語彙は利用側が足す。

## 前提: ロールを足すか、権限を足すか

| 見るところ | ロール（[add-role.md](add-role.md)）      | 権限（本レシピ）                                                    |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------- |
| 並び       | 全順序。上の段は下の段を含む              | 独立。ほかの権限・ロールの段を見ない                                |
| 付け方     | 1 人に 1 つ                               | 1 人に何個でも。Viewer にも付けられ、Admin でも付けなければ持たない |
| 判定       | `RoleGuard`・`require_role`（`at_least`） | `PermissionGuard`・`require_permission`・`has_permission`           |
| 影響       | 全経路の認可床・CHECK 制約・選択 UI       | その権限を判定する場所だけ。表 `user_permissions` と管理画面は共通  |

- 「上の段が下の段のことを全部できる」なら**ロール**。
- 「Admin でも既定では持たない」「Viewer に付けてよい」「editor と admin の間に収まらない」
  のどれかに当てはまるなら**権限**。ロールを足すと上の段が自動でできてしまう。
  たとえば「監査ログだけ読める」は editor の下にも上にも収まらないので、権限が素直。
- 迷ったら権限。ロールは足すほど全経路に効く。

## チェックリスト（実施順）

| #   | ステップ                                                                                                                                                                                                                                                                                                                                                                                             | 変更箇所                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | キーを決める。形式は `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`（2 語以上、64 バイトまで）。例 `equipment.operate`                                                                                                                                                                                                                                                                                      | —                                                          |
| 2   | **カタログに登録する**: `PermissionCatalog::empty().register("equipment.operate", "perm.equipment_operate", "perm.equipment_operate_desc")?`。`admin_template_core::permission_catalog()` が**唯一の組み立て場所**で、banto-serve（REST）と Tauri の両方がこの関数を呼ぶ。形の違うキー・二重登録は起動時にエラー（黙って捨てない）                                                                   | `apps/admin-template/core/src/lib.rs`                      |
| 3   | **表示名と説明の i18n**: 手順 2 の message key（`perm.equipment_operate` と `perm.equipment_operate_desc`）を `messages/{ja,en}.json` に足す。管理画面はこのキーで引き、見つからなければキーそのものを出す（説明は出さない）                                                                                                                                                                         | `apps/admin-template/messages/{ja,en}.json`                |
| 4   | **サーバー側の判定**（REST と Tauri を対称に、conventions §1）: 下の「判定の置き方」                                                                                                                                                                                                                                                                                                                 | `crates/banto-server` を使うルート・`src-tauri/src/lib.rs` |
| 5   | **付け外し**: ユーザー管理画面の編集パネルに、登録した権限のチェックボックスが出る（カタログが空なら欄ごと出ない）。付け外しは Admin のみ。REST は `PUT /api/users/{id}` の `permissions`、Tauri は `users_update` の `permissions`。省略すると変えない。付け外しで `version` が +1 され、ほかの Admin の編集と衝突すれば 409 になる。ユーザーを**作るとき**には付けない（作った後に編集から付ける） | 画面は変更不要（カタログから出る）                         |
| 6   | **ログイン不要モード**で持たせたいときは、設定 > セキュリティの「起動時のロール」の下の欄で選ぶ（`auth.disabledPermissions`。アプリが権限を登録しているときだけ出る。既定は権限なし）。Tauri の `auth_config_apply` の `permissions` で送る。デスクトップ専用の入口で、REST の入口は無い                                                                                                             | 設定画面（変更不要）                                       |
| 7   | **フロントの出し分け**: `sessionStore.hasPermission(key)`（セッションの `permissions`）で、ボタンの表示・無効化に使う。**画面の出し分けは見た目だけ**で、判定は手順 4 のサーバー側                                                                                                                                                                                                                   | 利用側の画面                                               |
| 8   | **テスト**: 持つ人は通り、持たない人（Admin を含む）は 403 `forbidden` + `denied` の監査になることを、REST と Tauri の両方で確かめる                                                                                                                                                                                                                                                                 | `apps/admin-template/core/src/rest/tests.rs` など          |

### 判定の置き方（手順 4）

- **経路やコマンドの単位**で守る:
  - REST: `middleware::from_fn_with_state(PermissionGuard { auth, permission, resource, audit }, require_permission)`
    を `require_auth` の後ろに積む。`permission` は `PermissionKey::parse("equipment.operate")` で作る。
    拒否は 403 `forbidden` と `denied` の監査（ロールの拒否と同じ形）。
  - Tauri: `require_permission(state, &permission, resource)?` を `require_role` の隣で呼ぶ。
    拒否は `BantoError::Forbidden` と `denied` の監査。コマンドのたびに DB から読むので、
    外せば次のコマンドから効く。
  - ロールと両方求めたいときは `RoleGuard`・`require_role` も重ねる（権限はロールを見ない）。
- **経路より細かい単位**（たとえば設備ごと）で分けたいとき:
  - REST: ハンドラが `Extension<SessionPermissions>` を受け取り、`has(&PermissionKey)`
    （`has_permission` の判定）で調べる。
  - Tauri: `session_permissions(state)` で読み、同じく `has` で調べる。
- 閲覧公開（grant のセッション）は**常に権限なし**。ログイン不要モードは
  `auth.disabledPermissions` に入れたものだけを持つ。
- カタログに登録されていないキーは**誰も持っていない**ものとして扱う（表に残っていても。
  管理画面では「未登録」と出て、外せる）。登録し忘れたキーで守ると全員が拒否される。
- 権限は要求ごとに DB から読むので、外せば次の要求から効く（セッションの再発行は要らない）。

## 監査に残るもの

- 付け外し: ユーザー更新の監査（`action: "update"`、`resource: "users"`）の `changes` に
  `{ field: "permissions", added: [...], removed: [...] }`。ロールの変更と同じ並び。
  監査ログ画面は「追加 / 削除」として表示する。
- 拒否: 権限による拒否は `denied`（ロールの拒否と同じ形）。
- ログイン不要モードの権限の変更: 設定変更（`settings_change`）の detail に、変わったときだけ
  `authDisabledPermissions: { added, removed }`。
- Admin が自分に付けることは**禁止していない**（監査に残る。小さい現場で Admin が 1 人のため）。

## 対象外（本レシピと本機構がやらないこと）

- **設備・画面ごとの割当て**（`equipment.operate` を設備 A だけに付ける）。必要なら利用側が、
  `has_permission` に加えて**自分の表**で判定する。
- 権限の**有効期限**。
- 権限の**グループ**（ロールのような束）。
- 作成時に権限を付ける入口（`POST /api/users`・`users_create` は変えていない）。

## 検証

```bash
pnpm check                 # フロント lint/型・i18n
pnpm verify:architecture   # rule 8: 権限のガードの対（PERMISSION_PAIRS）
cargo test                 # 判定・監査のテスト
```

`src-tauri` はサンドボックスでコンパイルできないことがある（AGENTS.md）。その場合
手順 4 の Tauri 側はコードレビュー + 週次 Tauri CI で担保し、「未実行の検証」として明記する。

## やってはいけないこと

- 片方の経路だけに判定を置く（conventions §1）。画面の非表示だけで守る。
- 権限をロールの代わりに使って、結局「上の段が全部できる」形にする（その場合はロール）。
- banto の公開の構造体（`Identity`・`UserIdentity` など）にフィールドを足して権限を持ち回る
  （破壊的変更。権限は別の型 `SessionPermissions` で持つ）。
- カタログに登録せずにキーだけ使う（誰も持てず、全員が拒否される）。
