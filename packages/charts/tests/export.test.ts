import { describe, expect, it } from 'vitest';
import { colorToSrgb, inlineCssVarRefs } from '../src/core/export';

describe('inlineCssVarRefs', () => {
	it('replaces a single var() reference with the resolved value', () => {
		const result = inlineCssVarRefs('var(--banto-chart-1)', (name) =>
			name === '--banto-chart-1' ? '#2a78d6' : ''
		);
		expect(result).toBe('#2a78d6');
	});

	it('replaces multiple var() references in one string', () => {
		const result = inlineCssVarRefs('var(--a) var(--b)', (name) =>
			name === '--a' ? '1px' : '2px'
		);
		expect(result).toBe('1px 2px');
	});

	it('leaves non-var() content untouched around a resolved reference', () => {
		const result = inlineCssVarRefs('4 3', () => '');
		expect(result).toBe('4 3');
	});

	it('leaves an unresolvable reference as the original var(...) text (empty resolve)', () => {
		const result = inlineCssVarRefs('var(--unknown)', () => '');
		expect(result).toBe('var(--unknown)');
	});

	it('leaves an unresolvable reference as-is when resolve returns whitespace only', () => {
		const result = inlineCssVarRefs('var(--unknown)', () => '   ');
		expect(result).toBe('var(--unknown)');
	});

	it('trims the resolved value', () => {
		const result = inlineCssVarRefs('var(--x)', () => '  #ffffff  ');
		expect(result).toBe('#ffffff');
	});

	it('is a no-op on a string with no var() references', () => {
		const result = inlineCssVarRefs('#123456', () => 'ignored');
		expect(result).toBe('#123456');
	});
});

describe('colorToSrgb', () => {
	const paint = () => [20, 94, 193, 255] as [number, number, number, number];

	it('converts oklch() to rgb() through the painter', () => {
		expect(colorToSrgb('oklch(0.5 0.17 258)', paint)).toBe('rgb(20, 94, 193)');
	});

	it('converts color() and color-mix() results too', () => {
		expect(colorToSrgb('color(srgb 0.1 0.2 0.3)', paint)).toBe('rgb(20, 94, 193)');
		expect(colorToSrgb('color-mix(in oklab, red, blue)', paint)).toBe('rgb(20, 94, 193)');
	});

	it('keeps the alpha as rgba()', () => {
		expect(colorToSrgb('oklch(0.5 0.17 258 / 0.5)', () => [1, 2, 3, 128])).toBe(
			'rgba(1, 2, 3, 0.502)'
		);
	});

	it('passes sRGB colours, none, url() and font names through without painting', () => {
		const never = () => {
			throw new Error('painter must not be called');
		};
		for (const v of ['#2a78d6', 'rgb(1 2 3)', 'rgba(1, 2, 3, 0.5)', 'none', 'url(#g)', 'system-ui'])
			expect(colorToSrgb(v, never)).toBe(v);
	});

	it('returns the value as-is when the painter cannot convert (no canvas)', () => {
		expect(colorToSrgb('oklch(0.5 0.17 258)', () => null)).toBe('oklch(0.5 0.17 258)');
	});

	it('default painter falls back to the value without a DOM (node environment)', () => {
		expect(colorToSrgb('oklch(0.5 0.17 258)')).toBe('oklch(0.5 0.17 258)');
	});
});
