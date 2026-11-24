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
 * One set of window listeners for every menu, installed on first use. A
 * release the page never sees (the browser's own context menu took it, the
 * pointer left the window) would leave the flag stuck, so a button-less
 * `pointermove`, a `keydown` and a window `blur` also clear it.
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
	window.addEventListener('pointercancel', release, true);
	window.addEventListener(
		'pointermove',
		(event) => {
			if (held && event.buttons === 0) release();
		},
		true
	);
	window.addEventListener('keydown', release, true);
	window.addEventListener('blur', release);
}

/** Starts watching (idempotent; a no-op without a DOM). Call on mount, before any gesture. */
export function trackPointerGesture(): void {
	install();
}

/**
 * Runs `callback` now when no pointer button is held, otherwise once the
 * current gesture has ended (after its `pointerup` has been dispatched).
 */
export function afterPointerRelease(callback: () => void): void {
	install();
	if (held) waiting.push(callback);
	else callback();
}
