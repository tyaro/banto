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
	import { getMenuContext } from './menuContext';
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
		onSelect: () => void;
	}

	let { label, icon: Icon, danger = false, disabled = false, checked, onSelect }: Props = $props();

	const menu = getMenuContext();

	let itemEl: HTMLButtonElement | undefined = $state();

	$effect(() => {
		if (!itemEl) return;
		return menu.registerItem(itemEl);
	});

	function handleClick(): void {
		if (disabled) return;
		onSelect();
		menu.close();
	}
</script>

<button
	bind:this={itemEl}
	type="button"
	role={checked === undefined ? 'menuitem' : 'menuitemradio'}
	aria-checked={checked === undefined ? undefined : checked}
	tabindex="-1"
	class="menu-item"
	class:danger
	class:disabled
	aria-disabled={disabled ? 'true' : undefined}
	onclick={handleClick}
>
	{#if checked !== undefined}
		<svg class="check" class:on={checked} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path d="M3 8.5l3.5 3.5L13 4.5" fill="none" stroke="currentColor" stroke-width="1.75" />
		</svg>
	{/if}
	{#if Icon}
		<Icon size={16} aria-hidden="true" />
	{/if}
	<span>{label}</span>
</button>

<style>
	.check {
		flex: none;
		width: var(--banto-space-4);
		height: var(--banto-space-4);
		visibility: hidden;
	}

	.check.on {
		visibility: visible;
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
		pointer-events: none;
		opacity: 0.6;
	}
</style>
