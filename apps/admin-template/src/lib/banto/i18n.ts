/**
 * i18n layer ② bridge (docs/conventions.md §13, ADR-0005, PR-B2): builds the
 * `messages` override bundles that the `@banto/*` packages accept (i18n layer
 * ①), sourcing every string from Paraglide (`$lib/paraglide/messages`).
 *
 * **App layer ONLY.** The packages stay i18n-agnostic: they declare a
 * `Partial<…Messages>` prop whose defaults reproduce today's Japanese output,
 * and the app hands them already-resolved strings here (conventions §4/§5 —
 * no `$lib` import or dictionary ever enters a package). Each entry is a thin
 * closure so the Paraglide message is resolved lazily at call time (render /
 * validation), keeping it reactive to the active locale.
 */
import type { GridMessages, ColumnValidationMessages } from '@banto/grid-svelte';
import type { ValidationMessages } from '@banto/forms';
import type { TreeMessages } from '@banto/tree-svelte';
import * as m from '$lib/paraglide/messages';

/** @banto/grid-svelte `messages` prop: FilterPopover / HeaderCell / BantoGrid / ColumnsMenu strings. */
export function gridMessages(): Partial<GridMessages> {
	return {
		filterOpContains: () => m['grid.filterContains'](),
		filterOpStartsWith: () => m['grid.filterStartsWith'](),
		filterOpEquals: () => m['grid.filterEquals'](),
		filterAriaLabel: (header) => m['grid.filterAriaLabel']({ header }),
		filterValuePlaceholder: () => m['grid.filterValuePlaceholder'](),
		filterApply: () => m['grid.filterApply'](),
		filterClear: () => m['grid.filterClear'](),
		inlineEditInvalid: () => m['grid.inlineEditInvalid'](),
		emptyState: () => m['items.list.empty'](),
		groupCountSuffix: (count) => m['grid.groupCountSuffix']({ count }),
		columnsMenuButton: () => m['grid.columnsMenuButton'](),
		columnsMenuTitle: () => m['grid.columnsMenuTitle'](),
		columnsMenuCount: (visible, total) => m['grid.columnsMenuCount']({ visible, total }),
		columnsMenuLastColumn: () => m['grid.columnsMenuLastColumn']()
	};
}

/** @banto/forms `ValidationMessages` (createFormStore): schema-form validation copy. */
export function formValidationMessages(): ValidationMessages {
	return {
		required: () => m['validation.required'](),
		min: (_def, min) => m['validation.min']({ min }),
		max: (_def, max) => m['validation.max']({ max }),
		minLength: (_def, min) => m['validation.minLength']({ min }),
		maxLength: (_def, max) => m['validation.maxLength']({ max }),
		pattern: () => m['validation.pattern']()
	};
}

/** @banto/grid-svelte `ColumnValidationMessages` (columnsFromSchema): inline-edit validation copy, kept in lockstep with {@link formValidationMessages}. */
export function columnValidationMessages(): ColumnValidationMessages {
	return {
		required: () => m['validation.required'](),
		min: (_field, min) => m['validation.min']({ min }),
		max: (_field, max) => m['validation.max']({ max }),
		minLength: (_field, min) => m['validation.minLength']({ min }),
		maxLength: (_field, max) => m['validation.maxLength']({ max }),
		pattern: () => m['validation.pattern']()
	};
}

/**
 * `@banto/tree-svelte` `messages` prop: BantoTree aria strings + TreeSelect's
 * two extra keys (placeholder / selectedCount). One bundle for both — BantoTree
 * ignores the two select-only keys, TreeSelect uses them (the return type widens
 * `Partial<TreeMessages>` since TreeSelectMessages isn't exported).
 */
export function treeMessages(): Partial<TreeMessages> & {
	placeholder?: () => string;
	selectedCount?: (n: number) => string;
} {
	return {
		expand: (label) => m['tree.expand']({ label }),
		collapse: (label) => m['tree.collapse']({ label }),
		checkbox: (label) => m['tree.checkbox']({ label }),
		loading: () => m['tree.loading'](),
		loadError: () => m['tree.loadError'](),
		empty: () => m['tree.empty'](),
		rename: (label) => m['tree.rename']({ label }),
		nameColumn: () => m['tree.nameColumn'](),
		placeholder: () => m['tree.selectPlaceholder'](),
		selectedCount: (n) => m['tree.selectedCount']({ n })
	};
}
