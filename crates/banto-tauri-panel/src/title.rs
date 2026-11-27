//! The script a panel window runs before its page (Issue #1024): it names
//! the document after the panel while the app's own code is still loading.
//!
//! A panel window loads the app's HTML shell, whose `<title>` is the app's
//! static one; the page replaces it only after its scripts have run. A screen
//! reader reads the document as soon as the window has the focus - in that
//! gap it read the shell's title, not the panel's. The plugin knows the title
//! when it builds the window (`open`'s `title`), so it hands the page a
//! script that puts it in place first. Pure (no Tauri): `plugin.rs` only
//! passes the result to `WebviewWindowBuilder::initialization_script`.

/// The function in `title.js` (an expression: `(function (title) { ... })`).
const TITLE_SCRIPT: &str = include_str!("title.js");

/// The initialization script for a panel window titled `title`: `title.js`
/// called with the title as a JSON string literal (valid JavaScript, whatever
/// the title holds - quotes, backslashes, line separators).
pub fn document_title_script(title: &str) -> String {
    // A `String` always serialises; the fallback only keeps this free of a
    // panic path.
    let literal = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".to_owned());
    let function = TITLE_SCRIPT.trim_end().trim_end_matches(';');
    format!("{function}({literal});")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_calls_the_function_with_the_title() {
        let script = document_title_script("月別更新件数");
        assert!(script.ends_with("})(\"月別更新件数\");"), "{script}");
        assert!(script.contains("(function (title) {"));
    }

    #[test]
    fn a_title_cannot_leave_its_string_literal() {
        let script = document_title_script("a\"); alert(1); (\"\\\nb");
        assert!(
            script.ends_with("})(\"a\\\"); alert(1); (\\\"\\\\\\nb\");"),
            "{script}"
        );
    }

    #[test]
    fn the_function_is_called_exactly_once() {
        // `title.js` ends with the closing of the function expression; a
        // formatter's trailing `;` must not end up between it and the call.
        let script = document_title_script("x");
        assert!(!script.contains(";(\"x\")"));
        assert_eq!(script.matches("(\"x\");").count(), 1);
    }
}
