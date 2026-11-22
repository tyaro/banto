//! Database bootstrap for the admin-template app (spec §12): connect,
//! run embedded migrations, seed demo data on first run.

use banto_core::BantoError;
use banto_storage::Db;

use crate::backup::MigrationManifest;

// [scaffold:items] begin
const SEED_ROW_COUNT: usize = 1_000;
// [scaffold:items] end

/// Connect to the **SQLite** database at `path`, run migrations, and seed demo
/// data if the `items` table is empty. Used by the `src-tauri` adapter with a
/// path under the app's data directory - desktop is always local SQLite, so
/// this entry point stays SQLite-fixed (V2 "PostgreSQL アプリ全体対応": the
/// Postgres path is opt-in via [`init_db_from_target`], never here).
///
/// Returns a backend-agnostic [`Db`] handle: the service layer takes `Db`, not
/// a concrete pool. The migration/seed helpers dispatch on the handle's
/// backend, so this function simply builds the SQLite handle and hands it off.
pub async fn init_db(path: impl AsRef<std::path::Path>) -> Result<Db, BantoError> {
    let db = Db::connect_sqlite(path).await?;
    run_migrations_and_seed(&db).await?;
    Ok(db)
}

/// Connect using a backend selected by the `target` connection string, run the
/// matching migrations, and seed if empty (V2 "PostgreSQL アプリ全体対応", PR3).
///
/// Backend selection is by URL scheme: a `postgres://` / `postgresql://`
/// `target` opens a **PostgreSQL** backend (feature `postgres`); anything else
/// is treated as a **SQLite** filesystem path (the default, byte-for-byte
/// identical to [`init_db`]). This is what `bin/banto-serve.rs` calls with its
/// `BANTO_DB` env value, so pointing `BANTO_DB` at a `postgres://` URL is all
/// it takes to run the whole app on Postgres; a plain path keeps the existing
/// SQLite behavior untouched.
pub async fn init_db_from_target(target: &str) -> Result<Db, BantoError> {
    if is_postgres_url(target) {
        #[cfg(feature = "postgres")]
        {
            let db = Db::connect_postgres(target).await?;
            run_migrations_and_seed(&db).await?;
            Ok(db)
        }
        #[cfg(not(feature = "postgres"))]
        {
            Err(BantoError::Storage(format!(
                "connection target {:?} is a PostgreSQL URL but this build was compiled without the `postgres` feature",
                display_target(target)
            )))
        }
    } else {
        init_db(target).await
    }
}

/// Does `target` name a PostgreSQL server (vs. a SQLite filesystem path)?
/// Matches the two canonical libpq URL schemes.
///
/// `pub` so the single backend-selection rule lives here and is reused rather
/// than duplicated: `bin/banto-serve.rs` calls this to decide whether to skip
/// the SQLite-only startup restore (`BackupService::apply_pending_restore_at_startup`)
/// for a `BANTO_DB` that points at Postgres, keeping that guard in lock-step
/// with [`init_db_from_target`]'s own scheme check below.
pub fn is_postgres_url(target: &str) -> bool {
    target.starts_with("postgres://") || target.starts_with("postgresql://")
}

/// What [`display_target`] shows for a PostgreSQL URL it cannot take apart
/// safely.
pub const REDACTED_POSTGRES_TARGET: &str = "postgres://<redacted>";
/// What [`display_target`] shows for a non-PostgreSQL target that looks like
/// a connection string rather than a file path.
pub const REDACTED_TARGET: &str = "<redacted>";

/// `target` with its credentials removed, for logs and error messages (Issue
/// #208).
///
/// - A PostgreSQL URL (per [`is_postgres_url`]) is shown as
///   `scheme://host:port/database`: the user info (`user:password@`) and the
///   whole query string / fragment (`?password=` ...) are dropped. This only
///   happens when the URL has an unambiguous shape - the host part is a
///   plain host name / IP (optionally `[IPv6]`) with an all-digit port, and
///   no `@` follows the host part. Anything else, e.g. a password containing
///   an unescaped `/`, `?`, `#` or `@` (which makes the host part end inside
///   the credentials), becomes the fixed [`REDACTED_POSTGRES_TARGET`] that
///   contains nothing of the input.
/// - Anything else is a SQLite file path and shown as-is - unless it contains
///   `://` or `@` (a mistyped connection string such as `Postgres://...` or
///   `user:pw@host/db`), which becomes the fixed [`REDACTED_TARGET`].
pub fn display_target(target: &str) -> String {
    if !is_postgres_url(target) {
        if target.contains("://") || target.contains('@') {
            return REDACTED_TARGET.to_string();
        }
        return target.to_string();
    }
    display_postgres_url(target).unwrap_or_else(|| REDACTED_POSTGRES_TARGET.to_string())
}

/// The credential-free form of a PostgreSQL URL, or `None` if its shape is
/// not unambiguous (see [`display_target`]).
fn display_postgres_url(target: &str) -> Option<String> {
    let (scheme, rest) = target.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    // An `@` after the authority means the authority ended early - inside the
    // credentials - so we cannot tell which part is the host.
    if tail.contains('@') {
        return None;
    }
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if !is_plain_host_port(host_port) {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("");
    let path_is_plain = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '%'));
    if !path_is_plain {
        return None;
    }
    Some(format!("{scheme}://{host_port}{path}"))
}

