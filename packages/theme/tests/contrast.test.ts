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
function block(selector: string, source = css): string {
	const start = source.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`css: no rule "${selector}"`);
	const open = source.indexOf('{', start);
	const close = source.indexOf('\n}', open);
	return source.slice(open + 1, close);
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

/** Linear sRGB before clipping (a component outside 0..1 is out of gamut). */
function oklchToLinear(color: Oklch, hue: number): number[] {
	const h = ((hue + color.offset) * Math.PI) / 180;
	const a = color.c * Math.cos(h);
	const b = color.c * Math.sin(h);
	const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
}

function oklchToSrgb(color: Oklch, hue: number): Rgb {
	const lin = oklchToLinear(color, hue);
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

/** Reads `--name: oklch(L C H)` with a fixed hue (the state colours do not follow the brand hue). */
function fixedToken(rules: string, name: string): Oklch & { hue: number } {
	const m = new RegExp(String.raw`${name}:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+(\d+)\s*\)`).exec(
		rules
	);
	if (!m) throw new Error(`banto.css: ${name} is not oklch(L C <fixed hue>)`);
	return { l: Number(m[1]), c: Number(m[2]), offset: 0, hue: Number(m[3]) };
}

describe('state text colours >= 4.5:1 on every surface, at every --banto-brand-hue', () => {
	// the surfaces tint with the brand hue, so the sweep is over the background
	const themes: [string, string, [string, string][]][] = [
		[
			'light',
			LIGHT,
			[
				['bg', '--banto-neutral-2'],
				['surface', '--banto-neutral-1'],
				['raised', '--banto-neutral-1']
			]
		],
		[
			'dark',
			DARK,
			[
				['bg', '--banto-neutral-1'],
				['surface', '--banto-neutral-2'],
				['raised', '--banto-neutral-4']
			]
		]
	];

	for (const [theme, rules, surfaces] of themes) {
		for (const state of ['danger', 'warning', 'caution', 'success', 'info']) {
			for (const [surface, neutral] of surfaces) {
				it(`${theme}: --banto-${state} on ${surface}`, () => {
					const t = fixedToken(rules, `--banto-${state}`);
					const fg = oklchToSrgb(t, t.hue);
					const { ratio, hue } = worst(
						() => fg,
						(h) => oklchToSrgb(token(rules, neutral), h)
					);
					expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(4.5);
				});
			}
			// Out-of-gamut colours are drawn differently per browser (Chrome clips
			// each component, CSS Color 4 gamut mapping lowers the chroma), so the
			// contrast above only holds everywhere for a colour inside sRGB.
			it(`${theme}: --banto-${state} is inside the sRGB gamut`, () => {
				const t = fixedToken(rules, `--banto-${state}`);
				for (const v of oklchToLinear(t, t.hue)) {
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(1);
				}
			});
		}
	}
});

describe('state -tint-text >= 4.6:1 on its own -tint over every surface, at every --banto-brand-hue', () => {
	const MIN = 4.6;
	const states = ['danger', 'warning', 'caution', 'success', 'info'];

	// light: the -tint is an opaque colour, so the surface does not matter
	for (const state of states) {
		it(`light: --banto-${state}-tint-text on --banto-${state}-tint`, () => {
			const fg = fixedToken(LIGHT, `--banto-${state}-tint-text`);
			const bg = fixedToken(LIGHT, `--banto-${state}-tint`);
			const ratio = contrast(oklchToSrgb(fg, fg.hue), oklchToSrgb(bg, bg.hue));
			expect(ratio).toBeGreaterThanOrEqual(MIN);
		});
	}

	// dark: -tint is `color-mix(in srgb, <tint-text> 18%, transparent)`, i.e. an 18%
	// film of the text colour composited (in gamma-encoded sRGB) over the surface
	const surfaces: [string, string][] = [
		['bg', '--banto-neutral-1'],
		['surface', '--banto-neutral-2'],
		['raised', '--banto-neutral-4']
	];
	for (const state of states) {
		for (const [surface, neutral] of surfaces) {
			it(`dark: --banto-${state}-tint-text on its tint over ${surface}`, () => {
				const t = fixedToken(DARK, `--banto-${state}-tint-text`);
				const fg = oklchToSrgb(t, t.hue);
				const { ratio, hue } = worst(
					() => fg,
					(h) => {
						const base = oklchToSrgb(token(DARK, neutral), h);
						return base.map((v, i) => 0.18 * fg[i] + 0.82 * v) as Rgb;
					}
				);
				expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(MIN);
			});
		}
		it(`${state}: --banto-${state}-tint-text is inside the sRGB gamut (light and dark)`, () => {
			for (const rules of [LIGHT, DARK]) {
				const t = fixedToken(rules, `--banto-${state}-tint-text`);
				for (const v of oklchToLinear(t, t.hue)) {
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(1);
				}
			}
		});
	}
});

/*
 * State steps (#1068): neutral < success < caution < warning < danger.
 * `--banto-<state>-fill` is the colour of a lamp / icon / bar (no text on it),
 * so its floor is the 3:1 of WCAG 1.4.11, not the 4.5:1 of the text colours.
 */
const FILL_STATES = ['success', 'caution', 'warning', 'danger'] as const;

const STANDARD_SURFACES: [string, string, [string, string][]][] = [
	[
		'light',
		LIGHT,
		[
			['bg', '--banto-neutral-2'],
			['surface', '--banto-neutral-1'],
			['raised', '--banto-neutral-1']
		]
	],
	[
		'dark',
		DARK,
		[
			['bg', '--banto-neutral-1'],
			['surface', '--banto-neutral-2'],
			['raised', '--banto-neutral-4']
		]
	]
];

/** `--banto-neutral-fill: var(--banto-neutral-N)` (declared once, the step differs per theme). */
function neutralFill(rules: string): (hue: number) => Rgb {
	const m = /--banto-neutral-fill:\s*var\((--banto-neutral-\d+)\)/.exec(LIGHT);
	if (!m) throw new Error('banto.css: --banto-neutral-fill is not var(--banto-neutral-N)');
	return rgb(rules, m[1]);
}

/** The fill of a step as a function of the brand hue (only the neutral one follows it). */
function fill(rules: string, state: string): (hue: number) => Rgb {
	if (state === 'neutral') return neutralFill(rules);
	const t = fixedToken(rules, `--banto-${state}-fill`);
	const c = oklchToSrgb(t, t.hue);
	return () => c;
}

describe('state fills (lamp / icon) >= 3:1 on every surface, at every --banto-brand-hue', () => {
	for (const [theme, rules, surfaces] of STANDARD_SURFACES) {
		for (const state of ['neutral', ...FILL_STATES]) {
			for (const [surface, neutral] of surfaces) {
				it(`${theme}: --banto-${state}-fill on ${surface}`, () => {
					const { ratio, hue } = worst(fill(rules, state), rgb(rules, neutral));
					expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(3);
				});
			}
		}
		for (const state of FILL_STATES) {
			it(`${theme}: --banto-${state}-fill is inside the sRGB gamut`, () => {
				const t = fixedToken(rules, `--banto-${state}-fill`);
				for (const v of oklchToLinear(t, t.hue)) {
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(1);
				}
			});
		}
	}
});

/*
 * Glass (banto-glass.css) does not redefine the state colours, so the new
 * tokens are checked against what it does to the ground: a card is a
 * translucent film of a neutral step over the page, and the page carries the
 * brand glows. Model: every glow composited as laid out in CSS (centre, px
 * radii, fade-out stop; the first layer on top) at grid points over the area
 * the page is painted on, for a few screen sizes. The radii are fixed px, so on
 * a narrow screen the two top glows overlap and are stronger than either alone
 * (#1072). The film percentages and glow strengths are read from
 * banto-glass.css. Not modelled: `saturate(1.5)` of the backdrop filter, and
 * content of the app behind the card.
 *
 * Text or a lamp put straight on the glass PAGE under a glow's peak is not
 * covered (the existing state text colours do not hold 4.5:1 there either);
 * state colours belong on a surface.
 */
const glassCss = readFileSync(new URL('../src/css/banto-glass.css', import.meta.url), 'utf8');

interface GlassModel {
	films: { name: string; neutral: string; alpha: number }[];
	glows: {
		name: string;
		alpha: number;
		colour: (hue: number) => Rgb;
		/** radii in CSS px, centre as a fraction of the area, and where the colour has faded out (0..1) */
		rx: number;
		ry: number;
		cx: number;
		cy: number;
		end: number;
	}[];
}

function glassModel(rules: string, glass: string): GlassModel {
	const films = ['--banto-surface', '--banto-surface-raised'].map((name) => {
		const m = new RegExp(
			String.raw`${name}:\s*color-mix\(in srgb,\s*var\((--banto-neutral-\d+)\)\s*(\d+)%,\s*transparent\)`
		).exec(glass);
		if (!m) throw new Error(`banto-glass.css: ${name} is not a neutral film`);
		return { name, neutral: m[1], alpha: Number(m[2]) / 100 };
	});
	const start = glass.indexOf('--banto-bg-image:');
	const image = glass.slice(start, glass.indexOf(';', start));
	const glows: GlassModel['glows'] = [];
	for (const g of image.matchAll(
		/radial-gradient\(\s*(\d+)px (\d+)px at (-?[\d.]+)% (-?[\d.]+)%,\s*(color-mix\(.*?transparent\s*\)|rgb\([^)]*\)),\s*transparent (\d+)%\s*\)/g
	)) {
		const geo = {
			rx: Number(g[1]),
			ry: Number(g[2]),
			cx: Number(g[3]) / 100,
			cy: Number(g[4]) / 100,
			end: Number(g[6]) / 100
		};
		const mix =
			/color-mix\(\s*in srgb,\s*var\((--banto-[a-z-]+)\)\s*(\d+)%,\s*transparent\s*\)/.exec(g[5]);
		const plain = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(g[5]);
		if (mix) {
			glows.push({ name: mix[1], alpha: Number(mix[2]) / 100, colour: rgb(rules, mix[1]), ...geo });
		} else if (plain) {
			const c = [Number(plain[1]) / 255, Number(plain[2]) / 255, Number(plain[3]) / 255] as Rgb;
			glows.push({
				name: `rgb(${plain[1]} ${plain[2]} ${plain[3]})`,
				alpha: Number(plain[4]),
				colour: () => c,
				...geo
			});
		}
	}
	if (glows.length !== 3) throw new Error('banto-glass.css: expected 3 glows in --banto-bg-image');
	return { films, glows };
}

