/**
 * Pure number-draft logic for the on-screen keypad (touch-keypad-design §5.4 / §8).
 * No DOM, no Svelte: the keypad display, the confirm key and the write all look
 * only at what these functions return.
 */
import {
	addDec,
	cmpDec,
	decPlaces,
	floorDivDec,
	formatDec,
	mulInt,
	parseDec,
	subDec,
	toDec,
	type Dec
} from './decimal';

/** Significant digits the keypad accepts (what `Number` compares exactly). */
export const MAX_DIGITS = 15;
/** Largest fractional digit count (one integer digit stays available). */
export const MAX_DECIMALS = MAX_DIGITS - 1;

// ---------------------------------------------------------------- rules

/** `value - base` must be an integer multiple of `step`. */
export interface StepRule {
	step: Dec;
	base: Dec;
}

export interface NumberRules {
	min: Dec | null;
	max: Dec | null;
	/** Every rule must hold (a `type="number"` attribute step AND an explicit one). */
	steps: StepRule[];
	/** Fractional digits the keys may enter. */
	decimals: number;
	allowNegative: boolean;
	required: boolean;
}

/** Explicit per-field settings (`touchKeys(...)` / `resolve`). Looked at before attributes. */
export interface NumberSpec {
	min?: number | string;
	max?: number | string;
	/** A positive step, or `'any'` for no step rule. */
	step?: number | string | 'any';
	decimals?: number;
	allowNegative?: boolean;
	required?: boolean;
}

/** The attributes of an `<input>` that matter, as plain strings (`null`/undefined = absent). */
export interface InputAttrs {
	type?: string | null;
	inputmode?: string | null;
	min?: string | null;
	max?: string | null;
	step?: string | null;
	/** The `value` attribute (initial value), the step base when `min` is absent. */
	value?: string | null;
	required?: boolean;
}

export interface ResolveOptions {
	/** Build rules even if the attributes do not mark a numeric field (an explicit `touchKeys` spec). */
	force?: boolean;
}

const ZERO: Dec = { n: 0n, s: 0 };
const ONE: Dec = { n: 1n, s: 0 };

function positive(d: Dec | null): Dec | null {
	return d && d.n > 0n ? d : null;
}

function larger(a: Dec | null, b: Dec | null): Dec | null {
	if (!a) return b;
	if (!b) return a;
	return cmpDec(a, b) >= 0 ? a : b;
}

function smaller(a: Dec | null, b: Dec | null): Dec | null {
	if (!a) return b;
	if (!b) return a;
	return cmpDec(a, b) <= 0 ? a : b;
}

/**
 * Reads the keypad rules from an input's attributes and an explicit spec
 * (§5.4). Returns `null` when the field is not numeric (`type="number"` or
 * `inputmode="numeric" | "decimal"`) and `force` is not set.
 *
 * - `type="number"`: the browser's own validation rules — step defaults to 1,
 *   `any` means no step, an invalid step falls back to 1, the step base is the
 *   `min` attribute, else the `value` attribute, else 0. The attributes always
 *   hold; an explicit spec can tighten them but never loosen them.
 * - `inputmode`: the browser validates nothing, so attributes are used only
 *   when present and the explicit spec replaces them field by field.
 */
export function resolveNumberRules(
	attrs: InputAttrs,
	spec: NumberSpec = {},
	options: ResolveOptions = {}
): NumberRules | null {
	const type = (attrs.type ?? '').trim().toLowerCase();
	const mode = (attrs.inputmode ?? '').trim().toLowerCase();
	const isNumberType = type === 'number';
	const isMode = !isNumberType && (mode === 'numeric' || mode === 'decimal');
	if (!isNumberType && !isMode && !options.force) return null;
	const decimalMode = isNumberType ? true : mode === 'decimal' || !isMode;

	const attrMin = toDec(attrs.min);
	const attrMax = toDec(attrs.max);
	const specMin = toDec(spec.min);
	const specMax = toDec(spec.max);
	const valueAttr = toDec(attrs.value);
	const attrBase = attrMin ?? valueAttr ?? ZERO;

	let min: Dec | null;
	let max: Dec | null;
	const steps: StepRule[] = [];

	// attribute step
	const stepText = (attrs.step ?? '').trim();
	if (isNumberType) {
		if (stepText.toLowerCase() !== 'any') {
			steps.push({
				step: positive(toDec(stepText === '' ? null : stepText)) ?? ONE,
				base: attrBase
			});
		}
	} else if (stepText !== '' && stepText.toLowerCase() !== 'any') {
		const s = positive(toDec(stepText));
		if (s) steps.push({ step: s, base: attrBase });
	}

	if (isNumberType) {
		min = larger(attrMin, specMin);
		max = smaller(attrMax, specMax);
	} else {
		min = specMin ?? attrMin;
		max = specMax ?? attrMax;
	}

	if (spec.step !== undefined) {
		const specBase = specMin ?? attrBase;
		if (!isNumberType) steps.length = 0; // explicit replaces the attribute outside type=number
		if (spec.step !== 'any') {
			const s = positive(toDec(spec.step));
			if (s) steps.push({ step: s, base: specBase });
		}
	}

	let decimals: number;
	if (spec.decimals !== undefined) {
		decimals = spec.decimals;
	} else if (steps.length > 0) {
		decimals = steps.reduce((acc, r) => Math.max(acc, decPlaces(r.step), decPlaces(r.base)), 0);
		if (isMode && mode === 'numeric') decimals = 0;
	} else {
		decimals = decimalMode ? MAX_DECIMALS : 0;
	}
	decimals = Math.max(0, Math.min(MAX_DECIMALS, Math.trunc(decimals)));

	const allowNegative = spec.allowNegative ?? !(min !== null && min.n >= 0n);
	// type=number: the attribute's `required` can not be loosened by a spec (the browser still flags it)
	const required = isNumberType
		? (attrs.required ?? false) || (spec.required ?? false)
		: (spec.required ?? attrs.required ?? false);
	return { min, max, steps, decimals, allowNegative, required };
}

