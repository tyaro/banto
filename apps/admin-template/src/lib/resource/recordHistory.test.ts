import { describe, expect, it, vi } from 'vitest';
import type { AuditLogList } from '#lib/banto/auditLogAdmin.js';
import { isAdmin } from '#lib/permissions.js';
import {
	HISTORY_PAGE_SIZE,
	createRecordHistoryLoader,
	recordHistoryParams,
	type RecordHistoryState
} from './recordHistory';

function entry(id: number): AuditLogList['rows'][number] {
	return {
		id,
		ts: '2026-11-14T00:00:00Z',
		actorUsername: 'admin',
		actorRole: 'admin',
		action: 'update',
		resource: 'items',
		entityId: '1',
		detail: null,
		origin: 'rest',
		result: 'ok'
	};
}

function answer(...ids: number[]): AuditLogList {
	return { rows: ids.map(entry), totalCount: ids.length, asOfId: 0 } as AuditLogList;
}

describe('who sees the history (#591 stage 2)', () => {
	// The drawer shows the tab for `isAdmin(role)` only; the server's
	// audit-log API is admin-only too.
	it.each([
		['admin', true],
		['editor', false],
		['viewer', false]
	] as const)('%s -> %s', (role, expected) => {
		expect(isAdmin(role)).toBe(expected);
	});
});

describe('recordHistoryParams', () => {
	it('filters the resource and the record with eq (not contains), newest first, one page', () => {
		const params = recordHistoryParams('items', 1);
		expect(params.filters).toEqual([
			{ field: 'resource', op: 'eq', value: 'items' },
			{ field: 'entityId', op: 'eq', value: '1' }
		]);
		expect(params.filters.some((f) => f.op === 'contains')).toBe(false);
		expect(params.sort[0]).toEqual({ field: 'ts', direction: 'desc' });
		expect(params.pagination).toEqual({ offset: 0, limit: HISTORY_PAGE_SIZE });
	});

	it('sends a string id as text', () => {
		expect(recordHistoryParams('items', '42').filters[1].value).toBe('42');
	});
});

describe('createRecordHistoryLoader', () => {
	it('loads with the record filter, a null snapshot boundary and a signal', async () => {
		const list = vi.fn().mockResolvedValue(answer(3, 2, 1));
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		await loader.load('items', 7);
		expect(list).toHaveBeenCalledTimes(1);
		const [params, asOfId, signal] = list.mock.calls[0];
		expect(params.filters[1]).toEqual({ field: 'entityId', op: 'eq', value: '7' });
		expect(asOfId).toBeNull();
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(states.map((s) => s.status)).toEqual(['loading', 'ready']);
		expect(states[1]).toMatchObject({ status: 'ready', total: 3 });
	});

	it('drops the answer of an older load (quick moves between rows)', async () => {
		const resolvers: Array<(v: AuditLogList) => void> = [];
		const list = vi.fn(
			(_p: unknown, _a?: unknown, signal?: AbortSignal) =>
				new Promise<AuditLogList>((resolve) => {
					resolvers.push(resolve);
					void signal;
				})
		);
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		const first = loader.load('items', 1);
		const second = loader.load('items', 2);
		// The first request was aborted when the second began.
		expect((list.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
		expect((list.mock.calls[1][2] as AbortSignal).aborted).toBe(false);
		// The second answers first, then the first answers late.
		resolvers[1](answer(20));
		await second;
		resolvers[0](answer(10));
		await first;
		const last = states[states.length - 1];
		expect(last).toMatchObject({ status: 'ready' });
		if (last.status === 'ready') expect(last.rows.map((r) => r.id)).toEqual([20]);
		expect(states.filter((s) => s.status === 'ready')).toHaveLength(1);
	});

	it('drops a failure of an older load too', async () => {
		const rejecters: Array<(e: unknown) => void> = [];
		const resolvers: Array<(v: AuditLogList) => void> = [];
		const list = vi.fn(
			() =>
				new Promise<AuditLogList>((resolve, reject) => {
					resolvers.push(resolve);
					rejecters.push(reject);
				})
		);
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		const first = loader.load('items', 1);
		const second = loader.load('items', 2);
		resolvers[1](answer(5));
		await second;
		rejecters[0](new Error('aborted'));
		await first;
		expect(states.some((s) => s.status === 'error')).toBe(false);
	});

	it('reports a failure of the current load, and a reload recovers', async () => {
		const list = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(answer(1));
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		await loader.load('items', 1);
		expect(states[states.length - 1].status).toBe('error');
		await loader.load('items', 1);
		expect(states[states.length - 1].status).toBe('ready');
	});

	it('reports nothing after dispose', async () => {
		let resolve!: (v: AuditLogList) => void;
		const list = vi.fn(
			() =>
				new Promise<AuditLogList>((r) => {
					resolve = r;
				})
		);
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		const pending = loader.load('items', 1);
		loader.dispose();
		resolve(answer(1));
		await pending;
		expect(states.map((s) => s.status)).toEqual(['loading']);
	});

	it('does nothing when load is called after dispose', async () => {
		const list = vi.fn().mockResolvedValue(answer(1));
		const states: RecordHistoryState[] = [];
		const loader = createRecordHistoryLoader(list, (s) => states.push(s));
		loader.dispose();
		await loader.load('items', 1);
		expect(list).not.toHaveBeenCalled();
		expect(states).toEqual([]);
	});
});