/// `host`, `host:port`, `[v6]` or `[v6]:port` (empty allowed - libpq's
/// default host), with a host of name/IP characters and an all-digit port.
fn is_plain_host_port(value: &str) -> bool {
    let (host, port) = if let Some(bracketed) = value.strip_prefix('[') {
        let Some((v6, after)) = bracketed.split_once(']') else {
            return false;
        };
        if !v6
            .chars()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.' | '%'))
        {
            return false;
        }
        match after.strip_prefix(':') {
            Some(port) => ("", Some(port)),
            None if after.is_empty() => ("", None),
            None => return false,
        }
    } else {
        match value.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (value, None),
        }
    };
    let host_is_plain = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '%'));
    let port_is_plain = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    host_is_plain && port_is_plain
}

/// Same as [`init_db`] but against a private in-memory SQLite database. Used by
/// tests so each test gets an isolated, migrated, seeded database.
pub async fn init_db_memory() -> Result<Db, BantoError> {
    let db = Db::connect_sqlite_memory().await?;
    run_migrations_and_seed(&db).await?;
    Ok(db)
}

/// A migrated but *unseeded* in-memory database. Used by `items` service
/// tests that need full control over which rows exist (e.g. asserting a
/// specific id is absent), where the 1,000-row demo seed from
/// [`init_db_memory`] would collide with test fixture ids.
#[cfg(test)]
pub(crate) async fn migrate_memory() -> Result<Db, BantoError> {
    let db = Db::connect_sqlite_memory().await?;
    run_migrations(&db).await?;
    Ok(db)
}

/// Last migration of the v8.0.0 baseline (ADR-0034 §9): `0014_ui_settings`.
/// A restore candidate must have every migration up to this one applied; a
/// derived app's own later migrations may still be pending in it.
pub const BASELINE_MIGRATION_VERSION: i64 = 14;

/// The embedded SQLite migrations as the restore validation wants them
/// (ADR-0034 §9): the wiring passes this to
/// [`BackupService::with_migrations`](crate::backup::BackupService::with_migrations)
/// and `apply_pending_restore_at_startup`. SQLite only - backup/restore has no
/// PostgreSQL side.
pub fn sqlite_migration_manifest() -> MigrationManifest {
    MigrationManifest::new(
        sqlx::migrate!("./migrations-sqlite")
            .iter()
            .filter(|migration| !migration.migration_type.is_down_migration())
            .map(|migration| (migration.version, migration.checksum.to_vec())),
        BASELINE_MIGRATION_VERSION,
    )
}

/// What the operator reads when the database was created by a version before
/// the v8.0.0 baseline rebuild (ADR-0034 §9). There is no data migration.
const PRE_V8_DATABASE_MESSAGE: &str =
    "この DB は v8.0.0 より前の版のものです。読めません。DB を作り直してください";

/// The migration v8.0.0 rewrote first in version order (`0003_users.sql`), and
/// the checksum (sqlx: SHA-384 of the file, lowercase hex) of the text v7.11.0
/// shipped, per dialect. A database that has exactly this recorded for
/// version 3 is a known pre-v8 database.
const V7_USERS_MIGRATION_VERSION: i64 = 3;
const V7_USERS_CHECKSUM_SQLITE: &str =
    "25f4a5973321cc81959ce2f2e211df45acdfa0d0e9db30db155dd3ac62a36b00b82edbf393ac250b4867e2a30e1b1240";
#[cfg(feature = "postgres")]
const V7_USERS_CHECKSUM_POSTGRES: &str =
    "66855aa6c0a663fbec1ac2b749477b07655b094492e5f8481eb0ae708584ee350522777beacd8090738b40a4121ad477";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The checksum the database recorded for the migration `version`, as hex.
/// `None` when it cannot be read (the answer then is "cannot tell").
async fn applied_checksum(db: &Db, version: i64) -> Option<String> {
    let bytes: Option<Vec<u8>> = match db {
        Db::Sqlite(pool) => {
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                .bind(version)
                .fetch_optional(pool)
                .await
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                .bind(version)
                .fetch_optional(pool)
                .await
        }
    }
    .ok()
    .flatten();
    bytes.as_deref().map(hex)
}

/// Turn a failed migration run into what the operator reads.
///
/// sqlx compares the checksum of every applied migration with the embedded
/// one, in version order, before it applies anything newer, and stops with
/// `VersionMismatch` at the first difference - the database is not changed.
/// Two cases are told apart (the remedy differs):
///
/// - **A known pre-v8 database**: the mismatch is at `0003` and the database
///   recorded v7.11.0's checksum for it. v8.0.0 rewrote that file and has no
///   data migration (ADR-0034 §9): the explicit "recreate the database".
/// - **Anything else** (another build, a hand-edited migration file, a damaged
///   history): cannot be told, so nothing here suggests discarding the
///   database. The message names the migration and says the data is untouched.
async fn migration_error(db: &Db, err: sqlx::migrate::MigrateError) -> BantoError {
    let sqlx::migrate::MigrateError::VersionMismatch(version) = err else {
        return BantoError::Storage(err.to_string());
    };
    let v7_checksum = match db {
        Db::Sqlite(_) => V7_USERS_CHECKSUM_SQLITE,
        #[cfg(feature = "postgres")]
        Db::Postgres(_) => V7_USERS_CHECKSUM_POSTGRES,
    };
    let is_pre_v8 = version == V7_USERS_MIGRATION_VERSION
        && applied_checksum(db, version).await.as_deref() == Some(v7_checksum);
    if is_pre_v8 {
        return BantoError::Storage(PRE_V8_DATABASE_MESSAGE.to_string());
    }
    BantoError::Storage(format!(
        "migration {version} の内容が、この DB に適用済みのものと違います。DB は変更していません。\
         別の版・別のビルドのアプリで作った DB か、migration のファイルが書き換えられています。\
         DB は消さずに、この DB を作った版のアプリで開くか、migration {version} のファイルを元に戻してください"
    ))
}

