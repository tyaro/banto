import { describe, expect, it } from 'vitest';
import {
	SAVED_VIEW_LIMIT,
	canSaveListViews,
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
