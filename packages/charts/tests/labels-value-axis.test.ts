import { describe, expect, it } from 'vitest';
import {
	estimateLabelWidth,
	leftMarginForFirstLabel,
	leftMarginFor,
	truncateLabel,
	originLabelsCollide,
	clipsLeft,
	placeEdgeLabel,
	dropCollidingPlaced,
	thinKeepEnd,
	thinValueLabels,
	thinVerticalLabels
} from '../src/core/labels';
import { dropCollidingTicks, thinCenteredTicks } from '../src/core/ticks-time';

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

describe('placeEdgeLabel keeps both ends inside the svg', () => {
	const extent = (p: ReturnType<typeof placeEdgeLabel>, x: number) =>
		p.anchor === 'start'
			? [x, x + p.width]
			: p.anchor === 'end'
				? [x - p.width, x]
				: [x - p.width / 2, x + p.width / 2];

	it('a label that fits stays centred and unchanged', () => {
		const p = placeEdgeLabel('2024-01', 48, 11, 400);
		expect(p).toMatchObject({ anchor: 'middle', text: '2024-01', full: '2024-01' });
	});

	it('100px svg, 22px, x=40: start-anchored and cut so the right end is inside', () => {
		const p = placeEdgeLabel('2024-01', 40, 22, 100);
		expect(estimateLabelWidth('2024-01', 22)).toBeGreaterThan(60);
		expect(p.anchor).toBe('start');
		expect(p.text).not.toBe('2024-01');
		expect(p.text.endsWith('…')).toBe(true);
		expect(p.full).toBe('2024-01');
		const [l, r] = extent(p, 40);
		expect(l).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(100);
		expect(p.width).toBeCloseTo(estimateLabelWidth(p.text, 22), 6);
	});

	it('100px svg, 22px, x=60, 7 ASCII chars: crosses the right edge and is too wide to end-anchor -> cut, inside', () => {
		const label = 'ABCDEFG';
		const w = estimateLabelWidth(label, 22);
		expect(60 - w / 2).toBeLessThan(0 + w); // sanity: wide label
		expect(60 + w / 2).toBeGreaterThan(100);
		const p = placeEdgeLabel(label, 60, 22, 100);
		expect(p.anchor).toBe('end');
		expect(p.text.endsWith('…')).toBe(true);
		expect(p.full).toBe(label);
		const [l, r] = extent(p, 60);
		expect(l).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(100);
	});

	it('crossing only the right edge: end-anchored, whole text, inside', () => {
		const label = 'ABCD';
		const w = estimateLabelWidth(label, 22);
		expect(60 - w / 2).toBeGreaterThanOrEqual(0);
		expect(60 + w / 2).toBeGreaterThan(80);
		const p = placeEdgeLabel(label, 60, 22, 80);
		expect(p).toMatchObject({ anchor: 'end', text: label, full: label });
		expect(p.centre).toBeCloseTo(60 - p.width / 2, 6);
		expect(extent(p, 60)[1]).toBeLessThanOrEqual(80);
	});

	it('a last label wider than the room on its left is cut with an ellipsis (end-anchored)', () => {
		const p = placeEdgeLabel('2024-01-01 00:00', 90, 22, 100, true);
		expect(p.anchor).toBe('end');
		expect(p.text.endsWith('…')).toBe(true);
		expect(p.full).toBe('2024-01-01 00:00');
		const [l, r] = extent(p, 90);
		expect(l).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(100);
	});

	it('forceEnd keeps a fitting last label whole, right-aligned at x', () => {
		const p = placeEdgeLabel('2024-01', 190, 11, 200, true);
		expect(p).toMatchObject({ anchor: 'end', text: '2024-01' });
		expect(p.centre).toBeCloseTo(190 - p.width / 2, 6);
	});

	it('horizontal value axis: first tick is start-anchored, last tick end-anchored, both inside', () => {
		const width = 100;
		const fs = 22;
		const first = placeEdgeLabel('10,000', 4, fs, width);
		const last = placeEdgeLabel('10,000', 96, fs, width);
		expect(first.anchor).toBe('start');
		expect(last.anchor).toBe('end');
		expect(extent(first, 4)[0]).toBeGreaterThanOrEqual(0);
		expect(extent(last, 96)[1]).toBeLessThanOrEqual(width);
		expect(extent(first, 4)[1]).toBeLessThanOrEqual(width);
		expect(extent(last, 96)[0]).toBeGreaterThanOrEqual(0);
	});

	it('start-anchored but fitting: full text, extent inside, centre reflects the shift', () => {
		const p = placeEdgeLabel('2024-01', 20, 11, 200);
		expect(p.anchor).toBe('start');
		expect(p.text).toBe('2024-01');
		expect(p.centre).toBeCloseTo(20 + p.width / 2, 6);
	});

	it('thinning with the real extent does not leave the shifted first label overlapping the next', () => {
		const first = placeEdgeLabel('2024-01', 10, 11, 300);
		const labels = [first.text, '2024-02'];
		const xs = [first.centre, 40];
		const kept = thinValueLabels(labels, xs, { fontSize: 11 });
		if (kept.length === 2) {
			const r0 = first.centre + first.width / 2;
			const l1 = 40 - estimateLabelWidth('2024-02', 11) / 2;
			expect(r0).toBeLessThanOrEqual(l1);
		}
	});
});

