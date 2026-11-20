# レシピ: CRUD リソースを追加する（items を手本にする正式手順）

> English: [add-resource.en.md](add-resource.en.md)

作成日: 2026-07-18（improvement-plan-2026-07.md P1-3。spec §14 の
「ルート導出方式」の決着に伴う成果物）

対象読者: **アプリ作者（トラックB）と、テンプレート保守者・AI エージェント
（トラックA）の両方**。新しい CRUD リソース（例: `customers`）を追加する
とき、または同梱デモの `items` を自リソースに差し替えるときの唯一の正式
手順。AI にリソース追加を委譲するときは、本レシピをそのまま指示に使う。

## 方式の決定（2026-07-18）

リソースのページは**動的ルート `[resource]` による自動導出ではなく、
`items` のルート一式をコピーして書き換える**方式を正式な規約とする
（spec §14 の未決事項を決着）。理由: テンプレートの「すべては削除可能・
コピーして理解できる」方針（template-scope §1）と整合し、動的ルート化は
利用者が読み解けない魔法を増やすため。

2026-11-13 更新（[ADR-0030](../adr/0030-resource-page.md)）: 動的ルートを採らないのは
そのまま。画面の中身は `lib/resource/` の共通部品（`ResourceListPage`・`ResourceDetail`）に
移ったので、コピーして書くのは**定義 1 つ（`resources/<name>.ts`）とルート 3 本**になった。

## チェックリスト（実施順）

Rust 側 → フロント側の順に進める。各ステップの「手本」列のファイルを
コピーして書き換えるのが最短。

| #   | ステップ                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 手本（items の実装）                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1   | マイグレーション追加（連番 SQL、conventions §11）                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/admin-template/core/migrations-sqlite/0001_items.sql`（+ Postgres 版を `migrations-postgres/` に）              |
| 2   | サービス層追加（Clone + BantoError + sqlx、tauri/axum 非依存。`column_map()` でソート/フィルタ列をホワイトリスト化 — conventions §2, §6）                                                                                                                                                                                                                                                                                                                                | `apps/admin-template/core/src/items.rs`                                                                               |
| 3   | REST ルート追加（`RoleGuard` + `record_write` で認可・監査 — conventions §1）                                                                                                                                                                                                                                                                                                                                                                                            | `apps/admin-template/core/src/rest/items.rs`（コピーして `rest/<yours>.rs` を作り `rest/mod.rs` に登録）              |
| 4   | Tauri コマンド追加（`require_role` + `audit.record(...)` — REST と**同一の**認可・監査）                                                                                                                                                                                                                                                                                                                                                                                 | `apps/admin-template/src-tauri/src/lib.rs` の `items_*` コマンドと `AppState.items`                                   |
| 5   | **両経路の認可対称テスト**（許可ロールの成功 + denied の記録、REST/Tauri 双方。読み取り系は監査しない — conventions §1）                                                                                                                                                                                                                                                                                                                                                 | `rest/tests.rs` / 各サービスの `#[cfg(test)]`                                                                         |
| 6   | 監査イベントの確認（mutating 操作すべてが `record_write`/`audit.record` を通ること。detail に秘密を入れない — conventions §6）                                                                                                                                                                                                                                                                                                                                           | 同上                                                                                                                  |
| 7   | フロント: リソース定義 + スキーマ登録（`resources/<yours>.ts` に `defineResource({...})` で `AppResourceDefinition` を書き、`resources/index.ts` の配列に追加。ナビは `nav`、一覧の読み込み方・列の調整は `list`、CSV 出力・取込は `csv` で決める。権限は `capabilities` と role から `resourcePermissions` が導く — ADR-0030 §3・§5）                                                                                                                                   | `apps/admin-template/src/lib/banto/resources/items.ts`・同 `resources/index.ts`                                       |
| 8   | フロント: ルート 3 本（一覧 `<ResourceListPage resource={…}>`・`[id]` と `new` の `<ResourceDetail>` を呼ぶ薄いファイル。ナビ・ページ題・「<label>を新規作成」コマンドは定義から導出されるので `navigation.ts` は触らない。一覧の列はスキーマから導出され、手書きは `list.columns` の `overrides` だけ — M23）                                                                                                                                                           | `apps/admin-template/src/routes/(app)/items/`（`+page.svelte`・`[id]/+page.svelte`・`new/+page.svelte`）              |
| 9   | （必要なら）CSV 取込: 取込の API（`DataProvider` に口が無いので専用のクライアント）を作り、定義の `csv.import` に `run`（行を API の型に直して送る）・`rules`（取込の規則の文言。取込ボタンの title と確認パネルに出る）・`available`（demo では false）を書く。必須列と確認表の列は既定でスキーマの `required` の欄、文字列の id は `idType: 'string'`。取込は `capabilities` の `create` と `edit` を両方持つときだけ出る。ほかにダッシュボードパネル・E2E スモーク1本 | `itemsAdmin.ts` の `importItems`・`items.ts` の `csv.import`・`src/lib/banto/dashboard.ts`・`e2e/tests/smoke.spec.ts` |

