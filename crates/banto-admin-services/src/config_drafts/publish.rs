//! Publish, revert, rebase (config-draft-publish-design §4.6; §7, step S1b):
//! the only writes that change a target's published value, plus the one that
//! moves a draft onto a newer published version.
//!
//! A publish or a revert is ONE transaction. It fixes the published row
//! (`with_target_write!`), checks its conditions against what it read there,
//! adds the next version to the history, rewrites the published row, and (a
//! publish) deletes the draft and the lock. A failure anywhere rolls all of it
//! back: the published row, the history, the draft and the lock stay as they
//! were.

use super::*;
use crate::audit::diff::{diff_paths, diff_paths_clipped, ClippedPathChanges};

/// Upper bound of a publish / revert comment, in characters.
pub const MAX_CONFIG_COMMENT_CHARS: usize = 500;

/// What made a version (the history's `kind` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigHistoryKind {
    /// Version 0: the registered default, written by `ensure_targets`.
    Initial,
    Publish,
    Revert,
}

impl ConfigHistoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Publish => "publish",
            Self::Revert => "revert",
        }
    }

    pub(super) fn from_stored(target: &str, raw: &str) -> Result<Self, BantoError> {
        match raw {
            "initial" => Ok(Self::Initial),
            "publish" => Ok(Self::Publish),
            "revert" => Ok(Self::Revert),
            _ => Err(BantoError::Storage(format!(
                "config target {target}: unknown history kind"
            ))),
        }
    }
}

/// "Who, from where" of a publish or a revert, written to the history row in
/// the same transaction. The wiring builds it from the session it authorized
/// (the audit actor) and the path (`rest` / `tauri`); the service does not
/// check it against anything.
#[derive(Debug, Clone, Copy)]
pub struct PublishStamp<'a> {
    pub actor_username: &'a str,
    pub actor_id: Option<i64>,
    pub actor_kind: &'a str,
    pub origin: &'a str,
    /// At most [`MAX_CONFIG_COMMENT_CHARS`] characters. Blank is no comment.
    pub comment: Option<&'a str>,
}

/// The answer to a publish or a revert: the version that was made.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    pub target: String,
    pub kind: ConfigHistoryKind,
    /// The new published version (`previous_version + 1`).
    pub version: i64,
    pub previous_version: i64,
    /// The new published revision.
    pub revision: String,
    pub published_at: String,
    /// For a revert: the version whose value is published again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted_to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Previous published value -> new one, per JSON path
    /// ([`diff_paths`]): masked by the target's secret paths, values not cut.
    pub changes: Vec<Value>,
    /// The same diff within the audit limits, for [`publish_audit_detail`].
    #[serde(skip)]
    audit_changes: ClippedPathChanges,
}

/// The audit `detail` of a publish or a revert (design §4.8):
/// `{ version, previousVersion, revertedTo?, comment?, changes,
/// changesTruncated? }`. `changes` is masked and cut to the audit limits
/// ([`diff_paths_clipped`]); the whole JSON is never in it. Both paths (REST
/// and Tauri) call this, so their audit rows cannot differ.
pub fn publish_audit_detail(outcome: &PublishOutcome) -> Value {
    let mut detail = json!({
        "version": outcome.version,
        "previousVersion": outcome.previous_version,
        "changes": outcome.audit_changes.changes,
    });
    if let Some(reverted_to) = outcome.reverted_to {
        detail["revertedTo"] = json!(reverted_to);
    }
    if let Some(comment) = &outcome.comment {
        detail["comment"] = json!(comment);
    }
    if outcome.audit_changes.truncated {
        detail["changesTruncated"] = json!(true);
    }
    detail
}

/// The comment as it is stored: trimmed, `None` when blank.
fn stamp_comment(stamp: &PublishStamp<'_>) -> Result<Option<String>, BantoError> {
    let Some(comment) = stamp.comment.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    if comment.chars().count() > MAX_CONFIG_COMMENT_CHARS {
        return Err(field_error(
            "comment",
            &format!("コメントは{MAX_CONFIG_COMMENT_CHARS}文字までにしてください"),
        ));
    }
    Ok(Some(comment.to_string()))
}

/// `stale_base`: the draft was started from a published version that is no
/// longer the published one. `current.published` is the published version
/// and revision as they are now (not the value); the screen shows the diff
/// against it and rebases.
fn stale_base(published: &PublishedConfig, base_version: i64) -> BantoError {
    BantoError::Conflict {
        message: "下書きを作った後に本番の設定が変更されています".to_string(),
        current: Some(json!({
            "reason": "stale_base",
            "baseVersion": base_version,
            "published": {
                "version": published.version,
                "revision": published.revision,
            },
        })),
    }
}

