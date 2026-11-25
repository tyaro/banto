// @vitest-environment jsdom
/**
 * TouchKeysHost in jsdom (touch-keypad-design §14.2): DOM in/out and "called / not
 * called" only. Hit testing, the top layer, real focus moves and the browser's own
 * number validation are NOT here - jsdom has none of them (tests/browser covers those).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import HostHarness from './HostHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	// Same stand-in as the @banto/ui / forms tests: jsdom has no popover.
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		this.dataset.popoverOpen = 'true';
		this.style.display = 'flex';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(document, 'elementsFromPoint');
});

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const key = (name: string | RegExp) => screen.getByRole('button', { name });
const pad = () => document.querySelector<HTMLElement>('[data-touch-keys-surface]');
const draft = () => screen.getByTestId('draft').textContent;

/** Counts `input` / `change` emitted on `el`. */
function watch(el: HTMLElement) {
	const seen = { input: 0, change: 0 };
	el.addEventListener('input', () => seen.input++);
	el.addEventListener('change', () => seen.change++);
	return seen;
}

async function openOn(id: string) {
	const el = field(id);
	el.focus();
	await fireEvent.click(el);
	return el;
}

describe('TouchKeysHost: open', () => {
	it('opens on a tap, not on focus, and starts from the field value', async () => {
		const onopen = vi.fn();
		render(HostHarness, { onopen });
		const qty = field('qty');
		qty.focus();
		await fireEvent.focus(qty);
		expect(pad()).toBeNull();
		await fireEvent.click(qty);
		expect(pad()).not.toBeNull();
		expect(pad()!.dataset.popoverOpen).toBe('true');
		expect(draft()).toBe('12');
		expect(screen.getByRole('group', { name: 'テンキー 数量' })).toBeTruthy();
		expect(onopen).toHaveBeenCalledWith(qty);
	});

	it('reads the rules from the attributes (inputmode="decimal") and names it from aria-label', async () => {
		render(HostHarness);
		await openOn('dec');
		expect(screen.getByRole('group', { name: 'テンキー 重さ' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '.' })).toBeTruthy();
	});

	it('leaves readonly, touchKeys(false), data-touch-keys="off" and text-on-number fields alone', async () => {
		render(HostHarness);
		for (const id of ['ro', 'ro-text', 'off', 'wrapped', 'numtext']) {
			await fireEvent.pointerDown(field(id));
			await fireEvent.click(field(id));
			expect(pad(), id).toBeNull();
			expect(field(id).getAttribute('inputmode'), id).toBeNull();
		}
	});

	it('resolve: options for a field the app did not write, false to keep the keys off', async () => {
		const resolve = vi.fn((input: HTMLInputElement) =>
			input.id === 'name'
				? ({ kind: 'number', max: 5, label: '段' } as const)
				: input.id === 'dec'
					? false
					: undefined
		);
		render(HostHarness, { resolve });
		await fireEvent.click(field('dec'));
		expect(pad()).toBeNull();
		await openOn('name');
		expect(screen.getByRole('group', { name: 'テンキー 段' })).toBeTruthy();
		await fireEvent.click(key('7'));
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
	});

	it('enabled=false: nothing opens, no inputmode is touched; turning it off closes and restores', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { enabled: false, oncancel });
		const dec = field('dec');
		await fireEvent.pointerDown(dec);
		await fireEvent.click(dec);
		expect(pad()).toBeNull();
		expect(dec.getAttribute('inputmode')).toBe('decimal');

		await rerender({ enabled: true });
		await fireEvent.pointerDown(dec);
		expect(dec.getAttribute('inputmode')).toBe('none');
		await openOn('dec');
		expect(pad()).not.toBeNull();
		// still read as a decimal field although the attribute now says "none"
		expect(screen.getByRole('button', { name: '.' })).toBeTruthy();

		await rerender({ enabled: false });
		expect(pad()).toBeNull();
		expect(oncancel).toHaveBeenCalledWith({ input: dec, reason: 'disabled' });
		expect(dec.getAttribute('inputmode')).toBe('decimal');
	});

	it('a field that stops being a keypad field gets its own inputmode back (host still on)', async () => {
		const { rerender } = render(HostHarness);
		const dec = field('dec');
		await fireEvent.pointerDown(dec);
		expect(dec.getAttribute('inputmode')).toBe('none');
		// an "off" ancestor, with another marker between it and the field
		await rerender({ decOff: true });
		await fireEvent.pointerDown(dec);
		await fireEvent.click(dec);
		expect(pad()).toBeNull();
		expect(dec.getAttribute('inputmode')).toBe('decimal');

		await rerender({ decOff: false });
		await fireEvent.pointerDown(dec);
		expect(dec.getAttribute('inputmode')).toBe('none');
		// the same through the options: resolve now says "no keys here"
		await rerender({
			resolve: (input: HTMLInputElement) => (input.id === 'dec' ? false : undefined)
		});
		await fireEvent.pointerDown(dec);
		await fireEvent.click(dec);
		expect(pad()).toBeNull();
		expect(dec.getAttribute('inputmode')).toBe('decimal');
	});

	it('an inputmode the app rewrote meanwhile is left alone when the field goes off', async () => {
		const { rerender } = render(HostHarness);
		const dec = field('dec');
		await fireEvent.pointerDown(dec);
		dec.setAttribute('inputmode', 'numeric');
		await rerender({ decOff: true });
		await fireEvent.pointerDown(dec);
		expect(dec.getAttribute('inputmode')).toBe('numeric');
	});

	it('a tap on a label suppresses the OS keyboard of its field', async () => {
		render(HostHarness);
		await fireEvent.pointerDown(screen.getByText('数量'));
		expect(field('qty').getAttribute('inputmode')).toBe('none');
	});

	it('uses supplied messages and placement, and renders the note with the draft', async () => {
		render(HostHarness, {
			messages: { confirm: () => 'OK' },
			placement: { number: 'bottom' },
			withNote: true
		});
		await openOn('qty');
		expect(key('OK')).toBeTruthy();
		expect(pad()!.dataset.touchKeysSurface).toBe('bottom');
		await fireEvent.click(key('7'));
		expect(screen.getByTestId('note').textContent).toBe('7 kg');
	});
});

