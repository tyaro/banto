//! Banto storage: sqlx-based repository implementations (spec §12).
//!
//! - [`list_query`]: whitelist-based `ListParams` -> SQL (`WHERE`/
//!   `ORDER BY`/`LIMIT..OFFSET..`), shared by every resource's service layer
//!   so query construction is never duplicated (spec §10).
//! - [`error`]: `sqlx::Error` -> `banto_core::BantoError` mapping.
//! - [`sqlite`] (feature `sqlite`, default): SQLite connection helpers
//!   (WAL + foreign keys, spec §11.3).
//! - [`postgres`] (feature `postgres`): PostgreSQL connection helper (pooled,
//!   `postgres://` URL, database pre-provisioned - spec §12.1).
//!
//! PostgreSQL/TimescaleDB support (feature `postgres`) currently covers
//! `list_query`'s `Postgres` instantiation and the connection helper above;
//! the app service layer (`apps/admin-template/core`) remains SQLite-only by
//! design (spec §12.1/§548) - this crate is Postgres-connectable, but no
//! Postgres-backed resource is wired up yet.
//!
//! No `sqlx::query!`/`query_as!` compile-time macros are used anywhere in
//! this crate - only runtime queries, so building never requires a
//! `DATABASE_URL` (CI-friendly, spec's "no compile-time DB access" design).

pub mod error;
pub mod list_query;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "postgres")]
pub mod postgres;

pub use error::{not_found, storage_error};
pub use list_query::ColumnMap;

#[cfg(feature = "sqlite")]
pub use sqlite::{connect as connect_sqlite, connect_memory as connect_sqlite_memory};

#[cfg(feature = "postgres")]
pub use postgres::connect as connect_postgres;
