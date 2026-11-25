// @vitest-environment jsdom
/**
 * TouchKeysHost with the text keyboard and password fields in jsdom
 * (touch-keypad-design §14.2, §5.5): DOM in/out and "called / not called" only.
 * The number keypad's half is in TouchKeysHost.test.ts.
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
const key = (name: string) => screen.getByRole('button', { name });
const pad = () => document.querySelector<HTMLElement>('[data-touch-keys-surface]');
const draft = () => screen.getByTestId('draft').textContent;

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

async function type(keys: string[]) {
	for (const k of keys) await fireEvent.click(key(k));
}

describe('TouchKeysHost: text fields', () => {
	it('a tap opens the text keyboard, docked to the bottom, from the field value', async () => {
		const onopen = vi.fn();
		render(HostHarness, { onopen });
		const title = field('title');
		await fireEvent.pointerDown(title);
		expect(title.getAttribute('inputmode')).toBe('none');
		title.focus();
		await fireEvent.focus(title);
		expect(pad()).toBeNull();
		await fireEvent.click(title);
		expect(pad()!.dataset.touchKeysSurface).toBe('bottom');
		expect(screen.getByRole('group', { name: '文字キーボード 題名' })).toBeTruthy();
		expect(draft()).toBe('abc');
		expect(onopen).toHaveBeenCalledWith(title);
	});

	it('confirm writes, emits input and change once each, reaches bind:value and onconfirm', async () => {
		const onconfirm = vi.fn();
		render(HostHarness, { onconfirm });
		const title = await openOn('title');
		const seen = watch(title);
		await type(['d', '大文字', 'E', '記号', '-', '確定']);
		expect(pad()).toBeNull();
		expect(title.value).toBe('abcdE-');
		expect(seen).toEqual({ input: 1, change: 1 });
		expect(screen.getByTestId('bound-title').textContent).toBe('abcdE-');
		expect(onconfirm).toHaveBeenCalledWith({ input: title, value: 'abcdE-', previous: 'abc' });
		// off the field again: the next keyboard starts from the new value
		await openOn('title');
		expect(draft()).toBe('abcdE-');
	});

	it('cancel writes nothing and emits nothing', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const title = await openOn('title');
		const seen = watch(title);
		await type(['d', '取り消し']);
		expect(title.value).toBe('abc');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: title, reason: 'cancel-key' });
	});

	it('maxlength from the attribute: keys stop there and the count shows it', async () => {
		render(HostHarness);
		const code = await openOn('code');
		expect(screen.getByTestId('count').textContent).toBe('2 / 5');
		await type(['c', 'd', 'e', 'f', 'g']);
		expect(draft()).toBe('abcde');
		await type(['確定']);
		expect(code.value).toBe('abcde');
	});

	it('placement and layouts: the host defaults, and the field options win', async () => {
		const { rerender } = render(HostHarness, {
			placement: { text: 'popup' },
			layouts: ['alnum']
		});
		await openOn('title');
		expect(pad()!.dataset.touchKeysSurface).toBe('popup');
		expect(screen.queryByRole('button', { name: '記号' })).toBeNull();
		await type(['取り消し']);

		await rerender({ memoLayouts: ['symbol'] });
		await openOn('memo');
		expect(key('@')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '英数' })).toBeNull();
	});

	it('number and text fields take turns: one tap on the surface over the other field', async () => {
		render(HostHarness);
		await openOn('qty');
		expect(screen.getByRole('group', { name: 'テンキー 数量' })).toBeTruthy();
		const title = field('title');
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			value: () => [pad()!, title, document.body]
		});
		await fireEvent.click(pad()!);
		expect(screen.getByRole('group', { name: '文字キーボード 題名' })).toBeTruthy();
		expect(draft()).toBe('abc');
		expect(document.activeElement).toBe(title);
	});

	it('renders the note with the draft', async () => {
		render(HostHarness, { withNote: true });
		await openOn('title');
		await type(['d']);
		expect(screen.getByTestId('note').textContent).toBe('abcd kg');
		expect(screen.getByTestId('note').dataset.draftNull).toBe('no');
	});

	it('a field that stops being a text-keyboard field gets its own inputmode back', async () => {
		const { rerender } = render(HostHarness);
		const title = field('title');
		await fireEvent.pointerDown(title);
		expect(title.getAttribute('inputmode')).toBe('none');
		await rerender({
			resolve: (input: HTMLInputElement) => (input.id === 'title' ? false : undefined)
		});
		await fireEvent.pointerDown(title);
		expect(title.getAttribute('inputmode')).toBeNull();
		await fireEvent.click(title);
		expect(pad()).toBeNull();
	});
});

describe('TouchKeysHost: text fields and hardware keys (§6.3)', () => {
	it('a character key closes the keyboard and is not prevented', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const title = await openOn('title');
		await type(['d']);
		expect(await fireEvent.keyDown(title, { key: 'x' })).toBe(true);
		expect(pad()).toBeNull();
		expect(title.value).toBe('abc');
		expect(oncancel).toHaveBeenCalledWith({ input: title, reason: 'hardware-input' });
	});

	it('Enter with an unconfirmed change only closes; with nothing pending it goes through', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const title = await openOn('title');
		const seen = watch(title);
		await type(['d']);
		expect(await fireEvent.keyDown(title, { key: 'Enter' })).toBe(false);
		expect(pad()).toBeNull();
		expect(onkeydown).not.toHaveBeenCalled();
		expect(title.value).toBe('abc');
		expect(seen).toEqual({ input: 0, change: 0 });
		await fireEvent.keyUp(title, { key: 'Enter' });

		await openOn('title');
		expect(await fireEvent.keyDown(title, { key: 'Enter' })).toBe(true);
		expect(pad()).toBeNull();
		expect(onkeydown).toHaveBeenCalledOnce();
	});

	it('typed and deleted back to the opening value: nothing is pending', async () => {
		render(HostHarness);
		const title = await openOn('title');
		await type(['d', '1文字消す']);
		expect(await fireEvent.keyDown(title, { key: 'Enter' })).toBe(true);
	});
});

describe('TouchKeysHost: text fields, the target changed (§6.5)', () => {
	it('the value was rewritten after open: nothing is written, no event, target-changed', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const code = await openOn('code');
		const seen = watch(code);
		await type(['c']);
		code.value = 'zz';
		await type(['確定']);
		expect(pad()).toBeNull();
		expect(code.value).toBe('zz');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: code, reason: 'target-changed' });
	});

	it('editKey changed with the same value: nothing is written, target-changed', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, editKey: 1 });
		const memo = await openOn('memo');
		const seen = watch(memo);
		await type(['y']);
		await rerender({ editKey: 2 });
		// The harness hands every prop again, so the options are attached again and the check
		// runs right away; in an app it runs at confirm at the latest. Either way nothing is written.
		await tick();
		if (pad()) await type(['確定']);
		expect(pad()).toBeNull();
		expect(memo.value).toBe('x');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: memo, reason: 'target-changed' });
	});

	it('maxLength was lowered after open: a longer value is not written; a fitting one is', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel, memoMax: 5 });
		const memo = await openOn('memo');
		await type(['a', 'b', 'c']);
		await rerender({ memoMax: 2 });
		await tick();
		expect(pad()).not.toBeNull(); // the rules alone changing does not close
		await type(['確定']);
		expect(memo.value).toBe('x');
		expect(oncancel).toHaveBeenCalledWith({ input: memo, reason: 'target-changed' });

		await openOn('memo');
		await type(['a', '確定']);
		expect(memo.value).toBe('xa');
	});

	it('required (the attribute): an empty draft cannot be confirmed', async () => {
		render(HostHarness);
		await openOn('mail');
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
		await type(['a']);
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false);
	});

	it('a field that does not keep the written text gets its opening value back and no event', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const code = field('code');
		// stand-in for a field that sanitizes what it is given (type="email" trims white space)
		let held = 'ab';
		Object.defineProperty(code, 'value', {
			configurable: true,
			get: () => held,
			set: (next: string) => {
				held = next.trim();
			}
		});
		await openOn('code');
		const seen = watch(code);
		await type(['空白', '確定']);
		expect(code.value).toBe('ab');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel).toHaveBeenCalledWith({ input: code, reason: 'target-changed' });
	});

	it('the field went away: target-gone', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const code = await openOn('code');
		code.readOnly = true;
		await waitFor(() => expect(pad()).toBeNull());
		expect(oncancel).toHaveBeenCalledWith({ input: code, reason: 'target-gone' });
	});
});

describe('TouchKeysHost: password fields (§5.5)', () => {
	const SECRET = 'pA5$ w';
	const SECRET_KEYS = ['p', '大文字', 'A', '5', '記号', '$', '空白', '英数', '小文字', 'w'];
	const OLD = 'old-secret';

	/** Everything a hook received, with elements left out: no string in it may be a password. */
	function texts(...mocks: ReturnType<typeof vi.fn>[]): string {
		return JSON.stringify(
			mocks.flatMap((mock) => mock.mock.calls),
			(_key, value: unknown) => (value instanceof Element ? '[element]' : value)
		);
	}

	it('opens masked and empty: the current value is not copied into the keyboard', async () => {
		render(HostHarness);
		const pw = field('pw');
		await fireEvent.pointerDown(pw);
		expect(pw.getAttribute('inputmode')).toBe('none');
		await openOn('pw');
		expect(screen.getByRole('group', { name: '文字キーボード パスワード' })).toBeTruthy();
		expect(draft()).toBe(' ');
		expect(screen.getByTestId('count').textContent).toBe('0 文字');
		expect(pad()!.outerHTML).not.toContain(OLD);
	});

	it('typed characters never appear in the keys DOM: dots and the count only', async () => {
		render(HostHarness, { withNote: true });
		await openOn('pw');
		await type(SECRET_KEYS);
		expect(draft()).toBe('●'.repeat(SECRET.length));
		expect(pad()!.textContent).not.toContain(SECRET);
		expect(pad()!.outerHTML).not.toContain(SECRET);
		expect(pad()!.querySelector('[role="status"]')!.textContent).toBe('');
		// the note receives null, not the draft
		expect(screen.getByTestId('note').dataset.draftNull).toBe('yes');
		expect(screen.getByTestId('note').textContent).toBe(' kg');
	});

	it('confirm writes the field; onconfirm gets value: null and previous: null', async () => {
		const onconfirm = vi.fn();
		const onopen = vi.fn();
		const oncancel = vi.fn();
		const resolve = vi.fn(() => undefined);
		render(HostHarness, { onconfirm, onopen, oncancel, resolve });
		const pw = await openOn('pw');
		const seen = watch(pw);
		await type([...SECRET_KEYS, '確定']);
		expect(pad()).toBeNull();
		expect(pw.value).toBe(SECRET);
		expect(seen).toEqual({ input: 1, change: 1 });
		expect(onconfirm.mock.calls).toEqual([[{ input: pw, value: null, previous: null }]]);
		const handed = texts(onconfirm, onopen, oncancel, resolve);
		expect(handed).not.toContain(SECRET);
		expect(handed).not.toContain(OLD);
	});

	it('no console output carries a draft or a value', async () => {
		const spies = (['log', 'info', 'debug', 'warn', 'error', 'trace'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => {})
		);
		render(HostHarness);
		const pw = await openOn('pw');
		await type(SECRET_KEYS);
		pw.value = 'rewritten'; // a refused confirm (target-changed) says nothing either
		await type(['確定']);
		await openOn('pw');
		await type([...SECRET_KEYS, '確定']);
		const printed = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		expect(printed).not.toContain(SECRET);
		expect(printed).not.toContain(OLD);
	});

	it('the draft does not survive cancel, a switch to another field, or enabled=false', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel });
		const reopenIsEmpty = async () => {
			await openOn('pw');
			expect(draft()).toBe(' ');
			expect(screen.getByTestId('count').textContent).toBe('0 文字');
			expect(pad()!.outerHTML).not.toContain('abc');
		};

		await openOn('pw');
		await type(['a', 'b', 'c', '取り消し']);
		await reopenIsEmpty();

		// to another field through the catch surface, and back
		await type(['a', 'b', 'c']);
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			value: () => [pad()!, field('title'), document.body]
		});
		await fireEvent.click(pad()!);
		expect(screen.getByRole('group', { name: '文字キーボード 題名' })).toBeTruthy();
		expect(draft()).toBe('abc'); // the title field's own value, not the password draft
		expect(field('title').value).toBe('abc');
		Reflect.deleteProperty(document, 'elementsFromPoint');
		await type(['取り消し']);
		await reopenIsEmpty();

		await type(['a', 'b', 'c']);
		await rerender({ enabled: false });
		expect(pad()).toBeNull();
		await rerender({ enabled: true });
		await reopenIsEmpty();

		expect(field('pw').value).toBe(OLD);
		expect(texts(oncancel)).not.toContain('abc');
	});

	it('the draft does not survive the host being destroyed', async () => {
		const first = render(HostHarness);
		await openOn('pw');
		await type(['a', 'b', 'c']);
		first.unmount();
		expect(pad()).toBeNull();
		render(HostHarness);
		await openOn('pw');
		expect(draft()).toBe(' ');
		expect(screen.getByTestId('count').textContent).toBe('0 文字');
	});

	it('the type changing while open ("show password") closes the keys and writes nothing', async () => {
		const oncancel = vi.fn();
		const { rerender } = render(HostHarness, { oncancel });
		const pw = await openOn('pw');
		await type(['a', 'b', 'c']);
		await rerender({ pwType: 'text' });
		await waitFor(() => expect(pad()).toBeNull());
		expect(pw.value).toBe(OLD);
		expect(oncancel).toHaveBeenCalledWith({ input: pw, reason: 'target-gone' });
		// now an ordinary text field: opened as one, from its value
		await openOn('pw');
		expect(draft()).toBe(OLD);
	});

	it('Enter: an empty draft is "nothing pending"; a typed one only closes', async () => {
		const onkeydown = vi.fn();
		render(HostHarness, { onkeydown });
		const pw = await openOn('pw');
		expect(await fireEvent.keyDown(pw, { key: 'Enter' })).toBe(true);
		expect(pad()).toBeNull();
		expect(onkeydown).toHaveBeenCalledOnce();
		await fireEvent.keyUp(pw, { key: 'Enter' });

		await openOn('pw');
		const seen = watch(pw);
		await type(['a']);
		expect(await fireEvent.keyDown(pw, { key: 'Enter' })).toBe(false);
		expect(pad()).toBeNull();
		expect(onkeydown).toHaveBeenCalledOnce();
		expect(pw.value).toBe(OLD);
		expect(seen).toEqual({ input: 0, change: 0 });
	});

	it('the value was rewritten while open: nothing is written, target-changed without a draft', async () => {
		const oncancel = vi.fn();
		render(HostHarness, { oncancel });
		const pw = await openOn('pw');
		const seen = watch(pw);
		await type(['a', 'b', 'c']);
		pw.value = 'from-elsewhere';
		await type(['確定']);
		expect(pw.value).toBe('from-elsewhere');
		expect(seen).toEqual({ input: 0, change: 0 });
		expect(oncancel.mock.calls).toEqual([[{ input: pw, reason: 'target-changed' }]]);
	});

	it('a password field is masked whatever kind its options name; maxlength still applies', async () => {
		const onconfirm = vi.fn();
		render(HostHarness, { onconfirm });
		const pin = await openOn('pin');
		expect(screen.getByRole('group', { name: '文字キーボード 暗証番号' })).toBeTruthy();
		await type(['1', '2', '3', '4', '5']);
		expect(draft()).toBe('●●●●');
		expect(screen.getByTestId('count').textContent).toBe('4 / 4');
		await type(['確定']);
		expect(pin.value).toBe('1234');
		expect(onconfirm).toHaveBeenCalledWith({ input: pin, value: null, previous: null });
	});

	it('touchKeys(false) / resolve false / data-touch-keys="off" keep the keys off a password field', async () => {
		render(HostHarness, {
			resolve: (input: HTMLInputElement) => (input.id === 'pw' ? false : undefined)
		});
		const pw = field('pw');
		await fireEvent.pointerDown(pw);
		await fireEvent.click(pw);
		expect(pad()).toBeNull();
		expect(pw.getAttribute('inputmode')).toBeNull();
	});
});