/// Refuse when someone else holds a valid lock (`lock_held`). Free, expired
/// or the editor's own lock all pass.
fn refuse_if_held_by_other(
    lock: Option<&ConfigLock>,
    editor: &ConfigEditor,
    now_ms: i64,
) -> Result<(), BantoError> {
    match lock.filter(|lock| lock.is_valid(now_ms) && lock.holder != editor.holder) {
        Some(other) => Err(lock_conflict("lock_held", Some(other))),
        None => Ok(()),
    }
}

/// Steps 6 and 7 of a publish (design §4.6), inside a write that fixed the
/// published row: add version `published.version + 1` to the history and
/// rewrite the published row to it. Gives (version, revision, published_at).
///
/// - The history's primary key `(target, version)` refuses a version that is
///   already there; the error leaves the function and the transaction rolls
///   back.
/// - The UPDATE names the version it read (`AND version = <read>`) and must
///   write one row - a second guard on top of the row lock.
/// - `published_at` is the time of the INSERT ([`now_text`]): after the
///   published row was fixed, so a write that waited for another one records
///   when it ran, not when it started waiting. Both rows get the SAME text:
///   the published row copies the history row's.
macro_rules! write_next_version {
    ($tx:ident, $dialect:expr, $target:expr, $published:expr, $text:expr,
     $kind:expr, $reverted_to:expr, $stamp:expr, $comment:expr) => {{
        let Some(version) = $published.version.checked_add(1) else {
            return Err(BantoError::BadRequest(
                "この設定はこれ以上の版を作れません".to_string(),
            ));
        };
        let revision = new_revision();
        let sql = format!(
            "INSERT INTO config_history \
                 (target, version, value, kind, reverted_to, \
                  actor_username, actor_id, actor_kind, origin, comment, published_at) \
             VALUES ({}, {})",
            $dialect.placeholders(10),
            now_text($dialect)
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind($target)
            .bind(version)
            .bind($text)
            .bind($kind.as_str())
            .bind($reverted_to)
            .bind($stamp.actor_username)
            .bind($stamp.actor_id)
            .bind($stamp.actor_kind)
            .bind($stamp.origin)
            .bind($comment)
            .execute(&mut *$tx)
            .await
            .map_err(storage_error)?;
        let sql = format!(
            "UPDATE config_published \
             SET value = {}, version = {}, revision = {}, \
                 published_at = (SELECT h.published_at FROM config_history h \
                                 WHERE h.target = {} AND h.version = {}) \
             WHERE target = {} AND version = {} \
             RETURNING published_at",
            $dialect.placeholder(1),
            $dialect.placeholder(2),
            $dialect.placeholder(3),
            $dialect.placeholder(4),
            $dialect.placeholder(5),
            $dialect.placeholder(6),
            $dialect.placeholder(7),
        );
        let written: Option<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind($text)
            .bind(version)
            .bind(&revision)
            .bind($target)
            .bind(version)
            .bind($target)
            .bind($published.version)
            .fetch_optional(&mut *$tx)
            .await
            .map_err(storage_error)?;
        let Some((published_at,)) = written else {
            return Err(BantoError::Storage(
                "config_published: expected to write 1 row, wrote 0".to_string(),
            ));
        };
        (version, revision, published_at)
    }};
}

impl ConfigDraftsService {
    /// Move the draft onto the published version the editor has checked
    /// (design §4.6, rebase). The value is not changed; the draft's "base
    /// version" becomes the published version, and the draft gets a NEW
    /// revision - so a publish screen opened before the rebase (holding the
    /// old `ifDraftRevision`) no longer goes through.
    ///
    /// Both conditions are checked inside the write:
    ///
    /// - `if_revision`: the draft's revision the editor has. Another
    ///   revision, or no draft, is a conflict (`draft_changed`).
    /// - `if_published_revision`: the published revision of the diff the
    ///   editor looked at. When the published value moved on again after
    ///   that, a conflict (`published_changed`) and nothing is rebased - a
    ///   change nobody looked at is never marked as seen.
    ///
    /// Needs the editor's own valid lock (`lock_required`) and, like a draft
    /// save, moves its expiry forward. There is no automatic merge: this
    /// only records that a person compared the draft with what is published
    /// now.
    pub async fn draft_rebase(
        &self,
        target: &str,
        editor: &ConfigEditor,
        if_revision: &str,
        if_published_revision: &str,
    ) -> Result<ConfigDraftSaved, BantoError> {
        let registered = self.target(target)?;
        check_token("ifRevision", if_revision)?;
        check_token("ifPublishedRevision", if_published_revision)?;
        let dialect = self.db.dialect();
        let now_text = now_text(dialect);
        let revision = new_revision();
        let (base_version, lock, value) = with_target_write!(self, target, |tx, published, at| {
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
            let Some(value) = draft
                .as_ref()
                .filter(|draft| draft.revision == if_revision)
                .map(|draft| draft.value.clone())
            else {
                return Err(draft_changed(draft.as_ref()));
            };
            if published.revision != if_published_revision {
                return Err(published_changed(&published));
            }
            // The revision is in the WHERE too (conventions §6), on top of
            // the row lock.
            let sql = format!(
                "UPDATE config_drafts \
                 SET base_version = {}, revision = {}, updated_by = {}, updated_at = {now_text} \
                 WHERE target = {} AND revision = {}",
                dialect.placeholder(1),
                dialect.placeholder(2),
                dialect.placeholder(3),
                dialect.placeholder(4),
                dialect.placeholder(5),
            );
            let done = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(published.version)
                .bind(&revision)
                .bind(&editor.name)
                .bind(target)
                .bind(if_revision)
                .execute(&mut *tx)
                .await
                .map_err(storage_error)?;
            expect_one_row(done.rows_affected(), "config_drafts")?;
            set_lock_expiry!(tx, dialect, target, expires_at_ms);
            lock.expires_at_ms = expires_at_ms;
            (published.version, lock, value)
        });
        Ok(ConfigDraftSaved {
            revision,
            base_version,
            // After the commit: the result does not decide the rebase.
            validation: registered.validate(&value).err().unwrap_or_default(),
            lock,
        })
    }

    /// Publish the draft: it becomes the published value at the next version
    /// (design §4.6, "反映"). One transaction; in this order:
    ///
    /// 1. fix the published row and read it;
    /// 2. no draft is `not_found`; a draft that is not at `if_draft_revision`
    ///    (the revision of the diff the person confirmed) is a conflict
    ///    (`draft_changed`);
    /// 3. a draft whose base version is not the published version is a
    ///    conflict (`stale_base`, with the published version and revision) -
    ///    the screen then shows the diff and rebases
    ///    ([`ConfigDraftsService::draft_rebase`]);
    /// 4. someone else's valid lock is a conflict (`lock_held`). No lock, an
    ///    expired one or the editor's own all pass;
    /// 5. the target's validator must pass (`validation`, 422), and the value
    ///    must differ from the published one (`bad_request`: no version
    ///    without a change);
    /// 6. the history gets the new version (`kind = 'publish'`, the stamp);
    /// 7. the published row is rewritten (value, version, a new revision);
    /// 8. the draft and the lock rows are deleted.
    ///
    /// When any step fails nothing is changed. The validator runs inside the
    /// transaction (see [`ConfigTarget::with_validator`]: pure and fast).
    pub async fn publish(
        &self,
        target: &str,
        editor: &ConfigEditor,
        if_draft_revision: &str,
        stamp: &PublishStamp<'_>,
    ) -> Result<PublishOutcome, BantoError> {
        let registered = self.target(target)?;
        check_token("ifDraftRevision", if_draft_revision)?;
        let comment = stamp_comment(stamp)?;
        let masked = masked_of(registered);
        let dialect = self.db.dialect();
        let outcome = with_target_write!(self, target, |tx, published, at| {
            let Some(draft) = fetch_draft!(tx, dialect, target) else {
                return Err(no_draft(target));
            };
            if draft.revision != if_draft_revision {
                return Err(draft_changed(Some(&draft)));
            }
            if draft.base_version != published.version {
                return Err(stale_base(&published, draft.base_version));
            }
            let lock = fetch_lock!(tx, dialect, target);
            refuse_if_held_by_other(lock.as_ref(), editor, at.now_ms)?;
            registered
                .validate(&draft.value)
                .map_err(|field_errors| BantoError::Validation { field_errors })?;
            if draft.value == published.value {
                return Err(BantoError::BadRequest(
                    "本番と同じ内容なので反映するものがありません".to_string(),
                ));
            }
            let text = value_text(&draft.value)?;
            let (version, revision, published_at) = write_next_version!(
                tx,
                dialect,
                target,
                published,
                &text,
                ConfigHistoryKind::Publish,
                None::<i64>,
                stamp,
                comment.as_deref()
            );
            let sql = format!(
                "DELETE FROM config_drafts WHERE target = {} AND revision = {}",
                dialect.placeholder(1),
                dialect.placeholder(2),
            );
            let done = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(target)
                .bind(if_draft_revision)
                .execute(&mut *tx)
                .await
                .map_err(storage_error)?;
            expect_one_row(done.rows_affected(), "config_drafts")?;
            delete_lock!(tx, dialect, target);
            PublishOutcome {
                target: target.to_string(),
                kind: ConfigHistoryKind::Publish,
                version,
                previous_version: published.version,
                revision,
                published_at,
                reverted_to: None,
                comment: comment.clone(),
                changes: diff_paths(&published.value, &draft.value, &masked),
                audit_changes: diff_paths_clipped(&published.value, &draft.value, &masked),
            }
        });
        Ok(outcome)
    }

    /// Publish the value of an earlier version again, as a NEW version
    /// (design §4.6, "元に戻す"). Nothing is removed from the history:
    /// reverting version 3 to version 1 makes version 4 with version 1's
    /// value (`kind = 'revert'`, `reverted_to = 1`).
    ///
    /// - `to_version`: 0 or more and below the published version. "The value
    ///   before version N was published" is `to_version = N - 1`.
    /// - `if_published_revision`: the published revision the screen showed.
    ///   Another one is a conflict (`published_changed`).
    /// - Someone else's valid lock is a conflict (`lock_held`).
    /// - The value must pass the validator AS IT IS NOW (`validation`, 422):
    ///   an old value the present validator refuses cannot come back, and
    ///   there is no way around the validator (design §11).
    /// - A value equal to the published one is refused (`bad_request`).
    ///
    /// The draft and the lock are left alone. A draft that exists now has an
    /// old base: its publish answers `stale_base` until it is rebased.
    pub async fn revert(
        &self,
        target: &str,
        editor: &ConfigEditor,
        to_version: i64,
        if_published_revision: &str,
        stamp: &PublishStamp<'_>,
    ) -> Result<PublishOutcome, BantoError> {
        let registered = self.target(target)?;
        check_token("ifPublishedRevision", if_published_revision)?;
        if to_version < 0 {
            return Err(field_error("toVersion", "版は 0 以上で指定してください"));
        }
        let comment = stamp_comment(stamp)?;
        let masked = masked_of(registered);
        let dialect = self.db.dialect();
        let outcome = with_target_write!(self, target, |tx, published, at| {
            if published.revision != if_published_revision {
                return Err(published_changed(&published));
            }
            if to_version >= published.version {
                return Err(field_error(
                    "toVersion",
                    "いまの本番より前の版を指定してください",
                ));
            }
            let lock = fetch_lock!(tx, dialect, target);
            refuse_if_held_by_other(lock.as_ref(), editor, at.now_ms)?;
            let sql = format!(
                "SELECT value FROM config_history WHERE target = {} AND version = {}",
                dialect.placeholder(1),
                dialect.placeholder(2),
            );
            let row: Option<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
                .bind(target)
                .bind(to_version)
                .fetch_optional(&mut *tx)
                .await
                .map_err(storage_error)?;
            let Some((text,)) = row else {
                return Err(no_version(target, to_version));
            };
            let value = stored_value(target, &text)?;
            registered
                .validate(&value)
                .map_err(|field_errors| BantoError::Validation { field_errors })?;
            if value == published.value {
                return Err(BantoError::BadRequest(
                    "本番と同じ内容なので元に戻すものがありません".to_string(),
                ));
            }
            let (version, revision, published_at) = write_next_version!(
                tx,
                dialect,
                target,
                published,
                &text,
                ConfigHistoryKind::Revert,
                Some(to_version),
                stamp,
                comment.as_deref()
            );
            PublishOutcome {
                target: target.to_string(),
                kind: ConfigHistoryKind::Revert,
                version,
                previous_version: published.version,
                revision,
                published_at,
                reverted_to: Some(to_version),
                comment: comment.clone(),
                changes: diff_paths(&published.value, &value, &masked),
                audit_changes: diff_paths_clipped(&published.value, &value, &masked),
            }
        });
        Ok(outcome)
    }
}
