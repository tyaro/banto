/**
 * "Is a pointer button held right now?" - for `Menu.openAt()` (#889).
 *
 * A `popover="auto"` shown while a button is held is closed again by that
 * gesture's own `pointerup`: the browser's light dismiss compares where the
 * press started (no popover yet) with where it ends, and a menu placed beside
 * the pointer is under neither. `contextmenu` fires on the press on macOS /
 * Linux (on the release on Windows), so a menu opened from it has to wait for
 * the release. Keyboard opens (Shift+F10, the Menu key) have no gesture and
 * open at once.
 *
 * One set of window listeners for every menu, installed on first use. Only a
 * `pointerup` runs what waited for the release. A gesture that ends any other
 * way - `pointercancel`, the window losing focus (another window took the
 * press), a key, or a button-less `pointermove` (the release went somewhere
 * the page never saw) - **drops** it: a menu must not appear late, after the
 * user has moved on (#889 review).
 *
 * Package-internal (not exported from `index.ts`).
 */

let installed = false;
let held = false;
let waiting: Array<() => void> = [];

function release(): void {
	held = false;
	if (waiting.length === 0) return;
	const run = waiting;
	waiting = [];
	// After the event is done: the light dismiss of this very `pointerup` must
	// be over before anything is shown.
	setTimeout(() => {
		for (const callback of run) callback();
	}, 0);
}

function cancel(): void {
	held = false;
	waiting = [];
}

function install(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener(
		'pointerdown',
		() => {
			held = true;
		},
		true
	);
	window.addEventListener('pointerup', release, true);
	window.addEventListener('pointercancel', cancel, true);
	window.addEventListener(
		'pointermove',
		(event) => {
			if (held && event.buttons === 0) cancel();
		},
		true
	);
	window.addEventListener('keydown', cancel, true);
	window.addEventListener('blur', cancel);
}

/** Starts watching (idempotent; a no-op without a DOM). Call on mount, before any gesture. */
export function trackPointerGesture(): void {
	install();
}

/**
 * Runs `callback` now when no pointer button is held, otherwise once the
 * current gesture has been released (after its `pointerup` has been
 * dispatched). A cancelled gesture never runs it.
 */
export function afterPointerRelease(callback: () => void): void {
	install();
	if (held) waiting.push(callback);
	else callback();
}
