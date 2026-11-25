//! Config drafts: edit a draft, publish it, go back to an earlier version
//! (Issue #938, config-draft-publish-design §4).
//!
//! This file is the base (design §7, step S1a): the target registry,
//! [`ConfigDraftsService::ensure_targets`], the reads of the published value
//! and the state, the edit lock, and saving / discarding a draft. Step S1b
//! added two parts on top of it, as child modules:
//!
//! - `publish`: [`ConfigDraftsService::publish`],
//!   [`ConfigDraftsService::revert`] and
//!   [`ConfigDraftsService::draft_rebase`] - the only writes that change the
//!   published value (each ONE transaction), and the rebase of a draft.
//! - `history`: [`ConfigDraftsService::list`],
//!   [`ConfigDraftsService::diff`], [`ConfigDraftsService::history`] and
//!   [`ConfigDraftsService::history_entry`] - each ONE SQL statement.
//!
//! The REST routes, the guards, the audit rows and the events are the
//! wiring's (S2: `banto-server`'s `routes::config_drafts_router`).
//!
//! Words (design §1):
//!
//! - **target**: one group of settings, named by a key (`plc.line1`). The app
//!   registers its targets at startup ([`ConfigTargetRegistry`]) and never
//!   changes them afterwards, like [`crate::PermissionCatalog`].
//! - **published**: the JSON the app runs on. The app's own code reads only
//!   this ([`ConfigDraftsService::published`] /
//!   [`ConfigDraftsService::published_as`]) - never the draft.
//! - **draft**: the JSON being edited; at most one per target.
//! - **version**: a per-target counter, 0 for the registered default.
//! - **revision**: a random string made on every write (as in
//!   [`crate::ui_settings`]). Clients send revisions as their conditions,
//!   never version numbers: after a backup is restored a version number
//!   comes back, a revision does not (design §4.4).
//! - **edit lock**: at most one holder per target may write the draft, until
//!   an expiry. The holder is an account (`acct:<users.id>` etc.), not a tab;
//!   each acquire makes a new **lease**, and extend / release must name it,
//!   so a late call from an old tab cannot touch the lock a newer tab took
//!   (design §4.6).
//!
//! Tables (design §4.5; owned by the app, conventions §11): `config_published`,
//! `config_history`, `config_drafts`, `config_locks`. The app's migration is
//! `0016_config_drafts.sql` (both dialects); the tests here re-state the DDL.
//!
//! **Every write first fixes the target's published row** (design §4.6):
//! `BEGIN IMMEDIATE` on SQLite, `SELECT ... FOR UPDATE` on PostgreSQL. After
//! that, the other writes of the same target wait, so "read, compare, write"
//! inside the transaction is safe. [`ConfigDraftsService::ensure_targets`]
//! makes sure the row exists.
//!
//! **Lock expiry uses the service's clock** (Unix milliseconds, passed to
//! SQL as a value), not the database's: SQLite's clock has one-second steps
//! and a test cannot move it. [`ConfigDraftsService::with_clock`] replaces
//! it. A lock is valid while `expires_at_ms > now`; an expired row is the
//! same as no row and is not cleaned up (the next acquire overwrites it).
//!
//! **A write reads the clock once, AFTER it fixed the published row**
//! ([`WriteTime`], handed to the body by `with_target_write!`). A write can
//! wait for the pool or for another write of the target; a time read before
//! that wait would be stale - an expired lock would pass as valid (or
//! someone's expired lock would still block an acquire). The same `now`
//! decides validity and the new expiry. An extension (an explicit one or a
//! draft save) never moves the expiry backwards.
//!
//! Conflicts are all [`BantoError::Conflict`]; `current.reason` tells them
//! apart (`draft_changed` / `published_changed` / `lock_held` /
//! `lock_required` / `stale_base`).
//!
//! Like every service here this one knows nothing about sessions, RBAC, HTTP,
//! audit or events (conventions §2): the wiring builds the [`ConfigEditor`]
//! from the session it authorized and adds the rest.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use banto_core::{BantoError, FieldError};
use banto_storage::{storage_error, Db, Dialect};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

/// Largest value of a target (its JSON text, in bytes): 256 KiB.
pub const MAX_CONFIG_VALUE_BYTES: usize = 256 * 1024;

/// Longest target key, in bytes (the same as a permission key).
pub const MAX_CONFIG_TARGET_KEY_LEN: usize = 64;

/// How long an edit lock lasts after an acquire, an extend or a draft save,
/// unless [`ConfigDraftsService::with_lock_ttl`] says otherwise.
pub const DEFAULT_LOCK_TTL: Duration = Duration::from_secs(300);

/// Shortest lock lifetime [`ConfigDraftsService::with_lock_ttl`] accepts.
pub const MIN_LOCK_TTL: Duration = Duration::from_secs(1);

/// Longest lock lifetime [`ConfigDraftsService::with_lock_ttl`] accepts. A
/// lock left behind blocks the other editors until it expires (design §11).
pub const MAX_LOCK_TTL: Duration = Duration::from_secs(3600);

/// The draft revision that means "no draft" (`if_revision` of the save that
/// must create it). A stored draft never has it.
pub const CONFIG_DRAFT_ABSENT_REVISION: &str = "0";

/// Longest revision / lease a caller may send. Both are 32 characters;
/// anything longer cannot be one and is refused before it reaches the
/// database.
const MAX_TOKEN_LEN: usize = 64;

const RESOURCE: &str = "config";

type Validator = Arc<dyn Fn(&Value) -> Result<(), Vec<FieldError>> + Send + Sync>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

// Row shapes of the three reads every write shares.
type PublishedRow = (String, i64, String, String);
type DraftRow = (String, i64, String, String, String);
type LockRow = (String, String, String, i64, i64);

/// One target's registration: its key, the default (the seed of version 0),
/// the secret paths, and an optional validator.
#[derive(Clone)]
pub struct ConfigTarget {
    key: String,
    default: Value,
    masked_paths: Vec<String>,
    validate: Option<Validator>,
}

