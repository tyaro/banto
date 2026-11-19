<script lang="ts">
	/**
	 * The "panel actions" menu button of a pane's title bar (#663 ④, docs/design/three-pane-dock-plan.md
	 * §4.6): the keyboard (and pointer) way to re-dock a pane without a drag. A WAI-ARIA menu button,
	 * kept inside this package (`@banto/ui`'s `Menu` cannot be imported, conventions §4):
	 *  - the button opens it with Enter / Space / ArrowDown (first item) or ArrowUp (last item);
	 *  - ArrowDown / ArrowUp move (wrapping), Home / End jump, Enter / Space choose;
	 *  - "next to X" items open the side choice in place (ArrowRight / Enter), ArrowLeft / Esc come
	 *    back to the first list; Esc there closes the menu and puts the focus back on the button;
	 *  - Tab, a click outside or the focus leaving closes it.
	 * The items are the moves the drag would offer for this pane now (`PanelMover.options`); a
	 * pane with none draws no button. Choosing an item closes the menu FIRST (the focus back on the
	 * button), then asks the move, so an app's confirm dialog (`beforePanelChange`) never opens
	 * over an open menu. Rendered as a manual popover (top layer) so the pane's clipping and the
	 * floating layer's stacking do not cut it; without the Popover API it is drawn in place.
	 * Keys and pointer presses inside it stop here: the tab strip's arrows and the title bar's drag
	 * never see them.
	 */
	import { tick, untrack } from 'svelte';
	import { placeMenu } from './core/geometry';
	import { getPanelMover, type DockMoveTarget } from './core/move.svelte';
	import type { DockMessages } from './messages';
	import type { DockEdge } from './types';

	interface Props {
		panelId: string;
		title: string;
		t: Required<DockMessages>;
	}

	let { panelId, title, t }: Props = $props();

	const mover = getPanelMover();
	const menuId = $props.id();
	const SIDES: DockEdge[] = ['left', 'right', 'top', 'bottom'];
	/**
	 * The Popover API (top layer). Without it the menu is drawn in place: a `[popover]` that cannot
	 * be shown would stay hidden, and its items could not take the focus.
	 */
	const POPOVER =
		typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

	let open = $state(false);
	/** `null` = the first list; else the pane whose sides are listed. */
	let page: string | null = $state(null);
	let buttonEl: HTMLButtonElement | null = $state(null);
	let menuEl: HTMLDivElement | null = $state(null);
	let top = $state(0);
	let left = $state(0);
	/** The room on the side the menu opens to (`placeMenu`); its content scrolls inside. */
	let maxHeight: number | null = $state(null);

	type Item =
		| { key: string; label: string; target: DockMoveTarget }
		| { key: string; label: string; sub: string }
		| { key: string; label: string; up: true };

	const shown = $derived(mover?.hasOptions(panelId) ?? false);

	const items: Item[] = $derived.by(() => {
		if (!open || !mover) return [];
		const o = mover.options(panelId);
		if (page !== null) {
			const other = o.splitWith.find((p) => p.id === page);
			if (!other) return [{ key: 'up', label: t.menuBack(), up: true }];
			return [
				...SIDES.map((side) => ({
					key: `side-${side}`,
					label: t.splitSide(side),
					target: { splitWith: other.id, side }
				})),
				{ key: 'up', label: t.menuBack(), up: true as const }
			];
		}
		return [
			...o.edges.map((edge) => ({
				key: `edge-${edge}`,
				label: t.moveToEdge(edge),
				target: { edge }
			})),
			...o.tabWith.map((p) => ({
				key: `tab-${p.id}`,
				label: t.moveToTabs(p.title),
				target: { tabWith: p.id }
			})),
			...o.splitWith.map((p) => ({
				key: `split-${p.id}`,
				label: t.moveToSplit(p.title),
				sub: p.id
			})),
			...(o.float
				? [{ key: 'float', label: t.floatPanel(), target: { float: true as const } }]
				: []),
			...(o.back ? [{ key: 'back', label: t.dockBack(), target: { back: true as const } }] : [])
		];
	});

	function menuItems(): HTMLElement[] {
		return menuEl ? [...menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
	}

	function focusItem(index: number): void {
		const list = menuItems();
		if (list.length === 0) return;
		list[((index % list.length) + list.length) % list.length]?.focus();
	}

	function place(): void {
		if (!buttonEl || !menuEl) return;
		const b = buttonEl.getBoundingClientRect();
		// The full height (not clipped by the last `max-height`): content + padding + border.
		const border = menuEl.offsetHeight - menuEl.clientHeight;
		const content = { width: menuEl.offsetWidth, height: menuEl.scrollHeight + border };
		const viewport = {
			width: document.documentElement.clientWidth || window.innerWidth,
			height: document.documentElement.clientHeight || window.innerHeight
		};
		const at = placeMenu(b, content, viewport);
		top = at.top;
		left = at.left;
		// `max-height` is the content box's: the padding and the border are outside it.
		const style = getComputedStyle(menuEl);
		const frame =
			border + parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
		maxHeight = Math.max(0, at.maxHeight - (Number.isFinite(frame) ? frame : 0));
	}

	async function openMenu(focus: 'first' | 'last'): Promise<void> {
		if (!shown) return;
		page = null;
		open = true;
		await tick();
		const el = menuEl as (HTMLDivElement & { showPopover?: () => void }) | null;
		try {
			el?.showPopover?.();
		} catch {
			// Already shown, or not connected: drawn in place.
		}
		place();
		focusItem(focus === 'first' ? 0 : -1);
	}

	function closeMenu(returnFocus: boolean): void {
		if (!open) return;
		const el = menuEl as (HTMLDivElement & { hidePopover?: () => void }) | null;
		const hadFocus = !!el && el.contains(document.activeElement);
		try {
			el?.hidePopover?.();
		} catch {
			// Not shown as a popover.
		}
		open = false;
		page = null;
		if (returnFocus || hadFocus) buttonEl?.focus();
	}

	async function showPage(next: string | null, focusKey?: string): Promise<void> {
		page = next;
		await tick();
		place();
		const list = menuItems();
		const at = focusKey ? list.findIndex((el) => el.dataset.key === focusKey) : 0;
		focusItem(Math.max(0, at));
	}

	function choose(item: Item): void {
		if ('sub' in item) {
			void showPage(item.sub);
			return;
		}
		if ('up' in item) {
			const from = page;
			void showPage(null, from ? `split-${from}` : undefined);
			return;
		}
		// Closed first (the focus back on the button, the menu out of the DOM): a confirm the move
		// asks never opens over the menu.
		const target = item.target;
		closeMenu(true);
		void tick().then(() => mover?.move(panelId, target, { returnFocus: buttonEl }));
	}

	function handleButtonKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			void openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
		} else if (event.key === 'Enter' || event.key === ' ') {
			// Handled here (not by the click) so the focus lands on the first item, and the tab
			// strip around the button does not take the key.
			event.preventDefault();
			event.stopPropagation();
			if (open) closeMenu(true);
			else void openMenu('first');
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
		}
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		// Nothing in here reaches the tab strip / the window around it.
		event.stopPropagation();
		if (event.isComposing) return;
		const list = menuItems();
		const index = list.indexOf(document.activeElement as HTMLElement);
		const item = index >= 0 ? items[index] : undefined;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusItem(index + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusItem(index === -1 ? -1 : index - 1);
				break;
			case 'Home':
				event.preventDefault();
				focusItem(0);
				break;
			case 'End':
				event.preventDefault();
				focusItem(-1);
				break;
			case 'ArrowRight':
				if (item && 'sub' in item) {
					event.preventDefault();
					choose(item);
				}
				break;
			case 'ArrowLeft':
				if (page !== null) {
					event.preventDefault();
					void showPage(null, `split-${page}`);
				}
				break;
			case 'Escape':
				event.preventDefault();
				if (page !== null) void showPage(null, `split-${page}`);
				else closeMenu(true);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (item) choose(item);
				break;
			case 'Tab':
				// No focus trap: Tab leaves the menu (and closes it), like the browser's own menus.
				closeMenu(false);
				break;
		}
	}

	function handleFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget as Node | null;
		if (next && (menuEl?.contains(next) || buttonEl?.contains(next))) return;
		// The focus left for something else (or nowhere, e.g. a click on plain page): close.
		if (next) closeMenu(false);
	}

	// A press outside the button and the menu closes it (the Popover API's light dismiss is not
	// used: `manual`, so the menu also works without it).
	$effect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menuEl?.contains(target) || buttonEl?.contains(target))) return;
			closeMenu(false);
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	});

	// No move left (the window got locked, the other panes went away): the button and the menu
	// leave the DOM. A focus in them would drop to <body>: hand it first (`.pre`: they are still
	// rendered) to the tab the button sits in, else to the title bar's next button (the lock /
	// collapse button). A focus elsewhere is left alone.
	$effect.pre(() => {
		if (shown) return;
		untrack(() => {
			const active = document.activeElement;
			const inside =
				!!active &&
				((!!buttonEl && buttonEl.contains(active)) || (!!menuEl && menuEl.contains(active)));
			open = false;
			page = null;
			if (!inside || !buttonEl) return;
			const bar = buttonEl.parentElement;
			const tab = bar?.closest<HTMLElement>('[role="tab"]');
			const next = [...(bar?.querySelectorAll<HTMLElement>('button') ?? [])].find(
				(el) => el !== buttonEl && !menuEl?.contains(el) && !el.hasAttribute('disabled')
			);
			(tab ?? next)?.focus();
		});
	});
