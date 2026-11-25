//! The screen's reads that S1b adds (config-draft-publish-design §4.6, §4.7;
//! §7, step S1b): the list of targets, the diff, the history.
//!
//! **Each read is ONE SQL statement.** With PostgreSQL's default isolation
//! level every statement sees its own moment, also inside a transaction; two
//! SELECTs could pair a value with the revision of another moment. One
//! statement is one moment on both backends, whatever the isolation level.
//! This matters most for the diff: the screen sends the revisions of the diff
//! it showed as the conditions of the publish / rebase / revert, so the
//! `changes` of an answer must be the diff of exactly the values those
//! revisions name.

use super::*;
use crate::audit::diff::diff_paths;

/// The most history rows one [`ConfigDraftsService::history`] call returns.
pub const MAX_CONFIG_HISTORY_PAGE: u32 = 100;

/// A draft in the list of targets: who, when, from which version - not the
/// value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDraftSummary {
    pub base_version: i64,
    pub revision: String,
    pub updated_by: String,
    pub updated_at: String,
}

/// One registered target in the list: where its published value is, whether
/// it has a draft, who edits it. No values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigTargetSummary {
    pub target: String,
    pub version: i64,
    pub revision: String,
    pub published_at: String,
    pub draft: Option<ConfigDraftSummary>,
    /// The valid lock; `None` when there is none or it expired.
    pub lock: Option<ConfigLock>,
}

/// A diff and the marks of what was compared (design §4.6: "the answer always
/// carries what it compared"). The screen sends THESE revisions as the
/// conditions of the next write, never ones from another read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiff {
    pub target: String,
    pub published_version: i64,
    pub published_revision: String,
    /// "Published -> draft" only: the draft that was compared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_revision: Option<String>,
    /// "Published -> draft" only: the draft's base version. When it is not
    /// `published_version`, a publish answers `stale_base` until a rebase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_version: Option<i64>,
    /// "Published -> version N" only: N.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_version: Option<i64>,
    /// Published value -> the other value, per JSON path
    /// ([`diff_paths`]): masked by the target's secret paths, values not cut.
    pub changes: Vec<Value>,
}

/// One version in the history, without its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHistoryEntry {
    pub version: i64,
    pub kind: ConfigHistoryKind,
    /// `kind = revert`: the version whose value was published again.
    pub reverted_to: Option<i64>,
    /// `None` for version 0 (nobody published the default).
    pub actor_username: Option<String>,
    pub actor_id: Option<i64>,
    pub actor_kind: Option<String>,
    pub origin: Option<String>,
    pub comment: Option<String>,
    pub published_at: String,
}

/// One version with its value and the one before it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHistoryDetail {
    #[serde(flatten)]
    pub entry: ConfigHistoryEntry,
    /// The published value of this version ("after").
    pub value: Value,
    /// The value of the version before ("before"); `None` for version 0.
    pub previous_value: Option<Value>,
    /// `previous_value` -> `value` per JSON path, masked by the target's
    /// secret paths; empty for version 0.
    pub changes: Vec<Value>,
}

