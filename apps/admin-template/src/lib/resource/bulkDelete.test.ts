import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@banto/admin-core';
import type { DeleteManyTarget, ListParams, ListResult } from '@banto/admin-core';
import {
	BULK_DELETE_MAX_ROWS,
	bulkDeleteFailureOf,
	bulkDeleteOffered,
	captureSendGuard,
	captureViewGuard,
	collectMatchingItems,
	deleteItemsFromCapture,
	refreshCapturedVersions,
	refreshVersionsAfterConflict,
	settleVersionsAfterConflict,
	runBulkDelete,
	updateVersionCapture,
	type BulkDeleteDeps,
	type BulkDeleteRequest,
	type VersionCapture
} from './bulkDelete';

type Row = Record<string, unknown>;

/** A `getList` over `rows` that honours `pagination` and records its calls. */
function pagedList(rows: Row[], totalCount = rows.length) {
	const calls: ListParams[] = [];
	const getList = async (params: ListParams): Promise<ListResult<Row>> => {
		calls.push(params);
		const offset = params.pagination?.offset ?? 0;
		const limit = params.pagination?.limit ?? rows.length;
		return { rows: rows.slice(offset, offset + limit), totalCount };
	};
	return { getList, calls };
}

function versionedRows(count: number): Row[] {
	return Array.from({ length: count }, (_, index) => ({ id: index + 1, version: 1 }));
}

describe('bulkDeleteOffered (opt-in)', () => {
	const provider = { deleteMany: () => Promise.resolve({ deleted: 0 }) };

	it('needs the resource opt-in, the provider method and the delete permission', () => {
		expect(bulkDeleteOffered({ resourceOptIn: true, provider, canDelete: true })).toBe(true);
	});

	it('is off when the resource definition does not say bulkDelete: true', () => {
		expect(bulkDeleteOffered({ resourceOptIn: undefined, provider, canDelete: true })).toBe(false);
		expect(bulkDeleteOffered({ resourceOptIn: false, provider, canDelete: true })).toBe(false);
	});

	it('is off when the provider has no deleteMany', () => {
		expect(bulkDeleteOffered({ resourceOptIn: true, provider: {}, canDelete: true })).toBe(false);
	});

	it('is off without the delete permission', () => {
		expect(bulkDeleteOffered({ resourceOptIn: true, provider, canDelete: false })).toBe(false);
	});
});

describe('updateVersionCapture', () => {
	it('captures the version of a newly selected row at that moment', () => {
		const rows = new Map<number, Row>([[1, { id: 1, version: 3 }]]);
		const capture = updateVersionCapture(new Map(), [1], (id) => rows.get(id as number));
		expect([...capture]).toEqual([[1, 3]]);
	});

	it('keeps an earlier capture when the row has left the window or changed since', () => {
		const first = updateVersionCapture(new Map(), [1], () => ({ id: 1, version: 3 }));
		// Row 1 is no longer loaded; row 2 is selected now.
		const second = updateVersionCapture(first, [1, 2], (id) =>
			id === 2 ? { id: 2, version: 7 } : undefined
		);
		expect([...second]).toEqual([
			[1, 3],
			[2, 7]
		]);
		// A refetch brought a newer version of row 1: the capture does not follow it.
		const third = updateVersionCapture(second, [1, 2], () => ({ id: 1, version: 99 }));
		expect(third.get(1)).toBe(3);
	});

	it('drops the ids that left the selection', () => {
		const first = updateVersionCapture(new Map(), [1, 2], (id) => ({ id, version: 1 }));
		const second = updateVersionCapture(first, [2], () => undefined);
		expect([...second]).toEqual([[2, 1]]);
		expect(updateVersionCapture(second, [], () => undefined).size).toBe(0);
	});

	it('records null for a row without a version, and nothing for a row it cannot find', () => {
		const capture = updateVersionCapture(new Map(), ['a', 'b'], (id) =>
			id === 'a' ? { id: 'a' } : undefined
		);
		expect(capture.get('a')).toBeNull();
		expect(capture.has('b')).toBe(false);
	});
});

describe('refreshCapturedVersions', () => {
	it('takes the new version of a selected row this page saved, and ignores others', () => {
		const capture: VersionCapture = new Map([[1, 1]]);
		const next = refreshCapturedVersions(capture, [
			{ id: 1, version: 2 },
			{ id: 5, version: 9 }
		]);
		expect([...next]).toEqual([[1, 2]]);
	});
});

