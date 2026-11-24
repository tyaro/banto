<script lang="ts">
	/**
	 * Single-level dropdown menu built on the native Popover API
	 * (visual-refresh-design.md §7). No headless UI dependency, same
	 * self-built approach as CommandPalette/charts/dock.
	 *
	 * - Display: `popover="auto"` (top-layer, light dismiss on outside
	 *   click / Escape handled natively) + `role="menu"` (§7.3).
	 * - Position: computed on open from `trigger.getBoundingClientRect()`,
	 *   `position: fixed`, default bottom-end, flips above when there's no
	 *   room below, clamped horizontally, recomputed on resize, and closed
	 *   (not re-tracked) on any ancestor scroll (§7.4). When the menu fits
	 *   on neither side, its height is capped to the larger side and it
	 *   scrolls internally; that scroll (wheel, or the browser bringing a
	 *   focused item into view) does not count as an ancestor scroll (#427).
	 *   The placement and the resize / scroll watch live in
	 *   `anchoredPopover.ts`, shared with DateInput.
	 * - Context menu (#889): without a `trigger`, `openAt({ x, y })` opens the
	 *   same popover at a viewport point (a right-click in a tree / grid).
	 *   Everything else is this one component: the point is placed as a
	 *   zero-size anchor (so the flip / clamp / height cap are the same), and
	 *   focus returns to the element that had it when the menu opened.
	 * - Keyboard: see the table in §7.5. Enter/Space on menu items is
	 *   native `<button>` behavior (handled in MenuItem); everything else
	 *   funnels through the handlers below.
	 *
	 * No app-specific store imports: lives in @banto/ui (ADR-0018 phase 2a),
	 * which imports nothing but `svelte`.
	 */
	import { flushSync, onMount, type Snippet } from 'svelte';
	import { computeAnchoredPosition, watchAnchoredPopover } from './anchoredPopover';
	import { setMenuContext } from './menuContext';
	import { afterPointerRelease, trackPointerGesture } from './pointerGesture';

	interface MenuTriggerProps {
		'aria-haspopup': 'menu';
		'aria-expanded': boolean;
		onclick: (event: MouseEvent) => void;
		onkeydown: (event: KeyboardEvent) => void;
	}

	interface Props {
		/** aria-label for the popover (role="menu"). */
		label: string;
		placement?: 'bottom-start' | 'bottom-end';
		/** Omit for a context menu opened with `openAt()` only (#889). */
		trigger?: Snippet<[MenuTriggerProps]>;
		children: Snippet;
	}

	interface MenuOpenAtOptions {
		/**
		 * Where focus goes when the menu closes with focus still in it (Escape,
		 * an item picked). Default: the element focused when `openAt()` was
		 * called (BantoGrid / BantoTree focus the clicked cell / row before
		 * their callback). `null`: nowhere.
		 */
		returnFocus?: HTMLElement | null;
	}

	let { label, placement = 'bottom-end', trigger, children }: Props = $props();

	let open = $state(false);
	let popoverEl: HTMLDivElement | undefined = $state();
	let coords = $state<{ top: number; left: number } | undefined>(undefined);

	// The trigger's DOM node isn't owned by this component - it's rendered
	// by the caller inside the `trigger` snippet. Captured lazily from the
	// event that opens the menu (`event.currentTarget`) instead of asking
	// the caller for an extra ref prop.
	let triggerEl: HTMLElement | undefined;

	// Set while the menu is open (or opening) at a point (`openAt`); the
	// trigger handlers clear it. `pointReturnEl` is that open's focus target.
	let anchorPoint: { x: number; y: number } | undefined;
	let pointReturnEl: HTMLElement | undefined;
	let openAtRequest = 0;

	onMount(trackPointerGesture);

	// Items registered by MenuItem (menuContext.ts), in mount order
	// (`enabledItems()` re-sorts them into DOM order).
	let items: HTMLElement[] = [];

	function registerItem(element: HTMLElement): () => void {
		items.push(element);
		return () => {
			items = items.filter((el) => el !== element);
		};
	}

	function enabledItems(): HTMLElement[] {
		// Sorted into current DOM order: a keyed {#each} that reorders its
		// items (e.g. the column menu after a column drag) moves the nodes
		// without re-mounting them, so mount order goes stale.
		return items
			.filter((el) => el.getAttribute('aria-disabled') !== 'true')
			.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
	}

	function focusItem(index: number): void {
		const list = enabledItems();
		if (list.length === 0) return;
		const wrapped = ((index % list.length) + list.length) % list.length;
		list[wrapped]?.focus();
	}

	function computePosition(): void {
		if (!popoverEl) return;
		if (anchorPoint) {
			const { x, y } = anchorPoint;
			const rect = { top: y, bottom: y, left: x, right: x, width: 0 };
			coords = computeAnchoredPosition(
				{ getBoundingClientRect: () => rect },
				popoverEl,
				'bottom-start'
			);
		} else if (triggerEl) {
			coords = computeAnchoredPosition(triggerEl, popoverEl, placement);
		}
	}

	// Not the `open` state: that follows the queued `toggle` event, so right
	// after a light dismiss (a right-click elsewhere while open) it still
	// says open. The catch is for engines without the pseudo-class.
	function isShowing(): boolean {
		try {
			return popoverEl?.matches(':popover-open') ?? false;
		} catch {
			return open;
		}
	}

	/**
	 * Opens the menu at a viewport point (`clientX` / `clientY`), as a context
	 * menu (#889): below-right of the point, flipped / clamped / height-capped
	 * like a trigger menu, first item focused. Called while a mouse button is
	 * still held (`contextmenu` fires on the press on macOS / Linux) it opens
	 * when the button is released. Called again while open, it moves there.
	 */
	export function openAt(point: { x: number; y: number }, options: MenuOpenAtOptions = {}): void {
		const active = document.activeElement;
		let returnTo: HTMLElement | undefined;
		if (options.returnFocus !== undefined) {
			returnTo = options.returnFocus ?? undefined;
		} else if (
			active instanceof HTMLElement &&
			active !== document.body &&
			!popoverEl?.contains(active)
		) {
			returnTo = active;
		} else {
			// Re-opened with focus still on one of its own items: keep the
			// target of the open before.
			returnTo = anchorPoint ? pointReturnEl : undefined;
		}
		const request = ++openAtRequest;
		afterPointerRelease(() => {
			if (request !== openAtRequest || !popoverEl) return;
			anchorPoint = { x: point.x, y: point.y };
			pointReturnEl = returnTo;
			if (!isShowing()) {
				focusIntent = 'first';
				try {
					popoverEl.showPopover();
					return;
				} catch {
					// Already open after all (an engine that cannot match
					// `:popover-open`): move it instead.
					focusIntent = 'none';
				}
			}
			computePosition();
			flushSync();
			focusItem(0);
		});
	}

	/**
	 * Re-places an open menu under its trigger. For a host that moves the
	 * trigger without a window resize (HeaderNav re-laying out its row).
	 * No-op while closed.
	 */
	export function reposition(): void {
		if (open) computePosition();
	}

	let focusIntent: 'first' | 'last' | 'none' = 'none';

	function openMenu(intent: 'first' | 'last' | 'none'): void {
		if (open) return; // showPopover() throws on an already-open popover
		focusIntent = intent;
		popoverEl?.showPopover();
	}

	function closeMenu(): void {
		popoverEl?.hidePopover();
	}

	/**
	 * Where focus goes back to on close: the trigger, or for a menu opened at a
	 * point the element that had focus then - if that row / cell still exists
	 * (deleted, virtualised away), without scrolling to it.
	 */
	function returnFocus(): void {
		if (!anchorPoint) triggerEl?.focus();
		else if (pointReturnEl?.isConnected) pointReturnEl.focus({ preventScroll: true });
	}

	// An item picked: focus goes back before the menu hides, not when the
	// queued `toggle` fires - a Modal / ConfirmDialog the item opens (rendered
	// before that event) then records the trigger / row as its opener instead
	// of the hidden item, and gets focus back there on close (#889).
	function closeFromItem(): void {
		const active = document.activeElement;
		if (active && popoverEl?.contains(active)) returnFocus();
		closeMenu();
	}

	setMenuContext({
		close: closeFromItem,
		registerItem
	});

	function handleToggle(event: ToggleEvent): void {
		open = event.newState === 'open';
		if (open) {
			// The popover is laid out by the time `toggle` fires, so
			// dimensions are accurate here (unlike right after showPopover()).
			computePosition();
			// Apply `coords` (and with it `visibility: visible`) now: a
			// still-hidden item cannot take focus, which left keyboard opens
			// (and Home/End/arrows after them) on the trigger.
			flushSync();
			if (focusIntent === 'first') focusItem(0);
			else if (focusIntent === 'last') focusItem(-1);
			focusIntent = 'none';
		} else {
			coords = undefined;
			popoverEl?.style.removeProperty('max-height');
			// Return focus to the trigger only when it would otherwise be
			// dropped (Escape / item selection leave it on a menu item; the
			// browser then moves it to <body> once the popover hides). An
			// outside click or Tab has already focused something else by the
			// time this queued event fires - stealing it back would fight
			// the user's own focus move.
			const active = document.activeElement;
			if (active === null || active === document.body || popoverEl?.contains(active)) {
				returnFocus();
			}
			anchorPoint = undefined;
			pointReturnEl = undefined;
		}
	}

	function handleTriggerClick(event: MouseEvent): void {
		triggerEl = event.currentTarget as HTMLElement;
		if (open) {
			closeMenu();
			return;
		}
		anchorPoint = undefined;
		openMenu('first');
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		triggerEl = event.currentTarget as HTMLElement;
		switch (event.key) {
			case 'Enter':
			case ' ':
			case 'ArrowDown':
				event.preventDefault();
				if (!open) anchorPoint = undefined;
				openMenu('first');
				break;
			case 'ArrowUp':
				event.preventDefault();
				if (!open) anchorPoint = undefined;
				openMenu('last');
				break;
		}
	}

	function handlePopoverKeydown(event: KeyboardEvent): void {
		const list = enabledItems();
		const currentIndex = list.indexOf(document.activeElement as HTMLElement);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusItem(currentIndex + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				// -1 (focus not on an item) means "start from the end", not
				// "one before the first".
				focusItem(currentIndex === -1 ? -1 : currentIndex - 1);
				break;
			case 'Home':
				event.preventDefault();
				focusItem(0);
				break;
			case 'End':
				event.preventDefault();
				focusItem(-1);
				break;
			case 'Tab':
				// Let the browser continue its normal tab traversal; just
				// drop out of the menu instead of trapping focus in it.
				closeMenu();
				break;
		}
	}

	$effect(() => {
		if (!open) return;
		// Resize re-places; an ancestor scroll closes, the menu's own scroll
		// (long menus, #427) does not (anchoredPopover.ts, §7.4).
		return watchAnchoredPopover(popoverEl, { reposition: computePosition, close: closeMenu });
	});
