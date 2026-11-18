// @vitest-environment jsdom
/**
 * computeAnchoredPosition horizontal clamp (#668). jsdom has no layout, so
 * the rects and the viewport width are stubbed.
 */
import { describe, expect, it } from 'vitest';
import { ANCHORED_POPOVER_GAP, computeAnchoredPosition } from '../src/anchoredPopover';

const GAP = ANCHORED_POPOVER_GAP;

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON() {}
	} as DOMRect;
}

function place(
	viewportWidth: number,
	anchor: DOMRect,
	popoverWidth: number,
	placement: 'bottom-start' | 'bottom-end' | 'bottom-center'
) {
	Object.defineProperty(document.documentElement, 'clientWidth', {
		configurable: true,
		value: viewportWidth
	});
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
	const anchorEl = document.createElement('button');
	anchorEl.getBoundingClientRect = () => anchor;
	const popover = document.createElement('div');
	popover.getBoundingClientRect = () => rect(0, 0, popoverWidth, 100);
	return computeAnchoredPosition(anchorEl, popover, placement);
}

describe('computeAnchoredPosition horizontal clamp', () => {
	it('keeps the left edge at GAP when the popover is wider than the viewport', () => {
		for (const placement of ['bottom-start', 'bottom-end', 'bottom-center'] as const) {
			const { left } = place(200, rect(150, 10, 40, 20), 204, placement);
			expect(left).toBe(GAP);
		}
	});

	it('clamps the right edge to the viewport when the popover would overflow it', () => {
		const { left } = place(400, rect(380, 10, 10, 20), 200, 'bottom-start');
		expect(left).toBe(400 - 200 - GAP);
	});

	it('clamps the left edge for bottom-end near the left of the viewport', () => {
		const { left } = place(400, rect(0, 10, 20, 20), 200, 'bottom-end');
		expect(left).toBe(GAP);
	});

	it('does not move a popover that already fits (bottom-start)', () => {
		const { left } = place(800, rect(100, 10, 40, 20), 200, 'bottom-start');
		expect(left).toBe(100);
	});

	it('centres under the anchor for bottom-center', () => {
		const { left } = place(800, rect(300, 10, 100, 20), 200, 'bottom-center');
		expect(left).toBe(250);
	});
});
