import type { Snippet } from 'svelte';
import type { UiMessages } from './messages';

/**
 * ThreePaneLayout (Issue #631 PR-1): the frame of a "pick a target on the
 * left, work on it in the middle, see the selected row's details on the right"
 * page. The frame owns the layout only - every pane's content comes in as a
 * snippet and must not depend on the frame (no context, no frame types), so
 * the same parts can later be laid out by `@banto/dock-svelte` instead.
 *
 * Widths are CSS pixels. The bound `leftWidth` / `rightWidth` are what the
 * user asked for (the app may persist them); what is shown can be narrower
 * while the frame is too small to keep the centre at `centerMinWidth`
 * ({@link fitPaneWidths}) - widening the window brings the asked-for width
 * back without anyone writing it.
 */
export interface ThreePaneLayoutProps {
	/** Left pane (the target picker: a tree, a list). Omitted = no left pane and no left toggle. */
	left?: Snippet;
	/** Right pane (the selected row's details). Omitted = no right pane and no right toggle. */
	right?: Snippet;
	/** Centre body (tabs and the like). */
	children: Snippet;
	/** Name of the selected target, shown in the band above the centre. Kept while a narrow drawer is closed. */
	title?: string;
	/** Replaces `title` in the band (a name with a badge, a breadcrumb). */
	titleContent?: Snippet;
	/** Asked-for left pane width in px (bindable; persisting it is the app's job). Default 280. */
	leftWidth?: number;
	/** Asked-for right pane width in px (bindable). Default 360. */
	rightWidth?: number;
	/** Default 200. */
	leftMinWidth?: number;
	/** Default 480. */
	leftMaxWidth?: number;
	/** Default 240. */
	rightMinWidth?: number;
	/** Default 640. */
	rightMaxWidth?: number;
	/** The side panes shrink (right first, down to their minimums) before the centre gets narrower than this. Default 320. */
	centerMinWidth?: number;
	/** Wide layout: the left pane is folded away (bindable). Default `false`. */
	leftCollapsed?: boolean;
	/** Wide layout: the right pane is folded away (bindable). Default `false`. */
	rightCollapsed?: boolean;
	/** Narrow layout: the left drawer is open (bindable - e.g. close it after a pick). Default `false`. */
	leftDrawerOpen?: boolean;
	/** Narrow layout: the right drawer is open (bindable). Default `false`. */
	rightDrawerOpen?: boolean;
	/**
	 * The frame's own width (not the viewport's) at or below which the side
	 * panes become drawers over the centre. Default 900.
	 */
	narrowBreakpoint?: number;
	/** Output (bindable): whether the narrow layout is in effect. Setting it does nothing. */
	narrow?: boolean;
	/** Arrow-key step of the resize handles in px. Default 16. */
	resizeStep?: number;
	/**
	 * Text overrides (layer 1 i18n): `threePaneLeft` / `threePaneRight` (the
	 * panes' and toggles' names), `threePaneResizeLeft` / `threePaneResizeRight`
	 * (the handles'). Defaults: `defaultUiMessages`.
	 */
	messages?: UiMessages;
}

export const THREE_PANE_DEFAULTS = {
	leftWidth: 280,
	rightWidth: 360,
	leftMinWidth: 200,
	leftMaxWidth: 480,
	rightMinWidth: 240,
	rightMaxWidth: 640,
	centerMinWidth: 320,
	narrowBreakpoint: 900,
	resizeStep: 16
} as const;

/**
 * `value` kept within `[min, max]`. A non-finite value becomes `min`; a `max`
 * below `min` counts as `min` (the minimum wins).
 */
export function clampPaneWidth(value: number, min: number, max: number): number {
	const lo = Number.isFinite(min) ? Math.max(0, min) : 0;
	const hi = Number.isFinite(max) ? Math.max(lo, max) : lo;
	if (!Number.isFinite(value)) return lo;
	return Math.min(hi, Math.max(lo, value));
}

export interface PaneFitInput {
	/** Frame width in px; `null` / `0` = not measured yet (nothing is fitted). */
	available: number | null;
	/** Left width to show (already clamped), or `0` when the left pane is not in the row. */
	left: number;
	/** Right width to show, or `0`. */
	right: number;
	leftMin: number;
	rightMin: number;
	centerMin: number;
}

/**
 * Widths to show so the centre keeps `centerMin`: the right pane gives way
 * first, then the left, each down to its minimum. When even the minimums do
 * not fit, the panes stay at their minimums and the centre takes what is left
 * (it never goes below 0 - the centre is `min-width: 0`).
 */
export function fitPaneWidths(input: PaneFitInput): { left: number; right: number } {
	let { left, right } = input;
	const { available } = input;
	if (available === null || !(available > 0)) return { left, right };
	let excess = left + right + input.centerMin - available;
	if (excess <= 0) return { left, right };
	if (right > 0) {
		const give = Math.min(excess, Math.max(0, right - input.rightMin));
		right -= give;
		excess -= give;
	}
	if (excess > 0 && left > 0) {
		const give = Math.min(excess, Math.max(0, left - input.leftMin));
		left -= give;
	}
	return { left, right };
}

/**
 * Largest width one side may take now: its own maximum, or what is left after
 * the other side's shown width and the centre's minimum - never below its own
 * minimum (the handle's `aria-valuemax`, the cap of a drag and of End).
 */
export function paneMaxWidth(options: {
	available: number | null;
	max: number;
	min: number;
	other: number;
	centerMin: number;
}): number {
	const { available, max, min, other, centerMin } = options;
	const hi = Math.max(min, max);
	if (available === null || !(available > 0)) return hi;
	return Math.max(min, Math.min(hi, available - other - centerMin));
}

/** Is a frame `width` px wide narrow? `null` / `0` (not measured, or not laid out) is not. */
export function isNarrowWidth(width: number | null, breakpoint: number): boolean {
	return width !== null && width > 0 && width <= breakpoint;
}