create/update/delete の監査 `detail.changes` は変更表用の予約キー。
`[{ field, before, after }]`（秘密の欄は `{ field, masked: true }`）の形で記録する。
別の意味のデータには `changes` 以外のキーを使う。

ブラウザ単体デモ（InMemory）にも出したい場合は
`src/lib/banto/sampleData.ts` に生成データを足す（任意。デモに出さない
機能は conventions §10 の「demo は明示拒否」に従う）。

## items の関与ファイル全量（層別）

`items`（商品）は「一覧・詳細・新規作成・CSVインポート/エクスポート・
ダッシュボード集計」を貫通させたお手本として同梱している
（[template-scope.md §3](../template-scope.md)）。上のチェックリストの「手本」列を
層別に展開した全量は以下のとおり（差し替え・削除の対象もこの表）。

| 層                       | ファイル                                                                                                                                | 内容                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust: マイグレーション   | `apps/admin-template/core/migrations-sqlite/0001_items.sql`（+ `migrations-postgres/0001_items.sql`）                                   | `items` テーブル定義                                                                                                                         |
| Rust: シード             | `apps/admin-template/core/src/db.rs`（`SEED_ROW_COUNT`・`seed_if_empty`）                                                               | 初回起動時の1,000件デモ投入                                                                                                                  |
| Rust: サービス層         | `apps/admin-template/core/src/items.rs`                                                                                                 | `Item`/`ItemInput`/`ItemImportRow`・CRUD・CSVインポート                                                                                      |
| Rust: REST               | `apps/admin-template/core/src/rest/items.rs`                                                                                            | `items` のルーティング（LANブラウザ向け）                                                                                                    |
| Rust: Tauriコマンド      | `apps/admin-template/src-tauri/src/lib.rs`                                                                                              | `items_list`/`items_get`/`items_create`/`items_update`/`items_delete`/`items_bulk_delete`/`items_import`、`AppState.items`                   |
| フロント: リソース定義   | `apps/admin-template/src/lib/banto/resources/items.ts`・同 `resources/index.ts`                                                         | `itemsSchema`/`itemsResource` の定義と `resources` 配列への登録（`setup.ts` が `initBanto` へ渡す）                                          |
| フロント: デモデータ     | `apps/admin-template/src/lib/banto/sampleData.ts`                                                                                       | ブラウザ単体デモモード（InMemory）用の生成データ                                                                                             |
| フロント: ページ         | `apps/admin-template/src/routes/(app)/items/`                                                                                           | 一覧・詳細・新規の薄いルート（中身は `lib/resource/` の `ResourceListPage`・`ResourceDetail`。CSV 取込も部品が定義の `csv.import` から描く） |
| フロント: CSVインポート  | `apps/admin-template/src/lib/banto/itemsAdmin.ts`                                                                                       | バルクインポートAPIクライアント（M15）。`items.ts` の `csv.import.run` から呼ぶ                                                              |
| フロント: ナビ           | `apps/admin-template/src/lib/navigation.ts`                                                                                             | items の項目・ページ題は定義の `nav` と `resource.createTitle` / `editTitle` から導出される（手で足さない。ADR-0030 段 1）                   |
| フロント: ダッシュボード | `apps/admin-template/src/lib/banto/dashboard.ts`・`src/lib/components/DashboardPanel.svelte`・`src/routes/(app)/dashboard/+page.svelte` | `items` から集計するスタットタイル/カテゴリ別在庫等のパネル定義                                                                              |

`admin-template-core`/Tauri/REST の三経路で同一のサービス層を通す構造
（[template-scope.md §2.1](../template-scope.md)）は維持すること。

## `sqlx::migrate!` は同一DBに1クレートまで

