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
 */
import { getContext, setContext } from 'svelte';
import type { HeaderNavMenuItem } from '@banto/ui';

/** A View menu item: an action, a checkbox (stays open) or a separator (`@banto/ui` HeaderNav's menu items). */
export type PageViewMenuItem = HeaderNavMenuItem;

/** What a page hands to the shell: the menu's label and its items (read reactively). */
export interface PageViewMenuDef {
	label: string;
	items: PageViewMenuItem[];
}

export class PageViewMenuHost {
	#source = $state.raw<(() => PageViewMenuDef) | null>(null);
	readonly #inShell: () => boolean;

	constructor(inShell: () => boolean) {
		this.#inShell = inShell;
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
}

const KEY = Symbol('banto.pageViewMenu');

/** For `(app)/+layout.svelte`: creates the host and puts it in context. */
export function providePageViewMenuHost(inShell: () => boolean): PageViewMenuHost {
	return setContext(KEY, new PageViewMenuHost(inShell));
}

/** The host from the shell, or `undefined` outside the `(app)` layout (the page then shows its own button). */
export function usePageViewMenuHost(): PageViewMenuHost | undefined {
	return getContext<PageViewMenuHost | undefined>(KEY);
}