// #1056 (review): the origin collision is judged on the x label that survives thinning.
describe('origin collision uses the surviving first x label', () => {
	const fontSize = 28;
	const svgWidth = 240;
	const innerLeft = 100;
	const ticks = [1000, 1200, 1400, 1600, 1800, 2000];
	const xs = ticks.map((t) => innerLeft + ((t - 1000) / 1000) * (svgWidth - innerLeft - 8));
	const place = ticks.map((t, i) =>
		placeEdgeLabel(`¥${t.toLocaleString('en-US')}`, xs[i], fontSize, svgWidth)
	);
	const kept = thinValueLabels(
		place.map((p) => p.text),
		place.map((p) => p.centre),
		{ fontSize }
	);
	const collides = (yLabel: string) => {
		if (kept.length === 0) return false;
		const f = Math.min(...kept);
		return originLabelsCollide(place[f].text, yLabel, {
			fontSize,
			xBaseline: 16,
			xAnchor: place[f].anchor,
			xOffset: xs[f] - innerLeft
		});
	};

	it('thinning drops the first label in this geometry', () => {
		expect(kept).not.toContain(0);
	});

	it('keeps the y "100" when the first x label was thinned away', () => {
		// the old judgement (first candidate, before thinning) hid it
		expect(
			originLabelsCollide(place[0].text, '100', {
				fontSize,
				xBaseline: 16,
				xAnchor: place[0].anchor,
				xOffset: xs[0] - innerLeft
			})
		).toBe(true);
		expect(collides('100')).toBe(false);
	});

	it('still hides y when the surviving first label really overlaps', () => {
		expect(
			originLabelsCollide('¥1,000', '100', { fontSize: 22, xBaseline: 16, xAnchor: 'middle' })
		).toBe(true);
		expect(
			originLabelsCollide('¥1,000', '100', {
				fontSize: 22,
				xBaseline: 16,
				xAnchor: 'end',
				xOffset: 0
			})
		).toBe(true);
	});
});

describe('dropCollidingPlaced (x labels of a line / stacked-area axis)', () => {
	// 284px svg, 2024-01..2024-03 at 13px, the last label right-aligned on its x (forceEnd).
	const xs = [40, 150, 260];
	const labels = ['2024-01', '2024-02', '2024-03'];
	const places = xs.map((x, i) => placeEdgeLabel(labels[i], x, 13, 284, i === 2));

	it('keeps all three when the old anchor-based check (main) keeps them', () => {
		const widths = labels.map((l) => estimateLabelWidth(l, 13));
		const main = dropCollidingTicks([0, 1, 2], xs, widths);
		expect(main).toEqual([0, 1, 2]);
		expect(dropCollidingPlaced([0, 1, 2], places)).toEqual(main);
	});

	it('does not drop the middle label for a last-label box counted twice', () => {
		// feeding the drawn centre as the last anchor subtracts half the width twice
		const doubled = dropCollidingTicks(
			[0, 1, 2],
			places.map((p) => p.centre),
			places.map((p) => p.width)
		);
		expect(doubled).not.toEqual([0, 1, 2]);
		expect(dropCollidingPlaced([0, 1, 2], places)).toEqual([0, 1, 2]);
	});

	it('still drops a label that really collides', () => {
		const tight = [40, 60, 260].map((x, i) => placeEdgeLabel(labels[i], x, 13, 284, i === 2));
		expect(dropCollidingPlaced([0, 1, 2], tight)).toEqual([1, 2]);
	});
});

describe("horizontal bar category labels at the standard font keep main's truncation", () => {
	// main: left = leftMarginFor(categories); the PR takes max() with the first value tick's half width.
	const names = ['オレンジジュース', 'スポーツドリンク', 'アップルジュース'];
	for (const total of [200, 240, 284, 320, 400]) {
		it(`plot ${total}px`, () => {
			const base = leftMarginFor(names, { fontSize: 11, totalWidth: total });
			const left = Math.max(
				base,
				leftMarginForFirstLabel('0件', { fontSize: 11, totalWidth: total })
			);
			expect(left).toBe(base);
			for (const n of names) {
				expect(truncateLabel(n, left - 8, 11)).toBe(truncateLabel(n, base - 8, 11));
			}
		});
	}
});
