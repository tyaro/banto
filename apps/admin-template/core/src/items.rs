//! Items resource service (spec §8.2, §10): the domain logic behind the
//! `items` resource, callable directly from tests and from thin
//! `tauri::command` adapters in `src-tauri` alike. Field names on
//! [`ItemInput`] intentionally match the frontend schema
//! (`apps/admin-template/src/lib/banto/setup.ts`'s `itemsSchema`) field for
//! field, so `BantoError::Validation` field errors map back onto the right
//! form inputs.

use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::ServerEvent;
use banto_storage::ColumnMap;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
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
}

/// Create/update payload. Field names match the frontend form schema's
/// field names exactly (`name`, `price`, `stock`) so that
/// `BantoError::Validation`'s per-field messages land on the right inputs.
#[derive(Debug, Clone, Deserialize)]
pub struct ItemInput {
    pub name: String,
    pub price: i64,
    pub stock: i64,
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

fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .column("name", "name")
        .column("price", "price")
        .column("stock", "stock")
        .column("updatedAt", "updated_at")
}

const RESOURCE: &str = "items";

/// Service layer for the `items` resource (spec §10): the same methods a
/// REST handler would call in M6. No `tauri` dependency, so it is testable
/// in a plain `cargo test`.
///
/// `Clone` is cheap: `SqlitePool` and `broadcast::Sender` are both
/// `Arc`-backed handles, so the REST layer (`rest.rs`) can capture an owned
/// `ItemsService` in each route closure without wrapping it itself.
#[derive(Clone)]
pub struct ItemsService {
    pool: SqlitePool,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl ItemsService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool, events: None }
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

        let mut rows_builder: QueryBuilder<'_, Sqlite> =
            QueryBuilder::new("SELECT id, name, price, stock, updated_at FROM items");
        banto_storage::list_query::sqlite::apply_list_params(&mut rows_builder, &columns, &params)?;
        let rows: Vec<Item> = rows_builder
            .build_query_as::<Item>()
            .fetch_all(&self.pool)
            .await
            .map_err(banto_storage::storage_error)?;

        let mut count_builder: QueryBuilder<'_, Sqlite> =
            QueryBuilder::new("SELECT COUNT(*) FROM items");
        banto_storage::list_query::sqlite::append_where(
            &mut count_builder,
            &columns,
            &params.filters,
        )?;
        let total_count: i64 = count_builder
            .build_query_scalar()
            .fetch_one(&self.pool)
            .await
            .map_err(banto_storage::storage_error)?;

        Ok(ListResult {
            rows,
            total_count: total_count as u64,
        })
    }

    pub async fn get(&self, id: i64) -> Result<Item, BantoError> {
        sqlx::query_as::<_, Item>(
            "SELECT id, name, price, stock, updated_at FROM items WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|err| banto_storage::not_found(err, RESOURCE, id.to_string()))
    }

    pub async fn create(&self, input: ItemInput) -> Result<Item, BantoError> {
        validate_item_input(&input)?;
        let item = sqlx::query_as::<_, Item>(
            "INSERT INTO items (name, price, stock, updated_at) VALUES (?, ?, ?, date('now')) \
             RETURNING id, name, price, stock, updated_at",
        )
        .bind(input.name.trim())
        .bind(input.price)
        .bind(input.stock)
        .fetch_one(&self.pool)
        .await
        .map_err(banto_storage::storage_error)?;
        self.notify_changed();
        Ok(item)
    }

    pub async fn update(&self, id: i64, input: ItemInput) -> Result<Item, BantoError> {
        validate_item_input(&input)?;
        let item = sqlx::query_as::<_, Item>(
            "UPDATE items SET name = ?, price = ?, stock = ?, updated_at = date('now') WHERE id = ? \
             RETURNING id, name, price, stock, updated_at",
        )
        .bind(input.name.trim())
        .bind(input.price)
        .bind(input.stock)
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|err| banto_storage::not_found(err, RESOURCE, id.to_string()))?;
        self.notify_changed();
        Ok(item)
    }

    pub async fn delete(&self, id: i64) -> Result<(), BantoError> {
        let result = sqlx::query("DELETE FROM items WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(banto_storage::storage_error)?;
        if result.rows_affected() == 0 {
            return Err(BantoError::NotFound {
                resource: RESOURCE.to_string(),
                id: id.to_string(),
            });
        }
        self.notify_changed();
        Ok(())
    }
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
    async fn create_then_get_round_trips() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Test Item".to_string(),
                price: 100,
                stock: 5,
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
                },
            )
            .await
            .expect("update should succeed");
        assert_eq!(updated.name, "After");
        assert_eq!(updated.price, 20);
        assert_eq!(updated.stock, 2);
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
            })
            .await
            .expect("list should succeed");

        assert_eq!(result.total_count, 2); // Beta and Gamma match the filter
        assert_eq!(result.rows.len(), 1); // pagination limits the page to 1
        assert_eq!(result.rows[0].name, "Gamma"); // highest price first
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
}
