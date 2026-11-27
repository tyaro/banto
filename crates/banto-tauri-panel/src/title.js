// Runs in a panel window before any script of the page (Issue #1024): the document is
// named after the panel from the moment its <title> exists, so a screen reader that reads
// the document while the app is still starting reads the panel's name - not the static
// title of the app's HTML shell. The page keeps the last word: a title it sets later (its
// own <svelte:head>) replaces this one.
//
// `src/title.rs` calls this function with the window's title. Kept as a file of its own so
// that the browser test (e2e/visual/panel-window-sr.spec.ts) runs the same text.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- an expression on purpose: the caller appends the call
(function (title) {
	var observer = null;
	// `final`: the parser is done - no <title> can still be half-read.
	function apply(final) {
		var el = document.querySelector('title');
		// Wait until something follows the <title> (its end tag has been read): setting the
		// text of a half-parsed element would be appended to by the parser.
		if (!final && !(el && (el.nextSibling || document.body))) return;
		if (observer) observer.disconnect();
		document.removeEventListener('DOMContentLoaded', onLoaded);
		if (document.title !== title) document.title = title;
	}
	function onLoaded() {
		apply(true);
	}
	if (document.readyState !== 'loading') return apply(true);
	observer = new MutationObserver(function () {
		apply(false);
	});
	observer.observe(document, { childList: true, subtree: true });
	document.addEventListener('DOMContentLoaded', onLoaded);
	apply(false);
});
