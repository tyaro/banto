<script lang="ts">
	/**
	 * Menu item (visual-refresh-design.md §7.2, §7.5). `role="menuitem"` +
	 * `tabindex="-1"` roving focus - Menu.svelte moves focus imperatively
	 * via `.focus()`, so items never need to enter native Tab order.
	 * Enter/Space selection comes for free from being a real `<button>`.
	 *
	 * `disabled` uses `aria-disabled` rather than the native `disabled`
	 * attribute (§7.5) so the item stays reachable for `aria-disabled`
	 * inspection during traversal while visually/interactively inert.
	 */
	import { onMount } from 'svelte';
	import { getMenuContext } from './menuContext';
	import { detectShortcutPlatform, formatShortcut, toAriaKeyShortcuts } from './shortcut';
	import type { ShortcutPlatform } from './shortcut';
	import type { UiIconComponent } from './types';

	interface Props {
		label: string;
		icon?: UiIconComponent;
		danger?: boolean;
		disabled?: boolean;
		/**
		 * Opt-in single-choice item: when set (true or false) the item is a
		 * `role="menuitemradio"` with `aria-checked`, and the chosen one shows
		 * a check mark. Omit it for an ordinary action item.
		 */
		checked?: boolean;
		/**
		 * Shape of a `checked` item. `'radio'` (default) is a single choice
		 * (`menuitemradio`) that closes the menu on select. `'checkbox'` is a
		 * multi-select toggle (`menuitemcheckbox`): selecting it calls
		 * `onSelect()` only, leaving the menu open and focus on the item.
		 * Without `checked` this has no effect.
		 */
		kind?: 'radio' | 'checkbox';
		/** Native tooltip (e.g. why a disabled item is unavailable). */
		title?: string;
		/**
		 * Key shown right-aligned as keycap text (`'Mod+Z'`, same syntax as
		 * `CommandSpec.shortcut`). Display only (the key itself is handled by a
		 * dispatcher): the accessible name stays `label`, the key goes to
		 * `aria-keyshortcuts`.
		 */
		shortcut?: string;
		/**
		 * Platform for the keycap text. Omitted: `'other'` for the first render
		 * (matches SSR, so hydration agrees) and `detectShortcutPlatform()` once
		 * mounted. Given: used as is.
		 */
		platform?: ShortcutPlatform;
		/**
		 * Explicit `aria-keyshortcuts` value, used as is instead of the automatic
		 * conversion. Needed for layout-dependent symbol keys (`'?'`, `'Shift+%'`),
		 * which the automatic conversion omits.
		 */
		ariaKeyShortcuts?: string;
		onSelect: () => void;
	}

	let {
		label,
		icon: Icon,
		danger = false,
		disabled = false,
		checked,
		kind = 'radio',
		title,
		shortcut,
		platform,
		ariaKeyShortcuts,
		onSelect
	}: Props = $props();

	const menu = getMenuContext();

	// First render is 'other' (same as SSR); the real platform arrives after mount.
	let detectedPlatform: ShortcutPlatform = $state('other');
	onMount(() => {
		detectedPlatform = detectShortcutPlatform();
	});
	const resolvedPlatform = $derived(platform ?? detectedPlatform);
	const shortcutText = $derived(shortcut ? formatShortcut(shortcut, resolvedPlatform) : undefined);
	const ariaKeys = $derived(
		ariaKeyShortcuts ?? (shortcut ? toAriaKeyShortcuts(shortcut, resolvedPlatform) : undefined)
	);

	let itemEl: HTMLButtonElement | undefined = $state();

	$effect(() => {
		if (!itemEl) return;
		return menu.registerItem(itemEl);
	});

	function handleClick(): void {
		if (disabled) return;
		onSelect();
		if (checked !== undefined && kind === 'checkbox') return;
		menu.close();
	}
</script>

<button
	bind:this={itemEl}
	type="button"
	role={checked === undefined
		? 'menuitem'
		: kind === 'checkbox'
			? 'menuitemcheckbox'
			: 'menuitemradio'}
	{title}
	aria-checked={checked === undefined ? undefined : checked}
	aria-keyshortcuts={ariaKeys}
	tabindex="-1"
	class="menu-item"
	class:danger
	class:disabled
	aria-disabled={disabled ? 'true' : undefined}
	onclick={handleClick}
	onmousedown={(event) => {
		// Keep focus where it was: a click on a disabled item does nothing,
		// so it must not pull DOM focus off the roving-focus item either.
		if (disabled) event.preventDefault();
	}}
>
	{#if checked !== undefined}
		<svg class="check" class:on={checked} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path d="M3 8.5l3.5 3.5L13 4.5" fill="none" stroke="currentColor" stroke-width="1.75" />
		</svg>
	{/if}
	{#if Icon}
		<Icon size={16} aria-hidden="true" />
	{/if}
	<span class="label">{label}</span>
	{#if shortcutText}
		<span class="shortcut" aria-hidden="true">{shortcutText}</span>
	{/if}
</button>

<style>
	.check {
		flex: none;
		width: 1rem;
		height: 1rem;
		visibility: hidden;
	}

	/* `inherit`, not `visible`: a closed Menu keeps its box (display: flex for
	   the exit transition) and hides it with `visibility: hidden` only. A
	   `visible` child would escape that and, invisible at opacity 0, still
	   take clicks over whatever lies under the closed menu. */
	.check.on {
		visibility: inherit;
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		width: 100%;
		box-sizing: border-box;
		padding: var(--banto-space-2) var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text);
		font-size: var(--banto-font-size-md);
		text-align: left;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.label {
		min-width: 0;
		flex: 1 1 auto;
	}

	/* Never shrinks or wraps: a long label wraps, the key stays. */
	.shortcut {
		flex: none;
		margin-inline-start: var(--banto-space-4);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		white-space: nowrap;
	}

	.menu-item:hover,
	.menu-item:focus-visible {
		background: var(--banto-surface-hover);
		outline: none;
	}

	.menu-item.danger {
		color: var(--banto-danger);
	}

	.menu-item.danger:hover,
	.menu-item.danger:focus-visible {
		background: var(--banto-danger-tint);
	}

	.menu-item.disabled {
		color: var(--banto-text-muted);
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* No pointer-events: none here - a disabled item must stay the hover
	   target so its `title` (why it is unavailable) shows. `handleClick`
	   already ignores it; the hover tint is suppressed instead. */
	.menu-item.disabled:hover {
		background: transparent;
	}

	/* Forced colors drop the hover/focus background, which is the only focus
	   mark above - draw a system-colour outline so keyboard focus stays visible. */
	@media (forced-colors: active) {
		.menu-item:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
