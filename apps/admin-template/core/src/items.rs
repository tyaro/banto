//! Items resource service (spec §8.2, §10): the domain logic behind the
//! `items` resource, callable directly from tests and from thin
//! `tauri::command` adapters in `src-tauri` alike. Field names on
//! [`ItemInput`] intentionally match the frontend schema
//! (`apps/admin-template/src/lib/banto/setup.ts`'s `itemsSchema`) field for
//! field, so `BantoError::Validation` field errors map back onto the right
//! form inputs.

use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::ServerEvent;
use banto_storage::{ColumnMap, Db};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};
use tokio::sync::broadcast;

/// A single row of the `items` table, wire-shaped for the frontend
/// (`updatedAt`, matching `apps/admin-template/src/lib/banto/sampleData.ts::Item`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub name: String,
    pub price: i64,
    pub stock: i64,
    #[sqlx(rename = "updated_at")]
    pub updated_at: String,
    /// Row version for optimistic locking (Issue #638, migration 0011):
    /// 1 on create, +1 on every update (incl. CSV import). A client sends
    /// back the version it read in [`ItemInput::version`] / the delete's
    /// `version`; a mismatch is `BantoError::Conflict`.
    pub version: i64,
}

/// Only fields intentionally approved for audit. When an app adds an item
/// field, decide explicitly whether it belongs here before recording it.
fn item_audit_fields(item: &Item) -> serde_json::Value {
    serde_json::json!({
        "name": item.name,
        "price": item.price,
        "stock": item.stock,
    })
}

/// `detail` of an `items` `update` audit record (Issue #597): `{ name,
/// changes: [{ field, before, after }] }`. Both the REST and the Tauri wiring
/// call this, so the two routes record the same shape (conventions section 1).
/// `items` has no secret column, so nothing is masked; `updatedAt` is a stamp,
/// not a user edit, `version` is the optimistic-lock counter (Issue #638, it
/// changes on every update), and `id` never changes.
pub fn item_update_detail(before: &Item, after: &Item) -> serde_json::Value {
    let changes = banto_admin_services::audit::diff::diff_changes(
        &serde_json::to_value(before).unwrap_or_default(),
        &serde_json::to_value(after).unwrap_or_default(),
        &[],
        &["id", "updatedAt", "version"],
    );
    serde_json::json!({ "name": after.name, "changes": changes })
}

/// Snapshot fields for create/delete use the same bounded change shape as an
/// update. The generated id and timestamp are not business values.
pub fn item_create_detail(item: &Item) -> serde_json::Value {
    let changes = banto_admin_services::audit::diff::diff_changes(
        &serde_json::json!({}),
        &item_audit_fields(item),
        &[],
        &[],
    );
    serde_json::json!({ "name": item.name, "changes": changes })
}

pub fn item_delete_detail(item: &Item, sweep: Option<serde_json::Value>) -> serde_json::Value {
    let changes = banto_admin_services::audit::diff::diff_changes(
        &item_audit_fields(item),
        &serde_json::json!({}),
        &[],
        &[],
    );
    let mut detail = serde_json::json!({ "name": item.name, "changes": changes });
    // sweep_item_attachments currently returns only attachmentsRemoved. Keep
    // this field explicit so future sweep metadata needs an audit review.
    if let Some(count) = sweep.and_then(|s| s.get("attachmentsRemoved").cloned()) {
        detail["attachmentsRemoved"] = count;
    }
    detail
}

/// Create/update payload. Field names match the frontend form schema's
/// field names exactly (`name`, `price`, `stock`) so that
/// `BantoError::Validation`'s per-field messages land on the right inputs.
///
/// `version` (Issue #638) is the optimistic-lock check for an update: the
/// [`Item::version`] the client last read. `Some` and different from the
/// stored one -> `BantoError::Conflict`; absent / `null` -> the old
/// last-write-wins overwrite. `create` ignores it (a new row starts at 1).
#[derive(Debug, Clone, Deserialize)]
pub struct ItemInput {
    pub name: String,
    pub price: i64,
    pub stock: i64,
    #[serde(default)]
    pub version: Option<i64>,
}

const MAX_NAME_LEN: usize = 40;
const MIN_PRICE: i64 = 0;
const MAX_PRICE: i64 = 99_999;
const MIN_STOCK: i64 = 0;

fn required_message() -> String {
    "必須項目です".to_string()
}

fn min_message(min: i64) -> String {
    format!("{min}以上で入力してください")
}

fn max_message(max: i64) -> String {
    format!("{max}以下で入力してください")
}

fn max_length_message(max: usize) -> String {
    format!("{max}文字以内で入力してください")
}

/// Validate an [`ItemInput`] against the same rules as the frontend schema
/// (spec §7.2): `name` trimmed non-empty, <= 40 chars; `price` in
/// `0..=99999`; `stock` >= 0. Returns every violation (not just the first),
/// mirroring `validateAll` in `@banto/forms`.
fn validate_item_input(input: &ItemInput) -> Result<(), BantoError> {
    let mut errors: Vec<FieldError> = Vec::new();

    let trimmed_name = input.name.trim();
    if trimmed_name.is_empty() {
        errors.push(FieldError {
            field: "name".to_string(),
            message: required_message(),
        });
    } else if trimmed_name.chars().count() > MAX_NAME_LEN {
        errors.push(FieldError {
            field: "name".to_string(),
            message: max_length_message(MAX_NAME_LEN),
        });
    }

    if input.price < MIN_PRICE {
        errors.push(FieldError {
            field: "price".to_string(),
            message: min_message(MIN_PRICE),
        });
    } else if input.price > MAX_PRICE {
        errors.push(FieldError {
            field: "price".to_string(),
            message: max_message(MAX_PRICE),
        });
    }

    if input.stock < MIN_STOCK {
        errors.push(FieldError {
            field: "stock".to_string(),
            message: min_message(MIN_STOCK),
        });
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

/// One row of a CSV/UI bulk import (spec M15, `docs/roadmap.md`): shaped
/// like [`ItemInput`] plus an optional `id` that selects UPDATE vs INSERT
/// (spec: "id あり→UPDATE / なし→INSERT"). Field names mirror `ItemInput`'s
/// (camelCase over the wire) so the frontend's CSV-to-row mapping can reuse
/// the same column names as the create/update form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemImportRow {
    pub id: Option<i64>,
    pub name: String,
    pub price: i64,
    pub stock: i64,
}

/// One row-level failure from [`ItemsService::import`] (spec M15). `row` is
/// the 0-based index into the request's `Vec<ItemImportRow>` - NOT a
/// database id, since a row can fail before it ever reaches the DB (e.g. a
/// validation error) - so the frontend's preview screen can point back at
/// the exact input row that needs fixing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowError {
    pub row: usize,
    pub message: String,
}

/// Outcome of [`ItemsService::import`] (spec M15). `errors` non-empty means
/// the whole import was rolled back (see that method's doc comment for why
/// this is all-or-nothing) - `created`/`updated` are then always `0`, never
/// a partial count.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: usize,
    pub updated: usize,
    pub errors: Vec<ImportRowError>,
}

/// Upper bound on rows accepted by a single [`ItemsService::import`] call
/// (spec M15): the whole request runs as one transaction, so this keeps a
/// runaway file from holding a single DB lock/transaction open over an
/// unbounded number of rows. `pub(crate)` so the REST layer can size the
/// import route's `DefaultBodyLimit` off the same single source of truth
/// (spec M14-review M-14; see `rest::items::items_write_router`).
pub(crate) const MAX_IMPORT_ROWS: usize = 10_000;

/// Upper bound on rows removed by a single [`ItemsService::bulk_delete`] call
/// (Issue #713): the whole request is one transaction, and a destructive
/// request stays small enough to review in the audit log. Applies to the
/// number of ids. Smaller than
/// [`MAX_IMPORT_ROWS`] on purpose: an import can be re-run, a delete cannot.
pub const MAX_BULK_DELETE_ROWS: usize = 1_000;

