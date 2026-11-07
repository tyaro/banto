/**
 * Rendered label font size for the `core/labels.ts` width estimates
 * (theme-dimension-tokens.md D9-b). The label CSS uses the rem-based type
 * tokens (`--banto-font-size-xs/sm/md`), so the real size follows the root
 * font size and any token override; the margin math therefore reads the
 * computed `font-size` of a rendered label instead of assuming a constant.
 *
 * Where nothing can be read (SSR, node unit tests, a detached element) the
 * estimate keeps the pre-token tick font, `DEFAULT_LABEL_FONT_SIZE` (11px).
 */
import type { Attachment } from 'svelte/attachments';

/** Fallback (px) when the computed size is unavailable - the pre-token SVG tick font. */
export const DEFAULT_LABEL_FONT_SIZE = 11;

type GetComputedStyle = (element: Element) => { fontSize: string };

/** Computed `font-size` of `element` in px, or `fallback` when it can't be read. */
export function readFontSizePx(
	element: Element | null | undefined,
	fallback = DEFAULT_LABEL_FONT_SIZE,
	getStyle: GetComputedStyle | undefined = typeof getComputedStyle === 'function'
		? getComputedStyle
		: undefined
): number {
	if (!element || !getStyle) return fallback;
	const px = Number.parseFloat(getStyle(element).fontSize);
	return Number.isFinite(px) && px > 0 ? px : fallback;
}

/**
 * Attachment for ONE representative label `<text>` (all labels of a class
 * share the size): reports its computed font size on mount and again whenever
 * its box resizes - a root font-size change or a token override at runtime
 * resizes the glyphs, so the margins re-estimate without a remount.
 *
 * No feedback loop: the margin only moves the label (`x`), it never changes
 * its font size or box size, and the callback is expected to store a
 * primitive `$state` (re-assigning the same number is a no-op). The first
 * read runs synchronously in the attach effect, i.e. before the first paint,
 * so the 11px fallback layout is never shown when the real size differs.
 * The caller's state starts at `DEFAULT_LABEL_FONT_SIZE`, which is also what
 * SSR and node tests (no attach) keep.
 */
export function trackFontSize(onChange: (px: number) => void): Attachment<Element> {
	return (element) => {
		// An unreadable size (e.g. a transiently detached node) keeps the last
		// reported value instead of snapping back to the 11px fallback.
		const read = () => {
			const px = readFontSizePx(element, Number.NaN);
			if (!Number.isNaN(px)) onChange(px);
		};
		read();
		if (typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver(read);
		observer.observe(element);
		return () => observer.disconnect();
	};
}