`apps/admin-template/core/src/db.rs` はアプリ自身のスキーマを
`sqlx::migrate!("./migrations-sqlite")` /
`sqlx::migrate!("./migrations-postgres")` で適用する。`sqlx` の
マイグレーション管理テーブル（`_sqlx_migrations`）は**データベース全体で
1つ**であり、クレートごとにテーブル名を分ける機能は無い。そのため
`_sqlx_migrations` を内部で使う別クレート（自作の共通クレート等）を
**同一プール**に対して併用すると、バージョン番号が衝突して
`MigrateError::VersionMismatch`/`VersionMissing` で必ず失敗する
（空DBへの初回実行から発生する）。回避策は次のどちらか:

- 併用するクレート側を `sqlx::migrate!` ではなく冪等な DDL
  （`CREATE TABLE IF NOT EXISTS`、列追加は存在確認してから
  `ALTER TABLE`）にする
- アプリ側の `db.rs` を冪等 DDL に寄せ、`sqlx::migrate!` を使うクレートを
  1つに絞る

いずれにせよ「同一プールに対して `sqlx::migrate!` を呼ぶクレートは常に
1つまで」を保つこと（[publishing.md](../publishing.md)「消費実績と消費側の手順」で
実際に踏んだ罠）。

## 一覧の絞り込み・並び順の保持（任意、Issue #215）

一覧 → 詳細 → 保存 → 一覧と往復しても絞り込み・並び順・直前に開いた行を
残したい場合は、`@banto/admin-core` の一覧状態 API を使う（手本は
一覧の共通部品 `lib/resource/ResourceListPage.svelte` と、詳細の共通部品
`lib/resource/ResourceDetail.svelte`）。

- 一覧ページは生成時に `const scope = currentSessionScope()` を取り、
  `loadListViewState`/`saveListViewState`/`loadLastOpenedId` などすべてに
  渡す。詳細ページは mount 時に `saveLastOpenedId(scope, resource, id)`、
  保存成功時に `noteLastEditedRecord(scope, …)` を呼ぶ（保存開始前に取った
  `scope` を渡す。保存中にセッションが変わると書かれない）。
- 状態は所有者（ログイン中のアカウント／公開閲覧者）付きで保存され、確定した
  今の所有者にしか復元されない。セッションの確定は SessionController（v2.0.0、
  tyaro/banto#260・ADR-0016）が 1 か所で行い、前提の配線はテンプレートに入っている:
  `(app)/+layout.ts` の `load` が `resolveSettled(getSessionController())` で確認し
  （`none` なら `grantFallback`）、確認できた generation を返す／
  `(app)/+layout.svelte` が世代の変化で再 load してページを作り直す（配線①）／
  `#lib/session.svelte.ts` の `sessionStore` は `controller.snapshot` からの `$derived`／
  ログアウトは `logout()` の後に `resolveSettled()` で確定する（`#lib/banto/logout.svelte.ts`）。
  自前の `AuthProvider` は `resolve()`・`credentialRevision()`・`onCredentialChanged()` を
  実装する（`resolve()` は取得できないときに reject する — `provider.ts` の契約）。
  これを外すと、一覧状態は保存も復元もされないか（所有者が確定しない）、
  セッションが変わっても前の画面が残る（作り直しなし）。

セッション管理の設計は [session-controller-design.md](../design/session-controller-design.md) §6.1。

## 楽観ロック（任意、Issue #638）

2 人が同じレコードを開いて保存したとき、後の保存が先の変更を黙って消さない
ようにするには、items の版（`version`）の仕組みを真似る（手本は
`apps/admin-template/core/src/items.rs` の `check_version`・`VERSION_BUMP`）。

1. migration を新しい連番で足す（SQLite は `version INTEGER NOT NULL DEFAULT 1`、
   PostgreSQL は `BIGINT`。手本は `0011_items_version.sql`）。行の型と全 SELECT・
   RETURNING に `version` を足す。
2. 入力の型に `#[serde(default)] version: Option<i64>` を足す。更新は今の
   トランザクションの中で先に読み（SQLite は `BEGIN IMMEDIATE`、PostgreSQL は
   `FOR UPDATE`）、`Some` で値が違えば `BantoError::Conflict { message, current }`
   （`current` は今のレコード）を返す。同じか `None` なら書き、`version` を +1 する。
   削除も `version` を受けるときは同じように先に読んで比べる。
3. REST（更新は本文、削除は `?version=`）と Tauri（コマンドの任意の引数）の
   両方で同じ判定にする（conventions §1）。衝突した操作は監査に残さない。
4. 監査の差分（`*_update_detail`）の除外に `version` を足す。フォームの項目
   （`schema`）には入れない（一覧・詳細に出さない）。
