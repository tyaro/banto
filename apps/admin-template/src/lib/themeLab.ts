/**
 * Pure logic of the theme lab (`/theme-lab`, Issue #690): the knobs, the
 * CSS the page exports, the preview's inline style, and the contrast ratios
 * shown next to the hue slider. No DOM, no Svelte - the page only binds it.
 *
 * The defaults and the colour steps below mirror `packages/theme/src/css/
 * banto.css`; `themeLab.test.ts` reads that file and fails when they drift.
 */

export type LabTheme = 'light' | 'dark';
export type LabDensity = 'standard' | 'compact' | 'touch';

export const DEFAULT_HUE = 258;
export const DEFAULT_RADIUS = { sm: 4, md: 6, lg: 10 } as const;
export const MAX_RADIUS_MD = 16;

/** `--banto-font-family` of banto.css (the "system" choice exports nothing). */
export const DEFAULT_FONT_STACK =
	"system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif";

export type LabFontId = 'system' | 'gothic' | 'mincho' | 'rounded' | 'mono';

/** Stacks of fonts that ship with the OS (Windows / macOS / Linux); no font file is bundled (#557). */
export const LAB_FONTS: readonly { id: LabFontId; stack: string }[] = [
	{ id: 'system', stack: DEFAULT_FONT_STACK },
	{
		id: 'gothic',
		stack: "'Hiragino Sans', 'Yu Gothic UI', 'Meiryo UI', 'Noto Sans JP', sans-serif"
	},
	{
		id: 'mincho',
		stack: "'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif"
	},
	{
		id: 'rounded',
		stack: "ui-rounded, 'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'Meiryo UI', sans-serif"
	},
	{
		id: 'mono',
		stack: "ui-monospace, 'SF Mono', Consolas, 'Cascadia Mono', 'Courier New', monospace"
	}
];

export interface LabState {
	hue: number;
	/** `--banto-radius-md` in px; sm / lg move with it (see `radiusScale`). */
	radiusMd: number;
	density: LabDensity;
	font: LabFontId;
	theme: LabTheme;
}

export const DEFAULT_STATE: LabState = {
	hue: DEFAULT_HUE,
	radiusMd: DEFAULT_RADIUS.md,
	density: 'standard',
	font: 'system',
	theme: 'light'
};

/** A hue is a whole number of degrees, 0..359 (a unit or a fraction would not survive `@property <number>` usefully). */
export function clampHue(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_HUE;
	return Math.min(359, Math.max(0, Math.round(value)));
}

export function clampRadius(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_RADIUS.md;
	return Math.min(MAX_RADIUS_MD, Math.max(0, Math.round(value)));
}

/** sm / md / lg move together; at the default md of 6 this is exactly 4 / 6 / 10. */
export function radiusScale(md: number): { sm: number; md: number; lg: number } {
	const m = clampRadius(md);
	return { sm: Math.round((m * 2) / 3), md: m, lg: Math.round((m * 5) / 3) };
}

function fontStack(id: LabFontId): string {
	return (LAB_FONTS.find((f) => f.id === id) ?? LAB_FONTS[0]).stack;
}

/** The variables that differ from banto.css, in a stable order. */
export function changedVariables(state: LabState): [string, string][] {
	const out: [string, string][] = [];
	if (clampHue(state.hue) !== DEFAULT_HUE)
		out.push(['--banto-brand-hue', String(clampHue(state.hue))]);
	const r = radiusScale(state.radiusMd);
	if (r.sm !== DEFAULT_RADIUS.sm) out.push(['--banto-radius-sm', `${r.sm}px`]);
	if (r.md !== DEFAULT_RADIUS.md) out.push(['--banto-radius-md', `${r.md}px`]);
	if (r.lg !== DEFAULT_RADIUS.lg) out.push(['--banto-radius-lg', `${r.lg}px`]);
	if (state.font !== 'system') out.push(['--banto-font-family', fontStack(state.font)]);
	return out;
}

/** True when nothing differs from the defaults (the page then says so instead of showing an empty rule). */
export function isDefaultState(state: LabState): boolean {
	return (
		changedVariables(state).length === 0 && state.density === 'standard' && state.theme === 'light'
	);
}

/**
 * The CSS to take home: only the variables that changed, in a `:root` rule.
 * Density and theme are not variables (they are `data-*` attributes set by
 * `applyDensity()` / `applyTheme()` from `@banto/theme`), so they come as comments.
 */
export function exportCss(state: LabState): string {
	const lines = changedVariables(state).map(([name, value]) => `\t${name}: ${value};`);
	const out = [`:root {`, ...lines, `}`];
	const notes: string[] = [];
	if (state.density !== 'standard')
		notes.push(`/* density: applyDensity('${state.density}') sets data-banto-density on <html> */`);
	if (state.theme !== 'light')
		notes.push(`/* theme: applyTheme('${state.theme}') sets data-theme on <html> */`);
	return [...out, ...notes].join('\n') + '\n';
}

