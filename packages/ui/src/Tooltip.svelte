<script lang="ts">
	/**
	 * Tooltip (#556, docs/reviews/design-ux-review-2026-11.md): a short text
	 * bubble for a control, the in-page replacement of the `title` attribute
	 * (which keyboard users never see and which cannot be styled).
	 *
	 * - Shown after `delay` ms of hover (mouse / pen; a touch is not a hover) or
	 *   keyboard focus (`:focus-visible`, so a click does not leave one open).
	 *   Hidden on blur, on a press of the trigger, and on leaving the trigger -
	 *   after a short grace period, so the pointer can move onto the bubble and
	 *   stay there (WCAG 1.4.13 "hoverable").
	 * - Esc hides it until the pointer leaves / focus moves (1.4.13
	 *   "dismissible"). Like LauncherBar's tooltip it does not consume the key:
	 *   a Modal around the trigger still closes on the same Esc; it yields to a
	 *   layer above the trigger (layering.ts promise 2).
	 * - The bubble is `role="tooltip"`. By default the trigger gets
	 *   `aria-describedby` pointing at it (the bubble then stays in the DOM,
	 *   hidden, so the description is there from the first focus). Pass
	 *   `describe={false}` when the text is already the trigger's accessible
	 *   name (IconButton's `label`) - it would be read twice.
	 * - The bubble is a `popover="manual"` (top layer: above Modals, never
	 *   clipped by a scrolling or transformed ancestor), placed under the
	 *   trigger and moved above / inside the viewport near an edge
	 *   (`anchoredPopover.ts`); an ancestor scroll hides it.
	 *
	 * The trigger is the caller's element: the `children` snippet receives
	 * props to spread on it (an attachment that wires the events, and
	 * `aria-describedby`).
	 */
	import type { Snippet } from 'svelte';
	import { createAttachmentKey, type Attachment } from 'svelte/attachments';
	import { computeAnchoredPosition, watchAnchoredPopover } from './anchoredPopover';
	import { hasVisibleLayerAbove } from './layering';
	import type { TooltipTriggerProps } from './types';

	interface Props {
		text: string;
		/** Default `true`: the trigger is described by the bubble (`aria-describedby`). */
		describe?: boolean;
		/** Hover / focus time before the bubble shows (ms). Default 300. */
		delay?: number;
		/** The trigger; spread the given props on its element. */
		children: Snippet<[TooltipTriggerProps]>;
	}

	let { text, describe = true, delay = 300, children }: Props = $props();

	/** Leaving the trigger: time to reach the bubble before it hides (ms). */
	const HIDE_GRACE_MS = 100;

	const uid = $props.id();
	const bubbleId = `${uid}-tooltip`;
	let triggerEl: HTMLElement | undefined;
	let bubbleEl: HTMLElement | undefined = $state();
	let open = $state(false);
	let coords: { top: number; left: number } | null = $state(null);

	let hovering = false;
	let focused = false;
	/** Esc / a press hid it: stay hidden until the pointer leaves and focus moves. */
	let quiet = false;
	let showTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		clearTimeout(showTimer);
		clearTimeout(hideTimer);
		showTimer = hideTimer = undefined;
	}

	function scheduleShow(): void {
		clearTimeout(hideTimer);
		hideTimer = undefined;
		if (open || quiet || showTimer !== undefined) return;
		showTimer = setTimeout(() => {
			showTimer = undefined;
			if ((hovering || focused) && !quiet) open = true;
		}, delay);
	}

	function scheduleHide(): void {
		clearTimeout(showTimer);
		showTimer = undefined;
		if (!open || hideTimer !== undefined) return;
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			if (!hovering && !focused) open = false;
		}, HIDE_GRACE_MS);
	}

	function hideNow(): void {
		clearTimers();
		open = false;
	}

	function isFocusVisible(el: Element): boolean {
		try {
			return el.matches(':focus-visible');
		} catch {
			return true; // engines without the selector: treat focus as visible
		}
	}

	const wire: Attachment<HTMLElement> = (el) => {
		triggerEl = el;
		const onEnter = (event: PointerEvent): void => {
			if (event.pointerType === 'touch') return;
			hovering = true;
			scheduleShow();
		};
		const onLeave = (event: PointerEvent): void => {
			if (event.pointerType === 'touch') return;
			hovering = false;
			if (!focused) quiet = false;
			scheduleHide();
		};
		const onFocus = (): void => {
			quiet = false;
			focused = isFocusVisible(el);
			if (focused) scheduleShow();
		};
		const onBlur = (): void => {
			focused = false;
			if (!hovering) quiet = false;
			hideNow();
		};
		const onPress = (): void => {
			quiet = true;
			hideNow();
		};
		el.addEventListener('pointerenter', onEnter);
		el.addEventListener('pointerleave', onLeave);
		el.addEventListener('focus', onFocus);
		el.addEventListener('blur', onBlur);
		el.addEventListener('pointerdown', onPress);
		return () => {
			el.removeEventListener('pointerenter', onEnter);
			el.removeEventListener('pointerleave', onLeave);
			el.removeEventListener('focus', onFocus);
			el.removeEventListener('blur', onBlur);
			el.removeEventListener('pointerdown', onPress);
			clearTimers();
			open = false;
			if (triggerEl === el) triggerEl = undefined;
		};
	};

	const attachKey = createAttachmentKey();
	const triggerProps: TooltipTriggerProps = $derived({
		'aria-describedby': describe ? bubbleId : undefined,
		[attachKey]: wire
	});

	// The bubble itself is hoverable: moving onto it keeps it open.
	function onBubbleEnter(): void {
		hovering = true;
		clearTimeout(hideTimer);
		hideTimer = undefined;
	}

	function onBubbleLeave(): void {
		hovering = false;
		scheduleHide();
	}

	type PopoverElement = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };

	function reposition(): void {
		if (!triggerEl || !bubbleEl) return;
		coords = computeAnchoredPosition(triggerEl, bubbleEl, 'bottom-center');
	}

	$effect(() => {
		const el = bubbleEl as PopoverElement | undefined;
		if (!el) return;
		if (!open) {
			coords = null;
			try {
				el.hidePopover?.();
			} catch {
				// already hidden
			}
			return;
		}
		try {
			el.showPopover?.();
		} catch {
			// already shown, or the popover API is missing (jsdom): stays in flow
		}
		reposition();
		const detach = watchAnchoredPopover(el, { reposition, close: hideNow });
		const onKeydown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			// A palette / Modal / menu above the trigger owns this Esc.
			if (triggerEl && hasVisibleLayerAbove({ except: triggerEl })) return;
			// No preventDefault: a layer around the trigger may still act on it.
			quiet = true;
			hideNow();
		};
		window.addEventListener('keydown', onKeydown);
		return () => {
			detach();
			window.removeEventListener('keydown', onKeydown);
		};
	});
</script>

{@render children(triggerProps)}

{#if describe || open}
	<div
		bind:this={bubbleEl}
		id={bubbleId}
		class="tooltip"
		role="tooltip"
		popover="manual"
		hidden={!open}
		style:top={coords ? `${coords.top}px` : undefined}
		style:left={coords ? `${coords.left}px` : undefined}
		style:visibility={open && coords ? 'visible' : 'hidden'}
		onpointerenter={onBubbleEnter}
		onpointerleave={onBubbleLeave}
	>
		{text}
	</div>
{/if}

<style>
	.tooltip {
		position: fixed;
		inset: auto;
		margin: 0;
		box-sizing: border-box;
		/* A short label, not a paragraph: wraps only past this width. */
		max-width: min(20rem, calc(100vw - 2 * var(--banto-space-2)));
		padding: var(--banto-space-1) var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-raised);
		box-shadow: var(--banto-shadow-md);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
		white-space: normal;
		pointer-events: auto;
	}

	@media (forced-colors: active) {
		.tooltip {
			border-color: CanvasText;
		}
	}
</style>