5. フロントは `update` の `values` に読んだ `version` を入れ、削除は
   `deleteOne(resource, id, { version })`。衝突は `ProviderError` の
   `body.kind === 'conflict'`（`body.current` が相手の最新値）で分かる。

`version` を送らなければ従来どおり上書きになる。

**テンプレートの汎用画面は、行に数値の `version` があれば自動で配線される**
（`lib/resource/`。新しいリソースは手順 1〜4 だけで足りる）:

- **詳細フォーム**（`ResourceDetail`）: 読み込んだレコードの `version` を保存・
  削除で送る。保存に成功したら返ってきた新しい `version` を次の保存の基準にする。
  保存が衝突したら差分のダイアログ（`ConflictDialog`）を出し、相手が変えた欄の
  「相手の値／あなたの値」を並べて「相手の値を採る」（フォームを相手の値にして
  閉じる。相手が変えていない欄の入力は残し、保存はしない）・「自分の値で上書き」・
  「項目ごとに選ぶ」（欄ごとのラジオ）から選ぶ。上書きと項目ごとの保存は相手の
  `version` で送り直すので、その間にまた変わればもう一度ダイアログが出る。
  キャンセルは入力を残して閉じる。相手が変えた欄が画面の欄に無ければ（`version`
  だけが進んだなど）、確認せずに相手の `version` で送り直す。削除が衝突したら
  「他の人が変更したため削除しませんでした」と知らせてフォームを相手の値にする。
- **一覧のセル編集・範囲貼り付け**（`ResourceListPage`）: その行の `version` を
  送る（`composeEditableValues`。readonly の欄は従来どおり送らない）。送る版は
  編集を開いた時点（貼り付けは貼り付けた時点）の行のもので、編集中に SSE の
  再取得で他人の新しい版が画面に届いても、その版では送らない（`CellEdit.baseRow`、
  `rowSaveQueue` の `lock`）。自分の保存の成功で進んだ版だけを追うので、同じ行の
  保存は直列で、2 回目は 1 回目が返した `version` で送る。衝突した行は相手の
  最新値に戻して「他の人が変更したため保存しませんでした」と知らせ（貼り付けは
  件数を 1 回）、入力は入れ直してもらう。同じ行の待っていた保存は送らない。
- **一覧の一括削除**（`ResourceListPage`、#713）: 次の 3 つがそろう一覧にだけ、先頭の
  チェックボックスと一括操作バーの「N件を削除」が出る（`bulkDeleteOffered`）。
  リソース定義の `bulkDelete: true`、provider の `deleteMany`、削除の権限
  （詳細画面の削除ボタンと同じ `resourcePermissions` の `delete`）。そろわない一覧には
  チェックボックスもバーも出ない。確認（件数入り）のあと、**`deleteMany` を 1 回だけ**
  呼ぶ（全件成功か全件失敗か。下の「一括削除」の API）。
  - 送る `version` は**行を選んだ時点**のもの（`updateVersionCapture`）。server モードでは
    選んだ行が読み込みの窓から外れるので、削除を押した時点では引けない。自分のセル編集で
    進んだ版だけは追う。版を控えられなかった行があれば、送らずに知らせる。
  - server モードの「該当する全件を選択」（`selectAllMatching`）では、確認の前に
    一覧の条件（グリッドの絞り込み・並び・画面の検索語）で `getList` をページングし、
    該当する行の id と `version` を集めて、その id で消す（`collectMatchingItems`）。
    確認に出す件数は集めた件数。1,000 件を超えるときは確認を出さずに知らせる。
  - 確認の前にセッションを控え、送る直前に比べる（`captureSendGuard`）。ログアウトや
    別のアカウントのログインで替わっていれば送らない。
  - 衝突（`conflict`）は何も消えず、選択を残して再読み込みを促す。判断は
    `lib/resource/bulkDelete.ts` の純関数（流れ全体は `runBulkDelete`）。
- 差分の計算・送り直す値の組み立ては純関数（`lib/resource/conflict.ts`）。
  `createFormResource(…, { handlesConflict: true })` にすると、衝突はトーストせず
  `submit()` の結果の `conflict`（`remove()` は `lastError`）で返る。

## 一括削除（任意、Issue #713）

一覧で選んだ行を、id と `version` で 1 回に消す API。手本は items
（`ItemsService::bulk_delete`・`rest/items.rs` の `items_bulk_delete`・
`src-tauri/src/lib.rs` の `items_bulk_delete_body`）。