impl fmt::Debug for ConfigTarget {
    // The default may be large and the validator is a closure: show the key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConfigTarget")
            .field("key", &self.key)
            .field("masked_paths", &self.masked_paths)
            .finish_non_exhaustive()
    }
}

impl ConfigTarget {
    /// Register a target.
    ///
    /// - `key`: dot-separated segments, each `[a-z][a-z0-9_]*`, at most
    ///   [`MAX_CONFIG_TARGET_KEY_LEN`] bytes. One segment is enough (unlike a
    ///   permission key). The key is shown to every session (in
    ///   `ResourceChanged`), so it must not hold a secret or a person's name.
    /// - `default`: the published value of version 0. A JSON **object**, at
    ///   most [`MAX_CONFIG_VALUE_BYTES`]. It is only the seed: once
    ///   [`ConfigDraftsService::ensure_targets`] wrote it, changing it in the
    ///   code changes nothing.
    /// - `masked_paths`: required (write `&[]` for none). JSON Pointers
    ///   (`/auth/token`) whose values must not appear in a diff or an audit
    ///   record ([`crate::audit::diff::diff_paths`]). The syntax is checked
    ///   (RFC 6901): a leading `/`, and `~` only as `~0` (a `~` in a key) or
    ///   `~1` (a `/` in a key). The diff compares against paths it escapes
    ///   that way, so a malformed pointer would be a mask that never
    ///   matches. The history and the
    ///   draft still store the whole value, so real secrets (passwords, keys)
    ///   do not belong in a target at all (design §11).
    ///
    /// A bad argument is a startup bug of the app: `BantoError::Other`, so it
    /// fails loudly.
    pub fn new(key: &str, default: Value, masked_paths: &[&str]) -> Result<Self, BantoError> {
        if !is_target_key(key) {
            return Err(BantoError::Other(format!(
                "invalid config target key: {key:?}"
            )));
        }
        if !default.is_object() {
            return Err(BantoError::Other(format!(
                "config target {key}: the default must be a JSON object"
            )));
        }
        if value_text(&default)?.len() > MAX_CONFIG_VALUE_BYTES {
            return Err(BantoError::Other(format!(
                "config target {key}: the default is larger than {MAX_CONFIG_VALUE_BYTES} bytes"
            )));
        }
        if let Some(bad) = masked_paths.iter().find(|path| !is_masked_pointer(path)) {
            return Err(BantoError::Other(format!(
                "config target {key}: masked path {bad:?} is not a JSON Pointer \
                 (it must start with '/', and '~' must be followed by '0' or '1')"
            )));
        }
        Ok(Self {
            key: key.to_string(),
            default,
            masked_paths: masked_paths.iter().map(|path| path.to_string()).collect(),
            validate: None,
        })
    }

    /// Add a validator. A draft that fails it can still be SAVED (so a
    /// half-written draft is not lost) - the errors come back with the save -
    /// but it cannot be published.
    ///
    /// **Only a pure, fast function**: publishing calls it inside the
    /// transaction that holds the target's row (on SQLite, the whole
    /// database). No I/O, no waiting.
    pub fn with_validator(
        mut self,
        validate: impl Fn(&Value) -> Result<(), Vec<FieldError>> + Send + Sync + 'static,
    ) -> Self {
        self.validate = Some(Arc::new(validate));
        self
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    /// The registered default (the seed of version 0).
    pub fn default_value(&self) -> &Value {
        &self.default
    }

    /// The secret paths, as JSON Pointers.
    pub fn masked_paths(&self) -> &[String] {
        &self.masked_paths
    }

    /// Run the validator (no validator = always fine).
    pub fn validate(&self, value: &Value) -> Result<(), Vec<FieldError>> {
        match &self.validate {
            Some(validate) => validate(value),
            None => Ok(()),
        }
    }
}

/// Is `raw` a JSON Pointer (RFC 6901) that names something below the root?
/// It starts with `/`, and every `~` is the start of `~0` or `~1`. The empty
/// pointer (the whole document) is refused: masking everything is not a
/// mask.
fn is_masked_pointer(raw: &str) -> bool {
    if !raw.starts_with('/') {
        return false;
    }
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '~' && !matches!(chars.next(), Some('0' | '1')) {
            return false;
        }
    }
    true
}

fn is_target_key(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > MAX_CONFIG_TARGET_KEY_LEN {
        return false;
    }
    raw.split('.').all(|segment| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    })
}

/// The targets the app registered. Built once at startup and never changed
/// afterwards (like [`crate::PermissionCatalog`]); kept in registration
/// order. `Clone` is cheap (`Arc`).
///
/// A target that is no longer registered keeps its rows; it just cannot be
/// read or written any more (`NotFound`).
#[derive(Debug, Clone, Default)]
pub struct ConfigTargetRegistry {
    targets: Arc<Vec<ConfigTarget>>,
}

impl ConfigTargetRegistry {
    /// No targets.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Add a target. A duplicate key is a startup bug: `BantoError::Other`.
    pub fn register(self, target: ConfigTarget) -> Result<Self, BantoError> {
        if self.get(target.key()).is_some() {
            return Err(BantoError::Other(format!(
                "config target registered twice: {}",
                target.key()
            )));
        }
        let mut targets = (*self.targets).clone();
        targets.push(target);
        Ok(Self {
            targets: Arc::new(targets),
        })
    }

    pub fn get(&self, key: &str) -> Option<&ConfigTarget> {
        self.targets.iter().find(|target| target.key == key)
    }

    /// The registered targets, in registration order.
    pub fn targets(&self) -> &[ConfigTarget] {
        &self.targets
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }
}

/// Who is editing. Built by the wiring from the session it authorized (the
/// same rule as the UI settings' owner: from the session's variant, never
/// from its name). It is NOT used for authorization - only to tell lock
/// holders apart and to label rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigEditor {
    /// `acct:<users.id>` / `grant:<kind>` / `local`.
    pub holder: String,
    /// The name shown to the other editors (a snapshot).
    pub name: String,
}

