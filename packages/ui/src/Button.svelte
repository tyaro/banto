<script lang="ts">
	/**
	 * Text button (#556, docs/reviews/design-ux-review-2026-11.md C-1). The look
	 * is `@banto/theme`'s common `.banto-btn` classes, so a `<button
	 * class="banto-btn banto-btn--secondary">` written by hand looks the same.
	 *
	 * - `variant` / `size` pick the modifier classes.
	 * - `loading` shows a spinner INSTEAD of swapping the label: the label stays
	 *   in the same grid cell (transparent), so the width does not change and a
	 *   screen reader still reads it. The button gets `aria-busy` and is
	 *   `disabled` meanwhile, so it cannot be pressed twice.
	 * - `icon` is drawn before the label at a size that follows `size`.
	 * - Anything else (`title`, `aria-label`, `form`, `data-*`, `class`, ...)
	 *   goes straight to the `<button>`.
	 */
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { UiIconComponent } from './types';

	interface Props extends Omit<HTMLButtonAttributes, 'children' | 'type'> {
		/** Default `'secondary'`, the most common look in the app. */
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		/** `'sm'` is the compact height. Default `'md'`. */
		size?: 'sm' | 'md';
		/** A process started by this button is running. Default `false`. */
		loading?: boolean;
		/** Drawn before the label; decorative (`aria-hidden`). */
		icon?: UiIconComponent;
		/** Default `'button'` (so it never submits a form by accident). */
		type?: 'button' | 'submit' | 'reset';
		children?: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		loading = false,
		icon: Icon,
		type = 'button',
		disabled = false,
		class: className,
		children,
		...rest
	}: Props = $props();
</script>

<button
	{...rest}
	{type}
	class={[
		'banto-btn',
		`banto-btn--${variant}`,
		size === 'sm' && 'banto-btn--sm',
		loading && 'banto-btn--loading',
		className
	]}
	disabled={disabled || loading}
	aria-busy={loading ? 'true' : undefined}
>
	{#if loading}
		<span class="banto-btn__content">
			{#if Icon}<Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />{/if}
			{@render children?.()}
		</span>
		<span class="banto-btn__spinner" aria-hidden="true"></span>
	{:else}
		{#if Icon}<Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />{/if}
		{@render children?.()}
	{/if}
</button>
