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
	if (!options.isTauri()) return () => {};

	let disposed = false;
	let unlisten: (() => void) | null = null;

	void options
		.listen(PANEL_CLOSED_EVENT, (e) => {
			if (!disposed && typeof e.payload === 'string') cb(e.payload);
		})
		.then(
			(fn) => {
				if (disposed) fn();
				else unlisten = fn;
			},
			// The subscription could not be made (no event permission, the
			// import failed): the panel then stays out of the dock until the user
			// reopens it from the app's own menu. Nothing to tear down.
			() => {}
		);

	return () => {
		disposed = true;
		unlisten?.();
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
	/** The window could not be opened (after `restore` has run). */
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
	const popOut = async (content: C): Promise<void> => {
		if (options.detach && !(await options.detach(content))) return;
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
		connect: () => listenPanelClosed(options.restore, options)
	};
}
