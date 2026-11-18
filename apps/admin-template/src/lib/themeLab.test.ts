import { describe, expect, it } from 'vitest';
import rawCss from '../../../../packages/theme/src/css/banto.css?raw';
import {
	COMPACT_DENSITY_VARS,
	STANDARD_DENSITY_VARS,
	TOUCH_DENSITY_VARS,
	densityVars,
	gridRowHeight,
	DEFAULT_FONT_STACK,
	DEFAULT_HUE,
	DEFAULT_RADIUS,
	DEFAULT_STATE,
	TOKENS,
	changedVariables,
	clampHue,
	clampRadius,
	contrastRatio,
	contrastRows,
	exportCss,
	isDefaultState,
	oklchToSrgb,
	previewStyle,
	radiusScale,
	type LabState
} from './themeLab.js';

const css = rawCss.replaceAll('\r\n', '\n');

const state = (patch: Partial<LabState>): LabState => ({ ...DEFAULT_STATE, ...patch });

describe('knob clamping', () => {
	it('keeps the hue a whole number in 0..359', () => {
		expect(clampHue(150.6)).toBe(151);
		expect(clampHue(-5)).toBe(0);
		expect(clampHue(400)).toBe(359);
		expect(clampHue(Number.NaN)).toBe(DEFAULT_HUE);
	});

	it('keeps the radius in 0..16', () => {
		expect(clampRadius(-1)).toBe(0);
		expect(clampRadius(99)).toBe(16);
		expect(clampRadius(Number.NaN)).toBe(DEFAULT_RADIUS.md);
	});

	it('moves sm / md / lg together and reproduces 4 / 6 / 10 at the default', () => {
		expect(radiusScale(6)).toEqual({ sm: 4, md: 6, lg: 10 });
		expect(radiusScale(0)).toEqual({ sm: 0, md: 0, lg: 0 });
		expect(radiusScale(12)).toEqual({ sm: 8, md: 12, lg: 20 });
	});
});

describe('exportCss', () => {
	it('exports nothing for the defaults', () => {
		expect(changedVariables(DEFAULT_STATE)).toEqual([]);
		expect(isDefaultState(DEFAULT_STATE)).toBe(true);
		expect(exportCss(DEFAULT_STATE)).toBe(':root {\n}\n');
	});

	it('exports only the variables that changed', () => {
		expect(exportCss(state({ hue: 150 }))).toBe(':root {\n\t--banto-brand-hue: 150;\n}\n');
		expect(changedVariables(state({ radiusMd: 8 })).map(([n]) => n)).toEqual([
			'--banto-radius-sm',
			'--banto-radius-md',
			'--banto-radius-lg'
		]);
		// a value equal to its default is not exported, even when another one in the scale is
		expect(changedVariables(state({ radiusMd: 6 }))).toEqual([]);
	});

	it('writes the font stack and leaves density and theme as comments', () => {
		const css = exportCss(state({ font: 'mono', density: 'touch', theme: 'dark' }));
		expect(css).toContain('--banto-font-family: ui-monospace');
		expect(css).toContain("/* density: applyDensity('touch')");
		expect(css).toContain("/* theme: applyTheme('dark')");
		expect(css.startsWith(':root {')).toBe(true);
		expect(isDefaultState(state({ density: 'compact' }))).toBe(false);
	});

	it('normalises an out-of-range hue', () => {
		expect(exportCss(state({ hue: 999 }))).toContain('--banto-brand-hue: 359;');
	});
});

describe('gridRowHeight', () => {
	it('follows the density table (BantoGrid takes the row height as a number)', () => {
		expect(gridRowHeight('standard')).toBe(36);
		expect(gridRowHeight('compact')).toBe(32);
		expect(gridRowHeight('touch')).toBe(52);
	});
});

