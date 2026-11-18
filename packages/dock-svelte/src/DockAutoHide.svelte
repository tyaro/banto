<script lang="ts">
	/**
	 * The edge bands and slide-outs of auto-hidden regions (#694 PR-3, `core/autohide.ts`).
	 * Rendered by `DockHost` between the docked layer and the floating layer, so a
	 * slid-out pane covers the docked tree and floating windows stay above it.
	 *
	 * - A band per edge that holds a region: one tab (a `button`) per pane, a region's
	 *   tabs next to each other. Left / right bands run vertically (vertical text), top
	 *   / bottom horizontally. `DockHost` insets the docked layer by the bands.
	 * - Pressing a tab slides its pane out from that edge over the docked tree
	 *   (`DockState.openFlyout`) and moves the focus into it; pressing it again slides
	 *   it back. Pressing (pointer down) outside the pane and its tab, Esc inside it,
	 *   and the focus leaving it slide it back. A press or a focus inside the top
	 *   layer (an open `dialog` / `[popover]`, e.g. a menu or a confirm dialog opened
	 *   from the pane) is not "outside" (#667); an Esc that something consumed
	 *   (`defaultPrevented`), part of an IME composition, or pressed inside such a
	 *   layer is left alone.
	 * - Sliding back while the focus is inside the pane hands the focus to the pane's
	 *   band tab first (`.pre`, the pane is still rendered). A focus the host or the
	 *   user put elsewhere is never taken.
	 * - Content: the slid-out pane, plus every `keepMounted` pane (kept `hidden` +
	 *   `inert`, the same DOM, like a background tab). Any other pane is created when
	 *   it slides out and destroyed when it slides back - sliding is not asked through
	 *   `beforePanelChange` (it is showing, like expanding a collapsed band).
	 * - The slid-out pane's header: the pin button (back to the docked place, asked
	 *   through `beforePanelChange` as `auto-hide` `to: 'tree'`) and the close button
	 *   (`capabilities.close`). It is not a drag source, and the bands and the pane are
	 *   not drop targets (`data-dock-no-drop`). No pop-out button.
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { clampFlyoutSize } from './core/autohide';
	import { getPanelLifecycle } from './core/lifecycle';
	import { getDockPolicy, resolveCapabilities } from './core/policy';
	import type { DockState } from './state.svelte';
	import type { DockAutoHidden, DockEdge, DockPanelNode, PanelContent } from './types';
	import { defaultDockMessages, type DockMessages } from './messages';

	interface Props {
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		iconContent?: Snippet<[string]>;
		messages?: Partial<DockMessages>;
	}

	let { dock, panel, iconContent, messages = {} }: Props = $props();

	const t = $derived({ ...defaultDockMessages, ...messages });
	const lifecycle = getPanelLifecycle();
	const policy = getDockPolicy();
	const uid = $props.id();

	const EDGES: DockEdge[] = ['top', 'bottom', 'left', 'right'];
	const BAND = 'var(--banto-dock-titlebar-height)';

	interface Item {
		pane: DockPanelNode;
		entry: DockAutoHidden;
		/** Stable within this render: used for `id` / `aria-controls`. */
		key: string;
	}

	const items: Item[] = $derived(
		dock.autoHidden.flatMap((entry, e) =>
			(entry.node.type === 'tabs' ? entry.node.children : [entry.node]).map((pane, i) => ({
				pane,
				entry,
				key: `${uid}-${e}-${i}`
			}))
		)
	);
	const bands = $derived(
		EDGES.map((edge) => ({ edge, entries: dock.autoHidden.filter((e) => e.edge === edge) })).filter(
			(b) => b.entries.length > 0
		)
	);
	const has = $derived(new Set(bands.map((b) => b.edge)));
	const open = $derived(dock.flyoutPanel);
	/** The slid-out pane and the kept (`keepMounted`) ones. */
	const mounted = $derived(
		items.filter((it) => it.pane.id === open || lifecycle.keepMounted(it.pane.id))
	);

	const flyoutEls: Record<string, HTMLElement | null> = $state({});
	let rootEl: HTMLElement | null = $state(null);

	function paneIds(entry: DockAutoHidden): DockPanelNode[] {
		return entry.node.type === 'tabs' ? entry.node.children : [entry.node];
	}

	function bandTab(panelId: string): HTMLElement | undefined {
		const host = rootEl?.closest('[data-dock-host]') ?? rootEl?.parentElement;
		const tabs = host?.querySelectorAll<HTMLElement>('[data-dock-band-tab]') ?? [];
		return [...tabs].find((el) => el.dataset.dockBandTab === panelId);
	}

	/**
	 * A modal layer that is showing: `@banto/ui`'s Modal / ConfirmDialog are an
	 * OverlayPanel `div` with `role="dialog"` / `"alertdialog"` and `aria-modal="true"`
	 * (`data-layer-inactive` while it leaves). A floating DockWindow is `role="dialog"`
	 * without `aria-modal`, so it stays "outside".
	 */
	const MODAL =
		':is([role="dialog"], [role="alertdialog"])[aria-modal="true"]:not([data-layer-inactive])';

	/**
	 * Inside an open dialog / popover (the top layer, #667) or a modal layer (a
	 * confirmation opened from the pane, #700): never "outside" the pane. A press
	 * on a modal's scrim (the element that directly wraps it) belongs to it too.
	 */
	function inTopLayer(node: Node): boolean {
		const el = node instanceof Element ? node : node.parentElement;
		if (!el) return false;
		if (el.closest(`dialog[open], [popover], ${MODAL}`) != null) return true;
		return [...el.children].some((child) => child.matches(MODAL));
	}

	async function toggle(panelId: string): Promise<void> {
		if (open === panelId) {
			dock.closeFlyout();
			return;
		}
		dock.openFlyout(panelId);
		await tick();
		// The user asked for the pane: the focus goes into it.
		flyoutEls[panelId]?.querySelector<HTMLElement>('.body')?.focus();
	}

	function onFlyoutKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (event.isComposing || event.keyCode === 229) return;
		if (event.target instanceof Node && inTopLayer(event.target)) return;
		event.preventDefault();
		dock.closeFlyout();
	}

	function onFlyoutFocusout(event: FocusEvent, panelId: string): void {
		const to = event.relatedTarget;
		// `null`: the window lost focus, or a press on something not focusable (the pointer path handles that).
		if (!(to instanceof Node) || open !== panelId) return;
		if (flyoutEls[panelId]?.contains(to) || inTopLayer(to)) return;
		if (bandTab(panelId)?.contains(to)) return;
		dock.closeFlyout();
	}

	// Outside press while a pane is slid out (a document listener only while it is open).
	$effect(() => {
		const now = open;
		if (now === null) return;
		const onDown = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (flyoutEls[now]?.contains(target) || inTopLayer(target)) return;
			// Its own band tab toggles it (the click handler).
			if (bandTab(now)?.contains(target)) return;
			dock.closeFlyout();
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	});

	// Sliding back with the focus inside: hand it to the band tab first (`.pre`: the pane is still shown).
	let shownBefore: string | null = null;
	$effect.pre(() => {
		const now = open;
		untrack(() => {
			const prev = shownBefore;
			shownBefore = now;
			if (prev === null || prev === now) return;
			const el = flyoutEls[prev];
			const active = document.activeElement;
			if (el && active && el.contains(active)) bandTab(prev)?.focus();
		});
	});

	/** The pin button of a slid-out pane: back to the docked place; the focus then goes to the region's pin button there. */
	function pinBack(item: Item): void {
		const regionId = item.entry.node.id;
		const host = rootEl?.closest('[data-dock-host]') ?? null;
		void lifecycle.restoreAutoHidden(regionId).then(async (outcome) => {
			if (outcome !== 'applied') return;
			await tick();
			const active = document.activeElement;
			if (active && active !== document.body && active.isConnected) return;
			const pins = host?.querySelectorAll<HTMLElement>('[data-dock-autohide-for]') ?? [];
			[...pins].find((el) => el.dataset.dockAutohideFor === regionId)?.focus();
		});
	}

	function sizeOf(item: Item): string {
		return `${clampFlyoutSize(item.entry.size) * 100}%`;
	}