/// How many ids one `IN (...)` list of [`ItemsService::bulk_delete`] carries
/// (well under SQLite's bind-parameter limit).
const BULK_DELETE_CHUNK: usize = 500;

/// How many deleted ids the audit detail of a bulk delete lists
/// ([`item_bulk_delete_detail`]); the rest is only counted.
const BULK_DELETE_AUDIT_IDS: usize = 100;

/// One row of an id-based bulk delete (Issue #713). `version` is the same
/// optimistic-lock check as [`ItemsService::delete_returning_previous`]'s:
/// `None` skips the check for that row.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BulkDeleteItem {
    pub id: i64,
    #[serde(default)]
    pub version: Option<i64>,
}

/// What [`ItemsService::bulk_delete`] removes (Issue #713). The wire shape
/// (`kind: "ids"`) mirrors `DeleteManyTarget` in
/// `packages/admin-core/src/provider.ts`.
///
/// - `Ids`: exactly these rows, each checked against its `version`.
///
/// There is deliberately no "everything the filters match" target: a
/// confirmed count cannot tell that one row left the filter and another
/// entered it. A caller deleting a whole filtered result lists the rows with
/// `list` first and sends their ids and versions here.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BulkDeleteTarget {
    Ids { items: Vec<BulkDeleteItem> },
}

/// Wire result of a bulk delete (`{ deleted }`), the same on REST and Tauri.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BulkDeleteResult {
    pub deleted: usize,
}

/// Audit `detail` of one bulk delete (Issue #713; one entry per request,
/// `action: "bulk_delete"`, no `entity_id`). `deleted` is what
/// [`ItemsService::bulk_delete`] returned.
///
/// - `mode` (`"ids"`) and `count` are always there.
/// - `ids`: the deleted ids, at most [`BULK_DELETE_AUDIT_IDS`] of them;
///   `idsTruncated: true` when there were more.
/// - `attachmentsRemoved` as in [`item_delete_detail`].
///
/// The row values are not snapshotted (unlike a single delete's `changes`):
/// up to [`MAX_BULK_DELETE_ROWS`] rows would not fit one audit row.
pub fn item_bulk_delete_detail(
    target: &BulkDeleteTarget,
    deleted: &[i64],
    sweep: Option<serde_json::Value>,
) -> serde_json::Value {
    let listed = &deleted[..deleted.len().min(BULK_DELETE_AUDIT_IDS)];
    let mut detail = serde_json::json!({ "count": deleted.len(), "ids": listed });
    if listed.len() < deleted.len() {
        detail["idsTruncated"] = serde_json::Value::Bool(true);
    }
    let BulkDeleteTarget::Ids { .. } = target;
    detail["mode"] = "ids".into();
    if let Some(count) = sweep.and_then(|s| s.get("attachmentsRemoved").cloned()) {
        detail["attachmentsRemoved"] = count;
    }
    detail
}

/// Format every field violation on one import row into a single
/// human-readable string (`ImportRowError::message` is one `String`, not a
/// `Vec<FieldError>`, since the import preview shows one line per row).
fn format_field_errors(field_errors: &[FieldError]) -> String {
    field_errors
        .iter()
        .map(|e| format!("{}: {}", e.field, e.message))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Column whitelist for [`ItemsService::list`] (conventions §6). `name` is the
/// one text column the quick search (`ListParams::search`, Issue #555) looks
/// in: `updatedAt` is stored as text but is a date column, like its grid
/// column (`filterType: date`), so the client search skips it too.
fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .text_column("name", "name")
        .column("price", "price")
        .column("stock", "stock")
        .column("updatedAt", "updated_at")
}

const RESOURCE: &str = "items";

/// The `SET version = ...` expression of every update (Issue #638): +1, but
/// back to 1 at `i64::MAX` instead of overflowing (PostgreSQL BIGINT would
/// raise, SQLite would turn the value into a REAL that no longer decodes into
/// `i64`). Wrapping is harmless in practice: a client would have to hold a
/// version read 2^63 updates ago.
const VERSION_BUMP: &str = "CASE WHEN version < 9223372036854775807 THEN version + 1 ELSE 1 END";

/// The conflict message (Issue #638). The client shows its own text; this is
/// the fallback `ProviderError.message`.
const CONFLICT_MESSAGE: &str = "他の人が先にこのレコードを変更しました";

/// Optimistic-lock check (Issue #638): `expected` is the version the client
/// read (`None` = no check, the old overwrite). Any other value than the
/// stored one - including 0, a negative or a future version - is a
/// `Conflict` carrying the current row, so the client can show what changed.
fn check_version(expected: Option<i64>, current: &Item) -> Result<(), BantoError> {
    match expected {
        Some(version) if version != current.version => Err(BantoError::Conflict {
            message: CONFLICT_MESSAGE.to_string(),
            current: serde_json::to_value(current).ok(),
        }),
        _ => Ok(()),
    }
}

/// "Today" as the **local** date of the machine running the app process,
/// rendered `YYYY-MM-DD`; stamped into `items.updated_at` by
/// `create`/`update`/`import` (bound as a parameter, never interpolated).
///
/// This intentionally CHANGES the previous behavior (it is not
/// byte-for-byte compatible with the old SQL expressions): `items.updated_at`
/// used to be written by the database (`date('now')` = the UTC date on
/// SQLite, `CURRENT_DATE::text` = the DB server's time zone on PostgreSQL),
/// so a row saved between 00:00 and 09:00 JST carried the previous day's
/// date and fell outside a period filter built from the picker's "today"
/// (the local date). Computing the date in Rust makes both backends agree
/// and match the picker. The stored shape is unchanged (a bare `YYYY-MM-DD`
/// TEXT, not `Dialect::now_expr()`'s datetime). Existing rows are not
/// rewritten.
fn local_today() -> String {
    chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// The conflict of an id-based bulk delete that names a row which is gone
/// (Issue #713): somebody else deleted it first, so the selection the user
/// confirmed no longer exists. No `current` (there is no row to show).
const BULK_MISSING_MESSAGE: &str = "削除対象の一部が既に削除されています";

/// Transaction body of [`ItemsService::bulk_delete`], expanded once per
/// backend (the `QueryBuilder`/`list_query` types are per-backend, like
/// [`ItemsService::list`]). Every early `return Err(..)` drops the
/// transaction, which rolls it back: nothing is deleted unless the commit at
/// the end runs.
macro_rules! bulk_delete_in_tx {
    ($pool:expr, $begin:expr, $db:ty, $lock:expr, $target:expr) => {{
        let mut tx = $pool
            .begin_with($begin)
            .await
            .map_err(banto_storage::storage_error)?;
        let BulkDeleteTarget::Ids { items } = $target;
        let deleted: Vec<i64> = {
            // Read (and, on PostgreSQL, lock) every row first, so one
            // stale or missing row refuses the whole request.
            for chunk in items.chunks(BULK_DELETE_CHUNK) {
                let mut select: QueryBuilder<$db> = QueryBuilder::new(
                    "SELECT id, name, price, stock, updated_at, version FROM items WHERE id IN (",
                );
                {
                    let mut ids = select.separated(", ");
                    for entry in chunk {
                        ids.push_bind(entry.id);
                    }
                }
                select.push(")").push($lock);
                let current: Vec<Item> = select
                    .build_query_as::<Item>()
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                for entry in chunk {
                    let Some(row) = current.iter().find(|row| row.id == entry.id) else {
                        return Err(BantoError::Conflict {
                            message: BULK_MISSING_MESSAGE.to_string(),
                            current: None,
                        });
                    };
                    check_version(entry.version, row)?;
                }
            }
            let mut removed: u64 = 0;
            for chunk in items.chunks(BULK_DELETE_CHUNK) {
                let mut delete: QueryBuilder<$db> =
                    QueryBuilder::new("DELETE FROM items WHERE id IN (");
                {
                    let mut ids = delete.separated(", ");
                    for entry in chunk {
                        ids.push_bind(entry.id);
                    }
                }
                delete.push(")");
                removed += delete
                    .build()
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?
                    .rows_affected();
            }
            if removed != items.len() as u64 {
                // Unreachable while the rows are locked; never commit a
                // delete that is not the one that was checked.
                return Err(BantoError::Storage(format!(
                    "bulk delete removed {removed} of {} rows",
                    items.len()
                )));
            }
            items.iter().map(|entry| entry.id).collect()
        };
        tx.commit().await.map_err(banto_storage::storage_error)?;
        deleted
    }};
}

/// Service layer for the `items` resource (spec §10): the same methods a
/// REST handler would call in M6. No `tauri` dependency, so it is testable
/// in a plain `cargo test`.
///
/// `Clone` is cheap: `Db` (an `Arc`-backed connection handle) and
/// `broadcast::Sender` are both cheap to clone, so the REST layer (`rest.rs`)
/// can capture an owned `ItemsService` in each route closure without wrapping
/// it itself.
#[derive(Clone)]
pub struct ItemsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
    /// Source of the `updated_at` date (`YYYY-MM-DD`); [`local_today`] by
    /// default, replaceable via [`ItemsService::with_today`] so tests can pin it.
    today: fn() -> String,
}

