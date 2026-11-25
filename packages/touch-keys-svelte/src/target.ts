/**
 * DOM side of the host (touch-keypad-design §5.4, §6.5, §7.4, §8.3): which
 * `<input>` gets the keypad and with which rules, the `inputmode="none"`
 * bookkeeping, and the checked write. Package-internal; no Svelte.
 */
import { attachedOptions } from './attach';
import {
	inferTouchKind,
	isWritableNumber,
	resolveNumberRules,
	type NumberRules
} from './core/number';
import type { TouchKeysOptions, TouchKeysPlacement } from './types';

export type ResolveFn = (input: HTMLInputElement) => TouchKeysOptions | false | undefined;

/** A field the number keypad can open on, with everything decided at this moment. */
export interface NumberTarget {
	input: HTMLInputElement;
	rules: NumberRules;
	label: string;
	placement: TouchKeysPlacement | undefined;
	/** The edit key right now (`undefined` when the field declares none). */
	editKey: string | number | null | undefined;
}

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
 * Decides whether `el` gets the number keypad: `readonly` / `disabled` /
 * `data-touch-keys="off"` (on the field or ANY ancestor) always win, then the
 * attachment, then `resolve`, then the attributes. `null` = leave the field alone.
 */
export function resolveNumberTarget(
	el: EventTarget | null,
	resolve: ResolveFn | undefined
): NumberTarget | null {
	if (!(el instanceof HTMLInputElement)) return null;
	// An "off" marker on the field or ANY ancestor wins, whatever other markers sit in between.
	const marker = el.closest('[data-touch-keys="off" i]')
		? 'off'
		: el.getAttribute('data-touch-keys');
	const kind = inferTouchKind({
		tagName: el.tagName,
		type: el.getAttribute('type'),
		inputmode: ownInputMode(el),
		readonly: el.readOnly,
		disabled: el.matches(':disabled'),
		touchKeys: marker
	});
	if (kind === 'off' || kind === 'password') return null;
	if (el.closest('[inert]')) return null;

	let options = attachedOptions(el);
	if (options === undefined) options = resolve?.(el);
	if (options === false) return null;
	if (options === undefined && kind !== 'number') return null;
	if (options !== undefined && options.kind !== 'number') return null;

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
		options ?? {},
		{ force: true }
	);
	if (!rules) return null;
	return {
		input: el,
		rules,
		label: options?.label ?? fieldLabel(el),
		placement: options?.placement,
		editKey: readEditKey(options)
	};
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
