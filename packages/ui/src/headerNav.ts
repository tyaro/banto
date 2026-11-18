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

/**
 * One item of a `menu` entry (#663 ①-B): a command, not a link. Rendered as a
 * `MenuItem` of the ui `Menu` (`role="menu"`), never inside the link
 * disclosure - ARIA menu roles and disclosure navigation are not mixed.
 *
 * - `action`: runs `onSelect` and closes the menu (focus goes back to the
 *   button unless `onSelect` moved it somewhere else).
 * - `checkbox`: `role="menuitemcheckbox"` with `aria-checked`; selecting it
 *   calls `onSelect` only and leaves the menu open with focus on the item.
 *   The state lives with the host: flip it in `onSelect`, and the next
 *   `checked` shows even while the menu is open.
 * - `separator`: a divider (`role="separator"`). `id` is only the `{#each}` key.
 *
 * `id` is unique within its menu.
 */
export type HeaderNavMenuItem =
	| {
			kind: 'action';
			id: string;
			label: string;
			/** Decorative, before the label. */
			icon?: UiIconComponent;
			disabled?: boolean;
			danger?: boolean;
			/** Native tooltip (e.g. why a disabled item is unavailable). */
			title?: string;
			onSelect: () => void;
	  }
	| {
			kind: 'checkbox';
			id: string;
			label: string;
			checked: boolean;
			disabled?: boolean;
			title?: string;
			onSelect: () => void;
	  }
	| { kind: 'separator'; id: string };

/**
 * A top-row entry: a single link, a group whose links open in a dropdown, or
 * a menu of commands (#663 ①-B, e.g. a desktop-style "View" menu).
 *
 * A `menu` entry is **pinned** to the top row: it never moves into "more",
 * and its width is reserved before the links are fitted (`fitCount`'s
 * `pinned`). In the insufficient state (§4.9) it hides with the rest of the
 * row, so a host that falls back to a drawer offers the same commands there.
 */
export type HeaderNavEntry =
	| ({ kind: 'link' } & HeaderNavLink)
	| { kind: 'group'; id: string; label: string; items: HeaderNavLink[] }
	| { kind: 'menu'; id: string; label: string; items: HeaderNavMenuItem[] };

/** Whether the entry stays on the top row however narrow the nav is (#663 ①-B). */
export function entryPinned(entry: HeaderNavEntry): boolean {
	return entry.kind === 'menu';
}

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
	/**
	 * Per entry, whether it is pinned (a `menu` entry, #663 ①-B). Pinned
	 * entries always stay: their widths (and a gap each) are taken off
	 * `available` first, and the result counts only the other entries -
	 * how many of them, in order, stay on top. When even the pinned entries
	 * and "more" do not fit, the result is `HEADER_NAV_INSUFFICIENT`.
	 */
	pinned?: readonly boolean[];
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
	const pinned = options.pinned;
	const flow = pinned ? widths.filter((_, i) => pinned[i] !== true) : widths;
	const fixed = pinned ? widths.filter((_, i) => pinned[i] === true) : [];
	const at = (room: number) => fitWithPinned(flow, fixed, room, moreWidth, gap);
	const result = at(available + EPSILON);
	if (
		options.previous === HEADER_NAV_INSUFFICIENT &&
		result !== HEADER_NAV_INSUFFICIENT &&
		at(available + EPSILON - (options.recoverSlack ?? HEADER_NAV_RECOVER_SLACK)) ===
			HEADER_NAV_INSUFFICIENT
	) {
		return HEADER_NAV_INSUFFICIENT;
	}
	return result;
}

function fitWithPinned(
	flow: readonly number[],
	fixed: readonly number[],
	room: number,
	moreWidth: number,
	gap: number
): number {
	if (fixed.length === 0) return fitAt(flow, room, moreWidth, gap);
	const fixedTotal = fixed.reduce((sum, width) => sum + width, 0);
	if (flow.length === 0) {
		// Only pinned entries: no "more" to fall back to.
		return fixedTotal + gap * (fixed.length - 1) <= room ? 0 : HEADER_NAV_INSUFFICIENT;
	}
	// Each pinned entry takes its width and the gap to its neighbour.
	return fitAt(flow, room - fixedTotal - gap * fixed.length, moreWidth, gap);
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
	if (entry.kind === 'menu') return 0;
	return entry.items.reduce((sum, item) => sum + Math.max(item.count ?? 0, 0), 0);
}

/** Whether the entry is, or holds, the current page. */
export function entryActive(entry: HeaderNavEntry): boolean {
	if (entry.kind === 'link') return entry.active === true;
	if (entry.kind === 'menu') return false;
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
		// Pinned, so never moved; skipped should a caller pass one anyway.
		if (entry.kind === 'menu') continue;
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