/// Run the embedded migrations matching the handle's backend. The two migration
/// sets are byte-distinct SQL (`migrations-sqlite/` is the SQLite DDL;
/// `migrations-postgres/` is the strict-typed Postgres port), so each backend
/// embeds and runs its own.
async fn run_migrations(db: &Db) -> Result<(), BantoError> {
    let result = match db {
        Db::Sqlite(pool) => sqlx::migrate!("./migrations-sqlite").run(pool).await,
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => sqlx::migrate!("./migrations-postgres").run(pool).await,
    };
    match result {
        Ok(()) => Ok(()),
        Err(err) => Err(migration_error(db, err).await),
    }
}

async fn run_migrations_and_seed(db: &Db) -> Result<(), BantoError> {
    run_migrations(db).await?;
    // [scaffold:items] begin
    seed_if_empty(db).await?;
    // [scaffold:items] end
    Ok(())
}

// [scaffold:items] begin
//
// D1-d (display-preset-plan.md, Issue #190 prep): the `items` demo-seed
// generator (row-count check, the deterministic mulberry32 PRNG port, the
// product tables, and `generate_sample_items` itself) - everything below is
// items-only, contiguous through the end of `generate_sample_items`, so a
// future `display`/`items` remover can delete it with one `cutRegion`.

async fn seed_if_empty(db: &Db) -> Result<(), BantoError> {
    let count: i64 = match db {
        Db::Sqlite(pool) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM items")
                .fetch_one(pool)
                .await
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM items")
                .fetch_one(pool)
                .await
        }
    }
    .map_err(banto_storage::storage_error)?;
    if count > 0 {
        return Ok(());
    }

    let rows = generate_sample_items(SEED_ROW_COUNT);
    // Positional placeholders via the shared `Dialect` helper so the same
    // INSERT text works on both backends (`?` on SQLite, `$1..$5` on Postgres).
    let dialect = db.dialect();
    // AssertSqlSafe: only `dialect.placeholder(n)` is interpolated
    // (internal enum, never caller input); each row's fields are bound
    // below. `.as_str()` (not moving `insert_sql`) because this statement is
    // reused across every iteration of the loops below.
    let insert_sql = format!(
        "INSERT INTO items (id, name, price, stock, updated_at) VALUES ({}, {}, {}, {}, {})",
        dialect.placeholder(1),
        dialect.placeholder(2),
        dialect.placeholder(3),
        dialect.placeholder(4),
        dialect.placeholder(5),
    );

    match db {
        Db::Sqlite(pool) => {
            let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
            for row in &rows {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql.as_str()))
                    .bind(row.id)
                    .bind(&row.name)
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(&row.updated_at)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            tx.commit().await.map_err(banto_storage::storage_error)?;
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
            for row in &rows {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql.as_str()))
                    .bind(row.id)
                    .bind(&row.name)
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(&row.updated_at)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            tx.commit().await.map_err(banto_storage::storage_error)?;
            // The seed inserted explicit ids 1..=N into a `GENERATED BY DEFAULT
            // AS IDENTITY` column, which does NOT advance the identity sequence.
            // Without this, the next app INSERT (which omits `id`) would try to
            // generate id=1 and collide. `setval(..., MAX(id))` moves the
            // sequence past the seed so the first real insert gets N+1. SQLite's
            // AUTOINCREMENT tracks this from the explicit inserts automatically,
            // so this fix-up is Postgres-only.
            sqlx::query(
                "SELECT setval(pg_get_serial_sequence('items', 'id'), (SELECT MAX(id) FROM items))",
            )
            .execute(pool)
            .await
            .map_err(banto_storage::storage_error)?;
        }
    }
    Ok(())
}

struct SeedItem {
    id: i64,
    name: String,
    price: i64,
    stock: i64,
    updated_at: String,
}

/// mulberry32: small, fast, deterministic PRNG (no runtime dependency).
/// Ported 1:1 from `apps/admin-template/src/lib/banto/sampleData.ts` so the
/// two seed generators (TS `InMemoryDataProvider` seed data, Rust SQLite
/// seed data) use the exact same algorithm and per-row draw order - only
/// the row count and destination differ.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Returns a float in `[0, 1)`, matching the TS implementation's
    /// `>>> 0) / 4294967296` normalization.
    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

const PRODUCT_BASES: [&str; 12] = [
    "緑茶",
    "ほうじ茶",
    "麦茶",
    "烏龍茶",
    "紅茶",
    "コーヒー",
    "抹茶ラテ",
    "レモネード",
    "炭酸水",
    "スポーツドリンク",
    "オレンジジュース",
    "アップルジュース",
];

const PRODUCT_SIZES: [&str; 6] = ["280ml", "350ml", "500ml", "600ml", "1L", "2L"];