// --- density --------------------------------------------------------------

/**
 * Every variable that moves along the density axis, with its standard value
 * (the `:root` value of banto.css; `initial` = not set on `:root`, so the
 * component's own fallback applies). The preview sets all of them explicitly,
 * so it does not depend on the density of the shell around it. A test keeps
 * these tables equal to banto.css.
 */
export const STANDARD_DENSITY_VARS: Readonly<Record<string, string>> = {
	'--banto-font-size': '14px',
	'--banto-space-1': '0.25rem',
	'--banto-space-2': '0.5rem',
	'--banto-space-3': '0.75rem',
	'--banto-space-4': '1rem',
	'--banto-space-5': '1.25rem',
	'--banto-space-6': '1.5rem',
	'--banto-space-7': '2rem',
	'--banto-space-8': '3rem',
	'--banto-font-size-xs': '0.8572rem',
	'--banto-font-size-sm': '0.9286rem',
	'--banto-font-size-md': '1rem',
	'--banto-font-size-base': '1rem',
	'--banto-font-size-lg': '1.1429rem',
	'--banto-font-size-xl': '1.4286rem',
	'--banto-font-size-2xl': '2rem',
	'--banto-font-size-3xl': '3.4286rem',
	'--banto-checkbox-size': '1.1rem',
	'--banto-control-height-sm': '28px',
	'--banto-control-height': '36px',
	'--banto-control-height-lg': '40px',
	'--banto-grid-row-height': '36px',
	'--banto-grid-header-height': '40px',
	'--banto-shell-header-height': '48px',
	'--banto-shell-header-height-compact': '40px',
	'--banto-shell-launcher-item-size': '44px',
	'--banto-dock-titlebar-height': '32px',
	'--banto-dock-button-size': 'initial',
	'--banto-tree-toggle-size': 'initial',
	'--banto-dock-guide-button-size': 'initial'
};

/** The `[data-banto-density='compact']` block of banto.css. */
export const COMPACT_DENSITY_VARS: Readonly<Record<string, string>> = {
	'--banto-control-height': '32px',
	'--banto-control-height-lg': '36px',
	'--banto-grid-row-height': '32px',
	'--banto-grid-header-height': '36px',
	'--banto-space-3': '0.5rem',
	'--banto-space-4': '0.75rem',
	'--banto-space-5': '1rem',
	'--banto-space-6': '1.25rem'
};

/** The `[data-banto-density='touch']` block of banto.css. */
export const TOUCH_DENSITY_VARS: Readonly<Record<string, string>> = {
	'--banto-font-size': '16px',
	'--banto-control-height-sm': '40px',
	'--banto-control-height': '48px',
	'--banto-control-height-lg': '52px',
	'--banto-grid-row-height': '52px',
	'--banto-grid-header-height': '56px',
	'--banto-shell-header-height': '56px',
	'--banto-shell-header-height-compact': '48px',
	'--banto-shell-launcher-item-size': '48px',
	'--banto-dock-titlebar-height': '40px',
	'--banto-dock-button-size': 'var(--banto-control-height-sm)',
	'--banto-tree-toggle-size': 'var(--banto-control-height-sm)',
	'--banto-dock-guide-button-size': 'var(--banto-control-height-sm)'
};

/** All density variables of one density (standard values overlaid with its block). */
export function densityVars(density: LabDensity): Record<string, string> {
	const overrides =
		density === 'compact' ? COMPACT_DENSITY_VARS : density === 'touch' ? TOUCH_DENSITY_VARS : {};
	return { ...STANDARD_DENSITY_VARS, ...overrides };
}

/**
 * `1.25rem` -> `calc(1.25 * var(--lab-rem))`. `rem` resolves against the
 * `<html>` of the page (the shell's density), so the preview carries its own
 * base size in `--lab-rem` instead.
 */
function remToLab(value: string): string {
	const m = /^([\d.]+)rem$/.exec(value);
	return m ? `calc(${m[1]} * var(--lab-rem))` : value;
}

/**
 * Inline style of the preview element. It sets every knob explicitly (also at
 * the default) and `--banto-radius`, which banto.css resolves on `:root` to the
 * md value, so a nested override of md alone would not reach it. The density is
 * set the same way: explicit values for every variable of the axis (rem scales
 * through `--lab-rem`), so it holds whatever density the shell has.
 */
