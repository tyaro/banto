/**
 * Pop-out panel windows (spec §5.3 v2, ADR-0037): the frontend half of the
 * Tauri plugin `banto-tauri-panel` (`crates/banto-tauri-panel`). A dock
 * panel becomes a real OS window (`openPanelWindow`), and when that window
 * is gone the plugin tells the main window (`banto://panel-closed`,
 * `listenPanelClosed`) so the panel can go back into the dock.
 * `createPanelPopOut` puts the two together in the shape a dock takes
 * (`onPopOut` + a subscription), and knows which panels are out in a window
 * right now (`isPoppedOut` / `subscribe` / `focus`, and - with a `storage` -
 * across a restart: `connect()` puts back the panels whose window is gone).
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
	/** The ids last saved (`[]` when nothing was). Read once, when the pop-out is created. */
	load: () => string[];
	/** Called with the whole list each time it changes. */
	save: (ids: string[]) => void;
}

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
	 */
	restore: (id: string) => void;
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
 * 	restore: (id) => dock.open(id)
 * });
 * $effect(() => popOut.connect());
 * // <DockHost onPopOut={popOut.onPopOut} ... />
 * ```
 */
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
	const listeners = new Set<() => void>();

	const changed = () => {
		try {
			options.storage?.save([...popped]);
		} catch {
			// Best effort: a failed write only loses the memory across a restart.
		}
		for (const cb of [...listeners]) cb();
	};
	const remember = (id: string) => {
		if (popped.has(id)) return;
		popped.add(id);
		changed();
	};
	const forget = (id: string) => {
		if (popped.delete(id)) changed();
	};
	/** The panel goes back into the dock: forgotten first, so `restore` sees it as not popped out. */
	const putBack = (id: string) => {
		forget(id);
		options.restore(id);
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
			// Still remembered (its closed notice may have come first), and no window.
			if (popped.has(id) && !open.includes(id)) putBack(id);
		}
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
			const { stop, ready } = subscribePanelClosed(putBack, options);
			subscription = ready;
			// After the registration, so a window that closes from now on is
			// heard: one that closed before is simply not in the plugin's answer.
			// Also when the registration failed - the panels without a window
			// can still be put back.
			void ready.then(() => reconcile(() => subscription === ready));
			return () => {
				if (subscription === ready) subscription = null;
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
			if (!options.isTauri() || !popped.has(content.id)) return;
			await openPanelWindow(content, options);
		}
	};
}
