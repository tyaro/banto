/**
 * DOM glue for selectable chart marks (roving tabindex). The decision of
 * where to move lives in `core/mark-nav.ts` (pure); this only reads the key
 * event, moves focus, and reports the new tab stop.
 */
import { isMarkActivateKey, nextMarkIndex } from '../core/mark-nav';

/**
 * Attachment cleanup helper: calls `forget` once the mark element has really
 * left the document. A removed element never fires `blur` / `pointerleave`, so
 * the chart must drop its focus / pointer state itself. The `isConnected`
 * check (after a microtask) keeps an attachment that merely re-runs on a
 * re-render from clearing state of a mark that is still there.
 */
export function onMarkDetached(node: Element, forget: () => void): () => void {
	return () => {
		queueMicrotask(() => {
			if (!node.isConnected) forget();
		});
	};
}

/** Attribute that carries a mark's position in the linear mark order (the charts write it literally as `data-mark-index`). */
const MARK_INDEX_ATTR = 'data-mark-index';

/**
 * Handle a keydown on mark number `index` of `count`. Enter / Space call
 * `activate`; arrows / Home / End call `setTabStop(next)` and focus the
 * target mark (found inside the same `<svg>` by its index attribute).
 */
export function handleMarkKeydown(
	event: KeyboardEvent,
	index: number,
	count: number,
	activate: () => void,
	setTabStop: (next: number) => void
): void {
	if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
	if (isMarkActivateKey(event.key)) {
		event.preventDefault();
		activate();
		return;
	}
	const next = nextMarkIndex(event.key, index, count);
	if (next === null) return;
	event.preventDefault();
	setTabStop(next);
	const svg = (event.currentTarget as Element).closest('svg');
	svg?.querySelector<SVGElement>(`[${MARK_INDEX_ATTR}="${next}"]`)?.focus();
}
