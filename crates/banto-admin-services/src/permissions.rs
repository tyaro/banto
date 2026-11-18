//! Per-user permissions, separate from the role (Issue #697,
//! user-permissions-plan §3-§5).
//!
//! `Role` (`viewer < editor < admin`) is a total order: a higher role always
//! includes a lower one. Some apps need a duty that does not follow that
//! order (banto-industrial's "運転操作" must not come with "設定を直す"
//! automatically, and an admin must not get it implicitly). A permission is
//! that second axis: a key such as `equipment.operate` that an admin grants
//! to individual accounts. The decision is only "does the account hold this
//! key"; the role is not looked at (user-permissions-plan §3-2).
//!
//! This module holds only the vocabulary and its validation:
//!
//! - [`PermissionKey`]: a validated key (`equipment.operate` style, see
//!   [`PermissionKey::parse`]).
//! - [`PermissionCatalog`]: the keys the app registers at startup, with the
//!   message keys of their display names (user-permissions-plan §3-3). Banto
//!   registers none itself: the template's catalog is empty.
//! - [`PermissionDiff`]: what a write added and removed, for the audit
//!   detail (user-permissions-plan §7).
//! - [`SessionPermissions`]: what a session holds, carried next to (not
//!   inside) the session structs (user-permissions-plan §8-7).
//!
//! The rows live in `user_permissions` (migration 0013) and are read and
//! written by [`crate::users::UsersService`]. Authorization (the REST
//! `PermissionGuard` and the Tauri `require_permission`) is the wiring
//! layer's job (conventions §2): nothing here knows about sessions or HTTP.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;

use banto_core::{BantoError, FieldError};
use serde::{Deserialize, Serialize};

/// Longest accepted key, in bytes. Generous for `area.subject.verb` keys and
/// small enough that a key never bloats a session or an audit row.
pub const MAX_PERMISSION_KEY_LEN: usize = 64;

/// A permission key (user-permissions-plan §5): two or more dot-separated
/// segments, each `[a-z][a-z0-9_]*`, so the whole key matches
/// `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` - e.g. `equipment.operate`,
/// `alarm.ack`. At most [`MAX_PERMISSION_KEY_LEN`] bytes.
///
/// The only ways to build one are [`PermissionKey::parse`] /
/// [`FromStr`](std::str::FromStr) / `Deserialize`, all of which validate, so
/// holding a `PermissionKey` means the format is right. Whether the app
/// registered the key is a separate question ([`PermissionCatalog`]).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PermissionKey(String);

impl PermissionKey {
    /// Validate `raw` as a permission key. `None` when the format is wrong.
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.is_empty() || raw.len() > MAX_PERMISSION_KEY_LEN {
            return None;
        }
        let mut segments = 0;
        for segment in raw.split('.') {
            let mut chars = segment.chars();
            match chars.next() {
                Some(c) if c.is_ascii_lowercase() => {}
                _ => return None,
            }
            if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                return None;
            }
            segments += 1;
        }
        (segments >= 2).then(|| Self(raw.to_string()))
    }

    /// Parse what a client sent as `permissions` (the REST body / Tauri
    /// argument): every string must be a well-formed key, or the whole list
    /// is a `Validation` error on the `permissions` field. Duplicates
    /// collapse; the result is sorted. Whether each key is registered is
    /// checked by the write itself ([`crate::users::UsersService`]).
    pub fn parse_all(raw: &[String]) -> Result<Vec<Self>, BantoError> {
        let mut keys = BTreeSet::new();
        for value in raw {
            keys.insert(Self::parse(value).ok_or_else(|| invalid_permission(value))?);
        }
        Ok(keys.into_iter().collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PermissionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for PermissionKey {
    type Err = BantoError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw).ok_or_else(|| invalid_permission(raw))
    }
}

impl<'de> Deserialize<'de> for PermissionKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("invalid permission key: {raw:?}")))
    }
}

/// The field name of every permission validation error (the `permissions`
/// field of `PUT /api/users/{id}` / `users_update`).
const PERMISSIONS_FIELD: &str = "permissions";

fn invalid_permission(raw: &str) -> BantoError {
    // Bounded echo: the value is caller input.
    let shown: String = raw.chars().take(MAX_PERMISSION_KEY_LEN).collect();
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: PERMISSIONS_FIELD.to_string(),
            message: format!("権限の形式が正しくありません: {shown}"),
        }],
    }
}

pub(crate) fn unknown_permission(key: &PermissionKey) -> BantoError {
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: PERMISSIONS_FIELD.to_string(),
            message: format!("登録されていない権限です: {key}"),
        }],
    }
}

/// One registered permission (user-permissions-plan §5): the key plus the
/// message keys the admin screen looks its display name and description up
/// with (the app's own messages, user-permissions-plan §6 i18n).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEntry {
    pub key: PermissionKey,
    pub label_key: String,
    pub description_key: String,
}

