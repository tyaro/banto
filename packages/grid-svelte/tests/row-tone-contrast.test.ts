/**
 * #1069: the text on a row painted by `rowTone` keeps >= 4.5:1 in light, dark
 * and Glass, at every --banto-brand-hue (the neutrals follow the brand hue).
 *
 * Nothing is copied here: which token paints what is read from the style block
 * of BantoGrid.svelte, and the colours from @banto/theme's banto.css /
 * banto-glass.css. The arithmetic is the one of packages/theme/tests/
 * contrast.test.ts: OKLCH -> sRGB with each component clipped to 0..1 (what
 * Chrome draws), and a `color-mix(in srgb, X N%, transparent)` film composited
 * over the ground in gamma-encoded sRGB.
 */
// Typed by ./node-fs.d.ts (this package has no @types/node; a `?raw` import of
// a .css file comes back empty under Vitest's default `css` handling).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const themeCss = read('../../theme/src/css/banto.css');
const glassCss = read('../../theme/src/css/banto-glass.css');
const gridSource = read('../src/BantoGrid.svelte');
const gridCss = gridSource.slice(gridSource.lastIndexOf('<style>'));

/** Body of the first rule of `css` whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`no rule "${selector}"`);
	const open = css.indexOf('{', start);
	return css.slice(open + 1, css.indexOf('\n}', open));
}

/** Body of a rule in the grid's (tab-indented) style block. */
function gridRule(selector: string): string {
	const start = gridCss.indexOf(`\n\t${selector} {`);
	if (start < 0) throw new Error(`BantoGrid.svelte: no rule "${selector}"`);
	const open = gridCss.indexOf('{', start);
	return gridCss.slice(open + 1, gridCss.indexOf('\n\t}', open));
}

function declared(rules: string, name: string): string | undefined {
	const m = new RegExp(String.raw`(?:^|[\s;{])${name}:\s*([^;]+);`).exec(rules);
	return m?.[1].trim().replace(/\s+/g, ' ');
}

const LIGHT = block(themeCss, ':root,\n[data-theme]');
const DARK = block(themeCss, "[data-theme='dark']");
const GLASS_GRID_LIGHT = block(glassCss, "[data-banto-preset='glass'] .banto-grid");
const GLASS_GRID_DARK = block(
	glassCss,
	"[data-theme='dark'][data-banto-preset='glass'] .banto-grid"
);

type Rgb = [number, number, number];
/** A colour at one brand hue; `alpha` < 1 is a film over whatever is below. */
interface Paint {
	rgb: Rgb;
	alpha: number;
}

