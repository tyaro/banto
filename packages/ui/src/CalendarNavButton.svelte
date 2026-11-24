<script lang="ts">
	/**
	 * A previous / next button of the calendar's heading (internal, not
	 * exported): shared by the day view (`MonthCalendar`) and the month / year
	 * views (`CalendarPeriodView`, Issue #908). An icon button named by
	 * `label` (also its tooltip); `disabled` is `aria-disabled`, so it stays
	 * focusable and a click on it does nothing.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		disabled?: boolean;
		onclick: () => void;
		children: Snippet;
	}

	let { label, disabled = false, onclick, children }: Props = $props();
</script>

<button
	type="button"
	class="date-picker-nav"
	aria-label={label}
	title={label}
	aria-disabled={disabled ? 'true' : undefined}
	onclick={() => {
		if (!disabled) onclick();
	}}
>
	{@render children()}
</button>

<style>
	.date-picker-nav {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		inline-size: var(--banto-control-height-sm);
		block-size: var(--banto-control-height-sm);
		padding: 0;
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.date-picker-nav:hover:not([aria-disabled='true']) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-picker-nav[aria-disabled='true'] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.date-picker-nav:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.date-picker-nav:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