impl ItemsService {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            events: None,
            today: local_today,
        }
    }

    /// Replace the "today" source used to stamp `updated_at` (tests pin a
    /// fixed date with this; production keeps the local date).
    pub fn with_today(mut self, today: fn() -> String) -> Self {
        self.today = today;
        self
    }

    /// Attach an event sender: `create`/`update`/`delete` will emit
    /// `ServerEvent::ResourceChanged { resource: "items" }` after their SQL
    /// commits successfully (spec §3.5). Builder-style so callers can write
    /// `ItemsService::new(pool).with_events(tx)`.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    /// Broadcast a `resource_changed` event for `items`, if an event sender
    /// is attached. Receivers being absent (`send` returning `Err`, e.g. no
    /// browser currently connected) is not an error.
    fn notify_changed(&self) {
        if let Some(tx) = &self.events {
            let _ = tx.send(ServerEvent::ResourceChanged {
                resource: RESOURCE.to_string(),
            });
        }
    }

    pub async fn list(&self, params: ListParams) -> Result<ListResult<Item>, BantoError> {
        let columns = column_map();
        const SELECT_ROWS: &str = "SELECT id, name, price, stock, updated_at, version FROM items";
        const SELECT_COUNT: &str = "SELECT COUNT(*) FROM items";

        // `QueryBuilder`/`list_query` are per-backend (the module is
        // monomorphized per dialect via macro), so the list path dispatches on
        // the backend and routes through the matching `list_query::{sqlite,
        // postgres}` module - each one's `push_bind` handles that backend's
        // placeholder syntax (conventions §6 "SQL 列はホワイトリスト経由のみ").
        match &self.db {
            Db::Sqlite(pool) => {
                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_ROWS);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Item> = rows_builder
                    .build_query_as::<Item>()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_COUNT);
                banto_storage::list_query::sqlite::append_list_where(
                    &mut count_builder,
                    &columns,
                    &params,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;

                Ok(ListResult {
                    rows,
                    total_count: total_count as u64,
                })
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(SELECT_ROWS);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Item> = rows_builder
                    .build_query_as::<Item>()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<sqlx::Postgres> =
                    QueryBuilder::new(SELECT_COUNT);
                banto_storage::list_query::postgres::append_list_where(
                    &mut count_builder,
                    &columns,
                    &params,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;

                Ok(ListResult {
                    rows,
                    total_count: total_count as u64,
                })
            }
        }
    }

    pub async fn get(&self, id: i64) -> Result<Item, BantoError> {
        let dialect = self.db.dialect();
        // AssertSqlSafe (here and throughout this impl): only
        // `dialect.placeholder(n)` is interpolated -
        // internally generated from the `Dialect` enum, never caller
        // input. Every actual value (incl. the `updated_at` date) is bound
        // below via `.bind(...)`.
        let sql = format!(
            "SELECT id, name, price, stock, updated_at, version FROM items WHERE id = {}",
            dialect.placeholder(1)
        );
        match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(|err| banto_storage::not_found(err, RESOURCE, id.to_string()))
    }

    pub async fn create(&self, input: ItemInput) -> Result<Item, BantoError> {
        validate_item_input(&input)?;
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let sql = format!(
            "INSERT INTO items (name, price, stock, updated_at) VALUES ({}, {}, {}, {}) \
             RETURNING id, name, price, stock, updated_at, version",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
        );
        let today = (self.today)();
        let item = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(&today)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(&today)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        self.notify_changed();
        Ok(item)
    }

    pub async fn update(&self, id: i64, input: ItemInput) -> Result<Item, BantoError> {
        self.update_returning_previous(id, input)
            .await
            .map(|(_, item)| item)
    }

    /// Like [`ItemsService::update`], but also returns the row as it was
    /// BEFORE the update (`(previous, updated)`), read in the same transaction
    /// so the pair is consistent. The audit wiring uses it to record a
    /// field-level diff (Issue #597); the service itself stays audit-unaware.
    pub async fn update_returning_previous(
        &self,
        id: i64,
        input: ItemInput,
    ) -> Result<(Item, Item), BantoError> {
        validate_item_input(&input)?;
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let lock = if matches!(self.db, Db::Sqlite(_)) {
            ""
        } else {
            // PostgreSQL: lock the row so a concurrent update cannot slip in
            // between the read and the write. (SQLite reserves the writer up
            // front with BEGIN IMMEDIATE below, so nothing can interleave.)
            " FOR UPDATE"
        };
        let select_sql = format!(
            "SELECT id, name, price, stock, updated_at, version FROM items WHERE id = {}{lock}",
            dialect.placeholder(1),
        );
        let sql = format!(
            "UPDATE items SET name = {}, price = {}, stock = {}, updated_at = {}, \
             version = {VERSION_BUMP} WHERE id = {} \
             RETURNING id, name, price, stock, updated_at, version",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
            dialect.placeholder(5),
        );
        let today = (self.today)();
        let not_found = |err| banto_storage::not_found(err, RESOURCE, id.to_string());
        // Issue #638: the version check runs on the row read under the same
        // lock as the write below (SQLite BEGIN IMMEDIATE / PostgreSQL FOR
        // UPDATE), so two concurrent updates carrying the same version are
        // serialized and the second one sees the first one's bump. A missing
        // id is still `NotFound` (the read fails before any comparison). An
        // early return drops `tx`, which rolls it back.
        let (previous, item) = match &self.db {
            Db::Sqlite(pool) => {
                // Reserve the writer BEFORE reading: a deferred transaction that
                // read first could hit SQLITE_BUSY when upgrading to a write.
                let mut tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(banto_storage::storage_error)?;
                let previous = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(select_sql))
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(not_found)?;
                check_version(input.version, &previous)?;
                let item = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(&today)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(not_found)?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                (previous, item)
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                // Explicit isolation level: a pool's repeatable-read default
                // would pin the snapshot before the FOR UPDATE wait ends.
                let mut tx = pool
                    .begin_with("BEGIN ISOLATION LEVEL READ COMMITTED")
                    .await
                    .map_err(banto_storage::storage_error)?;
                let previous = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(select_sql))
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(not_found)?;
                check_version(input.version, &previous)?;
                let item = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(&today)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(not_found)?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                (previous, item)
            }
        };
        self.notify_changed();
        Ok((previous, item))
    }

    /// Delete without a version check (last-write-wins, as before #638).
    pub async fn delete(&self, id: i64) -> Result<(), BantoError> {
        self.delete_returning_previous(id, None).await.map(|_| ())
    }

    /// Delete and return the exact removed row for the audit snapshot. Decode
    /// RETURNING before commit, so a decode failure cannot delete the row
    /// without letting the wiring layer write its audit entry.
    ///
    /// `expected_version` (Issue #638): `Some` -> the row is read first in the
    /// same transaction (SQLite BEGIN IMMEDIATE / PostgreSQL FOR UPDATE) and a
    /// different stored version is `BantoError::Conflict` with nothing
    /// deleted; a missing id is `NotFound` before any comparison. `None` ->
    /// the old single-statement delete.
    pub async fn delete_returning_previous(
        &self,
        id: i64,
        expected_version: Option<i64>,
    ) -> Result<Item, BantoError> {
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let sql = format!(
            "DELETE FROM items WHERE id = {} RETURNING id, name, price, stock, updated_at, version",
            dialect.placeholder(1)
        );
        let lock = if matches!(self.db, Db::Sqlite(_)) {
            ""
        } else {
            " FOR UPDATE"
        };
        let check_sql = format!(
            "SELECT id, name, price, stock, updated_at, version FROM items WHERE id = {}{lock}",
            dialect.placeholder(1)
        );
        let missing = || BantoError::NotFound {
            resource: RESOURCE.to_string(),
            id: id.to_string(),
        };
        let item = match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(banto_storage::storage_error)?;
                if expected_version.is_some() {
                    let current = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(check_sql))
                        .bind(id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .ok_or_else(missing)?;
                    check_version(expected_version, &current)?;
                }
                let item = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                item
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool
                    .begin_with("BEGIN ISOLATION LEVEL READ COMMITTED")
                    .await
                    .map_err(banto_storage::storage_error)?;
                if expected_version.is_some() {
                    let current = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(check_sql))
                        .bind(id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .ok_or_else(missing)?;
                    check_version(expected_version, &current)?;
                }
                let item = sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                item
            }
        };
        let item = item.ok_or_else(missing)?;
        self.notify_changed();
        Ok(item)
    }

    /// Delete many rows in ONE transaction, all or nothing (Issue #713).
    /// Returns the deleted ids (in request order) so the wiring layer can sweep attachments and write
    /// its single audit entry.
    ///
    /// - `Ids`: every row is read first in the transaction (SQLite BEGIN
    ///   IMMEDIATE / PostgreSQL FOR UPDATE). A row that is gone, or whose
    ///   stored version differs from a given `version`, is
    ///   `BantoError::Conflict` (`current`: the stale row, none for a missing
    ///   one) and nothing is deleted. A row without `version` is not checked,
    ///   like a single delete.
    ///
    /// `BadRequest` before any SQL: no target rows (an empty id list - a caller
    /// bug, and nothing worth an audit entry),
    /// more than [`MAX_BULK_DELETE_ROWS`], or the same id twice.
    ///
    /// Emits one `resource_changed` event for the whole request.
    pub async fn bulk_delete(&self, target: &BulkDeleteTarget) -> Result<Vec<i64>, BantoError> {
        let BulkDeleteTarget::Ids { items } = target;
        let mut seen = std::collections::HashSet::with_capacity(items.len());
        if let Some(duplicate) = items.iter().find(|entry| !seen.insert(entry.id)) {
            return Err(BantoError::BadRequest(format!(
                "同じ id が2回指定されています: {}",
                duplicate.id
            )));
        }
        let requested = items.len() as u64;
        if requested == 0 {
            return Err(BantoError::BadRequest("削除対象がありません".to_string()));
        }
        if requested > MAX_BULK_DELETE_ROWS as u64 {
            return Err(BantoError::BadRequest(format!(
                "一度に削除できるのは{MAX_BULK_DELETE_ROWS}件までです"
            )));
        }

        let deleted = match &self.db {
            Db::Sqlite(pool) => {
                bulk_delete_in_tx!(pool, "BEGIN IMMEDIATE", Sqlite, "", target)
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => bulk_delete_in_tx!(
                pool,
                "BEGIN ISOLATION LEVEL READ COMMITTED",
                sqlx::Postgres,
                " FOR UPDATE",
                target
            ),
        };
        self.notify_changed();
        Ok(deleted)
    }

    /// Bulk create/update (spec M15, `docs/roadmap.md`): each row carrying
    /// an `id` is an UPDATE (a missing id is that row's error), each row
    /// without one is an INSERT. Runs as a SINGLE transaction, and -
    /// crucially - is all-or-nothing: if ANY row fails validation or names a
    /// missing id, the ENTIRE import is rolled back and this returns
    /// `created: 0, updated: 0` with every failing row in `errors`, rather
    /// than applying the rows that would otherwise have succeeded.
    ///
    /// This is a deliberate spec M15 design decision, not the usual
    /// "skip the bad rows, apply the rest" bulk-import convention: the UI
    /// flow is "pick a file -> preview counts/errors (computed by calling
    /// this same validation) -> confirm -> run". If a partial apply were
    /// allowed, whatever the user confirmed against in the preview could
    /// silently diverge from what actually lands in the DB the moment any
    /// row in the batch is bad - there would be no way to show "312 of 400
    /// imported, 88 failed" honestly up front, only after the fact, and a
    /// re-run after fixing the 88 would risk re-creating the 312 that
    /// already went in as duplicates (rows without `id` always INSERT).
    /// All-or-nothing keeps "what you previewed is what you get" true.
    pub async fn import(&self, rows: Vec<ItemImportRow>) -> Result<ImportResult, BantoError> {
        if rows.len() > MAX_IMPORT_ROWS {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "rows".to_string(),
                    message: format!("一度にインポートできるのは{MAX_IMPORT_ROWS}行までです"),
                }],
            });
        }
        if rows.is_empty() {
            return Ok(ImportResult {
                created: 0,
                updated: 0,
                errors: Vec::new(),
            });
        }

        // Validate every row BEFORE opening a transaction: since a single
        // bad row rolls back the whole batch anyway (see doc comment
        // above), there is no reason to pay for a transaction/DB round trip
        // that is just going to be thrown away.
        let mut errors: Vec<ImportRowError> = Vec::new();
        for (row_index, row) in rows.iter().enumerate() {
            let input = ItemInput {
                name: row.name.clone(),
                price: row.price,
                stock: row.stock,
                version: None,
            };
            if let Err(BantoError::Validation { field_errors }) = validate_item_input(&input) {
                errors.push(ImportRowError {
                    row: row_index,
                    message: format_field_errors(&field_errors),
                });
            }
        }
        if !errors.is_empty() {
            return Ok(ImportResult {
                created: 0,
                updated: 0,
                errors,
            });
        }

        // The SQL is dialect-independent apart from placeholders, so build it once (shared by both backend
        // arms) and only the transaction execution dispatches per backend.
        let dialect = self.db.dialect();
        let update_sql = format!(
            // Issue #638: CSV import still overwrites (no version check), but
            // bumps the version so a form/grid holding the old one conflicts.
            "UPDATE items SET name = {}, price = {}, stock = {}, updated_at = {}, \
             version = {VERSION_BUMP} WHERE id = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
            dialect.placeholder(5),
        );
        let insert_sql = format!(
            "INSERT INTO items (name, price, stock, updated_at) VALUES ({}, {}, {}, {})",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
        );
        let today = (self.today)();

        let result = match &self.db {
            Db::Sqlite(pool) => {
                import_apply_sqlite(pool, &rows, &update_sql, &insert_sql, &today).await?
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                import_apply_postgres(pool, &rows, &update_sql, &insert_sql, &today).await?
            }
        };

        // Exactly one notify for a committed batch (spec M15) - an all-or-
        // nothing rollback (`errors` non-empty) emits none.
        if result.errors.is_empty() {
            self.notify_changed();
        }
        Ok(result)
    }
}

