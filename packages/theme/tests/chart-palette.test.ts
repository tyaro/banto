/**
 * The chart colours of banto.css (#557): the 16 categorical slots, the
 * sequential ramp and the diverging ramp, read from the CSS (not copied here).
 *
 * - Categorical, slots 1..8: under normal vision AND the simulated protanopia /
 *   deuteranopia / tritanopia of Machado, Oliveira & Fernandes 2009 (severity
 *   1.0, applied in linear sRGB), every pair of slots stays at least
 *   `ALL_PAIRS_MIN` apart and every neighbour pair (i, i+1 - the order series
 *   take, spec §6.4 rule 1) at least `NEIGHBOUR_MIN`. The distance is the
 *   Euclidean distance in OKLab (Ottosson; L in 0..1), not CIEDE2000.
 * - Categorical, slots 9..16 (#851): a weaker promise. Any two of 1..16 stay
 *   at least `EXTENDED_PAIRS_MIN` apart under NORMAL vision only (no
 *   neighbour margin, no simulated deficiency, no status colours - see
 *   `EXTENDED_PAIRS_MIN`).
 * - Every categorical slot (1..16) is a graphic object: >= 3:1 (WCAG 1.4.11) against
 *   the surfaces a chart sits on (light: --banto-surface; dark: --banto-surface
 *   and --banto-surface-raised), at every --banto-brand-hue since the neutrals
 *   are tinted by it.
 * - Sequential: OKLab lightness is strictly monotone and contrast against the
 *   surface grows with the step (low value = close to the surface).
 * - Diverging: an odd number of steps, the middle one neutral (no chroma),
 *   lightness moving away from it monotonically and symmetrically on both
 *   sides, and the two sides distinguishable at every step under all four
 *   visions.
 * - Status colours (#795): the first 4 categorical slots stay at least
 *   `STATUS_MIN` away from --banto-warning / --banto-danger / --banto-success
 *   under normal vision, so a limit line or an alarm mark drawn in a status
 *   colour does not read as one of the first pens. Slots 5..8 are not covered
 *   (see `STATUS_MIN`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/css/banto.css', import.meta.url), 'utf8');

function block(selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`banto.css: no rule "${selector}"`);
	const open = css.indexOf('{', start);
	const close = css.indexOf('\n}', open);
	return css.slice(open + 1, close);
}

const THEMES = {
	light: block(':root,\n[data-theme]'),
	dark: block("[data-theme='dark']")
};

type Rgb = [number, number, number];

const NEIGHBOUR_MIN = 0.1;
const ALL_PAIRS_MIN = 0.09;
const DIVERGING_SIDES_MIN = 0.07;
/** Slots 1..8 carry the full checks; 9..16 the weaker ones below (#851). */
const CORE_SLOTS = 8;
const TOTAL_SLOTS = 16;
/**
 * Any two of slots 1..16, normal vision (#851, plan §4.14 / §10 B3).
 *
 * Measured (smallest pair that involves a slot of 9..16):
 *   light  0.092 (8 / 9), then 0.093 (2 / 9), 0.094 (4 / 12)
 *   dark   0.076 (7 / 13), then 0.077 (2 / 15), 0.077 (9 / 12)
 *
 * Not covered, by decision: simulated colour-vision deficiency and the status
 * colours. 16 fixed colours cannot keep the 1..8 margins there; measured
 * smallest pairs are light 0.013 (protanopia 2 / 9, deuteranopia 7 / 11) and
 * dark 0.008 (deuteranopia 7 / 11), and light slot 15 is 0.055 from danger.
 * A chart with 9 or more series must not rely on colour alone (legend, dash,
 * marker).
 */