type HistoryRow = (
    i64,
    String,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

const HISTORY_COLUMNS: &str = "h.version, h.kind, h.reverted_to, h.actor_username, h.actor_id, \
     h.actor_kind, h.origin, h.comment, h.published_at";

fn history_entry_from_row(
    target: &str,
    (
        version,
        kind,
        reverted_to,
        actor_username,
        actor_id,
        actor_kind,
        origin,
        comment,
        published_at,
    ): HistoryRow,
) -> Result<ConfigHistoryEntry, BantoError> {
    Ok(ConfigHistoryEntry {
        version,
        kind: ConfigHistoryKind::from_stored(target, &kind)?,
        reverted_to,
        actor_username,
        actor_id,
        actor_kind,
        origin,
        comment,
        published_at,
    })
}

impl ConfigDraftsService {
    /// Every registered target, in the order of registration: the published
    /// version and revision, the draft (without its value) and the valid
    /// lock. One statement for all targets. Rows of keys that are no longer
    /// registered are left out.
    pub async fn list(&self) -> Result<Vec<ConfigTargetSummary>, BantoError> {
        type ListRow = (
            String,
            i64,
            String,
            String,
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
        let sql = "SELECT p.target, p.version, p.revision, p.published_at, \
                          d.base_version, d.revision, d.updated_by, d.updated_at, \
                          l.holder, l.holder_name, l.lease, l.acquired_at_ms, l.expires_at_ms \
                   FROM config_published p \
                   LEFT JOIN config_drafts d ON d.target = p.target \
                   LEFT JOIN config_locks l ON l.target = p.target";
        let rows: Vec<ListRow> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(sql).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(sql).fetch_all(pool).await,
        }
        .map_err(storage_error)?;
        let now = self.now_ms();
        let mut found: std::collections::HashMap<String, ConfigTargetSummary> = rows
            .into_iter()
            .map(|row| {
                let (target, version, revision, published_at, base, draft_revision, by, at, ..) =
                    row;
                // Every column of the joined tables is NOT NULL, so one NULL
                // means the row is not there.
                let draft = match (base, draft_revision, by, at) {
                    (Some(base_version), Some(revision), Some(updated_by), Some(updated_at)) => {
                        Some(ConfigDraftSummary {
                            base_version,
                            revision,
                            updated_by,
                            updated_at,
                        })
                    }
                    _ => None,
                };
                let lock = match (row.8, row.9, row.10, row.11, row.12) {
                    (Some(holder), Some(name), Some(lease), Some(acquired), Some(expires)) => Some(
                        ConfigLock::from_row((holder, name, lease, acquired, expires)),
                    ),
                    _ => None,
                }
                .filter(|lock| lock.is_valid(now));
                (
                    target.clone(),
                    ConfigTargetSummary {
                        target,
                        version,
                        revision,
                        published_at,
                        draft,
                        lock,
                    },
                )
            })
            .collect();
        self.targets
            .targets()
            .iter()
            .map(|target| {
                found
                    .remove(target.key())
                    .ok_or_else(|| not_seeded(target.key()))
            })
            .collect()
    }

    /// What a write would change, per JSON path, with the marks of what was
    /// compared (see [`ConfigDiff`] and the module doc: one statement).
    ///
    /// - `to_version: None` - **published -> draft**: what a publish would
    ///   change. Always against what is published NOW, so a draft with an old
    ///   base shows how it would overwrite the other person's change. No
    ///   draft is `not_found`.
    /// - `to_version: Some(n)` - **published -> version n**: what a revert to
    ///   `n` would change. A version that is not in the history is
    ///   `not_found`.
    ///
    /// Values under the target's secret paths are masked; nothing is cut.
    pub async fn diff(
        &self,
        target: &str,
        to_version: Option<i64>,
    ) -> Result<ConfigDiff, BantoError> {
        let registered = self.target(target)?;
        let masked = masked_of(registered);
        let dialect = self.db.dialect();
        match to_version {
            None => {
                type Row = (
                    String,
                    i64,
                    String,
                    Option<String>,
                    Option<String>,
                    Option<i64>,
                );
                let sql = format!(
                    "SELECT p.value, p.version, p.revision, d.value, d.revision, d.base_version \
                     FROM config_published p \
                     LEFT JOIN config_drafts d ON d.target = p.target \
                     WHERE p.target = {}",
                    dialect.placeholder(1)
                );
                let row: Option<Row> = match &self.db {
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
                let Some((value, version, revision, draft_value, draft_revision, base_version)) =
                    row
                else {
                    return Err(not_seeded(target));
                };
                let (Some(draft_value), Some(draft_revision), Some(base_version)) =
                    (draft_value, draft_revision, base_version)
                else {
                    return Err(no_draft(target));
                };
                Ok(ConfigDiff {
                    target: target.to_string(),
                    published_version: version,
                    published_revision: revision,
                    draft_revision: Some(draft_revision),
                    base_version: Some(base_version),
                    to_version: None,
                    changes: diff_paths(
                        &stored_value(target, &value)?,
                        &stored_value(target, &draft_value)?,
                        &masked,
                    ),
                })
            }
            Some(to_version) => {
                type Row = (String, i64, String, Option<String>);
                let sql = format!(
                    "SELECT p.value, p.version, p.revision, h.value \
                     FROM config_published p \
                     LEFT JOIN config_history h ON h.target = p.target AND h.version = {} \
                     WHERE p.target = {}",
                    dialect.placeholder(1),
                    dialect.placeholder(2),
                );
                let row: Option<Row> = match &self.db {
                    Db::Sqlite(pool) => {
                        sqlx::query_as(sqlx::AssertSqlSafe(sql))
                            .bind(to_version)
                            .bind(target)
                            .fetch_optional(pool)
                            .await
                    }
                    #[cfg(feature = "postgres")]
                    Db::Postgres(pool) => {
                        sqlx::query_as(sqlx::AssertSqlSafe(sql))
                            .bind(to_version)
                            .bind(target)
                            .fetch_optional(pool)
                            .await
                    }
                }
                .map_err(storage_error)?;
                let Some((value, version, revision, history_value)) = row else {
                    return Err(not_seeded(target));
                };
                let Some(history_value) = history_value else {
                    return Err(no_version(target, to_version));
                };
                Ok(ConfigDiff {
                    target: target.to_string(),
                    published_version: version,
                    published_revision: revision,
                    draft_revision: None,
                    base_version: None,
                    to_version: Some(to_version),
                    changes: diff_paths(
                        &stored_value(target, &value)?,
                        &stored_value(target, &history_value)?,
                        &masked,
                    ),
                })
            }
        }
    }

    /// The history of `target`, newest first, without the values: who
    /// published or reverted what version, from where, when.
    ///
    /// - `before`: only versions below it (the last version of the page
    ///   before); `None` starts at the newest.
    /// - `limit`: kept within 1..=[`MAX_CONFIG_HISTORY_PAGE`].
    pub async fn history(
        &self,
        target: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Vec<ConfigHistoryEntry>, BantoError> {
        self.target(target)?;
        let dialect = self.db.dialect();
        let limit = i64::from(limit.clamp(1, MAX_CONFIG_HISTORY_PAGE));
        let before = before.unwrap_or(i64::MAX);
        let sql = format!(
            "SELECT {HISTORY_COLUMNS} FROM config_history h \
             WHERE h.target = {} AND h.version < {} \
             ORDER BY h.version DESC LIMIT {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
        );
        let rows: Vec<HistoryRow> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(before)
                    .bind(limit)
                    .fetch_all(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(before)
                    .bind(limit)
                    .fetch_all(pool)
                    .await
            }
        }
        .map_err(storage_error)?;
        rows.into_iter()
            .map(|row| history_entry_from_row(target, row))
            .collect()
    }

    /// One version of the history with its value and the value of the
    /// version before it - "after" and "before" of that publish, read by one
    /// statement. The values are whole (reverting needs them); `changes` is
    /// the masked diff between the two. A version that is not in the history
    /// is `not_found`.
    pub async fn history_entry(
        &self,
        target: &str,
        version: i64,
    ) -> Result<ConfigHistoryDetail, BantoError> {
        type Row = (
            i64,
            String,
            Option<i64>,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
        );
        let registered = self.target(target)?;
        let dialect = self.db.dialect();
        let sql = format!(
            "SELECT {HISTORY_COLUMNS}, h.value, b.value FROM config_history h \
             LEFT JOIN config_history b ON b.target = h.target AND b.version = h.version - 1 \
             WHERE h.target = {} AND h.version = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
        );
        let row: Option<Row> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(version)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(target)
                    .bind(version)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(storage_error)?;
        let Some((
            v,
            kind,
            reverted_to,
            username,
            id,
            actor_kind,
            origin,
            comment,
            at,
            value,
            previous,
        )) = row
        else {
            return Err(no_version(target, version));
        };
        let entry = history_entry_from_row(
            target,
            (
                v,
                kind,
                reverted_to,
                username,
                id,
                actor_kind,
                origin,
                comment,
                at,
            ),
        )?;
        let value = stored_value(target, &value)?;
        let previous_value = match previous {
            Some(text) => Some(stored_value(target, &text)?),
            None => None,
        };
        let masked = masked_of(registered);
        let changes = previous_value
            .as_ref()
            .map(|previous| diff_paths(previous, &value, &masked))
            .unwrap_or_default();
        Ok(ConfigHistoryDetail {
            entry,
            value,
            previous_value,
            changes,
        })
    }
}
