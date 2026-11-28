import { describe, expect, it } from 'vitest';
import {
	estimateLabelWidth,
	leftMarginForFirstLabel,
	originLabelsCollide,
	thinValueLabels
} from '../src/core/labels';

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