describe('TouchKeysHost: openOnFocus', () => {
	const onFocusFor = (ids: string[]) => (input: HTMLInputElement) =>
		ids.includes(input.id) ? ({ openOnFocus: true } as const) : undefined;

	it('opens for a field focused in the continuation of a pointer-made click', async () => {
		render(HostHarness, { resolve: onFocusFor(['late']) });
		await fireEvent.click(document.getElementById('reveal')!, { detail: 1 });
		await tick();
		expect(document.activeElement).toBe(field('late'));
		expect(pad()).not.toBeNull();
		// the kind is still inferred from the field (type="number": the keypad)
		expect(screen.getByRole('group', { name: /^テンキー/ })).toBeTruthy();
		expect(field('late').getAttribute('inputmode')).toBe('none');
	});
	it('does not open without the option, for a keyboard-made click, or for a later focus', async () => {
		render(HostHarness, { resolve: onFocusFor(['late', 'later']) });
		await fireEvent.click(document.getElementById('reveal-later')!, { detail: 1 });
		await new Promise((r) => setTimeout(r, 60));
		expect(document.activeElement).toBe(field('later'));
		expect(pad()).toBeNull();
		// the same button, a click made by the keyboard (detail 0)
		await fireEvent.click(document.getElementById('reveal')!, { detail: 0 });
		await tick();
		expect(document.activeElement).toBe(field('late'));
		expect(pad()).toBeNull();
	});
	it('another input between the tap and the focus (a key, a keyboard-made click) closes the window', async () => {
		render(HostHarness, { resolve: onFocusFor(['late']) });
		const reveal = document.getElementById('reveal')!;
		reveal.addEventListener('click', () => fireEvent.keyDown(reveal, { key: 'Tab' }), {
			once: true
		});
		await fireEvent.click(reveal, { detail: 1 });
		await tick();
		expect(document.activeElement).toBe(field('late'));
		expect(pad()).toBeNull();
	});
	it('without the option a field focused after a tap stays closed; focus alone never opens', async () => {
		render(HostHarness);
		await fireEvent.click(document.getElementById('reveal')!, { detail: 1 });
		await tick();
		expect(document.activeElement).toBe(field('late'));
		expect(pad()).toBeNull();
		field('qty').focus();
		expect(pad()).toBeNull();
	});
	it('an explicit kind and range still apply together with the option', async () => {
		render(HostHarness, {
			resolve: (i) => (i.id === 'late' ? { kind: 'number', max: 5, openOnFocus: true } : undefined)
		});
		await fireEvent.click(document.getElementById('reveal')!, { detail: 1 });
		await tick();
		await fireEvent.click(key('7'));
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe('TouchKeysHost: confirm and cancel', () => {
	it('confirm writes the value, emits input and change once each, and reaches bind:value', async () => {
		const onconfirm = vi.fn();
		render(HostHarness, { onconfirm });
		const qty = await openOn('qty');
		const seen = watch(qty);
		await fireEvent.click(key('7'));
		await fireEvent.click(key('5'));
		await fireEvent.click(key('確定'));
		expect(qty.value).toBe('75');
		expect(seen).toEqual({ input: 1, change: 1 });
		expect(screen.getByTestId('bound').textContent).toBe('75');
		expect(pad()).toBeNull();
		expect(onconfirm).toHaveBeenCalledWith({ input: qty, value: '75', previous: '12' });
	});

	it('cancel writes nothing and emits nothing', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		const seen = watch(qty);
		await fireEvent.click(key('7'));
		await fireEvent.click(key('取り消し'));
		expect(qty.value).toBe('12');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(pad()).toBeNull();
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'cancel-key' });
	});

	it('confirm is disabled while the draft cannot be confirmed', async () => {
		render(HostHarness);
		await openOn('qty');
		for (const k of ['1', '0', '0', '0']) await fireEvent.click(key(k));
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
	});

	it('the next keypad does not show the previous draft', async () => {
		render(HostHarness);
		await openOn('qty');
		await fireEvent.click(key('7'));
		await fireEvent.click(key('取り消し'));
		await openOn('dec');
		expect(draft()).toBe('1.5');
	});

	it('a tap on the catch surface cancels as "outside"', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		expect(await fireEvent.mouseDown(pad()!)).toBe(false); // focus is not taken
		expect(await fireEvent.pointerDown(pad()!)).toBe(false);
		await fireEvent.click(pad()!);
		expect(pad()).toBeNull();
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'outside' });
	});

	it('a tap on the surface over another keypad field moves the keys there in one tap', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		const dec = field('dec');
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			value: () => [pad()!, dec, document.body]
		});
		await fireEvent.click(pad()!);
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'outside' });
		expect(screen.getByRole('group', { name: 'テンキー 重さ' })).toBeTruthy();
		expect(document.activeElement).toBe(dec);
		expect(dec.getAttribute('inputmode')).toBe('none');
	});

	it('a tap on the surface over a button does not open or press anything', async () => {
		render(HostHarness);
		await openOn('qty');
		const save = screen.getByRole('button', { name: '保存' });
		const pressed = vi.fn();
		save.addEventListener('click', pressed);
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			value: () => [pad()!, save]
		});
		await fireEvent.click(pad()!);
		expect(pad()).toBeNull();
		expect(pressed).not.toHaveBeenCalled();
	});
});