function oklchToSrgb(l: number, c: number, hueDeg: number): Rgb {
	const h = (hueDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
		-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
		-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
	];
	return lin.map((v) => {
		const clipped = Math.min(1, Math.max(0, v));
		const enc = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
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

const over = (top: Paint, base: Rgb): Rgb =>
	base.map((v, i) => top.alpha * top.rgb[i] + (1 - top.alpha) * v) as Rgb;

/**
 * A theme as the grid sees it: rule bodies searched in order (the first that
 * declares a token wins - the `.banto-grid` rule of Glass, then dark, then
 * the light values every theme starts from).
 */
interface Theme {
	name: string;
	layers: string[];
}

const THEMES: Theme[] = [
	{ name: 'light', layers: [LIGHT] },
	{ name: 'dark', layers: [DARK, LIGHT] },
	{ name: 'light glass', layers: [GLASS_GRID_LIGHT, LIGHT] },
	{ name: 'dark glass', layers: [GLASS_GRID_DARK, DARK, LIGHT] }
];

/** Resolves a CSS value (`var()`, `oklch()`, a `color-mix()` film) at one brand hue. */
function paint(theme: Theme, value: string, hue: number): Paint {
	const ref = /^var\((--[\w-]+)\)$/.exec(value);
	if (ref) {
		for (const layer of theme.layers) {
			const next = declared(layer, ref[1]);
			if (next) return paint(theme, next, hue);
		}
		throw new Error(`${theme.name}: ${ref[1]} is not declared`);
	}
	const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(?:var\(--banto-brand-hue\)|([\d.]+))\s*\)$/.exec(
		value
	);
	if (oklch) {
		const fixedHue = oklch[3] === undefined ? hue : Number(oklch[3]);
		return { rgb: oklchToSrgb(Number(oklch[1]), Number(oklch[2]), fixedHue), alpha: 1 };
	}
	const film = /^color-mix\(in srgb, (.+) ([\d.]+)%, transparent\)$/.exec(value);
	if (film) {
		const inner = paint(theme, film[1], hue);
		if (inner.alpha !== 1) throw new Error(`film of a film: ${value}`);
		return { rgb: inner.rgb, alpha: Number(film[2]) / 100 };
	}
	throw new Error(`${theme.name}: cannot resolve "${value}"`);
}

const TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const;
type Tone = (typeof TONES)[number];

/** What BantoGrid.svelte declares for a row tone: the ground and the band. */
function rowToneTokens(tone: Tone) {
	const rule = gridRule(`.row[data-row-tone='${tone}']`);
	return { tint: declared(rule, '--row-tone-tint')!, band: declared(rule, '--row-tone')! };
}

const TONED = '.row[data-row-tone]:not(.selected)';
const hoverOverlay = (tone: Tone) =>
	declared(
		gridRule(
			tone === 'neutral' ? `.row[data-row-tone='neutral']:not(.selected):hover` : `${TONED}:hover`
		),
		'--row-overlay'
	)!;
const inRangeOverlay = declared(gridRule('.cell.in-range'), 'background')!;
const rowText = declared(gridRule('.cell'), 'color')!;

type GroundState = 'at rest' | 'hover' | 'in the copy range';
const STATES: GroundState[] = ['at rest', 'hover', 'in the copy range'];

/** The ground under a cell of a toned (not selected) row, layer by layer. */
function ground(theme: Theme, tone: Tone, state: GroundState, hue: number): Rgb {
	const surface = paint(theme, 'var(--banto-surface)', hue);
	if (surface.alpha !== 1) throw new Error(`${theme.name}: the grid surface is not opaque`);
	const rest = over(paint(theme, rowToneTokens(tone).tint, hue), surface.rgb);
	if (state === 'hover') return over(paint(theme, hoverOverlay(tone), hue), rest);
	if (state === 'in the copy range') return over(paint(theme, inRangeOverlay, hue), rest);
	return rest;
}

/** Lowest contrast over the whole brand hue sweep. */
function worst(theme: Theme, fg: string, bg: (hue: number) => Rgb) {
	let min = { ratio: Infinity, hue: -1 };
	for (let hue = 0; hue < 360; hue += 1) {
		const ratio = contrast(paint(theme, fg, hue).rgb, bg(hue));
		if (ratio < min.ratio) min = { ratio, hue };
	}
	return min;
}

describe('the grid declares the row tone from theme tokens (#1069)', () => {
	it('paints each tone with its -tint token (neutral: the subtle surface)', () => {
		expect(Object.fromEntries(TONES.map((tone) => [tone, rowToneTokens(tone)]))).toEqual({
			success: { tint: 'var(--banto-success-tint)', band: 'var(--banto-success)' },
			warning: { tint: 'var(--banto-warning-tint)', band: 'var(--banto-warning)' },
			danger: { tint: 'var(--banto-danger-tint)', band: 'var(--banto-danger)' },
			info: { tint: 'var(--banto-info-tint)', band: 'var(--banto-info)' },
			neutral: { tint: 'var(--banto-surface-subtle)', band: 'var(--banto-text-muted)' }
		});
	});

	it('keeps the body text colour on a toned row, and layers the ground', () => {
		expect(rowText).toBe('var(--banto-text)');
		const toned = gridRule(TONED);
		expect(declared(toned, '--row-tint')).toBe('var(--row-tone-tint)');
		expect(declared(toned, 'background')).toBe(
			'linear-gradient(var(--row-overlay, transparent), var(--row-overlay, transparent)), var(--row-tint)'
		);
		// hover takes the tint back towards the (opaque) grid surface
		expect(hoverOverlay('danger')).toMatch(
			/^color-mix\(in srgb, var\(--banto-surface\) \d+%, transparent\)$/
		);
		expect(hoverOverlay('neutral')).toBe('var(--banto-surface-hover)');
	});

	it('repeats the tint under the pinned cells, over the opaque surface', () => {
		expect(declared(gridRule('.cell.pinned,\n\t.select-cell.pinned'), 'background')).toBe(
			'linear-gradient(var(--cell-overlay, transparent), var(--cell-overlay, transparent)), ' +
				'linear-gradient(var(--row-overlay, transparent), var(--row-overlay, transparent)), ' +
				'linear-gradient(var(--row-tint, transparent), var(--row-tint, transparent)), ' +
				'var(--banto-surface)'
		);
	});

	it('switches the coloured text of a toned row to the colours made for a tint', () => {
		expect(declared(gridRule(`${TONED} .cell[data-tone]`), 'color')).toBe('var(--cell-tint-text)');
		expect(declared(gridRule(`${TONED} .cell[data-tone='neutral']`), 'color')).toBe(rowText);
		expect(declared(gridRule(`${TONED} .cell-link`), 'color')).toBe(rowText);
		expect(declared(gridRule(`${TONED} .cell-link`), 'text-decoration')).toBe('underline');
		expect(declared(gridRule(`${TONED} .cell-badge`), 'background')).toBe('var(--banto-surface)');
		expect(declared(gridRule('.cell-badge'), 'color')).toBe(
			'var(--cell-tint-text, var(--banto-text-muted))'
		);
		for (const state of ['success', 'warning', 'danger', 'info']) {
			expect(declared(gridRule(`.cell[data-tone='${state}']`), '--cell-tint-text')).toBe(
				`var(--banto-${state}-tint-text)`
			);
		}
	});

	it('Glass restyles nothing the row tone reads, except the opaque grid surface', () => {
		for (const token of [
			'--banto-text',
			'--banto-text-muted',
			'--banto-primary',
			'--banto-surface-subtle',
			'--banto-surface-hover',
			'--banto-neutral-\\d+',
			'--banto-(?:success|warning|danger|info)(?:-tint|-tint-text)?'
		]) {
			expect(glassCss, token).not.toMatch(new RegExp(String.raw`${token}:`));
		}
		expect(declared(GLASS_GRID_LIGHT, '--banto-surface')).toBe(declared(LIGHT, '--banto-surface'));
		expect(declared(GLASS_GRID_DARK, '--banto-surface')).toBe(declared(DARK, '--banto-surface'));
	});
});

describe('text on a toned row >= 4.5:1 in light / dark / Glass, at every --banto-brand-hue', () => {
	for (const theme of THEMES) {
		for (const tone of TONES) {
			for (const state of STATES) {
				it(`${theme.name}: body text on a ${tone} row, ${state}`, () => {
					const { ratio, hue } = worst(theme, rowText, (h) => ground(theme, tone, state, h));
					expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(4.5);
				});
			}
			// A cell's own tone (`GridColumn.tone`) on the row's tone: every pair.
			for (const cellTone of ['success', 'warning', 'danger', 'info']) {
				for (const state of ['at rest', 'hover'] as const) {
					it(`${theme.name}: ${cellTone} cell text on a ${tone} row, ${state}`, () => {
						const { ratio, hue } = worst(theme, `var(--banto-${cellTone}-tint-text)`, (h) =>
							ground(theme, tone, state, h)
						);
						expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(4.5);
					});
				}
			}
		}
	}

	// The badge of a toned row is a pill of the plain surface (its text keeps
	// the badge colours: the -tint-text of its tone, or the muted text).
	for (const theme of THEMES) {
		for (const text of [
			...['success', 'warning', 'danger', 'info'].map((s) => `var(--banto-${s}-tint-text)`),
			'var(--banto-text-muted)'
		]) {
			it(`${theme.name}: badge text ${text} on the surface pill`, () => {
				const { ratio, hue } = worst(
					theme,
					text,
					(h) => paint(theme, 'var(--banto-surface)', h).rgb
				);
				expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	it('hover never lowers the contrast of the body text (the ground only gets paler)', () => {
		for (const theme of THEMES) {
			for (const tone of TONES.filter((t) => t !== 'neutral')) {
				for (const hue of [0, 90, 180, 258, 300]) {
					const fg = paint(theme, rowText, hue).rgb;
					expect(contrast(fg, ground(theme, tone, 'hover', hue))).toBeGreaterThanOrEqual(
						contrast(fg, ground(theme, tone, 'at rest', hue))
					);
				}
			}
		}
	});
});

describe('the band of a selected toned row >= 3:1 on the selection ground', () => {
	const selected = declared(gridRule('.row.selected'), '--row-overlay')!;
	const selectedHover = declared(gridRule('.row.selected:hover'), '--row-overlay')!;

	it('draws the band on the checkbox cell in the tone colour', () => {
		expect(declared(gridRule('.row.selected[data-row-tone] > .select-cell'), 'box-shadow')).toBe(
			'inset var(--banto-space-1) 0 0 var(--row-tone)'
		);
	});

	for (const theme of THEMES) {
		for (const tone of TONES) {
			it(`${theme.name}: ${tone} band`, () => {
				for (const overlay of [selected, selectedHover]) {
					const { ratio, hue } = worst(theme, rowToneTokens(tone).band, (h) =>
						over(paint(theme, overlay, h), paint(theme, 'var(--banto-surface)', h).rgb)
					);
					expect(ratio, `worst at hue ${hue}`).toBeGreaterThanOrEqual(3);
				}
			});
		}
	}
});
