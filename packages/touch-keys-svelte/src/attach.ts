/**
 * `touchKeys` — the per-field attachment (touch-keypad-design §5.2). It only
 * records the field's options in a `WeakMap`; opening and closing is the
 * host's one place (`TouchKeysHost`), so the attachment holds no DOM listener.
 *
 * Plain `.ts` on purpose (no `.svelte.ts` in this package, design §17).
 */
import type { Attachment } from 'svelte/attachments';
import type { TouchKeysOptions } from './types';

const registry = new WeakMap<Element, TouchKeysOptions | false>();
const listeners = new Set<(el: Element) => void>();

/**
 * `{@attach touchKeys({ kind: 'number', min: 0, max: 999 })}` sets the field's
 * keypad options; `{@attach touchKeys(false)}` keeps the keys off this field.
 */
export function touchKeys(options: TouchKeysOptions | false): Attachment<HTMLInputElement> {
	return (el) => {
		registry.set(el, options);
		for (const fn of listeners) fn(el);
		return () => {
			if (registry.get(el) === options) registry.delete(el);
		};
	};
}

/** Package-internal: the options attached to `el` (`undefined` = no attachment). */
export function attachedOptions(el: Element): TouchKeysOptions | false | undefined {
	return registry.get(el);
}

/** Package-internal: called whenever an attachment (re)sets a field's options. Returns the unsubscribe. */
export function onAttach(fn: (el: Element) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
