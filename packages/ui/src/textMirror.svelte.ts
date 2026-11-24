/**
 * The typed-text box of a picker input (DateInput, TimeInput, DateTimeInput)
 * kept in step with the bound `value` (#816).
 *
 * The box holds its own text while the user types; a parent's change of
 * `value` rewrites the box, but the component's own commit (which writes
 * `value` itself) does not rewrite it again. `mirrored` is the value last
 * mirrored into the text, so the two cases tell apart.
 *
 * Call it during component initialisation (it registers an `$effect`).
 */
import { untrack } from 'svelte';

export interface TextMirrorOptions {
	/** The bound value, read reactively. */
	value: () => string | null | undefined;
	/** Text shown for a value. Default: the value itself, `''` for null/undefined. */
	toText?: (value: string | null | undefined) => string;
	/**
	 * When a parent echoes the typed text back as the value (forms' FormStore
	 * path), leave the box as typed: rewriting it to its shown form mid-typing
	 * would move the caret. Default false.
	 */
	keepTypedEcho?: boolean;
}

export interface TextMirror {
	/** The box's own text (reactive). */
	readonly text: string;
	/** The user typed: replace the box's text. */
	setText(next: string): void;
	/** The component itself committed `next` as the value: do not rewrite the box for it. */
	committed(next: string | null): void;
}

export function createTextMirror(options: TextMirrorOptions): TextMirror {
	const { value, keepTypedEcho = false } = options;
	const toText = options.toText ?? ((v: string | null | undefined) => v ?? '');

	let ownText = $state(untrack(() => toText(value())));
	let mirrored: string | null | undefined = untrack(value);

	$effect(() => {
		const current = value();
		if (current === mirrored) return;
		mirrored = current;
		if (keepTypedEcho && current === untrack(() => ownText)) return;
		ownText = toText(current);
	});

	return {
		get text() {
			return ownText;
		},
		setText(next) {
			ownText = next;
		},
		committed(next) {
			mirrored = next;
		}
	};
}
