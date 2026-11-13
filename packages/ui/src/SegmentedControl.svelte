<script lang="ts" generics="T extends string">
	/**
	 * Segmented control (#556, docs/reviews/design-ux-review-2026-11.md): a short
	 * single choice drawn as one row of segments. The look is `@banto/theme`'s
	 * `.banto-segmented`.
	 *
	 * - Each segment is a native `<input type="radio">` inside its `<label>`,
	 *   so the arrow keys, the single Tab stop, form submission (`name`) and the
	 *   checked state are the browser's own; the radio is invisible but keeps
	 *   the segment's box, so it still takes clicks and focus.
	 * - The wrapper is `role="radiogroup"` named by `label` (aria-label) or by
	 *   `labelledby` (the id of a visible heading) - give one of them.
	 * - `value` (bindable) is the checked option; `onchange` fires only for a
	 *   choice the user made.
	 */
	import type { SegmentedOption } from './types';

	interface Props {
		options: SegmentedOption<T>[];
		/** The checked option (bindable). Nothing is checked when it matches none. */
		value?: T;
		/** `name` of the radios: one per group on the page (and the form field name). */
		name: string;
		/** Accessible name of the group (give `label` or `labelledby`). */
		label?: string;
		/** id of a visible heading naming the group. */
		labelledby?: string;
		/** `'sm'` is the compact height. Default `'md'`. */
		size?: 'sm' | 'md';
		/** Disables every segment. */
		disabled?: boolean;
		onchange?: (value: T) => void;
	}

	let {
		options,
		value = $bindable(),
		name,
		label,
		labelledby,
		size = 'md',
		disabled = false,
		onchange
	}: Props = $props();

	function choose(option: SegmentedOption<T>): void {
		value = option.value;
		onchange?.(option.value);
	}
</script>

<div
	class={['banto-segmented', size === 'sm' && 'banto-segmented--sm']}
	role="radiogroup"
	aria-label={label}
	aria-labelledby={labelledby}
	aria-disabled={disabled ? 'true' : undefined}
>
	{#each options as option (option.value)}
		{@const Icon = option.icon}
		<label class="banto-segmented__option">
			<input
				class="banto-segmented__input"
				type="radio"
				{name}
				value={option.value}
				checked={option.value === value}
				disabled={disabled || option.disabled}
				onchange={() => choose(option)}
			/>
			{#if Icon}<Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />{/if}
			<span>{option.label}</span>
		</label>
	{/each}
</div>
