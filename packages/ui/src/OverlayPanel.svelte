<script lang="ts">
	/**
	 * The shared body of Modal.svelte and Drawer.svelte (package-internal, not
	 * exported; docs/adr/0018-shared-ui-package.md §10, phase 4). The two
	 * differ only in placement and motion (`variant`), so the logic lives
	 * once here - banto-hub kept two copies that had to be edited in lockstep.
	 *
	 * Contract (banto-hub T13-1 / T19 S1-b / TAG-UX-C / #381, unchanged):
	 *
	 * - Esc, the scrim click and × all go through one `requestClose()`:
	 *   `onRequestClose()` may veto, then `onclose()`. It is idempotent - an
	 *   outro keeps the panel clickable for ~160ms, and a second × must not ask
	 *   the unsaved-changes question twice.
	 * - `dirty` blocks only the accidental routes (Esc, scrim) and reports
	 *   `onBlockedClose()`; × is deliberate and always reaches `onRequestClose`
	 *   (`isCloseAllowed`).
	 * - The layer promises of `layering.ts`: Esc at window level, consumed when
	 *   it closes us, yielded to an already-consumed Esc or a layer above;
	 *   `data-layer-inactive` from the moment the close was decided (promise 6,
	 *   set synchronously - the re-render is too late for the next Esc); focus
	 *   trap while open; focus back to the opener on close.
	 * - On open, focus goes to the first focusable (the × in the header comes
	 *   first in DOM order).
	 *
	 * The opener is captured in `$effect.pre` (before `focusFirst` moves focus)
	 * and restored after `tick()`: the same update that closes the layer can
	 * remove the opener (deleting the row being edited), and restoring before the
	 * DOM update would focus a node that disappears right after.
	 */
	import { tick, untrack } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import IconButton from './IconButton.svelte';
	import X from './icons/X.svelte';
	import {
		attachFocusTrap,
		FOCUSABLE_SELECTOR,
		hasVisibleLayerAbove,
		isCloseAllowed,
		LAYER_INACTIVE_ATTR,
		restoreFocus
	} from './layering';
	import { defaultUiMessages } from './messages';
	import type { OverlayProps } from './overlay';

	interface Props extends OverlayProps {
		variant: 'modal' | 'drawer';
	}

	let {
		variant,
		open,
		title,
		width,
		closeOnOverlayClick = true,
		onclose,
		onRequestClose,
		dirty = false,
		onBlockedClose,
		focusFallback,
		messages,
		children
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });

	/** The `role="dialog"` panel - the `except` of the layer checks. */
	let panelEl: HTMLDivElement | undefined = $state();

	/** The close was decided (promise 6); reset when `open` turns true again. */
	let closing = $state(false);

	function requestClose(): void {
		if (closing) return;
		if (onRequestClose && !onRequestClose()) return;
		closing = true;
		panelEl?.setAttribute(LAYER_INACTIVE_ATTR, 'true');
		onclose?.();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!open || closing || event.key !== 'Escape') return;
		// Promises 1-2: the listener of a layer opened earlier runs first, so
		// `defaultPrevented` alone is not enough - also yield to a layer above.
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panelEl })) return;
		event.preventDefault();
		if (!isCloseAllowed('escape', dirty)) {
			onBlockedClose?.();
			return;
		}
		requestClose();
	}

	// Only a click on the scrim itself (not one bubbling from the panel), so
	// the panel needs no stopPropagation click handler.
	function handleOverlayClick(event: MouseEvent): void {
		if (!closeOnOverlayClick || event.target !== event.currentTarget) return;
		if (!isCloseAllowed('overlay', dirty)) {
			onBlockedClose?.();
			return;
		}
		requestClose();
	}

	// Promise 5: remember the opener on the open transition, give focus back
	// on the close transition (only on transitions, not on every run).
	let opener: HTMLElement | null = null;
	let openHandled = false;

	$effect.pre(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen === openHandled) return;
			openHandled = isOpen;
			if (isOpen) {
				closing = false;
				const active = document.activeElement;
				opener = active instanceof HTMLElement ? active : null;
			} else {
				const previous = opener;
				opener = null;
				void tick().then(() => restoreFocus(previous, () => focusFallback?.()));
			}
		});
	});

	// Promise 4 while open (`panelEl` is bound inside `{#if open}`).
	$effect(() => {
		if (!open) return;
		const node = panelEl;
		if (!node) return;
		return attachFocusTrap(node);
	});

	function focusFirst(node: HTMLElement): void {
		(node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? node).focus();
	}

	/** Durations honour `prefers-reduced-motion` (the CSS tokens cannot reach JS transitions). */
	function motion(ms: number): number {
		if (typeof matchMedia !== 'function') return ms;
		return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
	}

	function panelTransition(node: Element) {
		return variant === 'drawer'
			? fly(node, { x: 48, duration: motion(160) })
			: scale(node, { start: 0.96, duration: motion(160) });
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
	<div
		class="overlay"
		class:overlay--drawer={variant === 'drawer'}
		class:overlay--modal={variant === 'modal'}
		role="presentation"
		onclick={handleOverlayClick}
		transition:fade={{ duration: motion(120) }}
	>
		<div
			class="panel"
			class:panel--drawer={variant === 'drawer'}
			class:panel--modal={variant === 'modal'}
			bind:this={panelEl}
			role="dialog"
			data-layer-inactive={open && !closing ? undefined : 'true'}
			aria-modal="true"
			aria-label={title}
			style:width
			use:focusFirst
			transition:panelTransition
		>
			<div class="header">
				{#if title}<h3>{title}</h3>{/if}
				<span class="close">
					<IconButton label={t.overlayClose()} icon={X} size="sm" onclick={() => requestClose()} />
				</span>
			</div>
			<div class="body">
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: var(--banto-z-modal);
		display: flex;
		background: var(--banto-scrim);
	}

	.overlay--drawer {
		justify-content: flex-end;
	}

	.overlay--modal {
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.panel {
		display: flex;
		flex-direction: column;
		max-width: calc(100vw - 2rem);
		background: var(--banto-surface-overlay);
		color: var(--banto-text);
		box-shadow: var(--banto-shadow-lg);
		/* Glass preset: no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.panel--drawer {
		height: 100%;
		border-left: 1px solid var(--banto-border);
	}

	.panel--modal {
		max-height: calc(100vh - 3rem);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
	}

	.header {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--banto-border);
	}

	.header h3 {
		margin: 0;
		font-size: 1rem;
	}

	/* Keeps the × at the right edge when there is no title. */
	.close {
		margin-left: auto;
		display: inline-flex;
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.25rem 1.5rem;
	}
</style>
