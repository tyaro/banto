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
}
