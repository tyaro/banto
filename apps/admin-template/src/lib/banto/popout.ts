/**
 * Pop-out panel windows (spec §5.3 v2 "ウィンドウ分離", Tauri only): this
 * app's binding of `@banto/admin-core`'s `createPanelPopOut` (ADR-0037).
 *
 * The behaviour is not here any more. The frontend half - open the window,
 * hear that it closed, put the panel back - is `@banto/admin-core`'s
 * `panelWindow.ts`; the Tauri half - one window per id, the
 * `banto://panel-closed` notice, the position / size memory, closing with
 * the main window - is the plugin `banto-tauri-panel`, registered in
 * `src-tauri/src/lib.rs` and allowed in `src-tauri/capabilities/default.json`
 * (`banto-tauri-panel:allow-open`, `banto-tauri-panel:allow-list`,
 * `banto-tauri-panel:allow-close` - the last one for `closeWindows`, which
 * the dashboard's "reset layout" calls: #1021).
 *
 * This file only hands over what admin-core does not import itself:
 * `isTauri`, `invoke` and `listen`, a `localStorage` entry for the memory of
 * the popped-out panels (#1013), and Svelte's reactivity for `isPoppedOut`
 * (#1014). It keeps the `@tauri-apps/api` imports in `lib/banto`
 * (conventions §10), out of the route.
 *
 * `notifyAppPanelReady` is the other direction: the panel window's own page
 * (`routes/panel/[id]`) tells the plugin that it has drawn, which is when
 * the plugin shows the window (#1024; `src-tauri/src/lib.rs` registers the
 * plugin with `RevealOn::Ready`).
 *
 * It also holds the joint between the two packages that must not know each
 * other (conventions §4: admin-core imports no option): `createLayoutSaveWatch`
 * turns what `@banto/dock-svelte`'s layout store answers to each `commit`
 * into the promise admin-core's `restore` returns (#1019).
 */
import { createSubscriber } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core'; // safe to import outside Tauri (see setup.ts) - only ever CALLED when isTauri()
import {
	createPanelPopOut,
	notifyPanelReady,
	type PanelPopOut,
	type PanelPopOutOptions,
	type PanelPopOutStorage,
	type PanelWindowContent
} from '@banto/admin-core';
import { isTauri } from './setup';

/**
 * The memory of the popped-out panel ids (#1013) as one `localStorage` entry:
 * a JSON array of ids, removed when it is empty. Anything else found under
 * the key reads as "nothing". A storage that throws is admin-core's to
 * survive (it treats the memory as best effort).
 */
export function panelPopOutLocalStorage(key: string): PanelPopOutStorage {
	return {
		load: () => {
			const raw = localStorage.getItem(key);
			if (raw === null) return [];
			const value: unknown = JSON.parse(raw);
			return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		},
		save: (ids) => {
			if (ids.length === 0) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(ids));
		}
	};
}

/** `createLayoutSaveWatch()`: "the layout as it is from now on has been saved". */
export interface LayoutSaveWatch {
	/**
	 * Hand over what the layout store answered to a `commit`
	 * (`@banto/dock-svelte`'s `DockLayoutSaveOutcome`, by shape: only
	 * `'saved'` counts). Call it for EVERY report, in the order they are made.
	 */
	track: (outcome: Promise<string>) => void;
	/**
	 * Resolves `true` once a report made AFTER this call is saved. It stays
	 * pending while none is (a failed write, a write dropped with its session,
	 * no report at all): a later report that is saved still answers it, since
	 * that write carries the layout as it is then.
	 */
	next: () => Promise<boolean>;
}

/**
 * Joins the dock's layout store to the pop-out's `restore` (#1019). A panel
 * put back into the dock must stay in the pop-out's memory until the layout
 * that has it again is in the provider; the store answers that per `commit`,
 * but the report of a restored panel is made by the dock host, later, not by
 * `restore` itself. So the page routes every report through `track`, and
 * `restore` takes `next()` BEFORE it changes the dock and returns it:
 *
 * ```ts
 * const saves = createLayoutSaveWatch();
 * const reportLayout = (layout, reason) => saves.track(dockLayout.commit(layout, reason));
 * // <DockHost onLayoutCommit={reportLayout} />
 * restore: (id) => {
 * 	const saved = saves.next();
 * 	dock.open(id);
 * 	return saved;
 * }
 * ```
 *
 * Why "a report made after": a write already on its way when the panel came
 * back holds the layout without it, and its success says nothing. Why ANY
 * later report: each write holds the whole layout, so the first one that
 * lands settles it - also when the user has closed the panel again by then
 * (that is then what is saved, and what the next start must show).
 */
