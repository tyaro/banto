// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PasswordInput from '../src/fields/PasswordInput.svelte';
import PasswordField from '../src/fields/PasswordField.svelte';
import type { FieldDef } from '../src/types';

afterEach(cleanup);

const input = (c: HTMLElement) => c.querySelector('input') as HTMLInputElement;

describe('PasswordInput (#944)', () => {
	it('starts hidden with an unpressed button named for showing', () => {
		const { container } = render(PasswordInput, { value: 'secret' });
		expect(input(container).type).toBe('password');
		const button = screen.getByRole('button', { name: 'パスワードを表示' });
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(button.getAttribute('type')).toBe('button');
	});

	it('toggles type, aria-pressed and the label on every press, keeping the value', async () => {
		const { container } = render(PasswordInput, { value: 'secret' });
		await fireEvent.click(screen.getByRole('button', { name: 'パスワードを表示' }));
		expect(input(container).type).toBe('text');
		expect(input(container).value).toBe('secret');
		const hide = screen.getByRole('button', { name: 'パスワードを隠す' });
		expect(hide.getAttribute('aria-pressed')).toBe('true');
		await fireEvent.click(hide);
		expect(input(container).type).toBe('password');
		expect(input(container).value).toBe('secret');
		expect(screen.getByRole('button', { name: 'パスワードを表示' })).toBeTruthy();
	});

	it('keeps the caret / selection across a toggle', async () => {
		const { container } = render(PasswordInput, { value: 'abcdef' });
		const el = input(container);
		el.setSelectionRange(2, 4);
		await fireEvent.click(screen.getByRole('button'));
		await Promise.resolve();
		expect(el.selectionStart).toBe(2);
		expect(el.selectionEnd).toBe(4);
	});

	it('uses the given messages', () => {
		render(PasswordInput, { messages: { show: () => 'Show password' } });
		expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();
	});

	it('does not submit the owning form, and goes back to hidden when it is submitted', async () => {
		const onSubmit = vi.fn((e: Event) => e.preventDefault());
		const form = document.createElement('form');
		form.addEventListener('submit', onSubmit);
		document.body.appendChild(form);
		const { container } = render(PasswordInput, { target: form, props: { value: 'x' } });
		await fireEvent.click(screen.getByRole('button'));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(input(container).type).toBe('text');
		await fireEvent.submit(form);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(input(container).type).toBe('password');
		form.remove();
	});

	it('disables the button with a disabled or readonly input', () => {
		const a = render(PasswordInput, { disabled: true });
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
		a.unmount();
		render(PasswordInput, { readonly: true });
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});

	it('PasswordField reports typed values and shares the button', async () => {
		const onInput = vi.fn();
		const def: FieldDef = { name: 'pw', label: 'PW', type: 'password' };
		const { container } = render(PasswordField, { def, value: '', onInput });
		await fireEvent.input(input(container), { target: { value: 'abc' } });
		expect(onInput).toHaveBeenCalledWith('abc');
		await fireEvent.click(screen.getByRole('button', { name: 'パスワードを表示' }));
		expect(input(container).type).toBe('text');
	});
});