describe('refreshVersionsAfterConflict', () => {
	it('takes the versions of loaded rows and keeps the ones that are not loaded', () => {
		const capture: VersionCapture = new Map([
			[1, 1],
			[2, 4],
			[3, null]
		]);
		const rows = new Map<number, Record<string, unknown>>([
			[1, { id: 1, version: 5 }],
			[3, { id: 3 }]
		]);
		const next = refreshVersionsAfterConflict(capture, (id) => rows.get(id as number));
		expect([...next]).toEqual([
			[1, 5],
			[2, 4],
			[3, null]
		]);
		expect(capture.get(1)).toBe(1);
	});

	it('conflict, reload, refresh: the second press sends the new version', async () => {
		const server = new Map([[1, 2]]);
		const deleteMany = vi.fn(async (target: DeleteManyTarget) => {
			for (const item of target.items) {
				if (server.get(item.id as number) !== item.version) {
					throw new ProviderError({ kind: 'conflict', message: 'x' });
				}
			}
			return { deleted: target.items.length };
		});
		const deps: BulkDeleteDeps = {
			getList: vi.fn(async () => ({ rows: [], totalCount: 0 })),
			deleteMany,
			confirm: async () => true,
			canSend: () => true
		};
		let capture: VersionCapture = new Map([[1, 1]]);
		const request = () => ({
			ids: [1],
			allMatching: false,
			capture,
			conditions: { sort: [], filters: [] }
		});
		expect((await runBulkDelete(request(), deps)).kind).toBe('conflict');
		// The reload brought the row at its new version.
		capture = refreshVersionsAfterConflict(capture, (id) => ({
			id,
			version: server.get(id as number)
		}));
		expect((await runBulkDelete(request(), deps)).kind).toBe('done');
		expect(deleteMany).toHaveBeenLastCalledWith({ kind: 'ids', items: [{ id: 1, version: 2 }] });
	});
});

describe('settleVersionsAfterConflict', () => {
	const rowOf = (id: unknown) => ({ id, version: 9 });
	const pending = { generation: 3, ids: [1] };

	it('refreshes the conflicting ids after a successful load of the same generation', () => {
		const capture: VersionCapture = new Map([[1, 1]]);
		const step = settleVersionsAfterConflict(pending, 3, true, capture, rowOf);
		expect(step.pending).toBeNull();
		expect([...step.capture]).toEqual([[1, 9]]);
	});

	it('carries the pending refresh over a failed load, then refreshes on the next success', () => {
		const capture: VersionCapture = new Map([[1, 1]]);
		const failed = settleVersionsAfterConflict(pending, 3, false, capture, rowOf);
		expect(failed).toEqual({ pending, capture });
		const ok = settleVersionsAfterConflict(failed.pending, 3, true, failed.capture, rowOf);
		expect(ok.pending).toBeNull();
		expect([...ok.capture]).toEqual([[1, 9]]);
	});

	it('A deselected and B selected meanwhile: B keeps its captured version', () => {
		const capture: VersionCapture = new Map([[2, 4]]);
		const step = settleVersionsAfterConflict(pending, 4, true, capture, rowOf);
		expect(step.pending).toBeNull();
		expect([...step.capture]).toEqual([[2, 4]]);
	});

	it('same generation: ids not in the conflicting request keep their version', () => {
		const capture: VersionCapture = new Map([
			[1, 1],
			[2, 4]
		]);
		const step = settleVersionsAfterConflict(pending, 3, true, capture, rowOf);
		expect([...step.capture]).toEqual([
			[1, 9],
			[2, 4]
		]);
	});

	it('a conflicting id that is no longer selected is not added back', () => {
		const capture: VersionCapture = new Map([[2, 4]]);
		const step = settleVersionsAfterConflict(pending, 3, true, capture, rowOf);
		expect([...step.capture]).toEqual([[2, 4]]);
	});

	it('does nothing when no conflict is pending', () => {
		const capture: VersionCapture = new Map([[1, 1]]);
		expect(settleVersionsAfterConflict(null, 3, true, capture, rowOf)).toEqual({
			pending: null,
			capture
		});
	});
});

