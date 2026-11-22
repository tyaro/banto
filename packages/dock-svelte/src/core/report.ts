/**
 * Run a callback of the app's that only hears about a change already made (`onLayoutCommit`,
 * `replaceLayout`'s `applied`; PR #842 review). What it throws must not stop the code that made
 * the change - the gesture's `onGestureEnd`, the pending `replaceLayout` and its release of the
 * next gesture - and must not be swallowed either: it is reported like an exception nobody caught
 * (`reportError`: the window's `error` event and the console), or thrown from a task of its own
 * where there is no `reportError`.
 */
export function notify(callback: () => void): void {
	try {
		callback();
	} catch (error) {
		if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
		else
			setTimeout(() => {
				throw error;
			}, 0);
	}
}