export function previewStyle(state: LabState): string {
	const r = radiusScale(state.radiusMd);
	const vars = densityVars(state.density);
	return [
		`--lab-rem: ${vars['--banto-font-size']}`,
		...Object.entries(vars).map(([name, value]) => `${name}: ${remToLab(value)}`),
		`font-size: ${vars['--banto-font-size']}`,
		`--banto-brand-hue: ${clampHue(state.hue)}`,
		`--banto-radius-sm: ${r.sm}px`,
		`--banto-radius-md: ${r.md}px`,
		`--banto-radius-lg: ${r.lg}px`,
		`--banto-radius: ${r.md}px`,
		`--banto-font-family: ${fontStack(state.font)}`
	].join('; ');
}

// --- contrast -------------------------------------------------------------

export interface Oklch {
	l: number;
	c: number;
	/** fixed hue (state colours), or undefined to follow `--banto-brand-hue` + `offset` */
	h?: number;
	offset?: number;
}

export type Rgb = [number, number, number];

/** OKLCH -> sRGB (0..1, rounded to 8 bit). An out-of-gamut component is clipped, like Chrome does. */
export function oklchToSrgb(color: Oklch, brandHue: number): Rgb {
	const hue = color.h ?? brandHue + (color.offset ?? 0);
	const rad = (hue * Math.PI) / 180;
	const a = color.c * Math.cos(rad);
	const b = color.c * Math.sin(rad);
	const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
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

/** WCAG 2 contrast ratio (1..21). */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
	const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

export const MIN_CONTRAST = 4.5;

export type ContrastId =
	| 'onPrimary'
	| 'onPrimaryHover'
	| 'onAccent'
	| 'primaryText'
	| 'danger'
	| 'warning'
	| 'success'
	| 'info';

export interface ContrastRow {
	id: ContrastId;
	ratio: number;
	ok: boolean;
}

const WHITE: Rgb = [1, 1, 1];

/** L / C of the colours that carry text; same numbers as banto.css (checked by the test). */
export const TOKENS = {
	light: {
		primary: { l: 0.5, c: 0.17 },
		primaryHover: { l: 0.44, c: 0.16 },
		accent: { l: 0.5, c: 0.2, offset: 40 },
		surface: { l: 1, c: 0 },
		inverse: null,
		primaryText: null,
		state: {
			danger: { l: 0.572, c: 0.215, h: 27 },
			warning: { l: 0.555, c: 0.132, h: 58 },
			success: { l: 0.525, c: 0.148, h: 149 },
			info: { l: 0.54, c: 0.105, h: 235 }
		}
	},
	dark: {
		primary: { l: 0.66, c: 0.15 },
		primaryHover: { l: 0.74, c: 0.12 },
		accent: { l: 0.7, c: 0.14, offset: 40 },
		surface: { l: 0.245, c: 0.011 },
		/** --banto-text-inverse = dark neutral-1 */
		inverse: { l: 0.2, c: 0.009 },
		/** --banto-primary-text */
		primaryText: { l: 0.74, c: 0.12 },
		state: {
			danger: { l: 0.69, c: 0.199, h: 25 },
			warning: { l: 0.769, c: 0.165, h: 70 },
			success: { l: 0.723, c: 0.192, h: 150 },
			info: { l: 0.72, c: 0.12, h: 235 }
		}
	}
} as const satisfies Record<
	LabTheme,
	{
		primary: Oklch;
		primaryHover: Oklch;
		accent: Oklch;
		surface: Oklch;
		inverse: Oklch | null;
		primaryText: Oklch | null;
		state: Record<'danger' | 'warning' | 'success' | 'info', Oklch>;
	}
>;

/** dark `--banto-neutral-4` (raised surface), where `--banto-primary-text` is read */
const DARK_RAISED: Oklch = { l: 0.285, c: 0.013 };

/**
 * Contrast of the text pairs that move with the brand hue (and of the state
 * colours on the hue-tinted surface), for the chosen theme.
 */
export function contrastRows(theme: LabTheme, hue: number): ContrastRow[] {
	const t = TOKENS[theme];
	const h = clampHue(hue);
	const fg = t.inverse ? oklchToSrgb(t.inverse, h) : WHITE;
	const surface = oklchToSrgb(t.surface, h);
	const rows: [ContrastId, Rgb, Rgb][] = [
		['onPrimary', fg, oklchToSrgb(t.primary, h)],
		['onPrimaryHover', fg, oklchToSrgb(t.primaryHover, h)],
		['onAccent', fg, oklchToSrgb(t.accent, h)]
	];
	if (t.primaryText)
		rows.push(['primaryText', oklchToSrgb(t.primaryText, h), oklchToSrgb(DARK_RAISED, h)]);
	for (const state of ['danger', 'warning', 'success', 'info'] as const)
		rows.push([state, oklchToSrgb(t.state[state], h), surface]);
	return rows.map(([id, a, b]) => {
		const ratio = contrastRatio(a, b);
		return { id, ratio, ok: ratio >= MIN_CONTRAST };
	});
}
