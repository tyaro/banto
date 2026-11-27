/**
 * Pop-out panel windows (spec §5.3 v2, ADR-0037): the frontend half of the
 * Tauri plugin `banto-tauri-panel` (`crates/banto-tauri-panel`). A dock
 * panel becomes a real OS window (`openPanelWindow`), and when that window
 * is gone the plugin tells the main window (`banto://panel-closed`,
 * `listenPanelClosed`) so the panel can go back into the dock.
 * `createPanelPopOut` puts the two together in the shape a dock takes
 * (`onPopOut` + a subscription), and knows which panels are out in a window
 * right now (`isPoppedOut` / `subscribe` / `focus`, and - with a `storage` -
 * across a restart: `connect()` puts back the panels whose window is gone,
 * and a panel put back stays in that memory until `restore` says the dock's
 * layout was saved with it - Issue #1019), and closes their windows when the
 * dock has taken the panels back by itself (`closeWindows`, a layout reset -
 * Issue #1021).
 *
 * What the plugin does on the Rust side - one window per id (opening again
 * only brings it to the front), the position / size memory per id, closing
 * the panels with the main window - needs nothing from this module.
 *
 * Tauri only. Everything here is guarded by the injected `isTauri()`, and
 * `createPanelPopOut(...).onPopOut` is `undefined` in a browser: the
 * contract with `@banto/dock-svelte` is that a browser does not pass
 * `onPopOut` at all, so the pop-out button is not drawn. The guards inside
 * are a second line of defence.
 *
 * `invoke` / `listen` are injected so this package has no `@tauri-apps/api`
 * dependency of its own (same pattern as `providers/tauri.ts` and
 * `events.ts`). Nothing is imported from `@banto/dock-svelte` either
 * (conventions §4): `PanelWindowContent` is the part of its `PanelContent`
 * this module reads.
 */
import type { TauriEventListenOptions } from './events';

/**
 * Tauri event the main window receives when a panel window is gone; the
 * payload is the panel id. Mirrors `banto_tauri_panel::PANEL_CLOSED_EVENT`.
 */
export const PANEL_CLOSED_EVENT = 'banto://panel-closed';

/** The plugin's command, as `invoke` takes it (`plugin:<name>|<command>`). */
export const PANEL_OPEN_COMMAND = 'plugin:banto-tauri-panel|open';

/**
 * The plugin's command that answers the ids of the panel windows open right
 * now (`string[]`). Needs `banto-tauri-panel:allow-list` in the capability.
 */
export const PANEL_LIST_COMMAND = 'plugin:banto-tauri-panel|list';

/**
 * The plugin's command that closes the window of a panel id; it answers
 * whether there was one (`boolean`). Needs `banto-tauri-panel:allow-close`
 * in the capability.
 */
export const PANEL_CLOSE_COMMAND = 'plugin:banto-tauri-panel|close';

/** What a panel window is opened from: the panel's id and the window title. */
export interface PanelWindowContent {
	/**
	 * Panel id. The plugin accepts ASCII letters, digits, `-` and `_` (at most
	 * 64 characters) and rejects anything else - the id becomes part of the
	 * window's label and of the route it loads.
	 */
	id: string;
	title: string;
}

export interface PanelWindowEnvironment {
	/** True only in the Tauri webview (the app's own check, e.g. the template's `isTauri`). */
	isTauri: () => boolean;
}

