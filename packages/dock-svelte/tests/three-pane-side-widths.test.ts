// Issue #892: `ThreePaneDock`'s `sideWidthUnit="px"` - the pure half (`threePaneSideShares`,
// `fitThreePaneSideWidths`, `followThreePaneSideWidths`).
//
// Properties (fast-check, ADR-0033): the shares are a valid row at any width; with room the sides
// have their px exactly; without, the centre keeps its minimum and no side goes below its own; the
// px kept do not drift however the width goes back and forth (the shares at a width depend on the
// px and the width only). And the saved value is the same version-4 layout of shares.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { validateDockLayout } from '../src/core/validate';
import {
	fitThreePaneSideWidths,
	followThreePaneSideWidths,
	THREE_PANE_DEFAULTS,
	threePaneDockLayout,
	threePaneSavedLayout,
	threePaneSideShares
} from '../src/threePane';
import type { DockLayout, DockSplitNode } from '../src/types';

const env =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env.DOCK_PROPERTY_SEED ?? 892);
const RUNS = Number(env.DOCK_PROPERTY_RUNS ?? 0);
if (RUNS) vi.setConfig({ testTimeout: 600_000 });
const params = (numRuns: number): fc.Parameters<unknown> => ({
	seed: SEED,
	numRuns: RUNS || numRuns
});

const { centerMinWidth, sideMinWidth } = THREE_PANE_DEFAULTS;
const EPS = 1e-6;

/** A row: 1-4 sides around the centre (px 1-900), the centre at `centre`. */
const rowRecipe = fc
	.array(fc.double({ min: 1, max: 900, noNaN: true }), { minLength: 1, maxLength: 4 })
	.chain((sides) =>
		fc.integer({ min: 0, max: sides.length }).map((centre) => {
			const px = [...sides];
			px.splice(centre, 0, 0);
			return { px, centre };
		})
	);
const widthRecipe = fc.double({ min: 1, max: 4000, noNaN: true });

const sideSum = (px: readonly number[], centre: number, f = (p: number) => p) =>
	px.reduce((sum, p, i) => (i === centre ? sum : sum + f(p)), 0);

const panes = { left: { title: 'L' }, center: { title: 'C' }, right: { title: 'R' } };
const rootOf = (layout: DockLayout) => layout.docked as DockSplitNode;
const pxOf = (layout: DockLayout, width: number) => rootOf(layout).sizes.map((s) => s * width);

describe('threePaneSideShares (#892)', () => {
	it('is a valid row at any width: positive shares summing to 1, the centre at least the dock minimum', () => {
		fc.assert(
			fc.property(rowRecipe, widthRecipe, ({ px, centre }, width) => {
				const shares = threePaneSideShares(px, centre, width);
				expect(shares).toHaveLength(px.length);
				for (const s of shares) {
					expect(Number.isFinite(s)).toBe(true);
					expect(s).toBeGreaterThan(0);
				}
				expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(EPS);
				expect(shares[centre]).toBeGreaterThanOrEqual(0.1 - EPS);
			}),
			params(500)
		);
	});

	it('gives every side its px exactly when the width has room for them and the centre minimum', () => {
		fc.assert(
			fc.property(rowRecipe, fc.double({ min: 0, max: 3000, noNaN: true }), (row, extra) => {
				const width = sideSum(row.px, row.centre) + centerMinWidth + extra;
				const shares = threePaneSideShares(row.px, row.centre, width);
				row.px.forEach((p, i) => {
					if (i !== row.centre) expect(Math.abs(shares[i] * width - p)).toBeLessThan(EPS);
				});
				expect(shares[row.centre] * width).toBeGreaterThanOrEqual(centerMinWidth - EPS);
			}),
			params(500)
		);
	});

	it('keeps the centre minimum and each side at least min(px, sideMinWidth) whenever those fit', () => {
		fc.assert(
			fc.property(rowRecipe, widthRecipe, ({ px, centre }, width) => {
				const floors = sideSum(px, centre, (p) => Math.min(p, sideMinWidth));
				fc.pre(width >= floors + centerMinWidth);
				const shares = threePaneSideShares(px, centre, width);
				expect(shares[centre] * width).toBeGreaterThanOrEqual(centerMinWidth - EPS);
				px.forEach((p, i) => {
					if (i === centre) return;
					expect(shares[i] * width).toBeGreaterThanOrEqual(Math.min(p, sideMinWidth) - EPS);
					// Never wider than asked.
					expect(shares[i] * width).toBeLessThanOrEqual(p + EPS);
				});
			}),
			params(500)
		);
	});
});

