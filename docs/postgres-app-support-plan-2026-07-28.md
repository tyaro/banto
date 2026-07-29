# V2 テーマA — PostgreSQL アプリ全体対応 着手プラン（2026-07-28）

対象: [v2-kickoff-2026-07-28.md](v2-kickoff-2026-07-28.md) §2-A の実装計画。
一次情報（背景）は [improvement-plan-2026-07.md](improvement-plan-2026-07.md) P4-5 /
[ui-framework-spec.md](ui-framework-spec.md) §12.1 / [roadmap.md](roadmap.md) §3。
本書は「どう実装するか」の設計・PR 分割・不変条件チェックを確定する作業計画。

> このブランチ（eval ＝計画ハブ）にのみ置く。コード変更は main から独立ブランチ
> （`claude/<slug>`）を切って PR し、オーナー承認を待つ（セルフマージ不可）。

> **✅ 完了（2026-07-29）**: PR1〜PR4 すべて main にマージ済み。
> PR1=#106（storage 基盤 Db/Dialect）/ PR2=#107（app 層 型置換+方言吸収）/
> PR3=#108（マイグレーション方言分岐+init_db_from_target の Postgres 経路+CI app-postgres
> スモーク）/ PR4=#109（backup を SQLite 専用化・Postgres は明示エラー）。
> app 層が SQLite/PostgreSQL 両対応（既定 SQLite 維持・全 PR byte 等価）。
> Postgres 有効化は `BANTO_DB=postgres://…`（`init_db_from_target`）＋ビルド feature `postgres`。
> 副産物: PR2 の未 exercise だった Postgres arm の 2 バグ（`CURRENT_DATE::text` /
> `ts::timestamptz`）と、scaffold の `pool`→`db` 追随漏れ 3 件を PR3 で発見・修正。

---

## 0. 現在地（#93 到達点）

- `banto-storage` は **Postgres 接続可**（`postgres::connect` / プール / feature
  `postgres`）。`list_query` は macro monomorphic 生成で **両バックエンド対応済み**
  （`impl_list_query!(sqlite, …)` / `impl_list_query!(postgres, …)`）。CI の
  `storage-postgres` ジョブが実 `postgres:16` で検証。
- **app 層（`apps/admin-template/core`）は全面 SQLite 密結合**。6 サービス
  （items/users/settings/audit/backup/assets）＋ `banto-attachments` クレートが
  `SqlitePool` / `sqlx::Sqlite` を具体型で直持ち。trait 抽象なし。
- 手書き raw SQL に SQLite 方言（`?` プレースホルダ / `date('now')` /
  `datetime('now')` / `ON CONFLICT` / `AUTOINCREMENT`）。`QueryBuilder`（list 2 箇所）
  は `push_bind` が方言吸収するので低コスト。
- マイグレーションは `sqlx::migrate!("./migrations")` 単一ディレクトリ + SQLite 専用
  DDL。backup は `VACUUM INTO` + 起動時ファイル差し替えで **Postgres 非互換**。

---

## 1. 確定した設計判断（2026-07-28 オーナー承認）

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| D1 | バックエンド抽象 | **enum ディスパッチ** `enum Db { Sqlite(SqlitePool), Postgres(PgPool) }` | 方言分岐が明示的・sqlx の trait 境界と戦わない（`list_query.rs:15-22` の前例回避）・既定 SQLite 経路を無改変で保てる |
| D2 | マイグレーション | **方言別ディレクトリ** `migrations-sqlite/` / `migrations-postgres/` を feature で切替 | 既存 SQLite スキーマを byte 無改変で後方互換維持。Postgres は厳密型で新規作成。attachments の DDL 二重管理点もここで解消 |
| D3 | backup | **SQLite 専用機能として維持** | `VACUUM INTO` + 起動時ファイル差し替えは Postgres に概念が無い。Postgres モードでは backup 経路を無効化。pg_dump 相当の論理バックアップは V2 別枠（ADR-0002 依存最小化と衝突するため） |

---

## 2. PR 分割

いずれも **既定 SQLite 経路を無改変で通す後方互換が受け入れ条件**
（roadmap.md「既定は SQLite 維持」）。各 PR は独立ブランチ + CI 緑 + オーナー承認。

### PR1 — storage 基盤（enum 抽象の導入）
- `banto-storage` に `enum Db`（D1）と、方言吸収ヘルパ（プレースホルダ番号付け /
  日付関数 / upsert）を導入。既定 SQLite 経路は挙動不変。
- app 層はまだ触らない。storage 単体テスト（sqlite / postgres 両 feature）で検証。
- 受け入れ: `cargo test -p banto-storage`（両 feature）緑・既存 API 後方互換。

### PR2 — app 層の型置換 + 方言吸収
- 6 サービス + `banto-attachments` の `SqlitePool` / `Sqlite` を `Db` 抽象へ置換。
- 手書き raw SQL を方言吸収経由に（`?`→`$N` / `date('now')`→バックエンド別）。
  `QueryBuilder`（list 2 箇所）は `push_bind` 継続。INSERT RETURNING は両対応で流用。
- 既定 SQLite で `cargo test` / `pnpm e2e` 全緑（挙動不変）。
- 受け入れ: 既定 SQLite で全テスト緑・rule 1（サービス層非依存）維持。

### PR3 — マイグレーション方言分岐 + Postgres 起動経路
- `migrations-sqlite/`（既存を byte 移動）/ `migrations-postgres/`（新規・厳密型）。
- `db::init_db` に Postgres 分岐 + seed の Postgres 対応。
- CI に app 層 Postgres スモークジョブを追加（`postgres:16` サービス）。
- 受け入れ: SQLite 経路無改変・Postgres 経路で seed + 主要 CRUD が緑。

### PR4 — backup のバックエンド条件分岐（D3）
- backup を SQLite 専用に限定。Postgres モードでは無効化（明示エラー or 非露出）。
- `scripts/verify-architecture.mjs` rule 8 の DUAL_PATH マニフェストを backend
  条件付きに更新（Postgres で backup 経路が非対称にならないよう整合）。
- 受け入れ: rule 8 緑・backup は SQLite モードで従来通り。

---

## 3. 不変条件チェック（各 PR 共通）

- **REST/Tauri 両経路対称**（rule 8 / `verify:architecture`）: mutating 経路を
  片側だけに足さない。PR4 で backup マニフェストを条件付き更新する以外は不変。
- **サービス層非依存**（rule 1）: `use axum`/`use tauri` 禁止は不変。enum 抽象は
  サービス層内で完結し REST/Tauri 層に漏らさない。
- **依存を足さない**（ADR-0002）: 新規 crate 追加なし（sqlx の既存 feature のみ）。
  D3 で pg_dump 系を退けたのはこの不変条件が理由。
- **既定 SQLite 維持**: 全 PR の受け入れ条件。

---

## 4. 検証（サンドボックスで可能な範囲）

```bash
pnpm check
cargo test                                   # 既定 = SQLite
cargo test -p banto-storage --no-default-features --features postgres
pnpm e2e
cargo audit
```

- `src-tauri` はサンドボックスでコンパイル不可 → `tauri-check.yml` + コードレビューで担保。
- app 層 Postgres 検証は CI サービスコンテナ（PR3 で追加）に依存。
