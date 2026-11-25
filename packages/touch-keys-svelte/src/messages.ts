/**
 * i18n message bundle for the touch keys (conventions §13, layer 1). The package
 * carries no dictionary and no Paraglide: every message is a FUNCTION with a
 * Japanese default, and the app passes a bundle built from its own (Paraglide)
 * keys via the `messages` prop. Key glyphs (`0`-`9`, `.`) are not messages.
 */
export interface TouchKeysMessages {
	/** `aria-label` of the number keypad group. */
	numberKeypad?: () => string;
	confirm?: () => string;
	cancel?: () => string;
	/** Delete one character. */
	backspace?: () => string;
	/** Delete everything. */
	clearAll?: () => string;
	/** Toggle the sign (visible label of the ± key). */
	sign?: () => string;
	/** Allowed range line; either side may be absent. */
	range?: (min: string | null, max: string | null) => string;
	/** Notice for a number that does not sit on the step grid; a side is null when no candidate can be offered there. */
	step?: (lower: string | null, upper: string | null) => string;
	/** Notice for an empty draft of a required field. */
	required?: () => string;
}

export const defaultTouchKeysMessages: Required<TouchKeysMessages> = {
	numberKeypad: () => 'テンキー',
	confirm: () => '確定',
	cancel: () => '取り消し',
	backspace: () => '1文字消す',
	clearAll: () => '全部消す',
	sign: () => '符号',
	range: (min, max) =>
		min !== null && max !== null
			? `${min} 〜 ${max}`
			: min !== null
				? `${min} 以上`
				: max !== null
					? `${max} 以下`
					: '',
	step: (lower, upper) =>
		lower !== null && upper !== null
			? `${lower} か ${upper} にしてください`
			: lower !== null || upper !== null
				? `${lower ?? upper} にしてください`
				: '刻みに合いません',
	required: () => '入力が必要です'
};