1. サービス層に `bulk_delete(&BulkDeleteTarget) -> Vec<id>`（消した id）を足す。
   **1 つのトランザクションで全件成功か全件失敗**にする（SQLite は
   `BEGIN IMMEDIATE`、PostgreSQL は `FOR UPDATE`）。
   - 先に全行を読み、1 件でも無い・`version` が違えば
     `BantoError::Conflict` を返して何も消さない（`version` の無い要素は
     1 件の削除と同じく比べない。フロントは必ず `version` を送る）。
   - 上限は定数にする（items は `MAX_BULK_DELETE_ROWS` = **1,000 件**。id の件数に
     掛かる）。超過・0 件・id の重複は
     `BantoError::BadRequest`（0 件は呼び出し側の不具合として扱い、0 を返さない）。
2. REST は `POST /api/<resource>/bulk-delete`（本文が target、答えは
   `{ deleted }`）、Tauri は `<resource>_bulk_delete`（引数 `target`）。どちらも
   1 件の削除と同じロール床にし、`scripts/verify-architecture.mjs` の
   `DUAL_PATH` に対を足す（conventions §1）。
3. 監査は **1 回につき 1 行**（`action: "bulk_delete"`、`entity_id` なし）。
   detail は `item_bulk_delete_detail` の形にそろえる: `mode`（`ids`）・
   `count`・`ids`（先頭 100 件。超えたら `idsTruncated: true`）。行の値は残さない（`changes` は使わない）。衝突した
   操作は監査しない（1 件の削除と同じ）。denied は `RoleGuard` / `require_role` が残す。
4. 変更の通知（`resource_changed`）は 1 回だけ出す。添付を持つリソースは、消した
   id の分を掃除する（`attachment_wiring::sweep_items_attachments`）。
5. フロントは `DataProvider.deleteMany?.(resource, target)`。**省略可能な
   メソッド**なので、`provider.deleteMany` が無ければ一括削除を出さない。
   http の provider は `POST /api/{resource}/bulk-delete`、
   tauri の provider は `${resource}_bulk_delete` を呼ぶので、手順 2 の名前を守れば
   provider の変更は要らない。衝突は `ProviderError` の `body.kind === 'conflict'`。
   - **HTTP と Tauri の provider は、どのリソースにも `deleteMany` を返す**（リソース名から
     URL・コマンド名を作るだけ）。メソッドがあっても、そのリソースの対応は保証しない。
     手順 1〜4 を済ませたリソースだけ、リソース定義（`lib/banto/resources/<name>.ts`）に
     **`bulkDelete: true`** を書いて明示する（items だけが true）。書かないリソースの一覧には
     チェックボックスも一括操作バーも出ない。
   - InMemory の provider（デモ・テスト）も `deleteMany` を持つ（同じ契約: id だけ・
     全件成功か全件失敗か・`version` の照合・上限 1,000 件）。
6. テストは両経路に: viewer の denied（403 `forbidden` + `denied` の監査行）、
   成功（監査 1 行）、`version` の衝突で何も消えない、上限の超過。
7. 絞り込んだ全件を消すときは、利用側が一覧の API（`getList`）で id と `version`
   を取ってから、id で消す（確かめた行だけが消え、変わっていれば衝突）。絞り込みの
   条件と件数だけで消す方式は、確認の後に行が入れ替わっても件数が同じなら通って
   しまうので、持たない。

## 検証

```bash
pnpm check     # フロント lint/型
cargo test     # サービス層 + REST のテスト（:memory: SQLite）
pnpm e2e       # スモーク（banto-serve 起動、E2E を足した場合）
```

`src-tauri` はサンドボックス環境ではコンパイルできないことがある
（AGENTS.md）。その場合、ステップ4はコードレビュー + 週次の Tauri CI
（improvement-plan P3-2）で担保し、完了報告に「未実行の検証」として明記
する（AGENTS.md「Definition of Done」）。

## やってはいけないこと（conventions.md の該当節）

- 片方の経路（REST or Tauri）だけにコマンドを足す（§1）
- サービス層に axum/tauri/RBAC を持ち込む（§2）
- フロント由来のフィールド名を `ColumnMap` を通さず SQL に使う（§6）
- 監査 detail にパスワード・トークンを入れる（§6）
- コンポーネント CSS に生の色値を書く（§9）

## items を削除する場合

自リソースへの差し替えが済んだら、上表の「手本」列のファイル一式が
削除対象になる（逆向きに辿ればよい）。`attachments` の items デモ配線を
使っている場合は [remove-optional-assets.md](remove-optional-assets.md) の添付の手順が先。
