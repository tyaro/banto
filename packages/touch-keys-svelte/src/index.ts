/**
 * `@banto/touch-keys-svelte` — on-screen keys for touch panels
 * (docs/design/touch-keypad-design.md). Optional, recipe-only: not wired into
 * the template app (template-scope §3, ADR-0036).
 *
 * T1 ships the pure number-draft core and the `NumberKeypad` display; binding
 * to an `<input>` (host / attachment) comes in a later step.
 */
export { default as NumberKeypad } from './NumberKeypad.svelte';
export { defaultTouchKeysMessages, type TouchKeysMessages } from './messages';
export {
	MAX_DIGITS,
	MAX_DECIMALS,
	resolveNumberRules,
	inferTouchKind,
	openDraft,
	pressNumberKey,
	normalizeDraft,
	isWritableNumber,
	classifyDraft,
	nearestSteps,
	type NumberRules,
	type NumberSpec,
	type InputAttrs,
	type KindAttrs,
	type TouchKind,
	type StepRule,
	type NumberKey,
	type DraftState,
	type KeyRules,
	type DraftStatus
} from './core/number';
