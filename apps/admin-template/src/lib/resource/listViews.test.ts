import { GridState, type GridColumn } from '@banto/grid-svelte';
import { describe, expect, it } from 'vitest';
import {
	SAVED_VIEW_LIMIT,
	canSaveListViews,
	definitionPinned,
	newSavedViewId,
	parseSavedViews,
	presetViewContent,
	removeSavedView,
	sameViewContent,
	savedViewsKey,
	serializeSavedViews,
	upsertSavedView,
	viewForFields,
	type SavedListView
} from './listViews';

const lowStock = {
	sort: [{ field: 'stock', direction: 'asc' as const }],
	filters: [{ field: 'stock', op: 'lt' as const, value: 50 }],
	search: ''
};

function saved(id: string, label: string): SavedListView {
	return { id, label, ...lowStock };
}

describe('savedViewsKey', () => {
	it('builds a UI settings key, or null when the name cannot form one', () => {
		expect(savedViewsKey('items')).toBe('list.views.items');
		expect(savedViewsKey('in ventory')).toBeNull();
		expect(savedViewsKey('x'.repeat(60))).toBeNull();
	});
});

describe('canSaveListViews', () => {
	it('allows real accounts, the local desktop session and the demo session (no kind)', () => {
		expect(canSaveListViews({ status: 'active', kind: 'account' })).toBe(true);
		expect(canSaveListViews({ status: 'active', kind: 'local' })).toBe(true);
		expect(canSaveListViews({ status: 'active', kind: null })).toBe(true);
		expect(canSaveListViews({ status: 'active' })).toBe(true);
	});

	it('refuses grant sessions (public viewer) and anything not active', () => {
		expect(canSaveListViews({ status: 'active', kind: 'publicViewer' })).toBe(false);
		expect(canSaveListViews({ status: 'active', kind: 'someOtherGrant' })).toBe(false);
		expect(canSaveListViews({ status: 'none', kind: 'account' })).toBe(false);
		expect(canSaveListViews({ status: 'unknown', kind: null })).toBe(false);
	});
});

describe('presetViewContent / viewForFields / sameViewContent', () => {
	it('fills missing parts and drops entries on unknown fields', () => {
		const content = presetViewContent({
			id: 'x',
			label: () => 'x',
			filters: [
				{ field: 'stock', op: 'lt', value: 50 },
				{ field: 'category', op: 'eq', value: 'tea' }
			]
		});
		expect(content.sort).toEqual([]);
		expect(content.search).toBe('');
		expect(viewForFields(content, ['id', 'stock']).filters).toEqual([
			{ field: 'stock', op: 'lt', value: 50 }
		]);
	});

	it('compares sort, filters and the trimmed search term', () => {
		expect(sameViewContent(lowStock, { ...lowStock, search: '  ' })).toBe(true);
		expect(sameViewContent(lowStock, { ...lowStock, search: 'tea' })).toBe(false);
		expect(sameViewContent(lowStock, { ...lowStock, sort: [] })).toBe(false);
	});
});