const EXTENDED_PAIRS_MIN = 0.06;
/**
 * Slots 1..4 against the status colours, normal vision (#795, plan §4.10).
 *
 * The value is `ALL_PAIRS_MIN`: a status colour on a chart must be as far from
 * a series as any two series are from each other. It cannot be much higher
 * without re-ordering the palette: in dark, warning and danger are 0.164 apart
 * and the orange slot 2 sits between them, so about 0.09 from both is the most
 * it can get while the pair checks above still hold (0.094 was the best found).
 *
 * Measured (smallest of the 12 pairs per theme, before -> after #795):
 *   light  0.110 (slot 2 / warning) - unchanged
 *   dark   0.052 (slot 2 / warning) -> 0.092 (slot 2 `#f48815` -> `#ed770e`)
 *
 * Not covered, by decision: slots 5..8 (light slot 8 / warning is 0.045, dark
 * slot 5 / danger 0.095), and simulated colour-vision deficiency - danger and
 * success themselves collapse towards the green and orange slots there (e.g.
 * dark slot 2 / danger 0.047 under deuteranopia), which a small move of one
 * slot cannot repair. Status colours on a chart need a second cue (dash, mark,
 * label) for those readers.
 */
const STATUS_MIN = ALL_PAIRS_MIN;
const STATUS_SLOTS = 4;
const STATUS_COLOURS = ['warning', 'danger', 'success'] as const;

/** Every `--{prefix}-N: #rrggbb;` of a rule, in N order (must be 1..count without gaps). */
function hexSteps(rules: string, prefix: string): string[] {
	const found = new Map<number, string>();
	for (const m of rules.matchAll(
		new RegExp(String.raw`--${prefix}-(\d+):\s*(#[0-9a-fA-F]{6})\s*;`, 'g')
	))
		found.set(Number(m[1]), m[2]);
	const out: string[] = [];
	for (let i = 1; found.has(i); i++) out.push(found.get(i)!);
	if (out.length !== found.size) throw new Error(`banto.css: --${prefix}-N has gaps`);
	return out;
}

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** #rrggbb -> linear sRGB. */
function hexToLinear(hex: string): Rgb {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => decode(v / 255)) as Rgb;
}

/** oklch (with the brand hue) -> 8-bit-rounded linear sRGB, clipped like contrast.test.ts. */
function oklchToLinear(l0: number, c: number, hueDeg: number): Rgb {
	const h = (hueDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l = (l0 + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (l0 - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (l0 - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	].map((v) => {
		const x = Math.min(1, Math.max(0, v));
		const enc = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
		return decode(Math.round(enc * 255) / 255);
	}) as Rgb;
}

function toOklab([r, g, b]: Rgb): Rgb {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	];
}

const deltaE = (x: Rgb, y: Rgb) => {
	const [p, q] = [toOklab(x), toOklab(y)];
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(x: Rgb, y: Rgb): number {
	const [hi, lo] = [luminance(x), luminance(y)].sort((u, v) => v - u);
	return (hi + 0.05) / (lo + 0.05);
}

/** Machado et al. 2009, severity 1.0 (linear sRGB -> linear sRGB). */
const VISIONS: Record<string, number[][] | null> = {
	normal: null,
	protanopia: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998]
	],
	deuteranopia: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881]
	],
	tritanopia: [
		[1.255528, -0.076749, -0.178779],
		[-0.078411, 0.930809, 0.147602],
		[0.004733, 0.691367, 0.3039]
	]
};

function simulate(matrix: number[][] | null, c: Rgb): Rgb {
	if (!matrix) return c;
	return matrix.map((row) =>
		Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))
	) as Rgb;
}

/** `--banto-neutral-N: oklch(L C var(--banto-brand-hue))` of a rule. */
function neutral(rules: string, n: number): (hue: number) => Rgb {
	const m = new RegExp(
		String.raw`--banto-neutral-${n}:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+var\(--banto-brand-hue\)\s*\)`
	).exec(rules);
	if (!m) throw new Error(`banto.css: --banto-neutral-${n} is not oklch(L C <brand hue>)`);
	return (hue) => oklchToLinear(Number(m[1]), Number(m[2]), hue);
}