describe('previewStyle', () => {
	it('sets every knob, and --banto-radius with md', () => {
		const style = previewStyle(state({ hue: 20, radiusMd: 10 }));
		expect(style).toContain('--banto-brand-hue: 20');
		expect(style).toContain('--banto-radius-md: 10px');
		expect(style).toContain('--banto-radius: 10px');
		expect(style).toContain(`--banto-font-family: ${DEFAULT_FONT_STACK}`);
	});

	it('sets the density variables explicitly, rem through --lab-rem', () => {
		const std = previewStyle(state({ density: 'standard' }));
		expect(std).toContain('--lab-rem: 14px');
		expect(std).toContain('--banto-control-height: 36px');
		expect(std).toContain('--banto-space-4: calc(1 * var(--lab-rem))');
		expect(std).toContain('--banto-dock-button-size: initial');
		const compact = previewStyle(state({ density: 'compact' }));
		expect(compact).toContain('--banto-control-height: 32px');
		expect(compact).toContain('--banto-space-4: calc(0.75 * var(--lab-rem))');
		const touch = previewStyle(state({ density: 'touch' }));
		expect(touch).toContain('--lab-rem: 16px');
		expect(touch).toContain('--banto-font-size: 16px');
		expect(touch).toContain('font-size: 16px');
		expect(densityVars('touch')['--banto-control-height-sm']).toBe('40px');
	});
});