/** `top` at `alpha` over `base`, composited in gamma-encoded sRGB (as `color-mix(in srgb)` does). */
const over = (top: Rgb, alpha: number, base: Rgb) =>
	base.map((v, i) => alpha * top[i] + (1 - alpha) * v) as Rgb;

/** Area the page ground is painted over (viewport, CSS px) and the grid resolution used on it. */
const AREAS: [number, number][] = [
	[320, 600],
	[375, 667],
	[768, 1024],
	[1440, 900]
];
const GRID = 24;

describe('glass: caution text >= 4.5:1 and the state fills >= 3:1 on the glass surfaces', () => {
	const themes: [string, string, string, string][] = [
		['light', LIGHT, block(":root[data-banto-preset='glass']", glassCss), '--banto-neutral-2'],
		[
			'dark',
			DARK,
			block(":root[data-theme='dark'][data-banto-preset='glass']", glassCss),
			'--banto-neutral-1'
		]
	];

	it('the model reads banto-glass.css', () => {
		const light = glassModel(LIGHT, themes[0][2]);
		expect(light.films.map((f) => f.alpha)).toEqual([0.62, 0.55]);
		expect(light.glows.map((g) => g.alpha)).toEqual([0.16, 0.14, 0.1]);
	});

	for (const [theme, rules, glass, page] of themes) {
		const model = glassModel(rules, glass);
		/** Lowest contrast of `fg` over every film x glow x brand hue; `tint` adds the 18% film of a dark -tint. */
		const worstOnGlass = (fg: (hue: number) => Rgb, tint = 0) => {
			let min = { ratio: Infinity, where: '' };
			for (const film of model.films) {
				for (const glow of model.glows) {
					const { ratio, hue } = worst(fg, (h) => {
						const ground = over(
							rgb(rules, film.neutral)(h),
							film.alpha,
							over(glow.colour(h), glow.alpha, rgb(rules, page)(h))
						);
						return tint ? over(fg(h), tint, ground) : ground;
					});
					if (ratio < min.ratio)
						min = { ratio, where: `${film.name} over ${glow.name}, hue ${hue}` };
				}
			}
			// The glows have fixed px radii, so on a narrow area they overlap: composite all
			// of them as laid out in CSS (first layer on top), at grid points over the area.
			for (let hue = 0; hue < 360; hue += STEP) {
				const glowColours = model.glows.map((g) => g.colour(hue));
				const pageColour = rgb(rules, page)(hue);
				const fgColour = fg(hue);
				for (const film of model.films) {
					const filmColour = rgb(rules, film.neutral)(hue);
					for (const [w, h] of AREAS) {
						for (let gx = 0; gx <= GRID; gx++) {
							for (let gy = 0; gy <= GRID; gy++) {
								const x = (w * gx) / GRID;
								const y = (h * gy) / GRID;
								let ground = pageColour;
								for (let i = model.glows.length - 1; i >= 0; i--) {
									const glow = model.glows[i];
									const t = Math.hypot((x - glow.cx * w) / glow.rx, (y - glow.cy * h) / glow.ry);
									const a = glow.alpha * Math.max(0, 1 - t / glow.end);
									if (a > 0) ground = over(glowColours[i], a, ground);
								}
								ground = over(filmColour, film.alpha, ground);
								if (tint) ground = over(fgColour, tint, ground);
								const ratio = contrast(fgColour, ground);
								if (ratio < min.ratio)
									min = {
										ratio,
										where: `${film.name} over stacked glows, ${w}x${h} at (${x}, ${y}), hue ${hue}`
									};
							}
						}
					}
				}
			}
			return min;
		};

		it(`${theme}: --banto-caution (text)`, () => {
			const t = fixedToken(rules, '--banto-caution');
			const c = oklchToSrgb(t, t.hue);
			const { ratio, where } = worstOnGlass(() => c);
			expect(ratio, where).toBeGreaterThanOrEqual(4.5);
		});

		for (const state of ['neutral', ...FILL_STATES]) {
			it(`${theme}: --banto-${state}-fill`, () => {
				const { ratio, where } = worstOnGlass(fill(rules, state));
				expect(ratio, where).toBeGreaterThanOrEqual(3);
			});
		}
	}

	// light: the -tint is opaque, so glass changes nothing (checked above). dark: the
	// 18% film of the text colour now sits on the glass surface instead of an opaque one.
	it('dark: --banto-caution-tint-text on its tint', () => {
		const [, rules, glass, page] = themes[1];
		const model = glassModel(rules, glass);
		const t = fixedToken(rules, '--banto-caution-tint-text');
		const fg = oklchToSrgb(t, t.hue);
		for (const film of model.films) {
			for (const glow of model.glows) {
				const { ratio, hue } = worst(
					() => fg,
					(h) =>
						over(
							fg,
							0.18,
							over(
								rgb(rules, film.neutral)(h),
								film.alpha,
								over(glow.colour(h), glow.alpha, rgb(rules, page)(h))
							)
						)
				);
				expect(ratio, `${film.name} over ${glow.name}, hue ${hue}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});

/*
 * Yellow vs orange (#1068): the reason --banto-caution exists is that a screen
 * can show caution AND warning side by side, so the two must not read as the
 * same colour. Floors (measured values in the PR / README):
 *
 * - OKLab distance >= 0.09 between caution and warning, for the text colour,
 *   the -tint-text and the -fill, light and dark. 0.09 is the floor
 *   chart-palette.test.ts already uses between a chart series and a state
 *   colour (STATUS_MIN, normal colour vision), i.e. this repo's existing
 *   meaning of "two colours a reader can tell apart".
 * - The fills (lamps: the case with no label next to the colour) also keep
 *   >= 40 degrees of OKLCH hue between caution and warning (a yellow and an
 *   orange, not two ambers), and every pair of the five steps keeps >= 0.09.
 * - Dark fills: caution is >= 0.10 lighter than warning. A lightness step
 *   survives a red-green colour-vision deficiency, where the hue gap shrinks.
 *   The light theme cannot have this: 3:1 against a white surface caps the
 *   luminance of every fill at about the same level, so there the hue carries
 *   the difference (and the README tells the app to add an icon or a label).
 *
 * Not checked: the light -tint grounds. --banto-warning-tint is already a pale
 * yellow (hue 95) and its value is kept for compatibility, so the caution tint
 * can only sit next to it (about 0.05); a badge is told apart by its
 * -tint-text and its label.
 */
describe('caution (yellow) and warning (orange) are told apart', () => {
	const MIN_DISTANCE = 0.09;
	const MIN_FILL_HUE_GAP = 40;
	const MIN_DARK_FILL_LIGHTNESS_GAP = 0.1;

	/** OKLab coordinates of an in-gamut oklch() token (no conversion needed). */
	const lab = (t: Oklch & { hue: number }) => {
		const h = (t.hue * Math.PI) / 180;
		return [t.l, t.c * Math.cos(h), t.c * Math.sin(h)];
	};
	const distance = (x: number[], y: number[]) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

	for (const [theme, rules] of [
		['light', LIGHT],
		['dark', DARK]
	] as const) {
		for (const suffix of ['', '-tint-text', '-fill']) {
			it(`${theme}: --banto-caution${suffix} vs --banto-warning${suffix}`, () => {
				const caution = fixedToken(rules, `--banto-caution${suffix}`);
				const warning = fixedToken(rules, `--banto-warning${suffix}`);
				expect(distance(lab(caution), lab(warning))).toBeGreaterThanOrEqual(MIN_DISTANCE);
			});
		}

		it(`${theme}: the fills keep a yellow / orange hue gap`, () => {
			const caution = fixedToken(rules, '--banto-caution-fill');
			const warning = fixedToken(rules, '--banto-warning-fill');
			expect(caution.hue - warning.hue).toBeGreaterThanOrEqual(MIN_FILL_HUE_GAP);
		});

		it(`${theme}: every pair of the five fills`, () => {
			const chromatic = FILL_STATES.map((s) => lab(fixedToken(rules, `--banto-${s}-fill`)));
			for (let i = 0; i < chromatic.length; i++) {
				for (let j = i + 1; j < chromatic.length; j++) {
					expect(
						distance(chromatic[i], chromatic[j]),
						`${FILL_STATES[i]} / ${FILL_STATES[j]}`
					).toBeGreaterThanOrEqual(MIN_DISTANCE);
				}
			}
			// the neutral step is a grey (chroma <= 0.016 at any brand hue): its distance
			// to a chromatic fill is at least that fill's chroma minus 0.016
			for (const s of FILL_STATES) {
				expect(fixedToken(rules, `--banto-${s}-fill`).c - 0.016, s).toBeGreaterThanOrEqual(
					MIN_DISTANCE
				);
			}
		});
	}

	it('dark: the caution fill is lighter than the warning fill', () => {
		const caution = fixedToken(DARK, '--banto-caution-fill');
		const warning = fixedToken(DARK, '--banto-warning-fill');
		expect(caution.l - warning.l).toBeGreaterThanOrEqual(MIN_DARK_FILL_LIGHTNESS_GAP);
	});
});