describe('pinned columns in a view (#713)', () => {
	interface Row {
		id: number;
		code: string;
		name: string;
		stock: number;
	}
	// `code` is pinned by the definition.
	const columns: GridColumn<Row>[] = [
		{ id: 'id', header: 'ID', accessor: 'id' },
		{ id: 'code', header: 'Code', accessor: 'code', pinned: 'left' },
		{ id: 'name', header: 'Name', accessor: 'name' },
		{ id: 'stock', header: 'Stock', accessor: 'stock' }
	];
	const fields = columns.map((column) => column.id);
	const defaults = definitionPinned(columns);

	/** What `ResourceListPage` reads from the grid to save / compare. */
	function contentOf(state: GridState<Row>) {
		return { sort: state.sort, filters: state.filters, search: '', pinned: [...state.pinned] };
	}

	/** What `ResourceListPage` does to a grid when a view is applied. */
	function apply(state: GridState<Row>, content: Parameters<typeof viewForFields>[0]): void {
		const view = viewForFields(content, fields, defaults);
		state.sort = [...view.sort];
		state.filters = [...view.filters];
		if (view.pinned) state.pinned = [...view.pinned];
	}

	it('reads the pinned ids of the column definitions', () => {
		expect(defaults).toEqual(['code']);
		expect(definitionPinned([{ id: 'a' }, { id: 'b' }])).toEqual([]);
	});

	it('a saved view keeps the pinned columns through save -> store -> load -> apply', () => {
		const state = new GridState<Row>(columns);
		state.setColumnPinned('code', false);
		state.setColumnPinned('stock', true);
		state.setColumnPinned('name', true);

		const result = upsertSavedView([], 'Stock first', contentOf(state), () => 'my-1');
		if (result.kind === 'limit') throw new Error('unexpected limit');
		const stored = parseSavedViews(serializeSavedViews(result.views));
		expect(stored?.[0]?.pinned).toEqual(['stock', 'name']);

		// A fresh page: the grid starts from the definitions again.
		const next = new GridState<Row>(columns);
		expect(next.pinned).toEqual(['code']);
		apply(next, stored![0]!);

		expect([...next.pinned].sort()).toEqual(['name', 'stock']);
		// Pinned columns lead, in the grid's own column order.
		expect(next.orderedColumns.map((column) => column.id)).toEqual(['name', 'stock', 'id', 'code']);
		expect(next.pinnedCount).toBe(2);
		// ... and the menu's check mark finds the view again.
		expect(sameViewContent(viewForFields(stored![0]!, fields, defaults), contentOf(next))).toBe(
			true
		);
	});

	it('a saved view with nothing pinned unpins the definition-pinned column', () => {
		const state = new GridState<Row>(columns);
		state.setColumnPinned('code', false);
		const result = upsertSavedView([], 'Flat', contentOf(state), () => 'my-1');
		if (result.kind === 'limit') throw new Error('unexpected limit');
		const stored = parseSavedViews(serializeSavedViews(result.views));
		expect(stored?.[0]?.pinned).toEqual([]);

		const next = new GridState<Row>(columns);
		apply(next, stored![0]!);
		expect(next.pinned).toEqual([]);
	});

	it('a view saved before pinning (no `pinned`) applies the column definitions', () => {
		const old = JSON.stringify({
			version: 1,
			views: [{ id: 'my-old', label: 'Old', ...lowStock }]
		});
		const stored = parseSavedViews(old);
		expect(stored).toHaveLength(1);
		expect(stored![0]).not.toHaveProperty('pinned');

		const state = new GridState<Row>(columns);
		state.setColumnPinned('code', false);
		state.setColumnPinned('name', true);
		apply(state, stored![0]!);

		expect(state.pinned).toEqual(['code']);
		expect(state.sort).toEqual(lowStock.sort);
		expect(sameViewContent(viewForFields(stored![0]!, fields, defaults), contentOf(state))).toBe(
			true
		);
	});

	it('a definition view has no `pinned`, so it also applies the column definitions', () => {
		const content = presetViewContent({ id: 'low-stock', label: () => 'Low', ...lowStock });
		expect(content).not.toHaveProperty('pinned');
		expect(viewForFields(content, fields, defaults).pinned).toEqual(['code']);
		// Without the defaults a missing `pinned` stays missing.
		expect(viewForFields(content, fields)).not.toHaveProperty('pinned');
	});

	it('drops pinned ids the grid has no column for, and repeats', () => {
		const content = { ...lowStock, pinned: ['stock', 'gone', 'stock'] };
		expect(viewForFields(content, fields, defaults).pinned).toEqual(['stock']);
		expect(viewForFields(content, ['id', 'name'], []).pinned).toEqual([]);
	});

	it('compares pinned ids as a set', () => {
		const a = { ...lowStock, pinned: ['name', 'stock'] };
		expect(sameViewContent(a, { ...lowStock, pinned: ['stock', 'name'] })).toBe(true);
		expect(sameViewContent(a, { ...lowStock, pinned: ['stock'] })).toBe(false);
		expect(sameViewContent(a, lowStock)).toBe(false);
		expect(sameViewContent({ ...lowStock, pinned: [] }, lowStock)).toBe(false);
	});

	it('drops a stored view whose `pinned` is malformed, keeping the others', () => {
		const raw = JSON.stringify({
			version: 1,
			views: [
				{ id: 'a', label: 'A', ...lowStock, pinned: 'code' },
				{ id: 'b', label: 'B', ...lowStock, pinned: ['code', 1] },
				{ id: 'c', label: 'C', ...lowStock, pinned: ['code', 'code'] }
			]
		});
		expect(parseSavedViews(raw)).toEqual([{ id: 'c', label: 'C', ...lowStock, pinned: ['code'] }]);
	});

	it('overwriting a view by name replaces its pinned columns', () => {
		const first = upsertSavedView([], 'V', { ...lowStock, pinned: ['code'] }, () => 'my-1');
		if (first.kind === 'limit') throw new Error('unexpected limit');
		const second = upsertSavedView(first.views, 'V', { ...lowStock, pinned: [] }, () => 'my-2');
		if (second.kind === 'limit') throw new Error('unexpected limit');
		expect(second.kind).toBe('replaced');
		expect(second.views).toEqual([{ id: 'my-1', label: 'V', ...lowStock, pinned: [] }]);
	});
});