/// The published value of a target: what the app runs on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedConfig {
    pub value: Value,
    pub version: i64,
    pub revision: String,
    pub published_at: String,
}

/// [`PublishedConfig`] with the value read into the app's own type. All four
/// fields come from the same read of the same row.
#[derive(Debug, Clone, PartialEq)]
pub struct PublishedConfigAs<T> {
    pub value: T,
    pub version: i64,
    pub revision: String,
    pub published_at: String,
}

/// A target's draft.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDraft {
    pub value: Value,
    /// The published version the draft was started from.
    pub base_version: i64,
    pub revision: String,
    pub updated_by: String,
    pub updated_at: String,
}

/// A target's edit lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLock {
    /// `acct:<users.id>` etc. For the wiring (audit); not sent to clients.
    #[serde(skip)]
    pub holder: String,
    pub holder_name: String,
    /// Names this acquire. Not a secret (whoever may read the state sees
    /// it): extend and release also check the holder.
    pub lease: String,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

impl ConfigLock {
    fn from_row((holder, holder_name, lease, acquired_at_ms, expires_at_ms): LockRow) -> Self {
        Self {
            holder,
            holder_name,
            lease,
            acquired_at_ms,
            expires_at_ms,
        }
    }

    /// Valid strictly before the expiry.
    fn is_valid(&self, now_ms: i64) -> bool {
        self.expires_at_ms > now_ms
    }

    fn held_by(&self, editor: &ConfigEditor, now_ms: i64) -> bool {
        self.is_valid(now_ms) && self.holder == editor.holder
    }
}

/// Published, draft and lock of a target, read by ONE statement (the three
/// are from the same moment under any isolation level).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigState {
    pub target: String,
    pub published: PublishedConfig,
    pub draft: Option<ConfigDraft>,
    /// The valid lock; `None` when there is none or it expired.
    pub lock: Option<ConfigLock>,
    /// Whether the viewer holds the lock.
    pub lock_is_mine: bool,
}

/// The answer to a draft save.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDraftSaved {
    /// The draft's new revision.
    pub revision: String,
    pub base_version: i64,
    /// What the target's validator says about the saved value. Not an error
    /// of the save: the draft IS saved. Publishing refuses it while this is
    /// not empty.
    pub validation: Vec<FieldError>,
    /// The saver's lock, with the expiry the save moved forward.
    pub lock: ConfigLock,
}

/// The answer to a draft discard: no draft, revision
/// [`CONFIG_DRAFT_ABSENT_REVISION`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDraftDiscarded {
    pub revision: String,
    /// The published version the discarded draft was started from; `None`
    /// when there was no draft (nothing was discarded). For the wiring's
    /// audit row ([`discard_audit_detail`]); not sent to clients.
    #[serde(skip)]
    pub discarded_base_version: Option<i64>,
}

/// The audit `detail` of a draft discard (design §4.8): `{ baseVersion }`.
/// `None` when the call found no draft - nothing was discarded, so the
/// wiring writes no audit row. Both paths (REST and Tauri) call this, so
/// their audit rows cannot differ.
pub fn discard_audit_detail(discarded: &ConfigDraftDiscarded) -> Option<Value> {
    discarded
        .discarded_base_version
        .map(|base_version| json!({ "baseVersion": base_version }))
}

/// The audit `detail` of a forced unlock (design §4.8): whose lock was
/// removed - `{ holder, holderName }`. `holder` is `acct:<users.id>` etc.;
/// it goes to the audit log, never into a response. Both paths call this.
pub fn unlock_audit_detail(removed: &ConfigLock) -> Value {
    json!({ "holder": removed.holder, "holderName": removed.holder_name })
}

/// See the module doc.
#[derive(Clone)]
pub struct ConfigDraftsService {
    db: Db,
    targets: ConfigTargetRegistry,
    lock_ttl_ms: i64,
    clock: Clock,
}

/// The time of one write: the service's clock read once, after the write
/// fixed the target's published row (so after every wait), and the expiry a
/// lock gets from it. Only `with_target_write!` makes one; every decision
/// about a lock inside the write uses it (publish and revert too).
#[derive(Debug, Clone, Copy)]
struct WriteTime {
    now_ms: i64,
    expires_at_ms: i64,
}

impl WriteTime {
    /// The expiry an extension sets: now + ttl, but never before the expiry
    /// the row already has (the clock may have stepped back).
    fn extended(&self, lock: &ConfigLock) -> i64 {
        self.expires_at_ms.max(lock.expires_at_ms)
    }
}

/// Start a write on `$target`: open the transaction, fix the target's
/// published row and read it into `$published` ([`PublishedConfig`]), read
/// the clock into `$at` ([`WriteTime`]; from here on no other write of the
/// target can run, so this is the time the write happens), run `$body` with
/// the transaction as `$tx`, commit. A `?` inside the body leaves the
/// function and drops the transaction, which rolls it back.
///
/// The body is expanded once per backend, without a generic SQL layer (the
/// shape of `users.rs`'s `with_users_write_transaction!`).
macro_rules! with_target_write {
    ($service:expr, $target:expr, |$tx:ident, $published:ident, $at:ident| $body:block) => {{
        let fix_sql = published_sql($service.db.dialect(), true);
        match &$service.db {
            Db::Sqlite(pool) => {
                // Reserve the writer BEFORE reading; a deferred transaction
                // could read a snapshot that another writer invalidates.
                let mut $tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(storage_error)?;
                let row: Option<PublishedRow> = sqlx::query_as(sqlx::AssertSqlSafe(fix_sql))
                    .bind($target)
                    .fetch_optional(&mut *$tx)
                    .await
                    .map_err(storage_error)?;
                let $published = published_from_row($target, row)?;
                let $at: WriteTime = $service.write_time();
                #[allow(clippy::let_unit_value)]
                let result = $body;
                $tx.commit().await.map_err(storage_error)?;
                result
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                // An explicit isolation level: every statement after the
                // row lock must see what the previous holder committed, even
                // when the pool's default is repeatable read.
                let mut $tx = pool
                    .begin_with("BEGIN ISOLATION LEVEL READ COMMITTED")
                    .await
                    .map_err(storage_error)?;
                let row: Option<PublishedRow> = sqlx::query_as(sqlx::AssertSqlSafe(fix_sql))
                    .bind($target)
                    .fetch_optional(&mut *$tx)
                    .await
                    .map_err(storage_error)?;
                let $published = published_from_row($target, row)?;
                let $at: WriteTime = $service.write_time();
                #[allow(clippy::let_unit_value)]
                let result = $body;
                $tx.commit().await.map_err(storage_error)?;
                result
            }
        }
    }};
}

