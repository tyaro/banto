/**
 * `@banto/touch-keys-svelte` — on-screen keys for touch panels
 * (docs/design/touch-keypad-design.md). Optional, recipe-only: not wired into
 * the template app (template-scope §3, ADR-0036).
 *
 * `TouchKeysHost` (once at the app root) opens the number keypad on numeric
 * `<input>`s; `touchKeys` sets one field's options. `NumberKeypad` and the pure
 * number-draft core are usable on their own. The text keyboard comes later.
 */
export { default as TouchKeysHost } from './TouchKeysHost.svelte';
export { default as NumberKeypad } from './NumberKeypad.svelte';
export { touchKeys } from './attach';
export type {
	TouchKeysOptions,
	NumberKeysOptions,
	CommonKeysOptions,
	TouchKeysPlacement,
	TouchKeysCancelReason,
	TouchKeysEditKey,
	TouchKeysConfirmDetail,
	TouchKeysCancelDetail
} from './types';
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
	nearestValid,
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
