import { describe, expect, it } from 'vitest';
import { estimateLabelWidth } from '../src/core/labels';
import {
	GAUGE_END_DEG,
	GAUGE_START_DEG,
	gaugeAngle,
	gaugeColorVar,
	gaugeLayout,
	gaugeRatio
} from '../src/core/gauge';

describe('gaugeRatio', () => {
	it('maps min to 0 and max to 1', () => {
		expect(gaugeRatio(0, 0, 100)).toBe(0);
		expect(gaugeRatio(100, 0, 100)).toBe(1);
	});

	it('is linear in between', () => {
		expect(gaugeRatio(25, 0, 100)).toBeCloseTo(0.25);
		expect(gaugeRatio(75, 0, 100)).toBeCloseTo(0.75);
	});

	it('clamps a value below min to 0', () => {
		expect(gaugeRatio(-50, 0, 100)).toBe(0);
	});

	it('clamps a value above max to 1', () => {
		expect(gaugeRatio(500, 0, 100)).toBe(1);
	});

	it('returns 0 for a degenerate/inverted range (max <= min) instead of dividing by zero', () => {
		expect(gaugeRatio(5, 10, 10)).toBe(0);
		expect(gaugeRatio(5, 10, 0)).toBe(0);
	});

	it('treats a non-finite value as the range floor rather than propagating NaN', () => {
		expect(gaugeRatio(NaN, 0, 100)).toBe(0);
	});
});

describe('gaugeAngle', () => {
	it('starts at GAUGE_START_DEG (135) when value <= min', () => {
		expect(gaugeAngle(0, 0, 100)).toBe(GAUGE_START_DEG);
		expect(gaugeAngle(-10, 0, 100)).toBe(GAUGE_START_DEG);
	});

	it('ends at GAUGE_END_DEG (405) when value >= max', () => {
		expect(gaugeAngle(100, 0, 100)).toBe(GAUGE_END_DEG);
		expect(gaugeAngle(200, 0, 100)).toBe(GAUGE_END_DEG);
	});

	it('is the midpoint (270) for the midpoint value', () => {
		expect(gaugeAngle(50, 0, 100)).toBeCloseTo(270);
	});
});

