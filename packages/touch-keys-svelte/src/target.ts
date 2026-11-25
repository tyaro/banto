/**
 * DOM side of the host (touch-keypad-design §5.4, §6.5, §7.4, §8.3): which
 * `<input>` gets which keys and with which rules, the `inputmode="none"`
 * bookkeeping, and the checked writes. Package-internal; no Svelte.
 */
import { attachedOptions } from './attach';
import {
	inferTouchKind,
	isWritableNumber,
	resolveNumberRules,
	type NumberRules
} from './core/number';
import { resolveTextRules, type TextLayout, type TextRules } from './core/text';
import type { TouchKeysOptions, TouchKeysPlacement } from './types';

export type ResolveFn = (input: HTMLInputElement) => TouchKeysOptions | false | undefined;

interface TargetBase {
	input: HTMLInputElement;
	label: string;
	placement: TouchKeysPlacement | undefined;
	/** The edit key right now (`undefined` when the field declares none). */
	editKey: string | number | null | undefined;
	/** `openOnFocus` of the field's options (§4.2 of grid-touch-edit-design). */
	openOnFocus: boolean;
}

/** A field the number keypad can open on, with everything decided at this moment. */
export interface NumberTarget extends TargetBase {
	kind: 'number';
	rules: NumberRules;
}

/** A field the text keyboard can open on. `masked` = a `type="password"` field, or `masked: true` (§5.5). */
export interface TextTarget extends TargetBase {
	kind: 'text';
	rules: TextRules;
	masked: boolean;
	layouts: TextLayout[] | undefined;
	initialLayout: TextLayout | undefined;
}

export type Target = NumberTarget | TextTarget;

// ------------------------------------------------------------ inputmode (§7.4)

/** Fields whose `inputmode` the host replaced with `none`, and the attribute they had. */
const savedInputMode = new Map<HTMLInputElement, string | null>();

/** The `inputmode` the app wrote (not the host's `none`). */
function ownInputMode(input: HTMLInputElement): string | null {
	const now = input.getAttribute('inputmode');
	if (savedInputMode.has(input) && now === 'none') return savedInputMode.get(input) ?? null;
	return now;
}

/** Keeps the OS touch keyboard away from a keypad field. Call before focus enters it. */
export function suppressOsKeyboard(input: HTMLInputElement): void {
	const now = input.getAttribute('inputmode');
	if (now === 'none' && savedInputMode.has(input)) return;
	if (savedInputMode.size > 64) {
		for (const el of savedInputMode.keys()) if (!el.isConnected) savedInputMode.delete(el);
	}
	savedInputMode.set(input, now);
	input.setAttribute('inputmode', 'none');
}

/** Puts one field's `inputmode` back: it stopped being a keypad field while the host stays on. */
export function releaseOsKeyboard(input: HTMLInputElement): void {
	if (!savedInputMode.has(input)) return;
	const original = savedInputMode.get(input) ?? null;
	savedInputMode.delete(input);
	if (input.getAttribute('inputmode') !== 'none') return; // the app rewrote it meanwhile
	if (original === null) input.removeAttribute('inputmode');
	else input.setAttribute('inputmode', original);
}

/** Puts every replaced `inputmode` back (the host was disabled or destroyed). */
export function restoreOsKeyboard(): void {
	for (const [input, original] of savedInputMode) {
		if (input.getAttribute('inputmode') !== 'none') continue; // the app rewrote it meanwhile
		if (original === null) input.removeAttribute('inputmode');
		else input.setAttribute('inputmode', original);
	}
	savedInputMode.clear();
}

// ------------------------------------------------------------ resolving (§5.4)

function fieldLabel(input: HTMLInputElement): string {
	const aria = input.getAttribute('aria-label')?.trim();
	if (aria) return aria;
	const fromLabel = input.labels?.[0]?.textContent?.trim();
	if (fromLabel) return fromLabel;
	return input.getAttribute('placeholder')?.trim() ?? '';
}

function readEditKey(options: TouchKeysOptions | undefined): string | number | null | undefined {
	const key = options?.editKey;
	return typeof key === 'function' ? key() : key;
}

/**
 * Decides whether `el` gets on-screen keys, and which: `readonly` / `disabled` /
 * `data-touch-keys="off"` (on the field or ANY ancestor) always win, then the
 * attachment, then `resolve`, then the attributes. `null` = leave the field alone.
 *
 * - A `type="password"` field always gets the MASKED text keyboard (§5.5), whatever
 *   kind the options name; only `false` / "off" keep the keys away from it.
 *   `{ kind: 'text', masked: true }` masks a field of another type too.
 * - `kind: 'text'` on a `type="number"` field is refused (`null`): the browser would
 *   turn most of what the text keys enter into an empty value.
 */