// ---------------------------------------------------------------- field kind

export type TouchKind = 'number' | 'text' | 'password' | 'off';

export interface KindAttrs extends InputAttrs {
	/** Upper-case or lower-case tag name (`input`, `textarea`, `select`). */
	tagName?: string;
	readonly?: boolean;
	disabled?: boolean;
	/** The `data-touch-keys` attribute. */
	touchKeys?: string | null;
}

const TEXT_TYPES = new Set(['', 'text', 'search', 'tel', 'url', 'email']);

/** Which keyboard a field gets by default (§5.4 table). */
export function inferTouchKind(attrs: KindAttrs): TouchKind {
	if (attrs.readonly || attrs.disabled) return 'off';
	if ((attrs.touchKeys ?? '').trim().toLowerCase() === 'off') return 'off';
	if ((attrs.tagName ?? 'input').toLowerCase() !== 'input') return 'off';
	const type = (attrs.type ?? '').trim().toLowerCase();
	const mode = (attrs.inputmode ?? '').trim().toLowerCase();
	if (type === 'number') return 'number';
	if (type === 'password') return 'password';
	if (!TEXT_TYPES.has(type)) return 'off';
	return mode === 'numeric' || mode === 'decimal' ? 'number' : 'text';
}

// ---------------------------------------------------------------- key entry

export type NumberKey =
	'0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'sign' | 'backspace' | 'clear';

export interface DraftState {
	text: string;
	/** True until the first key: a digit then replaces the current value (§8.3). */
	fresh: boolean;
}

export interface KeyRules {
	decimals: number;
	allowNegative: boolean;
}

/** The draft when the keypad opens: the field's current value, not yet touched. */
export function openDraft(current: string): DraftState {
	return { text: current, fresh: true };
}

function significantDigits(text: string): number {
	const body = text.replace('-', '');
	const [int = '', frac = ''] = body.split('.');
	return (int.replace(/^0+/, '') + frac).length;
}

/** One key press -> the next state. A key that cannot enter returns the state unchanged. */
export function pressNumberKey(state: DraftState, key: NumberKey, rules: KeyRules): DraftState {
	const { text, fresh } = state;
	switch (key) {
		case 'clear':
			return { text: '', fresh: false };
		case 'backspace':
			return { text: text.slice(0, -1), fresh: false };
		case 'sign': {
			if (!rules.allowNegative) return state;
			return { text: text.startsWith('-') ? text.slice(1) : `-${text}`, fresh: false };
		}
		case '.': {
			if (rules.decimals <= 0) return state;
			const base = fresh ? '' : text;
			if (base.includes('.')) return state;
			return { text: `${base}.`, fresh: false };
		}
		default: {
			const base = fresh ? '' : text;
			const neg = base.startsWith('-');
			let body = neg ? base.slice(1) : base;
			// a lone leading zero is replaced, not stacked ("0" + "7" -> "7")
			if (body === '0') body = '';
			const next = `${neg ? '-' : ''}${body}${key}`;
			const dot = next.indexOf('.');
			if (dot >= 0 && next.length - dot - 1 > rules.decimals) return state;
			if (significantDigits(next) > MAX_DIGITS) return state;
			return { text: next, fresh: false };
		}
	}
}

// ---------------------------------------------------------------- status