export function createLayoutSaveWatch(): LayoutSaveWatch {
	/** Reports handed to `track` so far. */
	let reports = 0;
	let waiting: { after: number; resolve: (saved: boolean) => void }[] = [];
	return {
		track: (outcome) => {
			const report = ++reports;
			void outcome.then(
				(result) => {
					if (result !== 'saved') return;
					const answered = waiting.filter((w) => w.after < report);
					waiting = waiting.filter((w) => w.after >= report);
					for (const w of answered) w.resolve(true);
				},
				() => {}
			);
		},
		next: () => {
			const after = reports;
			return new Promise<boolean>((resolve) => waiting.push({ after, resolve }));
		}
	};
}

/**
 * `notifyPanelReady` with this app's Tauri functions filled in: the page of
 * a panel window calls it once its first content is in the DOM, and the
 * plugin (registered with `RevealOn::Ready`) shows the window then (#1024).
 * Without the call the window only appears when the plugin's timeout is over
 * (3 seconds). Never rejects: a notice that could not be sent ends the same
 * way. Nothing happens in a plain browser.
 */
export async function notifyAppPanelReady(id: string): Promise<void> {
	try {
		await notifyPanelReady(id, {
			isTauri,
			// Dynamic import, like `listen` below: the event module talks to a
			// Tauri IPC channel that does not exist in a browser tab.
			emit: async (event, payload) => (await import('@tauri-apps/api/event')).emit(event, payload)
		});
	} catch {
		// The plugin shows the window when its timeout is over.
	}
}

export interface AppPanelPopOutOptions<C extends PanelWindowContent> extends Pick<
	PanelPopOutOptions<C>,
	'detach' | 'restore' | 'onError' | 'onListError'
> {
	/**
	 * `localStorage` key the popped-out panel ids are remembered under, so a
	 * panel that was out in a window when the app was closed is back in the
	 * dock at the next start (#1013). One key per dock, per user - the same
	 * owner as the dock's saved layout, since that layout is what lacks the
	 * panel. `null` = not remembered across a restart.
	 */
	storageKey: string | null;
}

// --- The window's background colour (Issue #1015) -------------------------
//
// What the current screen's background is, as `#rrggbb`, so a pop-out window
// is built in that colour and is not white until its page is drawn. The plugin
// takes it as `open`'s `background`; `createAppPanelPopOut` hands
// `readPageBackground` to admin-core, which asks at every open, so a theme
// change is followed. `cssColorToHex` is pure (tested without a DOM).

/** Smallest alpha treated as "this layer paints the background itself". */
const OPAQUE = 1;

const hex2 = (n: number) =>
	Math.min(255, Math.max(0, Math.round(n)))
		.toString(16)
		.padStart(2, '0');

/** A number or a percentage of `scale` (`rgb(50% ...)`, `alpha 50%`). */
function component(token: string, scale: number): number | undefined {
	if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(token)) return undefined;
	const value = Number.parseFloat(token);
	return token.endsWith('%') ? (value / 100) * scale : value;
}

/**
 * Reads the CSS colour `value` (what `getComputedStyle(...).backgroundColor`
 * gives) as `#rrggbb`, or `undefined` when it is not an opaque colour this
 * can read: `rgb()` / `rgba()` (comma or space separated, `/ alpha`) and
 * `color(srgb r g b)`. Anything else - `transparent`, an alpha below 1, a
 * keyword, `oklch()`, ... - is `undefined`. (Browsers keep an `oklch()`
 * colour as written when computing it, so the theme's own colours come back
 * as that; `readPageBackground` has a fallback for them.)
 */