export function resolveTarget(
	el: EventTarget | null,
	resolve: ResolveFn | undefined
): Target | null {
	if (!(el instanceof HTMLInputElement)) return null;
	// An "off" marker on the field or ANY ancestor wins, whatever other markers sit in between.
	const marker = el.closest('[data-touch-keys="off" i]')
		? 'off'
		: el.getAttribute('data-touch-keys');
	const inferred = inferTouchKind({
		tagName: el.tagName,
		type: el.getAttribute('type'),
		inputmode: ownInputMode(el),
		readonly: el.readOnly,
		disabled: el.matches(':disabled'),
		touchKeys: marker
	});
	if (inferred === 'off') return null;
	if (el.closest('[inert]')) return null;

	let options = attachedOptions(el);
	if (options === undefined) options = resolve?.(el);
	if (options === false) return null;

	const common = {
		input: el,
		label: options?.label ?? fieldLabel(el),
		placement: options?.placement,
		editKey: readEditKey(options),
		openOnFocus: options?.openOnFocus === true
	};
	const text = options?.kind === 'text' ? options : undefined;
	const masked = inferred === 'password' || text?.masked === true;
	if (masked || (options?.kind ?? inferred) === 'text') {
		if (el.type === 'number') return null;
		return {
			...common,
			kind: 'text',
			masked,
			rules: resolveTextRules(
				{
					maxlength: el.getAttribute('maxlength'),
					minlength: el.getAttribute('minlength'),
					required: el.required
				},
				text ?? {}
			),
			layouts: text?.layouts,
			initialLayout: text?.initialLayout
		};
	}

	const rules = resolveNumberRules(
		{
			type: el.getAttribute('type'),
			inputmode: ownInputMode(el),
			min: el.getAttribute('min'),
			max: el.getAttribute('max'),
			step: el.getAttribute('step'),
			value: el.getAttribute('value'),
			required: el.required
		},
		options?.kind === 'number' ? options : {},
		{ force: true }
	);
	if (!rules) return null;
	return { ...common, kind: 'number', rules };
}

// ------------------------------------------------------------ write (§8.3)

/**
 * Writes `value` and makes sure it stuck: a `type="number"` field silently
 * turns a string it does not accept into `''`, and its own validity is the
 * authority on range / step. On any mismatch the opening value is put back and
 * `false` is returned — the caller then emits no `input` / `change`.
 */
export function writeChecked(input: HTMLInputElement, value: string, previous: string): boolean {
	if (value !== '' && !isWritableNumber(value)) return false;
	input.value = value;
	let ok = input.value === value;
	if (ok && input.type === 'number') {
		// The browser is the authority here. `valueMissing`: `required` can not be loosened on
		// type=number (resolveNumberRules), so an empty value the browser flags is never written.
		const v = input.validity;
		ok = !(v.valueMissing || v.rangeUnderflow || v.rangeOverflow || v.stepMismatch || v.badInput);
	}
	if (!ok) input.value = previous;
	return ok;
}

/**
 * The text keyboard's write, with the field itself as the authority:
 * - `'changed'`: the value did not stick exactly (`type="email"` / `"url"` trim white space);
 * - `'invalid'`: the field's own constraints refuse it (`type` / `pattern` mismatch, a missing
 *   required value). `customError` is not looked at: an app-set message does not depend on
 *   this value and would only clear on an `input` event.
 * In both cases the opening value is put back and the caller emits no `input` / `change`.
 * (`maxlength` / `minlength` are not flagged by the browser for a value set from script;
 * `classifyText` enforces them.) Arguments are never logged (password fields, §5.5).
 */
export function writeTextChecked(
	input: HTMLInputElement,
	value: string,
	previous: string
): 'ok' | 'changed' | 'invalid' {
	input.value = value;
	let result: 'ok' | 'changed' | 'invalid' = input.value === value ? 'ok' : 'changed';
	if (result === 'ok') {
		const v = input.validity;
		if (v.typeMismatch || v.patternMismatch || v.valueMissing || v.tooLong || v.tooShort) {
			result = 'invalid';
		}
	}
	if (result !== 'ok') input.value = previous;
	return result;
}
