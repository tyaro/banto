import { describe, expect, it } from 'vitest';
import {
	focusFallbackName,
	hiddenFieldNames,
	isFieldVisible,
	layoutOf,
	resolveColumns,
	submitValuesOf
} from '../src/layout';
import { validateAll } from '../src/validate';
import { createFormStore } from '../src/store.svelte';
import type { FormSchema } from '../src/types';

const schema: FormSchema = {
	columns: 2,
	sections: [
		{ id: 'basic', title: '基本', columns: 3 },
		{ id: 'ship', title: '配送' }
	],
	fields: [
		{ name: 'name', label: '名称', type: 'text', required: true },
		{ name: 'kind', label: '種別', type: 'text', section: 'basic' },
		{ name: 'gift', label: '贈答', type: 'checkbox', section: 'ship' },
		{
			name: 'wrap',
			label: '包装',
			type: 'text',
			required: true,
			section: 'ship',
			visibleWhen: (v) => v.gift === true
		},
		{ name: 'stray', label: '迷子', type: 'text', section: 'nope' }
	]
};

describe('isFieldVisible / hiddenFieldNames', () => {
	it('is visible without visibleWhen and follows it otherwise', () => {
		expect(isFieldVisible(schema.fields[0], {})).toBe(true);
		expect(isFieldVisible(schema.fields[3], { gift: false })).toBe(false);
		expect(isFieldVisible(schema.fields[3], { gift: true })).toBe(true);
		expect([...hiddenFieldNames(schema, { gift: false })]).toEqual(['wrap']);
	});
});

describe('submitValuesOf', () => {
	it('drops hidden fields only, keeps unknown keys, and does not mutate', () => {
		const values = { name: 'a', gift: false, wrap: 'x', version: 3 };
		expect(submitValuesOf(schema, values)).toEqual({ name: 'a', gift: false, version: 3 });
		expect(values).toHaveProperty('wrap');
		expect(submitValuesOf(schema, { ...values, gift: true })).toEqual({ ...values, gift: true });
	});
});

describe('resolveColumns', () => {
	it('prefers own, then fallback, then 1; ignores out-of-range values', () => {
		expect(resolveColumns(3, 2)).toBe(3);
		expect(resolveColumns(undefined, 2)).toBe(2);
		expect(resolveColumns(undefined, undefined)).toBe(1);
		expect(resolveColumns(4, 2)).toBe(2);
		expect(resolveColumns(0)).toBe(1);
	});
});

describe('layoutOf', () => {
	it('puts fields without a (known) section first, then sections in order', () => {
		const groups = layoutOf(schema, { gift: true });
		expect(groups.map((g) => g.section?.id ?? null)).toEqual([null, 'basic', 'ship']);
		expect(groups[0].fields.map((f) => f.def.name)).toEqual(['name', 'stray']);
		expect(groups.map((g) => g.columns)).toEqual([2, 3, 2]);
		expect(groups[2].fields.map((f) => f.index)).toEqual([2, 3]);
	});

	it('drops hidden fields and a section left empty', () => {
		const two: FormSchema = {
			sections: [{ id: 's', title: 'S' }],
			fields: [{ name: 'a', label: 'A', type: 'text', section: 's', visibleWhen: () => false }]
		};
		expect(layoutOf(two, {})).toEqual([]);
		expect(layoutOf(schema, { gift: false })[2].fields.map((f) => f.def.name)).toEqual(['gift']);
	});

	it('keeps a schema without sections or columns as one single-column group', () => {
		const plain: FormSchema = { fields: [{ name: 'a', label: 'A', type: 'text' }] };
		const groups = layoutOf(plain, {});
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ section: null, columns: 1 });
	});
});

describe('focusFallbackName', () => {
	it('picks the nearest earlier visible field, else the first visible, else null', () => {
		expect(focusFallbackName(schema, { gift: false }, 'wrap')).toBe('gift');
		const s: FormSchema = {
			fields: [
				{ name: 'a', label: 'A', type: 'text', visibleWhen: () => false },
				{ name: 'b', label: 'B', type: 'text' }
			]
		};
		expect(focusFallbackName(s, {}, 'a')).toBe('b');
		expect(focusFallbackName({ fields: [s.fields[0]] }, {}, 'a')).toBeNull();
	});
});

describe('hidden fields and validation / store', () => {
	it('validateAll skips a hidden required field', () => {
		const values = { name: 'a', gift: false, wrap: '' };
		expect(validateAll(schema, values).map((e) => e.field)).toEqual([]);
		expect(validateAll(schema, { ...values, gift: true }).map((e) => e.field)).toEqual(['wrap']);
	});

	it('store: submitValues omits hidden, input is kept, errors of a hidden field go away', () => {
		const store = createFormStore(schema, { name: 'a' });
		store.setValue('gift', true);
		store.setValue('wrap', '');
		expect(store.validateAll()).toBe(false);
		expect(store.errors.wrap).toBeTruthy();
		store.setValue('wrap', 'ribbon');
		store.setValue('gift', false);
		expect(store.values.wrap).toBe('ribbon');
		expect(store.submitValues).not.toHaveProperty('wrap');
		expect(store.isDirty).toBe(true);
		store.setValue('gift', true);
		store.setValue('wrap', '');
		store.validateAll();
		store.setValue('gift', false);
		expect(store.errors.wrap).toBeUndefined();
		expect(store.validateAll()).toBe(true);
	});

	it('store: touch on a hidden field adds no error', () => {
		const store = createFormStore(schema, { name: 'a' });
		store.touch('wrap');
		expect(store.errors.wrap).toBeUndefined();
	});
});