/// The target's lock row inside a write (valid or expired), if any.
macro_rules! fetch_lock {
    ($tx:ident, $dialect:expr, $target:expr) => {{
        let sql = format!(
            "SELECT holder, holder_name, lease, acquired_at_ms, expires_at_ms \
             FROM config_locks WHERE target = {}",
            $dialect.placeholder(1)
        );
        let row: Option<LockRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind($target)
            .fetch_optional(&mut *$tx)
            .await
            .map_err(storage_error)?;
        row.map(ConfigLock::from_row)
    }};
}

/// The target's draft row inside a write, if any.
macro_rules! fetch_draft {
    ($tx:ident, $dialect:expr, $target:expr) => {{
        let sql = format!(
            "SELECT value, base_version, revision, updated_by, updated_at \
             FROM config_drafts WHERE target = {}",
            $dialect.placeholder(1)
        );
        let row: Option<DraftRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind($target)
            .fetch_optional(&mut *$tx)
            .await
            .map_err(storage_error)?;
        match row {
            Some(row) => Some(draft_from_row($target, row)?),
            None => None,
        }
    }};
}

/// Delete the target's lock row inside a write.
macro_rules! delete_lock {
    ($tx:ident, $dialect:expr, $target:expr) => {{
        let sql = format!(
            "DELETE FROM config_locks WHERE target = {}",
            $dialect.placeholder(1)
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind($target)
            .execute(&mut *$tx)
            .await
            .map_err(storage_error)?;
    }};
}

/// Move the expiry of the target's lock row inside a write. The caller has
/// already checked (in the same transaction) whose row it is.
macro_rules! set_lock_expiry {
    ($tx:ident, $dialect:expr, $target:expr, $expires_at_ms:expr) => {{
        let sql = format!(
            "UPDATE config_locks SET expires_at_ms = {} WHERE target = {}",
            $dialect.placeholder(1),
            $dialect.placeholder(2)
        );
        let done = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind($expires_at_ms)
            .bind($target)
            .execute(&mut *$tx)
            .await
            .map_err(storage_error)?;
        expect_one_row(done.rows_affected(), "config_locks")?;
    }};
}

/// Seed the registered targets that have no rows yet, inside one
/// transaction.
macro_rules! ensure_targets_in {
    ($tx:ident, $dialect:expr, $targets:expr) => {{
        // AssertSqlSafe (here and everywhere in this file): only placeholders
        // and the dialect's fixed expressions are interpolated; every value
        // is bound.
        let published_sql = format!(
            "INSERT INTO config_published (target, value, version, revision) \
             VALUES ({}, {}, 0, {}) ON CONFLICT (target) DO NOTHING",
            $dialect.placeholder(1),
            $dialect.placeholder(2),
            $dialect.placeholder(3),
        );
        let history_sql = format!(
            "INSERT INTO config_history (target, version, value, kind) \
             VALUES ({}, 0, {}, 'initial')",
            $dialect.placeholder(1),
            $dialect.placeholder(2),
        );
        for target in $targets {
            let text = value_text(target.default_value())?;
            let inserted = sqlx::query(sqlx::AssertSqlSafe(published_sql.clone()))
                .bind(target.key())
                .bind(&text)
                .bind(new_revision())
                .execute(&mut *$tx)
                .await
                .map_err(storage_error)?
                .rows_affected();
            // Only the call that made the published row writes version 0 of
            // the history. A plain INSERT: a history row without a published
            // row is a damaged database, and must fail instead of being
            // papered over.
            if inserted == 1 {
                sqlx::query(sqlx::AssertSqlSafe(history_sql.clone()))
                    .bind(target.key())
                    .bind(&text)
                    .execute(&mut *$tx)
                    .await
                    .map_err(storage_error)?;
            }
        }
    }};
}

impl ConfigDraftsService {
    pub fn new(db: Db, targets: ConfigTargetRegistry) -> Self {
        Self {
            db,
            targets,
            lock_ttl_ms: duration_ms(DEFAULT_LOCK_TTL),
            clock: Arc::new(system_now_ms),
        }
    }

    /// How long a lock lasts after an acquire, an extend or a draft save.
    /// Kept within [`MIN_LOCK_TTL`]..=[`MAX_LOCK_TTL`] (a value outside is
    /// moved to the nearest end). The screen extends at a third of this.
    pub fn with_lock_ttl(mut self, ttl: Duration) -> Self {
        self.lock_ttl_ms = duration_ms(ttl.clamp(MIN_LOCK_TTL, MAX_LOCK_TTL));
        self
    }

    /// Replace the clock the lock expiry uses: a function that returns Unix
    /// milliseconds. For tests (move an `AtomicI64` instead of sleeping).
    pub fn with_clock(mut self, now_ms: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(now_ms);
        self
    }

    /// The registered targets.
    pub fn targets(&self) -> &ConfigTargetRegistry {
        &self.targets
    }

    /// Give every registered target its rows: the published row at version 0
    /// with the registered default, and version 0 of the history
    /// (`kind = 'initial'`). **Call it at startup, after the migrations.**
    ///
    /// A target that already has its published row is left alone - so calling
    /// this again, or changing the default in the code, changes nothing. The
    /// default is only the seed; every later change goes through a publish
    /// and is in the history. All targets are seeded in one transaction.
    pub async fn ensure_targets(&self) -> Result<(), BantoError> {
        let dialect = self.db.dialect();
        let targets = self.targets.targets();
        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(storage_error)?;
                ensure_targets_in!(tx, dialect, targets);
                tx.commit().await.map_err(storage_error)?;
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                // Two servers starting together: the second INSERT waits for
                // the first one's commit and then does nothing.
                let mut tx = pool.begin().await.map_err(storage_error)?;
                ensure_targets_in!(tx, dialect, targets);
                tx.commit().await.map_err(storage_error)?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // What the app's own code reads: the published value only.
    // ------------------------------------------------------------------

    /// The published value of `target`: one read of one row, so the value,
    /// the version and the revision always belong together.
    ///
    /// To follow changes, compare the **revision** with the one in use and
    /// take the new value when it differs - not "when the version is
    /// larger": a restored backup brings a smaller version back (design
    /// §4.3, §11).
    pub async fn published(&self, target: &str) -> Result<PublishedConfig, BantoError> {
        self.target(target)?;
        let sql = published_sql(self.db.dialect(), false);
        let row: Option<PublishedRow> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(storage_error)?;
        published_from_row(target, row)
    }

    /// [`ConfigDraftsService::published`] with the value read into `T`. The
    /// version, the revision and the time are from the same read as the
    /// value (reading the revision separately could pair an old value with a
    /// new revision).
    ///
    /// A value that does not fit `T` is `BantoError::Other`. The message
    /// names the target only: a `serde` message can quote the value.
    pub async fn published_as<T: DeserializeOwned>(
        &self,
        target: &str,
    ) -> Result<PublishedConfigAs<T>, BantoError> {
        let published = self.published(target).await?;
        let value = serde_json::from_value(published.value).map_err(|_| {
            BantoError::Other(format!(
                "config target {target}: the published value does not fit the requested type"
            ))
        })?;
        Ok(PublishedConfigAs {
            value,
            version: published.version,
            revision: published.revision,
            published_at: published.published_at,
        })
    }

    // ------------------------------------------------------------------
    // For the screen.
    // ------------------------------------------------------------------

    /// Published, draft and lock of `target`, read by ONE statement (design
    /// §4.6: with PostgreSQL's default isolation level, separate SELECTs -
    /// even inside a transaction - are separate moments). An expired lock is
    /// reported as no lock.
    pub async fn state(
        &self,
        target: &str,
        viewer: &ConfigEditor,
    ) -> Result<ConfigState, BantoError> {
        type StateRow = (
            String,
            i64,
            String,
            String,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
        );
        self.target(target)?;
        let sql = format!(
            "SELECT p.value, p.version, p.revision, p.published_at, \
                    d.value, d.base_version, d.revision, d.updated_by, d.updated_at, \
                    l.holder, l.holder_name, l.lease, l.acquired_at_ms, l.expires_at_ms \
             FROM config_published p \
             LEFT JOIN config_drafts d ON d.target = p.target \
             LEFT JOIN config_locks l ON l.target = p.target \
             WHERE p.target = {}",
            self.db.dialect().placeholder(1)
        );
        let row: Option<StateRow> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(storage_error)?;
        let Some((
            value,
            version,
            revision,
            published_at,
            draft_value,
            draft_base_version,
            draft_revision,
            draft_updated_by,
            draft_updated_at,
            lock_holder,
            lock_holder_name,
            lock_lease,
            lock_acquired_at_ms,
            lock_expires_at_ms,
        )) = row
        else {
            return Err(not_seeded(target));
        };
        let published = published_from_row(target, Some((value, version, revision, published_at)))?;
        // Every column of the joined tables is NOT NULL, so one NULL means
        // the row is not there.
        let draft = match (
            draft_value,
            draft_base_version,
            draft_revision,
            draft_updated_by,
            draft_updated_at,
        ) {
            (Some(value), Some(base), Some(revision), Some(by), Some(at)) => {
                Some(draft_from_row(target, (value, base, revision, by, at))?)
            }
            _ => None,
        };
        let now = self.now_ms();
        let lock = match (
            lock_holder,
            lock_holder_name,
            lock_lease,
            lock_acquired_at_ms,
            lock_expires_at_ms,
        ) {
            (Some(holder), Some(name), Some(lease), Some(acquired), Some(expires)) => Some(
                ConfigLock::from_row((holder, name, lease, acquired, expires)),
            ),
            _ => None,
        }
        .filter(|lock| lock.is_valid(now));
        let lock_is_mine = lock
            .as_ref()
            .is_some_and(|lock| lock.holder == viewer.holder);
        Ok(ConfigState {
            target: target.to_string(),
            published,
            draft,
            lock,
            lock_is_mine,
        })
    }

    // ------------------------------------------------------------------
    // The edit lock (design §4.6, the table of rules).
    // ------------------------------------------------------------------

    /// Take the lock: allowed when there is no row, the row expired, or the
    /// holder is `editor` already. Always makes a NEW lease (so an older tab
    /// of the same person can no longer extend or release) and sets the
    /// expiry to now + ttl. Someone else's valid lock is a conflict
    /// (`lock_held`, with the holder's name and the expiry).
    pub async fn lock_acquire(
        &self,
        target: &str,
        editor: &ConfigEditor,
    ) -> Result<ConfigLock, BantoError> {
        self.target(target)?;
        let dialect = self.db.dialect();
        let lease = new_revision();
        let lock = with_target_write!(self, target, |tx, _published, at| {
            if let Some(current) = fetch_lock!(tx, dialect, target) {
                if current.is_valid(at.now_ms) && current.holder != editor.holder {
                    return Err(lock_conflict("lock_held", Some(&current)));
                }
            }
            let lock = ConfigLock {
                holder: editor.holder.clone(),
                holder_name: editor.name.clone(),
                lease,
                acquired_at_ms: at.now_ms,
                expires_at_ms: at.expires_at_ms,
            };
            let sql = format!(
                "INSERT INTO config_locks \
                     (target, holder, holder_name, lease, acquired_at_ms, expires_at_ms) \
                 VALUES ({}) \
                 ON CONFLICT (target) DO UPDATE SET \
                     holder = excluded.holder, holder_name = excluded.holder_name, \
                     lease = excluded.lease, acquired_at_ms = excluded.acquired_at_ms, \
                     expires_at_ms = excluded.expires_at_ms",
                dialect.placeholders(6)
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(target)
                .bind(&lock.holder)
                .bind(&lock.holder_name)
                .bind(&lock.lease)
                .bind(lock.acquired_at_ms)
                .bind(lock.expires_at_ms)
                .execute(&mut *tx)
                .await
                .map_err(storage_error)?;
            lock
        });
        Ok(lock)
    }

    /// Move the expiry to now + ttl (never backwards). Only when the lock is
    /// valid, the holder is `editor` AND `lease` is the row's lease; the
    /// lease stays the same. "Valid" is judged when the write runs, not when
    /// it was called: an extension that waited past the expiry is refused.
    /// Anything else - expired, another holder, a lease from an earlier
    /// acquire - is a conflict (`lock_required`). **Extending never takes the
    /// lock again**: after it expired the screen must acquire, and learns
    /// there whether someone else has it now.
    pub async fn lock_extend(
        &self,
        target: &str,
        editor: &ConfigEditor,
        lease: &str,
    ) -> Result<ConfigLock, BantoError> {
        self.target(target)?;
        check_token("lease", lease)?;
        let dialect = self.db.dialect();
        let lock = with_target_write!(self, target, |tx, _published, at| {
            let current = fetch_lock!(tx, dialect, target);
            let Some(mut mine) = current
                .clone()
                .filter(|lock| lock.held_by(editor, at.now_ms) && lock.lease == lease)
            else {
                return Err(lock_conflict(
                    "lock_required",
                    current.as_ref().filter(|lock| lock.is_valid(at.now_ms)),
                ));
            };
            let expires_at_ms = at.extended(&mine);
            set_lock_expiry!(tx, dialect, target, expires_at_ms);
            mine.expires_at_ms = expires_at_ms;
            mine
        });
        Ok(lock)
    }

    /// Give the lock back: deletes the row when the holder is `editor` AND
    /// `lease` is the row's lease. Otherwise it does nothing and still
    /// succeeds - a late release from an old tab must not remove the lock a
    /// newer tab (or someone else) took since. The draft stays.
    ///
    /// Returns whether a lock was removed (`false` for a stale lease), so the
    /// wiring announces a change only when there was one.
    pub async fn lock_release(
        &self,
        target: &str,
        editor: &ConfigEditor,
        lease: &str,
    ) -> Result<bool, BantoError> {
        self.target(target)?;
        check_token("lease", lease)?;
        let dialect = self.db.dialect();
        let removed = with_target_write!(self, target, |tx, _published, _at| {
            let current = fetch_lock!(tx, dialect, target);
            let mine =
                current.is_some_and(|lock| lock.holder == editor.holder && lock.lease == lease);
            if mine {
                delete_lock!(tx, dialect, target);
            }
            mine
        });
        Ok(removed)
    }

    /// Remove someone's lock (an administrator's action; the wiring checks
    /// the permission and writes the audit record). Only when `if_lease` is
    /// the row's lease - the lock the administrator SAW. If the row has
    /// another lease by now (released and taken by someone else) or is gone,
    /// nothing is removed: a conflict (`lock_held`) whose `current.lock` is
    /// the valid lock as it is now, or `null`. Returns the removed lock. The
    /// draft stays.
    pub async fn lock_force_release(
        &self,
        target: &str,
        if_lease: &str,
    ) -> Result<ConfigLock, BantoError> {
        self.target(target)?;
        check_token("ifLease", if_lease)?;
        let dialect = self.db.dialect();
        let removed = with_target_write!(self, target, |tx, _published, at| {
            let current = fetch_lock!(tx, dialect, target);
            let Some(seen) = current.clone().filter(|lock| lock.lease == if_lease) else {
                return Err(lock_conflict(
                    "lock_held",
                    current.as_ref().filter(|lock| lock.is_valid(at.now_ms)),
                ));
            };
            delete_lock!(tx, dialect, target);
            seen
        });
        Ok(removed)
    }

    // ------------------------------------------------------------------
    // The draft. Both writes need the editor's own valid lock.
    // ------------------------------------------------------------------

    /// Save the draft and move the lock's expiry forward.
    ///
    /// - `value`: a JSON object, at most [`MAX_CONFIG_VALUE_BYTES`]
    ///   (`Validation` otherwise). The target's validator is called, but only
    ///   reported ([`ConfigDraftSaved::validation`]): a half-written draft
    ///   can be saved.
    /// - `if_revision`: required. The draft's revision the editor has, or
    ///   [`CONFIG_DRAFT_ABSENT_REVISION`] for the save that creates the
    ///   draft. A draft that is not at that revision (or exists / does not
    ///   exist against expectation) is a conflict (`draft_changed`, with the
    ///   draft as it is now).
    /// - `if_published_revision`: required when `if_revision` is
    ///   [`CONFIG_DRAFT_ABSENT_REVISION`], ignored otherwise. The published
    ///   revision the editor's screen was built from. The draft is created
    ///   only when it is still the published revision, and that published
    ///   version becomes the draft's base; otherwise a conflict
    ///   (`published_changed`, with the published version and revision). This
    ///   ties the base to what the person actually saw.
    ///
    /// Without the editor's own valid lock: a conflict (`lock_required`),
    /// also after it expired.
    pub async fn draft_put(
        &self,
        target: &str,
        editor: &ConfigEditor,
        value: &Value,
        if_revision: &str,
        if_published_revision: Option<&str>,
    ) -> Result<ConfigDraftSaved, BantoError> {
        let registered = self.target(target)?;
        check_token("ifRevision", if_revision)?;
        let creates = if_revision == CONFIG_DRAFT_ABSENT_REVISION;
        let expected_published = match (creates, if_published_revision) {
            (true, None) => {
                return Err(field_error(
                    "ifPublishedRevision",
                    "下書きを作る保存には ifPublishedRevision が必要です",
                ))
            }
            (true, Some(revision)) => {
                check_token("ifPublishedRevision", revision)?;
                revision
            }
            (false, _) => "",
        };
        if !value.is_object() {
            return Err(field_error(
                "value",
                "設定の値は JSON のオブジェクトにしてください",
            ));
        }
        let text = value_text(value)?;
        if text.len() > MAX_CONFIG_VALUE_BYTES {
            return Err(field_error(
                "value",
                &format!("設定の値が大きすぎます（{MAX_CONFIG_VALUE_BYTES} バイトまで）"),
            ));
        }
        // Outside the transaction: the result does not decide the save.
        let validation = registered.validate(value).err().unwrap_or_default();

        let dialect = self.db.dialect();
        let now_text = now_text(dialect);
        let revision = new_revision();
        let (base_version, lock) = with_target_write!(self, target, |tx, published, at| {
            let current_lock = fetch_lock!(tx, dialect, target);
            let Some(mut lock) = current_lock
                .clone()
                .filter(|lock| lock.held_by(editor, at.now_ms))
            else {
                return Err(lock_conflict(
                    "lock_required",
                    current_lock
                        .as_ref()
                        .filter(|lock| lock.is_valid(at.now_ms)),
                ));
            };
            let expires_at_ms = at.extended(&lock);
            let draft = fetch_draft!(tx, dialect, target);
            let base_version = if creates {
                if draft.is_some() {
                    return Err(draft_changed(draft.as_ref()));
                }
                if published.revision != expected_published {
                    return Err(published_changed(&published));
                }
                let sql = format!(
                    "INSERT INTO config_drafts (target, value, base_version, revision, updated_by) \
                     VALUES ({})",
                    dialect.placeholders(5)
                );
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(&text)
                    .bind(published.version)
                    .bind(&revision)
                    .bind(&editor.name)
                    .execute(&mut *tx)
                    .await
                    .map_err(storage_error)?;
                published.version
            } else {
                let Some(base_version) = draft
                    .as_ref()
                    .filter(|draft| draft.revision == if_revision)
                    .map(|draft| draft.base_version)
                else {
                    return Err(draft_changed(draft.as_ref()));
                };
                // The revision is in the WHERE too (the check and the write
                // in one statement, conventions §6), on top of the row lock.
                let sql = format!(
                    "UPDATE config_drafts \
                     SET value = {}, revision = {}, updated_by = {}, updated_at = {now_text} \
                     WHERE target = {} AND revision = {}",
                    dialect.placeholder(1),
                    dialect.placeholder(2),
                    dialect.placeholder(3),
                    dialect.placeholder(4),
                    dialect.placeholder(5),
                );
                let done = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(&text)
                    .bind(&revision)
                    .bind(&editor.name)
                    .bind(target)
                    .bind(if_revision)
                    .execute(&mut *tx)
                    .await
                    .map_err(storage_error)?;
                expect_one_row(done.rows_affected(), "config_drafts")?;
                base_version
            };
            set_lock_expiry!(tx, dialect, target, expires_at_ms);
            lock.expires_at_ms = expires_at_ms;
            (base_version, lock)
        });
        Ok(ConfigDraftSaved {
            revision,
            base_version,
            validation,
            lock,
        })
    }

    /// Delete the draft. The lock is kept (and its expiry is not moved).
    ///
    /// `if_revision` is required: the draft's revision the editor has. A
    /// draft at another revision, or no draft, is a conflict
    /// (`draft_changed`). [`CONFIG_DRAFT_ABSENT_REVISION`] only asserts that
    /// there is no draft. Without the editor's own valid lock: a conflict
    /// (`lock_required`).
    pub async fn draft_discard(
        &self,
        target: &str,
        editor: &ConfigEditor,
        if_revision: &str,
    ) -> Result<ConfigDraftDiscarded, BantoError> {
        self.target(target)?;
        check_token("ifRevision", if_revision)?;
        let dialect = self.db.dialect();
        let discarded_base_version = with_target_write!(self, target, |tx, _published, at| {
            let current_lock = fetch_lock!(tx, dialect, target);
            if !current_lock
                .as_ref()
                .is_some_and(|lock| lock.held_by(editor, at.now_ms))
            {
                return Err(lock_conflict(
                    "lock_required",
                    current_lock
                        .as_ref()
                        .filter(|lock| lock.is_valid(at.now_ms)),
                ));
            }
            let draft = fetch_draft!(tx, dialect, target);
            let found = draft
                .as_ref()
                .map_or(CONFIG_DRAFT_ABSENT_REVISION, |draft| {
                    draft.revision.as_str()
                });
            if found != if_revision {
                return Err(draft_changed(draft.as_ref()));
            }
            if draft.is_some() {
                let sql = format!(
                    "DELETE FROM config_drafts WHERE target = {} AND revision = {}",
                    dialect.placeholder(1),
                    dialect.placeholder(2),
                );
                let done = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(if_revision)
                    .execute(&mut *tx)
                    .await
                    .map_err(storage_error)?;
                expect_one_row(done.rows_affected(), "config_drafts")?;
            }
            draft.map(|draft| draft.base_version)
        });
        Ok(ConfigDraftDiscarded {
            revision: CONFIG_DRAFT_ABSENT_REVISION.to_string(),
            discarded_base_version,
        })
    }

    // ------------------------------------------------------------------

    fn target(&self, key: &str) -> Result<&ConfigTarget, BantoError> {
        self.targets.get(key).ok_or_else(|| BantoError::NotFound {
            resource: RESOURCE.to_string(),
            // Cap what is echoed back from a malformed request.
            id: key.chars().take(MAX_CONFIG_TARGET_KEY_LEN).collect(),
        })
    }

    fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    /// Only for `with_target_write!` (see [`WriteTime`]).
    fn write_time(&self) -> WriteTime {
        let now_ms = self.now_ms();
        WriteTime {
            now_ms,
            expires_at_ms: now_ms.saturating_add(self.lock_ttl_ms),
        }
    }
}

/// The read of a target's published row. With `fix`, PostgreSQL also locks
/// the row until the transaction ends (SQLite's `BEGIN IMMEDIATE` already
/// holds the database).
fn published_sql(dialect: Dialect, fix: bool) -> String {
    let for_update = match dialect {
        Dialect::Postgres if fix => " FOR UPDATE",
        _ => "",
    };
    format!(
        "SELECT value, version, revision, published_at FROM config_published \
         WHERE target = {}{for_update}",
        dialect.placeholder(1)
    )
}

/// The `updated_at` / `published_at` expression a write uses: the time of
/// the STATEMENT, in the text form of the columns' defaults. A write runs
/// this after it fixed the published row, so the time is after every wait.
/// PostgreSQL's `now()` (the columns' default) is the time the transaction
/// STARTED - before the wait for the row lock - so it is not used here.
fn now_text(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Sqlite => "datetime('now')",
        Dialect::Postgres => "statement_timestamp()::text",
    }
}

fn published_from_row(
    target: &str,
    row: Option<PublishedRow>,
) -> Result<PublishedConfig, BantoError> {
    let Some((value, version, revision, published_at)) = row else {
        return Err(not_seeded(target));
    };
    Ok(PublishedConfig {
        value: stored_value(target, &value)?,
        version,
        revision,
        published_at,
    })
}

fn draft_from_row(
    target: &str,
    (value, base_version, revision, updated_by, updated_at): DraftRow,
) -> Result<ConfigDraft, BantoError> {
    Ok(ConfigDraft {
        value: stored_value(target, &value)?,
        base_version,
        revision,
        updated_by,
        updated_at,
    })
}

/// A registered target without its published row: the app did not call
/// [`ConfigDraftsService::ensure_targets`]. A startup bug, not a 404.
fn not_seeded(target: &str) -> BantoError {
    BantoError::Other(format!(
        "config target {target} has no published row: call ensure_targets() at startup, after the migrations"
    ))
}

fn value_text(value: &Value) -> Result<String, BantoError> {
    serde_json::to_string(value)
        .map_err(|_| BantoError::Other("config value could not be written as JSON".to_string()))
}

fn stored_value(target: &str, text: &str) -> Result<Value, BantoError> {
    // The message does not carry the parser's text or the stored value.
    serde_json::from_str(text).map_err(|_| {
        BantoError::Storage(format!("config target {target}: stored value is not JSON"))
    })
}

fn expect_one_row(rows: u64, table: &str) -> Result<(), BantoError> {
    if rows == 1 {
        Ok(())
    } else {
        Err(BantoError::Storage(format!(
            "{table}: expected to write 1 row, wrote {rows}"
        )))
    }
}

/// A new revision or lease: 128 bits from the OS random source as 32
/// lowercase hex characters (the same make as `ui_settings`'s revision). Not
/// a secret; it only has to differ from every one before it.
fn new_revision() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, duration_ms)
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn field_error(field: &str, message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: field.to_string(),
            message: message.to_string(),
        }],
    }
}

