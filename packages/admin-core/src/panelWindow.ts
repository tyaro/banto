/**
 * Pop-out panel windows (spec §5.3 v2, ADR-0037): the frontend half of the
 * Tauri plugin `banto-tauri-panel` (`crates/banto-tauri-panel`). A dock
 * panel becomes a real OS window (`openPanelWindow`), and when that window
 * is gone the plugin tells the main window (`banto://panel-closed`,
 * `listenPanelClosed`) so the panel can go back into the dock.
 * `createPanelPopOut` puts the two together in the shape a dock takes
 * (`onPopOut` + a subscription).
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
		if (options.detach) {
			if (!(await options.detach(content))) return;
			if (stale()) {
				// Stopped while the detach ran: the panel is out of the dock but no
				// window will open, so put it back.
				options.restore(content.id);
				return;
			}
		}
		try {
			await openPanelWindow(content, options);
		} catch (error) {
			// The panel has left the dock but has no window: put it back rather
			// than leave it nowhere.
			options.restore(content.id);
			options.onError?.(error, content);
		}
	};

	return {
		onPopOut: options.isTauri() ? (content) => void popOut(content) : undefined,
		connect: () => {
			const { stop, ready } = subscribePanelClosed(options.restore, options);
			subscription = ready;
			return () => {
				if (subscription === ready) subscription = null;
				stop();
			};
		}
	};
}
