// @vitest-environment jsdom
/**
 * BantoForm layout (Issue #714): sections, columns, help text, `visibleWhen`
 * and focus. The decisions themselves are in layout.test.ts; this proves the
 * component renders and wires them.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import BantoForm from '../src/BantoForm.svelte';
import { createFormStore } from '../src/store.svelte';
import type { FormSchema } from '../src/types';

afterEach(cleanup);

const layoutSchema: FormSchema = {
	sections: [
		{ id: 'basic', title: '基本情報', description: '必ず入れる項目', columns: 2 },
		{ id: 'ship', title: '配送' }
	],
	fields: [
		{ name: 'name', label: '名称', type: 'text', section: 'basic', help: '40文字まで' },
		{ name: 'memo', label: 'メモ', type: 'textarea', section: 'basic', fullWidth: true },
		{ name: 'gift', label: '贈答', type: 'checkbox', section: 'ship' },
		{
			name: 'wrap',
			label: '包装',
			type: 'text',
			required: true,
			section: 'ship',
			visibleWhen: (v) => v.gift === true
		}
	]
};

describe('BantoForm layout (#714)', () => {
	it('renders sections as named groups, columns on the grid, full width on the field', () => {
		const { container } = render(BantoForm, {
			schema: layoutSchema,
			store: createFormStore(layoutSchema),
			onSubmit: vi.fn()
		});
		const group = screen.getByRole('group', { name: '基本情報' });
		expect(group.getAttribute('aria-describedby')).toBeTruthy();
		expect(group.querySelector('.grid')?.getAttribute('data-columns')).toBe('2');
		expect(container.querySelector('[data-field="memo"]')?.classList.contains('field--full')).toBe(
			true
		);
		const names = [...container.querySelectorAll('[data-field]')].map((e) =>
			e.getAttribute('data-field')
		);
		expect(names).toEqual(['name', 'memo', 'gift']);
	});

	it('points the control at its help text, then its error', async () => {
		const schema: FormSchema = {
			fields: [{ name: 'name', label: '名称', type: 'text', required: true, help: '40文字まで' }]
		};
		render(BantoForm, { schema, store: createFormStore(schema), onSubmit: vi.fn() });
		const input = screen.getByLabelText(/名称/);
		const help = screen.getByText('40文字まで');
		expect(input.getAttribute('aria-describedby')).toBe(help.id);
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		const error = screen.getByText('必須項目です');
		expect(input.getAttribute('aria-describedby')).toBe(`${help.id} ${error.id}`);
	});

	it('shows a field when its condition holds, submits without it otherwise, keeps the input', async () => {
		const onSubmit = vi.fn();
		render(BantoForm, { schema: layoutSchema, store: createFormStore(layoutSchema), onSubmit });
		expect(screen.queryByLabelText(/包装/)).toBeNull();
		await fireEvent.click(screen.getByLabelText('贈答'));
		flushSync();
		await fireEvent.input(screen.getByLabelText(/包装/), { target: { value: 'ribbon' } });
		await fireEvent.click(screen.getByLabelText('贈答'));
		flushSync();
		expect(screen.queryByLabelText(/包装/)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('wrap');
		await fireEvent.click(screen.getByLabelText('贈答'));
		flushSync();
		expect((screen.getByLabelText(/包装/) as HTMLInputElement).value).toBe('ribbon');
	});

	it('moves focus to a neighbour when the focused field gets hidden', async () => {
		const schema: FormSchema = {
			fields: [
				{ name: 'a', label: 'A', type: 'text' },
				{ name: 'b', label: 'B', type: 'text', visibleWhen: (v) => v.b !== 'x' }
			]
		};
		render(BantoForm, { schema, store: createFormStore(schema), onSubmit: vi.fn() });
		const b = screen.getByLabelText('B') as HTMLInputElement;
		b.focus();
		await fireEvent.input(b, { target: { value: 'x' } });
		flushSync();
		await new Promise((r) => setTimeout(r, 10));
		expect(document.activeElement).toBe(screen.getByLabelText('A'));
	});

	it('keeps the focus record of B when the focusout microtask of A runs after the focusin of B', async () => {
		const schema: FormSchema = {
			fields: [
				{ name: 'a', label: 'A', type: 'text' },
				{ name: 'b', label: 'B', type: 'text', visibleWhen: (v) => v.b !== 'x' },
				{ name: 'c', label: 'C', type: 'text' }
			]
		};
		render(BantoForm, { schema, store: createFormStore(schema), onSubmit: vi.fn() });
		const a = screen.getByLabelText('A') as HTMLInputElement;
		const b = screen.getByLabelText('B') as HTMLInputElement;
		a.focus();
		b.focus();
		await Promise.resolve();
		await fireEvent.input(b, { target: { value: 'x' } });
		flushSync();
		await new Promise((r) => setTimeout(r, 10));
		expect(document.activeElement).not.toBe(document.body);
		expect(document.activeElement).toBe(screen.getByLabelText('A'));
	});
});
