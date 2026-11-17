import { initBanto, type CredentialRevision, type DataProvider } from '@banto/admin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #651: `updateUser` / `deleteUser` carry the optimistic-lock `version`
 * on both paths (REST: PUT body field / `DELETE ?version=`; Tauri: the
 * command's `version` argument) and leave it out (REST) or send `null`
 * (Tauri) when there is none, so the server overwrites as before.
 */
const setupMock = vi.hoisted(() => ({ mode: 'server' as 'demo' | 'server' | 'tauri' }));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function initForServer(): void {
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
}

const summary = {
	id: 7,
	username: 'u',
	displayName: 'U',
	role: 'editor',
	createdAt: '2026-01-01',
	version: 2
};

afterEach(() => {
	vi.unstubAllGlobals();
	invokeMock.mockReset();
});

describe('updateUser / deleteUser version (Issue #651)', () => {
	it('REST PUT sends version in the body, and omits it when absent', async () => {
		setupMock.mode = 'server';
		initForServer();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(summary), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { updateUser } = await import('./usersAdmin');

		await updateUser(7, { displayName: 'U', role: 'editor', version: 1 });
		await updateUser(7, { displayName: 'U', role: 'editor' });

		const bodies = fetchMock.mock.calls.map(
			(call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string) as unknown
		);
		expect(bodies[0]).toEqual({ displayName: 'U', role: 'editor', version: 1 });
		expect(bodies[1]).toEqual({ displayName: 'U', role: 'editor' });
	});

	it('REST DELETE sends ?version= only when given', async () => {
		setupMock.mode = 'server';
		initForServer();
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		const { deleteUser } = await import('./usersAdmin');

		await deleteUser(7, 3);
		await deleteUser(7);

		const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string])[0]);
		expect(urls).toEqual(['/api/users/7?version=3', '/api/users/7']);
	});

	it('Tauri passes version (or null) to the commands', async () => {
		setupMock.mode = 'tauri';
		invokeMock.mockResolvedValue(summary);
		const { updateUser, deleteUser } = await import('./usersAdmin');

		await updateUser(7, { displayName: 'U', role: 'editor', version: 1 });
		await updateUser(7, { displayName: 'U', role: 'editor' });
		await deleteUser(7, 3);
		await deleteUser(7);

		expect(invokeMock.mock.calls).toEqual([
			['users_update', { id: 7, displayName: 'U', role: 'editor', version: 1 }],
			['users_update', { id: 7, displayName: 'U', role: 'editor', version: null }],
			['users_delete', { id: 7, version: 3 }],
			['users_delete', { id: 7, version: null }]
		]);
	});
});