fn base_unit_price(base: &str) -> i64 {
    match base {
        "緑茶" => 140,
        "ほうじ茶" => 140,
        "麦茶" => 120,
        "烏龍茶" => 150,
        "紅茶" => 160,
        "コーヒー" => 130,
        "抹茶ラテ" => 220,
        "レモネード" => 180,
        "炭酸水" => 110,
        "スポーツドリンク" => 170,
        "オレンジジュース" => 190,
        "アップルジュース" => 190,
        _ => unreachable!("all PRODUCT_BASES entries are covered above"),
    }
}

const SEED: u32 = 0x8a17c05;
// Fixed "today" for deterministic output regardless of when the app runs
// (matches sampleData.ts's UPDATED_AT_END = Date.UTC(2026, 6, 2)).
const UPDATED_AT_END_DAYS_SINCE_EPOCH: i64 = 20636; // 2026-07-02 UTC
const UPDATED_AT_SPAN_DAYS: i64 = 900; // ~2.5 years of history

/// Port of `generateSampleItems` (`apps/admin-template/src/lib/banto/sampleData.ts`):
/// same PRNG, same product tables, same per-row draw order, so the first
/// `count` rows are identical to the TS dataset's first `count` rows.
fn generate_sample_items(count: usize) -> Vec<SeedItem> {
    let mut random = Mulberry32::new(SEED);
    let mut rows = Vec::with_capacity(count);

    for i in 0..count {
        let id = (i + 1) as i64;
        let base = PRODUCT_BASES[(random.next() * PRODUCT_BASES.len() as f64).floor() as usize];
        let size = PRODUCT_SIZES[(random.next() * PRODUCT_SIZES.len() as f64).floor() as usize];
        let lot = random.next();
        let name = if lot < 0.15 {
            format!("{base} {size} 数量限定")
        } else {
            format!("{base} {size}")
        };

        let unit_price = base_unit_price(base);
        let price_jitter = ((random.next() * 40.0 - 20.0) / 10.0).round() as i64 * 10; // -20..+20, rounded to 10
        let price = (unit_price + price_jitter).max(50);

        let stock = (random.next() * 500.0).floor() as i64;

        let days_ago = (random.next() * UPDATED_AT_SPAN_DAYS as f64).floor() as i64;
        let updated_at_days = UPDATED_AT_END_DAYS_SINCE_EPOCH - days_ago;
        let updated_at = banto_core::datetime::iso_date_from_days_since_epoch(updated_at_days);

        rows.push(SeedItem {
            id,
            name,
            price,
            stock,
            updated_at,
        });
    }

    rows
}
// [scaffold:items] end

#[cfg(test)]
mod tests {
    use super::*;

    // [scaffold:items] begin (demo-seed tests; `postgres_url_detection_*`
    // below stays outside - it tests generic backend selection, not the seed)

    #[test]
    fn iso_date_round_trips_known_epoch_days() {
        assert_eq!(
            banto_core::datetime::iso_date_from_days_since_epoch(0),
            "1970-01-01"
        );
        assert_eq!(
            banto_core::datetime::iso_date_from_days_since_epoch(1),
            "1970-01-02"
        );
        assert_eq!(
            banto_core::datetime::iso_date_from_days_since_epoch(-1),
            "1969-12-31"
        );
        // 2026-07-02 is the fixed "today" used by the seed generator.
        assert_eq!(
            banto_core::datetime::iso_date_from_days_since_epoch(UPDATED_AT_END_DAYS_SINCE_EPOCH),
            "2026-07-02"
        );
    }

