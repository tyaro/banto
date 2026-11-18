<script lang="ts">
	/**
	 * The nav links laid out in the header row: the "menu bar" form of the
	 * app nav (docs/design/nav-menubar-plan.md §4, §5.1; ADR-0018 §12).
	 *
	 * - Pattern (§4.7, D3-c): APG disclosure navigation - plain `<a href>`
	 *   links and `<button aria-expanded aria-controls>` for groups, not
	 *   `role="menubar"`. Every top item stays a Tab stop (no roving
	 *   tabindex); ArrowLeft / ArrowRight (wrapping) and Home / End move
	 *   along the top row as a help. Inside an open dropdown ArrowUp /
	 *   ArrowDown / Home / End move between the links; ArrowLeft / Right close
	 *   it and move to the neighbouring top item (wrapping, not opened;
	 *   `headerNav.ts` `listTarget`, `topRowTarget`).
	 * - Dropdowns open on click / tap only (D9), as `popover="auto"` (top
	 *   layer: a glass header's `backdrop-filter` would offset a plain
	 *   `position: fixed` child, §2.6), placed by `anchoredPopover.ts`. The
	 *   popover follows its button in the DOM, so Tab from an open button
	 *   walks into the links; focus leaving the dropdown closes it, Esc
	 *   closes it and returns focus to the button.
	 * - Overflow (§4.3, §4.4): an `aria-hidden`, `inert` measuring row of
	 *   `<span>`s (no links or buttons, so nothing shows up twice for AT or
	 *   e2e) holds every top item and the "more" button. ResizeObserver on the
	 *   nav and on each measured item, an `entries` change and font loading
	 *   re-measure (once per frame); `fitCount` decides how many stay on top,
	 *   the rest go to "more", groups under a heading with their links flat
	 *   (D2-a). The visible row stays hidden until the first measurement, and
	 *   the count is written only when it changes. When not even "more" fits,
	 *   the visible row hides and `onInsufficient(true)` tells the shell to
	 *   fall back to its drawer (§4.9); the measuring row keeps running.
	 * - Top items are text only, dropdown links icon + text (D5). Unread
	 *   counts come in as numbers: links show a capped badge, group / "more"
	 *   buttons a dot, and each adds `updatesLabel(count)` to its name (§4.5).
	 * - Menu entries (#663 ①-B, a desktop-style "View" menu): a button that
	 *   opens the ui `Menu` (`role="menu"`) with action / checkbox items and
	 *   separators - commands, kept apart from the link disclosures. Keyboard
	 *   and focus are Menu's (Enter / Space / ArrowDown open on the first item,
	 *   ArrowUp on the last; Esc closes and returns focus to the button; a
	 *   checkbox keeps the menu open). On top of that the button joins the
	 *   top-row arrows, and ArrowLeft / Right inside the open menu close it and
	 *   move to the neighbouring top item, like a dropdown. A menu entry is
	 *   pinned: it never moves into "more" (its width is reserved first,
	 *   `fitCount`'s `pinned`), and it hides with the row when insufficient,
	 *   its open menu closed like a dropdown.
	 *
	 * Text, icons and state all come through props; imports nothing but
	 * `svelte` (conventions §5). No `.svelte.ts` (conventions §14).
	 */
	import { flushSync, untrack, type Snippet } from 'svelte';
	import { computeAnchoredPosition, watchAnchoredPopover } from './anchoredPopover';
	import Menu from './Menu.svelte';
	import MenuItem from './MenuItem.svelte';
	import MenuSeparator from './MenuSeparator.svelte';
	import {
		entryActive,
		entryCount,
		entryPinned,
		fitCount,
		HEADER_NAV_INSUFFICIENT,
		headerNavBadgeText,
		listTarget,
		overflowSections,
		topRowTarget,
		type HeaderNavEntry,
		type HeaderNavLink
	} from './headerNav';

	interface Props {
		entries: HeaderNavEntry[];
		/** The `<nav>` landmark's name. */
		ariaLabel: string;
		/** The "more" button's text. */
		moreLabel: string;
		/** Spoken name of an unread count; defaults to the bare number. */
		updatesLabel?: (count: number) => string;
		/**
		 * `false` for a nav that never overflows (the admin nav: one group,
		 * D4): no measuring, no "more", and the nav does not stretch.
		 */
		overflow?: boolean;
		/** Called when the nav starts / stops being too narrow even for "more" (§4.9). */
		onInsufficient?: (insufficient: boolean) => void;
	}

	let {
		entries,
		ariaLabel,
		moreLabel,
		updatesLabel = (count: number) => String(count),
		overflow = true,
		onInsufficient
	}: Props = $props();

	const uid = $props.id();
	const MORE = 'more';

	let navEl: HTMLElement | undefined = $state();
	let measureEl: HTMLElement | undefined = $state();
	let rowEl: HTMLElement | undefined = $state();

	/** `fitCount`'s last result; all entries until the first measurement. */
	let fit = $state<number>(Number.POSITIVE_INFINITY);
	let measured = $state(false);

	const insufficient = $derived(overflow && fit === HEADER_NAV_INSUFFICIENT);
	/** Entries that can move into "more"; pinned ones (menus) always stay. */
	const flowEntries = $derived(entries.filter((entry) => !entryPinned(entry)));
	/** How many of `flowEntries` stay on top (pinned entries not counted). */
	const shownCount = $derived(
		!overflow ? flowEntries.length : Math.max(0, Math.min(fit, flowEntries.length))
	);
	const shown = $derived.by(() => {
		let flowIndex = 0;
		return entries.filter((entry) => entryPinned(entry) || flowIndex++ < shownCount);
	});
	const moved = $derived(overflow ? flowEntries.slice(shownCount) : []);
	const moreSections = $derived(overflowSections(moved));
	const moreCount = $derived(moved.reduce((sum, entry) => sum + entryCount(entry), 0));
	const moreActive = $derived(moved.some(entryActive));

	// ---- dropdowns -------------------------------------------------------

	/** Which dropdown is open: `g:<group id>` (stable across inserts), or `MORE`. */
	let openKey = $state<string | null>(null);
	let coords = $state<{ key: string; top: number; left: number } | null>(null);
	const popovers: Record<string, HTMLElement> = {};
	const buttons: Record<string, HTMLElement> = {};
	// Menu entries' `Menu` instances, to re-anchor an open one after a re-layout.
	const menus: Record<string, { reposition: () => void } | undefined> = {};
	let focusIntent: 'first' | 'last' | 'none' = 'none';

	function groupKey(id: string): string {
		return `g:${id}`;
	}

	function popoverId(key: string): string {
		// `key` carries a group id, which may hold characters unfit for an id.
		// `_` is encoded too, so it only ever marks an escape and no two keys collide.
		return `${uid}-dropdown-${key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
	}

	function linksIn(key: string): HTMLElement[] {
		const popover = popovers[key];
		return popover ? Array.from(popover.querySelectorAll<HTMLElement>('a[href]')) : [];
	}

	function openDropdown(key: string, intent: 'first' | 'last' | 'none'): void {
		if (openKey === key) {
			if (intent !== 'none') focusLink(key, intent === 'first' ? 0 : -1);
			return;
		}
		focusIntent = intent;
		// showPopover() throws on an already-open popover.
		if (popovers[key]?.matches?.(':popover-open') !== true) popovers[key]?.showPopover();
	}

	function closeDropdown(key: string | null = openKey): void {
		if (key === null) return;
		popovers[key]?.hidePopover();
	}

	function focusLink(key: string, index: number): void {
		const links = linksIn(key);
		if (links.length === 0) return;
		links[((index % links.length) + links.length) % links.length]?.focus();
	}

	function reposition(): void {
		const key = openKey;
		if (key === null) return;
		const button = buttons[key];
		const popover = popovers[key];
		if (!button || !popover) return;
		coords = { key, ...computeAnchoredPosition(button, popover, 'bottom-start') };
	}

	function handleToggle(key: string, event: ToggleEvent): void {
		if (event.newState === 'open') {
			openKey = key;
			// Laid out by the time `toggle` fires (same as Menu); apply the
			// position (and with it `visibility: visible`) before focusing.
			reposition();
			flushSync();
			if (focusIntent === 'first') focusLink(key, 0);
			else if (focusIntent === 'last') focusLink(key, -1);
			focusIntent = 'none';
			return;
		}
		if (openKey === key) openKey = null;
		if (coords?.key === key) coords = null;
		popovers[key]?.style.removeProperty('max-height');
		// Give focus back to the button only when it would otherwise drop to
		// <body> (Esc, a followed link); an outside click or Tab has already
		// moved it somewhere the user chose (same rule as Menu).
		const active = document.activeElement;
		if (active === null || active === document.body || popovers[key]?.contains(active)) {
			buttons[key]?.focus();
		}
	}

	function handleButtonClick(key: string): void {
		// `openKey` follows the async `toggle` event, so a click whose
		// pointerdown already light-dismissed this dropdown still reads it
		// as open here and does not reopen it (Menu relies on the same).
		if (openKey === key) closeDropdown(key);
		else openDropdown(key, 'none');
	}

	function handleButtonKeydown(key: string, event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				openDropdown(key, 'first');
				break;
			case 'ArrowUp':
				event.preventDefault();
				openDropdown(key, 'last');
				break;
			case 'Escape':
				if (openKey === key) {
					event.preventDefault();
					closeDropdown(key);
				}
				break;
			default:
				handleTopKeydown(event);
		}
	}

	function handleLinkKeydown(key: string, event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeDropdown(key);
			buttons[key]?.focus();
			return;
		}
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			// Close and step to the neighbouring top item (§4.7); it is not opened.
			const items = rowEl
				? Array.from(rowEl.querySelectorAll<HTMLElement>('[data-header-nav-top]'))
				: [];
			const button = buttons[key];
			const target = button ? topRowTarget(items.indexOf(button), items.length, event.key) : null;
			if (target === null) return;
			event.preventDefault();
			event.stopPropagation();
			closeDropdown(key);
			items[target]?.focus();
			return;
		}
		const links = linksIn(key);
		const target = listTarget(
			links.indexOf(document.activeElement as HTMLElement),
			links.length,
			event.key
		);
		if (target === null) return;
		event.preventDefault();
		links[target]?.focus();
	}

	/** On the cell (button + popover): focus leaving both closes the dropdown. */
	function handleCellFocusout(key: string, event: FocusEvent): void {
		const next = event.relatedTarget;
		// Tab past the last link or Shift+Tab off the button closes it; focus
		// is not returned (it went where the user chose).
		if (next instanceof Node && !(event.currentTarget as HTMLElement).contains(next))
			closeDropdown(key);
	}

	/**
	 * Closes the ui `Menu`s of menu entries (their popovers live in the row's
	 * cells, not in `popovers`). `hidePopover` skips a closed one; the guard
	 * is for browsers that still throw on it.
	 */
	function closeMenus(): void {
		for (const menu of rowEl?.querySelectorAll<HTMLElement>('[role="menu"][popover]') ?? []) {
			try {
				menu.hidePopover();
			} catch {
				// already closed
			}
		}
	}

	/**
	 * On a menu entry's cell: ArrowLeft / Right on an item of its open menu
	 * close the menu and move to the neighbouring top item (wrapping, not
	 * opened), the same as inside a dropdown (§4.7). Focus moves after the
	 * menu hides, so Menu's own "give focus back to the button" (which acts
	 * only when focus would drop to <body>) leaves it there.
	 */
	function handleMenuCellKeydown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const cell = event.currentTarget as HTMLElement;
		const menu = (event.target as HTMLElement | null)?.closest?.('[role="menu"]');
		if (!rowEl || !(menu instanceof HTMLElement) || !cell.contains(menu)) return;
		const items = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-header-nav-top]'));
		const button = cell.querySelector<HTMLElement>('[data-header-nav-top]');
		const target = button ? topRowTarget(items.indexOf(button), items.length, event.key) : null;
		if (target === null) return;
		event.preventDefault();
		event.stopPropagation();
		try {
			menu.hidePopover();
		} catch {
			// already closed
		}
		items[target]?.focus();
	}

	function handleTopKeydown(event: KeyboardEvent): void {
		if (!rowEl) return;
		const items = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-header-nav-top]'));
		const current = items.indexOf(event.currentTarget as HTMLElement);
		if (current < 0) return;
		const target = topRowTarget(current, items.length, event.key);
		if (target === null) return;
		event.preventDefault();
		closeDropdown();
		items[target]?.focus();
	}

	/** Dropdown keys rendered right now; an open one that moved away is dropped. */
	const renderedKeys = $derived(
		new Set([
			...shown.flatMap((entry) => (entry.kind === 'group' ? [groupKey(entry.id)] : [])),
			...(moved.length > 0 ? [MORE] : [])
		])
	);

	$effect(() => {
		if (openKey !== null && !renderedKeys.has(openKey)) {
			openKey = null;
			coords = null;
		}
	});

	$effect(() => {
		if (openKey === null) return;
		const popover = popovers[openKey];
		const key = openKey;
		return watchAnchoredPopover(popover, { reposition, close: () => closeDropdown(key) });
	});

	// ---- overflow measurement (§4.4) -------------------------------------

	/** Everything that changes the measured widths (§4.4 (2)). */
	const signature = $derived(
		JSON.stringify([
			moreLabel,
			entries.map((entry) =>
				entry.kind === 'link'
					? [entry.id, entry.label, entry.count ?? 0]
					: [entry.kind, entry.id, entry.label, entryCount(entry)]
			)
		])
	);

	function gapOf(element: HTMLElement): number {
		const style = getComputedStyle(element);
		return parseFloat(style.columnGap) || parseFloat(style.gap) || 0;
	}

	// A re-layout can remove the focused element (an item moves into "more", or
	// "more" disappears). Remember where focus was, then follow it to where that
	// item lives now. Dropdowns are never opened by this.
	type FocusSpot =
		| { kind: 'top'; id: string }
		| { kind: 'more'; moved: string[] }
		| { kind: 'link'; id: string; key: string };

	function captureFocus(): FocusSpot | null {
		const active = typeof document === 'undefined' ? null : document.activeElement;
		if (!rowEl || !active || !rowEl.contains(active)) return null;
		if (active === buttons[MORE]) return { kind: 'more', moved: moved.map((entry) => entry.id) };
		const el = active as HTMLElement;
		if (el.hasAttribute?.('data-header-nav-top') && el.dataset?.headerNavId !== undefined)
			return { kind: 'top', id: el.dataset.headerNavId };
		const linkId = el.dataset?.headerNavLink;
		if (linkId === undefined) return null;
		for (const key of Object.keys(popovers)) {
			if (popovers[key]?.contains(active)) return { kind: 'link', id: linkId, key };
		}
		return null;
	}

	function restoreFocus(spot: FocusSpot): void {
		if (!rowEl || rowEl.contains(document.activeElement)) return;
		let id: string | undefined;
		if (spot.kind === 'top') id = spot.id;
		else if (spot.kind === 'more') id = spot.moved.find((m) => entries.some((e) => e.id === m));
		else if (spot.key !== MORE)
			id = spot.key.slice(2); // its group, still on top
		else
			id = entries.find(
				(entry) =>
					entry.id === spot.id ||
					(entry.kind === 'group' && entry.items.some((item) => item.id === spot.id))
			)?.id;
		const tops = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-header-nav-top]'));
		const target =
			(id !== undefined ? tops.find((el) => el.dataset.headerNavId === id) : undefined) ??
			buttons[MORE];
		if (target?.isConnected) target.focus();
	}

	function measure(): void {
		if (!overflow || !navEl || !measureEl) return;
		// "more" carries its own marker so an entry whose id is 'more' is never mistaken for it.
		const measuredItems = Array.from(
			measureEl.querySelectorAll<HTMLElement>('[data-header-nav-measure]')
		);
		const widths = measuredItems.map((item) => item.getBoundingClientRect().width);
		const pinned = measuredItems.map((item) => item.hasAttribute('data-header-nav-pinned'));
		const moreEl = measureEl.querySelector<HTMLElement>('[data-header-nav-measure-more]');
		const next = fitCount(
			widths,
			navEl.getBoundingClientRect().width,
			moreEl?.getBoundingClientRect().width ?? 0,
			gapOf(measureEl),
			{ previous: fit, pinned }
		);
		// Write only on a change (§4.4 ちらつき防止 (2)).
		if (next !== fit) {
			const was = fit === HEADER_NAV_INSUFFICIENT;
			const focus = captureFocus();
			fit = next;
			const now = next === HEADER_NAV_INSUFFICIENT;
			// The row hides while insufficient; an open dropdown (top layer, its own
			// `visibility`) would stay usable without its button, so close it.
			if (now && !was) {
				closeDropdown();
				closeMenus();
			}
			if (was !== now) onInsufficient?.(now);
			if (focus) {
				flushSync();
				restoreFocus(focus);
			}
		}
		if (!measured) measured = true;
		// An open dropdown follows its button: the row may have just changed
		// (a new fit, or a label / count width), so lay it out, then re-anchor.
		if (openKey !== null) {
			flushSync();
			reposition();
		}
		// Same for an open menu entry: its trigger may have moved (links before
		// it going into "More", a width change) with no window resize, which is
		// all `Menu` listens to. `reposition` is a no-op on a closed one.
		for (const menu of Object.values(menus)) menu?.reposition();
	}

	// `overflow` turned off while the width was insufficient: nothing measures
	// any more, so release the state here.
	$effect(() => {
		if (overflow || fit !== HEADER_NAV_INSUFFICIENT) return;
		fit = Number.POSITIVE_INFINITY;
		untrack(() => onInsufficient?.(false));
	});

	let pending = false;
	let frame: number | null = null;
	let destroyed = false;
	function schedule(): void {
		if (pending || destroyed) return;
		pending = true;
		const raf =
			typeof requestAnimationFrame === 'function'
				? requestAnimationFrame
				: (callback: (time: number) => void) =>
						setTimeout(() => callback(0), 16) as unknown as number;
		const id = raf(() => {
			pending = false;
			frame = null;
			// Never let a measurement subscribe the caller (an effect, when
			// the frame runs synchronously) to `fit` (conventions §8).
			untrack(measure);
		});
		if (pending) frame = id;
	}

	$effect(() => {
		if (!overflow || !navEl || !measureEl) return;
		void signature; // re-run (re-observe and re-measure) when entries change
		const nav = navEl;
		const row = measureEl;
		schedule();
		if (typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver(() => schedule());
		observer.observe(nav);
		for (const item of row.querySelectorAll(
			'[data-header-nav-measure], [data-header-nav-measure-more]'
		))
			observer.observe(item);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!overflow || typeof document === 'undefined' || !document.fonts) return;
		const fonts = document.fonts;
		const handle = () => schedule();
		fonts.addEventListener?.('loadingdone', handle);
		void fonts.ready?.then(handle);
		return () => fonts.removeEventListener?.('loadingdone', handle);
	});

	$effect(() => {
		return () => {
			destroyed = true;
			if (frame !== null && typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(frame);
			}
		};
	});
</script>

{#snippet badge(count: number)}
	{#if count > 0}
		<span class="badge" aria-hidden="true">{headerNavBadgeText(count)}</span>
		<span class="sr-only">{updatesLabel(count)}</span>
	{/if}
{/snippet}

{#snippet dot(count: number)}
	{#if count > 0}
		<span class="dot" aria-hidden="true"></span>
		<span class="sr-only">{updatesLabel(count)}</span>
	{/if}
{/snippet}

{#snippet caret()}
	<svg class="caret" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
		<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" />
	</svg>
{/snippet}

{#snippet links(key: string, items: HeaderNavLink[])}
	<ul class="list">
		{#each items as item (item.id)}
			{@const Icon = item.icon}
			<li>
				<a
					href={item.href}
					class="link"
					class:active={item.active}
					aria-current={item.active ? 'page' : undefined}
					data-header-nav-link={item.id}
					onclick={() => closeDropdown(key)}
					onkeydown={(event) => handleLinkKeydown(key, event)}
				>
					{#if Icon}<Icon size={16} aria-hidden="true" />{/if}
					<span class="link-label">{item.label}</span>
					{@render badge(item.count ?? 0)}
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet dropdown(key: string, content: Snippet)}
	<div
		bind:this={popovers[key]}
		id={popoverId(key)}
		popover="auto"
		class="dropdown"
		style:top={coords?.key === key ? `${coords.top}px` : undefined}
		style:left={coords?.key === key ? `${coords.left}px` : undefined}
		style:visibility={coords?.key === key ? 'visible' : 'hidden'}
		ontoggle={(event) => handleToggle(key, event)}
	>
		{@render content()}
	</div>
{/snippet}

<nav
	bind:this={navEl}
	class="header-nav"
	class:fixed={!overflow}
	aria-label={ariaLabel}
	data-header-nav-shown={overflow ? shownCount : undefined}
>
	{#if overflow}
		<!-- Measuring row (§4.4): every top item + "more", out of the flow and
		     out of the a11y tree; spans only, so no link or button is doubled. -->
		<div class="measure-clip" aria-hidden="true" inert>
			<div bind:this={measureEl} class="row measure">
				{#each entries as entry (entry.id)}
					<span
						class="item"
						data-header-nav-measure={entry.id}
						data-header-nav-pinned={entryPinned(entry) ? '' : undefined}
					>
						<span>{entry.label}</span>
						{#if entry.kind === 'link'}
							{#if (entry.count ?? 0) > 0}<span class="badge"
									>{headerNavBadgeText(entry.count ?? 0)}</span
								>{/if}
						{:else}
							{#if entryCount(entry) > 0}<span class="dot"></span>{/if}
							{@render caret()}
						{/if}
					</span>
				{/each}
				<!-- "more" is measured with its dot so a dot appearing never
			     overflows the row. -->
				<span class="item" data-header-nav-measure-more>
					<span>{moreLabel}</span><span class="dot"></span>{@render caret()}
				</span>
			</div>
		</div>
	{/if}

	<ul
		bind:this={rowEl}
		class="row"
		style:visibility={overflow && (!measured || insufficient) ? 'hidden' : undefined}
	>
		{#each shown as entry (entry.id)}
			<!-- The keydown only catches ArrowLeft / Right bubbling up from the
			     items of a menu entry's open Menu (handleMenuCellKeydown); the
			     cell itself takes no input. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<li
				class="cell"
				onfocusout={(event) => {
					if (entry.kind === 'group') handleCellFocusout(groupKey(entry.id), event);
				}}
				onkeydown={entry.kind === 'menu' ? handleMenuCellKeydown : undefined}
			>
				{#if entry.kind === 'menu'}
					<Menu bind:this={menus[entry.id]} label={entry.label} placement="bottom-start">
						{#snippet trigger(props)}
							<button
								type="button"
								class="item"
								{...props}
								data-header-nav-top
								data-header-nav-id={entry.id}
								onkeydown={(event) => {
									props.onkeydown(event);
									if (!event.defaultPrevented) handleTopKeydown(event);
								}}
							>
								<span>{entry.label}</span>
								{@render caret()}
							</button>
						{/snippet}
						{#each entry.kind === 'menu' ? entry.items : [] as item (item.id)}
							{#if item.kind === 'separator'}
								<MenuSeparator />
							{:else if item.kind === 'checkbox'}
								<MenuItem
									kind="checkbox"
									label={item.label}
									checked={item.checked}
									disabled={item.disabled}
									title={item.title}
									onSelect={item.onSelect}
								/>
							{:else}
								<MenuItem
									label={item.label}
									icon={item.icon}
									danger={item.danger}
									disabled={item.disabled}
									title={item.title}
									onSelect={item.onSelect}
								/>
							{/if}
						{/each}
					</Menu>
				{:else if entry.kind === 'link'}
					<a
						href={entry.href}
						class="item"
						class:active={entry.active}
						aria-current={entry.active ? 'page' : undefined}
						data-header-nav-top
						data-header-nav-id={entry.id}
						onkeydown={handleTopKeydown}
					>
						<span>{entry.label}</span>
						{@render badge(entry.count ?? 0)}
					</a>
				{:else}
					{@const key = groupKey(entry.id)}
					<button
						bind:this={buttons[key]}
						type="button"
						class="item"
						class:active={entryActive(entry)}
						aria-expanded={openKey === key}
						aria-controls={popoverId(key)}
						data-header-nav-top
						data-header-nav-id={entry.id}
						onclick={() => handleButtonClick(key)}
						onkeydown={(event) => handleButtonKeydown(key, event)}
					>
						<span>{entry.label}</span>
						{@render dot(entryCount(entry))}
						{@render caret()}
					</button>
					{#snippet groupContent()}
						{@render links(key, entry.kind === 'group' ? entry.items : [])}
					{/snippet}
					{@render dropdown(key, groupContent)}
				{/if}
			</li>
		{/each}
		{#if moved.length > 0}
			<li class="cell" onfocusout={(event) => handleCellFocusout(MORE, event)}>
				<button
					bind:this={buttons[MORE]}
					type="button"
					class="item"
					class:active={moreActive}
					aria-expanded={openKey === MORE}
					aria-controls={popoverId(MORE)}
					data-header-nav-top
					onclick={() => handleButtonClick(MORE)}
					onkeydown={(event) => handleButtonKeydown(MORE, event)}
				>
					<span>{moreLabel}</span>
					{@render dot(moreCount)}
					{@render caret()}
				</button>
				{#snippet moreContent()}
					{#each moreSections as section, sectionIndex (section.id)}
						{#if section.heading !== undefined}
							{@const headingId = `${uid}-heading-${sectionIndex}`}
							<div class="section" role="group" aria-labelledby={headingId}>
								<p id={headingId} class="heading" aria-hidden="true">{section.heading}</p>
								{@render links(MORE, section.items)}
							</div>
						{:else}
							<div class="section">
								{@render links(MORE, section.items)}
							</div>
						{/if}
					{/each}
				{/snippet}
				{@render dropdown(MORE, moreContent)}
			</li>
		{/if}
	</ul>
</nav>

<style>
	.header-nav {
		position: relative;
		/* The hidden measuring row and a not-yet-fitted row must not widen the
		   page; the margin keeps the focus ring (box-shadow) from being cut.
		   Popovers live in the top layer and are not clipped. */
		overflow-x: clip;
		overflow-clip-margin: var(--banto-space-1);
		display: flex;
		align-items: center;
		/* The nav's width must not follow its content (§4.4): it takes what
		   the header row leaves, and ResizeObserver watches that. */
		flex: 1 1 0;
		min-width: 0;
	}

	.header-nav.fixed {
		flex: none;
	}

	.row {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: var(--banto-shell-menubar-gap);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Same classes on both rows so the measured widths match the visible row. */
	.measure-clip {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.measure {
		position: absolute;
		top: 0;
		left: 0;
		width: max-content;
		visibility: hidden;
		pointer-events: none;
	}

	.cell {
		display: flex;
		flex: none;
	}

	.item {
		position: relative;
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: var(--banto-space-1);
		box-sizing: border-box;
		height: var(--banto-control-height);
		margin: 0;
		padding: 0 var(--banto-shell-menubar-item-padding-x);
		border: 0;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
		font-size: var(--banto-font-size-md);
		line-height: 1;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.item:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.item:focus-visible,
	.link:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Active: a bottom edge (a component-shape edge, conventions §9) and the
	   sidebar's contrast-safe text colour. No weight change - it would make
	   the item wider than its measured twin. */
	.item.active {
		color: var(--banto-primary-hover);
	}

	.item.active::after {
		content: '';
		position: absolute;
		right: var(--banto-shell-menubar-item-padding-x);
		bottom: 0;
		left: var(--banto-shell-menubar-item-padding-x);
		height: var(--banto-shell-menubar-indicator);
		border-radius: var(--banto-shell-menubar-indicator);
		background: var(--banto-primary);
	}

	.caret {
		flex: none;
		width: 0.875em;
		height: 0.875em;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 1.5em;
		height: 1.5em;
		padding: 0 0.4em;
		border-radius: 999px;
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: var(--banto-font-size-xs);
		font-weight: 700;
		line-height: 1;
	}

	.dot {
		flex: none;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		background: var(--banto-primary-solid);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	.dropdown {
		position: fixed;
		inset: auto;
		box-sizing: border-box;
		/* Both bounds stay inside the viewport (min-width would win over max-width). */
		min-width: min(
			var(--banto-shell-menubar-popover-min-width),
			calc(100vw - 2 * var(--banto-space-2))
		);
		max-width: min(20rem, calc(100vw - 2 * var(--banto-space-2)));
		margin: 0;
		padding: var(--banto-space-1);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		box-shadow: var(--banto-shadow-lg);
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard. */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
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

	.dropdown:popover-open {
		opacity: 1;
		transform: translateY(0);
	}

	@starting-style {
		.dropdown:popover-open {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	.section + .section {
		margin-top: var(--banto-space-1);
		padding-top: var(--banto-space-1);
		border-top: var(--banto-border-width) solid var(--banto-border);
	}

	/* Same look as MenuGroup's heading (D2-a). */
	.heading {
		margin: var(--banto-space-1) var(--banto-space-2);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.link {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		padding: var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		color: var(--banto-text);
		font-size: var(--banto-font-size-md);
		text-decoration: none;
		/* A long name wraps inside the dropdown; the top row stays nowrap. */
		overflow-wrap: anywhere;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.link > :global(svg),
	.link .badge {
		flex: none;
	}

	.link:hover,
	.link:focus-visible {
		background: var(--banto-surface-hover);
	}

	.link.active {
		color: var(--banto-primary-hover);
		font-weight: 600;
	}

	.link-label {
		flex: 1;
		min-width: 0;
	}
</style>
