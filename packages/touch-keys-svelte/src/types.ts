/**
 * Public option types of the touch keys host (touch-keypad-design §5.1 / §5.2).
 */
import type { NumberSpec } from './core/number';
import type { TextLayout } from './core/text';

/** Where the keys appear: a centred popup over a scrim, or docked to the bottom edge. */
export type TouchKeysPlacement = 'popup' | 'bottom';

/** Why the keys closed without writing (§6.2). The draft is never handed out. */
export type TouchKeysCancelReason =
	/** The cancel key or Esc. */
	| 'cancel-key'
	/** A tap outside the keys (the tap does not reach the page underneath, §7.2.1). */
	| 'outside'
	/** A hardware key / scanner typed into the field (§6.3). */
	| 'hardware-input'
	/** The field went away, lost focus, became readonly / disabled, changed type, or its form was submitted. */
	| 'target-gone'
	/**
	 * The field's value or edit key differs from when the keys opened, the value no longer
	 * satisfies the field's rules as they are at confirm, or the write did not stick (§6.5, §8.3).
	 */
	| 'target-changed'
	/** The host's `enabled` became false (or the host was destroyed). */
	| 'disabled';

/** What the app says it is editing right now; compared at open and right before the write (§6.5). */
export type TouchKeysEditKey = string | number | (() => string | number | null | undefined);

export interface CommonKeysOptions {
	/** Heading of the keys. Default: the field's name (`aria-label` -> `<label>` -> `placeholder`). */
	label?: string;
	placement?: TouchKeysPlacement;
	/**
	 * The record / edit generation behind this field. When it differs between
	 * open and confirm, nothing is written (`target-changed`). Pass it wherever
	 * one `<input>` node is reused for different records.
	 */
	editKey?: TouchKeysEditKey;
}

/** Number keypad for one field. `min` / `max` / `step` / `decimals` as in `NumberSpec` (§5.4). */
export interface NumberKeysOptions extends CommonKeysOptions, NumberSpec {
	kind: 'number';
}

/**
 * Text keyboard for one field. On a `type="password"` field the keyboard is always
 * masked and offers every layout, whatever `layouts` says (§5.5).
 */
export interface TextKeysOptions extends CommonKeysOptions {
	kind: 'text';
	/**
	 * Upper bound in UTF-16 code units. With a `maxlength` attribute on the field the
	 * smaller of the two applies (options can tighten, never loosen).
	 */
	maxLength?: number;
	/** An empty draft cannot be confirmed (also read from the `required` attribute). */
	required?: boolean;
	/** Layouts to offer, in order. Default: the host's `layouts`. One layout = no switch keys. */
	layouts?: TextLayout[];
	/** The layout shown first. Default: the first of `layouts`. */
	initialLayout?: TextLayout;
}

export type TouchKeysOptions = NumberKeysOptions | TextKeysOptions;

export interface TouchKeysConfirmDetail {
	input: HTMLInputElement;
	/** The string written to the field. **`null` for a password field** (§5.5). */
	value: string | null;
	/** The field's value when the keys opened. **`null` for a password field** (§5.5). */
	previous: string | null;
}

export interface TouchKeysCancelDetail {
	input: HTMLInputElement;
	reason: TouchKeysCancelReason;
}
