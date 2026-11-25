/**
 * Pure text-keyboard core (touch-keypad-design §5.5, §9.1, §9.3, §9.4): the key
 * tables, one key press -> the next draft, and whether a draft can be confirmed.
 * No DOM, no Svelte.
 *
 * The draft is edited at its END only (append / delete the last character); the
 * keys never place a caret. Every character the keys enter is one UTF-16 code
 * unit, so `maxLength` counts exactly like the HTML `maxlength` attribute.
 */

/** A key layout of the text keyboard. (`kana` joins in a later stage, design §15 T4.) */
export type TextLayout = 'alnum' | 'symbol';

export const TEXT_LAYOUTS: readonly TextLayout[] = ['alnum', 'symbol'];

export interface TextRules {
	/** Upper bound in UTF-16 code units (as `maxlength`). `undefined` = no bound. */
	maxLength: number | undefined;
	/** An empty draft cannot be confirmed. */
	required: boolean;
}

export interface TextSpec {
	maxLength?: number;
	required?: boolean;
}

/** What the `<input>` says about its text (attribute strings as written). */
export interface TextAttrs {
	maxlength?: string | null;
	required?: boolean;
}

function lengthBound(value: number | string | null | undefined): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) return undefined;
	const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The rules of one field. `maxLength` comes from the options and the `maxlength`
 * attribute; when both exist the SMALLER one wins, so options can tighten but never
 * loosen what the field itself declares (same stance as `type="number"`, §5.4).
 * `required` is true when either side says so.
 */
export function resolveTextRules(attrs: TextAttrs, spec: TextSpec = {}): TextRules {
	const fromSpec = lengthBound(spec.maxLength);
	const fromAttr = lengthBound(attrs.maxlength);
	const maxLength =
		fromSpec !== undefined && fromAttr !== undefined
			? Math.min(fromSpec, fromAttr)
			: (fromSpec ?? fromAttr);
	return { maxLength, required: Boolean(spec.required || attrs.required) };
}

// ---------------------------------------------------------------- key tables

const ALNUM_ROWS: readonly string[] = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
/** The short symbol set of ordinary text fields (§9.1). */
const SYMBOL_ROWS: readonly string[] = ['-_.,/:@#()', '+*=%&!?'];
/** Every printable ASCII symbol (32), for password fields (§5.5). */
const SYMBOL_ROWS_FULL: readonly string[] = ['!"#$%&\'()*', '+,-./:;<=>', '?@[\\]^_`{|', '}~'];

export interface TextKeyRowsOptions {
	/** `alnum`: letters in upper case. */
	upper?: boolean;
	/** `symbol`: all 32 printable ASCII symbols instead of the short set. */
	fullSymbols?: boolean;
}

/** The character keys of one layout, row by row. The space key is separate (always present). */
export function textKeyRows(layout: TextLayout, options: TextKeyRowsOptions = {}): string[][] {
	const rows =
		layout === 'symbol' ? (options.fullSymbols ? SYMBOL_ROWS_FULL : SYMBOL_ROWS) : ALNUM_ROWS;
	return rows.map((row) => {
		const keys = [...row];
		return layout === 'alnum' && options.upper ? keys.map((k) => k.toUpperCase()) : keys;
	});
}

/** Every character the keys can enter with these layouts (both letter cases, plus the space key). */
export function reachableChars(
	layouts: readonly TextLayout[],
	options: Pick<TextKeyRowsOptions, 'fullSymbols'> = {}
): Set<string> {
	const chars = new Set<string>([' ']);
	for (const layout of layouts) {
		for (const upper of [false, true]) {
			for (const row of textKeyRows(layout, { upper, fullSymbols: options.fullSymbols })) {
				for (const k of row) chars.add(k);
			}
		}
	}
	return chars;
}

/**
 * The layouts a keyboard offers, in order: unknown names and duplicates dropped,
 * never empty (falls back to all). A password field always gets `alnum` + `symbol`
 * so that every printable ASCII character stays reachable (§5.5).
 */
export function resolveTextLayouts(
	layouts: readonly string[] | undefined,
	masked = false
): TextLayout[] {
	if (masked) return [...TEXT_LAYOUTS];
	const known = (layouts ?? TEXT_LAYOUTS).filter((l): l is TextLayout =>
		(TEXT_LAYOUTS as readonly string[]).includes(l)
	);
	const unique = [...new Set(known)];
	return unique.length > 0 ? unique : [...TEXT_LAYOUTS];
}

// ---------------------------------------------------------------- key entry

export type TextKey = { char: string } | 'backspace' | 'clear';

/** One key press -> the next draft. A key that cannot enter returns the draft unchanged. */
export function pressTextKey(text: string, key: TextKey, rules: { maxLength?: number }): string {
	if (key === 'clear') return '';
	if (key === 'backspace') {
		if (text === '') return text;
		// A value that was already in the field may end in a surrogate pair: drop it whole.
		const last = text.charCodeAt(text.length - 1);
		const before = text.length > 1 ? text.charCodeAt(text.length - 2) : 0;
		const pair = last >= 0xdc00 && last <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
		return text.slice(0, pair ? -2 : -1);
	}
	if (rules.maxLength !== undefined && text.length + key.char.length > rules.maxLength) return text;
	return text + key.char;
}

export interface TextStatus {
	canConfirm: boolean;
	/** Why not / what to tell: an empty required draft, or the length bound reached or exceeded. */
	notice: 'required' | 'max-length' | null;
}

/** Whether the draft can be written as it is (§9.3: never longer than `maxLength`). */
export function classifyText(text: string, rules: TextRules): TextStatus {
	if (text === '') {
		return rules.required
			? { canConfirm: false, notice: 'required' }
			: { canConfirm: true, notice: null };
	}
	if (rules.maxLength === undefined || text.length < rules.maxLength) {
		return { canConfirm: true, notice: null };
	}
	return { canConfirm: text.length === rules.maxLength, notice: 'max-length' };
}