fn check_token(field: &str, token: &str) -> Result<(), BantoError> {
    if token.is_empty() || token.len() > MAX_TOKEN_LEN {
        return Err(field_error(
            field,
            &format!("{field} は1〜{MAX_TOKEN_LEN}文字で指定してください"),
        ));
    }
    Ok(())
}

/// `lock_held` / `lock_required`. `current.lock` is the VALID lock as it is
/// now (the holder's name and the times, without the lease), or `null`.
fn lock_conflict(reason: &str, lock: Option<&ConfigLock>) -> BantoError {
    let message = match reason {
        "lock_held" => "ほかの人がこの設定を編集しています",
        _ => "この設定の編集のロックを持っていません",
    };
    BantoError::Conflict {
        message: message.to_string(),
        current: Some(json!({
            "reason": reason,
            "lock": lock.map(|lock| json!({
                "holderName": lock.holder_name,
                "acquiredAtMs": lock.acquired_at_ms,
                "expiresAtMs": lock.expires_at_ms,
            })),
        })),
    }
}

/// `draft_changed`. `current.draft` is the draft as it is now, or `null`
/// (`current.revision` is then [`CONFIG_DRAFT_ABSENT_REVISION`]).
fn draft_changed(draft: Option<&ConfigDraft>) -> BantoError {
    BantoError::Conflict {
        message: "この下書きは別の画面で変更されています".to_string(),
        current: Some(json!({
            "reason": "draft_changed",
            "revision": draft.map_or(CONFIG_DRAFT_ABSENT_REVISION, |draft| draft.revision.as_str()),
            "draft": draft,
        })),
    }
}