describe('deleteItemsFromCapture', () => {
	it('builds the records from the captured versions', () => {
		const capture: VersionCapture = new Map([
			[1, 3],
			[2, 7]
		]);
		expect(deleteItemsFromCapture([2, 1], capture)).toEqual({
			ok: true,
			items: [
				{ id: 2, version: 7 },
				{ id: 1, version: 3 }
			]
		});
	});

	it('sends no version for an unversioned resource', () => {
		const capture: VersionCapture = new Map([
			['a', null],
			['b', null]
		]);
		expect(deleteItemsFromCapture(['a', 'b'], capture)).toEqual({
			ok: true,
			items: [{ id: 'a' }, { id: 'b' }]
		});
	});

	it('refuses when a selected id was never captured', () => {
		expect(deleteItemsFromCapture([1, 2], new Map([[1, 3]]))).toEqual({
			ok: false,
			reason: 'versionMissing'
		});
	});

	it('refuses when only some rows of the selection carry a version', () => {
		const capture: VersionCapture = new Map([
			[1, 3],
			[2, null]
		]);
		expect(deleteItemsFromCapture([1, 2], capture)).toEqual({
			ok: false,
			reason: 'versionMissing'
		});
	});

	it('sends a repeated id once', () => {
		const result = deleteItemsFromCapture([1, 1], new Map([[1, 3]]));
		expect(result).toEqual({ ok: true, items: [{ id: 1, version: 3 }] });
	});
});

describe('collectMatchingItems', () => {
	const conditions = {
		sort: [{ field: 'name', direction: 'asc' as const }],
		filters: [{ field: 'stock', op: 'lt' as const, value: 50 }],
		search: 'tea'
	};

	it('pages through the result with the list conditions, search term included', async () => {
		const { getList, calls } = pagedList(versionedRows(5));
		const result = await collectMatchingItems(getList, conditions, { max: 10, pageSize: 2 });
		expect(result).toEqual({
			kind: 'ok',
			items: [1, 2, 3, 4, 5].map((id) => ({ id, version: 1 }))
		});
		expect(calls.map((call) => call.pagination)).toEqual([
			{ offset: 0, limit: 2 },
			{ offset: 2, limit: 2 },
			{ offset: 4, limit: 2 }
		]);
		for (const call of calls) {
			expect(call.sort).toEqual(conditions.sort);
			expect(call.filters).toEqual(conditions.filters);
			expect(call.search).toBe('tea');
		}
	});

	it('collects exactly the limit', async () => {
		const { getList } = pagedList(versionedRows(BULK_DELETE_MAX_ROWS));
		const result = await collectMatchingItems(getList, conditions);
		expect(result.kind === 'ok' && result.items.length).toBe(BULK_DELETE_MAX_ROWS);
	});

	it('is tooMany after the first page when totalCount exceeds the limit', async () => {
		const { getList, calls } = pagedList(versionedRows(BULK_DELETE_MAX_ROWS + 1));
		expect(await collectMatchingItems(getList, conditions)).toEqual({ kind: 'tooMany' });
		expect(calls).toHaveLength(1);
	});

	it('is tooMany when the rows collected exceed the limit although totalCount did not', async () => {
		// A backend whose count lags behind its rows.
		const { getList } = pagedList(versionedRows(7), 4);
		const result = await collectMatchingItems(getList, conditions, { max: 4, pageSize: 5 });
		expect(result).toEqual({ kind: 'tooMany' });
	});

	it('is changed when the result shifted between pages (a row met twice)', async () => {
		const pages: Row[][] = [
			[
				{ id: 1, version: 1 },
				{ id: 2, version: 1 }
			],
			[
				{ id: 2, version: 1 },
				{ id: 3, version: 1 }
			]
		];
		let call = 0;
		const result = await collectMatchingItems(
			async () => ({ rows: pages[call++] ?? [], totalCount: 4 }),
			conditions,
			{ max: 10, pageSize: 2 }
		);
		expect(result).toEqual({ kind: 'changed' });
	});

	it('is changed when totalCount differs between pages', async () => {
		const totals = [4, 5];
		let call = 0;
		const result = await collectMatchingItems(
			async (params) => {
				const offset = params.pagination?.offset ?? 0;
				return {
					rows: versionedRows(5).slice(offset, offset + 2),
					totalCount: totals[call++] ?? 5
				};
			},
			conditions,
			{ max: 10, pageSize: 2 }
		);
		expect(result).toEqual({ kind: 'changed' });
	});

	it('is changed when the rows collected are not totalCount', async () => {
		// The last page came back short: 3 rows for a total of 4.
		const { getList } = pagedList(versionedRows(3), 4);
		const result = await collectMatchingItems(getList, conditions, { max: 10, pageSize: 2 });
		expect(result).toEqual({ kind: 'changed' });
	});

	it('stops on an empty page and returns nothing for an empty result', async () => {
		const { getList, calls } = pagedList([]);
		expect(await collectMatchingItems(getList, conditions)).toEqual({ kind: 'ok', items: [] });
		expect(calls).toHaveLength(1);
	});

	it('is versionMissing when only some of the rows carry a version', async () => {
		const { getList } = pagedList([{ id: 1, version: 1 }, { id: 2 }]);
		expect(await collectMatchingItems(getList, conditions)).toEqual({ kind: 'versionMissing' });
	});
});

