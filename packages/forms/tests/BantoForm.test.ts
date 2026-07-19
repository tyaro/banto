// @vitest-environment jsdom
/**
 * BantoForm component test (spec §7.3, improvement-plan P3-3): mount + basic
 * interaction only. The validation RULES themselves are covered by the
 * headless validate.ts tests; here we prove the component renders one field
 * per schema entry, wires input back to the store, blocks submit on invalid
 * input while surfacing the error, and submits the collected values when
 * valid.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoForm from '../src/BantoForm.svelte';
import { createFormStore } from '../src/store.svelte';
import type { FormSchema } from '../src/types';

afterEach(cleanup);

const schema: FormSchema = {
	fields: [
		{ name: 'name', label: '商品名', type: 'text', required: true, min: 1, max: 40 },
		{ name: 'note', label: '備考', type: 'text' }
	]
};

describe('BantoForm', () => {
	it('renders one labelled field per schema entry and a submit button', () => {
		render(BantoForm, { schema, store: createFormStore(schema), onSubmit: vi.fn() });

		expect(screen.getByText('商品名')).toBeTruthy();
		expect(screen.getByText('備考')).toBeTruthy();
		// label `for` matches the input `id` (= field name), so getByLabelText resolves the input.
		expect(screen.getByLabelText(/商品名/)).toBeTruthy();
		expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
	});

	it('writes input back into the store', async () => {
		const store = createFormStore(schema);
		render(BantoForm, { schema, store, onSubmit: vi.fn() });

		await fireEvent.input(screen.getByLabelText(/商品名/), { target: { value: 'ペン' } });

		expect(store.values.name).toBe('ペン');
	});

	it('submits collected values when valid', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		render(BantoForm, { schema, store, onSubmit });

		await fireEvent.input(screen.getByLabelText(/商品名/), { target: { value: 'ペン' } });
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'ペン' }));
	});

	it('blocks submit and surfaces the error when a required field is empty', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		render(BantoForm, { schema, store, onSubmit });

		await fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(await screen.findByText('必須項目です')).toBeTruthy();
		// aria-invalid is reflected onto the field for assistive tech.
		expect(screen.getByLabelText(/商品名/).getAttribute('aria-invalid')).toBe('true');
	});

	it('disables inputs and submit while submitting', () => {
		render(BantoForm, {
			schema,
			store: createFormStore(schema),
			onSubmit: vi.fn(),
			submitting: true
		});

		expect((screen.getByLabelText(/商品名/) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
	});
});
