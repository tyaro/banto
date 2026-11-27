/**
 * i18n layer ② bridge (docs/conventions.md §13, ADR-0005, PR-B2): builds the
 * `messages` override bundles that the `@banto/*` packages accept (i18n layer
 * ①), sourcing every string from Paraglide (`#lib/paraglide/messages`).
 *
 * **App layer ONLY.** The packages stay i18n-agnostic: they declare a
 * `Partial<…Messages>` prop whose defaults reproduce today's Japanese output,
 * and the app hands them already-resolved strings here (conventions §4/§5 —
 * no `#lib` import or dictionary ever enters a package). Each entry is a thin
 * closure so the Paraglide message is resolved lazily at call time (render /
 * validation), keeping it reactive to the active locale.
 */
import type { GridMessages, ColumnValidationMessages } from '@banto/grid-svelte';
import {
	fileErrorText,
	formatFileSize,
	type FileFieldMessages,
	type PasswordInputMessages,
	type ReferenceFieldMessages,
	type ValidationMessages
} from '@banto/forms';
import type { TreeMessages } from '@banto/tree-svelte';
import type { UiMessages } from '@banto/ui';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';

/**
 * Digit-grouped count in the app's display language (1,000 / 1.000 ...), never
 * the device's locale: the screen-reader text and the bulk delete button read
 * the same way as the rest of the UI (#1016).
 */
export function formatCount(count: number): string {
	return count.toLocaleString(getLocale());
}

/** @banto/grid-svelte `messages` prop: FilterPopover / HeaderCell / BantoGrid / ColumnsMenu strings. */
export function gridMessages(): Partial<GridMessages> {
	return {
		filterOpContains: () => m['grid.filterContains'](),
		filterOpStartsWith: () => m['grid.filterStartsWith'](),
		filterOpEquals: () => m['grid.filterEquals'](),
		filterButtonLabel: () => m['grid.filterButtonLabel'](),
		filterAriaLabel: (header) => m['grid.filterAriaLabel']({ header }),
		filterAppliedDescription: (header) => m['grid.filterAppliedDescription']({ header }),
		filterOperatorLabel: () => m['grid.filterOperatorLabel'](),
		filterValueLabel: () => m['grid.filterValueLabel'](),
		filterValuePlaceholder: () => m['grid.filterValuePlaceholder'](),
		filterApply: () => m['grid.filterApply'](),
		filterClear: () => m['grid.filterClear'](),
		filterRangeLabel: () => m['grid.filterRangeLabel'](),
		filterRangeStart: () => m['grid.filterRangeStart'](),
		filterRangeEnd: () => m['grid.filterRangeEnd'](),
		filterRangeInvalid: () => m['grid.filterRangeInvalid'](),
		filterRangeOrder: () => m['grid.filterRangeOrder'](),
		inlineEditInvalid: () => m['grid.inlineEditInvalid'](),
		inlineEditErrorLabel: (header) => m['grid.inlineEditErrorLabel']({ header }),
		inlineEditErrorHint: () => m['grid.inlineEditErrorHint'](),
		emptyState: () => m['items.list.empty'](),
		groupCountSuffix: (count) => m['grid.groupCountSuffix']({ count }),
		columnsMenuButton: () => m['grid.columnsMenuButton'](),
		columnsMenuTitle: () => m['grid.columnsMenuTitle'](),
		columnsMenuCount: (visible, total) => m['grid.columnsMenuCount']({ visible, total }),
		columnsMenuLastColumn: () => m['grid.columnsMenuLastColumn'](),
		pinColumn: (header) => m['grid.pinColumn']({ header }),
		unpinColumn: (header) => m['grid.unpinColumn']({ header }),
		filterChipsLabel: () => m['grid.filterChipsLabel'](),
		filterChipRemove: (header) => m['grid.filterChipRemove']({ header }),
		filterChipsClearAll: () => m['grid.filterChipsClearAll'](),
		filterChipIsNull: () => m['grid.filterChipIsNull'](),
		filterChipNotNull: () => m['grid.filterChipNotNull'](),
		filterChipIn: () => m['grid.filterChipIn'](),
		filterChipRangeSeparator: () => m['grid.filterChipRangeSeparator'](),
		booleanTrue: () => m['grid.booleanTrue'](),
		booleanFalse: () => m['grid.booleanFalse'](),
		selectRowLabel: (rowLabel) => m['grid.selectRowLabel']({ rowLabel }),
		// Counts are grouped by digit in the display language (formatCount), like the bulk delete button's (#1016).
		selectAllRows: (count) => m['grid.selectAllRows']({ count: formatCount(count) }),
		selectAllLoadedRows: (loaded, total) =>
			m['grid.selectAllLoadedRows']({
				loaded: formatCount(loaded),
				total: formatCount(total)
			}),
		selectionStatus: (count) =>
			count === 0
				? m['grid.selectionNone']()
				: m['grid.selectionStatus']({ count: formatCount(count) }),
		selectAllMatching: (count) => m['grid.selectAllMatching']({ count: formatCount(count) }),
		allMatchingStatus: (count) => m['grid.allMatchingStatus']({ count: formatCount(count) }),
		selectionClear: () => m['grid.selectionClear'](),
		bulkBarLabel: () => m['grid.bulkBarLabel'](),
		selectColumnLabel: () => m['grid.selectColumnLabel'](),
		gridLabel: () => m['grid.gridLabel'](),
		sortAscendingStatus: (header) => m['grid.sortAscendingStatus']({ header }),
		sortDescendingStatus: (header) => m['grid.sortDescendingStatus']({ header }),
		sortClearedStatus: () => m['grid.sortClearedStatus'](),
		sortMultipleAscendingStatus: (header, priority) =>
			m['grid.sortMultipleAscendingStatus']({ header, priority }),
		sortMultipleDescendingStatus: (header, priority) =>
			m['grid.sortMultipleDescendingStatus']({ header, priority }),
		sortKeyRemovedStatus: (header) => m['grid.sortKeyRemovedStatus']({ header }),
		scrolledToActiveCell: () => m['grid.scrolledToActiveCell']()
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
		pattern: () => m['validation.pattern'](),
		dateInvalid: () => m['validation.dateInvalid'](),
		dateMin: (_def, min) => m['validation.dateMin']({ min }),
		dateMax: (_def, max) => m['validation.dateMax']({ max }),
		dateDisabled: () => m['validation.dateDisabled'](),
		timeInvalid: () => m['validation.timeInvalid'](),
		timeMin: (_def, min) => m['validation.timeMin']({ min }),
		timeMax: (_def, max) => m['validation.timeMax']({ max }),
		timeStep: (_def, step) => m['validation.timeStep']({ step }),
		dateTimeInvalid: () => m['validation.dateTimeInvalid'](),
		dateTimeMin: (_def, min) => m['validation.dateTimeMin']({ min }),
		dateTimeMax: (_def, max) => m['validation.dateTimeMax']({ max }),
		visibilityUnsettled: () => m['validation.visibilityUnsettled'](),
		fileTooLarge: (_def, maxBytes) =>
			m['validation.fileTooLarge']({ size: formatFileSize(maxBytes) }),
		fileTypeNotAccepted: (_def, accept) => m['validation.fileTypeNotAccepted']({ accept }),
		fileTooMany: (_def, max) => m['validation.fileTooMany']({ max })
	};
}

