/**
 * A page's "View" menu in the app shell (#663 ①-C). A page that has view
 * commands (the dashboard's pane toggles) hands them to the shell once; the
 * shell decides where the menu lives so that it exists in exactly ONE place
 * at a time (the same rule as narrowViewport.svelte.ts's toggle control):
 *
 * - while the menu bar is on screen (`navLayout === 'menubar'`, >900px, not
 *   insufficient - nav-menubar-plan.md §4.9) it is a `kind: 'menu'` entry of
 *   the bar (ShellMenubar.svelte);
 * - otherwise (sidebar / launcher layout, <=900px, or the drawer standing in
 *   for an insufficient bar) the page renders it as a menu button in its own
 *   header (PageViewMenu.svelte, in PageHeader's `actions`).
 *
 * The host is a context set by `(app)/+layout.svelte`, which owns the shell
 * state that decides `inShell`. Only one page is mounted at a time, so the
 * host keeps one source; a source registered later replaces an earlier one,
 * and a cleanup only removes its own source.
 *
 * Focus follows the menu (logical focus = DOM focus): when the menu moves
 * while focus is on its trigger or inside its open menu, the control that
 * leaves is unmounted (its open menu with it), and focus goes to the trigger
 * of the control that replaces it - never opened. When focus is anywhere
 * else at the moment of the switch, focus is not touched. Each place
 * registers its control with `attach` (`pageViewMenuControl`), and the
 * provider runs `followFocus` before the DOM changes. Header.svelte leaves
 * focus in the page menu to this (`owns`) instead of sending it to the drawer
 * button with the nav.
 */
import { getContext, setContext, tick } from 'svelte';
import type { HeaderNavMenuItem } from '@banto/ui';

/** A View menu item: an action, a checkbox (stays open) or a separator (`@banto/ui` HeaderNav's menu items). */
export type PageViewMenuItem = HeaderNavMenuItem;

/** What a page hands to the shell: the menu's label and its items (read reactively). */
export interface PageViewMenuDef {
	label: string;
	items: PageViewMenuItem[];
}

/** Where the menu is rendered: the menu bar's entry or the page header's button. */
export type PageViewMenuPlace = 'shell' | 'page';

/** One rendering of the menu, as the host sees it for moving focus. */
export interface PageViewMenuControl {
	/** Whether `node` is the trigger or inside the control's (open) menu. */
	contains(node: Node | null): boolean;
	/** Focuses the trigger; `true` when focus landed on it (a hidden or inert one refuses). */
	focusTrigger(): boolean;
}

/** Test seams for the DOM: the focused element and the scheduler of the hand-over attempts. */
export interface PageViewMenuHostOptions {
	activeElement?: () => Element | null;
	/** Runs `run` later: attempt 0 after the DOM update, then once per frame. */
	defer?: (run: () => void, attempt: number) => void;
}

/** A freshly mounted menu bar stays hidden until measured: retry for this many attempts. */
const HAND_OVER_ATTEMPTS = 10;

const defaultActiveElement = (): Element | null =>
	typeof document === 'undefined' ? null : document.activeElement;

const defaultDefer = (run: () => void, attempt: number): void => {
	if (attempt === 0) void tick().then(run);
	else requestAnimationFrame(run);
};

