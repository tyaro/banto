import { describe, expect, it } from 'vitest';
import {
	composeEditableValues,
	editableFieldNames,
	exportListParams,
	initialLoadMode,
	listLoadModes
} from './listState';

describe('listLoadModes', () => {
	it('defaults to server only (ADR-0030 decision 3)', () => {
		expect(listLoadModes({})).toEqual(['server']);
		expect(listLoadModes({ list: {} })).toEqual(['server']);
		expect(listLoadModes({ list: { loadModes: [] } })).toEqual(['server']);
	});

	it('keeps the definition order and drops duplicates', () => {
		expect(listLoadModes({ list: { loadModes: ['client', 'server', 'client'] } })).toEqual([
			'client',
			'server'
		]);
	});
});

describe('initialLoadMode', () => {
	it('restores the saved mode when the resource offers it', () => {
		expect(initialLoadMode('client', ['client', 'server'])).toBe('client');
		expect(initialLoadMode('server', ['client', 'server'])).toBe('server');
	});

	it('prefers server on a first visit', () => {
		expect(initialLoadMode(null, ['client', 'server'])).toBe('server');
	});

	it('never selects a mode the resource does not offer', () => {
		expect(initialLoadMode('client', ['server'])).toBe('server');
		expect(initialLoadMode('bogus', ['client'])).toBe('client');
	});
});

describe('editableFieldNames / composeEditableValues', () => {
	const schema = {
		fields: [{ name: 'name' }, { name: 'price' }, { name: 'updatedAt', readonly: true }]
	};

	it('skips readonly fields', () => {
		expect(editableFieldNames(schema)).toEqual(['name', 'price']);
		expect(editableFieldNames(undefined)).toEqual([]);
	});

	it('sends the base row values plus the changed columns, nothing else', () => {
		const fields = editableFieldNames(schema);
		const row = { id: 3, name: 'a', price: 10, updatedAt: '2026-01-01', category: 'x' };
		expect(composeEditableValues(fields, row, { price: 20 })).toEqual({ name: 'a', price: 20 });
		// A change on a column outside the schema (id, a derived field) is not sent.
		expect(composeEditableValues(fields, row, { category: 'y', id: 9 })).toEqual({
			name: 'a',
			price: 10
		});
	});
});

describe('exportListParams', () => {
	it('drops sort and filters on columns that are not real resource columns', () => {
		const result = exportListParams(
			{
				sort: [
					{ field: 'category', direction: 'asc' },
					{ field: 'price', direction: 'desc' }
				],
				filters: [
					{ field: 'category', op: 'contains', value: 'x' },
					{ field: 'name', op: 'contains', value: 'y' }
				]
			},
			new Set(['id', 'name', 'price'])
		);
		expect(result.sort).toEqual([{ field: 'price', direction: 'desc' }]);
		expect(result.filters).toEqual([{ field: 'name', op: 'contains', value: 'y' }]);
	});
});
