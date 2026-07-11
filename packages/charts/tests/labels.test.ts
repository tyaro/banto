import { describe, expect, it } from 'vitest';
import { estimateLabelWidth, leftMarginFor, rightMarginForLastTick } from '../src/core/labels';

describe('estimateLabelWidth', () => {
	it('estimates CJK characters as ~13px each at the 11px tick font', () => {
		// 8 fullwidth kana - the widest real category in the demo data
		// (アップルジュース) must come out around 8 * 13px.
		const width = estimateLabelWidth('アップルジュース', 11);
		expect(width).toBeGreaterThan(96);
		expect(width).toBeLessThan(112);
	});

	it('estimates ASCII narrower than CJK', () => {
		expect(estimateLabelWidth('12345678', 11)).toBeLessThan(
			estimateLabelWidth('アップルジュース', 11)
		);
	});

	it('scales with font size', () => {
		expect(estimateLabelWidth('あ', 22)).toBeCloseTo(estimateLabelWidth('あ', 11) * 2);
	});

	it('returns 0 for empty text', () => {
		expect(estimateLabelWidth('', 11)).toBe(0);
	});
});

describe('leftMarginFor', () => {
	it('fits the longest label plus the gap', () => {
		const margin = leftMarginFor(['緑茶', 'アップルジュース'], { fontSize: 11, gap: 8 });
		expect(margin).toBeGreaterThanOrEqual(
			Math.round(estimateLabelWidth('アップルジュース', 11) + 8)
		);
		expect(margin).toBeLessThanOrEqual(140);
	});

	it('clamps to the minimum for short labels', () => {
		expect(leftMarginFor(['A'], { min: 48 })).toBe(48);
	});

	it('clamps to the maximum for pathological labels', () => {
		expect(leftMarginFor(['あ'.repeat(50)], { max: 140 })).toBe(140);
	});

	it('returns the minimum for an empty label list', () => {
		expect(leftMarginFor([])).toBe(48);
	});
});

describe('rightMarginForLastTick', () => {
	it('reserves half the (middle-anchored) label width plus pad', () => {
		const margin = rightMarginForLastTick('1,000,000', { fontSize: 11, gap: 4 });
		expect(margin).toBeGreaterThanOrEqual(Math.round(estimateLabelWidth('1,000,000', 11) / 2));
	});

	it('never shrinks below the minimum', () => {
		expect(rightMarginForLastTick('1', { min: 16 })).toBe(16);
	});
});