</script>

{#if shown}
	<button
		type="button"
		class="menu-btn"
		bind:this={buttonEl}
		data-dock-menu-for={panelId}
		aria-label={t.panelMenu(title)}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? menuId : undefined}
		onpointerdown={(event) => event.stopPropagation()}
		onclick={() => (open ? closeMenu(true) : void openMenu('first'))}
		onkeydown={handleButtonKeydown}
		onfocusout={handleFocusOut}
	>
		⋯
	</button>
	{#if open}
		<div
			class="dock-menu"
			id={menuId}
			role="menu"
			aria-label={t.panelMenu(title)}
			tabindex="-1"
			popover={POPOVER ? 'manual' : undefined}
			bind:this={menuEl}
			style:top={`${top}px`}
			style:left={`${left}px`}
			style:max-height={maxHeight === null ? undefined : `${maxHeight}px`}
			onpointerdown={(event) => event.stopPropagation()}
			onkeydown={handleMenuKeydown}
			onfocusout={handleFocusOut}
		>
			{#each items as item (item.key)}
				<button
					type="button"
					class="dock-menu-item"
					role="menuitem"
					tabindex="-1"
					data-key={item.key}
					aria-haspopup={'sub' in item ? 'menu' : undefined}
					onclick={() => choose(item)}
				>
					{item.label}{#if 'sub' in item}<span class="sub" aria-hidden="true">▸</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
{/if}

<style>
	/* Same shape as the title bar's other buttons (DockedTree / DockWindow). */
	.menu-btn {
		flex: 0 0 auto;
		width: var(--banto-dock-button-size, 20px);
		height: var(--banto-dock-button-size, 20px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font: inherit;
		line-height: 1;
	}

	.menu-btn:hover,
	.menu-btn[aria-expanded='true'] {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-primary);
	}

	.menu-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* A manual popover in the top layer, placed under (or above) the button in viewport px. */
	.dock-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: 12rem;
		max-height: 60vh;
		overflow-y: auto;
		padding: var(--banto-space-1);
		background: var(--banto-surface-raised);
		color: var(--banto-text);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-dock-shadow);
		font-size: var(--banto-font-size-sm);
		pointer-events: auto;
		z-index: 40;
	}

	.dock-menu-item {
		width: 100%;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
		padding: var(--banto-space-1) var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.dock-menu-item:hover,
	.dock-menu-item:focus {
		background: var(--banto-surface-hover);
		outline: none;
	}

	.dock-menu-item:focus-visible {
		box-shadow: var(--banto-focus-ring);
	}

	.sub {
		color: var(--banto-text-muted);
	}
</style>
