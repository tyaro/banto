/**
 * `@banto/touch-keys-svelte` `messages` prop from Paraglide (conventions §13,
 * the same layer as `gridMessages()` etc. in i18n.ts). A file of its own so
 * `pnpm scaffold` removes the optional asset by deleting it
 * (docs/recipes/remove-optional-assets.md, touch-keypad-design §16).
 *
 * Every item of `TouchKeysMessages` is mapped: an item left out would show the
 * package's Japanese default under the English locale. Key legends (digits,
 * letters, kana, symbols) are not messages and stay in the package.
 */
import type { TouchKeysMessages } from '@banto/touch-keys-svelte';
import * as m from '#lib/paraglide/messages.js';

export function touchKeysMessages(): Required<TouchKeysMessages> {
	return {
		numberKeypad: () => m['touchKeys.numberKeypad'](),
		confirm: () => m['touchKeys.confirm'](),
		cancel: () => m['touchKeys.cancel'](),
		backspace: () => m['touchKeys.backspace'](),
		clearAll: () => m['touchKeys.clearAll'](),
		sign: () => m['touchKeys.sign'](),
		range: (min, max) =>
			min !== null && max !== null
				? m['touchKeys.range.both']({ min, max })
				: min !== null
					? m['touchKeys.range.min']({ min })
					: max !== null
						? m['touchKeys.range.max']({ max })
						: '',
		step: (lower, upper) =>
			lower !== null && upper !== null
				? m['touchKeys.step.both']({ lower, upper })
				: lower !== null || upper !== null
					? m['touchKeys.step.one']({ value: lower ?? upper ?? '' })
					: m['touchKeys.step.none'](),
		required: () => m['touchKeys.required'](),
		textKeyboard: () => m['touchKeys.textKeyboard'](),
		alnum: () => m['touchKeys.alnum'](),
		symbol: () => m['touchKeys.symbol'](),
		kana: () => m['touchKeys.kana'](),
		dakuten: () => m['touchKeys.dakuten'](),
		handakuten: () => m['touchKeys.handakuten'](),
		small: () => m['touchKeys.small'](),
		upper: () => m['touchKeys.upper'](),
		lower: () => m['touchKeys.lower'](),
		space: () => m['touchKeys.space'](),
		length: (length, max) =>
			max !== null
				? m['touchKeys.length.max']({ length, max })
				: m['touchKeys.length.count']({ length }),
		maxLength: (max) => m['touchKeys.maxLength']({ max }),
		minLength: (min) => m['touchKeys.minLength']({ min }),
		lengthConflict: (min, max) => m['touchKeys.lengthConflict']({ min, max }),
		invalid: () => m['touchKeys.invalid']()
	};
}
