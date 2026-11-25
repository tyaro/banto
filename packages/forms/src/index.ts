/**
 * Public entry point for @banto/forms (spec §7).
 */
export type {
	FieldType,
	FieldOption,
	ReferenceOption,
	FieldDef,
	FileFieldMeta,
	PendingFile,
	FileFieldValue,
	FileFieldClient,
	FileFieldConfig,
	FormSection,
	FormColumns,
	FormSchema,
	FieldError,
	FormAppearance
} from './types';

export {
	isFieldVisible,
	hiddenFieldNames,
	submitValuesOf,
	assertFormSchema,
	resolveColumns,
	layoutOf,
	focusCandidateNames,
	type LayoutField,
	type LayoutGroup
} from './layout';
export { validateField, validateAll, type ValidationMessages } from './validate';
export { FormStore, createFormStore } from './store.svelte';

// Picker components injected by the app (date-time-pickers §5.7, D1-a): forms
// never imports @banto/ui; without an injected component the native input is used.
export {
	provideFieldInputs,
	getFieldInputs,
	type FieldInputs,
	type DateFieldInputProps,
	type TimeFieldInputProps,
	type DateTimeFieldInputProps,
	type TemporalFieldInputProps
} from './fieldInputs';
export {
	guardUnsavedChanges,
	hasUnsavedChanges,
	decideLeave,
	isApprovedExit,
	isSamePage,
	isSamePath,
	leaveCheckOutcome,
	runLeaveCheck,
	type BeforeNavigateHook,
	type LeaveCheckOptions,
	type LeaveCheckResult,
	type LeaveDecision,
	type LeaveDecisionInput,
	type LeaveNavigation,
	type UnsavedChangesGuard,
	type UnsavedChangesGuardOptions,
	type UnsavedChangesSource
} from './unsavedChanges.svelte';
export { default as UnsavedChangesNotice } from './UnsavedChangesNotice.svelte';

// Unapplied input that outlives a pane, and apply / discard / cancel of several
// forms with one prompt (Issue #432; shared-primitives-upstream-plan §3.5・D3).
// The dock side (`beforePanelChange` etc.) lives in @banto/dock-svelte; the app
// connects the two (plan §4.2) - forms never imports dock-svelte (plan §2.1).
export {
	createFormDraft,
	draftSourceFrom,
	formatDraftValue,
	type FormDraft,
	type FormDraftOptions,
	type FormDraftSnapshot
} from './draft.svelte';
export {
	createDraftCoordinator,
	type DraftCoordinator,
	type DraftCoordinatorOptions,
	type DraftSettleChoice,
	type DraftSettleResult,
	type DraftSource
} from './draftCoordinator.svelte';
export { default as DraftNumberField } from './fields/DraftNumberField.svelte';
export { default as DraftDateField } from './fields/DraftDateField.svelte';

export { default as BantoForm } from './BantoForm.svelte';
export { default as TextField } from './fields/TextField.svelte';
export { default as PasswordField } from './fields/PasswordField.svelte';
// The password box with its show / hide (eye) button (#944); PasswordField draws it, apps use it directly.
export { default as PasswordInput } from './fields/PasswordInput.svelte';
export { defaultPasswordInputMessages, type PasswordInputMessages } from './fields/password';
export { default as NumberField } from './fields/NumberField.svelte';
export { default as TextareaField } from './fields/TextareaField.svelte';
export { default as SelectField } from './fields/SelectField.svelte';
export { default as CheckboxField } from './fields/CheckboxField.svelte';
export { default as RadioField } from './fields/RadioField.svelte';
export { default as MultiselectField } from './fields/MultiselectField.svelte';
export { default as ReferenceField } from './fields/ReferenceField.svelte';
export { REFERENCE_SEARCH_DEBOUNCE_MS, type ReferenceFieldMessages } from './fields/reference';
// `file` type (§4.12, Issue #714): files go through the injected client only.
export { default as FileField } from './fields/FileField.svelte';
export {
	uploadPendingFiles,
	fileValueOf,
	emptyFileValue,
	formatFileSize,
	fileErrorText,
	type FileFieldMessages,
	type FileUploadOutcome,
	type FileUploadStore
} from './fields/file';
export { default as DateField } from './fields/DateField.svelte';