describe('captureSendGuard (session check)', () => {
	function session() {
		const state = { generation: 1, owner: 'account:1', destroyed: false };
		const guard = () =>
			captureSendGuard({
				capture: () => ({ generation: state.generation, owner: state.owner }),
				isCurrent: (scope) => scope.generation === state.generation && scope.owner === state.owner,
				isDestroyed: () => state.destroyed
			});
		return { state, guard };
	}

	it('allows the send while the session and the page are the same', () => {
		const { guard } = session();
		expect(guard()()).toBe(true);
	});

	it('refuses after the session changed, even for the same account', () => {
		const { state, guard } = session();
		const canSend = guard();
		state.generation = 2;
		expect(canSend()).toBe(false);
	});

	it('refuses after another account logged in', () => {
		const { state, guard } = session();
		const canSend = guard();
		state.owner = 'account:2';
		expect(canSend()).toBe(false);
	});

	it('refuses once the page is destroyed', () => {
		const { state, guard } = session();
		const canSend = guard();
		state.destroyed = true;
		expect(canSend()).toBe(false);
	});

	it('refuses once the list or selection generation changed since the press', () => {
		const state = { generation: 1, view: 'a' };
		const canSend = captureSendGuard({
			capture: () => state.generation,
			isCurrent: (scope) => scope === state.generation,
			isDestroyed: () => false,
			view: () => state.view
		});
		expect(canSend()).toBe(true);
		state.view = 'b';
		expect(canSend()).toBe(false);
		state.view = 'a';
		expect(canSend()).toBe(true);
	});

	it('compares against the scope captured at the press, not a later one', () => {
		const { state, guard } = session();
		const canSend = guard();
		state.generation = 2;
		// A guard captured now belongs to the new session; the old one stays refused.
		expect(guard()()).toBe(true);
		expect(canSend()).toBe(false);
	});
});

describe('bulkDeleteFailureOf', () => {
	it('maps a conflict', () => {
		const err = new ProviderError({ kind: 'conflict', message: 'x' });
		expect(bulkDeleteFailureOf(err)).toEqual({ kind: 'conflict' });
	});

	it('maps a bad_request to rejected without the server sentence', () => {
		const err = new ProviderError({ kind: 'bad_request', message: '一度に削除できるのは…' });
		expect(bulkDeleteFailureOf(err)).toEqual({ kind: 'rejected' });
	});

	it('maps everything else to error', () => {
		expect(bulkDeleteFailureOf(new ProviderError({ kind: 'forbidden' })).kind).toBe('error');
		expect(bulkDeleteFailureOf(new Error('offline'))).toEqual({
			kind: 'error',
			message: 'offline'
		});
		expect(bulkDeleteFailureOf('boom')).toEqual({ kind: 'error', message: 'boom' });
	});
});