/// The permissions an app registers at startup (user-permissions-plan §3-3,
/// §8-2). The template registers none ([`PermissionCatalog::empty`]); a
/// derived app builds its own and hands it to
/// [`crate::users::UsersService::with_permission_catalog`].
///
/// Used for two things: validating what an admin grants (an unregistered key
/// is a `Validation` error) and filtering what a session holds (a key left
/// in `user_permissions` after the app stopped registering it is treated as
/// not held, user-permissions-plan §4). Kept in registration order for the
/// admin screen. `Clone` is cheap (`Arc`).
#[derive(Debug, Clone, Default)]
pub struct PermissionCatalog {
    entries: Arc<Vec<PermissionEntry>>,
}

impl PermissionCatalog {
    /// No permissions: the template's catalog.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Add a permission. `key` is validated ([`PermissionKey::parse`]); a
    /// malformed or duplicate key is a startup bug of the app, reported as
    /// `BantoError::Other` so it fails loudly instead of being skipped.
    pub fn register(
        self,
        key: &str,
        label_key: &str,
        description_key: &str,
    ) -> Result<Self, BantoError> {
        let key = PermissionKey::parse(key)
            .ok_or_else(|| BantoError::Other(format!("invalid permission key: {key:?}")))?;
        if self.contains(&key) {
            return Err(BantoError::Other(format!(
                "permission registered twice: {key}"
            )));
        }
        let mut entries = (*self.entries).clone();
        entries.push(PermissionEntry {
            key,
            label_key: label_key.to_string(),
            description_key: description_key.to_string(),
        });
        Ok(Self {
            entries: Arc::new(entries),
        })
    }

    /// The registered permissions, in registration order.
    pub fn entries(&self) -> &[PermissionEntry] {
        &self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, key: &PermissionKey) -> bool {
        self.entries.iter().any(|entry| &entry.key == key)
    }

    /// Validate what a caller asked to grant (the `permissions` of a user
    /// update, or `auth.disabled_permissions`): every string must be a
    /// well-formed key ([`PermissionKey::parse`]) the catalog registers.
    /// Duplicates collapse. The first failure is a `Validation` error on the
    /// `permissions` field.
    pub fn validate(&self, raw: &[String]) -> Result<BTreeSet<PermissionKey>, BantoError> {
        let mut keys = BTreeSet::new();
        for value in raw {
            let key = PermissionKey::parse(value).ok_or_else(|| invalid_permission(value))?;
            if !self.contains(&key) {
                return Err(unknown_permission(&key));
            }
            keys.insert(key);
        }
        Ok(keys)
    }

    /// The subset of `held` the catalog registers: what a session is
    /// authorized with (user-permissions-plan §4 - an unregistered key left
    /// in the table is not held).
    pub fn effective<'a>(
        &self,
        held: impl IntoIterator<Item = &'a PermissionKey>,
    ) -> BTreeSet<PermissionKey> {
        held.into_iter()
            .filter(|key| self.contains(key))
            .cloned()
            .collect()
    }
}

/// What a permission write changed (user-permissions-plan §5,
/// [`crate::users::UsersService::set_permissions`]): the keys granted and the
/// keys revoked, each sorted. Both empty = nothing changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PermissionDiff {
    pub added: Vec<PermissionKey>,
    pub removed: Vec<PermissionKey>,
}

