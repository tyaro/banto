<script lang="ts">
	/**
	 * The calendar dialog of the extended pickers (internal, not exported;
	 * Issue #910): `DatePicker` and `DateRangePicker` share it. The same
	 * dialog as `DateInput`'s (docs/design/date-time-pickers.md §5.4, APG Date
	 * Picker Dialog): `role="dialog"` + `aria-modal="true"` +
	 * `attachFocusTrap`, in the top layer (`popover="manual"`, our own light
	 * dismiss: a pointerdown outside closes it), placed by `anchoredPopover.ts`
	 * below `anchor`, closed on an ancestor scroll. Esc goes through one
	 * function, `closeOnEscape` (layering.ts rules 1-2), from the dialog's
	 * keydown and from the window (rule 3); `back` is its first stop (the
	 * calendar's month / year view goes back one view, #908). Closing returns
	 * focus to `returnFocus()` (the text box, D10).
	 *
	 * Keys inside the dialog do not propagate (a native listener, §5.8 promise
	 * 1) - the calendar's own grid listener runs first. The parent renders it
	 * inside its root, so the parent's `focusout` / `pointerdown` handling
	 * sees the dialog as part of the component (promises 3 and 4).
	 *
	 * `DateInput` / `DateTimeInput` keep their own copy of this logic on
	 * purpose: the plain pickers are not changed by #910.
	 */
	import { flushSync, type Snippet } from 'svelte';
	import { computeAnchoredPosition, watchAnchoredPopover } from './anchoredPopover';
	import { attachFocusTrap, hasVisibleLayerAbove } from './layering';

	interface Props {
		/** Shown (bindable; read it, open with `show()` and close with `close()`). */
		open?: boolean;
		/** The dialog's accessible name. */
		label: string;
		/** What the dialog is placed against (the field). */
		anchor: HTMLElement | undefined;
		/** The button that toggles the dialog: a press on it is left to its own click. */
		toggle: HTMLElement | undefined;
		/** Where focus goes when the dialog closes with focus inside / from Esc. */
		returnFocus: () => HTMLElement | undefined;
		/** Esc's first stop: `true` when it was consumed (stay open). */
		back?: () => boolean;
		/** The dialog element while open (bindable, read-only): the calendar's `scroller`. */
		panel?: HTMLDivElement;
		children: Snippet;
	}

	let {
		open = $bindable(false),
		label,
		anchor,
		toggle,
		returnFocus,
		back,
		panel = $bindable(),
		children
	}: Props = $props();

	let coords = $state<{ top: number; left: number } | undefined>(undefined);
	let detachTrap: (() => void) | undefined;

	function reposition(): void {
		if (!anchor || !panel) return;
		coords = computeAnchoredPosition(anchor, panel, 'bottom-start');
	}

	/**
	 * Render the dialog, show it, measure it, then make it visible (`coords`)
	 * and call `focusInside` (a still-hidden cell cannot take focus). It
	 * exists only while open, so a closed picker leaves no `role="dialog"`.
	 */
	export function show(focusInside: () => void): void {
		if (open) return;
		open = true;
		flushSync();
		if (!panel) return;
		panel.showPopover();
		reposition();
		flushSync();
		detachTrap = attachFocusTrap(panel);
		focusInside();
	}

	/** Close; `focusBack` puts focus on `returnFocus()` first (never dropping it to <body>). */
	export function close(focusBack: boolean): void {
		if (!open) return;
		// Trap off first: focusing the box from inside the dialog must not be
		// pulled back. Then focus the box before hiding.
		detachTrap?.();
		detachTrap = undefined;
		if (focusBack) returnFocus()?.focus({ preventScroll: true });
		try {
			panel?.hidePopover();
		} catch {
			// Already hidden (removed from the top layer by the browser).
		}
		open = false;
		coords = undefined;
	}

	/** The one Esc path (§5.4): yields to IME, to a consumed Esc and to a layer above. */
	export function closeOnEscape(event: KeyboardEvent): void {
		if (!open || event.key !== 'Escape') return;
		// IME 変換中の Escape は変換の取消。ピッカーを閉じない。
		if (event.isComposing || event.keyCode === 229) return;
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panel })) return;
		event.preventDefault();
		if (back?.()) return;
		close(true);
	}

	function handlePanelKeydown(event: KeyboardEvent): void {
		closeOnEscape(event);
		event.stopPropagation();
	}

	$effect(() => {
		const el = panel;
		if (!el) return;
		el.addEventListener('keydown', handlePanelKeydown);
		return () => el.removeEventListener('keydown', handlePanelKeydown);
	});

	$effect(() => {
		if (!open) return;
		function handleDocumentPointerDown(event: PointerEvent): void {
			const target = event.target;
			if (target instanceof Node && (panel?.contains(target) || toggle?.contains(target))) {
				return;
			}
			// Park focus on the text box first: the click then moves it on from
			// there, so a host sees one ordinary blur from the component.
			close(true);
		}
		document.addEventListener('pointerdown', handleDocumentPointerDown, true);
		const unwatch = watchAnchoredPopover(panel, {
			reposition,
			close: () => close(!!panel?.contains(document.activeElement))
		});
		// The content can change size while open (two months <-> one at the
		// narrow width, or `months` changed): measure and place it again, so
		// it never sticks out past the viewport's edge.
		const resize =
			typeof ResizeObserver === 'function' && panel ? new ResizeObserver(reposition) : null;
		if (resize && panel) resize.observe(panel);
		return () => {
			document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
			unwatch();
			resize?.disconnect();
		};
	});

	// Unmounted while open: drop the trap's listeners.
	$effect(() => () => detachTrap?.());