describe('TouchKeysHost: hardware keys (§6.3)', () => {
	it('a character key closes the keys and is not prevented', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		await fireEvent.click(key('7'));
		expect(await fireEvent.keyDown(qty, { key: '3' })).toBe(true);
		expect(pad()).toBeNull();
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'hardware-input' });
		// the Enter that follows (a scanner's suffix) goes through
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
	});

	it('modifier keys alone do not close', async () => {
		render(HostHarness);
		const qty = await openOn('qty');
		await fireEvent.keyDown(qty, { key: 'Shift' });
		expect(pad()).not.toBeNull();
	});

	it('beforeinput on the field closes the keys', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		await fireEvent(qty, new Event('beforeinput', { bubbles: true, cancelable: true }));
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'hardware-input' });
	});

	it('Enter with an unconfirmed change only closes: prevented, the field handler does not run, nothing is written', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const qty = await openOn('qty');
		const seen = watch(qty);
		await fireEvent.click(key('7'));
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(false);
		expect(pad()).toBeNull();
		expect(onkeydown).not.toHaveBeenCalled();
		expect(qty.value).toBe('12');
		expect(seen).toEqual({ input: 0, change: 0 });
		// a second, fresh Enter is an ordinary one
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
		expect(onkeydown).toHaveBeenCalledOnce();
	});

	it('held-down Enter: the auto-repeats after the closing Enter are swallowed until keyup', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const qty = await openOn('qty');
		await fireEvent.click(key('7'));
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(false);
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
		expect(onkeydown).not.toHaveBeenCalled();
		await fireEvent.keyUp(qty, { key: 'Enter' });
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
	});

	it('a repeating Enter never passes through open keys, even with nothing pending', async () => {
		render(HostHarness);
		const qty = await openOn('qty');
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
		expect(pad()).toBeNull();
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
	});

	it('held-down Enter with nothing pending: the first goes through, its repeats are swallowed until keyup', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const qty = await openOn('qty');
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
		expect(pad()).toBeNull();
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
		expect(await fireEvent.keyDown(qty, { key: 'Enter', repeat: true })).toBe(false);
		expect(onkeydown).toHaveBeenCalledOnce();
		await fireEvent.keyUp(qty, { key: 'Enter' });
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
		expect(onkeydown).toHaveBeenCalledTimes(2);
	});

	it('Enter with nothing pending closes the keys and goes through', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const qty = await openOn('qty');
		expect(await fireEvent.keyDown(qty, { key: 'Enter' })).toBe(true);
		expect(pad()).toBeNull();
		expect(onkeydown).toHaveBeenCalledOnce();
	});
});

