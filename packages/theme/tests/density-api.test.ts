import { describe, expect, it } from 'vitest';
import { isThemeDensity } from '../src/index';

describe('isThemeDensity', () => {
	it('accepts the three densities and nothing else', () => {
		for (const d of ['standard', 'compact', 'touch']) expect(isThemeDensity(d)).toBe(true);
		for (const d of ['large', '', null, undefined, 1]) expect(isThemeDensity(d)).toBe(false);
	});
});
