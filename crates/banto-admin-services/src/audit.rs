//! Audit trail service (spec M14, `docs/roadmap.md`): who did what, when,
//! over which transport, and whether it was allowed. Backed by the
//! `audit_log` table (migration `0005_audit_log.sql`), same service-layer
//! pattern as `admin_template_core::items::ItemsService` - testable in a
//! plain `cargo test`, no `tauri`/`axum` dependency.
//!
//! Moved from `admin-template-core::audit` to this crate in theme C PR-C1
//! (docs/template-scope.md §7 移行順 ①): the logic is domain-agnostic, so it
//! belongs in the shared crate rather than in code every adopter copies.
//!
//! **This service does not know about actors, RBAC, or HTTP** - it only
//! knows how to store/list/prune rows. Every REST handler and Tauri command
//! that mutates state (or gets rejected by an RBAC guard) is responsible for
//! building an [`AuditEntry`] itself and calling
//! [`AuditLogService::record`] - see `admin_template_core::rest`'s and
//! `src-tauri`'s `require_role`/`require_role_at_least` call sites for where
//! the actor (`Identity`) and the REST/Tauri "origin" are known.
//!
//! SECURITY: [`AuditEntry::detail`] is a JSON **summary** (spec: "値の全量は
//! 入れない") - changed field NAMES, a new role, a method+path, etc. Nothing
//! that calls into this module may ever put a password, password hash, or
//! bearer token into `detail`. There is no runtime guard against this (the
//! type is a free-form `serde_json::Value`) - it is enforced by review at
//! every call site instead.

use banto_core::{BantoError, ListParams, ListResult};
use banto_storage::{ColumnMap, Db};
use serde::Serialize;
use sqlx::{QueryBuilder, Sqlite};

/// One row of the `audit_log` table, wire-shaped for the audit-log viewer
/// (spec M14's admin-only grid). `detail` is the raw JSON-encoded summary
/// string as stored (not re-parsed into a `Value`) - the frontend grid can
/// `JSON.parse` it on demand for display, mirroring how `detail` is written
/// (see [`AuditLogService::try_record`]).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: i64,
    pub ts: String,
    pub actor_username: Option<String>,
    pub actor_role: Option<String>,
    pub action: String,
    pub resource: String,
    pub entity_id: Option<String>,
    pub detail: Option<String>,
    pub origin: String,
    pub result: String,
}

/// One page of the audit-log viewer's read with its snapshot boundary
/// (Issue #248, [`AuditLogService::list_as_of`]). `rows`/`totalCount` are
/// spelled exactly like `banto_core::ListResult` (which lives in
/// `banto-core` and cannot grow a field), plus the boundary this answer
/// used, `asOfId` - a client that reads only `rows`/`totalCount` keeps
/// working unchanged.
///
/// Both `rows` and `total_count` are taken from the rows with
/// `id <= as_of_id`. On an empty table `as_of_id` is `0` (ids start at 1, so
/// it is a boundary containing no row), never `null`.
///
/// `deletion_epoch` (`deletionEpoch`, Issue #248 review) is the retention
/// prune's counter ([`DELETION_EPOCH_KEY`]) read in the same transaction:
/// it advances with every prune that deleted rows, in the prune's own
/// transaction. A viewer compares it (and the count) with its generation's
/// first answer - see [`AuditLogService::list_as_of`] for why the count
/// alone is not enough.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogList {
    pub rows: Vec<AuditLogEntry>,
    pub total_count: u64,
    pub as_of_id: i64,
    pub deletion_epoch: i64,
}

/// `settings` key of the retention prune's deletion epoch (Issue #248
/// review, [`AuditLogList::deletion_epoch`]). Absent (never pruned) or not an
/// integer reads as `0`. Lives in `settings` (a Banto base table every
/// adopter has, conventions §11) so no migration is needed.
pub const DELETION_EPOCH_KEY: &str = "audit.deletion_epoch";

/// The stored epoch text as a number (`0` when absent or not an integer).
fn parse_epoch(value: Option<String>) -> i64 {
    value.and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

/// One record to write to the `audit_log` table (spec M14). Borrowed string
/// fields keep call sites cheap - this is built fresh at each call site and
/// consumed immediately by [`AuditLogService::record`]/[`AuditLogService::try_record`],
/// never stored.
///
/// See this module's doc comment for the hard rule on what `detail` may
/// carry.
#[derive(Debug, Clone)]
pub struct AuditEntry<'a> {
    /// Username snapshot of the actor, or `None` for an unauthenticated
    /// event (e.g. a login failure before any session exists).
    pub actor_username: Option<&'a str>,
    /// The actor's role AT THE TIME of the action (spec: not looked up
    /// later - a role change afterward must not rewrite history).
    pub actor_role: Option<&'a str>,
    /// e.g. `"create"`, `"update"`, `"delete"`, `"login"`, `"login_failed"`,
    /// `"logout"`, `"setup"`, `"password_reset"`, `"settings_change"`,
    /// `"denied"`.
    pub action: &'a str,
    /// e.g. `"items"`, `"users"`, `"settings"`, `"auth"`.
    pub resource: &'a str,
    pub entity_id: Option<&'a str>,
    pub detail: Option<serde_json::Value>,
    /// `"rest"` or `"tauri"`.
    pub origin: &'a str,
    /// `"ok"`, `"denied"`, or `"failed"`.
    pub result: &'a str,
}

