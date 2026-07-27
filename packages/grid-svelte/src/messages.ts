/**
 * i18n layer 1 (docs/i18n-plan.md §3.2): package-level overridable UI string
 * bundle for @banto/grid-svelte's Svelte components (FilterPopover,
 * HeaderCell, BantoGrid). Mirrors @banto/forms' `validate.ts` convention -
 * every message is a function (parameterized ones take the relevant
 * arguments, static ones take none) so callers always call `t.key(...)`
 * uniformly; `defaultGridMessages` holds the current Japanese literals
 * verbatim, so passing nothing reproduces today's output exactly.
 */

export interface GridMessages {
	/** FilterPopover's TEXT_OPS 'contains' operator label. */
	filterOpContains?: () => string;
	/** FilterPopover's TEXT_OPS 'starts_with' operator label. */
	filterOpStartsWith?: () => string;
	/** FilterPopover's TEXT_OPS 'eq' operator label. */
	filterOpEquals?: () => string;
	/** Filter button/popover aria-label (HeaderCell + FilterPopover), given the column's header text. */
	filterAriaLabel?: (header: string) => string;
	/** FilterPopover's value input placeholder. */
	filterValuePlaceholder?: () => string;
	/** FilterPopover's apply button label. */
	filterApply?: () => string;
	/** FilterPopover's clear button label. */
	filterClear?: () => string;
	/** BantoGrid inline-edit error shown when parseCellInput rejects the draft value. */
	inlineEditInvalid?: () => string;
	/** BantoGrid's empty-state message when there are zero rows. */
	emptyState?: () => string;
	/** BantoGrid group header's row-count suffix, given the already-`toLocaleString()`-ed count. */
	groupCountSuffix?: (count: string) => string;
}

export const defaultGridMessages: Required<GridMessages> = {
	filterOpContains: () => '含む',
	filterOpStartsWith: () => 'で始まる',
	filterOpEquals: () => '一致する',
	filterAriaLabel: (header) => `${header}の絞り込み`,
	filterValuePlaceholder: () => '値を入力',
	filterApply: () => '適用',
	filterClear: () => 'クリア',
	inlineEditInvalid: () => '入力値が不正です',
	emptyState: () => 'データがありません',
	groupCountSuffix: (count) => `（${count}件）`
};