describe('gaugeColorVar', () => {
	it('defaults to the primary theme color with no thresholds', () => {
		expect(gaugeColorVar(999)).toBe('var(--banto-primary)');
	});

	it('stays primary below the warning threshold', () => {
		expect(gaugeColorVar(49, { warning: 50, danger: 90 })).toBe('var(--banto-primary)');
	});

	it('switches to warning exactly AT the warning threshold ("crossed above")', () => {
		expect(gaugeColorVar(50, { warning: 50, danger: 90 })).toBe('var(--banto-warning)');
	});

	it('switches to danger exactly at the danger threshold', () => {
		expect(gaugeColorVar(90, { warning: 50, danger: 90 })).toBe('var(--banto-danger)');
	});

	it('danger wins precedence when both thresholds are crossed', () => {
		expect(gaugeColorVar(95, { warning: 50, danger: 90 })).toBe('var(--banto-danger)');
	});

	it('lower thresholds match on value <= threshold (warningLow / dangerLow)', () => {
		const th = { warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(21, th)).toBe('var(--banto-primary)');
		expect(gaugeColorVar(20, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(11, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(10, th)).toBe('var(--banto-danger)');
		expect(gaugeColorVar(-5, th)).toBe('var(--banto-danger)');
	});

	it('combines lower and upper thresholds; the upper ones are unchanged', () => {
		const th = { warning: 80, danger: 90, warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(50, th)).toBe('var(--banto-primary)');
		expect(gaugeColorVar(85, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(95, th)).toBe('var(--banto-danger)');
		expect(gaugeColorVar(15, th)).toBe('var(--banto-warning)');
	});

	it('a non-finite value (NaN, i.e. no reading) stays primary under any thresholds', () => {
		const th = { warning: 80, danger: 90, warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(NaN, th)).toBe('var(--banto-primary)');
	});

	it('no value (null → NaN) yields angle at the range floor', () => {
		expect(gaugeAngle(NaN, 0, 100)).toBe(GAUGE_START_DEG);
	});

	it('supports a warning-only threshold set (no danger)', () => {
		expect(gaugeColorVar(1000, { warning: 50 })).toBe('var(--banto-warning)');
	});
});

describe('gaugeLayout (range labels)', () => {
	const base = {
		sidePad: 16,
		topPad: 16,
		bottomPad: 30,
		trackWidth: 14,
		verticalFactor: 1 + Math.sin(Math.PI / 4)
	};
	const box = (text: string, cx: number, fs: number) => {
		const w = estimateLabelWidth(text, fs);
		return [cx - w / 2, cx + w / 2];
	};

	it('keeps the radius at normal size', () => {
		const l = gaugeLayout({
			...base,
			width: 300,
			plotHeight: 160,
			minText: '0',
			maxText: '100',
			fontSize: 11
		});
		expect(l.rOuter).toBeCloseTo((160 - 16 - 30) / base.verticalFactor, 5);
		expect(l.minLabel).toBe('0');
		expect(l.maxLabel).toBe('100');
	});

	it('keeps range labels apart and inside the svg for a narrow dial with long values at 200%', () => {
		const width = 211;
		const fs = 29.7;
		const l = gaugeLayout({
			...base,
			width,
			plotHeight: 160,
			minText: '0',
			maxText: '1,000,000',
			fontSize: fs
		});
		expect(l.rOuter).toBeGreaterThanOrEqual(36);
		const d = (l.rOuter + 14) * Math.SQRT1_2;
		const [a0, a1] = box(l.minLabel, width / 2 - d, fs);
		const [b0, b1] = box(l.maxLabel, width / 2 + d, fs);
		expect(a1).toBeLessThan(b0);
		expect(a0).toBeGreaterThanOrEqual(0);
		expect(b1).toBeLessThanOrEqual(width);
		expect(l.maxLabel).toContain('…');
	});

	it('keeps both labels whole when they fit side by side (svg 211px, 29.7px, 0 and 100000)', () => {
		const l = gaugeLayout({
			...base,
			width: 211,
			plotHeight: 160,
			minText: '0',
			maxText: '100000',
			fontSize: 29.7
		});
		expect(l.rOuter).toBeGreaterThanOrEqual(36);
		expect(l.minLabel).toBe('0');
		expect(l.maxLabel).toBe('100000');
		const d = (l.rOuter + 14) * Math.SQRT1_2;
		const [, a1] = box(l.minLabel, 211 / 2 - d, 29.7);
		const [b0, b1] = box(l.maxLabel, 211 / 2 + d, 29.7);
		expect(a1).toBeLessThanOrEqual(b0);
		expect(b1).toBeLessThanOrEqual(211);
	});

	it('keeps 1,000,000 and 9,000,000 whole at 300px / 11px when they fit (Codex example)', () => {
		const l = gaugeLayout({
			...base,
			width: 300,
			plotHeight: 160,
			minText: '1,000,000',
			maxText: '9,000,000',
			fontSize: 11
		});
		expect(l.minLabel).toBe('1,000,000');
		expect(l.maxLabel).toBe('9,000,000');
		const d = (l.rOuter + 14) * Math.SQRT1_2;
		const [, a1] = box(l.minLabel, 150 - d, 11);
		const [b0] = box(l.maxLabel, 150 + d, 11);
		expect(a1).toBeLessThan(b0);
	});

	it('keeps the centre value inside the inner circle at 200% text, cutting the range labels instead', () => {
		const heroFontSize = 64;
		const l = gaugeLayout({
			...base,
			width: 211,
			plotHeight: 160,
			minText: '0',
			maxText: '1,000,000',
			fontSize: 22,
			heroText: '88',
			heroFontSize
		});
		const hw = estimateLabelWidth('88', heroFontSize) / 2;
		expect(Math.hypot(hw, heroFontSize / 2)).toBeLessThanOrEqual(l.rInner);
		const d = (l.rOuter + 14) * Math.SQRT1_2;
		const [lo, hi] = box(l.maxLabel, l.cx + d, 22);
		expect(hi).toBeLessThanOrEqual(211);
		const [, minHi] = box(l.minLabel, l.cx - d, 22);
		expect(minHi).toBeLessThan(lo);
	});

	it('does not change the radius at normal size when a centre value is given', () => {
		const input = {
			...base,
			width: 300,
			plotHeight: 160,
			minText: '0',
			maxText: '100',
			fontSize: 11
		};
		expect(gaugeLayout({ ...input, heroText: '88', heroFontSize: 32 }).rOuter).toBe(
			gaugeLayout(input).rOuter
		);
	});
});
