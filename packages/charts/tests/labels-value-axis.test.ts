import { describe, expect, it } from 'vitest';
import {
	estimateLabelWidth,
	leftMarginForFirstLabel,
	originLabelsCollide,
	clipsLeft,
	thinKeepEnd,
	thinValueLabels,
	thinVerticalLabels
} from '../src/core/labels';
import { thinCenteredTicks } from '../src/core/ticks-time';

// #1056: text 200% (11px -> 22px labels) on the value axes.
describe('thinValueLabels', () => {
	const labels = ['¥50', '¥100', '¥150', '¥200', '¥250'];
	// Scatter x axis of the dashboard (211px wide svg, plot ~ 130px).
	const xs = [48, 80, 112, 144, 176];

	it('keeps every label at the standard font', () => {
		expect(thinValueLabels(labels, xs, { fontSize: 11 })).toEqual([0, 1, 2, 3, 4]);
	});

	it('thins at 200% so the kept labels do not overlap, keeping first and last', () => {
		const kept = thinValueLabels(labels, xs, { fontSize: 22 });
		expect(kept.length).toBeLessThan(labels.length);
		expect(kept[0]).toBe(0);
		for (let k = 1; k < kept.length; k++) {
			const a = kept[k - 1];
			const b = kept[k];
			const right = xs[a] + estimateLabelWidth(labels[a], 22) / 2;
			const left = xs[b] - estimateLabelWidth(labels[b], 22) / 2;
			expect(right).toBeLessThanOrEqual(left);
		}
	});
});

describe('leftMarginForFirstLabel', () => {
	it('is within the default 48px margin at the standard font (layout unchanged)', () => {
		expect(leftMarginForFirstLabel('2024-01', { fontSize: 11 })).toBeLessThanOrEqual(48);
		expect(leftMarginForFirstLabel('10,000', { fontSize: 11 })).toBeLessThanOrEqual(48);
	});

	it('exceeds 48px at 200% for "2024-01" and covers half the label', () => {
		const m = leftMarginForFirstLabel('2024-01', { fontSize: 22 });
		expect(m).toBeGreaterThan(48);
		expect(m).toBeGreaterThanOrEqual(estimateLabelWidth('2024-01', 22) / 2);
	});

	it('is capped at 40% of a narrow container', () => {
		expect(leftMarginForFirstLabel('2024-01', { fontSize: 22, totalWidth: 100 })).toBe(40);
	});
});

describe('originLabelsCollide', () => {
	it('does not drop the origin y label at the standard font', () => {
		expect(originLabelsCollide('2024-01', '0', { fontSize: 11, xBaseline: 18 })).toBe(false);
		expect(originLabelsCollide('¥100', '0', { fontSize: 11, xBaseline: 16 })).toBe(false);
	});

	it('drops it at 200% when the first x label spans the origin', () => {
		expect(originLabelsCollide('2024-01', '0', { fontSize: 22, xBaseline: 18 })).toBe(true);
		expect(originLabelsCollide('¥100', '0', { fontSize: 22, xBaseline: 16 })).toBe(true);
	});

	it('keeps it when the x label sits clear of the y label (start-anchored)', () => {
		expect(
			originLabelsCollide('2024-01', '0', { fontSize: 22, xBaseline: 18, xAnchor: 'start' })
		).toBe(false);
	});
});

// A low pane: 12 categories in ~150px of plot (step 12.5px) at 12px labels.
describe('vertical category labels of a horizontal bar chart', () => {
	it('are thinned by their height, keeping the first and last, never overlapping', () => {
		const ys = Array.from({ length: 12 }, (_, i) => 14 + i * 12.5);
		const kept = thinCenteredTicks(
			ys,
			ys.map(() => 12 * 1.1),
			0
		);
		expect(kept.length).toBeLessThan(12);
		expect(kept[0]).toBe(0);
		expect(kept[kept.length - 1]).toBe(11);
		for (let k = 1; k < kept.length; k++)
			expect(ys[kept[k]] - ys[kept[k - 1]]).toBeGreaterThanOrEqual(13.2);
	});

	it('keeps every label when the pane is high enough (layout unchanged)', () => {
		const ys = Array.from({ length: 12 }, (_, i) => 20 + i * 24);
		expect(
			thinCenteredTicks(
				ys,
				ys.map(() => 12.1),
				0
			)
		).toHaveLength(12);
	});
});

// A low pane at 200% text: 5 ticks (0..40000) in ~60px of plot, 24px labels.
describe('thinVerticalLabels', () => {
	it('thins crowded y labels, keeping the origin and the top, never overlapping', () => {
		const ys = [100, 80, 60, 40, 20]; // descending: ticks ascend in value
		const kept = thinVerticalLabels(ys, 24);
		expect(kept.length).toBeLessThan(5);
		expect(kept[0]).toBe(0);
		expect(kept[kept.length - 1]).toBe(4);
		for (let k = 1; k < kept.length; k++)
			expect(ys[kept[k - 1]] - ys[kept[k]]).toBeGreaterThanOrEqual(24 * 1.1);
	});

	it('keeps every label when the pane is high enough (layout unchanged)', () => {
		expect(thinVerticalLabels([200, 150, 100, 50, 0], 11)).toEqual([0, 1, 2, 3, 4]);
		expect(thinVerticalLabels([300, 225, 150, 75, 0], 22)).toEqual([0, 1, 2, 3, 4]);
	});

	it('keeps a single tick', () => {
		expect(thinVerticalLabels([50], 22)).toEqual([0]);
	});
});

describe('ends too close for both labels (the last one wins)', () => {
	it('thinKeepEnd keeps the last tick, not the first, when the two ends collide', () => {
		// 2 categories 10px apart, labels 24px high: cannot both be drawn.
		expect(thinKeepEnd([10, 20], [24, 24], 0)).toEqual([1]);
		expect(thinCenteredTicks([10, 20], [24, 24], 0)).toEqual([0]);
	});

	it('thinKeepEnd keeps both ends while they fit', () => {
		expect(thinKeepEnd([10, 60], [24, 24], 0)).toEqual([0, 1]);
		expect(thinKeepEnd([10], [24], 0)).toEqual([0]);
	});

	it('thinValueLabels keeps the last (upper bound) on a plot too narrow for two', () => {
		expect(thinValueLabels(['100', '500'], [10, 20], { fontSize: 22 })).toEqual([1]);
	});

	it('thinVerticalLabels keeps the top tick on a pane too low for two', () => {
		expect(thinVerticalLabels([30, 20], 22)).toEqual([1]);
	});
});

describe('first x label at a capped left margin', () => {
	it('is clipped when centred on the edge with the 40%-capped margin (100px, 22px)', () => {
		const margin = leftMarginForFirstLabel('2024-01', { fontSize: 22, totalWidth: 100 });
		expect(margin).toBe(40);
		expect(clipsLeft('2024-01', margin, 22)).toBe(true);
	});

	it('anchored start it stays inside the svg; a label that fits is not flagged', () => {
		const margin = leftMarginForFirstLabel('2024-01', { fontSize: 22, totalWidth: 100 });
		// start anchor: the label spans margin .. margin + width, within the 100px svg's left edge.
		expect(margin).toBeGreaterThanOrEqual(0);
		expect(clipsLeft('2024-01', 80, 22)).toBe(false);
		expect(clipsLeft('2024-01', 48, 11)).toBe(false);
	});
});