describe('fitThreePaneSideWidths / followThreePaneSideWidths (#892)', () => {
	const start = (width: number, leftWidth: number, rightWidth: number) =>
		threePaneDockLayout({ hostWidth: width, leftWidth, rightWidth, panels: panes });

	it('keeps the px of the sides however the width goes back and forth (no drift)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 120, max: 500 }),
				fc.integer({ min: 120, max: 500 }),
				fc.array(fc.integer({ min: 901, max: 3840 }), { minLength: 1, maxLength: 12 }),
				(leftWidth, rightWidth, widths) => {
					const first = Math.max(1280, leftWidth + rightWidth + centerMinWidth);
					let layout = start(first, leftWidth, rightWidth);
					let seen: DockLayout | null = null;
					let kept: Map<string, number> | null = null;
					let prevWidth = first;
					for (const width of [first, ...widths, first]) {
						const followed = followThreePaneSideWidths(seen, kept, layout, prevWidth);
						expect(followed.resized).toBe(false);
						kept = followed.widths;
						expect(kept.get('left')).toBeCloseTo(leftWidth, 6);
						expect(kept.get('right')).toBeCloseTo(rightWidth, 6);
						layout = fitThreePaneSideWidths(layout, kept, width);
						expect(validateDockLayout(layout).ok).toBe(true);
						seen = layout;
						prevWidth = width;
						if (width >= leftWidth + rightWidth + centerMinWidth) {
							const [l, , r] = pxOf(layout, width);
							expect(l).toBeCloseTo(leftWidth, 6);
							expect(r).toBeCloseTo(rightWidth, 6);
						}
					}
					// Back at the first width: the layout it started with.
					rootOf(layout).sizes.forEach((s, i) =>
						expect(s).toBeCloseTo(rootOf(start(first, leftWidth, rightWidth)).sizes[i], 9)
					);
				}
			),
			params(200)
		);
	});

	it('takes a resized side at its new px, and keeps the other', () => {
		const layout = start(1280, 280, 360);
		const followed = followThreePaneSideWidths(null, null, layout, 1280);
		const root = rootOf(layout);
		const sizes = [...root.sizes];
		sizes[0] += 100 / 1280;
		sizes[1] -= 100 / 1280;
		const dragged: DockLayout = { ...layout, docked: { ...root, sizes } };
		const after = followThreePaneSideWidths(layout, followed.widths, dragged, 1280);
		expect(after.resized).toBe(true);
		expect(after.widths.get('left')).toBeCloseTo(380, 6);
		expect(after.widths.get('right')).toBeCloseTo(360, 6);
		// A fit at the same width leaves the user's shares alone.
		expect(fitThreePaneSideWidths(dragged, after.widths, 1280)).toBe(dragged);
	});

	it('keeps a side by id across a structure change (a pane hidden and shown again)', () => {
		const layout = start(1280, 280, 360);
		const kept = followThreePaneSideWidths(null, null, layout, 1280).widths;
		// Left hidden: the dock gives its share to the others in their ratio.
		const root = rootOf(layout);
		const without: DockLayout = {
			...layout,
			docked: {
				...root,
				children: root.children.slice(1),
				sizes: [root.sizes[1] / (1 - root.sizes[0]), root.sizes[2] / (1 - root.sizes[0])]
			}
		};
		const followed = followThreePaneSideWidths(layout, kept, without, 1280);
		expect(followed.resized).toBe(false);
		const fitted = fitThreePaneSideWidths(without, followed.widths, 1280);
		expect(rootOf(fitted).sizes[1] * 1280).toBeCloseTo(360, 6);
		// Shown again at another width: the left comes back at its px.
		const back = followThreePaneSideWidths(fitted, followed.widths, layout, 1600);
		expect(back.widths.get('left')).toBeCloseTo(280, 6);
		const [l, , r] = pxOf(fitThreePaneSideWidths(layout, back.widths, 1600), 1600);
		expect(l).toBeCloseTo(280, 6);
		expect(r).toBeCloseTo(360, 6);
	});

	it('gives a side seen for the first time its fallback px', () => {
		const onlyCentreRight = threePaneDockLayout({
			hostWidth: 1280,
			panels: panes,
			leftOpen: false
		});
		const kept = followThreePaneSideWidths(null, null, onlyCentreRight, 1280).widths;
		expect(kept.has('left')).toBe(false);
		const shown = start(1280, 500, 360);
		const followed = followThreePaneSideWidths(onlyCentreRight, kept, shown, 1280, (id) =>
			id === 'left' ? 280 : undefined
		);
		expect(followed.widths.get('left')).toBe(280);
	});

	it('leaves a layout without a root row holding the centre alone, and the saved value as version 4 shares', () => {
		const alone: DockLayout = {
			version: 4,
			floating: [],
			docked: { type: 'panel', id: 'center', title: 'C' }
		};
		expect(fitThreePaneSideWidths(alone, new Map(), 1000)).toBe(alone);
		const fitted = fitThreePaneSideWidths(start(1280, 280, 360), new Map([['left', 400]]), 2000);
		const saved = threePaneSavedLayout(fitted);
		expect(saved.layout.version).toBe(4);
		expect(Object.keys(saved).sort()).toEqual(['layout', 'panels', 'schema']);
		expect(Object.keys(rootOf(saved.layout)).sort()).toEqual(
			Object.keys(rootOf(start(1280, 280, 360))).sort()
		);
	});
});