</script>

<div class="dock-autohide" bind:this={rootEl}>
	{#each bands as band (band.edge)}
		{@const vertical = band.edge === 'left' || band.edge === 'right'}
		<div
			class="band band-{band.edge}"
			role="group"
			aria-label={t.autoHideBand(band.edge)}
			data-dock-no-drop=""
			data-dock-band={band.edge}
			style:top={vertical && has.has('top') ? BAND : undefined}
			style:bottom={vertical && has.has('bottom') ? BAND : undefined}
		>
			{#each band.entries as entry (entry.node.id)}
				<div class="band-entry">
					{#each paneIds(entry) as pane (pane.id)}
						{@const item = items.find((it) => it.pane.id === pane.id)}
						{@const isOpen = open === pane.id}
						<button
							type="button"
							class="band-tab"
							class:open={isOpen}
							data-dock-band-tab={pane.id}
							aria-expanded={isOpen}
							aria-controls={item && mounted.includes(item) ? item.key : undefined}
							onclick={() => void toggle(pane.id)}
						>
							{#if pane.icon}
								<span class="icon" aria-hidden="true">
									{#if iconContent}
										{@render iconContent(pane.icon)}
									{:else}
										{pane.icon}
									{/if}
								</span>
							{/if}
							<span class="title">{pane.title}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
	{/each}

	{#if mounted.length > 0}
		<div
			class="flyout-area"
			style:top={has.has('top') ? BAND : '0'}
			style:bottom={has.has('bottom') ? BAND : '0'}
			style:left={has.has('left') ? BAND : '0'}
			style:right={has.has('right') ? BAND : '0'}
		>
			{#each mounted as item (item.pane.id)}
				{@const shown = item.pane.id === open}
				{@const horizontal = item.entry.edge === 'left' || item.entry.edge === 'right'}
				<!-- The pane listens for Esc and focus leaving it (slide back); its controls are the buttons and the body inside. -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="flyout edge-{item.entry.edge}"
					id={item.key}
					role="group"
					aria-label={item.pane.title}
					data-dock-no-drop=""
					data-dock-flyout={item.pane.id}
					hidden={!shown}
					inert={!shown}
					style:width={horizontal ? sizeOf(item) : undefined}
					style:height={horizontal ? undefined : sizeOf(item)}
					bind:this={flyoutEls[item.pane.id]}
					onkeydown={onFlyoutKeydown}
					onfocusout={(event) => onFlyoutFocusout(event, item.pane.id)}
				>
					<div class="titlebar">
						{#if item.pane.icon}
							<span class="icon" aria-hidden="true">
								{#if iconContent}
									{@render iconContent(item.pane.icon)}
								{:else}
									{item.pane.icon}
								{/if}
							</span>
						{/if}
						<span class="title">{item.pane.title}</span>
						<button
							type="button"
							class="pin-btn unpinned"
							aria-label={t.pinPane(item.pane.title)}
							onclick={() => pinBack(item)}
						>
							<span aria-hidden="true">📌</span>
						</button>
						{#if resolveCapabilities(policy, item.pane.id).close}
							<button
								type="button"
								class="close-btn"
								aria-label={t.close(item.pane.title)}
								onclick={() => void lifecycle.closeButton(item.pane.id)}
							>
								✕
							</button>
						{/if}
					</div>
					<!-- Same scrollable-region-focusable rationale (and svelte-ignore) as DockedTree's `.body`. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div class="body" role="region" aria-label={item.pane.title} tabindex="0">
						{@render panel(item.pane)}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* A layout no-op: the bands and the slide-out area are placed against the host. */
	.dock-autohide {
		display: contents;
	}

	.band {
		position: absolute;
		display: flex;
		gap: var(--banto-space-2);
		box-sizing: border-box;
		overflow: hidden;
		background: var(--banto-surface-raised);
		user-select: none;
	}

	.band-top,
	.band-bottom {
		left: 0;
		right: 0;
		height: var(--banto-dock-titlebar-height);
		flex-direction: row;
		padding: 0 var(--banto-space-2);
	}

	.band-top {
		top: 0;
		border-bottom: var(--banto-border-width) solid var(--banto-border);
	}

	.band-bottom {
		bottom: 0;
		border-top: var(--banto-border-width) solid var(--banto-border);
	}

	.band-left,
	.band-right {
		top: 0;
		bottom: 0;
		width: var(--banto-dock-titlebar-height);
		flex-direction: column;
		padding: var(--banto-space-2) 0;
	}

	.band-left {
		left: 0;
		border-right: var(--banto-border-width) solid var(--banto-border);
	}

	.band-right {
		right: 0;
		border-left: var(--banto-border-width) solid var(--banto-border);
	}

	.band-entry {
		display: flex;
		flex-direction: inherit;
		min-width: 0;
		min-height: 0;
	}

	.band-tab {
		flex: 0 1 auto;
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		min-width: 0;
		min-height: 0;
		max-width: 12rem;
		padding: 0 var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		cursor: pointer;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Left / right: the tab runs down, the title in vertical text. */
	.band-left .band-tab,
	.band-right .band-tab {
		writing-mode: vertical-rl;
		max-width: none;
		max-height: 12rem;
		padding: var(--banto-space-2) 0;
	}

	.band-tab:hover,
	.band-tab.open {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.band-tab.open {
		box-shadow: inset 0 calc(-1 * var(--banto-border-width-strong)) 0 var(--banto-primary);
	}

	.band-tab:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Its own stacking context, like `.docked-layer`: painted above the docked tree by DOM
	   order, below the floating layer (z-index 1), whatever z-index the slid-out pane uses -
	   except while the slid-out pane shows a modal, which must stay above the floating windows. */
	.flyout-area {
		position: absolute;
		pointer-events: none;
	}

	.flyout-area:not(:has([aria-modal='true'])) {
		isolation: isolate;
	}

	.flyout {
		position: absolute;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		min-width: 0;
		min-height: 0;
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		box-shadow: var(--banto-dock-shadow);
		pointer-events: auto;
	}

	.flyout[hidden] {
		display: none;
	}

	.flyout.edge-left {
		left: 0;
		top: 0;
		bottom: 0;
		animation: dock-slide-left var(--banto-duration-base) var(--banto-ease-out);
	}

	.flyout.edge-right {
		right: 0;
		top: 0;
		bottom: 0;
		animation: dock-slide-right var(--banto-duration-base) var(--banto-ease-out);
	}

	.flyout.edge-top {
		top: 0;
		left: 0;
		right: 0;
		animation: dock-slide-top var(--banto-duration-base) var(--banto-ease-out);
	}

	.flyout.edge-bottom {
		bottom: 0;
		left: 0;
		right: 0;
		animation: dock-slide-bottom var(--banto-duration-base) var(--banto-ease-out);
	}

	@keyframes dock-slide-left {
		from {
			transform: translateX(-100%);
		}
	}

	@keyframes dock-slide-right {
		from {
			transform: translateX(100%);
		}
	}

	@keyframes dock-slide-top {
		from {
			transform: translateY(-100%);
		}
	}

	@keyframes dock-slide-bottom {
		from {
			transform: translateY(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.flyout {
			animation: none;
		}
	}

	.titlebar {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-dock-titlebar-height);
		padding: 0 var(--banto-space-2) 0 var(--banto-space-3);
		background: var(--banto-surface-raised);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text);
		user-select: none;
	}

	.icon {
		flex: 0 0 auto;
		font-size: var(--banto-font-size-md);
	}

	.title {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pin-btn,
	.close-btn {
		flex: 0 0 auto;
		width: var(--banto-dock-button-size, 20px);
		height: var(--banto-dock-button-size, 20px);
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font-size: var(--banto-font-size-xs);
	}

	/* Unpinned: the pin lies on its side (Visual Studio's auto-hide look). */
	.pin-btn.unpinned span {
		display: inline-block;
		transform: rotate(-90deg);
	}

	.pin-btn:hover {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-primary);
	}

	.close-btn:hover {
		background: color-mix(in srgb, var(--banto-danger) 15%, transparent);
		color: var(--banto-danger);
	}

	.pin-btn:focus-visible,
	.close-btn:focus-visible,
	.body:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: auto;
		background: var(--banto-surface);
	}
</style>
