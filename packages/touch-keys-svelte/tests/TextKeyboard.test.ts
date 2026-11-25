// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import TextKeyboard from '../src/TextKeyboard.svelte';

const key = (name: string) => screen.getByRole('button', { name });
const draft = () => screen.getByTestId('draft').textContent;
const board = () => screen.getByRole('group');

async function type(keys: string[]) {
	for (const k of keys) await fireEvent.click(key(k));
}

describe('TextKeyboard', () => {
	it('appends to the opening value; case is a toggle that stays', async () => {
		render(TextKeyboard, { draft: 'ab', label: '品名' });
		expect(screen.getByRole('group', { name: '文字キーボード 品名' })).toBeTruthy();
		await type(['c', '大文字', 'D', 'E', '小文字', 'f', '空白', '1']);
		expect(draft()).toBe('abcDEf 1');
	});

	it('switches layouts with the layout keys and marks the current one', async () => {
		render(TextKeyboard, { draft: '' });
		expect(key('英数').getAttribute('aria-pressed')).toBe('true');
		await type(['a', '記号', '@', '-']);
		expect(key('記号').getAttribute('aria-pressed')).toBe('true');
		expect(screen.queryByRole('button', { name: 'a' })).toBeNull();
		// no case toggle on the symbol layout
		expect(screen.queryByRole('button', { name: '大文字' })).toBeNull();
		await type(['英数', 'b']);
		expect(draft()).toBe('a@-b');
	});

	it('one layout: no layout keys; initialLayout picks the first one shown', async () => {
		const { unmount } = render(TextKeyboard, { layouts: ['alnum'] });
		expect(screen.queryByRole('button', { name: '記号' })).toBeNull();
		expect(screen.queryByRole('button', { name: '英数' })).toBeNull();
		unmount();
		render(TextKeyboard, { initialLayout: 'symbol' });
		expect(key('@')).toBeTruthy();
	});

	it('deletes from the end, clears, confirms the text as it is (spaces kept), cancels', async () => {
		const onconfirm = vi.fn();
		const oncancel = vi.fn();
		render(TextKeyboard, { draft: ' ab', onconfirm, oncancel });
		await type(['c', '1文字消す', '空白', '確定']);
		expect(onconfirm).toHaveBeenCalledWith(' ab ');
		await type(['全部消す']);
		expect(draft()).toBe(' ');
		await type(['取り消し']);
		expect(oncancel).toHaveBeenCalledOnce();
	});

	it('maxLength: keys stop entering, the count and a status notice say so', async () => {
		const onedit = vi.fn();
		render(TextKeyboard, { draft: 'ab', maxLength: 3, onedit });
		expect(screen.getByTestId('count').textContent).toBe('2 / 3');
		expect(screen.getByRole('status').textContent).toBe('');
		await type(['c', 'd']);
		expect(draft()).toBe('abc');
		expect(screen.getByTestId('count').textContent).toBe('3 / 3');
		expect(screen.getByRole('status').textContent).toBe('3 文字までです');
		expect(onedit).toHaveBeenLastCalledWith({ length: 3, cleared: false });
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false);
	});

	it('a value already over maxLength cannot be confirmed until it fits', async () => {
		render(TextKeyboard, { draft: 'abcd', maxLength: 3 });
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
		await type(['1文字消す']);
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false);
	});

	it('required: an empty draft cannot be confirmed and says why', async () => {
		const onconfirm = vi.fn();
		render(TextKeyboard, { draft: '', required: true, onconfirm });
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('status').textContent).toBe('入力が必要です');
		await fireEvent.click(key('確定'));
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('minLength: a non-empty draft that is too short cannot be confirmed and says why', async () => {
		render(TextKeyboard, { draft: '', minLength: 3 });
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false); // empty is not "too short"
		await type(['a', 'b']);
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('status').textContent).toBe('3 文字以上にしてください');
		await type(['c']);
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByRole('status').textContent).toBe('');
	});

	it('rejected: the owner refused the text, said in the status line', async () => {
		const { rerender } = render(TextKeyboard, { draft: 'ab', rejected: true });
		expect(screen.getByRole('status').textContent).toBe('入力の形式が合いません');
		await rerender({ rejected: false });
		expect(screen.getByRole('status').textContent).toBe('');
	});

	it('keys are buttons outside the tab order that do not take focus; messages can be replaced', async () => {
		render(TextKeyboard, { messages: { confirm: () => 'OK', space: () => 'Space' } });
		for (const button of screen.getAllByRole('button')) {
			expect(button.getAttribute('tabindex')).toBe('-1');
			expect(button.getAttribute('type')).toBe('button');
		}
		expect(await fireEvent.mouseDown(key('a'))).toBe(false);
		expect(await fireEvent.mouseDown(key('Space'))).toBe(false);
		expect(key('OK')).toBeTruthy();
	});
});

