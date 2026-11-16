/**
 * #623 (D3, owner decision 2026-11): the compact density steps the spacing
 * scale space-3..6 down one rung and leaves space-1/2/7/8 and the type scale
 * alone. Values are read from banto.css, as in contrast.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/css/banto.css', import.meta.url), 'utf8');

/** Body of the first rule whose selector line is `selector`. */
function block(selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`banto.css: no rule "${selector}"`);
	const open = css.indexOf('{', start);
	return css.slice(open + 1, css.indexOf('\n}', open));
}

function vars(body: string, prefix: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of body.matchAll(/(--banto-[\w-]+):\s*([^;]+);/g)) {
		if (m[1].startsWith(prefix)) out[m[1]] = m[2].trim();
	}
	return out;
}

describe('compact density spacing', () => {
	const compact = block("[data-banto-density='compact']");

	it('steps space-3..6 down one rung and touches nothing else on the scale', () => {
		expect(vars(compact, '--banto-space-')).toEqual({
			'--banto-space-3': '0.5rem',
			'--banto-space-4': '0.75rem',
			'--banto-space-5': '1rem',
			'--banto-space-6': '1.25rem'
		});
	});

	it('does not switch the type scale', () => {
		expect(vars(compact, '--banto-font-size')).toEqual({});
	});

	it('each compact value equals the standard value one rung below', () => {
		const std = vars(block(':root'), '--banto-space-');
		const c = vars(compact, '--banto-space-');
		for (const n of [3, 4, 5, 6]) {
			expect(c[`--banto-space-${n}`]).toBe(std[`--banto-space-${n - 1}`]);
		}
	});
});

/**
 * #624 (owner decision 2026-11-17): the touch density has 48px controls, 52px
 * grid rows and a 16px root size; the space scale is left to the standard one.
 */
describe('touch density', () => {
	const touch = block("[data-banto-density='touch']");
	const v = vars(touch, '--banto-');
	const px = (n: string) => Number.parseInt(v[n], 10);

	it('sets the owner-decided sizes', () => {
		expect(v['--banto-control-height']).toBe('48px');
		expect(v['--banto-grid-row-height']).toBe('52px');
		expect(v['--banto-font-size']).toBe('16px');
	});

	it('moves the root size only, not the type scale tokens or the space scale', () => {
		expect(vars(touch, '--banto-font-size-')).toEqual({});
		expect(vars(touch, '--banto-space-')).toEqual({});
	});

	it('keeps control heights ordered and the bars taller than their controls', () => {
		expect(px('--banto-control-height-sm')).toBeLessThan(px('--banto-control-height'));
		expect(px('--banto-control-height')).toBeLessThan(px('--banto-control-height-lg'));
		expect(px('--banto-grid-header-height')).toBeGreaterThan(px('--banto-grid-row-height'));
		expect(px('--banto-shell-header-height')).toBeGreaterThanOrEqual(px('--banto-control-height'));
	});
});
