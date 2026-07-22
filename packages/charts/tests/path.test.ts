import { describe, expect, it } from 'vitest';
import { areaPath, bandAreaPath, linePath, roundedTopBarPath } from '../src/core/path';

describe('bandAreaPath', () => {
	it('fills the band between the top polyline (forward) and bottom polyline (reversed)', () => {
		const d = bandAreaPath(
			[
				{ x: 0, y: 5 },
				{ x: 10, y: 3 }
			],
			[
				{ x: 0, y: 20 },
				{ x: 10, y: 18 }
			]
		);
		// top forward, then bottom points appended in reverse, then close.
		expect(d).toBe('M 0 5 L 10 3 L 10 18 L 0 20 Z');
	});

	it('returns empty when either boundary has no points', () => {
		expect(bandAreaPath([], [{ x: 0, y: 1 }])).toBe('');
		expect(bandAreaPath([{ x: 0, y: 1 }], [])).toBe('');
	});
});

describe('linePath', () => {
	it('builds an M + L polyline through the given points', () => {
		const d = linePath([
			{ x: 0, y: 10 },
			{ x: 5, y: 20 },
			{ x: 10, y: 0 }
		]);
		expect(d).toBe('M 0 10 L 5 20 L 10 0');
	});

	it('handles a single point (M only, no L)', () => {
		expect(linePath([{ x: 3, y: 4 }])).toBe('M 3 4');
	});

	it('handles empty data', () => {
		expect(linePath([])).toBe('');
	});
});

describe('areaPath', () => {
	it('closes the polyline down to the baseline and back', () => {
		const d = areaPath(
			[
				{ x: 0, y: 10 },
				{ x: 10, y: 5 }
			],
			100
		);
		expect(d).toBe('M 0 10 L 10 5 L 10 100 L 0 100 Z');
	});

	it('handles a single point (a thin sliver down to baseline)', () => {
		const d = areaPath([{ x: 5, y: 20 }], 100);
		expect(d).toBe('M 5 20 L 5 100 Z');
	});

	it('handles empty data', () => {
		expect(areaPath([], 100)).toBe('');
	});
});

describe('roundedTopBarPath', () => {
	it('rounds only the top edge for a vertical bar', () => {
		const d = roundedTopBarPath(0, 0, 20, 100, 4);
		expect(d).toContain('Q 0 0 4 0');
		expect(d).toContain('Q 20 0 20 4');
		// Bottom (baseline) corners are plain L commands - no Q near y=100.
		expect(d).not.toContain('Q 0 100');
		expect(d).not.toContain('Q 20 100');
	});

	it('rounds only the right edge for a horizontal bar', () => {
		const d = roundedTopBarPath(0, 0, 100, 20, 4, true);
		expect(d).toContain('Q 100 0 100 4');
		expect(d).toContain('Q 100 20 96 20');
		expect(d).not.toContain('Q 0 0');
		expect(d).not.toContain('Q 0 20');
	});

	it('clamps the radius so it never exceeds half the width/height', () => {
		const d = roundedTopBarPath(0, 0, 4, 4, 100);
		// radius should clamp to 2 (half of 4)
		expect(d).toContain('Q 0 0 2 0');
	});

	it('falls back to a plain rect path when radius is 0', () => {
		const d = roundedTopBarPath(1, 2, 10, 20, 0);
		expect(d).toBe('M 1 2 L 11 2 L 11 22 L 1 22 Z');
	});

	it('handles a zero-height bar (stacked zero segment) without throwing', () => {
		const d = roundedTopBarPath(0, 50, 20, 0, 4);
		expect(typeof d).toBe('string');
	});
});
