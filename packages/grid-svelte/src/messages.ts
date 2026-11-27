/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
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
	/**
	 * Name of the filter button in a column header (HeaderCell). No column name in it (#1035):
	 * the button sits in its `columnheader`, which already has that name, and a screen reader
	 * reading the header row would say the column name twice.
	 */
	filterButtonLabel?: () => string;
	/** FilterPopover's dialog aria-label, given the column's header text. */
	filterAriaLabel?: (header: string) => string;
	/** Applied-filter state description, independent of the popover's open state. */
	filterAppliedDescription?: (header: string) => string;
	/** FilterPopover's value input placeholder. */
	filterValuePlaceholder?: () => string;
	/** Accessible name of FilterPopover's operator select. */
	filterOperatorLabel?: () => string;
	/** Accessible name of FilterPopover's value input. */
	filterValueLabel?: () => string;
	/** FilterPopover's apply button label. */
	filterApply?: () => string;
	/** FilterPopover's clear button label. */
	filterClear?: () => string;
	/** FilterPopover: accessible name of the day range of a date / date-and-time column. */
	filterRangeLabel?: () => string;
	/** FilterPopover: the native start-day input's name (the injected `DateRangeInput` names its own). */
	filterRangeStart?: () => string;
	/** FilterPopover: the native end-day input's name. */
	filterRangeEnd?: () => string;
	/** FilterPopover: a range end is not a date. */
	filterRangeInvalid?: () => string;
	/** FilterPopover: the end day is before the start day. */
	filterRangeOrder?: () => string;
	/** BantoGrid inline-edit error shown when parseCellInput rejects the draft value. */
	inlineEditInvalid?: () => string;
	/** Name of the keyboard-readable error region for a column. */
	inlineEditErrorLabel?: (header: string) => string;
	/** Explains reading an error without retrying the save. */
	inlineEditErrorHint?: () => string;
	/** BantoGrid's empty-state message when there are zero rows. */
	emptyState?: () => string;
	/** BantoGrid group header's row-count suffix, given the already-`toLocaleString()`-ed count. */
	groupCountSuffix?: (count: string) => string;
	/** ColumnsMenu's trigger button label (spec §4.4). */
	columnsMenuButton?: () => string;
	/** ColumnsMenu's popover aria-label (spec §4.4). */
	columnsMenuTitle?: () => string;
	/** ColumnsMenu's visible/total counter next to the trigger label, given both counts. */
	columnsMenuCount?: (visible: number, total: number) => string;
	/** ColumnsMenu's tooltip on the last remaining visible column's (disabled) checkbox. */
	columnsMenuLastColumn?: () => string;
	/**
	 * ColumnsMenu's pin toggle (#713): the button's accessible name, given the
	 * column's header text. The name stays the same in both states - the state
	 * is carried by `aria-pressed` - and is the tooltip while the column is not
	 * pinned.
	 */
	pinColumn?: (header: string) => string;
	/** ColumnsMenu's pin toggle (#713): the tooltip while the column is pinned (what a click does next). */
	unpinColumn?: (header: string) => string;
	/** FilterChips: accessible name of the group of applied-filter chips. */
	filterChipsLabel?: () => string;
	/** FilterChips: accessible name of a chip's x button, given the column's header text. */
	filterChipRemove?: (header: string) => string;
	/** FilterChips: the "clear all filters" button (shown with two or more filters). */
	filterChipsClearAll?: () => string;
	/** FilterChips: operator word of an `is_null` filter (no value follows). */
	filterChipIsNull?: () => string;
	/** FilterChips: operator word of a `not_null` filter (no value follows). */
	filterChipNotNull?: () => string;
	/** FilterChips: operator word of an `in` filter (the values follow, comma-separated). */
	filterChipIn?: () => string;
	/** FilterChips: separator between the two ends of a `between` (range) filter. */
	filterChipRangeSeparator?: () => string;
	/** `renderer: 'boolean'`: text read for a true value (the check mark itself is hidden from assistive tech). */
	booleanTrue?: () => string;
	/** `renderer: 'boolean'`: text read for a false value (nothing is drawn). */
	booleanFalse?: () => string;
	/** Row selection (#713): accessible name of a row's checkbox, given the row's label. */
	selectRowLabel?: (rowLabel: string) => string;
	/** Row selection, client mode: name / tooltip of the header checkbox - it acts on the `count` listed rows. */
	selectAllRows?: (count: number) => string;
	/** Row selection, server mode: name / tooltip of the header checkbox - it acts only on the `loaded` rows of `total`. */
	selectAllLoadedRows?: (loaded: number, total: number) => string;
	/** Row selection: the count shown in the bulk bar and read by the live region (0 = nothing selected). */
	selectionStatus?: (count: number) => string;
	/** Row selection, server mode: the bulk bar's button that selects all `count` rows the filters match, loaded or not. */
	selectAllMatching?: (count: number) => string;
	/** Row selection, server mode: shown in the bulk bar and read by the live region while all `count` matching rows are selected. */
	allMatchingStatus?: (count: number) => string;
	/** Row selection: the bulk bar's "clear the selection" button. */
	selectionClear?: () => string;
	/** Row selection: accessible name of the bulk bar. */
	bulkBarLabel?: () => string;
	/** Row selection: accessible name of the header cell holding the select-all checkbox (#1016). */
	selectColumnLabel?: () => string;
	/** Sort (#1016): read by the live region when the only sort becomes ascending on `header`. */
	sortAscendingStatus?: (header: string) => string;
	/** Sort: read when the only sort becomes descending on `header`. */
	sortDescendingStatus?: (header: string) => string;
	/** Sort: read when the last sort key is gone, so the rows are in their original order. */
	sortClearedStatus?: () => string;
	/** Sort, several columns (Shift+click): `header` is now the `priority`-th key, ascending. */
	sortMultipleAscendingStatus?: (header: string, priority: number) => string;
	/** Sort, several columns: `header` is now the `priority`-th key, descending. */
	sortMultipleDescendingStatus?: (header: string, priority: number) => string;
	/** Sort, several columns: `header` was dropped from the keys, others remain. */
	sortKeyRemovedStatus?: (header: string) => string;
	/**
	 * Read by the live region when an action key (Enter, Space, F2, the menu
	 * keys) only scrolled to the active cell because it was off screen (#1036):
	 * the key did nothing else, pressing it again acts.
	 */
	scrolledToActiveCell?: () => string;
	/**
	 * Accessible name of the grid itself when the `label` prop is not given
	 * (#1016). The grid element takes the focus back after the bulk bar closes,
	 * and a screen reader reads that element's whole content unless it has a name.
	 */
	gridLabel?: () => string;
}

