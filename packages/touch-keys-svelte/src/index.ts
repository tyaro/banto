/**
 * `@banto/touch-keys-svelte` — on-screen keys for touch panels
 * (docs/design/touch-keypad-design.md). Optional: the template app wires it only
 * as a sample card on `/ui-demo` (template-scope §3, ADR-0036 §2).
 *
 * `TouchKeysHost` (once at the app root) opens the number keypad on numeric
 * `<input>`s and the text keyboard on text / password `<input>`s; `touchKeys` sets
 * one field's options. `NumberKeypad`, `TextKeyboard` and the pure draft cores are
 * usable on their own. Password fields never hand their plain text out (design §5.5).
 */
export { default as TouchKeysHost } from './TouchKeysHost.svelte';
export { default as NumberKeypad } from './NumberKeypad.svelte';
export { default as TextKeyboard } from './TextKeyboard.svelte';
export { touchKeys } from './attach';
export type {
	TouchKeysOptions,
	InferredKeysOptions,
	NumberKeysOptions,
	TextKeysOptions,
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
export {
	DEFAULT_TEXT_LAYOUTS,
	TEXT_LAYOUTS,
	applyKanaMark,
	kanaMarked,
	type KanaMark,
	resolveTextRules,
	resolveTextLayouts,
	textKeyRows,
	reachableChars,
	pressTextKey,
	classifyText,
	type TextLayout,
	type TextRules,
	type TextSpec,
	type TextAttrs,
	type TextKey,
	type TextKeyRowsOptions,
	type TextStatus
} from './core/text';
