/**
 * Pieces of `ReferenceField` that need no component: the debounce constant,
 * the texts (i18n layer 1, conventions §13) and the placement of the list.
 *
 * The placement is a small package-local take on what `@banto/ui`'s pickers
 * do (below the input, above when there is more room there, capped to the
 * room): forms imports no other package (conventions §4).
 */
import type { FieldDef } from '../types';

/** Milliseconds a `reference` field waits after the last keystroke before it searches. */
export const REFERENCE_SEARCH_DEBOUNCE_MS = 250;

/** Texts of a `reference` field. Every one is shown and read out (`role="status"`), except `listLabel`. */
export interface ReferenceFieldMessages {
	/** A search is running. */
	loading: () => string;
	/** The search returned nothing; `query` is the text searched for. */
	noResults: (query: string) => string;
	/** Read out when candidates arrive (not shown: the list itself is). */
	resultCount: (count: number) => string;
	/** `FieldDef.search` rejected; `error` is what it rejected with. */
	searchFailed: (error: unknown) => string;
	/** Accessible name of the list of candidates. */
	listLabel: (def: FieldDef) => string;
}

export const defaultReferenceFieldMessages: ReferenceFieldMessages = {
	loading: () => '検索中…',
	noResults: () => '該当する候補がありません',
	resultCount: (count) => `${count} 件の候補`,
	searchFailed: () => '候補を取得できませんでした',
	listLabel: (def) => `${def.label}の候補`
};

/** No reference chosen: `null` (the empty value), `undefined` or `''`. */
export function isBlankReference(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

/** Distance between the input and the list, and the list and the viewport edges (px). */
const GAP = 4;

/**
 * Put `list` (a `position: fixed` element in the top layer, `box-sizing:
 * border-box`) next to `anchor`: as wide as it, below it - or above when the
 * list does not fit below and there is more room above - and never taller
 * than the room on that side (it scrolls inside).
 */
export function placeReferenceList(anchor: Element, list: HTMLElement): void {
	const scrollTop = list.scrollTop;
	list.style.removeProperty('max-height');
	const box = anchor.getBoundingClientRect();
	const natural = list.getBoundingClientRect().height;
	const viewport = document.documentElement.clientHeight;
	const below = Math.max(viewport - box.bottom - 2 * GAP, 0);
	const above = Math.max(box.top - 2 * GAP, 0);
	const up = natural > below && above > below;
	const room = up ? above : below;
	const height = Math.min(natural, room);
	if (height < natural) list.style.maxHeight = `${height}px`;
	list.style.top = `${up ? box.top - GAP - height : box.bottom + GAP}px`;
	list.style.left = `${box.left}px`;
	list.style.width = `${box.width}px`;
	list.scrollTop = scrollTop;
}

/** Scroll `list` itself (never an ancestor) so `option` is inside its visible box. */
export function revealReferenceOption(list: HTMLElement, option: HTMLElement): void {
	const top = option.offsetTop;
	const bottom = top + option.offsetHeight;
	if (top < list.scrollTop) list.scrollTop = top;
	else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