impl PermissionDiff {
    /// `before` -> `after`.
    pub fn between(before: &BTreeSet<PermissionKey>, after: &BTreeSet<PermissionKey>) -> Self {
        Self {
            added: after.difference(before).cloned().collect(),
            removed: before.difference(after).cloned().collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

/// The permissions a session is authorized with (Issue #697,
/// user-permissions-plan §5, owner decision §8-7): the account's stored keys
/// that the [`PermissionCatalog`] registers, read per request.
///
/// A separate type on purpose: the session structs (`Identity`,
/// `UserIdentity`, ...) are built with struct literals by derived apps, so a
/// new field there would be a breaking change. The REST wiring puts one of
/// these into the request extensions (`require_auth`); the Tauri wiring reads
/// it per command. A viewer-public (grant) session and, by default, the
/// auth-disabled mode hold none ([`SessionPermissions::none`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SessionPermissions(BTreeSet<PermissionKey>);

impl SessionPermissions {
    /// No permissions (a grant session, the default auth-disabled mode).
    pub fn none() -> Self {
        Self::default()
    }

    /// Exactly `keys`. Callers filter by the catalog first
    /// ([`PermissionCatalog::effective`]).
    pub fn new(keys: BTreeSet<PermissionKey>) -> Self {
        Self(keys)
    }

    /// Does the session hold `permission`? Only the permission is looked at,
    /// never the role (user-permissions-plan §3-2).
    pub fn has(&self, permission: &PermissionKey) -> bool {
        self.0.contains(permission)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The held keys, sorted.
    pub fn iter(&self) -> impl Iterator<Item = &PermissionKey> {
        self.0.iter()
    }

    /// The held keys as a sorted list (the `permissions` of a session JSON).
    pub fn to_vec(&self) -> Vec<PermissionKey> {
        self.0.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format_follows_the_plan() {
        for ok in ["equipment.operate", "alarm.ack", "a.b", "a1_x.b2.c_3"] {
            assert!(PermissionKey::parse(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            "equipment",
            "Equipment.operate",
            "equipment.Operate",
            ".operate",
            "equipment.",
            "equipment..operate",
            "1x.operate",
            "equipment._operate",
            "equipment-x.operate",
            "equipment.operate ",
            "設備.運転",
        ] {
            assert!(PermissionKey::parse(bad).is_none(), "{bad:?}");
        }
        let long = format!("a.{}", "b".repeat(MAX_PERMISSION_KEY_LEN - 1));
        assert!(PermissionKey::parse(&long).is_none());
        let max = format!("a.{}", "b".repeat(MAX_PERMISSION_KEY_LEN - 2));
        assert!(PermissionKey::parse(&max).is_some());
    }

    #[test]
    fn deserialize_validates_and_serialize_is_the_plain_string() {
        let key: PermissionKey = serde_json::from_str(r#""alarm.ack""#).unwrap();
        assert_eq!(serde_json::to_string(&key).unwrap(), r#""alarm.ack""#);
        assert!(serde_json::from_str::<PermissionKey>(r#""ALARM""#).is_err());
    }

    fn catalog() -> PermissionCatalog {
        PermissionCatalog::empty()
            .register(
                "equipment.operate",
                "perm.equipment_operate",
                "perm.equipment_operate_desc",
            )
            .unwrap()
            .register("alarm.ack", "perm.alarm_ack", "perm.alarm_ack_desc")
            .unwrap()
    }

    #[test]
    fn register_rejects_bad_and_duplicate_keys_and_keeps_order() {
        let c = catalog();
        let keys: Vec<_> = c.entries().iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["equipment.operate", "alarm.ack"]);
        assert!(c.clone().register("alarm.ack", "x", "y").is_err());
        assert!(c.register("NOPE", "x", "y").is_err());
        assert!(PermissionCatalog::empty().is_empty());
    }

    #[test]
    fn validate_accepts_registered_keys_and_rejects_the_rest_as_validation() {
        let c = catalog();
        let ok = c
            .validate(&["alarm.ack".into(), "alarm.ack".into()])
            .unwrap();
        assert_eq!(ok.len(), 1);
        for bad in ["bad key", "other.thing"] {
            match c.validate(&[bad.to_string()]) {
                Err(BantoError::Validation { field_errors }) => {
                    assert_eq!(field_errors[0].field, "permissions");
                }
                other => panic!("{bad}: expected Validation, got {other:?}"),
            }
        }
        // The template's empty catalog accepts only "no permissions".
        assert!(PermissionCatalog::empty().validate(&[]).unwrap().is_empty());
        assert!(PermissionCatalog::empty()
            .validate(&["alarm.ack".into()])
            .is_err());
    }

    #[test]
    fn effective_drops_unregistered_keys() {
        let held: BTreeSet<_> = ["alarm.ack", "gone.away"]
            .iter()
            .map(|k| PermissionKey::parse(k).unwrap())
            .collect();
        let eff = catalog().effective(&held);
        assert_eq!(
            eff.iter().map(PermissionKey::as_str).collect::<Vec<_>>(),
            ["alarm.ack"]
        );
    }

    #[test]
    fn diff_between_sets() {
        let set = |ks: &[&str]| -> BTreeSet<PermissionKey> {
            ks.iter()
                .map(|k| PermissionKey::parse(k).unwrap())
                .collect()
        };
        let d = PermissionDiff::between(&set(&["a.x", "b.y"]), &set(&["b.y", "c.z"]));
        assert_eq!(d.added, vec![PermissionKey::parse("c.z").unwrap()]);
        assert_eq!(d.removed, vec![PermissionKey::parse("a.x").unwrap()]);
        assert!(PermissionDiff::between(&set(&["a.x"]), &set(&["a.x"])).is_empty());
    }

    #[test]
    fn session_permissions_has_only_what_it_holds() {
        let held = catalog().effective(&[PermissionKey::parse("alarm.ack").unwrap()]);
        let session = SessionPermissions::new(held);
        assert!(session.has(&PermissionKey::parse("alarm.ack").unwrap()));
        assert!(!session.has(&PermissionKey::parse("equipment.operate").unwrap()));
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            serde_json::json!(["alarm.ack"])
        );
        assert!(SessionPermissions::none().is_empty());
    }
}
