/**
 * Svelte context bridging `Menu` and its descendant `MenuItem`s
 * (visual-refresh-design.md §7.1). `Menu` provides `close()` (used by
 * `MenuItem` on selection) and `registerItem()` (used by `MenuItem` on
 * mount to join the roving-focus traversal list, in DOM/mount order).
 *
 * No app-specific store imports - kept promotable to a shared package per
 * plan Phase 1 ("メニュー一式...アプリ固有の import を混ぜずに書く").
 */
import { getContext, setContext } from 'svelte';

const MENU_CONTEXT_KEY = Symbol('banto-menu');

export interface MenuContext {
	/** Closes the menu and returns focus to the trigger element. */
	close: () => void;
	/** Called by MenuItem on mount; returns an unregister function for its cleanup. */
	registerItem: (element: HTMLElement) => () => void;
}

export function setMenuContext(context: MenuContext): void {
	setContext(MENU_CONTEXT_KEY, context);
}

export function getMenuContext(): MenuContext {
	const context = getContext<MenuContext | undefined>(MENU_CONTEXT_KEY);
	if (!context) {
		throw new Error('Menu item components must be rendered inside <Menu>.');
	}
	return context;
}
