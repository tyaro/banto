import { describe, expect, it } from 'vitest';
import {
	DIV_RAMP,
	DIV_STEPS,
	divergingColor,
	SEQ_RAMP,
	SEQ_STEPS,
	sequentialColor,
	seriesColorVar
} from '../src/core/color';

describe('SEQ_RAMP / DIV_RAMP', () => {
	it('reference the theme tokens in step order', () => {
		expect(SEQ_RAMP).toHaveLength(SEQ_STEPS);
		expect(SEQ_RAMP[0]).toBe('var(--banto-chart-seq-1)');
		expect(SEQ_RAMP[SEQ_STEPS - 1]).toBe(`var(--banto-chart-seq-${SEQ_STEPS})`);
		expect(DIV_RAMP).toHaveLength(DIV_STEPS);
		expect(DIV_RAMP[0]).toBe('var(--banto-chart-div-1)');
		expect(DIV_RAMP[DIV_STEPS - 1]).toBe(`var(--banto-chart-div-${DIV_STEPS})`);
	});
});

describe('divergingColor', () => {
	const ramp = ['a', 'b', 'c', 'MID', 'e', 'f', 'g'];

	it('uses the neutral middle step exactly at the midpoint', () => {
		expect(divergingColor(0, -10, 0, 10, ramp)).toBe('MID');
		expect(divergingColor(0, -10, 0, 10)).toBe('var(--banto-chart-div-4)');
	});

	it('bins each side over its own half (asymmetric domains use both sides fully)', () => {
		expect(divergingColor(-10, -10, 0, 40, ramp)).toBe('a');
		expect(divergingColor(40, -10, 0, 40, ramp)).toBe('g');
		expect(divergingColor(-5, -10, 0, 40, ramp)).toBe('b');
		expect(divergingColor(20, -10, 0, 40, ramp)).toBe('f');
	});

	it('never puts a value off the midpoint on the neutral step', () => {
		expect(divergingColor(0.001, -10, 0, 10, ramp)).toBe('e');
		expect(divergingColor(-0.001, -10, 0, 10, ramp)).toBe('c');
	});

	it('clamps outside the domain and handles a side with no extent', () => {
		expect(divergingColor(-99, -10, 0, 10, ramp)).toBe('a');
		expect(divergingColor(99, -10, 0, 10, ramp)).toBe('g');
		expect(divergingColor(-1, 0, 0, 10, ramp)).toBe('a');
	});

	it('handles tiny ramps', () => {
		expect(divergingColor(1, 0, 0.5, 1, [])).toBe('');
		expect(divergingColor(1, 0, 0.5, 1, ['x'])).toBe('x');
		expect(divergingColor(0, 0, 0.5, 1, ['x'])).toBe('x');
	});

	it('returns an empty string for non-finite input instead of undefined', () => {
		expect(divergingColor(NaN, -10, 0, 10)).toBe('');
		expect(divergingColor(Infinity, -10, 0, 10)).toBe('');
		expect(divergingColor(1, NaN, 0, 10)).toBe('');
		expect(divergingColor(1, -10, NaN, 10)).toBe('');
		expect(divergingColor(1, -10, 0, Infinity)).toBe('');
	});

	it('does not overflow on huge finite domains', () => {
		const ramp = ['a', 'b', 'c', 'MID', 'e', 'f', 'g'];
		expect(divergingColor(-9e307, -1e308, 1e308, 1.7e308, ramp)).toBe('a');
		expect(divergingColor(5e307, -1e308, 1e308, 1.7e308, ramp)).toBe('c');
		expect(divergingColor(-1e308, -1e308, 1e308, 1.7e308, ramp)).toBe('a');
		expect(divergingColor(1.7e308, -1.7e308, -1e308, 1.7e308, ramp)).toBe('g');
	});

	it('keeps subnormal domains distinct', () => {
		const ramp = ['a', 'b', 'c', 'MID', 'e', 'f', 'g'];
		const m = Number.MIN_VALUE;
		expect(divergingColor(-m, -m, 0, m, ramp)).toBe('a');
		expect(divergingColor(m, -m, 0, m, ramp)).toBe('g');
	});
});

describe('seriesColorVar', () => {
	it('maps series index 0..7 to slots 1..8 in fixed order', () => {
		for (let i = 0; i < 8; i++) {
			expect(seriesColorVar(i)).toBe(`var(--banto-chart-${i + 1})`);
		}
	});

	it('clamps overflow (index >= 8) to slot 8 instead of cycling back to slot 1', () => {
		expect(seriesColorVar(8)).toBe('var(--banto-chart-8)');
		expect(seriesColorVar(20)).toBe('var(--banto-chart-8)');
	});
});

describe('sequentialColor', () => {
	it("maps the minimum to the ramp's first (lightest) step", () => {
		expect(sequentialColor(0, 0, 100)).toBe(SEQ_RAMP[0]);
	});

	it("maps the maximum to the ramp's last (darkest) step", () => {
		expect(sequentialColor(100, 0, 100)).toBe(SEQ_RAMP[SEQ_RAMP.length - 1]);
	});

	it('bins linearly across the domain', () => {
		// 7 steps over [0, 70]: value 10 sits in bin 1 (10/70 * 7 = 1).
		expect(sequentialColor(10, 0, 70)).toBe(SEQ_RAMP[1]);
		expect(sequentialColor(35, 0, 70)).toBe(SEQ_RAMP[3]);
	});

	it('degenerate min === max maps to the middle step, not the lightest end', () => {
		expect(sequentialColor(5, 5, 5)).toBe(SEQ_RAMP[Math.floor(SEQ_RAMP.length / 2)]);
	});

	it('clamps out-of-domain values instead of extrapolating past the ramp', () => {
		expect(sequentialColor(-50, 0, 100)).toBe(SEQ_RAMP[0]);
		expect(sequentialColor(500, 0, 100)).toBe(SEQ_RAMP[SEQ_RAMP.length - 1]);
	});

	it('accepts a caller-supplied ramp of a different length', () => {
		const ramp = ['#111', '#222', '#333'];
		expect(sequentialColor(0, 0, 10, ramp)).toBe('#111');
		expect(sequentialColor(10, 0, 10, ramp)).toBe('#333');
		expect(sequentialColor(5, 5, 5, ramp)).toBe('#222');
	});

	it('returns an empty string for non-finite input instead of undefined', () => {
		expect(sequentialColor(NaN, 0, 100)).toBe('');
		expect(sequentialColor(-Infinity, 0, 100)).toBe('');
		expect(sequentialColor(5, NaN, 100)).toBe('');
		expect(sequentialColor(5, 0, Infinity)).toBe('');
	});

	it('does not overflow on huge finite domains', () => {
		const ramp = ['#111', '#222', '#333'];
		expect(sequentialColor(9e307, -1e308, 1e308, ramp)).toBe('#333');
		expect(sequentialColor(-1e308, -1e308, 1e308, ramp)).toBe('#111');
		expect(sequentialColor(0, -1.7e308, 1.7e308, ramp)).toBe('#222');
	});

	it('keeps subnormal domains distinct', () => {
		const ramp = ['#111', '#222', '#333'];
		expect(sequentialColor(0, 0, Number.MIN_VALUE, ramp)).toBe('#111');
		expect(sequentialColor(Number.MIN_VALUE, 0, Number.MIN_VALUE, ramp)).toBe('#333');
	});
});