export class PageViewMenuHost {
	#source = $state.raw<(() => PageViewMenuDef) | null>(null);
	readonly #inShell: () => boolean;
	readonly #activeElement: () => Element | null;
	readonly #defer: (run: () => void, attempt: number) => void;
	readonly #controls: Record<PageViewMenuPlace, PageViewMenuControl | null> = {
		shell: null,
		page: null
	};
	#lastInShell: boolean | undefined;
	#switch = 0;

	constructor(inShell: () => boolean, options: PageViewMenuHostOptions = {}) {
		this.#inShell = inShell;
		this.#activeElement = options.activeElement ?? defaultActiveElement;
		this.#defer = options.defer ?? defaultDefer;
	}

	/** The registered page menu (reactive: the source getter is read here), or `null`. */
	get menu(): PageViewMenuDef | null {
		return this.#source?.() ?? null;
	}

	/**
	 * Whether the shell's menu bar carries the page menu right now. When
	 * `false` the page shows its own menu button. While the bar is
	 * insufficient it keeps the (hidden, inert) entry mounted so its width
	 * does not flip the measurement back, and this is `false`.
	 */
	get inShell(): boolean {
		return this.#inShell();
	}

	/** Registers the page's menu; returns the cleanup (call it on destroy). */
	register(source: () => PageViewMenuDef): () => void {
		this.#source = source;
		return () => {
			if (this.#source === source) this.#source = null;
		};
	}

	/** Registers the control rendered at `place`; returns the cleanup (call it on unmount). */
	attach(place: PageViewMenuPlace, control: PageViewMenuControl): () => void {
		this.#controls[place] = control;
		return () => {
			if (this.#controls[place] === control) this.#controls[place] = null;
		};
	}

	/** Whether `node` is in one of the menu's controls (Header leaves such focus to the host). */
	owns(node: Node | null): boolean {
		return (
			this.#controls.shell?.contains(node) === true || this.#controls.page?.contains(node) === true
		);
	}

	/**
	 * Call before the DOM changes whenever `inShell` may have changed (the
	 * provider's `$effect.pre`). When the menu moves while focus is on the
	 * leaving control, hands focus to the trigger of the other one once it can
	 * take it; if focus has meanwhile gone somewhere else, leaves it there.
	 */
	followFocus(): void {
		const next = this.inShell;
		const previous = this.#lastInShell;
		this.#lastInShell = next;
		if (previous === undefined || previous === next) return;
		const switchId = ++this.#switch;
		const from = this.#controls[previous ? 'shell' : 'page'];
		if (from?.contains(this.#activeElement()) !== true) return;
		const to: PageViewMenuPlace = next ? 'shell' : 'page';
		const attempt = (n: number): void => {
			// A later switch owns the focus now.
			if (switchId !== this.#switch) return;
			const active = this.#activeElement();
			const lost =
				active === null ||
				(typeof document !== 'undefined' && active === document.body) ||
				from.contains(active);
			// Focus moved on to something else meanwhile: not ours to take.
			if (!lost) return;
			if (this.#controls[to]?.focusTrigger() === true) return;
			if (n + 1 < HAND_OVER_ATTEMPTS) this.#defer(() => attempt(n + 1), n + 1);
		};
		this.#defer(() => attempt(0), 0);
	}
}

/**
 * For the two places: registers `root` (an element wrapping the trigger and
 * its menu) as the control at `place`. Use with `{@attach}`; the trigger is
 * looked up on each attempt (the bar's entry may be remounted).
 */
export function pageViewMenuControl(
	host: PageViewMenuHost,
	place: PageViewMenuPlace,
	triggerSelector: string
): (root: HTMLElement) => () => void {
	return (root) =>
		host.attach(place, {
			contains: (node) => root.contains(node),
			focusTrigger: () => {
				const trigger = root.querySelector<HTMLElement>(triggerSelector);
				if (!trigger?.isConnected || trigger.closest('[inert]')) return false;
				trigger.focus();
				return document.activeElement === trigger;
			}
		});
}

const KEY = Symbol('banto.pageViewMenu');

/** For `(app)/+layout.svelte`: creates the host and puts it in context. */
export function providePageViewMenuHost(inShell: () => boolean): PageViewMenuHost {
	const host = setContext(KEY, new PageViewMenuHost(inShell));
	$effect.pre(() => host.followFocus());
	return host;
}

/** The host from the shell, or `undefined` outside the `(app)` layout (the page then shows its own button). */
export function usePageViewMenuHost(): PageViewMenuHost | undefined {
	return getContext<PageViewMenuHost | undefined>(KEY);
}
