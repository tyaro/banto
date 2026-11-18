/**
 * Closing open ui `Menu`s (`role="menu"` popovers) - the one place that knows
 * how. A menu is a top-layer popover, so it stays above any z-index'd modal
 * layer, usable, and `layering.ts` calls it "above" the modal while the modal
 * calls it "above" in turn (#670). Whoever opens a modal layer closes the
 * menus first (OverlayPanel does so for Modal / Drawer / ConfirmDialog; the
 * admin-template's settle prompt and HeaderNav use it directly).
 */

const OPEN_MENU_SELECTOR = '[role="menu"][popover]';

/**
 * Hides every open menu under `root` (default: the document) and returns the
 * ones it hid. Menus inside `except` (a modal's own panel) are left alone.
 * A no-op without a DOM (unit tests in node, SSR). `hidePopover` on a closed
 * popover is a no-op (no `:popover-open` pre-check: stand-ins in jsdom do not
 * match it); the guard is for browsers that still throw on it.
 */
export function closeOpenMenus(
	root: ParentNode | undefined = globalThis.document,
	except?: Element | null
): HTMLElement[] {
	const closed: HTMLElement[] = [];
	for (const menu of root?.querySelectorAll<HTMLElement>(OPEN_MENU_SELECTOR) ?? []) {
		if (except?.contains(menu)) continue;
		try {
			menu.hidePopover();
			closed.push(menu);
		} catch {
			// already closed
		}
	}
	return closed;
}
