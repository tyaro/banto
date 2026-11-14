/**
 * The README / visual-refresh-design.md §2.4 promise: the brand colours keep
 * >= 4.5:1 text contrast at ANY --banto-brand-hue. The L / C of every colour is
 * read from banto.css (not copied here), the hue is swept over 0..359, and
 * OKLCH -> sRGB uses the same rule as Chrome for an out-of-gamut value: clip
 * each component to 0..1 (no chroma reduction).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/css/banto.css', import.meta.url), 'utf8');

/** Body of the first rule whose selector line is `selector`. */
function block(selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`banto.css: no rule "${selector}"`);
	const open = css.indexOf('{', start);
	const close = css.indexOf('\n}', open);
	return css.slice(open + 1, close);
}

const LIGHT = block(':root,\n[data-theme]');
const DARK = block("[data-theme='dark']");

interface Oklch {
	l: number;
	c: number;
	/** hue offset added to --banto-brand-hue (0, or 40 for the accent) */
	offset: number;
}

/** Reads `--name: oklch(L C var(--banto-brand-hue))` / `... calc(var(--banto-brand-hue) + N))`. */
function token(rules: string, name: string): Oklch {
	const re = new RegExp(
		String.raw`${name}:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+(?:var\(--banto-brand-hue\)|calc\(var\(--banto-brand-hue\)\s*\+\s*(\d+)\))\s*\)`
	);
	const m = re.exec(rules);
	if (!m) throw new Error(`banto.css: ${name} is not oklch(L C <brand hue>)`);
	return { l: Number(m[1]), c: Number(m[2]), offset: Number(m[3] ?? 0) };
}

type Rgb = [number, number, number];

function oklchToSrgb(color: Oklch, hue: number): Rgb {
	const h = ((hue + color.offset) * Math.PI) / 180;
	const a = color.c * Math.cos(h);
	const b = color.c * Math.sin(h);
	const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
	// clip per component, gamma-encode, round to the 8-bit value the screen shows
	return lin.map((v) => {
		const c = Math.min(1, Math.max(0, v));
		const enc = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		return Math.round(enc * 255) / 255;
	}) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
	const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
	const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const STEP = 1; // degrees

/** Lowest contrast over the whole hue sweep, and the hue where it happens. */
function worst(fg: (hue: number) => Rgb, bg: (hue: number) => Rgb) {
	let min = { ratio: Infinity, hue: -1 };
	for (let hue = 0; hue < 360; hue += STEP) {
		const ratio = contrast(fg(hue), bg(hue));
		if (ratio < min.ratio) min = { ratio, hue };
	}
	return min;
}

const rgb = (rules: string, name: string) => (hue: number) => oklchToSrgb(token(rules, name), hue);

describe('the colour helpers', () => {
	it('matches known values', () => {
		expect(oklchToSrgb({ l: 1, c: 0, offset: 0 }, 0)).toEqual([1, 1, 1]);
		expect(oklchToSrgb({ l: 0, c: 0, offset: 0 }, 0)).toEqual([0, 0, 0]);
		expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
		// oklch(0.5 0.17 258) is #145ec1-ish (CHANGELOG), white on it is ~6.1:1
		const [r, g, b] = oklchToSrgb({ l: 0.5, c: 0.17, offset: 0 }, 258).map((v) =>
			Math.round(v * 255)
		);
		expect(Math.abs(r - 0x14)).toBeLessThanOrEqual(8);
		expect(Math.abs(g - 0x5e)).toBeLessThanOrEqual(8);
		expect(Math.abs(b - 0xc1)).toBeLessThanOrEqual(8);
	});
});

describe('contrast >= 4.5:1 at every --banto-brand-hue (0..359)', () => {
	const white = () => [1, 1, 1] as Rgb;
	const darkInverse = rgb(DARK, '--banto-neutral-1'); // dark --banto-text-inverse

	const cases: [string, (h: number) => Rgb, (h: number) => Rgb][] = [
		['light: white on the primary solid', white, rgb(LIGHT, '--banto-primary')],
		['light: white on the primary hover', white, rgb(LIGHT, '--banto-primary-hover')],
		['light: white on the accent (gradient end)', white, rgb(LIGHT, '--banto-brand-accent')],
		['dark: text-inverse on the primary solid', darkInverse, rgb(DARK, '--banto-primary')],
		['dark: text-inverse on the primary hover', darkInverse, rgb(DARK, '--banto-primary-hover')],
		[
			'dark: text-inverse on the accent (gradient end)',
			darkInverse,
			rgb(DARK, '--banto-brand-accent')
		],
		[
			'dark: primary-text on raised',
			rgb(DARK, '--banto-primary-text'),
			rgb(DARK, '--banto-neutral-4')
		],
		[
			'dark: primary-text on surface',
			rgb(DARK, '--banto-primary-text'),
			rgb(DARK, '--banto-neutral-2')
		],
		['dark: primary-text on bg', rgb(DARK, '--banto-primary-text'), rgb(DARK, '--banto-neutral-1')]
	];

	for (const [name, fg, bg] of cases) {
		it(name, () => {
			const { ratio, hue } = worst(fg, bg);
			expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(4.5);
		});
	}
});