describe('TouchKeysHost: the target changed or went away (§6.2, §6.5, §8.3)', () => {
	it('the field was removed: closes as target-gone', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		await rerender({ show: false });
		await waitFor(() => expect(pad()).toBeNull());
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'target-gone' });
	});

	it('the field became readonly / lost focus / its form was submitted: closes as target-gone', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		qty.readOnly = true;
		await waitFor(() => expect(pad()).toBeNull());
		qty.readOnly = false;

		await openOn('qty');
		await fireEvent.focusOut(qty);
		expect(pad()).toBeNull();

		await openOn('qty');
		await fireEvent.submit(qty.form!);
		expect(pad()).toBeNull();
		expect(oncancel.mock.calls.map((c) => c[0].reason)).toEqual([
			'target-gone',
			'target-gone',
			'target-gone'
		]);
	});

	it('the value was rewritten after open: nothing is written, no event, target-changed', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		const seen = watch(qty);
		await fireEvent.click(key('7'));
		qty.value = '40';
		await fireEvent.click(key('確定'));
		expect(qty.value).toBe('40');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'target-changed' });
	});

	it('editKey (a function) changed with the same value: target-changed at confirm', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, editKey: 1 });
		const qty = await openOn('qty');
		const seen = watch(qty);
		await fireEvent.click(key('7'));
		await rerender({ editKey: 2 });
		expect(pad()).not.toBeNull();
		await fireEvent.click(key('確定'));
		expect(qty.value).toBe('12');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'target-changed' });
	});

	it('editKey (a value) changed: the re-attached options cancel right away', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, editKey: 1 });
		const rec = await openOn('rec');
		await fireEvent.click(key('7'));
		await rerender({ editKey: 2 });
		await tick();
		expect(pad()).toBeNull();
		expect(rec.value).toBe('5');
		expect(oncancel).toHaveBeenCalledWith({ input: rec, reason: 'target-changed' });
	});

	it('same value and same editKey: written', async () => {
		const { rerender } = render(HostHarness, { editKey: 1 });
		const rec = await openOn('rec');
		await fireEvent.click(key('7'));
		await rerender({ editKey: 1 });
		await fireEvent.click(key('確定'));
		expect(rec.value).toBe('7');
	});

	it('the rules changed after open (max lowered): a value over the new max is not written', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, recMax: 100 });
		const rec = await openOn('rec');
		const seen = watch(rec);
		await fireEvent.click(key('8'));
		await fireEvent.click(key('0'));
		await rerender({ recMax: 50 });
		await tick();
		expect(pad()).not.toBeNull(); // same value, same editKey: still open
		await fireEvent.click(key('確定'));
		expect(pad()).toBeNull();
		expect(rec.value).toBe('5');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: rec, reason: 'target-changed' });
	});

	it('the rules changed after open, the value still satisfies them: written', async () => {
		const { rerender } = render(HostHarness, { recMax: 100 });
		const rec = await openOn('rec');
		const seen = watch(rec);
		await fireEvent.click(key('4'));
		await fireEvent.click(key('0'));
		await rerender({ recMax: 50 });
		await tick();
		await fireEvent.click(key('確定'));
		expect(rec.value).toBe('40');
		expect(seen).toEqual({ input: 1, change: 1 });
	});

	it('decimals were lowered after open: an entered value with more fraction digits is not written', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, recDecimals: 2 });
		const rec = await openOn('rec');
		const seen = watch(rec);
		for (const k of ['1', '.', '2', '5']) await fireEvent.click(key(k));
		await rerender({ recDecimals: 1 });
		await tick();
		await fireEvent.click(key('確定'));
		expect(pad()).toBeNull();
		expect(rec.value).toBe('5');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: rec, reason: 'target-changed' });
	});

	it('decimals were lowered after open: fewer digits, or the untouched opening value, are written', async () => {
		const { rerender } = render(HostHarness, { recDecimals: 2 });
		const rec = await openOn('rec');
		for (const k of ['1', '.', '2']) await fireEvent.click(key(k));
		await rerender({ recDecimals: 1 });
		await tick();
		await fireEvent.click(key('確定'));
		expect(rec.value).toBe('1.2');

		await rerender({ recDecimals: 2 });
		rec.value = '1.25';
		await openOn('rec');
		const seen = watch(rec);
		await rerender({ recDecimals: 1 });
		await tick();
		await fireEvent.click(key('確定'));
		expect(rec.value).toBe('1.25');
		expect(seen).toEqual({ input: 1, change: 1 });
	});

	it('required was added after open: an empty value is not written, no event', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel });
		const dec = await openOn('dec');
		const seen = watch(dec);
		await fireEvent.click(key('全部消す'));
		await rerender({ decRequired: true });
		await fireEvent.click(key('確定'));
		expect(pad()).toBeNull();
		expect(dec.value).toBe('1.5');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: dec, reason: 'target-changed' });
	});

	it('form reset that changes the value closes as target-changed', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const dec = await openOn('dec');
		dec.form!.reset(); // same value as at open: stays
		await new Promise((r) => setTimeout(r, 5));
		expect(pad()).not.toBeNull();
		await fireEvent.click(key('取り消し'));

		dec.value = '9';
		await openOn('dec');
		dec.form!.reset();
		await waitFor(() => expect(pad()).toBeNull());
		expect(oncancel).toHaveBeenLastCalledWith({ input: dec, reason: 'target-changed' });
	});

	it('a field that does not keep the written value gets its opening value back and no event', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const dec = field('dec');
		// stand-in for type="number" silently blanking a string it does not accept
		let held = '1.5';
		Object.defineProperty(dec, 'value', {
			configurable: true,
			get: () => held,
			set: (next: string) => {
				held = next === '1.5' ? next : '';
			}
		});
		await openOn('dec');
		const seen = watch(dec);
		await fireEvent.click(key('7'));
		await fireEvent.click(key('確定'));
		expect(dec.value).toBe('1.5');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: dec, reason: 'target-changed' });
	});
});

describe('TouchKeysHost: Esc layer (§7.3)', () => {
	it('carries data-esc-layer only while open and no aria-modal', async () => {
		render(HostHarness);
		expect(document.querySelector('[data-esc-layer]')).toBeNull();
		await openOn('qty');
		expect(pad()!.hasAttribute('data-esc-layer')).toBe(true);
		expect(document.querySelector('[aria-modal]')).toBeNull();
		await fireEvent.click(key('取り消し'));
		expect(document.querySelector('[data-esc-layer]')).toBeNull();
	});

	it('consumes Esc and cancels', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const qty = await openOn('qty');
		expect(await fireEvent.keyDown(qty, { key: 'Escape' })).toBe(false);
		expect(pad()).toBeNull();
		expect(oncancel).toHaveBeenCalledWith({ input: qty, reason: 'cancel-key' });
	});

	it('yields an Esc that something else already consumed', async () => {
		render(HostHarness, { onkeydown: (event) => event.preventDefault() });
		const qty = await openOn('qty');
		await fireEvent.keyDown(qty, { key: 'Escape' });
		expect(pad()).not.toBeNull();
	});
});
