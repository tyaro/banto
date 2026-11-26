import {
	initBanto,
	type CredentialRevision,
	type DataProvider,
	type ListParams
} from '@banto/admin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #248: `listAuditLog` carries the snapshot boundary on both paths -
 * REST as `?asOfId=` (the body stays `ListParams`), Tauri as the command's
 * `asOfId` argument - and leaves it out entirely when there is none, so the
 * server answers exactly as before (and runs its retention prune).
 */
const setupMock = vi.hoisted(() => ({ mode: 'server' as 'demo' | 'server' | 'tauri' }));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const params = {
	pagination: { offset: 200, limit: 200 },
	sort: [{ field: 'ts', direction: 'desc' as const }],
	filters: []
};
const answer = { rows: [], totalCount: 0, asOfId: 0 };

afterEach(() => {
	vi.unstubAllGlobals();
	invokeMock.mockReset();
});

describe('listAuditLog (Issue #248)', () => {
	it.each([
		['without a boundary', null, '/api/audit-log/list'],
		['with a boundary', 42, '/api/audit-log/list?asOfId=42']
	])('REST %s', async (_name, asOfId, path) => {
		setupMock.mode = 'server';
		initBanto({
			dataProvider: {} as DataProvider,
			authProvider: {
				login: async () => ({ success: true }),
				logout: async () => {},
				resolve: async () => ({
					status: 'none',
					checked: '0.0' as CredentialRevision,
					current: '0.0' as CredentialRevision
				}),
				credentialRevision: () => '0.0' as CredentialRevision,
				onCredentialChanged: () => () => {}
			},
			resources: []
		});
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { listAuditLog } = await import('./auditLogAdmin');
		const controller = new AbortController();

		await expect(listAuditLog(params, asOfId, controller.signal)).resolves.toEqual(answer);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(path);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual(params);
		expect(init.signal).toBe(controller.signal);
	});

	it.each([
		['without a boundary', null, { params }],
		['with a boundary', 42, { params, asOfId: 42 }]
	])('Tauri %s', async (_name, asOfId, args) => {
		setupMock.mode = 'tauri';
		invokeMock.mockResolvedValue(answer);
		const { listAuditLog } = await import('./auditLogAdmin');

		await expect(listAuditLog(params, asOfId)).resolves.toEqual(answer);
		expect(invokeMock).toHaveBeenCalledWith('audit_log_list', args);
	});
});

describe('demo mode: read-only sample audit log (Issue #712)', () => {
	const demoParams = (extra: Partial<ListParams> = {}): ListParams => ({ ...params, ...extra });

	it('pages the fixed sample rows newest first, without calling the network', async () => {
		setupMock.mode = 'demo';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { listAuditLog, isAuditLogAvailable } = await import('./auditLogAdmin');

		const first = await listAuditLog(demoParams({ pagination: { offset: 0, limit: 10 } }), null);
		expect(first.rows).toHaveLength(10);
		expect(first.totalCount).toBeGreaterThanOrEqual(30);
		expect(first.asOfId).toBe(first.totalCount);
		expect(first.rows[0].id).toBe(first.asOfId);
		expect(first.rows[0].ts >= first.rows[1].ts).toBe(true);

		const second = await listAuditLog(
			demoParams({ pagination: { offset: 10, limit: 10 } }),
			first.asOfId
		);
		expect(second.rows[0].id).toBe(first.rows[9].id - 1);

		expect(isAuditLogAvailable()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('honours filters and the snapshot boundary', async () => {
		setupMock.mode = 'demo';
		const { listAuditLog } = await import('./auditLogAdmin');
		const all = await listAuditLog(demoParams({ pagination: { offset: 0, limit: 500 } }), null);
		const logins = await listAuditLog(
			demoParams({
				pagination: { offset: 0, limit: 500 },
				filters: [{ field: 'action', op: 'eq', value: 'login' }]
			}),
			null
		);
		expect(logins.totalCount).toBeGreaterThan(0);
		expect(logins.totalCount).toBeLessThan(all.totalCount);
		expect(logins.rows.every((row) => row.action === 'login')).toBe(true);

		const bounded = await listAuditLog(demoParams({ pagination: { offset: 0, limit: 500 } }), 5);
		expect(bounded.totalCount).toBe(5);
		expect(bounded.asOfId).toBe(5);
	});

	it('reads the retention config, and refuses to change it', async () => {
		setupMock.mode = 'demo';
		const { getAuditConfig, setAuditConfig, DEMO_MODE_MESSAGE } = await import('./auditLogAdmin');
		await expect(getAuditConfig()).resolves.toMatchObject({ retentionDays: expect.any(Number) });
		await expect(setAuditConfig({ retentionDays: 1, retentionRows: 1 })).rejects.toMatchObject({
			message: DEMO_MODE_MESSAGE
		});
	});
});