describe('runBulkDelete', () => {
	function setup(overrides: Partial<BulkDeleteDeps> = {}) {
		const sent: DeleteManyTarget[] = [];
		const confirmed: { count: number; allMatching: boolean }[] = [];
		const deps: BulkDeleteDeps = {
			getList: vi.fn(async () => ({ rows: [], totalCount: 0 })),
			deleteMany: async (target) => {
				sent.push(target);
				return { deleted: target.items.length };
			},
			confirm: async (info) => {
				confirmed.push(info);
				return true;
			},
			canSend: () => true,
			...overrides
		};
		return { deps, sent, confirmed };
	}

	const noConditions = { sort: [], filters: [] };

	function selection(ids: number[], capture: VersionCapture): BulkDeleteRequest {
		return { ids, allMatching: false, capture, conditions: noConditions };
	}

	it('sends the selection in ONE request with the captured versions', async () => {
		const { deps, sent, confirmed } = setup();
		const outcome = await runBulkDelete(
			selection(
				[1, 2],
				new Map([
					[1, 3],
					[2, 7]
				])
			),
			deps
		);
		expect(outcome).toEqual({ kind: 'done', deleted: 2 });
		expect(sent).toEqual([
			{
				kind: 'ids',
				items: [
					{ id: 1, version: 3 },
					{ id: 2, version: 7 }
				]
			}
		]);
		expect(confirmed).toEqual([{ count: 2, allMatching: false }]);
		expect(deps.getList).not.toHaveBeenCalled();
	});

	it('does not ask or send when a version is missing', async () => {
		const { deps, sent, confirmed } = setup();
		const outcome = await runBulkDelete(selection([1, 2], new Map([[1, 3]])), deps);
		expect(outcome).toEqual({ kind: 'versionMissing' });
		expect(confirmed).toEqual([]);
		expect(sent).toEqual([]);
	});

	it('does not ask or send a selection over the limit', async () => {
		const { deps, sent, confirmed } = setup({ max: 2 });
		const capture = new Map([1, 2, 3].map((id) => [id, 1] as const));
		expect(await runBulkDelete(selection([1, 2, 3], capture), deps)).toEqual({ kind: 'tooMany' });
		expect(confirmed).toEqual([]);
		expect(sent).toEqual([]);
	});

	it('sends nothing when the confirmation is declined', async () => {
		const { deps, sent } = setup({ confirm: async () => false });
		expect(await runBulkDelete(selection([1], new Map([[1, 1]])), deps)).toEqual({
			kind: 'cancelled'
		});
		expect(sent).toEqual([]);
	});

	it('sends nothing when the session changed while the confirmation was open', async () => {
		let current = true;
		const { deps, sent } = setup({
			confirm: async () => {
				current = false; // logged out / another login behind the dialog
				return true;
			},
			canSend: () => current
		});
		expect(await runBulkDelete(selection([1], new Map([[1, 1]])), deps)).toEqual({
			kind: 'stale'
		});
		expect(sent).toEqual([]);
	});

	it('reports a conflict, a rejection and another error without throwing', async () => {
		const request = selection([1], new Map([[1, 1]]));
		const failing = (err: unknown) => setup({ deleteMany: () => Promise.reject(err) }).deps;
		expect(
			await runBulkDelete(request, failing(new ProviderError({ kind: 'conflict', message: 'x' })))
		).toEqual({ kind: 'conflict' });
		expect(
			(
				await runBulkDelete(
					request,
					failing(new ProviderError({ kind: 'bad_request', message: 'x' }))
				)
			).kind
		).toBe('rejected');
		expect((await runBulkDelete(request, failing(new Error('offline')))).kind).toBe('error');
	});

	describe('all matching', () => {
		const conditions = {
			sort: [],
			filters: [{ field: 'stock', op: 'lt' as const, value: 50 }],
			search: 'tea'
		};

		function allMatching(): BulkDeleteRequest {
			// `ids` are only the loaded rows and the capture is theirs: neither is used.
			return { ids: [1], allMatching: true, capture: new Map([[1, 1]]), conditions };
		}

		it('neither confirms nor sends when the list changed while the rows were read', async () => {
			const state = { view: 'a' };
			const canSend = captureSendGuard({
				capture: () => 0,
				isCurrent: () => true,
				isDestroyed: () => false,
				view: () => state.view
			});
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const { deps, sent, confirmed } = setup({
				canSend,
				getList: async () => {
					await gate;
					return { rows: [{ id: 1, version: 1 }], totalCount: 1 };
				}
			});
			const running = runBulkDelete(allMatching(), deps);
			state.view = 'b'; // the user searched while the ids were being collected
			release?.();
			expect(await running).toEqual({ kind: 'stale' });
			expect(confirmed).toEqual([]);
			expect(sent).toEqual([]);
		});

		it('does not send when the list changed while the confirmation was open', async () => {
			const state = { view: 'a' };
			const canSend = captureSendGuard({
				capture: () => 0,
				isCurrent: () => true,
				isDestroyed: () => false,
				view: () => state.view
			});
			const { deps, sent } = setup({
				canSend,
				getList: async () => ({ rows: [{ id: 1, version: 1 }], totalCount: 1 }),
				confirm: async () => {
					state.view = 'b';
					return true;
				}
			});
			expect(await runBulkDelete(allMatching(), deps)).toEqual({ kind: 'stale' });
			expect(sent).toEqual([]);
		});

		it('is changed (nothing confirmed or sent) when the result shifted while read', async () => {
			const { getList } = pagedList([{ id: 1, version: 1 }], 2);
			const { deps, sent, confirmed } = setup({ getList });
			expect(await runBulkDelete(allMatching(), deps)).toEqual({ kind: 'changed' });
			expect(confirmed).toEqual([]);
			expect(sent).toEqual([]);
		});

		it('captureViewGuard compares with the value at the press', () => {
			let view = 1;
			const same = captureViewGuard(() => view);
			expect(same()).toBe(true);
			view = 2;
			expect(same()).toBe(false);
		});

		it('a generation counter tells A -> B -> A and a same-selection mode switch apart', () => {
			let generation = 0;
			const same = captureViewGuard(() => generation);
			expect(same()).toBe(true);
			generation += 1; // A -> B
			generation += 1; // B -> A: the content is back, the generation is not
			expect(same()).toBe(false);
			const sameAgain = captureViewGuard(() => generation);
			generation += 1; // entering all-matching mode, selectedIds unchanged
			expect(sameAgain()).toBe(false);
		});

		it('canSend goes false once the generation moves on', async () => {
			let generation = 0;
			const sameView = captureViewGuard(() => generation);
			const { deps, sent } = setup({ canSend: () => sameView() });
			generation += 1;
			expect(await runBulkDelete(selection([1], new Map([[1, 1]])), deps)).toEqual({
				kind: 'stale'
			});
			expect(sent).toEqual([]);
		});

		it('reads the matching rows first, confirms THEIR count and sends their ids and versions', async () => {
			const rows = [
				{ id: 1, version: 4 },
				{ id: 8, version: 2 },
				{ id: 9, version: 1 }
			];
			const { getList, calls } = pagedList(rows);
			const { deps, sent, confirmed } = setup({ getList });
			const outcome = await runBulkDelete(allMatching(), deps);
			expect(outcome).toEqual({ kind: 'done', deleted: 3 });
			expect(calls[0].filters).toEqual(conditions.filters);
			expect(calls[0].search).toBe('tea');
			expect(confirmed).toEqual([{ count: 3, allMatching: true }]);
			expect(sent).toEqual([
				{
					kind: 'ids',
					items: [
						{ id: 1, version: 4 },
						{ id: 8, version: 2 },
						{ id: 9, version: 1 }
					]
				}
			]);
		});

		it('shows no confirmation and sends nothing over the limit', async () => {
			const { getList } = pagedList(versionedRows(5));
			const { deps, sent, confirmed } = setup({ getList, max: 4 });
			expect(await runBulkDelete(allMatching(), deps)).toEqual({ kind: 'tooMany' });
			expect(confirmed).toEqual([]);
			expect(sent).toEqual([]);
		});

		it('sends nothing when nothing matches any more', async () => {
			const { getList } = pagedList([]);
			const { deps, sent, confirmed } = setup({ getList });
			expect(await runBulkDelete(allMatching(), deps)).toEqual({ kind: 'noRows' });
			expect(confirmed).toEqual([]);
			expect(sent).toEqual([]);
		});

		it('shows no confirmation when the session changed during the read', async () => {
			const { getList } = pagedList(versionedRows(2));
			const { deps, sent, confirmed } = setup({ getList, canSend: () => false });
			expect(await runBulkDelete(allMatching(), deps)).toEqual({ kind: 'stale' });
			expect(confirmed).toEqual([]);
			expect(sent).toEqual([]);
		});

		it('reports a failed read as an error', async () => {
			const { deps, sent } = setup({ getList: () => Promise.reject(new Error('offline')) });
			expect(await runBulkDelete(allMatching(), deps)).toEqual({
				kind: 'error',
				message: 'offline'
			});
			expect(sent).toEqual([]);
		});
	});
});
