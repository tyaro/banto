// @vitest-environment jsdom
/** textMirror.svelte.ts: the typed-text box kept in step with a bound value (#816). */
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createTextMirror, type TextMirrorOptions } from '../src/textMirror.svelte.js';

function setup(initial: string | null, extra: Partial<TextMirrorOptions> = {}) {
	let value = $state<string | null>(initial);
	const held: { mirror?: ReturnType<typeof createTextMirror> } = {};
	const cleanup = $effect.root(() => {
		held.mirror = createTextMirror({ value: () => value, ...extra });
	});
	flushSync();
	return {
		mirror: held.mirror as ReturnType<typeof createTextMirror>,
		set: (v: string | null) => {
			value = v;
			flushSync();
		},
		cleanup
	};
}

describe('createTextMirror', () => {
	it('starts from the value, null as an empty box', () => {
		const a = setup('09:30');
		expect(a.mirror.text).toBe('09:30');
		const b = setup(null);
		expect(b.mirror.text).toBe('');
		a.cleanup();
		b.cleanup();
	});

	it('rewrites the box when the parent changes the value', () => {
		const s = setup('09:30');
		s.set('10:00');
		expect(s.mirror.text).toBe('10:00');
		s.set(null);
		expect(s.mirror.text).toBe('');
		s.cleanup();
	});

	it('keeps typed text until the value changes', () => {
		const s = setup('09:30');
		s.mirror.setText('9');
		flushSync();
		expect(s.mirror.text).toBe('9');
		s.cleanup();
	});

	it("does not rewrite the box for the component's own commit", () => {
		const s = setup(null);
		s.mirror.setText('9:5');
		s.mirror.committed('09:05');
		s.set('09:05');
		expect(s.mirror.text).toBe('9:5');
		s.cleanup();
	});

	it('applies toText on init and on a parent change', () => {
		const toText = (v: string | null | undefined) => (v ? v.replace('T', ' ') : '');
		const s = setup('2026-11-07T09:30', { toText });
		expect(s.mirror.text).toBe('2026-11-07 09:30');
		s.set('2026-11-08T10:00');
		expect(s.mirror.text).toBe('2026-11-08 10:00');
		s.cleanup();
	});

	it('keepTypedEcho leaves the box as typed when the parent echoes it back', () => {
		const toText = (v: string | null | undefined) => (v ? v.replace('T', ' ') : '');
		const echo = setup(null, { toText, keepTypedEcho: true });
		echo.mirror.setText('2026-11-07T09:30');
		echo.set('2026-11-07T09:30');
		expect(echo.mirror.text).toBe('2026-11-07T09:30');
		const plain = setup(null, { toText });
		plain.mirror.setText('2026-11-07T09:30');
		plain.set('2026-11-07T09:30');
		expect(plain.mirror.text).toBe('2026-11-07 09:30');
		echo.cleanup();
		plain.cleanup();
	});
});
