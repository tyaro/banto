// @vitest-environment jsdom
/**
 * radio / multiselect / number prefix-suffix (Issue #714): defaults,
 * validation, draft, and how BantoForm renders and wires them.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import BantoForm from '../src/BantoForm.svelte';
import { createFormStore } from '../src/store.svelte';
import { createFormDraft } from '../src/draft.svelte';
import NumberField from '../src/fields/NumberField.svelte';
import DraftNumberField from '../src/fields/DraftNumberField.svelte';
import { validateField } from '../src/validate';
import type { FieldDef, FormSchema } from '../src/types';

afterEach(cleanup);

const options = [
	{ value: 'a', label: '赤' },
	{ value: 2, label: '青' },
	{ value: 'c', label: '緑' }
];

describe('defaults and validation', () => {
	const radio: FieldDef = { name: 'r', label: 'R', type: 'radio', options, required: true };
	const multi: FieldDef = { name: 'm', label: 'M', type: 'multiselect', options, required: true };

	it('starts a radio at an empty string and a multiselect at an empty array', () => {
		const store = createFormStore({ fields: [radio, multi] });
		expect(store.values).toEqual({ r: '', m: [] });
		const draft = createFormDraft({ key: 'k', schema: { fields: [radio, multi] } });
		expect(draft.values).toEqual({ r: '', m: [] });
	});

	it('requires a radio choice and at least one multiselect item', () => {
		expect(validateField(radio, '', {})).toBe('必須項目です');
		expect(validateField(radio, 'a', {})).toBeNull();
		expect(validateField(multi, [], {})).toBe('必須項目です');
		expect(validateField(multi, ['a'], {})).toBeNull();
		expect(validateField({ ...multi, required: false }, [], {})).toBeNull();
	});

	it('draft: a radio value is set through the options, a multiselect array stays an array', () => {
		const draft = createFormDraft({ key: 'k', schema: { fields: [radio, multi] } });
		draft.setRaw('r', '2');
		expect(draft.commit('r')).toBe(true);
		expect(draft.values.r).toBe(2);
		draft.setValue('m', ['a', 2]);
		expect(draft.values.m).toEqual(['a', 2]);
		expect(draft.dirty).toBe(true);
		expect(draft.commitAll()).toBe(true);
	});
});

describe('BantoForm: radio', () => {
	const schema: FormSchema = {
		fields: [
			{
				name: 'color',
				label: '色',
				type: 'radio',
				options,
				required: true,
				help: '一つ選ぶ'
			}
		]
	};

	it('is a named radiogroup with the help text as its description, the id on the first radio', async () => {
		const store = createFormStore(schema);
		const { container } = render(BantoForm, { schema, store, onSubmit: vi.fn() });
		const group = screen.getByRole('radiogroup', { name: /色/ });
		expect(group.getAttribute('aria-describedby')).toMatch(/help-0$/);
		const radios = screen.getAllByRole('radio');
		expect(radios).toHaveLength(3);
		expect(container.querySelector('[id$="-field-0"]')).toBe(radios[0]);
		await fireEvent.click(radios[1]);
		expect(store.values.color).toBe(2);
	});

	it('shows the required error and clears it once a choice is made', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		render(BantoForm, { schema, store, onSubmit });
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(store.errors.color).toBe('必須項目です');
		const group = screen.getByRole('radiogroup');
		expect(group.getAttribute('aria-describedby')).toMatch(/error-0$/);
		await fireEvent.click(screen.getAllByRole('radio')[0]);
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(onSubmit).toHaveBeenCalledWith({ color: 'a' });
	});

	it('segmented: the same radios, in the segmented strip', () => {
		const seg: FormSchema = {
			fields: [{ name: 'color', label: '色', type: 'radio', variant: 'segmented', options }]
		};
		const { container } = render(BantoForm, {
			schema: seg,
			store: createFormStore(seg, { color: 'c' }),
			onSubmit: vi.fn()
		});
		expect(container.querySelector('.options.segmented')).not.toBeNull();
		const radios = screen.getAllByRole('radio') as HTMLInputElement[];
		expect(radios.map((r) => r.checked)).toEqual([false, false, true]);
		expect(screen.getByRole('radio', { name: '緑' })).toBeTruthy();
	});
});

describe('BantoForm: multiselect', () => {
	const schema: FormSchema = {
		fields: [{ name: 'tags', label: 'タグ', type: 'multiselect', options, required: true }]
	};

	it('submits an array in options order and needs at least one', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		render(BantoForm, { schema, store, onSubmit });
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(store.errors.tags).toBe('必須項目です');
		await fireEvent.click(screen.getByRole('checkbox', { name: '緑' }));
		await fireEvent.click(screen.getByRole('checkbox', { name: '赤' }));
		expect(store.values.tags).toEqual(['a', 'c']);
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(onSubmit).toHaveBeenCalledWith({ tags: ['a', 'c'] });
		await fireEvent.click(screen.getByRole('checkbox', { name: '緑' }));
		expect(store.values.tags).toEqual(['a']);
	});

	it('names the group by its legend', () => {
		render(BantoForm, { schema, store: createFormStore(schema), onSubmit: vi.fn() });
		expect(screen.getByRole('group', { name: /タグ/ })).toBeTruthy();
	});
});

describe('options whose values differ only by type (1 and "1")', () => {
	const mixed = [
		{ value: 1, label: '数値の1' },
		{ value: '1', label: '文字の1' }
	];

	it('multiselect: picks, outputs and clears each one on its own', async () => {
		const schema: FormSchema = {
			fields: [{ name: 'm', label: 'M', type: 'multiselect', options: mixed }]
		};
		const store = createFormStore(schema);
		render(BantoForm, { schema, store, onSubmit: vi.fn() });
		const num = screen.getByRole('checkbox', { name: '数値の1' }) as HTMLInputElement;
		const str = screen.getByRole('checkbox', { name: '文字の1' }) as HTMLInputElement;
		await fireEvent.click(str);
		expect(store.values.m).toEqual(['1']);
		expect([num.checked, str.checked]).toEqual([false, true]);
		await fireEvent.click(num);
		expect(store.values.m).toEqual([1, '1']);
		await fireEvent.click(str);
		expect(store.values.m).toEqual([1]);
		expect([num.checked, str.checked]).toEqual([true, false]);
	});

	it('radio: only the option of the same type is checked', () => {
		const schema: FormSchema = {
			fields: [{ name: 'r', label: 'R', type: 'radio', options: mixed }]
		};
		const store = createFormStore(schema);
		store.setValue('r', 1);
		render(BantoForm, { schema, store, onSubmit: vi.fn() });
		const radios = screen.getAllByRole('radio') as HTMLInputElement[];
		expect(radios.map((r) => r.checked)).toEqual([true, false]);
	});
});

describe('BantoForm: visibleWhen focus with a group', () => {
	it('moves focus to the first radio of a neighbouring group when the focused field hides', async () => {
		const schema: FormSchema = {
			fields: [
				{ name: 'color', label: '色', type: 'radio', options },
				{ name: 'gift', label: '贈答', type: 'checkbox' },
				{ name: 'wrap', label: '包装', type: 'text', visibleWhen: (v) => v.gift === true }
			]
		};
		const store = createFormStore(schema, { gift: true });
		render(BantoForm, { schema, store, onSubmit: vi.fn() });
		const wrap = screen.getByLabelText('包装');
		wrap.focus();
		store.setValue('gift', false);
		flushSync();
		await Promise.resolve();
		await Promise.resolve();
		expect(document.activeElement?.tagName).not.toBe('BODY');
	});
});

describe('number prefix / suffix', () => {
	const schema: FormSchema = {
		fields: [
			{ name: 'weight', label: '重量', type: 'number', suffix: 'kg', help: '梱包を含む' },
			{ name: 'price', label: '価格', type: 'number', prefix: '¥' }
		]
	};

	it('keeps the value a number, hides the unit from the name and reads it as a description', async () => {
		const store = createFormStore(schema);
		render(BantoForm, { schema, store, onSubmit: vi.fn() });
		const input = screen.getByLabelText('重量') as HTMLInputElement;
		const described = input.getAttribute('aria-describedby')!.split(' ');
		expect(document.getElementById(described[0])?.textContent).toBe('kg');
		expect(document.getElementById(described[1])?.textContent).toBe('梱包を含む');
		await fireEvent.input(input, { target: { value: '12.5' } });
		expect(store.values.weight).toBe(12.5);
		const price = screen.getByLabelText('価格');
		expect(document.getElementById(price.getAttribute('aria-describedby')!)?.textContent).toBe('¥');
	});

	it('draws nothing extra for a number without affixes', () => {
		const plain: FormSchema = { fields: [{ name: 'n', label: 'N', type: 'number' }] };
		const { container } = render(BantoForm, {
			schema: plain,
			store: createFormStore(plain),
			onSubmit: vi.fn()
		});
		expect(container.querySelector('.affix')).toBeNull();
		expect(screen.getByLabelText('N').getAttribute('aria-describedby')).toBeNull();
	});
});

describe('number prefix / suffix with appearance="underline"', () => {
	it('keeps the input where the theme underline rules reach it', () => {
		const schema: FormSchema = {
			fields: [{ name: 'weight', label: '重量', type: 'number', suffix: 'kg' }]
		};
		render(BantoForm, {
			schema,
			store: createFormStore(schema),
			onSubmit: vi.fn(),
			appearance: 'underline'
		});
		const input = screen.getByLabelText(/重量/);
		expect(input.classList.contains('banto-field-control')).toBe(true);
		// The wrapper is a `.banto-affix` directly under `.banto-field`, which the
		// theme's `.banto-field > .banto-affix > .banto-field-control` rules target.
		expect(input.matches('.banto-field--stacked > .banto-affix > .banto-field-control')).toBe(true);
	});

	it.each(['NumberField', 'DraftNumberField'])(
		'%s keeps the underline selector match inside .banto-field',
		(kind) => {
			const def: FieldDef = { name: 'w', label: '重量', type: 'number', suffix: 'kg' };
			const target = document.body.appendChild(document.createElement('div'));
			target.className = 'banto-field banto-field--stacked';
			if (kind === 'NumberField') {
				render(NumberField, {
					target,
					props: { def, class: 'banto-field-control', value: 1, onInput: vi.fn() }
				});
			} else {
				const draft = createFormDraft({ key: 'k', schema: { fields: [def] } });
				render(DraftNumberField, { target, props: { def, class: 'banto-field-control', draft } });
			}
			const input = target.querySelector('input')!;
			expect(input.matches('.banto-field > .banto-affix > .banto-field-control')).toBe(true);
			expect(input.matches('.banto-field--stacked > .banto-affix > .banto-field-control')).toBe(
				true
			);
		}
	);
});

describe('raw text of options that differ only by type', () => {
	it('draft reads the first option whose text matches', () => {
		const mixed = [
			{ value: 2, label: 'n' },
			{ value: '2', label: 's' }
		];
		const schema: FormSchema = {
			fields: [
				{ name: 'r', label: 'R', type: 'radio', options: mixed },
				{ name: 'm', label: 'M', type: 'multiselect', options: mixed }
			]
		};
		const draft = createFormDraft({ key: 'k', schema });
		draft.setRaw('r', '2');
		draft.commit('r');
		expect(draft.values.r).toBe(2);
	});
});