describe('parseSavedViews / serializeSavedViews', () => {
	it('round-trips', () => {
		const views = [saved('my-1', 'Low'), saved('my-2', 'Other')];
		expect(parseSavedViews(serializeSavedViews(views))).toEqual(views);
	});

	it('rejects a value that is not saved views at all', () => {
		expect(parseSavedViews('not json')).toBeUndefined();
		expect(parseSavedViews('[]')).toBeUndefined();
		expect(parseSavedViews(JSON.stringify({ version: 2, views: [] }))).toBeUndefined();
	});

	it('drops malformed entries and repeated ids, keeping the rest', () => {
		const raw = JSON.stringify({
			version: 1,
			views: [
				saved('my-1', 'Low'),
				{ ...saved('my-2', 'Bad op'), filters: [{ field: 'stock', op: 'nope', value: 1 }] },
				{ ...saved('my-3', '   ') },
				{ id: 'my-4', label: 'No search', sort: [], filters: [] },
				saved('my-1', 'Duplicate')
			]
		});
		expect(parseSavedViews(raw)?.map((view) => view.id)).toEqual(['my-1']);
	});
});

describe('upsertSavedView / removeSavedView', () => {
	it('adds a new name at the end with a fresh id and a trimmed name / term', () => {
		const result = upsertSavedView(
			[saved('my-1', 'Low')],
			'  Tea  ',
			{ ...lowStock, search: ' tea ' },
			() => 'my-new'
		);
		expect(result.kind).toBe('added');
		if (result.kind === 'limit') return;
		expect(result.views.map((view) => view.id)).toEqual(['my-1', 'my-new']);
		expect(result.view).toMatchObject({ id: 'my-new', label: 'Tea', search: 'tea' });
	});

	it('overwrites a view with the same name in place', () => {
		const result = upsertSavedView(
			[saved('my-1', 'Low'), saved('my-2', 'Tea')],
			'Low',
			{ sort: [], filters: [], search: 'x' },
			() => 'unused'
		);
		expect(result.kind).toBe('replaced');
		if (result.kind === 'limit') return;
		expect(result.views.map((view) => view.id)).toEqual(['my-1', 'my-2']);
		expect(result.views[0]).toEqual({
			id: 'my-1',
			label: 'Low',
			sort: [],
			filters: [],
			search: 'x'
		});
	});

	it('refuses a new name past the limit (an overwrite still works)', () => {
		const full = Array.from({ length: SAVED_VIEW_LIMIT }, (_, i) => saved(`my-${i}`, `V${i}`));
		expect(upsertSavedView(full, 'New', lowStock, () => 'my-x').kind).toBe('limit');
		expect(upsertSavedView(full, 'V3', lowStock, () => 'my-x').kind).toBe('replaced');
	});

	it('removes by id', () => {
		expect(removeSavedView([saved('my-1', 'A'), saved('my-2', 'B')], 'my-1')).toEqual([
			saved('my-2', 'B')
		]);
	});
});

describe('newSavedViewId', () => {
	it('never returns an id already taken', () => {
		const randoms = [0.5, 0.5, 0.25];
		const id = newSavedViewId(
			[{ ...saved(`my-${(1).toString(36)}${(0.5).toString(36).slice(2, 8)}`, 'A') }],
			() => randoms.shift() ?? 0.75,
			() => 1
		);
		expect(id).toBe(`my-1${(0.25).toString(36).slice(2, 8)}`);
	});
});