/// `published_changed`. `current.published` is the published version and
/// revision as they are now (not the value).
fn published_changed(published: &PublishedConfig) -> BantoError {
    BantoError::Conflict {
        message: "本番の設定が先に変更されています".to_string(),
        current: Some(json!({
            "reason": "published_changed",
            "published": {
                "version": published.version,
                "revision": published.revision,
            },
        })),
    }
}

/// No draft where one is needed (publish, the draft's diff).
fn no_draft(target: &str) -> BantoError {
    BantoError::NotFound {
        resource: "config_draft".to_string(),
        id: target.to_string(),
    }
}

/// A version that is not in the target's history.
fn no_version(target: &str, version: i64) -> BantoError {
    BantoError::NotFound {
        resource: "config_version".to_string(),
        id: format!("{target}/{version}"),
    }
}

/// The target's secret paths in the shape `audit::diff` takes.
fn masked_of(target: &ConfigTarget) -> Vec<&str> {
    target.masked_paths().iter().map(String::as_str).collect()
}

// After the macros above: the child modules use them.
mod history;
mod publish;

pub use history::{
    ConfigDiff, ConfigDraftSummary, ConfigHistoryDetail, ConfigHistoryEntry, ConfigTargetSummary,
    MAX_CONFIG_HISTORY_PAGE,
};
pub use publish::{
    publish_audit_detail, ConfigHistoryKind, PublishOutcome, PublishStamp, MAX_CONFIG_COMMENT_CHARS,
};

#[cfg(test)]
mod cases;
#[cfg(test)]
mod tests;