    #[test]
    fn generate_sample_items_is_deterministic() {
        let a = generate_sample_items(50);
        let b = generate_sample_items(50);
        assert_eq!(a.len(), 50);
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.id, y.id);
            assert_eq!(x.name, y.name);
            assert_eq!(x.price, y.price);
            assert_eq!(x.stock, y.stock);
            assert_eq!(x.updated_at, y.updated_at);
        }
    }

    #[test]
    fn generate_sample_items_produces_plausible_rows() {
        let rows = generate_sample_items(200);
        for row in &rows {
            assert!(row.price >= 50);
            assert!(row.stock >= 0 && row.stock < 500);
            assert_eq!(row.updated_at.len(), 10); // YYYY-MM-DD
        }
    }

    #[tokio::test]
    async fn init_db_memory_migrates_and_seeds_exactly_once() {
        let db = init_db_memory()
            .await
            .expect("init_db_memory should succeed");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(db.as_sqlite().expect("sqlite handle"))
            .await
            .unwrap();
        assert_eq!(count, SEED_ROW_COUNT as i64);
    }

    #[tokio::test]
    async fn seeding_is_idempotent_across_two_inits_on_the_same_db() {
        let db = Db::connect_sqlite_memory().await.unwrap();
        run_migrations_and_seed(&db).await.unwrap();
        run_migrations_and_seed(&db).await.unwrap(); // second init: must not double-seed
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(db.as_sqlite().expect("sqlite handle"))
            .await
            .unwrap();
        assert_eq!(count, SEED_ROW_COUNT as i64);
    }

    // [scaffold:items] end

    #[test]
    fn postgres_url_detection_selects_backend_by_scheme() {
        assert!(is_postgres_url("postgres://user:pass@localhost/db"));
        assert!(is_postgres_url("postgresql://localhost/db"));
        assert!(!is_postgres_url("./banto-dev.sqlite3"));
        assert!(!is_postgres_url("/var/lib/banto/app.sqlite3"));
        assert!(!is_postgres_url("C:\\data\\app.sqlite3"));
    }

    /// Issue #208: what `banto-serve` prints for `BANTO_DB` carries no
    /// credentials.
    #[test]
    fn display_target_drops_postgres_credentials() {
        let cases = [
            (
                "postgres://review_user:example_password@localhost:5432/banto_a",
                "postgres://localhost:5432/banto_a",
            ),
            (
                "postgresql://u:p%40ss@db.example/banto?sslmode=require&password=q",
                "postgresql://db.example/banto",
            ),
            ("postgres://u:p@[::1]:5432", "postgres://[::1]:5432"),
            (
                "postgres://localhost/db?user=x&password=y",
                "postgres://localhost/db",
            ),
            ("postgres://a@b:c@host/db", "postgres://host/db"),
            ("postgres:///banto", "postgres:///banto"),
            ("postgres://host", "postgres://host"),
            ("./banto-dev.sqlite3", "./banto-dev.sqlite3"),
            ("C:\\data\\app.sqlite3", "C:\\data\\app.sqlite3"),
            ("/var/lib/banto/app.sqlite3", "/var/lib/banto/app.sqlite3"),
        ];
        for (target, expected) in cases {
            assert_eq!(display_target(target), expected, "{target}");
        }
    }

    /// Review of #233 (3): malformed connection strings - an unescaped `?`,
    /// `#`, `/` or `@` inside the credentials, a missing or mistyped scheme -
    /// never let a secret through; they fall back to a fixed text.
    #[test]
    fn display_target_redacts_what_it_cannot_parse_safely() {
        const SECRET: &str = "ExampleSecret";
        let cases = [
            (
                "postgres://alice:ExampleSecret?tail@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://alice:ExampleSecret#tail@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://alice:Example/Secret@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgresql://alice:ExampleSecret?a#b@localhost:5432/db?x=1",
                REDACTED_POSTGRES_TARGET,
            ),
            // No `@` at all: the credentials would be read as host:port.
            ("postgres://alice:ExampleSecret", REDACTED_POSTGRES_TARGET),
            (
                "postgres://alice:ExampleSecret/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://u:p@[::1:ExampleSecret",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://u:p@host/db name ExampleSecret",
                REDACTED_POSTGRES_TARGET,
            ),
            // Mistyped or missing scheme: not PostgreSQL, but not a path either.
            (
                "Postgres://alice:ExampleSecret@localhost/db",
                REDACTED_TARGET,
            ),
            (
                "postgres:/alice:ExampleSecret@localhost/db",
                REDACTED_TARGET,
            ),
            ("alice:ExampleSecret@localhost:5432/db", REDACTED_TARGET),
            ("mysql://alice:ExampleSecret@localhost/db", REDACTED_TARGET),
        ];
        for (target, expected) in cases {
            let shown = display_target(target);
            assert_eq!(shown, expected, "{target}");
            assert!(
                !shown.contains(SECRET) && !shown.contains("alice"),
                "{target}"
            );
        }
    }

    /// Review of #233 (3): the one error that prints `BANTO_DB` - a PostgreSQL
    /// URL given to a build without the `postgres` feature - keeps no secret,
    /// even for a malformed URL.
    #[cfg(not(feature = "postgres"))]
    #[tokio::test]
    async fn postgres_url_without_the_feature_errors_without_the_secret() {
        for target in [
            "postgres://alice:ExampleSecret@localhost/db",
            "postgres://alice:ExampleSecret?tail@localhost/db",
            "postgres://alice:ExampleSecret#tail@localhost/db",
        ] {
            let err = match init_db_from_target(target).await {
                Ok(_) => panic!("{target}: a build without `postgres` must refuse"),
                Err(err) => err,
            };
            let text = format!("{err} {err:?}");
            assert!(text.contains("postgres"), "{text}");
            assert!(
                !text.contains("ExampleSecret") && !text.contains("alice"),
                "{text}"
            );
        }
    }

    // --- v8.0.0 baseline rebuild (ADR-0034 §2/§9, plan §4.1) ---------------

    const V7_USERS: &str = include_str!("../tests/fixtures/v7.11.0/sqlite-0003_users.sql");
    const V7_AUDIT_LOG: &str = include_str!("../tests/fixtures/v7.11.0/sqlite-0005_audit_log.sql");

    /// The migrator v7.11.0 shipped: 0001-0013 with the original text of
    /// `0003_users.sql` / `0005_audit_log.sql` (the two files v8.0.0 rewrote).
    fn v7_migrator() -> sqlx::migrate::Migrator {
        use sqlx::migrate::Migration;
        use sqlx::SqlSafeStr;
        let mut migrator = sqlx::migrate!("./migrations-sqlite");
        migrator.migrations = migrator
            .migrations
            .iter()
            .filter(|m| m.version < BASELINE_MIGRATION_VERSION)
            .map(|m| {
                let old = match m.version {
                    3 => V7_USERS,
                    5 => V7_AUDIT_LOG,
                    _ => return m.clone(),
                };
                Migration::new(
                    m.version,
                    m.description.clone(),
                    m.migration_type,
                    sqlx::AssertSqlSafe(old).into_sql_str(),
                    m.no_tx,
                )
            })
            .collect::<Vec<_>>()
            .into();
        migrator
    }

    /// A v7.11.0 database file at `path`, with one account, closed.
    async fn v7_database_file(path: &std::path::Path) {
        let db = Db::connect_sqlite(path).await.unwrap();
        let pool = db.as_sqlite().unwrap();
        v7_migrator().run(pool).await.expect("the v7.11.0 schema");
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, role) \
             VALUES ('existing', 'unused', '既存', 'admin')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(pool)
            .await
            .unwrap();
        pool.close().await;
    }

    async fn column_names(pool: &sqlx::SqlitePool, table: &str) -> Vec<String> {
        // `table` is a literal of this test module.
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT name FROM pragma_table_xinfo('{table}') ORDER BY cid"
        )))
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn index_names(pool: &sqlx::SqlitePool, table: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? \
             AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Plan §4.1: a new database has exactly one built-in `admin`, the CHECKs
    /// refuse a malformed row, and a second built-in row cannot be inserted.
    #[tokio::test]
    async fn a_new_database_has_one_builtin_admin_and_the_row_shapes_are_enforced() {
        let db = migrate_memory().await.unwrap();
        let pool = db.as_sqlite().unwrap();
        type Row = (String, String, String, Option<String>, Option<String>);
        let rows: Vec<Row> =
            sqlx::query_as("SELECT username, kind, role, password_hash, account_uid FROM users")
                .fetch_all(pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![(
                "admin".to_string(),
                "builtin".to_string(),
                "admin".to_string(),
                None,
                None
            )]
        );

        for (what, sql) in [
            (
                "a second built-in row",
                "INSERT INTO users (username, display_name, kind) VALUES ('admin2', 'x', 'builtin')",
            ),
            (
                "an account without account_uid",
                "INSERT INTO users (username, password_hash, display_name) VALUES ('a', 'h', 'x')",
            ),
            (
                "an account without a password hash",
                "INSERT INTO users (username, display_name, account_uid) VALUES ('a', 'x', 'u1')",
            ),
            (
                "a built-in row with a password hash",
                "INSERT INTO users (username, password_hash, display_name, kind) \
                 VALUES ('b', 'h', 'x', 'builtin')",
            ),
            (
                "a built-in row with an account_uid",
                "INSERT INTO users (username, display_name, kind, account_uid) \
                 VALUES ('b', 'x', 'builtin', 'u1')",
            ),
            (
                "an unknown kind",
                "INSERT INTO users (username, password_hash, display_name, kind, account_uid) \
                 VALUES ('c', 'h', 'x', 'other', 'u1')",
            ),
        ] {
            assert!(sqlx::query(sql).execute(pool).await.is_err(), "{what}");
        }
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, account_uid) \
             VALUES ('ok', 'h', 'x', 'u1')",
        )
        .execute(pool)
        .await
        .expect("a well-formed account row");
        assert!(
            sqlx::query(
                "INSERT INTO users (username, password_hash, display_name, account_uid) \
                 VALUES ('dup', 'h', 'x', 'u1')",
            )
            .execute(pool)
            .await
            .is_err(),
            "account_uid is unique"
        );
    }

    /// Plan §4.1 (ui_settings): an account's rows need the matching `user_id`
    /// and go away with the account (the foreign key is enforced on this
    /// connection); a synthetic owner has no `user_id`.
    #[tokio::test]
    async fn ui_settings_rows_are_tied_to_their_owner() {
        let db = migrate_memory().await.unwrap();
        let pool = db.as_sqlite().unwrap();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (username, password_hash, display_name, account_uid) \
             VALUES ('op', 'h', 'x', 'u1') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let insert = "INSERT INTO ui_settings (owner, key, value, revision, user_id) \
                      VALUES (?, 'k', 'v', 'r', ?)";
        for (owner, user_id, ok) in [
            (format!("acct:{id}"), Some(id), true),
            ("local".to_string(), None, true),
            ("grant:public".to_string(), None, true),
            (format!("acct:{id}x"), Some(id), false),
            (format!("acct:{id}"), None, false),
            ("local".to_string(), Some(id), false),
            ("acct:999".to_string(), Some(999), false),
        ] {
            let result = sqlx::query(insert)
                .bind(&owner)
                .bind(user_id)
                .execute(pool)
                .await;
            // The first three rows are also the fixture of the delete below.
            assert_eq!(result.is_ok(), ok, "owner {owner:?} user_id {user_id:?}");
        }
        sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        let owners: Vec<String> =
            sqlx::query_scalar("SELECT owner FROM ui_settings ORDER BY owner")
                .fetch_all(pool)
                .await
                .unwrap();
        assert_eq!(owners, ["grant:public", "local"]);
    }

    /// Plan §4.1 "リスク" (one-off): the rewrite of 0003/0005 dropped nothing.
    /// Against the v7.11.0 schema, the only differences are the new columns
    /// and the built-in row's index.
    #[tokio::test]
    async fn the_baseline_rewrite_only_adds_the_intended_columns_and_index() {
        let old = Db::connect_sqlite_memory().await.unwrap();
        let old_pool = old.as_sqlite().unwrap();
        v7_migrator().run(old_pool).await.unwrap();
        let new = Db::connect_sqlite_memory().await.unwrap();
        let new_pool = new.as_sqlite().unwrap();
        sqlx::migrate!("./migrations-sqlite")
            .run_to(BASELINE_MIGRATION_VERSION - 1, new_pool)
            .await
            .unwrap();

        for (table, added_columns, added_indexes) in [
            (
                "users",
                vec!["kind", "account_uid"],
                vec!["idx_users_single_builtin"],
            ),
            ("audit_log", vec!["actor_id"], vec![]),
        ] {
            let old_columns = column_names(old_pool, table).await;
            let new_columns = column_names(new_pool, table).await;
            let kept: Vec<&String> = new_columns
                .iter()
                .filter(|c| !added_columns.contains(&c.as_str()))
                .collect();
            let mut old_sorted: Vec<&String> = old_columns.iter().collect();
            let mut kept_sorted = kept.clone();
            old_sorted.sort();
            kept_sorted.sort();
            assert_eq!(kept_sorted, old_sorted, "{table}: no column lost");
            assert_eq!(
                new_columns.len(),
                old_columns.len() + added_columns.len(),
                "{table}: exactly the intended columns were added"
            );
            let old_indexes = index_names(old_pool, table).await;
            let mut expected = old_indexes.clone();
            expected.extend(added_indexes.iter().map(|s| s.to_string()));
            expected.sort();
            assert_eq!(index_names(new_pool, table).await, expected, "{table}");
        }
        // Every other table is byte-for-byte the same definition.
        let other_tables = "SELECT name, sql FROM sqlite_master \
             WHERE tbl_name NOT IN ('users', 'audit_log', '_sqlx_migrations') ORDER BY name";
        let old_rest: Vec<(String, Option<String>)> = sqlx::query_as(other_tables)
            .fetch_all(old_pool)
            .await
            .unwrap();
        let new_rest: Vec<(String, Option<String>)> = sqlx::query_as(other_tables)
            .fetch_all(new_pool)
            .await
            .unwrap();
        assert_eq!(new_rest, old_rest);
    }

    /// Plan §4.1 / §9.1: opening a v7.11.0 database stops with the explicit
    /// message BEFORE `0014` is applied - the schema is unchanged.
    #[tokio::test]
    async fn a_v7_database_is_refused_before_any_new_migration_touches_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("admin-template.sqlite3");
        v7_database_file(&path).await;
        let err = init_db(&path).await.expect_err("a v7 database is refused");
        let message = err.to_string();
        assert!(message.contains("v8.0.0 より前の版"), "{message}");
        assert!(message.contains("DB を作り直してください"), "{message}");

        let db = Db::connect_sqlite(&path).await.unwrap();
        let pool = db.as_sqlite().unwrap();
        let ui_settings: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ui_settings'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(ui_settings, 0, "0014 was not applied");
        assert!(!column_names(pool, "users")
            .await
            .contains(&"kind".to_string()));
        let applied: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(applied, 13);
        let users: Vec<String> = sqlx::query_scalar("SELECT username FROM users")
            .fetch_all(pool)
            .await
            .unwrap();
        assert_eq!(users, ["existing"]);
        pool.close().await;
    }

    /// The constant in the startup check is the checksum sqlx computes for the
    /// v7.11.0 text of `0003_users.sql`.
    #[test]
    fn the_known_v7_checksum_is_the_checksum_of_the_v7_users_migration() {
        let v7 = v7_migrator();
        let users = v7
            .iter()
            .find(|m| m.version == V7_USERS_MIGRATION_VERSION)
            .unwrap();
        assert_eq!(hex(&users.checksum), V7_USERS_CHECKSUM_SQLITE);
    }

    /// A checksum mismatch that is NOT the known v7 history (another build, an
    /// edited file, a damaged history) does not tell the operator to recreate
    /// the database: it names the migration and leaves the data alone.
    #[tokio::test]
    async fn an_unexplained_checksum_mismatch_does_not_suggest_recreating_the_database() {
        let dir = tempfile::tempdir().unwrap();
        for (version, checksum) in [(2_i64, "x'00'"), (V7_USERS_MIGRATION_VERSION, "x'00'")] {
            let path = dir.path().join(format!("mismatch-{version}.sqlite3"));
            let db = init_db(&path).await.unwrap();
            let pool = db.as_sqlite().unwrap();
            // `checksum` is a literal of this test.
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE _sqlx_migrations SET checksum = {checksum} WHERE version = {version}"
            )))
            .execute(pool)
            .await
            .unwrap();
            let users_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(pool)
                .await
                .unwrap();
            pool.close().await;

            let message = init_db(&path)
                .await
                .expect_err("a mismatch stops the start")
                .to_string();
            assert!(!message.contains("v8.0.0 より前"), "{message}");
            assert!(!message.contains("作り直し"), "{message}");
            assert!(
                message.contains(&format!("migration {version} の内容")),
                "{message}"
            );
            assert!(message.contains("DB は変更していません"), "{message}");

            let db = Db::connect_sqlite(&path).await.unwrap();
            let pool = db.as_sqlite().unwrap();
            let users_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(pool)
                .await
                .unwrap();
            assert_eq!(users_after, users_before);
            pool.close().await;
        }
    }

    /// ADR-0034 §9 (regression): a candidate that has every required table and
    /// a clean `integrity_check` but v7 checksums is (1) refused at staging,
    /// (2) not applied when placed as the pending file by hand - the current
    /// database's bytes are unchanged - and (3) the next startup succeeds.
    /// The same holds for a candidate with a migration this app does not have,
    /// and for one that lacks part of the baseline.
    #[tokio::test]
    async fn a_restore_candidate_with_a_foreign_migration_history_never_replaces_the_database() {
        use crate::backup::BackupService;

        let dir = tempfile::tempdir().unwrap();

        // v7 checksums, plus the table a v7 file lacks: only the history
        // check can refuse it.
        let v7_path = dir.path().join("v7.sqlite3");
        v7_database_file(&v7_path).await;
        {
            let db = Db::connect_sqlite(&v7_path).await.unwrap();
            let pool = db.as_sqlite().unwrap();
            sqlx::query("CREATE TABLE ui_settings (owner TEXT)")
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(pool)
                .await
                .unwrap();
            pool.close().await;
        }
        // A newer version's file: one migration this app does not know.
        let newer_path = dir.path().join("newer.sqlite3");
        {
            let db = init_db(&newer_path).await.unwrap();
            let pool = db.as_sqlite().unwrap();
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (9999, 'from the future', 1, x'00', 0)",
            )
            .execute(pool)
            .await
            .unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(pool)
                .await
                .unwrap();
            pool.close().await;
        }
        // Part of the baseline missing (0014 not applied), `ui_settings` made
        // by hand.
        let partial_path = dir.path().join("partial.sqlite3");
        {
            let db = Db::connect_sqlite(&partial_path).await.unwrap();
            let pool = db.as_sqlite().unwrap();
            sqlx::migrate!("./migrations-sqlite")
                .run_to(BASELINE_MIGRATION_VERSION - 1, pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE ui_settings (owner TEXT)")
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let db_path = dir.path().join("admin-template.sqlite3");
        let pending = dir
            .path()
            .join("backups")
            .join("admin-template.sqlite3")
            .join("restore-pending.sqlite3");
        for candidate in [&v7_path, &newer_path, &partial_path] {
            let bytes = tokio::fs::read(candidate).await.unwrap();
            let current = init_db(&db_path).await.unwrap();
            let pool = current.as_sqlite().unwrap().clone();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&pool)
                .await
                .unwrap();

            // (1) Staging refuses it.
            let err = BackupService::new(db_path.clone(), current.clone())
                .with_migrations(sqlite_migration_manifest())
                .stage_restore_from_bytes(&bytes)
                .await
                .expect_err("staging refuses a foreign history");
            match err {
                BantoError::Validation { field_errors } => assert!(
                    field_errors[0]
                        .message
                        .contains("このアプリの版のデータベースではありません"),
                    "{candidate:?}: {field_errors:?}"
                ),
                other => panic!("{candidate:?}: expected Validation, got {other:?}"),
            }
            assert!(!pending.exists());
            pool.close().await;
            drop(current);

            // (2) Placed by hand: not applied, removed, the database untouched.
            let before = tokio::fs::read(&db_path).await.unwrap();
            tokio::fs::create_dir_all(pending.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&pending, &bytes).await.unwrap();
            let applied = BackupService::apply_pending_restore_at_startup(
                &db_path,
                &sqlite_migration_manifest(),
            )
            .await
            .unwrap();
            assert!(applied.is_none(), "{candidate:?}");
            assert!(!pending.exists(), "the refused pending file is removed");
            assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);

            // (3) The next startup succeeds.
            let again = init_db(&db_path).await.expect("the database still starts");
            again.as_sqlite().unwrap().close().await;
        }
    }

    /// ADR-0034 §9: without the migration list, staging is refused (fail
    /// closed); with it, a backup of this version restores, and so does one
    /// taken before a migration the app added AFTER the baseline (the startup
    /// migration run brings it forward).
    #[tokio::test]
    async fn a_backup_of_this_version_restores_and_later_migrations_may_be_pending() {
        use crate::backup::BackupService;
        use crate::users::{Role, UsersService};

        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("source.sqlite3");
        let source = init_db(&source_path).await.unwrap();
        UsersService::new(source.clone())
            .create_user("op", "operator-password", "Op", Role::Viewer)
            .await
            .unwrap();
        let source_pool = source.as_sqlite().unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(source_pool)
            .await
            .unwrap();
        source_pool.close().await;
        let bytes = tokio::fs::read(&source_path).await.unwrap();

        let db_path = dir.path().join("admin-template.sqlite3");
        let current = init_db(&db_path).await.unwrap();
        let unwired = BackupService::new(db_path.clone(), current.clone());
        assert!(unwired.stage_restore_from_bytes(&bytes).await.is_err());
        assert!(unwired.pending_restore().await.is_none());

        // The app's list has one migration after the baseline that the
        // backup has not applied yet.
        let mut with_a_later_migration: Vec<(i64, Vec<u8>)> = sqlx::migrate!("./migrations-sqlite")
            .iter()
            .map(|m| (m.version, m.checksum.to_vec()))
            .collect();
        with_a_later_migration.push((BASELINE_MIGRATION_VERSION + 1, vec![1, 2, 3]));
        let manifest = MigrationManifest::new(with_a_later_migration, BASELINE_MIGRATION_VERSION);
        BackupService::new(db_path.clone(), current.clone())
            .with_migrations(manifest.clone())
            .stage_restore_from_bytes(&bytes)
            .await
            .expect("a backup of this version is accepted");
        current.as_sqlite().unwrap().close().await;
        BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .unwrap()
            .expect("the staged restore is applied");
        let restored = init_db(&db_path).await.unwrap();
        let op = UsersService::new(restored)
            .get_by_username("op")
            .await
            .unwrap();
        assert!(op.is_some(), "the restored account is there");
    }
}
