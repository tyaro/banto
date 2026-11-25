// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NumberKeypad from '../src/NumberKeypad.svelte';

const key = (name: string | RegExp) => screen.getByRole('button', { name });

describe('NumberKeypad', () => {
	it('enters digits, replacing the opening value on the first digit', async () => {
		render(NumberKeypad, { draft: '42', label: '数量' });
		await fireEvent.click(key('7'));
		await fireEvent.click(key('5'));
		expect(screen.getByTestId('draft').textContent).toBe('75');
	});

	it('confirms the canonical value and cancels', async () => {
		const onconfirm = vi.fn();
		const oncancel = vi.fn();
		render(NumberKeypad, { draft: '', decimals: 2, onconfirm, oncancel });
		await fireEvent.click(key('1'));
		await fireEvent.click(key('.'));
		await fireEvent.click(key('確定'));
		expect(onconfirm).toHaveBeenCalledWith('1');
		await fireEvent.click(key('取り消し'));
		expect(oncancel).toHaveBeenCalledOnce();
	});

	it('disables confirm for partial and out-of-range drafts and says why', async () => {
		render(NumberKeypad, { draft: '' });
		const ok = key('確定') as HTMLButtonElement;
		expect(ok.disabled).toBe(false);
		await fireEvent.click(key('符号'));
		expect(ok.disabled).toBe(true); // "-" is partial
		expect(screen.getByRole('status').textContent).toBe('');
		await fireEvent.click(key('3'));
		expect(ok.disabled).toBe(false);
	});

	it('shows the range and the out-of-range notice', async () => {
		render(NumberKeypad, { draft: '', min: 10, max: 20, allowNegative: false });
		expect(screen.getByText('10 〜 20')).toBeTruthy();
		await fireEvent.click(key('1'));
		expect(screen.getByRole('status').textContent).toBe('10 〜 20');
		await fireEvent.click(key('5'));
		expect(screen.getByRole('status').textContent).toBe('');
		expect((key('確定') as HTMLButtonElement).disabled).toBe(false);
	});

	it('hides the dot when decimals is 0 and the sign when negatives are not allowed', () => {
		render(NumberKeypad, { draft: '', decimals: 0, allowNegative: false });
		expect(screen.queryByRole('button', { name: '.' })).toBeNull();
		expect(screen.queryByRole('button', { name: '符号' })).toBeNull();
	});

	it('required blocks confirming an empty draft', async () => {
		render(NumberKeypad, { draft: '', required: true });
		expect((key('確定') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('status').textContent).toBe('入力が必要です');
	});

	it('keys are out of the tab order and do not take focus on mousedown', async () => {
		render(NumberKeypad, { draft: '' });
		const b = key('1');
		expect(b.getAttribute('tabindex')).toBe('-1');
		const notPrevented = fireEvent.mouseDown(b);
		expect(await notPrevented).toBe(false);
	});

	it('uses supplied messages', () => {
		render(NumberKeypad, {
			draft: '',
			messages: { confirm: () => 'OK', numberKeypad: () => 'pad' }
		});
		expect(key('OK')).toBeTruthy();
		expect(screen.getByRole('group', { name: 'pad' })).toBeTruthy();
	});
});