export function cssColorToHex(value: string): string | undefined {
	const match = /^\s*(rgba?|color)\(\s*([^)]*?)\s*\)\s*$/i.exec(value);
	if (!match) return undefined;
	const isColorFn = match[1].toLowerCase() === 'color';
	// "r g b / a" and "r, g, b, a" differ only in their separators.
	const tokens = match[2].split(/[\s,/]+/).filter((t) => t !== '');
	if (isColorFn && tokens.shift()?.toLowerCase() !== 'srgb') return undefined;
	if (tokens.length !== 3 && tokens.length !== 4) return undefined;
	if (tokens.length === 4) {
		const alpha = component(tokens[3], 1);
		if (alpha === undefined || alpha < OPAQUE) return undefined;
	}
	const channels = tokens.slice(0, 3).map((t) => component(t, isColorFn ? 1 : 255));
	if (channels.some((c) => c === undefined)) return undefined;
	const [r, g, b] = channels.map((c) => (isColorFn ? c! * 255 : c!));
	return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * What the DOM side needs: injected so the walk is testable without a
 * browser's computed styles (the default reads the real `document`).
 */
export interface BackgroundEnvironment {
	/** Elements to look at, innermost first (default: `body`, `documentElement`). */
	elements: () => Element[];
	/** `getComputedStyle(element).backgroundColor`. */
	computed: (element: Element) => string;
	/**
	 * Turns a colour `cssColorToHex` cannot read (`oklch()`, a keyword, ...)
	 * into `#rrggbb` by painting it - or `undefined` when it cannot.
	 */
	rasterize?: (color: string) => string | undefined;
}

/** Paints `color` on a 1x1 canvas and reads the pixel back (any CSS colour the browser knows). */
function rasterizeWithCanvas(color: string): string | undefined {
	try {
		const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
		if (!context) return undefined;
		// An unparsable colour leaves `fillStyle` at its old value; a sentinel
		// tells that apart from "painted black".
		context.fillStyle = '#010203';
		context.fillStyle = color;
		context.clearRect(0, 0, 1, 1);
		context.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
		if (a !== 255) return undefined;
		return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
	} catch {
		return undefined;
	}
}

const domEnvironment: BackgroundEnvironment = {
	elements: () => [document.body, document.documentElement].filter((e) => e != null),
	computed: (element) => getComputedStyle(element).backgroundColor,
	rasterize: rasterizeWithCanvas
};

/**
 * The background of the current screen as `#rrggbb`: the first of `body`,
 * then `html` (the theme paints `html`) whose background is not transparent.
 * `undefined` when there is none or it cannot be read - the plugin's own
 * default applies then. Never throws (a colour is a nicety).
 */
export function readPageBackground(
	environment: BackgroundEnvironment = domEnvironment
): string | undefined {
	try {
		for (const element of environment.elements()) {
			const value = environment.computed(element).trim();
			if (value === '' || value === 'transparent' || /^rgba\(.*[\s,/]0\)$/i.test(value)) continue;
			const direct = cssColorToHex(value);
			if (direct) return direct;
			// Readable but not a plain colour (oklch, a keyword): let the
			// browser convert it.
			const painted = environment.rasterize?.(value);
			if (painted) return painted;
		}
	} catch {
		// fall through
	}
	return undefined;
}

/**
 * `createPanelPopOut` with this app's Tauri functions filled in. In a plain
 * browser the result's `onPopOut` is `undefined` (the dock then draws no
 * pop-out button), `connect()` registers nothing and `isPoppedOut` is always
 * `false`.
 *
 * `isPoppedOut` is reactive here: read in a `$derived` / `$effect` / the
 * template, it re-runs them when a panel is popped out or put back.
 */
export function createAppPanelPopOut<C extends PanelWindowContent>(
	options: AppPanelPopOutOptions<C>
): PanelPopOut<C> {
	const { storageKey, ...rest } = options;
	const popOut = createPanelPopOut<C>({
		isTauri,
		invoke,
		// Dynamic import: `listen` talks to a Tauri IPC channel that does not
		// exist in a browser tab (same reasoning as setup.ts's event provider).
		listen: async (event, cb) => (await import('@tauri-apps/api/event')).listen(event, cb),
		background: readPageBackground,
		storage: storageKey === null ? undefined : panelPopOutLocalStorage(storageKey),
		...rest
	});
	// admin-core tells "the popped-out set changed" through a plain
	// subscription; this turns it into a dependency of whoever reads.
	const track = createSubscriber((update) => popOut.subscribe(update));
	return {
		...popOut,
		isPoppedOut: (id) => {
			track();
			return popOut.isPoppedOut(id);
		}
	};
}
