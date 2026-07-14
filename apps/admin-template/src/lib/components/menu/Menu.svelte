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
	 *   (not re-tracked) on any ancestor scroll (§7.4).
	 * - Keyboard: see the table in §7.5. Enter/Space on menu items is
	 *   native `<button>` behavior (handled in MenuItem); everything else
	 *   funnels through the handlers below.
	 *
	 * No app-specific store imports - kept promotable to a shared package
	 * per plan Phase 1.
	 */
	import type { Snippet } from 'svelte';
	import { setMenuContext } from './menuContext';

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
		trigger: Snippet<[MenuTriggerProps]>;
		children: Snippet;
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

	// Items registered by MenuItem (menuContext.ts), in mount order.
	let items: HTMLElement[] = [];

	function registerItem(element: HTMLElement): () => void {
		items.push(element);
		return () => {
			items = items.filter((el) => el !== element);
		};
	}

	function enabledItems(): HTMLElement[] {
		return items.filter((el) => el.getAttribute('aria-disabled') !== 'true');
	}

	function focusItem(index: number): void {
		const list = enabledItems();
		if (list.length === 0) return;
		const wrapped = ((index % list.length) + list.length) % list.length;
		list[wrapped]?.focus();
	}

	function computePosition(): void {
		if (!triggerEl || !popoverEl) return;
		const triggerRect = triggerEl.getBoundingClientRect();
		const menuRect = popoverEl.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth;
		const viewportHeight = document.documentElement.clientHeight;

		let top = triggerRect.bottom + 4;
		const fitsBelow = top + menuRect.height <= viewportHeight;
		if (!fitsBelow) {
			const flippedTop = triggerRect.top - menuRect.height - 4;
			if (flippedTop >= 0) top = flippedTop;
		}

		let left = placement === 'bottom-start' ? triggerRect.left : triggerRect.right - menuRect.width;
		left = Math.min(Math.max(left, 4), viewportWidth - menuRect.width - 4);

		coords = { top, left };
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

	setMenuContext({
		close: closeMenu,
		registerItem
	});

	function handleToggle(event: ToggleEvent): void {
		open = event.newState === 'open';
		if (open) {
			// The popover is laid out by the time `toggle` fires, so
			// dimensions are accurate here (unlike right after showPopover()).
			computePosition();
			if (focusIntent === 'first') focusItem(0);
			else if (focusIntent === 'last') focusItem(-1);
			focusIntent = 'none';
		} else {
			coords = undefined;
			// Return focus to the trigger only when it would otherwise be
			// dropped (Escape / item selection leave it on a menu item; the
			// browser then moves it to <body> once the popover hides). An
			// outside click or Tab has already focused something else by the
			// time this queued event fires - stealing it back would fight
			// the user's own focus move.
			const active = document.activeElement;
			if (active === null || active === document.body || popoverEl?.contains(active)) {
				triggerEl?.focus();
			}
		}
	}

	function handleTriggerClick(event: MouseEvent): void {
		triggerEl = event.currentTarget as HTMLElement;
		if (open) closeMenu();
		else openMenu('first');
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		triggerEl = event.currentTarget as HTMLElement;
		switch (event.key) {
			case 'Enter':
			case ' ':
			case 'ArrowDown':
				event.preventDefault();
				openMenu('first');
				break;
			case 'ArrowUp':
				event.preventDefault();
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
		function handleResize(): void {
			computePosition();
		}
		function handleScroll(): void {
			// Menus are short-lived; re-tracking the trigger on scroll isn't
			// worth the complexity, so close instead (§7.4).
			closeMenu();
		}
		window.addEventListener('resize', handleResize);
		window.addEventListener('scroll', handleScroll, true);
		return () => {
			window.removeEventListener('resize', handleResize);
			window.removeEventListener('scroll', handleScroll, true);
		};
	});
</script>

{@render trigger({
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
		min-width: 180px;
		max-width: 320px;
		padding: 0.35rem;
		border: 1px solid var(--banto-border);
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
		opacity: 0;
		transform: translateY(-4px);
		transition:
			display var(--banto-duration-fast) allow-discrete,
			overlay var(--banto-duration-fast) allow-discrete,
			opacity var(--banto-duration-fast) var(--banto-ease-out),
			transform var(--banto-duration-fast) var(--banto-ease-out);
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