describe('TextKeyboard masked (§5.5)', () => {
	const SECRET = 'pA5$ w';
	const SECRET_KEYS = ['p', '大文字', 'A', '5', '記号', '$', '空白', '英数', '小文字', 'w'];

	it('shows dots and the count only: the typed text is nowhere in the keyboard DOM', async () => {
		render(TextKeyboard, { masked: true, label: 'パスワード' });
		await type(SECRET_KEYS);
		expect(draft()).toBe('●'.repeat(SECRET.length));
		expect(screen.getByTestId('count').textContent).toBe('6 文字');
		expect(screen.getByRole('status').textContent).toBe('');
		expect(board().textContent).not.toContain(SECRET);
		expect(board().outerHTML).not.toContain(SECRET);
		// not even the last character: everything outside the keys is free of typed characters
		const display = board().querySelector('.display')!;
		expect(display.textContent!.replace(/\s/g, '')).toBe(`パスワード${'●'.repeat(6)}6文字`);
	});

	it('starts empty whatever `draft` says, and never writes `draft`', async () => {
		const props = { draft: 'old-secret' };
		render(TextKeyboard, {
			get draft() {
				return props.draft;
			},
			set draft(next: string) {
				props.draft = next;
			},
			masked: true
		});
		expect(draft()).toBe(' ');
		expect(board().outerHTML).not.toContain('old-secret');
		await type(['a', 'b']);
		expect(props.draft).toBe('old-secret');
	});

	it('hands the text out exactly once, to onconfirm; onedit gets the length, note gets null', async () => {
		const onconfirm = vi.fn();
		const onedit = vi.fn();
		const seen: (string | null)[] = [];
		const note = createRawSnippet<[string | null]>((text) => ({
			render: () => {
				seen.push(text());
				return '<span data-testid="note">note</span>';
			}
		}));
		render(TextKeyboard, { masked: true, onconfirm, onedit, note });
		await type(SECRET_KEYS);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((text) => text === null)).toBe(true);
		expect(onedit.mock.calls.map(([edit]) => edit)).toEqual(
			[1, 2, 3, 4, 5, 6].map((length) => ({ length, cleared: false }))
		);
		expect(onconfirm).not.toHaveBeenCalled();
		await type(['確定']);
		expect(onconfirm.mock.calls).toEqual([[SECRET]]);
	});

	it('an empty draft is confirmable only after the clear-all key (never wipes a password by accident)', async () => {
		const onconfirm = vi.fn();
		const onedit = vi.fn();
		render(TextKeyboard, { masked: true, onconfirm, onedit });
		const confirm = () => key('確定') as HTMLButtonElement;
		expect(confirm().disabled).toBe(true);
		// typed and deleted back to empty is still not an explicit clear
		await type(['a', '1文字消す']);
		expect(confirm().disabled).toBe(true);
		expect(onedit).toHaveBeenLastCalledWith({ length: 0, cleared: false });
		await type(['全部消す']);
		expect(onedit).toHaveBeenLastCalledWith({ length: 0, cleared: true });
		expect(confirm().disabled).toBe(false);
		await type(['確定']);
		expect(onconfirm.mock.calls).toEqual([['']]);
		// typing again takes the "cleared" mark away
		await type(['a', '1文字消す']);
		expect(confirm().disabled).toBe(true);
	});

	it('required wins over the clear-all key', async () => {
		render(TextKeyboard, { masked: true, required: true });
		await type(['全部消す']);
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
	});

	it('offers every layout and the full symbol set, whatever `layouts` says', async () => {
		render(TextKeyboard, { masked: true, layouts: ['alnum'] });
		await type(['記号']);
		for (const symbol of ['"', '\\', '`', '~', '|', '{', '}', '<', '>', "'", ';', '^', '[', ']']) {
			expect(key(symbol), symbol).toBeTruthy();
		}
	});

	it('`masked` is fixed at creation: turning it off later reveals nothing', async () => {
		const { rerender } = render(TextKeyboard, { masked: true });
		await type(['a', 'b', 'c']);
		await rerender({ masked: false });
		expect(draft()).toBe('●●●');
		expect(board().outerHTML).not.toContain('abc');
	});
});
