/**
 * Types and pure helpers of `HeaderNav`, the nav links laid out in the header
 * row (docs/design/nav-menubar-plan.md §4, §5.1; ADR-0018 §12, phase 6).
 *
 * Kept apart from the component so the overflow arithmetic (§4.4) and the
 * arrow-key moves (§4.7, D3-c) are tested as tables, without a DOM.
 */
import type { UiIconComponent } from './types';

/**
 * One link. `count` is the unread count as a **number** (§4.5): the component
 * caps the badge at "99+", builds the spoken name with `updatesLabel(count)`,
 * and sums the counts for a group / "more" button - a "99+" string could not
 * be summed back.
 */
export interface HeaderNavLink {
	/** Unique among all links and groups of one `HeaderNav`; the `{#each}` key. */
	id: string;
	href: string;
	label: string;
	/** Drawn only inside a dropdown, before the label (D5); decorative. */
	icon?: UiIconComponent;
	/** The current page: `aria-current="page"` on the link, and the active look. */
	active?: boolean;
	/** Unread updates; 0 / undefined shows no badge. */
	count?: number;
}

/** A top-row entry: a single link, or a group whose links open in a dropdown. */
export type HeaderNavEntry =
	| ({ kind: 'link' } & HeaderNavLink)
	| { kind: 'group'; id: string; label: string; items: HeaderNavLink[] };

/** Result of `fitCount` when not even the "more" button fits (§4.9). */
export const HEADER_NAV_INSUFFICIENT = -1;

/**
 * Extra room (px) the nav must have, beyond the "more" button, before an
 * insufficient nav counts as fitting again (§4.9: the shell swaps the nav for
 * the drawer while insufficient; without this margin a width right at the
 * edge would flip it back and forth).
 */
export const HEADER_NAV_RECOVER_SLACK = 16;

/**
 * Sub-pixel tolerance: measured widths are fractional, and a row that sums to
 * `available + 0.01` because of rounding should still count as fitting.
 */
const EPSILON = 0.5;

export interface FitCountOptions {
	/** The previous result; `HEADER_NAV_INSUFFICIENT` turns on the recover slack. */
	previous?: number;
	/** Defaults to `HEADER_NAV_RECOVER_SLACK`. */
	recoverSlack?: number;
}

/**
 * How many top-row entries to show (§4.3, §4.4). `widths` are the entries'
 * measured widths in order, `available` the nav's width, `moreWidth` the
 * "more" button's width and `gap` the space between two items.
 *
 * - Everything fits: `widths.length` (no "more" button).
 * - Otherwise the entries move to "more" from the right end, and the "more"
 *   button's width (and its gap) is taken off first: the largest `k` with
 *   `w[0] + ... + w[k-1] + k * gap + moreWidth <= available`.
 * - Not even the "more" button fits: `HEADER_NAV_INSUFFICIENT` (-1). Coming
 *   back from that state needs `recoverSlack` more px than going into it.
 */
export function fitCount(
	widths: readonly number[],
	available: number,
	moreWidth: number,
	gap: number,
	options: FitCountOptions = {}
): number {
	const result = fitAt(widths, available + EPSILON, moreWidth, gap);
	if (
		options.previous === HEADER_NAV_INSUFFICIENT &&
		result !== HEADER_NAV_INSUFFICIENT &&
		fitAt(
			widths,
			available + EPSILON - (options.recoverSlack ?? HEADER_NAV_RECOVER_SLACK),
			moreWidth,
			gap
		) === HEADER_NAV_INSUFFICIENT
	) {
		return HEADER_NAV_INSUFFICIENT;
	}
	return result;
}

function fitAt(widths: readonly number[], room: number, moreWidth: number, gap: number): number {
	const count = widths.length;
	if (count === 0) return 0;
	const total = widths.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
	if (total <= room) return count;
	if (moreWidth > room) return HEADER_NAV_INSUFFICIENT;
	let used = moreWidth;
	let shown = 0;
	for (const width of widths) {
		if (used + width + gap > room) break;
		used += width + gap;
		shown++;
	}
	return shown;
}

/** Badge text: the count, capped at "99+" (same cap as the sidebar). */
export function headerNavBadgeText(count: number): string {
	return count > 99 ? '99+' : String(count);
}

/** The unread total of the links under an entry (a link: its own count). */
export function entryCount(entry: HeaderNavEntry): number {
	if (entry.kind === 'link') return Math.max(entry.count ?? 0, 0);
	return entry.items.reduce((sum, item) => sum + Math.max(item.count ?? 0, 0), 0);
}

/** Whether the entry is, or holds, the current page. */
export function entryActive(entry: HeaderNavEntry): boolean {
	if (entry.kind === 'link') return entry.active === true;
	return entry.items.some((item) => item.active === true);
}

/** One block of the "more" dropdown: a group under its heading, or loose links. */
export interface HeaderNavSection {
	/** The source group's id, or the first loose link's id. */
	id: string;
	/** Absent for a run of loose links. */
	heading?: string;
	items: HeaderNavLink[];
}

/**
 * The "more" dropdown's content (§4.3, D2-a): the moved entries in their
 * original order, each group under its heading with its links flat, and runs
 * of single links gathered into one block without a heading.
 */
export function overflowSections(entries: readonly HeaderNavEntry[]): HeaderNavSection[] {
	const sections: HeaderNavSection[] = [];
	for (const entry of entries) {
		if (entry.kind === 'group') {
			sections.push({ id: entry.id, heading: entry.label, items: entry.items });
			continue;
		}
		const link: HeaderNavLink = {
			id: entry.id,
			href: entry.href,
			label: entry.label,
			icon: entry.icon,
			active: entry.active,
			count: entry.count
		};
		const last = sections[sections.length - 1];
		if (last && last.heading === undefined) last.items.push(link);
		else sections.push({ id: entry.id, items: [link] });
	}
	return sections;
}

/**
 * Arrow help on the top row (§4.7, D3-c): ArrowLeft / ArrowRight move to the
 * previous / next item and wrap around ("more" counts as an item), Home / End
 * go to the first / last. Returns the index to focus, or `null` when the key is
 * not one of these (let it through). Tab is untouched: every item stays a tab
 * stop (no roving tabindex).
 */
export function topRowTarget(current: number, count: number, key: string): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowRight':
			return current < 0 ? 0 : (current + 1) % count;
		case 'ArrowLeft':
			return current < 0 ? count - 1 : (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

/**
 * Arrow help inside an open dropdown (§4.7): ArrowDown / ArrowUp move to the
 * next / previous link and wrap, Home / End go to the first / last. ArrowLeft
 * and ArrowRight do nothing in the list (`null`; nav-menubar PR-2's default -
 * see the PR's open questions). `current` is -1 when focus is not on a link.
 */
export function listTarget(current: number, count: number, key: string): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowDown':
			return current < 0 ? 0 : (current + 1) % count;
		case 'ArrowUp':
			return current < 0 ? count - 1 : (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