export interface OpenPanelWindowOptions extends PanelWindowEnvironment {
	/** Pass `@tauri-apps/api/core`'s `invoke`. */
	invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface ListenPanelClosedOptions extends PanelWindowEnvironment {
	/**
	 * Pass `@tauri-apps/api/event`'s `listen` (or a function that imports it
	 * lazily and calls it).
	 */
	listen: TauriEventListenOptions['listen'];
}

/**
 * Asks the plugin to open `content` in its own window, or to bring that
 * window to the front if it is already open. Resolves when the window
 * exists; rejects with the plugin's message if it could not be opened (an
 * id the plugin refuses, a missing capability permission). No-op outside
 * Tauri.
 */
export async function openPanelWindow(
	content: PanelWindowContent,
	options: OpenPanelWindowOptions
): Promise<void> {
	if (!options.isTauri()) return;
	await options.invoke(PANEL_OPEN_COMMAND, { id: content.id, title: content.title });
}

/**
 * Asks the plugin which panel windows are open right now (their panel ids).
 * Rejects with the plugin's message (e.g. the capability lacks
 * `banto-tauri-panel:allow-list`), or when the answer is not a list of
 * strings. Resolves `[]` outside Tauri.
 */
export async function listPanelWindows(options: OpenPanelWindowOptions): Promise<string[]> {
	if (!options.isTauri()) return [];
	const answer = await options.invoke(PANEL_LIST_COMMAND);
	if (!Array.isArray(answer) || answer.some((id) => typeof id !== 'string')) {
		throw new Error(`${PANEL_LIST_COMMAND} did not answer a list of panel ids`);
	}
	return answer as string[];
}

/**
 * Asks the plugin to close the window of panel `id`. Resolves `true` when a
 * window was closed - the main window then still gets its
 * `banto://panel-closed`, like for any window that goes away - and `false`
 * when the plugin had no window for the id. Rejects with the plugin's message
 * (e.g. the capability lacks `banto-tauri-panel:allow-close`). Resolves
 * `false` outside Tauri.
 *
 * On its own this only closes the window. A panel `createPanelPopOut` has out
 * in a window is closed through its `closeWindows`, which also forgets it and
 * does not `restore` it on that notice.
 */
export async function closePanelWindow(
	id: string,
	options: OpenPanelWindowOptions
): Promise<boolean> {
	if (!options.isTauri()) return false;
	return (await options.invoke(PANEL_CLOSE_COMMAND, { id })) === true;
}

/**
 * Subscribes to "a panel window is gone" (`cb` gets the panel id). Returns
 * the unsubscribe function. Outside Tauri nothing is registered. If the
 * caller unsubscribes before the async `listen()` has resolved, the listener
 * is torn down as soon as it exists instead of leaking (same handling as
 * `createTauriEventProvider`). A payload that is not a string is ignored.
 */
export function listenPanelClosed(
	cb: (id: string) => void,
	options: ListenPanelClosedOptions
): () => void {
	return subscribePanelClosed(cb, options).stop;
}

/** How a subscription turned out: `error` is set when `listen()` failed. */
type SubscriptionResult = { ok: true } | { ok: false; error: unknown };

/**
 * `listenPanelClosed`, plus `ready`: it settles (never rejects) once the
 * registration has finished, so `createPanelPopOut` can wait for it before it
 * takes a panel out of the dock.
 */
function subscribePanelClosed(
	cb: (id: string) => void,
	options: ListenPanelClosedOptions
): { stop: () => void; ready: Promise<SubscriptionResult> } {
	if (!options.isTauri()) return { stop: () => {}, ready: Promise.resolve({ ok: true }) };

	let disposed = false;
	let unlisten: (() => void) | null = null;

	const ready = options
		.listen(PANEL_CLOSED_EVENT, (e) => {
			if (!disposed && typeof e.payload === 'string') cb(e.payload);
		})
		.then(
			(fn): SubscriptionResult => {
				if (disposed) fn();
				else unlisten = fn;
				return { ok: true };
			},
			// The subscription could not be made (no event permission, the
			// import failed). Nothing to tear down; `createPanelPopOut` refuses to
			// pop panels out meanwhile, since nothing would bring them back.
			(error: unknown): SubscriptionResult => ({ ok: false, error })
		);

	return {
		stop: () => {
			disposed = true;
			unlisten?.();
		},
		ready
	};
}

/**
 * Where `createPanelPopOut` keeps the ids of the panels that are out in a
 * window, so they survive the main window (Issue #1013) - e.g. a
 * `localStorage` entry. Both functions may throw; a failure only loses the
 * memory.
 */
export interface PanelPopOutStorage {
	/**
	 * The ids last saved (`[]` when nothing was). Read when the pop-out is
	 * created, and again when a `restore` promise confirms a save later
	 * (#1019: only that id is taken out of what is stored then).
	 */
	load: () => string[];
	/** Called with the whole list each time it changes. */
	save: (ids: string[]) => void;
}

/**
 * What `restore` may return to say when the dock's layout is saved with the
 * panel back in it (Issue #1019, see `PanelPopOutOptions.restore`): `false`
 * = not saved, keep the panel in the memory; a promise = wait for it.
 */
export type PanelRestoreSaved = void | boolean | PromiseLike<boolean | void>;

export interface PanelPopOutOptions<C extends PanelWindowContent = PanelWindowContent>
	extends OpenPanelWindowOptions, ListenPanelClosedOptions {
	/**
	 * Takes the panel out of the dock before its window opens - e.g.
	 * `async (c) => (await dockHost.closePanel(c.id)) === 'applied'`. Resolve
	 * `false` to cancel the pop-out (the panel stays where it is, no window is
	 * opened). Omitted = nothing to do first.
	 */
	detach?: (content: C) => boolean | Promise<boolean>;
	/**
	 * Puts the panel back into the dock - e.g. `(id) => dock.open(id)`. Called
	 * when the panel's window is gone, and when the window could not be
	 * opened after `detach` had already taken the panel out.
	 *
	 * What it returns says when the panel may be forgotten in `storage`
	 * (Issue #1019). The dock's saved layout lacks the panel since the pop-out,
	 * and saving the layout that has it again is somebody else's write, later
	 * and fallible; if the memory were dropped before that write landed, a
	 * failed write would lose the panel at the next start (the old layout, no
	 * memory).
	 * - nothing: forgotten at once - for a dock whose layout is not saved,
	 *   or an app that accepts that risk (the behaviour before #1019).
	 * - a promise (`PanelRestoreSaved`): the id stays in `storage` until it
	 *   resolves to anything but `false` - resolve it when the layout with
	 *   the panel is saved. While it is pending, and when it resolves `false`
	 *   or rejects, the id is kept: the next `createPanelPopOut` over the
	 *   same `storage` (the next start, or the next visit of the screen)
	 *   reads it and `connect()` restores the panel again. `false` returned
	 *   at once does the same.
	 *
	 * `isPoppedOut(id)` is `false` from the call on either way: only the
	 * stored memory waits.
	 *
	 * Typed `unknown` (read it as `PanelRestoreSaved`) so that a `restore`
	 * written before #1019 keeps compiling whatever its expression happens
	 * to return (`(id) => list.push(id)`): any other value is "nothing".
	 */
	restore: (id: string) => unknown;
	/**
	 * The pop-out did not happen: the window could not be opened (after
	 * `restore` has run), or the closed-notice subscription failed, in which
	 * case the panel was not detached at all.
	 */
	onError?: (error: unknown, content: C) => void;
	/**
	 * Remembers the popped-out ids across a restart (Issue #1013). The panel
	 * left the dock when it was popped out, and that is what the dock saves;
	 * if the main window goes first (the app is closed with a panel window
	 * open), nobody hears `banto://panel-closed`, and without this memory the
	 * panel is in neither place at the next start. With it, the next
	 * `connect()` restores every remembered id whose window is not open.
	 * Omitted = remembered only as long as this object lives.
	 *
	 * The list also holds the panels that were put back but whose layout is
	 * not known to be saved yet (see `restore`, Issue #1019): to the next
	 * reader they are the same thing - panels to restore unless their window
	 * is open.
	 */
	storage?: PanelPopOutStorage;
	/**
	 * `connect()` could not ask which panel windows are open (the `list`
	 * command failed - typically the capability lacks
	 * `banto-tauri-panel:allow-list`). Nothing was restored: the remembered
	 * panels stay "popped out" (see `createPanelPopOut`).
	 */
	onListError?: (error: unknown) => void;
}

/** What `PanelPopOut.closeWindows` did. */
export interface PanelWindowsClosed {
	/**
	 * The ids that have no window any more and are not popped out: a window
	 * was closed, or there was none to close. Forgotten in `storage` too -
	 * at once, or with `PanelWindowsCloseOptions.saved` once that says so.
	 */
	closed: string[];
	/**
	 * The ids whose window could not be closed, with the reason. Nothing
	 * changed for them: a panel that was popped out still is.
	 */
	failed: { id: string; error: unknown }[];
}

/** Options of `PanelPopOut.closeWindows`. */
export interface PanelWindowsCloseOptions {
	/**
	 * "The layout that has the panels back in the dock is saved" - the same
	 * answer `restore` may return (`PanelRestoreSaved` as a promise), and for
	 * the same reason: the dock's saved layout lacks a popped-out panel, and
	 * the write of the layout that has it again (the reset) is later and
	 * fallible. Given, the ids of the closed windows stay in `storage` until
	 * it resolves to anything but `false`; while it is pending, and when it
	 * resolves `false` or rejects, they are kept, and the next
	 * `createPanelPopOut` over the same `storage` restores those panels at
	 * its `connect()` (harmless when the layout read then has them already).
	 * Take it BEFORE the change that puts the panels back is reported.
	 *
	 * Omitted = forgotten at once: for a dock whose layout is not saved.
	 */
	saved?: PromiseLike<boolean | void>;
}

export interface PanelPopOut<C extends PanelWindowContent = PanelWindowContent> {
	/**
	 * Hand this to the dock (`DockHost` / `ThreePaneDock`'s `onPopOut`).
	 * `undefined` outside Tauri, so the dock draws no pop-out button there.
	 */
	onPopOut: ((content: C) => void) | undefined;
	/**
	 * Starts listening for closed panel windows and returns the function that
	 * stops it - the shape a Svelte `$effect` returns:
	 * `$effect(() => popOut.connect())`. No-op outside Tauri.
	 */
	connect: () => () => void;
	/**
	 * Is panel `id` out in its own window (popped out here and not yet put
	 * back)? A menu that lists the panels shows such a panel as on screen, and
	 * selecting it calls `focus` instead of showing it in the dock (Issue
	 * #1014: the dock itself cannot tell it from a closed panel). Always
	 * `false` outside Tauri.
	 */
	isPoppedOut: (id: string) => boolean;
	/**
	 * Calls `cb` each time the answer of `isPoppedOut` may have changed for
	 * some id; returns the unsubscribe function. This package does not depend
	 * on Svelte - in a Svelte 5 app wrap it once:
	 * `const track = createSubscriber((update) => popOut.subscribe(update))`
	 * (`svelte/reactivity`), and call `track()` before `isPoppedOut(id)`.
	 */
	subscribe: (cb: () => void) => () => void;
	/**
	 * Brings the window of a popped-out panel to the front (the plugin's
	 * `open` only focuses a window that exists). Does nothing for a panel that
	 * is not popped out - it never opens a second copy of a panel the dock
	 * shows - and outside Tauri. Rejects with the plugin's message.
	 */
	focus: (content: PanelWindowContent) => Promise<void>;
	/**
	 * Closes panel windows WITHOUT putting the panels back: for when the dock
	 * has them again by other means - a layout reset that put every panel in
	 * its default place (Issue #1021). Call it AFTER that change is in (and not
	 * at all when it was refused): from here on the dock is what shows the
	 * panels.
	 *
	 * `ids` omitted = the panels popped out here (`isPoppedOut`). Given = those
	 * ids, popped out here or not - the plugin only closes a window it built,
	 * so passing every panel of the dock also closes a window this object does
	 * not know of (one left open by a run without `storage`).
	 *
	 * For each id whose window is closed (or that had none): `isPoppedOut` is
	 * `false`, and `restore` is NOT called - not now, and not on the
	 * `banto://panel-closed` of that window either (also when the id is closed
	 * again before that notice has come). The id is gone from `storage` at
	 * once, or - with `options.saved` - once the layout that has the panel back
	 * is known to be saved (see `PanelWindowsCloseOptions.saved`).
	 *
	 * An id whose window could not be closed (the capability lacks
	 * `banto-tauri-panel:allow-close`, the plugin's error) is reported in
	 * `failed` and left as it was: still popped out, still remembered. Its
	 * window is still there, so the menu keeps showing it as on screen
	 * (`focus` brings it to the front), and closing that window later calls
	 * `restore` as usual - which has to be harmless for a panel the dock
	 * already shows (`@banto/dock-svelte`'s `dock.open` is). The same goes for
	 * an id whose window is being opened at that moment (a pop-out or `focus`
	 * in flight - nothing is asked of the plugin then), or that was popped out
	 * again while the plugin was asked.
	 *
	 * Never rejects. Resolves with nothing done outside Tauri.
	 */
	closeWindows: (
		ids?: readonly string[],
		options?: PanelWindowsCloseOptions
	) => Promise<PanelWindowsClosed>;
}

/**
 * The round trip in one piece: `onPopOut` detaches the panel and opens its
 * window; `connect()` restores the panel when the window is gone.
 *
 * A panel is only taken out of the dock once the closed-notice subscription
 * is known to work, because the notice is the only way it comes back. If
 * `onPopOut` runs while `connect()`'s registration is still pending it waits
 * for it; if the registration failed, nothing is detached and `onError`
 * gets the reason. If `connect()` is stopped (or replaced) while the pop-out
 * waits, or while `detach` runs, no window is opened: nothing was detached
 * yet in the first case, and `restore` puts the panel back in the second;
 * `onError` is not called, as leaving the screen is not a failure. (If `connect()` was never called, or has been stopped,
 * there is nothing to wait for and the pop-out proceeds - wiring `connect()`
 * is the caller's part.)
 *
 * Which panels are out is remembered (`isPoppedOut`; in `storage` too when
 * given): from the moment `detach` took the panel out of the dock until
 * `restore` puts it back. Each `connect()` then reconciles that memory with
 * the plugin (`list`): a remembered panel whose window is NOT open - the
 * main window was closed first last time, or the window closed while nothing
 * was connected - is restored and forgotten; one whose window IS open (the
 * main window was only reloaded, or the screen was left and entered again)
 * stays out, and comes back on its closed notice as usual. So call
 * `connect()` when `restore` can do its work for good: after a saved dock
 * layout has been loaded (a later load would overwrite the restored panel),
 * and make sure `restore` saves what it changed even while the dock UI is
 * not mounted (e.g. a narrow display without one): keep `connect()` running
 * then too, or a window closed meanwhile does not bring its panel back.
 *
 * Putting a panel back is only finished when the dock's layout is saved with
 * it (Issue #1019). `restore` may return a promise of that; until it resolves
 * `true` the id stays in `storage`, though `isPoppedOut` is already `false`.
 * A save that fails, a main window closed before the save, a session that
 * ended first - each leaves the id there, and the next start restores the
 * panel again (a retry). Once the save is confirmed the id is gone, so a
 * panel the user closes afterwards stays closed. A panel popped out again
 * while its save is still awaited is simply popped out: the older answer is
 * ignored.
 *
 * `closeWindows` is the other way a panel stops being popped out (Issue
 * #1021): the dock took the panels back by itself (a layout reset), so their
 * windows are closed and the panels are forgotten without a `restore` - the
 * closed notice of such a window is swallowed. Like a put-back, the stored
 * memory can wait for the save of the layout that has the panels again
 * (`closeWindows`' `saved`). A window that could not be closed keeps its
 * panel popped out (see `PanelPopOut.closeWindows`).
 *
 * If `list` fails, nothing is restored and `onListError` gets the reason.
 * Restoring blindly would be the other choice, and it is the worse one:
 * with a window still open (a reload, coming back to the screen) the panel
 * would be in the dock AND in its window - two live copies of one panel,
 * every time the screen is entered. Kept as "popped out" the panel is not
 * lost: the menu shows it as on screen, and selecting it (`focus`) opens its
 * window again, whose closing puts it back into the dock.
 *
 * ```ts
 * const popOut = createPanelPopOut<PanelContent>({
 * 	isTauri,
 * 	invoke,
 * 	listen: async (event, cb) => (await import('@tauri-apps/api/event')).listen(event, cb),
 * 	detach: async (c) => (await dockHost?.closePanel(c.id)) === 'applied',
 * 	// Without a saved layout. With one: return a promise of "saved" (above).
 * 	restore: (id) => dock.open(id)
 * });
 * $effect(() => popOut.connect());
 * // <DockHost onPopOut={popOut.onPopOut} ... />
 * ```
 */
/**
 * Per panel id, how many times a panel was popped out by any
 * `createPanelPopOut` in this page (Issue #1019). A late "saved" answer of a
 * pop-out whose screen was left must not take an id out of the storage when
 * a newer pop-out - another object on the same storage, after the screen was
 * entered again - has put that panel out in a window since: the stored lists
 * may even be equal, so only this tells them apart. Shared by every object on
 * purpose; two docks with the same id only cost one more `restore`.
 */
const popOutEpochs = new Map<string, number>();
const popOutEpochOf = (id: string) => popOutEpochs.get(id) ?? 0;

export function createPanelPopOut<C extends PanelWindowContent = PanelWindowContent>(
	options: PanelPopOutOptions<C>
): PanelPopOut<C> {
	let subscription: Promise<SubscriptionResult> | null = null;

	// The panels that are out of the dock because of a pop-out. Outside Tauri
	// nothing is ever popped out, and a memory another runtime left is not read.
	const popped = new Set<string>();
	if (options.isTauri() && options.storage) {
		try {
			const saved: unknown = options.storage.load();
			if (Array.isArray(saved)) {
				for (const id of saved) if (typeof id === 'string') popped.add(id);
			}
		} catch {
			// An unreadable memory is an empty one.
		}
	}
	// Pop-outs between "remembered" and "the window exists": the plugin does
	// not list their window yet, so the reconciliation leaves them alone.
	const opening = new Set<string>();
	// Per id, how many times an operation that opens its window has started
	// (`popOut`, `focus`). A list answer asked for before such a start does not
	// know that window, so `reconcile` does not trust it for that id.
	const generation = new Map<string, number>();
	const generationOf = (id: string) => generation.get(id) ?? 0;
	const startOpening = (id: string) => generation.set(id, generationOf(id) + 1);
	const listeners = new Set<() => void>();
	// Put back into the dock, but the layout that has them again is not known
	// to be saved (#1019): id -> the `restore` call whose answer is awaited.
	// Not "popped out" any more, yet still in `storage`, so that the next start
	// restores them again if that save never lands.
	const unsaved = new Map<string, { epoch: number }>();
	// Windows `closeWindows` is closing - the plugin has not answered yet
	// (#1021). `noticed` = the closed notice came meanwhile (the window is
	// gone, whatever the answer will be).
	const closing = new Map<string, { noticed: boolean }>();
	// Per id, how many windows `closeWindows` has closed whose closed notice
	// has not come yet: those notices must not `restore` the panel - the dock
	// already has it. A count, not a flag: closing an id again before the
	// notice (no window then, or a new one after a pop-out in between) must
	// not lose what is still owed for the earlier window.
	const owed = new Map<string, number>();
	// `closeWindows`' `saved` per id, for the close in flight to pick up.
	const keeps = new Map<string, PromiseLike<boolean | void>>();
	type CloseFailure = { error: unknown } | null;
	// The closes in flight, so that asking twice shares the one answer.
	const closes = new Map<string, Promise<CloseFailure>>();

	/** What `storage` holds: the panels the next start has to look at. */
	const stored = () => [...new Set([...popped, ...unsaved.keys()])];
	const keyOf = (ids: string[]) => [...ids].sort().join('\n');
	let lastStored = keyOf(stored());
	/**
	 * What the storage holds right now, as a key. Read again each time rather
	 * than trusted from this object's last write: another `createPanelPopOut`
	 * on the same storage (the screen left and entered again) may have
	 * changed it since. Falls back to the last write when it cannot be read.
	 */
	const storedNow = (): string => {
		if (!options.storage) return lastStored;
		try {
			const now: unknown = options.storage.load();
			if (Array.isArray(now)) {
				return keyOf(now.filter((other): other is string => typeof other === 'string'));
			}
		} catch {
			// Unreadable: trust this object's own last write.
		}
		return lastStored;
	};
	/** Writes the list when the storage does not already hold it. */
	const persist = () => {
		const ids = stored();
		const key = keyOf(ids);
		if (key === storedNow()) {
			lastStored = key;
			return;
		}
		lastStored = key;
		try {
			options.storage?.save(ids);
		} catch {
			// Best effort: a failed write only loses the memory across a restart.
		}
	};
	const notify = () => {
		for (const cb of [...listeners]) cb();
	};
	const remember = (id: string) => {
		// Out in a window again: an answer still awaited for an earlier put-back
		// is about a layout that is no longer the one to save.
		unsaved.delete(id);
		popOutEpochs.set(id, popOutEpochOf(id) + 1);
		if (popped.has(id)) return;
		popped.add(id);
		persist();
		notify();
	};
	/**
	 * The layout with the panel back in it is saved: the stored memory lets go
	 * of it. `call` is the `restore` call this answers - not the latest one
	 * for the id means the panel was popped out (or put back) again since.
	 * `late` = the answer came as a promise.
	 */
	const confirmSaved = (id: string, call: { epoch: number }, late: boolean) => {
		if (unsaved.get(id) !== call) return;
		unsaved.delete(id);
		if (popped.has(id)) return;
		if (!late || !options.storage) {
			persist();
			return;
		}
		// A late answer may come after the screen was left and entered again,
		// with another `createPanelPopOut` writing the same `storage` since
		// (the write flushed on leaving is answered then). The newer one may
		// hold this same id again for a newer pop-out, which this old answer
		// knows nothing of (and the lists can be equal, so they cannot tell).
		// So the id is taken out only while no pop-out of it has happened since
		// it was put back (`popOutEpochs`); otherwise it is left, and the next
		// `connect()` looks at it again - at worst restoring a panel once more.
		if (popOutEpochOf(id) !== call.epoch) return;
		// Take this one id out of what is stored now rather than write this
		// object's own, possibly older, list over it.
		try {
			const now: unknown = options.storage.load();
			if (Array.isArray(now)) {
				const ids = now.filter((other): other is string => typeof other === 'string');
				if (ids.includes(id)) options.storage.save(ids.filter((other) => other !== id));
				lastStored = keyOf(stored());
				return;
			}
		} catch {
			// Unreadable or unwritable: fall back to this object's list.
		}
		persist();
	};
	/** Lets go of the stored id once `saved` resolves to anything but `false`. */
	const awaitSaved = (id: string, call: { epoch: number }, saved: PromiseLike<unknown>) => {
		void Promise.resolve(saved).then(
			(answer) => {
				if (answer !== false) confirmSaved(id, call, true);
			},
			// Not saved as far as anyone knows: kept for the next start.
			() => {}
		);
	};
	/**
	 * The panel goes back into the dock: no longer popped out before `restore`
	 * runs (so `restore` sees it as such), but kept in `storage` until
	 * `restore` says the layout was saved (#1019; at once when it returns
	 * nothing). A `restore` that throws leaves it stored too.
	 */
	const putBack = (id: string) => {
		const call = { epoch: popOutEpochOf(id) };
		const wasPopped = popped.delete(id);
		unsaved.set(id, call);
		// Already stored when it was popped out; a notice for a panel this
		// object did not know is stored now.
		persist();
		if (wasPopped) notify();
		const result = options.restore(id);
		if (result === false) return;
		const thenable =
			typeof result === 'object' &&
			result !== null &&
			typeof (result as { then?: unknown }).then === 'function';
		if (!thenable) {
			confirmSaved(id, call, false);
			return;
		}
		awaitSaved(id, call, result as PromiseLike<unknown>);
	};

	/** A closed notice: the panel goes back, unless `closeWindows` closed that window. */
	const onClosed = (id: string) => {
		// The oldest window first: a notice owed for a window closed earlier is
		// that window's, also while a later close of the id is in flight.
		const owes = owed.get(id) ?? 0;
		if (owes > 0) {
			if (owes === 1) owed.delete(id);
			else owed.set(id, owes - 1);
			return;
		}
		const close = closing.get(id);
		if (close) {
			close.noticed = true;
			return;
		}
		putBack(id);
	};
	/** `closeWindows` for one id: resolves to the reason when the panel is left as it was. */
	const closeOne = async (id: string): Promise<CloseFailure> => {
		if (opening.has(id)) {
			// A pop-out or `focus` is opening this window right now: closing it
			// would race with that. Left as it is, for the caller to see.
			return { error: new Error(`the window of panel "${id}" is being opened`) };
		}
		const asked = generationOf(id);
		const close = { noticed: false };
		closing.set(id, close);
		let had = false;
		let failure: CloseFailure = null;
		try {
			had = await closePanelWindow(id, options);
		} catch (error) {
			failure = { error };
		}
		if (closing.get(id) === close) closing.delete(id);
		const keep = keeps.get(id);
		keeps.delete(id);
		// Was there a window that is gone now?
		let gone = had;
		if (close.noticed) {
			// The window went away while the plugin was asked - also when the
			// plugin then answered with an error: gone is what was wanted, and
			// its notice has been taken already.
			failure = null;
			had = false;
			gone = true;
		}
		// The notice of the window just closed is still to come: one more is
		// owed - while somebody listens. With no subscription it is never
		// heard, and a mark left behind would swallow a later window's notice.
		// No window (`had` is false) adds nothing and takes nothing away: a
		// notice still owed for a close made before this one stays owed.
		if (!failure && had && subscription !== null) owed.set(id, (owed.get(id) ?? 0) + 1);
		if (failure) return failure;
		// Popped out again (or focused) while the plugin was asked: the panel is
		// out in a window that this answer knows nothing of.
		if (generationOf(id) !== asked) {
			return { error: new Error(`panel "${id}" was popped out again meanwhile`) };
		}
		const wasPopped = popped.delete(id);
		if (keep !== undefined && (wasPopped || gone)) {
			// The dock has the panel again, but the layout that says so is not
			// known to be saved (the saved one lacks it since the pop-out): the
			// id stays stored until `saved` answers, like after a put-back.
			const call = { epoch: popOutEpochOf(id) };
			unsaved.set(id, call);
			persist();
			if (wasPopped) notify();
			awaitSaved(id, call, keep);
		} else if (wasPopped) {
			persist();
			notify();
		}
		return null;
	};
	const closeShared = (id: string): Promise<CloseFailure> => {
		const running = closes.get(id);
		if (running) return running;
		const started = closeOne(id).finally(() => {
			if (closes.get(id) === started) closes.delete(id);
		});
		closes.set(id, started);
		return started;
	};

	/**
	 * Restores the remembered panels whose window is not open (see the
	 * function's doc). `live` says the `connect()` that asked is still the
	 * current one.
	 */
	const reconcile = async (live: () => boolean): Promise<void> => {
		// Taken before asking: a pop-out that starts while the answer is on its
		// way is not in the answer either.
		const candidates = [...popped].filter((id) => !opening.has(id));
		if (candidates.length === 0) return;
		const asked = new Map(candidates.map((id) => [id, generationOf(id)]));
		let open: string[];
		try {
			open = await listPanelWindows(options);
		} catch (error) {
			if (live()) options.onListError?.(error);
			return;
		}
		// Stopped meanwhile: the screen is going away. The next `connect()` asks again.
		if (!live()) return;
		for (const id of candidates) {
			// A window started opening after the question: the answer is stale for it.
			if (generationOf(id) !== asked.get(id)) continue;
			// Still remembered (its closed notice may have come first), and no window.
			if (popped.has(id) && !open.includes(id)) putBack(id);
		}
	};

	/** After a failed open: puts the panel back when the plugin lists no window for it. */
	const confirmNoWindow = async (id: string): Promise<void> => {
		const asked = generationOf(id);
		let open: string[];
		try {
			open = await listPanelWindows(options);
		} catch (error) {
			options.onListError?.(error);
			return;
		}
		if (generationOf(id) !== asked) return;
		if (popped.has(id) && !open.includes(id)) putBack(id);
	};

	const popOut = async (content: C): Promise<void> => {
		const awaited = subscription;
		// The subscription this pop-out relied on is gone (stopped, or replaced
		// by a reconnect): its notices no longer reach `restore`.
		const stale = () => awaited !== null && subscription !== awaited;
		if (awaited) {
			const result = await awaited;
			if (!result.ok) {
				// No notice would ever bring the panel back: leave it in the dock.
				options.onError?.(result.error, content);
				return;
			}
			// Stopped while it waited (the registration is torn down as soon as
			// it lands): nothing would bring the panel back. Quietly drop it.
			if (stale()) return;
		}
		const { id } = content;
		opening.add(id);
		startOpening(id);
		try {
			if (options.detach) {
				if (!(await options.detach(content))) return;
				// Out of the dock from here on: remembered before the window is
				// asked for, so a main window that dies in between still knows.
				remember(id);
				if (stale()) {
					// Stopped while the detach ran: the panel is out of the dock but
					// no window will open, so put it back.
					putBack(id);
					return;
				}
			} else {
				remember(id);
			}
			try {
				await openPanelWindow(content, options);
			} catch (error) {
				// The panel has left the dock but has no window: put it back rather
				// than leave it nowhere.
				putBack(id);
				options.onError?.(error, content);
			}
		} finally {
			opening.delete(id);
		}
	};

	return {
		onPopOut: options.isTauri() ? (content) => void popOut(content) : undefined,
		connect: () => {
			const { stop, ready } = subscribePanelClosed(onClosed, options);
			subscription = ready;
			// After the registration, so a window that closes from now on is
			// heard: one that closed before is simply not in the plugin's answer.
			// Also when the registration failed - the panels without a window
			// can still be put back.
			void ready.then(() => reconcile(() => subscription === ready));
			return () => {
				if (subscription === ready) {
					subscription = null;
					// Nobody hears the notices these marks wait for any more (#1021).
					owed.clear();
				}
				stop();
			};
		},
		isPoppedOut: (id) => popped.has(id),
		subscribe: (cb) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		focus: async (content) => {
			const { id } = content;
			if (!options.isTauri() || !popped.has(id)) return;
			// Like a pop-out: a reconciliation must not take the window that is
			// being opened for one that is missing.
			const owns = !opening.has(id);
			opening.add(id);
			startOpening(id);
			try {
				await openPanelWindow(content, options);
			} catch (error) {
				// No window came of it: do not leave the panel nowhere. Ask again
				// (it may have been opened by someone else) and put it back if not.
				await confirmNoWindow(id);
				throw error;
			} finally {
				if (owns) opening.delete(id);
			}
		},
		closeWindows: async (ids, closeOptions) => {
			const result: PanelWindowsClosed = { closed: [], failed: [] };
			if (!options.isTauri()) return result;
			const targets = [...new Set(ids ?? popped)];
			// Before the closes start (or are joined): a close already in flight
			// for an id takes this answer too. A call without `saved` does not
			// take away the one an earlier call gave - keeping is the safe side.
			const saved = closeOptions?.saved;
			if (saved !== undefined) for (const id of targets) keeps.set(id, saved);
			const answers = await Promise.all(targets.map((id) => closeShared(id)));
			targets.forEach((id, i) => {
				const failure = answers[i];
				if (failure) result.failed.push({ id, error: failure.error });
				else result.closed.push(id);
			});
			return result;
		}
	};
}