/// Run one import batch inside a single SQLite transaction (spec M15
/// all-or-nothing). Free function (not a method) so the identical logic can be
/// mirrored for Postgres without threading `self` through two backend arms -
/// `sqlx`'s `Query<Sqlite>` and `Query<Postgres>` are distinct types, so the
/// two transaction bodies cannot share one generic implementation (the same
/// enum-dispatch trade-off `banto_storage::list_query` documents). Assumes
/// every row already passed validation (the caller validates the whole batch
/// before opening any transaction).
///
/// `update_sql`/`insert_sql` are wrapped in `sqlx::AssertSqlSafe` at their
/// call sites below: both are built once by [`ItemsService::import`] from
/// `dialect.placeholder(n)` only (internally generated, never caller
/// input) - every row's actual field values and the `today` date (bound as
/// `$4`/`?4`) are bound, never interpolated.
async fn import_apply_sqlite(
    pool: &sqlx::SqlitePool,
    rows: &[ItemImportRow],
    update_sql: &str,
    insert_sql: &str,
    today: &str,
) -> Result<ImportResult, BantoError> {
    let mut errors: Vec<ImportRowError> = Vec::new();
    let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
    let mut created = 0usize;
    let mut updated = 0usize;

    for (row_index, row) in rows.iter().enumerate() {
        match row.id {
            Some(id) => {
                let result = sqlx::query(sqlx::AssertSqlSafe(update_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(today)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                if result.rows_affected() == 0 {
                    errors.push(ImportRowError {
                        row: row_index,
                        message: format!("id {id} の商品が見つかりません"),
                    });
                } else {
                    updated += 1;
                }
            }
            None => {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(today)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                created += 1;
            }
        }
    }

    if !errors.is_empty() {
        tx.rollback().await.map_err(banto_storage::storage_error)?;
        return Ok(ImportResult {
            created: 0,
            updated: 0,
            errors,
        });
    }

    tx.commit().await.map_err(banto_storage::storage_error)?;
    Ok(ImportResult {
        created,
        updated,
        errors: Vec::new(),
    })
}

/// Postgres mirror of [`import_apply_sqlite`] (see that function's doc for why
/// the two cannot be unified). Not exercised in PR2 - `init_db` builds SQLite
/// only - but kept a faithful copy so PR3 can wire a Postgres pool with no
/// further change here.
#[cfg(feature = "postgres")]
async fn import_apply_postgres(
    pool: &sqlx::PgPool,
    rows: &[ItemImportRow],
    update_sql: &str,
    insert_sql: &str,
    today: &str,
) -> Result<ImportResult, BantoError> {
    let mut errors: Vec<ImportRowError> = Vec::new();
    let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
    let mut created = 0usize;
    let mut updated = 0usize;

    for (row_index, row) in rows.iter().enumerate() {
        match row.id {
            Some(id) => {
                let result = sqlx::query(sqlx::AssertSqlSafe(update_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(today)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                if result.rows_affected() == 0 {
                    errors.push(ImportRowError {
                        row: row_index,
                        message: format!("id {id} の商品が見つかりません"),
                    });
                } else {
                    updated += 1;
                }
            }
            None => {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(today)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                created += 1;
            }
        }
    }

    if !errors.is_empty() {
        tx.rollback().await.map_err(banto_storage::storage_error)?;
        return Ok(ImportResult {
            created: 0,
            updated: 0,
            errors,
        });
    }

    tx.commit().await.map_err(banto_storage::storage_error)?;
    Ok(ImportResult {
        created,
        updated,
        errors: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;
    use banto_core::{FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;

    /// A migrated but unseeded database, so tests have full control over
    /// which rows/ids exist (the 1,000-row demo seed lives behind
    /// `db::init_db`/`init_db_memory`, exercised separately in `db.rs`'s
    /// own tests).
    async fn service() -> ItemsService {
        let pool = migrate_memory().await.expect("migrate_memory");
        ItemsService::new(pool)
    }

    #[tokio::test]
    async fn create_delete_details_capture_values_and_deleted_row() {
        let svc = service().await;
        let item = svc
            .create(ItemInput {
                name: "Test Item".into(),
                price: 100,
                stock: 5,
                version: None,
            })
            .await
            .unwrap();
        let created = item_create_detail(&item);
        assert_eq!(created["name"], "Test Item");
        assert_eq!(
            created["changes"],
            json!([
                { "field": "name", "before": null, "after": "Test Item" },
                { "field": "price", "before": null, "after": 100 },
                { "field": "stock", "before": null, "after": 5 }
            ])
        );
        let removed = svc.delete_returning_previous(item.id, None).await.unwrap();
        assert_eq!(removed, item);
        let deleted = item_delete_detail(&removed, Some(json!({ "attachmentsRemoved": 2 })));
        assert_eq!(deleted["attachmentsRemoved"], 2);
        assert_eq!(
            deleted["changes"],
            json!([
                { "field": "name", "before": "Test Item", "after": null },
                { "field": "price", "before": 100, "after": null },
                { "field": "stock", "before": 5, "after": null }
            ])
        );
        // These top-level keys redirect record history; item values must
        // never promote user input into a parent relationship.
        for detail in [&created, &deleted] {
            assert!(detail.get("parentResource").is_none());
            assert!(detail.get("parentId").is_none());
        }
        assert!(matches!(
            svc.delete_returning_previous(item.id, None).await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn delete_decode_failure_rolls_back_the_row() {
        let svc = service().await;
        let item = svc
            .create(ItemInput {
                name: "Invalid storage value".into(),
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        // SQLite's INTEGER affinity permits a text value in a non-STRICT
        // table. Item::price cannot decode it as i64.
        sqlx::query("UPDATE items SET price = 'invalid' WHERE id = ?")
            .bind(item.id)
            .execute(svc.db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert!(svc.delete_returning_previous(item.id, None).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items WHERE id = ?")
            .bind(item.id)
            .fetch_one(svc.db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert_eq!(count, 1, "a decode error must roll back the delete");
    }

    #[tokio::test]
    async fn create_then_get_round_trips() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Test Item".to_string(),
                price: 100,
                stock: 5,
                version: None,
            })
            .await
            .expect("create should succeed");
        assert_eq!(created.name, "Test Item");
        assert_eq!(created.price, 100);
        assert_eq!(created.stock, 5);
        assert!(!created.updated_at.is_empty());

        let fetched = svc.get(created.id).await.expect("get should succeed");
        assert_eq!(fetched, created);
    }

    #[tokio::test]
    async fn create_trims_name() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "  Padded  ".to_string(),
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .expect("create should succeed");
        assert_eq!(created.name, "Padded");
    }

    #[tokio::test]
    async fn update_changes_fields_and_stamps_updated_at() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        let updated = svc
            .update(
                created.id,
                ItemInput {
                    name: "After".to_string(),
                    price: 20,
                    stock: 2,
                    version: None,
                },
            )
            .await
            .expect("update should succeed");
        assert_eq!(updated.name, "After");
        assert_eq!(updated.price, 20);
        assert_eq!(updated.stock, 2);
    }

    #[tokio::test]
    async fn update_returning_previous_gives_the_old_row_and_the_detail_lists_changes() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        let (previous, updated) = svc
            .update_returning_previous(
                created.id,
                ItemInput {
                    name: "Before".to_string(),
                    price: 20,
                    stock: 1,
                    version: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(previous, created);
        assert_eq!(updated.price, 20);
        let detail = item_update_detail(&previous, &updated);
        assert_eq!(detail["name"], "Before");
        assert!(detail.get("parentResource").is_none());
        assert!(detail.get("parentId").is_none());
        assert_eq!(
            detail["changes"],
            serde_json::json!([{ "field": "price", "before": 10, "after": 20 }])
        );
        // no change -> empty array
        let (p2, u2) = svc
            .update_returning_previous(
                created.id,
                ItemInput {
                    name: "Before".to_string(),
                    price: 20,
                    stock: 1,
                    version: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            item_update_detail(&p2, &u2)["changes"],
            serde_json::json!([])
        );
        // missing row -> NotFound
        let err = svc
            .update_returning_previous(
                9999,
                ItemInput {
                    name: "x".to_string(),
                    price: 1,
                    stock: 1,
                    version: None,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[test]
    fn update_detail_leaves_out_the_updated_at_stamp() {
        // The ignore list names the serialized key; a rename would let the
        // stamp into every cross-day update, so check it against real values.
        let before = Item {
            id: 1,
            name: "A".to_string(),
            price: 10,
            stock: 1,
            updated_at: "2031-02-03".to_string(),
            version: 1,
        };
        // Issue #638: the optimistic-lock counter changes on every update
        // and is not a user edit either.
        let after = Item {
            updated_at: "2031-02-04".to_string(),
            version: 2,
            ..before.clone()
        };
        let wire = serde_json::to_value(&before).unwrap();
        assert!(wire.get("updatedAt").is_some());
        assert!(wire.get("version").is_some());
        assert_eq!(
            item_update_detail(&before, &after)["changes"],
            serde_json::json!([])
        );
    }

    fn fixed_today() -> String {
        "2031-02-03".to_string()
    }

    #[tokio::test]
    async fn create_update_import_stamp_the_injected_local_date() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let svc = ItemsService::new(pool).with_today(fixed_today);
        let created = svc
            .create(ItemInput {
                name: "A".to_string(),
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        assert_eq!(created.updated_at, "2031-02-03");
        let updated = svc
            .update(
                created.id,
                ItemInput {
                    name: "B".to_string(),
                    price: 2,
                    stock: 2,
                    version: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.updated_at, "2031-02-03");
        svc.import(vec![
            ItemImportRow {
                id: Some(created.id),
                name: "C".to_string(),
                price: 3,
                stock: 3,
            },
            ItemImportRow {
                id: None,
                name: "D".to_string(),
                price: 4,
                stock: 4,
            },
        ])
        .await
        .unwrap();
        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.rows.len(), 2);
        assert!(all.rows.iter().all(|r| r.updated_at == "2031-02-03"));
    }

    #[test]
    fn local_today_is_a_yyyy_mm_dd_date() {
        let t = local_today();
        assert_eq!(t.len(), 10);
        assert!(chrono::NaiveDate::parse_from_str(&t, "%Y-%m-%d").is_ok());
    }

    #[tokio::test]
    async fn update_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc
            .update(
                999,
                ItemInput {
                    name: "X".to_string(),
                    price: 1,
                    stock: 1,
                    version: None,
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "999")
        );
    }

    #[tokio::test]
    async fn get_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc.get(12345).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "12345")
        );
    }

    #[tokio::test]
    async fn delete_then_get_is_not_found() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Doomed".to_string(),
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        svc.delete(created.id).await.expect("delete should succeed");
        let err = svc.get(created.id).await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc.delete(999).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "999")
        );
    }

    #[tokio::test]
    async fn create_rejects_empty_name_with_required_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "   ".to_string(),
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 1);
                assert_eq!(field_errors[0].field, "name");
                assert_eq!(field_errors[0].message, "必須項目です");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_name_over_40_chars() {
        let svc = service().await;
        let long_name = "あ".repeat(41);
        let err = svc
            .create(ItemInput {
                name: long_name,
                price: 1,
                stock: 1,
                version: None,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "name");
                assert_eq!(field_errors[0].message, "40文字以内で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_negative_price_and_stock_with_min_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "Valid".to_string(),
                price: -1,
                stock: -5,
                version: None,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 2);
                assert_eq!(field_errors[0].field, "price");
                assert_eq!(field_errors[0].message, "0以上で入力してください");
                assert_eq!(field_errors[1].field, "stock");
                assert_eq!(field_errors[1].message, "0以上で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_price_over_99999_with_max_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "Valid".to_string(),
                price: 100_000,
                stock: 1,
                version: None,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "price");
                assert_eq!(field_errors[0].message, "99999以下で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_filters_sorts_and_paginates_with_total_count() {
        let svc = service().await;
        for (name, price, stock) in [("Alpha", 10, 1), ("Beta", 20, 2), ("Gamma", 30, 3)] {
            svc.create(ItemInput {
                name: name.to_string(),
                price,
                stock,
                version: None,
            })
            .await
            .unwrap();
        }

        let result = svc
            .list(ListParams {
                sort: vec![SortState {
                    field: "price".to_string(),
                    direction: SortDirection::Desc,
                }],
                filters: vec![FilterState {
                    field: "price".to_string(),
                    op: FilterOp::Gte,
                    value: json!(20),
                }],
                pagination: Some(Pagination {
                    offset: 0,
                    limit: 1,
                }),
                search: None,
            })
            .await
            .expect("list should succeed");

        assert_eq!(result.total_count, 2); // Beta and Gamma match the filter
        assert_eq!(result.rows.len(), 1); // pagination limits the page to 1
        assert_eq!(result.rows[0].name, "Gamma"); // highest price first
    }

    /// Issue #555: the quick search looks in `name` (case-insensitively),
    /// not in `updatedAt` or the numbers, and the count matches the rows.
    #[tokio::test]
    async fn list_search_matches_the_name_and_is_counted() {
        let svc = service().await;
        for (name, price, stock) in [
            ("Green Tea", 10, 1),
            ("Black tea", 20, 2),
            ("Coffee", 30, 3),
        ] {
            svc.create(ItemInput {
                name: name.to_string(),
                price,
                stock,
                version: None,
            })
            .await
            .unwrap();
        }
        let search = |term: &str| ListParams {
            pagination: Some(Pagination {
                offset: 0,
                limit: 1,
            }),
            search: Some(term.to_string()),
            ..Default::default()
        };

        let tea = svc.list(search("TEA")).await.expect("list");
        assert_eq!(tea.total_count, 2);
        assert_eq!(tea.rows.len(), 1);
        assert_eq!(tea.rows[0].name, "Green Tea");

        // `30` is a price, the year is in `updatedAt`: neither is searched.
        assert_eq!(svc.list(search("30")).await.expect("list").total_count, 0);
        assert_eq!(svc.list(search("20")).await.expect("list").total_count, 0);
        assert_eq!(svc.list(search("  ")).await.expect("list").total_count, 3);
    }

    #[tokio::test]
    async fn update_emits_resource_changed_event() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        // Drain the event from `create` so we can assert specifically on
        // the one from `update` below.
        rx.try_recv().expect("create should have emitted an event");

        svc.update(
            created.id,
            ItemInput {
                name: "After".to_string(),
                price: 20,
                stock: 2,
                version: None,
            },
        )
        .await
        .expect("update should succeed");

        let event = rx
            .try_recv()
            .expect("update should emit a resource_changed event");
        match event {
            ServerEvent::ResourceChanged { resource } => assert_eq!(resource, "items"),
            other => panic!("expected ResourceChanged, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn failed_update_emits_no_event() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        rx.try_recv().expect("create should have emitted an event");

        let err = svc
            .update(
                created.id,
                ItemInput {
                    name: "".to_string(), // fails validation
                    price: 20,
                    stock: 2,
                    version: None,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));

        assert!(
            rx.try_recv().is_err(),
            "a failed validation update must not emit a resource_changed event"
        );
    }

    // --- import (spec M15) --------------------------------------------------

    #[tokio::test]
    async fn import_all_success_creates_and_updates_in_one_transaction() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let existing = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
                version: None,
            })
            .await
            .unwrap();
        rx.try_recv().expect("create should have emitted an event");

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: Some(existing.id),
                    name: "After".to_string(),
                    price: 20,
                    stock: 2,
                },
                ItemImportRow {
                    id: None,
                    name: "New Item".to_string(),
                    price: 30,
                    stock: 3,
                },
            ])
            .await
            .expect("import should succeed");

        assert_eq!(result.created, 1);
        assert_eq!(result.updated, 1);
        assert!(result.errors.is_empty());

        let updated = svc.get(existing.id).await.unwrap();
        assert_eq!(updated.name, "After");
        assert_eq!(updated.price, 20);
        assert_eq!(updated.stock, 2);

        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 2);

        // Exactly one resource_changed event for the whole batch, not one
        // per row (spec M15: "成功時に notify_changed() を1回だけ").
        rx.try_recv()
            .expect("import should emit a resource_changed event");
        assert!(
            rx.try_recv().is_err(),
            "import must emit exactly one resource_changed event, not one per row"
        );
    }

    #[tokio::test]
    async fn import_with_missing_id_rolls_back_the_whole_batch() {
        let svc = service().await;

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: None,
                    name: "Would Have Been Created".to_string(),
                    price: 10,
                    stock: 1,
                },
                ItemImportRow {
                    id: Some(999),
                    name: "No Such Row".to_string(),
                    price: 20,
                    stock: 2,
                },
            ])
            .await
            .expect("import should return Ok with row errors, not Err");

        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].row, 1);

        // The first row must NOT have been committed despite being valid on
        // its own - the id-not-found error on row 1 rolls back row 0's
        // insert too.
        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_with_validation_error_rolls_back_and_reports_the_row() {
        let svc = service().await;

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: None,
                    name: "Valid".to_string(),
                    price: 10,
                    stock: 1,
                },
                ItemImportRow {
                    id: None,
                    name: "".to_string(), // fails validation: required
                    price: -1,            // fails validation: min
                    stock: 1,
                },
            ])
            .await
            .expect("import should return Ok with row errors, not Err");

        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].row, 1);
        assert!(result.errors[0].message.contains("name"));
        assert!(result.errors[0].message.contains("price"));

        // No transaction was even opened for a pre-validated batch, but
        // assert on the observable behavior (nothing landed) rather than the
        // implementation detail.
        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_rejects_more_than_the_max_row_count() {
        let svc = service().await;

        let rows: Vec<ItemImportRow> = (0..(MAX_IMPORT_ROWS + 1))
            .map(|i| ItemImportRow {
                id: None,
                name: format!("Item {i}"),
                price: 1,
                stock: 1,
            })
            .collect();

        let err = svc.import(rows).await.unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 1);
                assert_eq!(field_errors[0].field, "rows");
            }
            other => panic!("expected Validation, got {other:?}"),
        }

        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_empty_is_a_no_op_ok() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let result = svc
            .import(Vec::new())
            .await
            .expect("empty import should succeed");
        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert!(result.errors.is_empty());
        assert!(
            rx.try_recv().is_err(),
            "an empty import must not emit a resource_changed event"
        );
    }

    // --- Issue #638: optimistic locking -------------------------------------

    fn input(name: &str, version: Option<i64>) -> ItemInput {
        ItemInput {
            name: name.to_string(),
            price: 10,
            stock: 1,
            version,
        }
    }

    fn conflict_current(result: Result<impl std::fmt::Debug, BantoError>) -> serde_json::Value {
        match result {
            Err(BantoError::Conflict { current, .. }) => current.expect("current row"),
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_starts_at_version_1_and_ignores_a_sent_version() {
        let svc = service().await;
        let created = svc.create(input("A", Some(42))).await.unwrap();
        assert_eq!(created.version, 1);
        assert_eq!(svc.get(created.id).await.unwrap().version, 1);
    }

    #[tokio::test]
    async fn update_with_the_current_version_applies_and_bumps_it() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let (previous, updated) = svc
            .update_returning_previous(created.id, input("B", Some(1)))
            .await
            .unwrap();
        assert_eq!(previous.version, 1);
        assert_eq!(updated.version, 2);
        assert_eq!(updated.name, "B");
        let again = svc.update(created.id, input("C", Some(2))).await.unwrap();
        assert_eq!(again.version, 3);
    }

    #[tokio::test]
    async fn update_with_a_stale_version_conflicts_with_the_current_row_and_changes_nothing() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let theirs = svc
            .update(created.id, input("Theirs", Some(1)))
            .await
            .unwrap();
        let (tx, mut rx) = broadcast::channel(4);
        let svc = svc.with_events(tx);

        let current = conflict_current(svc.update(created.id, input("Mine", Some(1))).await);
        assert_eq!(current, serde_json::to_value(&theirs).unwrap());
        assert_eq!(current["version"], 2);
        assert_eq!(svc.get(created.id).await.unwrap(), theirs);
        assert!(rx.try_recv().is_err(), "a conflict must not emit an event");
    }

    #[tokio::test]
    async fn update_edge_versions_all_conflict() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        for version in [0, -1, 2, i64::MAX, i64::MIN] {
            conflict_current(svc.update(created.id, input("X", Some(version))).await);
        }
        assert_eq!(svc.get(created.id).await.unwrap().version, 1);
    }

    #[tokio::test]
    async fn update_without_a_version_overwrites_and_still_bumps() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        svc.update(created.id, input("B", Some(1))).await.unwrap();
        let overwritten = svc.update(created.id, input("C", None)).await.unwrap();
        assert_eq!(overwritten.name, "C");
        assert_eq!(overwritten.version, 3);
    }

    #[tokio::test]
    async fn update_missing_id_with_a_version_is_not_found_not_conflict() {
        let svc = service().await;
        let result = svc.update(999_999, input("X", Some(1))).await;
        assert!(
            matches!(result, Err(BantoError::NotFound { .. })),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn the_version_wraps_to_1_at_i64_max_instead_of_overflowing() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        // Refutable only with the `postgres` feature on.
        #[allow(irrefutable_let_patterns)]
        let Db::Sqlite(pool) = &svc.db
        else {
            unreachable!("migrate_memory is SQLite")
        };
        sqlx::query("UPDATE items SET version = ? WHERE id = ?")
            .bind(i64::MAX)
            .bind(created.id)
            .execute(pool)
            .await
            .unwrap();
        let updated = svc
            .update(created.id, input("B", Some(i64::MAX)))
            .await
            .unwrap();
        assert_eq!(updated.version, 1);
    }

    #[tokio::test]
    async fn concurrent_updates_with_the_same_version_let_exactly_one_win() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let (a, b) = tokio::join!(
            svc.update(created.id, input("First", Some(1))),
            svc.update(created.id, input("Second", Some(1))),
        );
        let wins = [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count();
        assert_eq!(wins, 1, "a: {a:?} / b: {b:?}");
        let loser = if a.is_ok() { b } else { a };
        assert!(matches!(loser, Err(BantoError::Conflict { .. })));
        assert_eq!(svc.get(created.id).await.unwrap().version, 2);
    }

    #[tokio::test]
    async fn delete_with_the_current_version_removes_the_row() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let removed = svc
            .delete_returning_previous(created.id, Some(1))
            .await
            .unwrap();
        assert_eq!(removed, created);
        assert!(matches!(
            svc.get(created.id).await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn delete_with_a_stale_version_conflicts_and_keeps_the_row() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let theirs = svc.update(created.id, input("Theirs", None)).await.unwrap();
        let (tx, mut rx) = broadcast::channel(4);
        let svc = svc.with_events(tx);
        let current = conflict_current(svc.delete_returning_previous(created.id, Some(1)).await);
        assert_eq!(current, serde_json::to_value(&theirs).unwrap());
        assert_eq!(svc.get(created.id).await.unwrap(), theirs);
        assert!(rx.try_recv().is_err(), "a conflict must not emit an event");
    }

    #[tokio::test]
    async fn delete_without_a_version_overwrites() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        svc.update(created.id, input("B", None)).await.unwrap();
        svc.delete_returning_previous(created.id, None)
            .await
            .unwrap();
        assert!(matches!(
            svc.get(created.id).await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn delete_missing_id_with_a_version_is_not_found_not_conflict() {
        let svc = service().await;
        let result = svc.delete_returning_previous(999_999, Some(1)).await;
        assert!(
            matches!(result, Err(BantoError::NotFound { .. })),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn import_update_overwrites_without_a_check_but_bumps_the_version() {
        let svc = service().await;
        let created = svc.create(input("A", None)).await.unwrap();
        let result = svc
            .import(vec![
                ItemImportRow {
                    id: Some(created.id),
                    name: "Imported".to_string(),
                    price: 5,
                    stock: 5,
                },
                ItemImportRow {
                    id: None,
                    name: "New".to_string(),
                    price: 5,
                    stock: 5,
                },
            ])
            .await
            .unwrap();
        assert!(result.errors.is_empty());
        assert_eq!(svc.get(created.id).await.unwrap().version, 2);
        let rows = svc.list(ListParams::default()).await.unwrap().rows;
        let new_row = rows.iter().find(|r| r.name == "New").unwrap();
        assert_eq!(new_row.version, 1);
        // A form still holding version 1 now conflicts.
        conflict_current(svc.update(created.id, input("Mine", Some(1))).await);
    }

    #[test]
    fn item_input_version_is_optional_on_the_wire() {
        let without: ItemInput =
            serde_json::from_value(serde_json::json!({ "name": "A", "price": 1, "stock": 1 }))
                .unwrap();
        assert_eq!(without.version, None);
        let null: ItemInput = serde_json::from_value(
            serde_json::json!({ "name": "A", "price": 1, "stock": 1, "version": null }),
        )
        .unwrap();
        assert_eq!(null.version, None);
        let some: ItemInput = serde_json::from_value(serde_json::json!({
            "name": "A", "price": 1, "stock": 1, "version": 7, "updatedAt": "2031-01-01"
        }))
        .unwrap();
        assert_eq!(some.version, Some(7));
    }

    // --- Issue #713: bulk delete -------------------------------------------

    fn ids_target(items: &[(i64, Option<i64>)]) -> BulkDeleteTarget {
        BulkDeleteTarget::Ids {
            items: items
                .iter()
                .map(|&(id, version)| BulkDeleteItem { id, version })
                .collect(),
        }
    }

    async fn total(svc: &ItemsService) -> u64 {
        svc.list(ListParams::default()).await.unwrap().total_count
    }

    #[tokio::test]
    async fn bulk_delete_by_ids_removes_exactly_those_rows_with_one_event() {
        let svc = service().await;
        let a = svc.create(input("A", None)).await.unwrap();
        let b = svc.create(input("B", None)).await.unwrap();
        let keep = svc.create(input("Keep", None)).await.unwrap();
        let (tx, mut rx) = broadcast::channel(8);
        let svc = svc.with_events(tx);

        // `b` carries no version: not checked, like a single delete.
        let deleted = svc
            .bulk_delete(&ids_target(&[(a.id, Some(1)), (b.id, None)]))
            .await
            .unwrap();
        assert_eq!(deleted, vec![a.id, b.id]);
        assert_eq!(total(&svc).await, 1);
        assert!(svc.get(keep.id).await.is_ok());
        rx.try_recv().expect("one event for the whole request");
        assert!(rx.try_recv().is_err(), "not one event per row");
    }

    #[tokio::test]
    async fn bulk_delete_by_ids_is_all_or_nothing() {
        let svc = service().await;
        let a = svc.create(input("A", None)).await.unwrap();
        let b = svc.create(input("B", None)).await.unwrap();
        let b = svc.update(b.id, input("B2", Some(1))).await.unwrap();
        assert_eq!(b.version, 2);
        let (tx, mut rx) = broadcast::channel(8);
        let svc = svc.with_events(tx);

        // A stale version on the LAST row still refuses the first one.
        let current = conflict_current(
            svc.bulk_delete(&ids_target(&[(a.id, Some(1)), (b.id, Some(1))]))
                .await,
        );
        assert_eq!(current["id"], b.id);
        assert_eq!(current["version"], 2);
        assert_eq!(total(&svc).await, 2);

        // A row that is already gone is a conflict too (no `current`).
        let missing = svc
            .bulk_delete(&ids_target(&[(a.id, Some(1)), (9_999, Some(1))]))
            .await;
        assert!(
            matches!(missing, Err(BantoError::Conflict { current: None, .. })),
            "{missing:?}"
        );
        assert_eq!(total(&svc).await, 2);
        assert!(rx.try_recv().is_err(), "a conflict must not emit an event");

        svc.bulk_delete(&ids_target(&[(a.id, Some(1)), (b.id, Some(2))]))
            .await
            .unwrap();
        assert_eq!(total(&svc).await, 0);
    }

    #[tokio::test]
    async fn bulk_delete_by_ids_spans_more_than_one_chunk() {
        let svc = service().await;
        let rows = (0..BULK_DELETE_CHUNK + 100)
            .map(|n| ItemImportRow {
                id: None,
                name: format!("Row {n}"),
                price: 1,
                stock: 1,
            })
            .collect();
        assert!(svc.import(rows).await.unwrap().errors.is_empty());
        let keep = svc.create(input("Keep", None)).await.unwrap();
        let all = svc.list(ListParams::default()).await.unwrap().rows;
        let target: Vec<(i64, Option<i64>)> = all
            .iter()
            .filter(|row| row.id != keep.id)
            .map(|row| (row.id, Some(row.version)))
            .collect();

        let deleted = svc.bulk_delete(&ids_target(&target)).await.unwrap();
        assert_eq!(deleted.len(), BULK_DELETE_CHUNK + 100);
        assert_eq!(total(&svc).await, 1);
    }

    #[tokio::test]
    async fn bulk_delete_rejects_empty_oversized_and_duplicate_targets() {
        let svc = service().await;
        let a = svc.create(input("A", None)).await.unwrap();
        let over = MAX_BULK_DELETE_ROWS as i64 + 1;
        let too_many: Vec<(i64, Option<i64>)> = (1..=over).map(|id| (id, None)).collect();
        for target in [
            ids_target(&[]),
            ids_target(&too_many),
            ids_target(&[(a.id, Some(1)), (a.id, Some(1))]),
        ] {
            let result = svc.bulk_delete(&target).await;
            assert!(
                matches!(result, Err(BantoError::BadRequest(_))),
                "{result:?}"
            );
        }
        assert_eq!(total(&svc).await, 1);
    }

    #[test]
    fn bulk_delete_target_wire_shape() {
        let ids: BulkDeleteTarget = serde_json::from_value(json!({
            "kind": "ids", "items": [{ "id": 1, "version": 3 }, { "id": 2 }]
        }))
        .unwrap();
        assert_eq!(ids, ids_target(&[(1, Some(3)), (2, None)]));
        // Neither a filter target (removed on purpose: a confirmed count
        // cannot tell a swapped row) nor an unknown kind is accepted.
        for bad in [
            json!({ "kind": "filter", "filters": [], "expectedCount": 2 }),
            json!({ "kind": "all" }),
        ] {
            assert!(serde_json::from_value::<BulkDeleteTarget>(bad).is_err());
        }
        assert_eq!(
            serde_json::to_value(BulkDeleteResult { deleted: 2 }).unwrap(),
            json!({ "deleted": 2 })
        );
    }

    #[test]
    fn bulk_delete_detail_bounds_ids() {
        assert_eq!(
            item_bulk_delete_detail(
                &ids_target(&[(1, Some(1)), (2, None)]),
                &[1, 2],
                Some(json!({ "attachmentsRemoved": 3 })),
            ),
            json!({ "mode": "ids", "count": 2, "ids": [1, 2], "attachmentsRemoved": 3 })
        );

        let many: Vec<i64> = (1..=BULK_DELETE_AUDIT_IDS as i64 + 1).collect();
        let truncated = item_bulk_delete_detail(&ids_target(&[]), &many, None);
        assert_eq!(truncated["count"], many.len());
        assert_eq!(
            truncated["ids"].as_array().unwrap().len(),
            BULK_DELETE_AUDIT_IDS
        );
        assert_eq!(truncated["idsTruncated"], true);
        assert!(truncated.get("changes").is_none(), "`changes` is reserved");

        assert!(truncated.get("filters").is_none());
    }
}
