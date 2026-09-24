/**
 * Public entry point for @banto/forms (spec §7).
 */
export type { FieldType, FieldOption, FieldDef, FormSchema, FieldError } from './types';

export { validateField, validateAll, type ValidationMessages } from './validate';
export { FormStore, createFormStore } from './store.svelte';
export {
	guardUnsavedChanges,
	hasUnsavedChanges,
	decideLeave,
	isApprovedExit,
	isSamePage,
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

export { default as BantoForm } from './BantoForm.svelte';
export { default as TextField } from './fields/TextField.svelte';
export { default as PasswordField } from './fields/PasswordField.svelte';
export { default as NumberField } from './fields/NumberField.svelte';
export { default as TextareaField } from './fields/TextareaField.svelte';
export { default as SelectField } from './fields/SelectField.svelte';
export { default as CheckboxField } from './fields/CheckboxField.svelte';
export { default as DateField } from './fields/DateField.svelte';