describe('contrast helpers', () => {
	it('matches known values', () => {
		expect(oklchToSrgb({ l: 1, c: 0 }, 0)).toEqual([1, 1, 1]);
		expect(oklchToSrgb({ l: 0, c: 0 }, 0)).toEqual([0, 0, 0]);
		expect(contrastRatio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
	});

	it('white on the default primary is about 6:1 and passes', () => {
		const row = contrastRows('light', DEFAULT_HUE).find((r) => r.id === 'onPrimary');
		expect(row?.ratio).toBeGreaterThan(5.5);
		expect(row?.ratio).toBeLessThan(6.6);
		expect(row?.ok).toBe(true);
	});

	it('lists the four state colours in both themes, and primaryText only in dark', () => {
		const ids = (theme: 'light' | 'dark') => contrastRows(theme, 100).map((r) => r.id);
		expect(ids('light')).toEqual([
			'onPrimary',
			'onPrimaryHover',
			'onAccent',
			'danger',
			'warning',
			'success',
			'info'
		]);
		expect(ids('dark')).toContain('primaryText');
	});

	it('flags a ratio under 4.5 (the ok flag is the comparison itself)', () => {
		for (const theme of ['light', 'dark'] as const)
			for (const row of contrastRows(theme, 200)) expect(row.ok).toBe(row.ratio >= 4.5);
	});

	it('keeps every row at 4.5:1 or more over the whole hue sweep (the theme promises it)', () => {
		for (const theme of ['light', 'dark'] as const)
			for (let hue = 0; hue < 360; hue += 5)
				for (const row of contrastRows(theme, hue))
					expect(row.ratio, `${theme} ${row.id} at ${hue}`).toBeGreaterThanOrEqual(4.5);
	});
});

// The constants of themeLab.ts must follow banto.css, not a copy of it.
describe('themeLab.ts mirrors banto.css', () => {
	function block(selector: string): string {
		const start = css.indexOf(`\n${selector} {`);
		if (start < 0) throw new Error(`banto.css: no rule "${selector}"`);
		const open = css.indexOf('{', start);
		return css.slice(open + 1, css.indexOf('\n}', open));
	}
	const light = block(':root,\n[data-theme]');
	const dark = block("[data-theme='dark']");
	const root = css.slice(css.indexOf('\n:root {'), css.indexOf('\n}', css.indexOf('\n:root {')));

	function oklch(rules: string, name: string) {
		const m = new RegExp(
			String.raw`${name}:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+(?:(\d+)|var\(--banto-brand-hue\)|calc\(var\(--banto-brand-hue\)\s*\+\s*(\d+)\))\s*\)`
		).exec(rules);
		if (!m) throw new Error(`banto.css: ${name} is not oklch(...)`);
		return {
			l: Number(m[1]),
			c: Number(m[2]),
			h: m[3] ? Number(m[3]) : undefined,
			offset: m[4] ? Number(m[4]) : 0
		};
	}

	it('has the same defaults', () => {
		expect(root).toContain(`--banto-brand-hue: ${DEFAULT_HUE};`);
		for (const k of ['sm', 'md', 'lg'] as const)
			expect(css).toContain(`--banto-radius-${k}: ${DEFAULT_RADIUS[k]}px;`);
		const family = /--banto-font-family:\s*([^;]+);/.exec(css)?.[1].replace(/\s+/g, ' ').trim();
		expect(family).toBe(DEFAULT_FONT_STACK);
	});

	for (const [name, rules] of [
		['light', light],
		['dark', dark]
	] as const) {
		const t = TOKENS[name];
		it(`${name}: brand colours`, () => {
			for (const [key, token] of [
				['primary', '--banto-primary'],
				['primaryHover', '--banto-primary-hover'],
				['accent', '--banto-brand-accent']
			] as const) {
				const c = oklch(rules, token);
				expect([c.l, c.c, c.offset], key).toEqual([
					t[key].l,
					t[key].c,
					'offset' in t[key] ? t[key].offset : 0
				]);
			}
		});

		it(`${name}: state colours`, () => {
			for (const state of ['danger', 'warning', 'success', 'info'] as const) {
				const c = oklch(rules, `--banto-${state}`);
				expect([c.l, c.c, c.h], state).toEqual([
					t.state[state].l,
					t.state[state].c,
					t.state[state].h
				]);
			}
		});
	}

	it('surfaces and inverse text', () => {
		const n1 = oklch(light, '--banto-neutral-1');
		expect([n1.l, n1.c]).toEqual([TOKENS.light.surface.l, TOKENS.light.surface.c]);
		const d1 = oklch(dark, '--banto-neutral-1');
		expect([d1.l, d1.c]).toEqual([TOKENS.dark.inverse.l, TOKENS.dark.inverse.c]);
		const d2 = oklch(dark, '--banto-neutral-2');
		expect([d2.l, d2.c]).toEqual([TOKENS.dark.surface.l, TOKENS.dark.surface.c]);
		const d4 = oklch(dark, '--banto-neutral-4');
		expect([d4.l, d4.c]).toEqual([0.285, 0.013]);
		const pt = oklch(dark, '--banto-primary-text');
		expect([pt.l, pt.c]).toEqual([TOKENS.dark.primaryText.l, TOKENS.dark.primaryText.c]);
	});

	// The preview sets every density variable itself (the shell may be in another
	// density), so the tables must equal banto.css, and a variable added to a
	// density block must be added to the table.
	describe('density tables', () => {
		function vars(rules: string): Record<string, string> {
			const out: Record<string, string> = {};
			const plain = rules.replace(/\/\*[\s\S]*?\*\//g, '');
			for (const m of plain.matchAll(/(--banto-[\w-]+):\s*([^;]+);/g))
				out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
			return out;
		}
		const rootVars = vars(root);
		const compact = vars(block("[data-banto-density='compact']"));
		const touch = vars(block("[data-banto-density='touch']"));

		it('standard values equal :root (initial = not set there)', () => {
			for (const [name, value] of Object.entries(STANDARD_DENSITY_VARS))
				expect(value, name).toBe(rootVars[name] ?? 'initial');
		});
		it('compact and touch equal their blocks', () => {
			expect(COMPACT_DENSITY_VARS).toEqual(compact);
			expect(TOUCH_DENSITY_VARS).toEqual(touch);
		});
		it('every variable of a density block is in the standard table', () => {
			for (const name of [...Object.keys(compact), ...Object.keys(touch)])
				expect(Object.keys(STANDARD_DENSITY_VARS), name).toContain(name);
		});
	});
});