export const defaultGridMessages: Required<GridMessages> = {
	filterOpContains: () => '含む',
	filterOpStartsWith: () => 'で始まる',
	filterOpEquals: () => '一致する',
	filterButtonLabel: () => '絞り込み',
	filterAriaLabel: (header) => `${header}の絞り込み`,
	filterAppliedDescription: (header) => `${header}の絞り込みを適用中`,
	filterValuePlaceholder: () => '値を入力',
	filterOperatorLabel: () => '絞り込み条件',
	filterValueLabel: () => '絞り込み値',
	filterApply: () => '適用',
	filterClear: () => 'クリア',
	filterRangeLabel: () => '期間',
	filterRangeStart: () => '開始日',
	filterRangeEnd: () => '終了日',
	filterRangeInvalid: () => '日付は YYYY-MM-DD の形で入力してください',
	filterRangeOrder: () => '終了日は開始日と同じ日かそれより後にしてください',
	inlineEditInvalid: () => '入力値が不正です',
	inlineEditErrorLabel: (header) => `${header}のエラー`,
	inlineEditErrorHint: () =>
		'入力欄ではTabでエラーを確認、Enterで再試行。エラー欄ではShift+TabまたはEscapeで入力欄に戻ります。',
	emptyState: () => 'データがありません',
	groupCountSuffix: (count) => `（${count}件）`,
	columnsMenuButton: () => '列',
	columnsMenuTitle: () => '列の表示',
	columnsMenuCount: (visible, total) => `${visible}/${total}`,
	columnsMenuLastColumn: () => '最後の1列は非表示にできません',
	pinColumn: (header) => `${header}を左端に固定`,
	unpinColumn: (header) => `${header}の固定を解除`,
	filterChipsLabel: () => '適用中の絞り込み',
	filterChipRemove: (header) => `${header}の絞り込みを外す`,
	filterChipsClearAll: () => 'すべて解除',
	filterChipIsNull: () => '空',
	filterChipNotNull: () => '空でない',
	filterChipIn: () => 'いずれか',
	filterChipRangeSeparator: () => '〜',
	booleanTrue: () => 'はい',
	booleanFalse: () => 'いいえ',
	selectRowLabel: (rowLabel) => `${rowLabel}を選択`,
	selectAllRows: (count) => `一覧の${count.toLocaleString('ja')}件をすべて選択`,
	selectAllLoadedRows: (loaded, total) =>
		`読み込み済みの${loaded.toLocaleString('ja')}件をすべて選択（全${total.toLocaleString('ja')}件のうち）`,
	selectionStatus: (count) =>
		count === 0 ? '選択なし' : `${count.toLocaleString('ja')}件を選択中`,
	selectAllMatching: (count) => `該当する全${count.toLocaleString('ja')}件を選択`,
	allMatchingStatus: (count) => `該当する全${count.toLocaleString('ja')}件を選択中`,
	selectionClear: () => '選択を解除',
	bulkBarLabel: () => '一括操作',
	selectColumnLabel: () => '選択',
	sortAscendingStatus: (header) => `${header}で昇順に並べ替え`,
	sortDescendingStatus: (header) => `${header}で降順に並べ替え`,
	sortClearedStatus: () => '並べ替えを解除',
	sortMultipleAscendingStatus: (header, priority) => `${header}を第${priority}キーで昇順に並べ替え`,
	sortMultipleDescendingStatus: (header, priority) =>
		`${header}を第${priority}キーで降順に並べ替え`,
	sortKeyRemovedStatus: (header) => `${header}を並べ替えから外しました`,
	scrolledToActiveCell: () => '選択中のセルまでスクロールしました。もう一度押すと実行します',
	gridLabel: () => 'データ一覧'
};
