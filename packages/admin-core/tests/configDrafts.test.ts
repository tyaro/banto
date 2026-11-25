import { describe, expect, it, vi } from 'vitest';
import { isNetworkError, ProviderError } from '../src/errors';
import {
	configDraftConflict,
	createHttpConfigDrafts,
	createTauriConfigDrafts
} from '../src/providers/configDrafts';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const GET_HEADERS = { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' };
const WRITE_HEADERS = { ...GET_HEADERS, 'Content-Type': 'application/json' };

function http(status = 200, body: unknown = {}) {
	const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(status, body));
	const provider = createHttpConfigDrafts({
		baseUrl: 'http://h:8721',
		getToken: () => 'tok',
		fetchFn
	});
	return { fetchFn, provider };
}

function conflict(current: unknown): ProviderError {
	return new ProviderError({ kind: 'conflict', message: 'x', current });
}

describe('createHttpConfigDrafts (T16)', () => {
	it('reads: path, query and headers', async () => {
		const { fetchFn, provider } = http(200, []);
		await provider.list();
		await provider.historyList('site/a', { before: 7, limit: 20 });
		await provider.historyList('site');
		expect(fetchFn.mock.calls).toEqual([
			['http://h:8721/api/config', { method: 'GET', headers: GET_HEADERS }],
			[
				'http://h:8721/api/config/site%2Fa/history?before=7&limit=20',
				{ method: 'GET', headers: GET_HEADERS }
			],
			['http://h:8721/api/config/site/history', { method: 'GET', headers: GET_HEADERS }]
		]);
	});

	it('get / diff / historyGet', async () => {
		const { fetchFn, provider } = http(200, { target: 'site' });
		await provider.get('site');
		await provider.diff('site');
		await provider.diff('site', { toVersion: 2 });
		await provider.historyGet('site', 3);
		expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
			'http://h:8721/api/config/site',
			'http://h:8721/api/config/site/diff',
			'http://h:8721/api/config/site/diff?toVersion=2',
			'http://h:8721/api/config/site/history/3'
		]);
	});

	it('lock: POST acquire, PUT extend {lease}, DELETE ?lease= answers 204', async () => {
		const { fetchFn, provider } = http(200, { lease: 'L' });
		await provider.lockAcquire('site');
		await provider.lockExtend('site', 'L');
		fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(provider.lockRelease('site', 'a b')).resolves.toBeUndefined();
		expect(fetchFn.mock.calls).toEqual([
			['http://h:8721/api/config/site/lock', { method: 'POST', headers: GET_HEADERS }],
			[
				'http://h:8721/api/config/site/lock',
				{ method: 'PUT', headers: WRITE_HEADERS, body: JSON.stringify({ lease: 'L' }) }
			],
			['http://h:8721/api/config/site/lock?lease=a%20b', { method: 'DELETE', headers: GET_HEADERS }]
		]);
	});

	it('draft: PUT body (ifPublishedRevision only when given), rebase, DELETE ?ifRevision=', async () => {
		const { fetchFn, provider } = http(200, { revision: '2' });
		await provider.draftPut('site', {
			value: { a: 1 },
			ifRevision: '0',
			ifPublishedRevision: 'p1'
		});
		await provider.draftPut('site', { value: { a: 2 }, ifRevision: '2' });
		await provider.draftRebase('site', { ifRevision: '3', ifPublishedRevision: 'p2' });
		await provider.draftDiscard('site', '3');
		expect(fetchFn.mock.calls).toEqual([
			[
				'http://h:8721/api/config/site/draft',
				{
					method: 'PUT',
					headers: WRITE_HEADERS,
					body: JSON.stringify({ value: { a: 1 }, ifRevision: '0', ifPublishedRevision: 'p1' })
				}
			],
			[
				'http://h:8721/api/config/site/draft',
				{
					method: 'PUT',
					headers: WRITE_HEADERS,
					body: JSON.stringify({ value: { a: 2 }, ifRevision: '2' })
				}
			],
			[
				'http://h:8721/api/config/site/draft/rebase',
				{
					method: 'POST',
					headers: WRITE_HEADERS,
					body: JSON.stringify({ ifRevision: '3', ifPublishedRevision: 'p2' })
				}
			],
			[
				'http://h:8721/api/config/site/draft?ifRevision=3',
				{ method: 'DELETE', headers: GET_HEADERS }
			]
		]);
	});

	it('publish / revert / unlock bodies (comment only when given)', async () => {
		const { fetchFn, provider } = http(200, { version: 2 });
		await provider.publish('site', { ifDraftRevision: 'd1', comment: 'ok' });
		await provider.publish('site', { ifDraftRevision: 'd2' });
		await provider.revert('site', { toVersion: 1, ifPublishedRevision: 'p3' });
		fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(provider.unlock('site', 'L9')).resolves.toBeUndefined();
		const bodies = fetchFn.mock.calls.map((c) => [c[0], c[1].method, c[1].body]);
		expect(bodies).toEqual([
			[
				'http://h:8721/api/config/site/publish',
				'POST',
				JSON.stringify({ ifDraftRevision: 'd1', comment: 'ok' })
			],
			['http://h:8721/api/config/site/publish', 'POST', JSON.stringify({ ifDraftRevision: 'd2' })],
			[
				'http://h:8721/api/config/site/revert',
				'POST',
				JSON.stringify({ toVersion: 1, ifPublishedRevision: 'p3' })
			],
			['http://h:8721/api/config/site/unlock', 'POST', JSON.stringify({ ifLease: 'L9' })]
		]);
	});

	it('no token: no Authorization header; an empty target is refused locally', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
		const provider = createHttpConfigDrafts({ getToken: () => null, fetchFn });
		await provider.list();
		expect(fetchFn).toHaveBeenCalledWith('/api/config', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto' }
		});
		await expect(provider.get('')).rejects.toBeInstanceOf(ProviderError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('errors: a 409 is a ProviderError conflict; a lost fetch is a network failure; a bad shape is refused', async () => {
		const body = { kind: 'conflict', message: 'm', current: { reason: 'lock_held', lock: null } };
		const { provider } = http(409, body);
		const error = await provider.lockAcquire('site').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(configDraftConflict(error)).toEqual({ reason: 'lock_held', lock: null });

		const down = createHttpConfigDrafts({
			getToken: () => 'tok',
			fetchFn: vi.fn().mockRejectedValue(new TypeError('x'))
		});
		expect(isNetworkError(await down.list().catch((e: unknown) => e))).toBe(true);

		const bad = http(200, 'nope').provider;
		await expect(bad.get('site')).rejects.toBeInstanceOf(ProviderError);
	});

	it('another account holds the lock: list and get show its lease and an administrator unlocks with it', async () => {
		const lock = { holderName: 'B', lease: 'LB', acquiredAtMs: 1, expiresAtMs: 2 };
		const { fetchFn, provider } = http(200, [{ target: 'site', lock }]);
		const rows = await provider.list();
		const seen = rows[0]!.lock!;
		expect(seen.lease).toBe('LB');
		fetchFn.mockImplementationOnce(async () =>
			jsonResponse(200, { target: 'site', lock, lockIsMine: false })
		);
		const state = await provider.get('site');
		expect(state.lockIsMine).toBe(false);
		expect(state.lock?.lease).toBe('LB');
		fetchFn.mockImplementationOnce(async () => new Response(null, { status: 204 }));
		await provider.unlock('site', seen.lease);
		expect(fetchFn.mock.calls[2]).toEqual([
			'http://h:8721/api/config/site/unlock',
			{ method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify({ ifLease: 'LB' }) }
		]);
	});

	it('a body JSON cannot hold is an input error of the caller: nothing is sent, not a network failure', async () => {
		const { fetchFn, provider } = http();
		const error = await provider
			.draftPut('site', { value: { n: 1n }, ifRevision: '0', ifPublishedRevision: 'r' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(isNetworkError(error)).toBe(false);
		expect((error as ProviderError).body.kind).toBe('bad_request');
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('createTauriConfigDrafts (T16)', () => {
	it('calls the config_* commands with target + body + query fields as arguments', async () => {
		const invoke = vi
			.fn()
			.mockImplementation(async (cmd: string) =>
				cmd === 'config_list' || cmd === 'config_history_list' ? [] : {}
			);
		const provider = createTauriConfigDrafts({ invoke });
		await provider.list();
		await provider.get('site');
		await provider.diff('site', { toVersion: 2 });
		await provider.historyList('site', { before: 5 });
		await provider.historyGet('site', 3);
		await provider.lockAcquire('site');
		await provider.lockExtend('site', 'L');
		await provider.lockRelease('site', 'L');
		await provider.draftPut('site', { value: { a: 1 }, ifRevision: '0', ifPublishedRevision: 'p' });
		await provider.draftRebase('site', { ifRevision: '1', ifPublishedRevision: 'p2' });
		await provider.draftDiscard('site', '1');
		await provider.publish('site', { ifDraftRevision: 'd', comment: 'c' });
		await provider.revert('site', { toVersion: 1, ifPublishedRevision: 'p3' });
		await provider.unlock('site', 'L2');
		expect(invoke.mock.calls).toEqual([
			['config_list', {}],
			['config_get', { target: 'site' }],
			['config_diff', { target: 'site', toVersion: 2 }],
			['config_history_list', { target: 'site', before: 5 }],
			['config_history_get', { target: 'site', version: 3 }],
			['config_lock_acquire', { target: 'site' }],
			['config_lock_extend', { target: 'site', lease: 'L' }],
			['config_lock_release', { target: 'site', lease: 'L' }],
			[
				'config_draft_put',
				{ target: 'site', value: { a: 1 }, ifRevision: '0', ifPublishedRevision: 'p' }
			],
			['config_draft_rebase', { target: 'site', ifRevision: '1', ifPublishedRevision: 'p2' }],
			['config_draft_discard', { target: 'site', ifRevision: '1' }],
			['config_publish', { target: 'site', ifDraftRevision: 'd', comment: 'c' }],
			['config_revert', { target: 'site', toVersion: 1, ifPublishedRevision: 'p3' }],
			['config_unlock', { target: 'site', ifLease: 'L2' }]
		]);
	});

	it('a rejected ErrorBody becomes a ProviderError', async () => {
		const invoke = vi.fn().mockRejectedValue({
			kind: 'conflict',
			message: 'm',
			current: { reason: 'lock_required', lock: null }
		});
		const error = await createTauriConfigDrafts({ invoke })
			.draftDiscard('site', '1')
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(configDraftConflict(error)).toEqual({ reason: 'lock_required', lock: null });
	});
});

describe('configDraftConflict (T16)', () => {
	const stamp = { version: 4, revision: 'p9' };
	const lock = { holderName: 'alice', acquiredAtMs: 1, expiresAtMs: 2 };
	const draft = { value: { a: 1 }, baseVersion: 3, revision: 'd2', updatedBy: 'a', updatedAt: 't' };

	it('extracts every reason with its state', () => {
		expect(
			configDraftConflict(conflict({ reason: 'stale_base', baseVersion: 3, published: stamp }))
		).toEqual({ reason: 'stale_base', baseVersion: 3, published: stamp });
		expect(
			configDraftConflict(conflict({ reason: 'draft_changed', revision: 'd2', draft }))
		).toEqual({ reason: 'draft_changed', revision: 'd2', draft });
		expect(
			configDraftConflict(conflict({ reason: 'draft_changed', revision: '0', draft: null }))
		).toEqual({ reason: 'draft_changed', revision: '0', draft: null });
		expect(
			configDraftConflict(conflict({ reason: 'published_changed', published: stamp }))
		).toEqual({
			reason: 'published_changed',
			published: stamp
		});
		expect(configDraftConflict(conflict({ reason: 'lock_held', lock }))).toEqual({
			reason: 'lock_held',
			lock
		});
		expect(configDraftConflict(conflict({ reason: 'lock_required', lock: null }))).toEqual({
			reason: 'lock_required',
			lock: null
		});
	});

	it('is null for anything else', () => {
		expect(configDraftConflict(new Error('x'))).toBeNull();
		expect(configDraftConflict(new ProviderError({ kind: 'forbidden' }))).toBeNull();
		expect(configDraftConflict(conflict(undefined))).toBeNull();
		expect(configDraftConflict(conflict({ reason: 'other' }))).toBeNull();
		expect(configDraftConflict(conflict({ reason: 'stale_base', baseVersion: 'x' }))).toBeNull();
		expect(
			configDraftConflict(conflict({ reason: 'lock_held', lock: { holderName: 1 } }))
		).toBeNull();
		expect(configDraftConflict(conflict({ value: 'v', revision: 'r' }))).toBeNull();
	});
});