/** `--banto-{name}: oklch(L C H)` of a rule (a fixed hue, not the brand hue). */
function statusColour(rules: string, name: string): Rgb {
	const m = new RegExp(
		String.raw`--banto-${name}:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)`
	).exec(rules);
	if (!m) throw new Error(`banto.css: --banto-${name} is not oklch(L C H)`);
	return oklchToLinear(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** The surfaces a chart sits on (--banto-surface, and raised where it differs). */
const SURFACES: Record<keyof typeof THEMES, ((hue: number) => Rgb)[]> = {
	light: [neutral(THEMES.light, 1)],
	dark: [neutral(THEMES.dark, 2), neutral(THEMES.dark, 4)]
};

it('the surfaces are the neutrals the test assumes', () => {
	expect(THEMES.light).toMatch(/--banto-surface:\s*var\(--banto-neutral-1\)/);
	expect(THEMES.dark).toMatch(/--banto-surface:\s*var\(--banto-neutral-2\)/);
	expect(THEMES.dark).toMatch(/--banto-surface-raised:\s*var\(--banto-neutral-4\)/);
});

it('the colour helpers match known values', () => {
	expect(deltaE([1, 1, 1], [0, 0, 0])).toBeCloseTo(1, 3);
	expect(contrast(hexToLinear('#ffffff'), hexToLinear('#000000'))).toBeCloseTo(21, 5);
	// A grey is unchanged by every simulation (the rows of each matrix sum to 1).
	for (const m of Object.values(VISIONS)) {
		const g = simulate(m, [0.5, 0.5, 0.5]);
		for (const v of g) expect(v).toBeCloseTo(0.5, 3);
	}
});

for (const [theme, rules] of Object.entries(THEMES) as [keyof typeof THEMES, string][]) {
	describe(`${theme}: categorical --banto-chart-1..8`, () => {
		const slots = hexSteps(rules, 'banto-chart').slice(0, CORE_SLOTS);
		it('has exactly 8 slots', () => expect(slots).toHaveLength(8));

		for (const [vision, matrix] of Object.entries(VISIONS)) {
			const seen = slots.map((h) => simulate(matrix, hexToLinear(h)));
			it(`${vision}: neighbours >= ${NEIGHBOUR_MIN}, all pairs >= ${ALL_PAIRS_MIN} (OKLab)`, () => {
				for (let i = 0; i < seen.length; i++)
					for (let j = i + 1; j < seen.length; j++) {
						const d = deltaE(seen[i], seen[j]);
						const min = j === i + 1 ? NEIGHBOUR_MIN : ALL_PAIRS_MIN;
						expect(d, `slots ${i + 1} and ${j + 1}`).toBeGreaterThanOrEqual(min);
					}
			});
		}

		it('every slot is >= 3:1 on the surface at every --banto-brand-hue', () => {
			for (const [i, hex] of slots.entries()) {
				const fg = hexToLinear(hex);
				for (const bg of SURFACES[theme])
					for (let hue = 0; hue < 360; hue++)
						expect(contrast(fg, bg(hue)), `slot ${i + 1} at hue ${hue}`).toBeGreaterThanOrEqual(3);
			}
		});
	});

	describe(`${theme}: categorical --banto-chart-1..${TOTAL_SLOTS} (#851)`, () => {
		const slots = hexSteps(rules, 'banto-chart');
		it(`has exactly ${TOTAL_SLOTS} slots`, () => expect(slots).toHaveLength(TOTAL_SLOTS));

		it(`normal vision: all pairs >= ${EXTENDED_PAIRS_MIN} (OKLab)`, () => {
			const seen = slots.map(hexToLinear);
			for (let i = 0; i < seen.length; i++)
				for (let j = i + 1; j < seen.length; j++)
					expect(deltaE(seen[i], seen[j]), `slots ${i + 1} and ${j + 1}`).toBeGreaterThanOrEqual(
						EXTENDED_PAIRS_MIN
					);
		});

		it(`slots ${CORE_SLOTS + 1}..${TOTAL_SLOTS} are >= 3:1 on the surface at every --banto-brand-hue`, () => {
			for (const [i, hex] of slots.entries()) {
				if (i < CORE_SLOTS) continue;
				const fg = hexToLinear(hex);
				for (const bg of SURFACES[theme])
					for (let hue = 0; hue < 360; hue++)
						expect(contrast(fg, bg(hue)), `slot ${i + 1} at hue ${hue}`).toBeGreaterThanOrEqual(3);
			}
		});
	});

	describe(`${theme}: --banto-chart-1..${STATUS_SLOTS} against the status colours`, () => {
		const slots = hexSteps(rules, 'banto-chart').slice(0, STATUS_SLOTS).map(hexToLinear);
		for (const name of STATUS_COLOURS)
			it(`${name}: every slot >= ${STATUS_MIN} (OKLab, normal vision)`, () => {
				const status = statusColour(rules, name);
				for (const [i, slot] of slots.entries())
					expect(deltaE(slot, status), `slot ${i + 1}`).toBeGreaterThanOrEqual(STATUS_MIN);
			});
	});

	describe(`${theme}: sequential --banto-chart-seq-N`, () => {
		const steps = hexSteps(rules, 'banto-chart-seq').map(hexToLinear);
		it('has at least 5 steps', () => expect(steps.length).toBeGreaterThanOrEqual(5));
		it('lightness is strictly monotone', () => {
			const l = steps.map((c) => toOklab(c)[0]);
			const sign = Math.sign(l[1] - l[0]);
			expect(sign).not.toBe(0);
			for (let i = 1; i < l.length; i++)
				expect(Math.sign(l[i] - l[i - 1]), `step ${i + 1}`).toBe(sign);
		});
		it('contrast against the surface grows with the step', () => {
			const bg = SURFACES[theme][0](258);
			for (let i = 1; i < steps.length; i++)
				expect(contrast(steps[i], bg), `step ${i + 1}`).toBeGreaterThan(contrast(steps[i - 1], bg));
		});
	});

	describe(`${theme}: diverging --banto-chart-div-N`, () => {
		const steps = hexSteps(rules, 'banto-chart-div').map(hexToLinear);
		const mid = (steps.length - 1) / 2;
		it('has an odd number (>= 5) of steps', () => {
			expect(steps.length).toBeGreaterThanOrEqual(5);
			expect(steps.length % 2).toBe(1);
		});
		it('the middle step is neutral', () => {
			const [, a, b] = toOklab(steps[mid]);
			expect(Math.hypot(a, b)).toBeLessThan(0.005);
		});
		it('lightness moves away from the middle monotonically and symmetrically', () => {
			const l = steps.map((c) => toOklab(c)[0]);
			const dir = Math.sign(l[mid + 1] - l[mid]);
			expect(dir).not.toBe(0);
			for (let k = 1; k <= mid; k++) {
				expect(Math.sign(l[mid + k] - l[mid + k - 1]), `right step ${k}`).toBe(dir);
				expect(Math.sign(l[mid - k] - l[mid - k + 1]), `left step ${k}`).toBe(dir);
				expect(Math.abs(l[mid + k] - l[mid - k]), `symmetry at ${k}`).toBeLessThan(0.02);
			}
		});
		for (const [vision, matrix] of Object.entries(VISIONS)) {
			it(`${vision}: the two sides stay apart at every step`, () => {
				for (let k = 1; k <= mid; k++) {
					const d = deltaE(simulate(matrix, steps[mid - k]), simulate(matrix, steps[mid + k]));
					expect(d, `step ${k} from the middle`).toBeGreaterThanOrEqual(DIVERGING_SIDES_MIN);
				}
			});
		}
	});
}
