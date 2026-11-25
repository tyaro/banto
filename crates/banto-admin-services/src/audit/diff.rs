//! Field-level diff for `update` audit records (Issue #597).
//!
//! The wiring layers (REST and Tauri) call [`diff_changes`] with the row
//! before and after an update and put the result in `detail.changes`, so both
//! routes record the same shape (conventions section 1). The service layer
//! stays audit-unaware (conventions section 2): it only returns the previous
//! row.
//!
//! Secrets (conventions section 5): the caller must name the fields to mask in
//! `masked_fields` (a required argument, so omitting it is a compile error).
//! A masked field that changed is recorded as `{ "field", "masked": true }`
//! with no values.
//!
//! [`diff_paths`] / [`diff_paths_clipped`] (Issue #938,
//! config-draft-publish-design §4.7) are the same idea for a nested JSON
//! document: one entry per changed JSON Pointer path instead of per top-level
//! field. [`diff_changes`] itself is unchanged.

use serde_json::{json, Value};

/// Strings longer than this many characters are cut (a trailing `…` marks the
/// cut) so a huge value cannot bloat the audit log. Strings nested in arrays
/// and objects are cut too.
pub const MAX_VALUE_CHARS: usize = 200;

fn clip(value: &Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > MAX_VALUE_CHARS => {
            let mut out: String = s.chars().take(MAX_VALUE_CHARS).collect();
            out.push('…');
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(clip).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), clip(v))).collect())
        }
        other => other.clone(),
    }
}

/// Diff two JSON objects field by field.
///
/// Returns one entry per changed field: `{ "field", "before", "after" }`, or
/// `{ "field", "masked": true }` for a field in `masked_fields`. Fields in
/// `ignored_fields` (e.g. an `updatedAt` stamp) are skipped. A field missing
/// on one side is reported as `null` on that side. Non-object input yields an
/// empty list. Order follows the field names (sorted), so it is stable.
pub fn diff_changes(
    before: &Value,
    after: &Value,
    masked_fields: &[&str],
    ignored_fields: &[&str],
) -> Vec<Value> {
    let (Some(b), Some(a)) = (before.as_object(), after.as_object()) else {
        return Vec::new();
    };
    let mut names: Vec<&String> = b.keys().chain(a.keys()).collect();
    names.sort();
    names.dedup();
    let null = Value::Null;
    let mut out = Vec::new();
    for name in names {
        if ignored_fields.contains(&name.as_str()) {
            continue;
        }
        // Compare presence too: a field going from missing to `null` (or back)
        // is a change; only the output shows the missing side as `null`.
        let (bo, ao) = (b.get(name), a.get(name));
        if bo == ao {
            continue;
        }
        let (bv, av) = (bo.unwrap_or(&null), ao.unwrap_or(&null));
        if masked_fields.contains(&name.as_str()) {
            out.push(json!({ "field": name, "masked": true }));
        } else {
            out.push(json!({ "field": name, "before": clip(bv), "after": clip(av) }));
        }
    }
    out
}

/// The most entries [`diff_paths_clipped`] keeps (the audit `detail` must
/// stay small; config-draft-publish-design §4.7).
pub const MAX_PATH_CHANGES: usize = 100;

/// The result of [`diff_paths_clipped`]: the entries that were kept, and
/// whether some were dropped (the audit `detail` then carries
/// `changesTruncated: true`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClippedPathChanges {
    pub changes: Vec<Value>,
    pub truncated: bool,
}