</script>

<svelte:window onkeydown={closeOnEscape} />

{#if open}
	<div
		bind:this={panel}
		popover="manual"
		role="dialog"
		aria-modal="true"
		aria-label={label}
		tabindex="-1"
		class="date-picker"
		style:top={coords ? `${coords.top}px` : undefined}
		style:left={coords ? `${coords.left}px` : undefined}
		style:visibility={coords ? 'visible' : 'hidden'}
		onmousedown={(event) => {
			// A press on something that cannot take focus (heading, weekday
			// header, gaps) would focus the dialog itself and strand the arrow
			// keys: keep focus where it is (the tracked day).
			const target = event.target;
			if (!(target instanceof Element) || !target.closest('button, td[tabindex]')) {
				event.preventDefault();
			}
		}}
	>
		{@render children()}
	</div>
{/if}

<style>
	.date-picker {
		/* Shape of the calendar (§9: a part's own size, not a dimension step):
		   one day cell, shrunk so 7 of them plus the padding fit a 320px
		   viewport at 200% text (RangeCalendar narrows it for two months). */
		--banto-date-cell-size: min(
			2.25rem,
			calc((100vw - 2 * var(--banto-space-3) - var(--banto-space-4)) / 7)
		);
		position: fixed;
		inset: auto;
		margin: 0;
		box-sizing: border-box;
		max-inline-size: calc(100vw - 2 * var(--banto-space-1));
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		box-shadow: var(--banto-shadow-lg);
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		overflow: auto;
		overscroll-behavior: contain;
	}

	.date-picker:focus {
		outline: none;
	}

	/* The footer the pickers put under the calendar (their own markup). */
	.date-picker :global(.date-picker-footer) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
		margin-block-start: var(--banto-space-2);
	}

	.date-picker :global(.date-picker-action) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--banto-space-1) var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-primary-text);
		font: inherit;
		font-size: var(--banto-font-size-md);
		cursor: pointer;
	}

	.date-picker :global(.date-picker-action:hover:not([aria-disabled='true'])) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-picker :global(.date-picker-action[aria-disabled='true']) {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.date-picker :global(.date-picker-action:focus-visible) {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.date-picker :global(.date-picker-action:focus-visible) {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