</script>

{@render trigger?.({
	'aria-haspopup': 'menu',
	'aria-expanded': open,
	onclick: handleTriggerClick,
	onkeydown: handleTriggerKeydown
})}

<div
	bind:this={popoverEl}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label={label}
	class="menu-popover"
	style:top={coords ? `${coords.top}px` : undefined}
	style:left={coords ? `${coords.left}px` : undefined}
	style:visibility={coords ? 'visible' : 'hidden'}
	ontoggle={handleToggle}
	onkeydown={handlePopoverKeydown}
>
	{@render children()}
</div>

<style>
	.menu-popover {
		position: fixed;
		inset: auto;
		margin: 0;
		/* Never wider than the viewport minus the edge gap on both sides
		   (ANCHORED_POPOVER_GAP = --banto-space-1; #668). */
		min-width: min(180px, calc(100vw - 2 * var(--banto-space-1)));
		max-width: min(320px, calc(100vw - 2 * var(--banto-space-1)));
		padding: var(--banto-space-1);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		box-shadow: var(--banto-shadow-lg);
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		display: flex;
		flex-direction: column;
		gap: 1px;
		/* Long menus (#427): computePosition() caps max-height so the whole
		   box (padding + border included) fits beside the trigger; the rest
		   scrolls here without chaining to the page behind. */
		overflow-y: auto;
		overscroll-behavior: contain;
		opacity: 0;
		transform: translateY(-4px);
		transition:
			display var(--banto-duration-fast) allow-discrete,
			overlay var(--banto-duration-fast) allow-discrete,
			opacity var(--banto-duration-fast) var(--banto-ease-out),
			transform var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Keep items at their size when the column is capped - an empty
	   separator would otherwise shrink to nothing instead of scrolling. */
	.menu-popover > :global(*) {
		flex-shrink: 0;
	}

	.menu-popover:popover-open {
		opacity: 1;
		transform: translateY(0);
	}

	@starting-style {
		.menu-popover:popover-open {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
</style>