/// One JSON Pointer reference token (RFC 6901 section 3): `~` is `~0`, `/` is
/// `~1`.
fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Is `inner` the path `outer` or a path below it? Compared token by token,
/// so `/ab` is not below `/a`.
fn at_or_below(inner: &str, outer: &str) -> bool {
    inner == outer
        || inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Must the entry at `path` be masked? Yes when a masked path is the same as,
/// above, or below it: the entry's values hold (or may hold) the secret in
/// each of the three cases.
fn touches_masked(path: &str, masked_paths: &[&str]) -> bool {
    masked_paths
        .iter()
        .any(|masked| at_or_below(path, masked) || at_or_below(masked, path))
}

fn walk_paths(
    before: Option<&Value>,
    after: Option<&Value>,
    path: &str,
    masked_paths: &[&str],
    out: &mut Vec<Value>,
) {
    if let (Some(Value::Object(b)), Some(Value::Object(a))) = (before, after) {
        let mut names: Vec<&String> = b.keys().chain(a.keys()).collect();
        names.sort();
        names.dedup();
        for name in names {
            let child = format!("{path}/{}", pointer_token(name));
            walk_paths(b.get(name), a.get(name), &child, masked_paths, out);
        }
        return;
    }
    // Presence counts: missing and `null` differ (as in `diff_changes`); only
    // the output shows the missing side as `null`.
    if before == after {
        return;
    }
    if touches_masked(path, masked_paths) {
        out.push(json!({ "field": path, "masked": true }));
    } else {
        out.push(json!({
            "field": path,
            "before": before.unwrap_or(&Value::Null),
            "after": after.unwrap_or(&Value::Null),
        }));
    }
}

/// Diff two JSON documents path by path (config-draft-publish-design §4.7).
///
/// One entry per changed path, in the shape of [`diff_changes`] -
/// `{ "field", "before", "after" }` or `{ "field", "masked": true }` - where
/// `field` is a JSON Pointer (RFC 6901, e.g. `/limits/high`; the whole
/// document is `""`). Values are NOT cut: this is for the screen that shows a
/// change before it is published. For an audit `detail` use
/// [`diff_paths_clipped`].
///
/// - Objects are walked into. An array is ONE value (an insert would shift
///   every later index and make a per-index diff unreadable). So is an object
///   on one side only (added, removed, or replaced by another type): the
///   entry is at the parent path and carries the whole value.
/// - A side that is missing is shown as `null`; missing and `null` still
///   differ.
/// - Order: depth first, keys sorted at each level (stable).
///
/// Secrets (conventions section 5): `masked_paths` is required (JSON
/// Pointers; write `&[]` for none). An entry is masked as a whole when a
/// masked path is the SAME as its path, ABOVE it, or BELOW it. "Below"
/// matters: `/devices/0/token` is never an entry's path (arrays are one
/// value), so the change shows up at `/devices`, and that entry would carry
/// the token. Nothing is masked in part - an entry that may hold a secret
/// carries no values at all.
pub fn diff_paths(before: &Value, after: &Value, masked_paths: &[&str]) -> Vec<Value> {
    let mut out = Vec::new();
    walk_paths(Some(before), Some(after), "", masked_paths, &mut out);
    out
}

/// [`diff_paths`] for an audit `detail`: strings are cut at
/// [`MAX_VALUE_CHARS`] (nested ones too) and at most [`MAX_PATH_CHANGES`]
/// entries are kept; `truncated` says whether entries were dropped. Masking
/// is done before anything is dropped or cut.
pub fn diff_paths_clipped(
    before: &Value,
    after: &Value,
    masked_paths: &[&str],
) -> ClippedPathChanges {
    let mut changes = diff_paths(before, after, masked_paths);
    let truncated = changes.len() > MAX_PATH_CHANGES;
    changes.truncate(MAX_PATH_CHANGES);
    for change in &mut changes {
        for side in ["before", "after"] {
            if let Some(value) = change.get_mut(side) {
                *value = clip(value);
            }
        }
    }
    ClippedPathChanges { changes, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_changed_fields_and_ignored_are_skipped() {
        let b = json!({"name": "a", "price": 1, "updatedAt": "x"});
        let a = json!({"name": "a", "price": 2, "updatedAt": "y"});
        let c = diff_changes(&b, &a, &[], &["updatedAt"]);
        assert_eq!(c, vec![json!({"field": "price", "before": 1, "after": 2})]);
        assert!(diff_changes(&b, &b, &[], &[]).is_empty());
    }

    #[test]
    fn masked_field_carries_no_values() {
        let b = json!({"token": "old-secret"});
        let a = json!({"token": "new-secret"});
        let c = diff_changes(&b, &a, &["token"], &[]);
        assert_eq!(c, vec![json!({"field": "token", "masked": true})]);
        assert!(!serde_json::to_string(&c).unwrap().contains("secret"));
        // unchanged masked field is not reported at all
        assert!(diff_changes(&b, &b, &["token"], &[]).is_empty());
    }

    #[test]
    fn long_strings_are_clipped_by_chars() {
        let long = "あ".repeat(MAX_VALUE_CHARS + 50);
        let c = diff_changes(&json!({"n": "x"}), &json!({"n": long}), &[], &[]);
        let after = c[0]["after"].as_str().unwrap();
        assert_eq!(after.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(after.ends_with('…'));
    }

    #[test]
    fn nested_long_strings_are_clipped() {
        let long = "x".repeat(MAX_VALUE_CHARS + 10);
        let after = json!({"n": {"tags": [long.clone()], "note": long}});
        let c = diff_changes(&json!({"n": null}), &after, &[], &[]);
        let n = &c[0]["after"];
        for s in [&n["tags"][0], &n["note"]] {
            let s = s.as_str().unwrap();
            assert_eq!(s.chars().count(), MAX_VALUE_CHARS + 1);
            assert!(s.ends_with('…'));
        }
    }

    #[test]
    fn missing_side_is_null() {
        let c = diff_changes(&json!({}), &json!({"a": 1}), &[], &[]);
        assert_eq!(c, vec![json!({"field": "a", "before": null, "after": 1})]);
    }

    #[test]
    fn missing_to_null_and_back_is_a_change() {
        let c = diff_changes(&json!({}), &json!({"x": null}), &[], &[]);
        assert_eq!(
            c,
            vec![json!({"field": "x", "before": null, "after": null})]
        );
        let c = diff_changes(&json!({"x": null}), &json!({}), &[], &[]);
        assert_eq!(
            c,
            vec![json!({"field": "x", "before": null, "after": null})]
        );
    }

    #[test]
    fn non_object_side_gives_empty_list() {
        assert!(diff_changes(&json!(null), &json!({"a": 1}), &[], &[]).is_empty());
        assert!(diff_changes(&json!({"a": 1}), &json!([1]), &[], &[]).is_empty());
    }

    // --- diff_paths (config-draft-publish-design §6 T9) ---

    #[test]
    fn paths_nested_added_removed_and_unchanged() {
        let b = json!({"limits": {"high": 10, "low": 1}, "name": "a", "gone": true});
        let a = json!({"limits": {"high": 12, "low": 1}, "name": "a", "added": "x"});
        let c = diff_paths(&b, &a, &[]);
        assert_eq!(
            c,
            vec![
                json!({"field": "/added", "before": null, "after": "x"}),
                json!({"field": "/gone", "before": true, "after": null}),
                json!({"field": "/limits/high", "before": 10, "after": 12}),
            ]
        );
        assert!(diff_paths(&b, &b, &[]).is_empty());
    }

    #[test]
    fn paths_null_and_missing_differ() {
        let c = diff_paths(&json!({"a": {}}), &json!({"a": {"x": null}}), &[]);
        assert_eq!(
            c,
            vec![json!({"field": "/a/x", "before": null, "after": null})]
        );
        assert!(diff_paths(&json!({"x": null}), &json!({"x": null}), &[]).is_empty());
    }

    #[test]
    fn paths_array_is_one_value() {
        let c = diff_paths(&json!({"list": [1, 2, 3]}), &json!({"list": [1, 3]}), &[]);
        assert_eq!(
            c,
            vec![json!({"field": "/list", "before": [1, 2, 3], "after": [1, 3]})]
        );
    }

    #[test]
    fn paths_object_on_one_side_is_one_value_at_the_parent() {
        // added, removed, and replaced by another type
        let c = diff_paths(&json!({}), &json!({"a": {"x": 1}}), &[]);
        assert_eq!(
            c,
            vec![json!({"field": "/a", "before": null, "after": {"x": 1}})]
        );
        let c = diff_paths(&json!({"a": {"x": 1}}), &json!({"a": "text"}), &[]);
        assert_eq!(
            c,
            vec![json!({"field": "/a", "before": {"x": 1}, "after": "text"})]
        );
    }

    #[test]
    fn paths_escape_pointer_tokens_and_keep_dots() {
        let c = diff_paths(&json!({}), &json!({"a/b": 1, "c~d": 2, "e.f": 3}), &[]);
        let fields: Vec<&str> = c.iter().map(|e| e["field"].as_str().unwrap()).collect();
        assert_eq!(fields, vec!["/a~1b", "/c~0d", "/e.f"]);
    }

    #[test]
    fn paths_non_object_root_is_one_entry_at_the_empty_pointer() {
        let c = diff_paths(&json!([1]), &json!({"a": 1}), &[]);
        assert_eq!(
            c,
            vec![json!({"field": "", "before": [1], "after": {"a": 1}})]
        );
        // any masked path is below the root
        let c = diff_paths(&json!([1]), &json!({"a": 1}), &["/a"]);
        assert_eq!(c, vec![json!({"field": "", "masked": true})]);
    }

    #[test]
    fn paths_masked_same_and_below_carry_no_values() {
        let b = json!({"auth": {"token": "OLD-SECRET", "extra": {"k": "DEEP-OLD"}}, "n": 1});
        let a = json!({"auth": {"token": "NEW-SECRET", "extra": {"k": "DEEP-NEW"}}, "n": 2});
        let c = diff_paths(&b, &a, &["/auth/token", "/auth/extra"]);
        assert_eq!(
            c,
            vec![
                json!({"field": "/auth/extra/k", "masked": true}),
                json!({"field": "/auth/token", "masked": true}),
                json!({"field": "/n", "before": 1, "after": 2}),
            ]
        );
        let text = serde_json::to_string(&c).unwrap();
        assert!(!text.contains("SECRET") && !text.contains("DEEP"));
        // a sibling whose name only starts the same is not masked
        let c = diff_paths(&json!({"ab": 1}), &json!({"ab": 2}), &["/a"]);
        assert_eq!(c, vec![json!({"field": "/ab", "before": 1, "after": 2})]);
    }

    /// The parent of a secret: a secret inside an array, an object with a
    /// secret added or removed as a whole, and a type change. Each is ONE
    /// masked entry and the raw value is nowhere in the output.
    #[test]
    fn paths_masked_parent_carries_no_values() {
        let masked = ["/devices/0/token", "/auth/token"];
        let cases = [
            // secret inside an array (the index is not looked at)
            (
                json!({"devices": [{"name": "a", "token": "RAW-ONE"}]}),
                json!({"devices": [{"name": "b", "token": "RAW-TWO"}]}),
                "/devices",
            ),
            // object holding a secret, added as a whole
            (
                json!({}),
                json!({"auth": {"token": "RAW-ONE", "user": "RAW-TWO"}}),
                "/auth",
            ),
            // ... and removed as a whole
            (
                json!({"auth": {"token": "RAW-ONE", "user": "RAW-TWO"}}),
                json!({}),
                "/auth",
            ),
            // type change: object -> string, and back
            (
                json!({"auth": {"token": "RAW-ONE"}}),
                json!({"auth": "RAW-TWO"}),
                "/auth",
            ),
            (
                json!({"auth": "RAW-ONE"}),
                json!({"auth": {"token": "RAW-TWO"}}),
                "/auth",
            ),
        ];
        for (b, a, field) in cases {
            for c in [
                diff_paths(&b, &a, &masked),
                diff_paths_clipped(&b, &a, &masked).changes,
            ] {
                assert_eq!(c, vec![json!({"field": field, "masked": true})]);
                assert!(!serde_json::to_string(&c).unwrap().contains("RAW"));
            }
        }
    }

    #[test]
    fn paths_clipped_cuts_strings_and_caps_the_count() {
        let long = "あ".repeat(MAX_VALUE_CHARS + 50);
        let b = json!({"note": "x", "nested": {"list": ["y"]}});
        let a = json!({"note": long, "nested": {"list": [long]}});
        // the unclipped diff keeps the whole value
        let full = diff_paths(&b, &a, &[]);
        assert_eq!(
            full[1]["after"].as_str().unwrap().chars().count(),
            MAX_VALUE_CHARS + 50
        );
        let clipped = diff_paths_clipped(&b, &a, &[]);
        assert!(!clipped.truncated);
        for s in [
            &clipped.changes[0]["after"][0],
            &clipped.changes[1]["after"],
        ] {
            let s = s.as_str().unwrap();
            assert_eq!(s.chars().count(), MAX_VALUE_CHARS + 1);
            assert!(s.ends_with('…'));
        }

        let many = |n: usize| {
            Value::Object(
                (0..n)
                    .map(|i| (format!("k{i:04}"), json!(i)))
                    .collect::<serde_json::Map<_, _>>(),
            )
        };
        let at_limit = diff_paths_clipped(&json!({}), &many(MAX_PATH_CHANGES), &[]);
        assert_eq!(at_limit.changes.len(), MAX_PATH_CHANGES);
        assert!(!at_limit.truncated);
        let over = diff_paths_clipped(&json!({}), &many(MAX_PATH_CHANGES + 1), &[]);
        assert_eq!(over.changes.len(), MAX_PATH_CHANGES);
        assert!(over.truncated);
        assert_eq!(over.changes[0]["field"], "/k0000");
    }
}
