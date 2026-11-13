<script lang="ts">
	/**
	 * In-page tabs (#556, docs/reviews/design-ux-review-2026-11.md): one
	 * `role="tablist"` of `role="tab"` buttons and one `role="tabpanel"` per tab
	 * (WAI-ARIA APG "Tabs"). The look is `@banto/theme`'s `.banto-tabs` (drawn
	 * like `.banto-section-nav`, which stays the class for page links - tabs
	 * here switch content on the same page, they do not route).
	 *
	 * - `value` (bindable) is the selected tab's id; `onchange` reports a new one.
	 * - Keyboard: a roving tabindex - only one tab is in the Tab order; ←/→ move
	 *   between tabs (mirrored when the tablist is right-to-left), Home / End go
	 *   to the first / last; disabled tabs are skipped. `activation="automatic"`
	 *   (default) selects the tab focus lands on, `"manual"` waits for
	 *   Enter / Space (for panels that are slow to draw).
	 * - Every tab has its panel element (so `aria-controls` always resolves),
	 *   but only the selected panel is drawn; the others are `hidden` and empty.
	 *   The panel is focusable (`tabindex="0"`) so Tab reaches a panel without
	 *   focusable content.
	 * - Disabled tabs carry `aria-disabled` (still announced, never selected).
	 */
	import type { Snippet } from 'svelte';
	import type { TabItem } from './types';

	interface Props {
		tabs: TabItem[];
		/** The selected tab's id (bindable). Default: the first enabled tab. */
		value?: string;
		/** Accessible name of the tablist (give `label` or `labelledby`). */
		label?: string;
		/** id of a visible heading naming the tablist. */
		labelledby?: string;
		/** Default `'automatic'`: moving focus selects the tab. */
		activation?: 'automatic' | 'manual';
		onchange?: (id: string) => void;
		/** The selected tab's panel content; receives the tab id. */
		panel: Snippet<[string]>;
	}

	let {
		tabs,
		value = $bindable(),
		label,
		labelledby,
		activation = 'automatic',
		onchange,
		panel
	}: Props = $props();

	const uid = $props.id();
	const tabId = (id: string): string => `${uid}-tab-${id}`;
	const panelId = (id: string): string => `${uid}-panel-${id}`;

	const enabled = $derived(tabs.filter((tab) => !tab.disabled));
	/** `value` when it names an enabled tab, else the first enabled one. */
	const selected = $derived(enabled.some((tab) => tab.id === value) ? value : enabled[0]?.id);
	// Keep the bound value on the tab actually shown: the fallback above (no
	// value yet, or the chosen tab was removed / disabled) is written back, so
	// the caller never acts on a tab that is not displayed. Not a user choice,
	// so `onchange` is not called.
	$effect.pre(() => {
		if (value !== selected) value = selected;
	});
	/** Manual activation lets focus rest on another tab; that tab holds the tab stop. */
	let focusedId: string | undefined = $state();
	const tabStop = $derived(
		focusedId !== undefined && enabled.some((tab) => tab.id === focusedId) ? focusedId : selected
	);

	let listEl: HTMLElement | undefined = $state();

	function select(id: string): void {
		if (id === selected) return;
		value = id;
		onchange?.(id);
	}

	function isRtl(): boolean {
		return !!listEl && getComputedStyle(listEl).direction === 'rtl';
	}

	function moveTo(id: string): void {
		focusedId = id;
		document.getElementById(tabId(id))?.focus();
		if (activation === 'automatic') select(id);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const ids = enabled.map((tab) => tab.id);
		if (ids.length === 0) return;
		const current = Math.max(ids.indexOf(tabStop ?? ''), 0);
		let next: number;
		switch (event.key) {
			case 'ArrowRight':
				next = current + (isRtl() ? -1 : 1);
				break;
			case 'ArrowLeft':
				next = current + (isRtl() ? 1 : -1);
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = ids.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		moveTo(ids[(next + ids.length) % ids.length]);
	}

	function handleClick(tab: TabItem): void {
		if (tab.disabled) return;
		focusedId = tab.id;
		select(tab.id);
	}

	function handleFocusout(event: FocusEvent): void {
		// Leaving the tablist hands the tab stop back to the selected tab.
		const to = event.relatedTarget;
		if (!(to instanceof Node) || !listEl?.contains(to)) focusedId = undefined;
	}
</script>

<div
	bind:this={listEl}
	class="banto-tabs"
	role="tablist"
	aria-label={label}
	aria-labelledby={labelledby}
	aria-orientation="horizontal"
	onfocusout={handleFocusout}
>
	{#each tabs as tab (tab.id)}
		{@const Icon = tab.icon}
		<button
			type="button"
			role="tab"
			id={tabId(tab.id)}
			aria-selected={tab.id === selected}
			aria-controls={panelId(tab.id)}
			aria-disabled={tab.disabled ? 'true' : undefined}
			tabindex={tab.id === tabStop ? 0 : -1}
			onclick={() => handleClick(tab)}
			onkeydown={handleKeydown}
		>
			{#if Icon}<Icon size={16} aria-hidden="true" />{/if}
			{tab.label}
		</button>
	{/each}
</div>

{#each tabs as tab (tab.id)}
	<div
		class="banto-tabs__panel"
		role="tabpanel"
		id={panelId(tab.id)}
		aria-labelledby={tabId(tab.id)}
		tabindex="0"
		hidden={tab.id !== selected}
	>
		{#if tab.id === selected}
			{@render panel(tab.id)}
		{/if}
	</div>
{/each}