/** @banto/forms `ReferenceFieldMessages` (BantoForm `referenceMessages`): the texts of a `reference` field's list. */
export function referenceFieldMessages(): ReferenceFieldMessages {
	return {
		loading: () => m['reference.loading'](),
		noResults: (query) =>
			query ? m['reference.noResults']({ query }) : m['reference.noResultsEmpty'](),
		resultCount: (count) => m['reference.resultCount']({ count }),
		searchFailed: () => m['reference.searchFailed'](),
		listLabel: (def) => m['reference.listLabel']({ label: def.label })
	};
}

/**
 * @banto/forms `FileFieldMessages` (BantoForm `fileMessages`, `uploadPendingFiles`): the texts of a `file` field.
 * A rejection of the injected client is shown as it is (its own message); the keys are the fallback.
 */
export function fileFieldMessages(): FileFieldMessages {
	return {
		choose: () => m['fileField.choose'](),
		pendingNote: () => m['fileField.pendingNote'](),
		pending: () => m['fileField.pending'](),
		uploading: () => m['fileField.uploading'](),
		upload: () => m['fileField.upload'](),
		retry: () => m['fileField.retry'](),
		cancel: () => m['fileField.cancel'](),
		remove: () => m['fileField.remove'](),
		actionLabel: (action, fileName) => m['fileField.actionLabel']({ action, fileName }),
		removeConfirm: (fileName) => m['fileField.removeConfirm']({ fileName }),
		loading: () => m['fileField.loading'](),
		loadFailed: (error) => fileErrorText(error) ?? m['fileField.loadFailed'](),
		reload: () => m['fileField.reload'](),
		empty: () => m['fileField.empty'](),
		uploadFailed: (error) => fileErrorText(error) ?? m['fileField.uploadFailed'](),
		removeFailed: (error) => fileErrorText(error) ?? m['fileField.removeFailed'](),
		rejected: (fileName, reason) => m['fileField.rejected']({ fileName, reason }),
		listLabel: (def) => m['fileField.listLabel']({ label: def.label })
	};
}

/** @banto/forms `PasswordInputMessages` (`PasswordInput` / BantoForm `passwordMessages`): the show / hide button of a password box (#944). */
export function passwordInputMessages(): PasswordInputMessages {
	return {
		show: () => m['passwordInput.show'](),
		hide: () => m['passwordInput.hide']()
	};
}