/** Canonical form of a numeric draft (§8.3), or `null` when it is not a number yet. */
export function normalizeDraft(text: string): string | null {
	const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
	if (!m) return null;
	const neg = m[1] === '-';
	const intRaw = m[2] ?? '';
	const frac = m[3] ?? '';
	if (intRaw === '' && frac === '') return null;
	const int = intRaw.replace(/^0+(?=\d)/, '') || '0';
	const zero = /^0*$/.test(int + frac);
	return `${neg && !zero ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** HTML "valid floating-point number" subset the keypad writes: `-?\d+(\.\d+)?`. */
export function isWritableNumber(text: string): boolean {
	return /^-?\d+(\.\d+)?$/.test(text);
}

export type DraftStatus =
	| { kind: 'empty'; canConfirm: boolean; notice: 'required' | null }
	| { kind: 'partial'; canConfirm: false }
	| {
			kind: 'invalid';
			canConfirm: false;
			reason: 'range' | 'step';
			min: string | null;
			max: string | null;
			/** For `step`: the nearest valid values below and above. */
			lower: string | null;
			upper: string | null;
	  }
	| { kind: 'valid'; canConfirm: true; value: string };

/** Nearest values below and above `value` that satisfy one step rule. */
export function nearestSteps(value: Dec, rule: StepRule): { lower: Dec; upper: Dec } {
	const k = floorDivDec(subDec(value, rule.base), rule.step);
	const lower = addDec(rule.base, mulInt(rule.step, k));
	return { lower, upper: addDec(lower, rule.step) };
}

function satisfiesAll(v: Dec, rules: NumberRules): boolean {
	if (rules.min && cmpDec(v, rules.min) < 0) return false;
	if (rules.max && cmpDec(v, rules.max) > 0) return false;
	if (!rules.allowNegative && v.n < 0n) return false;
	return rules.steps.every((r) => cmpDec(nearestSteps(v, r).lower, v) === 0);
}

/** Search bound when walking the failing step's grid for a value every rule accepts. */
const NEAREST_SEARCH_LIMIT = 1000;

/**
 * Nearest values below and above `value` that satisfy EVERY rule (range, sign and all
 * steps), found by walking the failing rule's grid. `null` on a side when none is found.
 */
export function nearestValid(
	value: Dec,
	failing: StepRule,
	rules: NumberRules
): { lower: Dec | null; upper: Dec | null } {
	const first = nearestSteps(value, failing);
	let lower: Dec | null = null;
	let upper: Dec | null = null;
	let c = first.lower;
	for (let i = 0; i < NEAREST_SEARCH_LIMIT; i++) {
		if (rules.min && cmpDec(c, rules.min) < 0) break;
		if (satisfiesAll(c, rules)) {
			lower = c;
			break;
		}
		c = subDec(c, failing.step);
	}
	c = first.upper;
	for (let i = 0; i < NEAREST_SEARCH_LIMIT; i++) {
		if (rules.max && cmpDec(c, rules.max) > 0) break;
		if (satisfiesAll(c, rules)) {
			upper = c;
			break;
		}
		c = addDec(c, failing.step);
	}
	return { lower, upper };
}

/** Decides what the draft is and whether it can be confirmed (§8.2). */
export function classifyDraft(text: string, rules: NumberRules): DraftStatus {
	if (text === '') {
		return {
			kind: 'empty',
			canConfirm: !rules.required,
			notice: rules.required ? 'required' : null
		};
	}
	const norm = normalizeDraft(text);
	if (norm === null) return { kind: 'partial', canConfirm: false };
	const v = parseDec(norm);
	if (!v) return { kind: 'partial', canConfirm: false };
	const minS = rules.min ? formatDec(rules.min) : null;
	const maxS = rules.max ? formatDec(rules.max) : null;
	const outOfRange =
		(rules.min && cmpDec(v, rules.min) < 0) ||
		(rules.max && cmpDec(v, rules.max) > 0) ||
		(!rules.allowNegative && v.n < 0n);
	if (outOfRange) {
		return {
			kind: 'invalid',
			canConfirm: false,
			reason: 'range',
			min: minS,
			max: maxS,
			lower: null,
			upper: null
		};
	}
	for (const rule of rules.steps) {
		const { lower } = nearestSteps(v, rule);
		if (cmpDec(lower, v) !== 0) {
			const near = nearestValid(v, rule, rules);
			return {
				kind: 'invalid',
				canConfirm: false,
				reason: 'step',
				min: minS,
				max: maxS,
				lower: near.lower ? formatDec(near.lower) : null,
				upper: near.upper ? formatDec(near.upper) : null
			};
		}
	}
	return { kind: 'valid', canConfirm: true, value: norm };
}