/// Column whitelist for [`AuditLogService::list`] (spec M14, mirrors
/// `admin_template_core::items::column_map`): wire field name (camelCase, as
/// sent by the audit-log viewer) -> actual `audit_log` SQL column.
fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .column("ts", "ts")
        .column("actorUsername", "actor_username")
        .column("actorRole", "actor_role")
        .column("action", "action")
        .column("resource", "resource")
        .column("entityId", "entity_id")
        .column("detail", "detail")
        .column("origin", "origin")
        .column("result", "result")
}

/// Audit trail service (spec M14): append-only writes, a filtered/sorted/
/// paginated read (admin-only viewer), and retention-based pruning.
///
/// `Clone` is cheap (`Db` is an `Arc`-backed connection handle), matching
/// `ItemsService`/`UsersService`/`SettingsService`.
#[derive(Clone)]
pub struct AuditLogService {
    db: Db,
}

impl AuditLogService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Write one audit entry. `Result`-returning (unlike
    /// [`AuditLogService::record`]) so unit tests can assert on failure
    /// modes; every REST/Tauri call site should use `record` instead, which
    /// never fails the caller's real operation over an audit-write hiccup.
    pub async fn try_record(&self, entry: AuditEntry<'_>) -> Result<(), BantoError> {
        let detail = entry
            .detail
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|err| {
                BantoError::Other(format!("監査ログのdetailシリアライズに失敗しました: {err}"))
            })?;

        let dialect = self.db.dialect();
        // sqlx 0.9: `sqlx::query` requires `impl SqlSafeStr`, which a runtime
        // `String` does not implement directly. AssertSqlSafe is safe here
        // because the only interpolated fragment is `dialect.placeholders(8)`,
        // which is internally generated from the `Dialect` enum (never
        // caller input) - every actual value is bound below via `.bind(...)`.
        let sql = format!(
            "INSERT INTO audit_log (actor_username, actor_role, action, resource, entity_id, detail, origin, result) \
             VALUES ({})",
            dialect.placeholders(8),
        );
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(entry.actor_username)
                .bind(entry.actor_role)
                .bind(entry.action)
                .bind(entry.resource)
                .bind(entry.entity_id)
                .bind(detail)
                .bind(entry.origin)
                .bind(entry.result)
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(entry.actor_username)
                .bind(entry.actor_role)
                .bind(entry.action)
                .bind(entry.resource)
                .bind(entry.entity_id)
                .bind(detail)
                .bind(entry.origin)
                .bind(entry.result)
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;
        Ok(())
    }

    /// Fire-and-forget wrapper around [`AuditLogService::try_record`] (spec
    /// M14 design decision): a failure to WRITE an audit entry must never
    /// fail the operation being audited (e.g. an `items.create` that
    /// otherwise succeeded) - it is only logged as a warning (`eprintln`;
    /// this workspace has no `tracing` dependency, see the root
    /// `Cargo.toml`). Every REST handler and Tauri command calls this, not
    /// `try_record`, directly.
    pub async fn record(&self, entry: AuditEntry<'_>) {
        let action = entry.action.to_string();
        let resource = entry.resource.to_string();
        if let Err(err) = self.try_record(entry).await {
            eprintln!(
                "banto: 監査ログの記録に失敗しました（action={action}, resource={resource}）: {err}"
            );
        }
    }

    /// Filtered/sorted/paginated read (spec M14's admin-only viewer) with no
    /// snapshot boundary. Same result as [`AuditLogService::list_as_of`] with
    /// `as_of_id: None` minus the boundary it picked (that boundary is the
    /// newest row at the time of the read, so the result covers the whole
    /// table exactly as before Issue #248). Kept with its original return
    /// type so existing callers (and derived apps) stay unchanged.
    pub async fn list(&self, params: ListParams) -> Result<ListResult<AuditLogEntry>, BantoError> {
        let list = self.list_as_of(params, None).await?;
        Ok(ListResult {
            rows: list.rows,
            total_count: list.total_count,
        })
    }

    /// Filtered/sorted/paginated read (spec M14's admin-only viewer), same
    /// `banto_storage::list_query` pattern as
    /// `admin_template_core::items::ItemsService::list`. Deliberately called
    /// only from the admin-gated `/api/audit-log/list` route / `audit_log_list`
    /// command - this service itself has no RBAC awareness (see this
    /// module's doc comment).
    ///
    /// **`as_of_id` is a snapshot boundary** (Issue #248, spec §4.1): when
    /// given, only rows with `id <= as_of_id` are counted and listed. When
    /// omitted, the boundary is the largest `id` at the time of this read
    /// (`0` for an empty table), which covers every row - so a caller that
    /// omits it gets the same rows and count as before. The boundary used
    /// is returned in [`AuditLogList::as_of_id`]; a block-fetching viewer
    /// (`@banto/admin-core`'s `SnapshotListResource`) pins the one its first
    /// answer returned and sends it with every later block of the same
    /// generation, so rows **added** between two block requests do not
    /// shift `OFFSET`. This relies on `audit_log.id` growing monotonically
    /// and never being reused (SQLite `AUTOINCREMENT`, PostgreSQL
    /// `IDENTITY`; migration `0005_audit_log.sql`) and on audit rows never
    /// being updated.
    ///
    /// The boundary does **not** keep the set fixed by itself: retention
    /// pruning ([`AuditLogService::prune`]) removes rows inside it, and on
    /// PostgreSQL a writer that allocated a lower `id` can commit after the
    /// boundary was picked and add a row inside it (SQLite writes one at a
    /// time, so there a row below the boundary is always committed before a
    /// higher id exists). Either shifts `OFFSET`. The viewer stops reading
    /// the generation when an answer differs from the generation's first in
    /// **the count or the deletion epoch** ([`AuditLogList::deletion_epoch`]):
    /// a late commit alone raises the count, a prune alone lowers the count
    /// and advances the epoch, and a late commit plus an equally large prune
    /// (the count is unchanged) still advances the epoch. The count alone
    /// would miss that last case (a duplicated row, no expiry, Issue #248
    /// review). Rows are never deleted outside `prune` (restoring a backup
    /// replaces the whole database and restarts the app). The callers also
    /// skip the opportunistic prune for bounded reads (see the REST route /
    /// Tauri command) so a page's own reads do not expire it.
    ///
    /// **The boundary, the rows and the count come from one read
    /// transaction** together with the deletion epoch, so one answer never
    /// mixes two points in time (the comparisons above depend on it). PostgreSQL runs it as
    /// `REPEATABLE READ, READ ONLY` - its default `READ COMMITTED` would
    /// give every statement its own snapshot; a SQLite read transaction
    /// already reads one snapshot.
    ///
    /// The order is total: `column_map()` registers `id`, so
    /// `append_order_by` ends `ORDER BY` with `id` in the direction of the
    /// last sort key (Issue #243) - rows sharing a `ts` second keep one
    /// order across blocks.
    pub async fn list_as_of(
        &self,
        params: ListParams,
        as_of_id: Option<i64>,
    ) -> Result<AuditLogList, BantoError> {
        let columns = column_map();
        // The bounded set is wrapped as a subquery aliased `audit_log`, so the
        // column whitelist (`column_map`) and `apply_list_params` apply to it
        // unchanged (`append_where` writes its own ` WHERE `, so the bound
        // cannot simply be appended to the outer query).
        const SELECT_ROWS: &str =
            "SELECT id, ts, actor_username, actor_role, action, resource, entity_id, detail, origin, result \
             FROM (SELECT * FROM audit_log WHERE id <= ";
        const SELECT_COUNT: &str = "SELECT COUNT(*) FROM (SELECT * FROM audit_log WHERE id <= ";
        const BOUNDED_ALIAS: &str = ") AS audit_log";
        const SELECT_MAX_ID: &str = "SELECT MAX(id) FROM audit_log";
        // The key literal here and in `prune` is [`DELETION_EPOCH_KEY`]
        // (`deletion_epoch_uses_the_documented_settings_key` pins it).
        const SELECT_EPOCH: &str = "SELECT value FROM settings WHERE key = 'audit.deletion_epoch'";

        // Per-backend `QueryBuilder`/`list_query` dispatch, same shape as
        // `admin_template_core::items::ItemsService::list` (see that method's
        // comment).
        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let as_of_id = match as_of_id {
                    Some(id) => id,
                    None => sqlx::query_scalar::<_, Option<i64>>(SELECT_MAX_ID)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .unwrap_or(0),
                };

                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_ROWS);
                rows_builder.push_bind(as_of_id);
                rows_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<AuditLogEntry> = rows_builder
                    .build_query_as::<AuditLogEntry>()
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_COUNT);
                count_builder.push_bind(as_of_id);
                count_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::sqlite::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let deletion_epoch = parse_epoch(
                    sqlx::query_scalar::<_, String>(SELECT_EPOCH)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?,
                );

                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(AuditLogList {
                    rows,
                    total_count: total_count as u64,
                    as_of_id,
                    deletion_epoch,
                })
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                // Must be the transaction's first statement (PostgreSQL rejects
                // it after a query has run).
                sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let as_of_id = match as_of_id {
                    Some(id) => id,
                    None => sqlx::query_scalar::<_, Option<i64>>(SELECT_MAX_ID)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .unwrap_or(0),
                };

                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(SELECT_ROWS);
                rows_builder.push_bind(as_of_id);
                rows_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<AuditLogEntry> = rows_builder
                    .build_query_as::<AuditLogEntry>()
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<sqlx::Postgres> =
                    QueryBuilder::new(SELECT_COUNT);
                count_builder.push_bind(as_of_id);
                count_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::postgres::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let deletion_epoch = parse_epoch(
                    sqlx::query_scalar::<_, String>(SELECT_EPOCH)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?,
                );

                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(AuditLogList {
                    rows,
                    total_count: total_count as u64,
                    as_of_id,
                    deletion_epoch,
                })
            }
        }
    }

    /// Retention-based pruning (spec M14): delete rows older than
    /// `retention_days` (if `Some`), then - separately - delete the oldest
    /// rows beyond `retention_rows` (if `Some`), oldest-first by `id`
    /// (`AUTOINCREMENT` guarantees `id` order matches insertion order,
    /// which is a more reliable "oldest" tiebreak than `ts` alone since
    /// several rows can share the same second). `None` means unlimited for
    /// that dimension (spec: "0以下は「無制限」として None 扱い" - callers
    /// normalize at the settings layer, see
    /// `crate::settings::SettingsService::audit_config`; this method also
    /// treats a non-positive value defensively as "skip this dimension").
    ///
    /// Called opportunistically (spec: "サーバ/アプリ起動時に1回 + list実行時に
    /// 軽く") rather than from a dedicated background task - see the REST/
    /// Tauri call sites' comments for why that is sufficient here.
    ///
    /// **The deletions and the deletion epoch move together** (Issue #248
    /// review): both deletes run in one transaction that, when it deleted
    /// anything, also advances [`DELETION_EPOCH_KEY`] in `settings`. A
    /// reader's snapshot therefore sees either the rows and the old epoch or
    /// neither and the new one - the invariant [`AuditLogList::deletion_epoch`]
    /// relies on. The row-cap delete computes its excess inside the `DELETE`
    /// (no read-then-write gap between counting and deleting).
    ///
    /// Returns the total number of rows deleted.
    pub async fn prune(
        &self,
        retention_days: Option<i64>,
        retention_rows: Option<i64>,
    ) -> Result<u64, BantoError> {
        let days = retention_days.filter(|d| *d > 0);
        let max_rows = retention_rows.filter(|r| *r > 0);
        if days.is_none() && max_rows.is_none() {
            return Ok(0);
        }

        // The "N days ago" interval arithmetic is the largest dialect gap in
        // this crate: SQLite's `datetime('now', '-N days')` modifier has no
        // Postgres analogue, so each backend gets its own hand-written SQL.
        // The SQLite string is byte-identical to the pre-V2 query. Postgres
        // casts the TEXT `ts` to `timestamptz` (it has no `text <
        // timestamptz` operator; the stored `now()::text` values round-trip)
        // and binds `days` as `int8` while `make_interval` wants `int4`.
        const SQLITE_DAYS: &str =
            "DELETE FROM audit_log WHERE ts < datetime('now', '-' || ? || ' days')";
        // Oldest-first-by-`id` delete of everything beyond the cap; the excess
        // is computed in the same statement.
        const SQLITE_ROWS: &str = "DELETE FROM audit_log WHERE id IN \
             (SELECT id FROM audit_log ORDER BY id ASC \
              LIMIT max(0, (SELECT COUNT(*) FROM audit_log) - ?))";
        // `CAST('garbage' AS INTEGER)` is 0 in SQLite, so a hand-edited value
        // restarts from 1 instead of failing the prune.
        const SQLITE_BUMP: &str = "INSERT INTO settings (key, value) VALUES ('audit.deletion_epoch', '1') \
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)";

        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let mut deleted: u64 = 0;
                if let Some(days) = days {
                    deleted += sqlx::query(SQLITE_DAYS)
                        .bind(days)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if let Some(max_rows) = max_rows {
                    deleted += sqlx::query(SQLITE_ROWS)
                        .bind(max_rows)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if deleted > 0 {
                    sqlx::query(SQLITE_BUMP)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(deleted)
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                const PG_DAYS: &str = "DELETE FROM audit_log WHERE ts::timestamptz < NOW() - make_interval(days => $1::int)";
                const PG_ROWS: &str = "DELETE FROM audit_log WHERE id IN \
                     (SELECT id FROM audit_log ORDER BY id ASC \
                      LIMIT GREATEST(0, (SELECT COUNT(*) FROM audit_log) - $1))";
                // `ON CONFLICT DO UPDATE` locks the row, so two concurrent
                // prunes each advance the epoch. A value that is not an integer
                // (hand-edited) restarts from 1 instead of failing the prune.
                const PG_BUMP: &str = "INSERT INTO settings (key, value) VALUES ('audit.deletion_epoch', '1') \
                     ON CONFLICT (key) DO UPDATE SET value = ((CASE WHEN settings.value ~ '^-?[0-9]{1,18}$' \
                     THEN settings.value::bigint ELSE 0 END) + 1)::text";
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let mut deleted: u64 = 0;
                if let Some(days) = days {
                    deleted += sqlx::query(PG_DAYS)
                        .bind(days)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if let Some(max_rows) = max_rows {
                    deleted += sqlx::query(PG_ROWS)
                        .bind(max_rows)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if deleted > 0 {
                    sqlx::query(PG_BUMP)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(deleted)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_core::{FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;

    /// An in-memory SQLite handle with the `audit_log` table + indexes
    /// created inline. This crate owns no migrations (conventions §11: table
    /// definitions belong to the app); the DDL below MUST be kept in sync
    /// with `apps/admin-template/core/migrations-sqlite/0005_audit_log.sql`.
    /// Same pattern `banto-attachments` uses to avoid a backwards dependency
    /// on the app crate's `db::migrate_memory` (conventions §"逆依存禁止").
    async fn service() -> AuditLogService {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        let pool = db
            .as_sqlite()
            .expect("service tests run on a SQLite handle");
        sqlx::query(
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                actor_username TEXT,
                actor_role TEXT,
                action TEXT NOT NULL,
                resource TEXT NOT NULL,
                entity_id TEXT,
                detail TEXT,
                origin TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT 'ok'
            )",
        )
        .execute(pool)
        .await
        .expect("create audit_log table");
        // `prune`/`list_as_of` keep the deletion epoch in `settings`
        // (Issue #248 review); MUST match `0002_settings.sql`.
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(pool)
            .await
            .expect("create settings table");
        sqlx::query("CREATE INDEX idx_audit_log_ts ON audit_log(ts)")
            .execute(pool)
            .await
            .expect("create ts index");
        sqlx::query("CREATE INDEX idx_audit_log_actor ON audit_log(actor_username)")
            .execute(pool)
            .await
            .expect("create actor index");
        sqlx::query("CREATE INDEX idx_audit_log_resource ON audit_log(resource, entity_id)")
            .execute(pool)
            .await
            .expect("create resource index");
        AuditLogService::new(db)
    }

    fn sample_entry<'a>(action: &'a str, resource: &'a str, actor: &'a str) -> AuditEntry<'a> {
        AuditEntry {
            actor_username: Some(actor),
            actor_role: Some("admin"),
            action,
            resource,
            entity_id: Some("1"),
            detail: Some(json!({ "name": "Widget" })),
            origin: "rest",
            result: "ok",
        }
    }

    #[tokio::test]
    async fn record_then_list_round_trips() {
        let svc = service().await;
        svc.try_record(sample_entry("create", "items", "admin"))
            .await
            .expect("try_record should succeed");

        let result = svc
            .list(ListParams::default())
            .await
            .expect("list should succeed");
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows.len(), 1);
        let row = &result.rows[0];
        assert_eq!(row.actor_username.as_deref(), Some("admin"));
        assert_eq!(row.actor_role.as_deref(), Some("admin"));
        assert_eq!(row.action, "create");
        assert_eq!(row.resource, "items");
        assert_eq!(row.entity_id.as_deref(), Some("1"));
        assert_eq!(row.origin, "rest");
        assert_eq!(row.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(row.detail.as_deref().expect("detail should be set")).unwrap();
        assert_eq!(detail, json!({ "name": "Widget" }));
        assert!(!row.ts.is_empty());
    }

    #[tokio::test]
    async fn record_with_no_actor_stores_null_actor_columns() {
        let svc = service().await;
        svc.try_record(AuditEntry {
            actor_username: None,
            actor_role: None,
            action: "login_failed",
            resource: "auth",
            entity_id: None,
            detail: None,
            origin: "rest",
            result: "failed",
        })
        .await
        .expect("try_record should succeed");

        let result = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(result.rows[0].actor_username, None);
        assert_eq!(result.rows[0].actor_role, None);
        assert_eq!(result.rows[0].detail, None);
    }

    /// `record` (the fire-and-forget entry point every REST/Tauri call site
    /// actually uses) must not panic and must still persist a valid entry -
    /// this is the "happy path" proof that it delegates to `try_record`
    /// correctly, since its failure-swallowing behavior itself can't be
    /// observed without a broken pool (not exercised here).
    #[tokio::test]
    async fn record_persists_like_try_record() {
        let svc = service().await;
        svc.record(sample_entry("delete", "users", "owner")).await;
        let result = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].action, "delete");
    }

    #[tokio::test]
    async fn list_filters_by_resource_and_action() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "admin")).await;
        svc.record(sample_entry("create", "users", "admin")).await;
        svc.record(sample_entry("delete", "items", "admin")).await;

        let result = svc
            .list(ListParams {
                filters: vec![
                    FilterState {
                        field: "resource".to_string(),
                        op: FilterOp::Eq,
                        value: json!("items"),
                    },
                    FilterState {
                        field: "action".to_string(),
                        op: FilterOp::Eq,
                        value: json!("create"),
                    },
                ],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].resource, "items");
        assert_eq!(result.rows[0].action, "create");
    }

    #[tokio::test]
    async fn list_filters_by_actor_username() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "bob")).await;

        let result = svc
            .list(ListParams {
                filters: vec![FilterState {
                    field: "actorUsername".to_string(),
                    op: FilterOp::Eq,
                    value: json!("bob"),
                }],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].actor_username.as_deref(), Some("bob"));
    }

    #[tokio::test]
    async fn list_sorts_and_paginates() {
        let svc = service().await;
        for action in ["a", "b", "c"] {
            svc.record(sample_entry(action, "items", "admin")).await;
        }

        let result = svc
            .list(ListParams {
                sort: vec![SortState {
                    field: "id".to_string(),
                    direction: SortDirection::Desc,
                }],
                pagination: Some(Pagination {
                    offset: 0,
                    limit: 1,
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 3);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].action, "c"); // most recently inserted first
    }

    // --- prune (spec M14) ---------------------------------------------------

    async fn seed_n(svc: &AuditLogService, n: usize) {
        for i in 0..n {
            svc.record(sample_entry("create", "items", "admin")).await;
            let _ = i;
        }
    }

    #[tokio::test]
    async fn prune_with_both_none_is_a_no_op() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let deleted = svc.prune(None, None).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            5
        );
    }

    #[tokio::test]
    async fn prune_by_row_count_keeps_the_newest_rows() {
        let svc = service().await;
        seed_n(&svc, 5).await;

        let deleted = svc.prune(None, Some(2)).await.unwrap();
        assert_eq!(deleted, 3);

        let remaining = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(remaining.total_count, 2);
        // The two highest ids (most recently inserted) must survive.
        let mut ids: Vec<i64> = remaining.rows.iter().map(|r| r.id).collect();
        ids.sort();
        assert_eq!(ids, vec![4, 5]);
    }

    #[tokio::test]
    async fn prune_by_row_count_is_a_no_op_when_under_the_limit() {
        let svc = service().await;
        seed_n(&svc, 3).await;
        let deleted = svc.prune(None, Some(100)).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            3
        );
    }

    #[tokio::test]
    async fn prune_by_days_deletes_rows_older_than_the_cutoff() {
        let svc = service().await;
        seed_n(&svc, 2).await;
        // Directly backdate one row's `ts` past a 1-day retention window -
        // there is no clock injection in this service (unlike
        // `banto_server::auth`'s `AuthState`), so this is the simplest way
        // to exercise the days branch deterministically.
        sqlx::query("UPDATE audit_log SET ts = datetime('now', '-10 days') WHERE id = 1")
            .execute(
                svc.db
                    .as_sqlite()
                    .expect("service tests run on a SQLite handle"),
            )
            .await
            .unwrap();

        let deleted = svc.prune(Some(1), None).await.unwrap();
        assert_eq!(deleted, 1);
        let remaining = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(remaining.total_count, 1);
        assert_eq!(remaining.rows[0].id, 2);
    }

    #[tokio::test]
    async fn prune_treats_non_positive_values_as_unlimited() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let deleted = svc.prune(Some(0), Some(-1)).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            5
        );
    }

    // --- list_as_of: snapshot boundary (Issue #248) ----------------------------

    fn page(offset: u64, limit: u64, sort: Vec<SortState>) -> ListParams {
        ListParams {
            pagination: Some(Pagination { offset, limit }),
            sort,
            ..Default::default()
        }
    }

    fn ts_desc() -> Vec<SortState> {
        vec![SortState {
            field: "ts".to_string(),
            direction: SortDirection::Desc,
        }]
    }

    fn ids(list: &AuditLogList) -> Vec<i64> {
        list.rows.iter().map(|r| r.id).collect()
    }

    /// Rows written between two block reads do not enter a pinned
    /// generation: the second block continues the first one's set exactly
    /// (no duplicate at the block edge), and its count is the first one's.
    /// A new unbounded read (the viewer's "reload") sees the new rows.
    #[tokio::test]
    async fn list_as_of_pins_the_set_across_blocks() {
        let svc = service().await;
        seed_n(&svc, 5).await;

        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(first.as_of_id, 5, "an omitted boundary is the newest id");
        assert_eq!(first.total_count, 5);
        assert_eq!(ids(&first), vec![5, 4]);

        // Two entries recorded between the blocks.
        seed_n(&svc, 2).await;

        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        let third = svc
            .list_as_of(page(4, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(second.as_of_id, 5, "the given boundary is echoed back");
        assert_eq!(second.total_count, 5, "the pinned set's count is unchanged");
        assert_eq!(ids(&second), vec![3, 2]);
        assert_eq!(ids(&third), vec![1]);

        let fresh = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(fresh.as_of_id, 7);
        assert_eq!(fresh.total_count, 7);
        assert_eq!(ids(&fresh), vec![7, 6]);
    }

    /// Without the boundary the same interleaving duplicates a row at the
    /// block edge - the failure `asOfId` exists to prevent (the "before"
    /// half of the test above).
    #[tokio::test]
    async fn unbounded_blocks_shift_when_rows_are_added_between_them() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let first = svc.list(page(0, 2, ts_desc())).await.unwrap();
        seed_n(&svc, 2).await;
        let second = svc.list(page(2, 2, ts_desc())).await.unwrap();
        let first_ids: Vec<i64> = first.rows.iter().map(|r| r.id).collect();
        let second_ids: Vec<i64> = second.rows.iter().map(|r| r.id).collect();
        assert_eq!(first_ids, vec![5, 4]);
        assert_eq!(second_ids, vec![5, 4], "the edge rows come back again");
    }

    /// Omitting `as_of_id` keeps `list`'s old result: every row, the same
    /// count, and on an empty table the boundary `0` (a boundary that holds
    /// no row, never `null`).
    #[tokio::test]
    async fn list_as_of_without_a_boundary_matches_list() {
        let svc = service().await;
        let empty = svc.list_as_of(ListParams::default(), None).await.unwrap();
        assert_eq!(empty.as_of_id, 0);
        assert_eq!(empty.total_count, 0);
        assert!(empty.rows.is_empty());
        let pinned_empty = svc
            .list_as_of(ListParams::default(), Some(0))
            .await
            .unwrap();
        assert_eq!(pinned_empty.total_count, 0);

        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("delete", "users", "bob")).await;
        svc.record(sample_entry("create", "users", "alice")).await;

        let params = ListParams {
            sort: ts_desc(),
            filters: vec![FilterState {
                field: "actorUsername".to_string(),
                op: FilterOp::Eq,
                value: json!("alice"),
            }],
            ..Default::default()
        };
        let old = svc.list(params.clone()).await.unwrap();
        let new = svc.list_as_of(params, None).await.unwrap();
        assert_eq!(new.as_of_id, 3);
        assert_eq!(new.total_count, old.total_count);
        assert_eq!(new.rows, old.rows);
        assert_eq!(ids(&new), vec![3, 1]);
    }

    /// The boundary and the filters combine: the count is the filtered
    /// count inside the boundary.
    #[tokio::test]
    async fn list_as_of_combines_with_filters() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "bob")).await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "alice")).await;

        let bounded = svc
            .list_as_of(
                ListParams {
                    filters: vec![FilterState {
                        field: "actorUsername".to_string(),
                        op: FilterOp::Eq,
                        value: json!("alice"),
                    }],
                    ..Default::default()
                },
                Some(3),
            )
            .await
            .unwrap();
        assert_eq!(bounded.total_count, 2);
        assert_eq!(ids(&bounded), vec![1, 3]);
    }

    /// Rows sharing one `ts` (several entries within one second) keep one
    /// order across `OFFSET` blocks: `ORDER BY ts DESC` ends with `id DESC`
    /// (`column_map()` registers `id`, Issue #243), `ts ASC` with `id ASC`.
    #[tokio::test]
    async fn rows_with_the_same_ts_are_ordered_by_id_in_both_directions() {
        let svc = service().await;
        seed_n(&svc, 7).await;
        sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00'")
            .execute(
                svc.db
                    .as_sqlite()
                    .expect("service tests run on a SQLite handle"),
            )
            .await
            .unwrap();

        for (direction, expected) in [
            (SortDirection::Desc, vec![7, 6, 5, 4, 3, 2, 1]),
            (SortDirection::Asc, vec![1, 2, 3, 4, 5, 6, 7]),
        ] {
            let sort = vec![SortState {
                field: "ts".to_string(),
                direction,
            }];
            let first = svc
                .list_as_of(page(0, 3, sort.clone()), None)
                .await
                .unwrap();
            let mut seen = ids(&first);
            for offset in [3, 6] {
                let block = svc
                    .list_as_of(page(offset, 3, sort.clone()), Some(first.as_of_id))
                    .await
                    .unwrap();
                seen.extend(ids(&block));
            }
            assert_eq!(seen, expected, "{direction:?}");
        }
    }

    /// A prune inside a pinned boundary changes the pinned set's count -
    /// the signal the viewer uses to expire the generation (the boundary
    /// only covers additions).
    #[tokio::test]
    async fn a_prune_inside_the_boundary_changes_the_pinned_count() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(first.total_count, 5);

        svc.prune(None, Some(3)).await.unwrap();
        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(second.total_count, 3);
    }

    // --- deletion epoch (Issue #248 review) -----------------------------------

    fn pool_of(svc: &AuditLogService) -> &sqlx::SqlitePool {
        svc.db
            .as_sqlite()
            .expect("service tests run on a SQLite handle")
    }

    /// A late commit below the boundary (+1) and a prune of the same size
    /// (-1) leave the pinned count unchanged while the set changed - the
    /// block after the edge repeats a row. The deletion epoch still moves.
    ///
    /// SQLite writes one at a time, so a row below the boundary cannot
    /// commit late there; the late commit is simulated by inserting an
    /// explicit lower id (the PostgreSQL smoke test reproduces it with real
    /// transactions).
    #[tokio::test]
    async fn a_late_commit_offset_by_a_prune_keeps_the_count_but_moves_the_epoch() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        // Id 4 "has not committed yet".
        sqlx::query("DELETE FROM audit_log WHERE id = 4")
            .execute(pool_of(&svc))
            .await
            .unwrap();

        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(ids(&first), vec![5, 3]);
        assert_eq!((first.as_of_id, first.total_count), (5, 4));

        // Id 4 commits, then another tab's unbounded read prunes to 4 rows.
        sqlx::query(
            "INSERT INTO audit_log (id, action, resource, origin) VALUES (4, 'create', 'items', 'rest')",
        )
        .execute(pool_of(&svc))
        .await
        .unwrap();
        assert_eq!(svc.prune(None, Some(4)).await.unwrap(), 1);

        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(
            second.total_count, first.total_count,
            "the count alone misses it"
        );
        assert_eq!(
            ids(&second),
            vec![3, 2],
            "row 3 comes back: the set shifted"
        );
        assert_ne!(
            second.deletion_epoch, first.deletion_epoch,
            "the deletion epoch catches it"
        );
    }

    /// The epoch starts at 0, advances once per prune that deleted rows
    /// (both dimensions in one prune count once), and not for a prune that
    /// deleted nothing. It is stored under `DELETION_EPOCH_KEY`.
    #[tokio::test]
    async fn deletion_epoch_uses_the_documented_settings_key() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let epoch = |svc: &AuditLogService| {
            let svc = svc.clone();
            async move {
                svc.list_as_of(ListParams::default(), None)
                    .await
                    .unwrap()
                    .deletion_epoch
            }
        };
        assert_eq!(epoch(&svc).await, 0);

        assert_eq!(svc.prune(None, Some(100)).await.unwrap(), 0);
        assert_eq!(epoch(&svc).await, 0, "nothing deleted, no advance");

        sqlx::query("UPDATE audit_log SET ts = datetime('now', '-10 days') WHERE id = 1")
            .execute(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(svc.prune(Some(1), Some(3)).await.unwrap(), 2);
        assert_eq!(epoch(&svc).await, 1);
        let stored: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(DELETION_EPOCH_KEY)
            .fetch_one(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(stored, "1");

        assert_eq!(svc.prune(None, Some(2)).await.unwrap(), 1);
        assert_eq!(epoch(&svc).await, 2);

        // A hand-edited value that is not a number restarts from 1 instead
        // of failing the prune.
        sqlx::query("UPDATE settings SET value = 'x' WHERE key = ?")
            .bind(DELETION_EPOCH_KEY)
            .execute(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(epoch(&svc).await, 0);
        assert_eq!(svc.prune(None, Some(1)).await.unwrap(), 1);
        assert_eq!(epoch(&svc).await, 1);
    }
}