/** @banto/ui `DateInput` `messages` (date-time-pickers §5.5): the calendar's button / dialog / hint copy. */
export function dateInputMessages(): UiMessages {
	return {
		datePickerOpen: () => m['datePicker.open'](),
		datePickerChange: (date) => m['datePicker.change']({ date }),
		datePickerDialog: () => m['datePicker.dialog'](),
		datePickerPrevMonth: () => m['datePicker.prevMonth'](),
		datePickerNextMonth: () => m['datePicker.nextMonth'](),
		datePickerPrevYear: () => m['datePicker.prevYear'](),
		datePickerNextYear: () => m['datePicker.nextYear'](),
		datePickerChooseMonth: () => m['datePicker.chooseMonth'](),
		datePickerChooseYear: () => m['datePicker.chooseYear'](),
		datePickerPrevYears: () => m['datePicker.prevYears'](),
		datePickerNextYears: () => m['datePicker.nextYears'](),
		datePickerYearRange: (start, end) => m['datePicker.yearRange']({ start, end }),
		datePickerToday: () => m['datePicker.today'](),
		datePickerClear: () => m['datePicker.clear'](),
		dateFormatHint: () => m['datePicker.formatHint']()
	};
}

/** @banto/ui `ConfirmHost` / `ConfirmDialog` `messages` (Issue #556): the default buttons, the type-to-confirm label and the ×. */
export function confirmDialogMessages(): UiMessages {
	return {
		confirmOk: () => m['common.confirmOk'](),
		confirmCancel: () => m['common.cancel'](),
		confirmTypeToConfirm: (text) => m['common.typeToConfirm']({ text }),
		overlayClose: () => m['common.close']()
	};
}

/** @banto/ui `TimeInput` `messages` (date-time-pickers §5.5): the list button / list / hint copy. */
export function timeInputMessages(): UiMessages {
	return {
		timePickerOpen: () => m['timePicker.open'](),
		timePickerList: () => m['timePicker.list'](),
		timeFormatHint: () => m['timePicker.formatHint']()
	};
}

/** @banto/ui `DateTimeInput` `messages` (date-time-pickers §5.5, PR-5): the calendar's copy, the time list's and its own. */
export function dateTimeInputMessages(): UiMessages {
	return {
		...dateInputMessages(),
		timePickerList: () => m['timePicker.list'](),
		dateTimePickerOpen: () => m['dateTimePicker.open'](),
		dateTimePickerChange: (dateTime) => m['dateTimePicker.change']({ dateTime }),
		dateTimePickerDialog: () => m['dateTimePicker.dialog'](),
		dateTimeFormatHint: () => m['dateTimePicker.formatHint']()
	};
}

/** @banto/ui `DateRangeInput` `messages` (date-time-pickers §5.9, PR-6): both boxes' names plus the calendar's copy. */
export function dateRangeInputMessages(): UiMessages {
	return {
		...dateInputMessages(),
		dateRangeStart: () => m['dateRange.start'](),
		dateRangeEnd: () => m['dateRange.end']()
	};
}

/** @banto/ui `DateRangePicker` `messages` (Issue #910): DateRangeInput's copy plus the one calendar's button, dialog and status line. */
export function dateRangePickerMessages(): UiMessages {
	return {
		...dateRangeInputMessages(),
		dateRangePickerOpen: () => m['dateRangePicker.open'](),
		dateRangePickerChange: (from, to) => m['dateRangePicker.change']({ from, to }),
		dateRangePickerDialog: () => m['dateRangePicker.dialog'](),
		dateRangePickerPickStart: () => m['dateRangePicker.pickStart'](),
		dateRangePickerPickEnd: (from) => m['dateRangePicker.pickEnd']({ from }),
		dateRangePickerDayStart: (date) => m['dateRangePicker.dayStart']({ date }),
		dateRangePickerDayEnd: (date) => m['dateRangePicker.dayEnd']({ date }),
		dateRangePickerDayBoth: (date) => m['dateRangePicker.dayBoth']({ date })
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
		pattern: () => m['validation.pattern'](),
		dateInvalid: () => m['validation.dateInvalid'](),
		dateMin: (_field, min) => m['validation.dateMin']({ min }),
		dateMax: (_field, max) => m['validation.dateMax']({ max }),
		dateDisabled: () => m['validation.dateDisabled'](),
		timeInvalid: () => m['validation.timeInvalid'](),
		timeMin: (_field, min) => m['validation.timeMin']({ min }),
		timeMax: (_field, max) => m['validation.timeMax']({ max }),
		timeStep: (_field, step) => m['validation.timeStep']({ step }),
		dateTimeInvalid: () => m['validation.dateTimeInvalid'](),
		dateTimeMin: (_field, min) => m['validation.dateTimeMin']({ min }),
		dateTimeMax: (_field, max) => m['validation.dateTimeMax']({ max })
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
