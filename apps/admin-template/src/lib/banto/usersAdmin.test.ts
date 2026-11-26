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
			['users_update', { id: 7, displayName: 'U', role: 'editor', version: 1, permissions: null }],
			[
				'users_update',
				{ id: 7, displayName: 'U', role: 'editor', version: null, permissions: null }
			],
			['users_delete', { id: 7, version: 3 }],
			['users_delete', { id: 7, version: null }]
		]);
	});
});

describe('shouldAdvanceEditVersion (Issue #651)', () => {
	const base = { selectedId: 7, targetId: 7, editVersion: 3, sentVersion: 3, savedVersion: 4 };
	it('advances only for same user, same base, and consecutive version', async () => {
		const { shouldAdvanceEditVersion: f } = await import('./usersAdmin');
		expect(f(base)).toBe(true);
		expect(f({ ...base, selectedId: 8 })).toBe(false);
		expect(f({ ...base, selectedId: null })).toBe(false);
		expect(f({ ...base, editVersion: 2 })).toBe(false);
		expect(f({ ...base, savedVersion: 5 })).toBe(false);
	});
});

describe('permissions client (Issue #697)', () => {
	it('REST: updateUser sends permissions only when given; the catalog is GET /api/permissions', async () => {
		setupMock.mode = 'server';
		initForServer();
		const fetchMock = vi.fn(async (url: string) =>
			url === '/api/permissions'
				? new Response(
						JSON.stringify([
							{ key: 'alarm.ack', labelKey: 'perm.ack', descriptionKey: 'perm.ack.desc' }
						]),
						{ status: 200 }
					)
				: new Response(JSON.stringify({ ...summary, permissions: ['alarm.ack'] }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const { updateUser, listPermissionCatalog } = await import('./usersAdmin');

		await updateUser(7, { displayName: 'U', role: 'editor', version: 1 });
		await updateUser(7, { displayName: 'U', role: 'editor', version: 1, permissions: [] });
		await updateUser(7, { displayName: 'U', role: 'editor', permissions: ['alarm.ack'] });
		const catalog = await listPermissionCatalog();

		const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
		const bodies = calls.slice(0, 3).map(([, init]) => JSON.parse(init.body as string) as object);
		expect(bodies[0]).not.toHaveProperty('permissions');
		expect(bodies[1]).toHaveProperty('permissions', []);
		expect(bodies[2]).toHaveProperty('permissions', ['alarm.ack']);
		expect(calls[3][0]).toBe('/api/permissions');
		expect(calls[3][1].method).toBe('GET');
		expect(catalog[0]).toEqual({
			key: 'alarm.ack',
			labelKey: 'perm.ack',
			descriptionKey: 'perm.ack.desc'
		});
	});

	it('Tauri: permissions (or null) go to users_update; the catalog is permissions_catalog', async () => {
		setupMock.mode = 'tauri';
		invokeMock.mockResolvedValue([]);
		const { updateUser, listPermissionCatalog } = await import('./usersAdmin');

		await updateUser(7, {
			displayName: 'U',
			role: 'editor',
			version: 2,
			permissions: ['alarm.ack']
		});
		await listPermissionCatalog();

		expect(invokeMock.mock.calls).toEqual([
			[
				'users_update',
				{ id: 7, displayName: 'U', role: 'editor', version: 2, permissions: ['alarm.ack'] }
			],
			['permissions_catalog', undefined]
		]);
	});

	it('demo mode answers the catalog with an empty list (a read)', async () => {
		setupMock.mode = 'demo';
		const { listPermissionCatalog } = await import('./usersAdmin');
		await expect(listPermissionCatalog()).resolves.toEqual([]);
	});
});

describe('demo mode: read-only sample users (Issue #712)', () => {
	it('lists the fixed sample users, without calling the network', async () => {
		setupMock.mode = 'demo';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { listUsers, isUsersAdminWritable } = await import('./usersAdmin');
		const users = await listUsers();
		expect(users.length).toBeGreaterThanOrEqual(3);
		expect(users.filter((u) => u.kind === 'builtin')).toHaveLength(1);
		expect(await listUsers()).toEqual(users);
		expect(isUsersAdminWritable()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('refuses every write with the demo message', async () => {
		setupMock.mode = 'demo';
		const { createUser, updateUser, deleteUser, resetUserPassword, DEMO_MODE_MESSAGE } =
			await import('./usersAdmin');
		const expected = { message: DEMO_MODE_MESSAGE };
		await expect(
			createUser({ username: 'x', password: 'password1', displayName: 'X', role: 'viewer' })
		).rejects.toMatchObject(expected);
		await expect(updateUser(2, { displayName: 'Y', role: 'viewer' })).rejects.toMatchObject(
			expected
		);
		await expect(deleteUser(2)).rejects.toMatchObject(expected);
		await expect(resetUserPassword(2, 'password2')).rejects.toMatchObject(expected);
	});
});

describe('permission rows and draft (Issue #697)', () => {
	const catalog = [
		{ key: 'equipment.operate', labelKey: 'perm.op', descriptionKey: 'perm.op.desc' },
		{ key: 'alarm.ack', labelKey: 'perm.ack', descriptionKey: 'perm.ack.desc' }
	];
	const messages = { 'perm.op': () => 'Operate', 'perm.op.desc': () => 'Run equipment' };

	it('looks names up by message key and falls back to the key (no description when missing)', async () => {
		const { permissionRows } = await import('./usersAdmin');
		expect(permissionRows(catalog, [], messages)).toEqual([
			{
				key: 'equipment.operate',
				label: 'Operate',
				description: 'Run equipment',
				registered: true
			},
			{ key: 'alarm.ack', label: 'alarm.ack', description: null, registered: true }
		]);
	});

	it('lists held keys the catalog dropped as unregistered, sorted, after the catalog', async () => {
		const { permissionRows } = await import('./usersAdmin');
		const rows = permissionRows(catalog, ['zeta.old', 'alarm.ack', 'beta.old'], messages);
		expect(rows.map((r) => [r.key, r.registered])).toEqual([
			['equipment.operate', true],
			['alarm.ack', true],
			['beta.old', false],
			['zeta.old', false]
		]);
	});

	it('does not treat inherited names or a throwing message as a label', async () => {
		const { lookupMessage } = await import('./usersAdmin');
		expect(lookupMessage({}, 'toString')).toBeNull();
		expect(
			lookupMessage(
				{
					bad: () => {
						throw new Error('x');
					}
				},
				'bad'
			)
		).toBeNull();
		expect(lookupMessage({ empty: () => '' }, 'empty')).toBeNull();
	});

	it('finds a message in the real Paraglide namespace by its dotted key', async () => {
		const m = await import('#lib/paraglide/messages.js');
		const { lookupMessage } = await import('./usersAdmin');
		const source = m as unknown as Record<string, unknown>;
		expect(lookupMessage(source, 'common.role')).toBe(m['common.role']());
		expect(lookupMessage(source, 'no.such.key')).toBeNull();
	}, 30_000);

	it('withPermission is sorted, de-duplicated and does not mutate', async () => {
		const { withPermission } = await import('./usersAdmin');
		const draft = ['b.x', 'a.x'];
		expect(withPermission(draft, 'c.x', true)).toEqual(['a.x', 'b.x', 'c.x']);
		expect(withPermission(draft, 'a.x', true)).toEqual(['a.x', 'b.x']);
		expect(withPermission(draft, 'a.x', false)).toEqual(['b.x']);
		expect(draft).toEqual(['b.x', 'a.x']);
	});

	it('rebasePermissions: replays the draft changes on a moved base (own save landed after reselect)', async () => {
		const { rebasePermissions, permissionsToSend } = await import('./usersAdmin');
		// Saved a.x (base [] -> [a.x]); the reselected form (base []) then checked b.y.
		const draft = rebasePermissions(['b.y'], [], ['a.x']);
		expect(draft).toEqual(['a.x', 'b.y']);
		// The next save keeps what the first save granted.
		expect(permissionsToSend(draft, ['a.x'])).toEqual(['a.x', 'b.y']);
		// Unchecking against the old base still removes; untouched keys follow the new base.
		expect(rebasePermissions(['c.z'], ['a.x', 'c.z'], ['a.x', 'b.y', 'c.z'])).toEqual([
			'b.y',
			'c.z'
		]);
		// No change in the draft -> exactly the new base.
		expect(rebasePermissions([], [], ['a.x'])).toEqual(['a.x']);
	});

	it('permissionsToSend: only a changed set; nothing for an unchanged or unknown draft', async () => {
		const { permissionsToSend } = await import('./usersAdmin');
		expect(permissionsToSend(['b.x', 'a.x'], ['a.x', 'b.x'])).toBeUndefined();
		expect(permissionsToSend(['a.x'], ['a.x', 'b.x'])).toEqual(['a.x']);
		// Removing the last one sends an empty list (it is a change, not "omitted").
		expect(permissionsToSend([], ['a.x'])).toEqual([]);
		expect(permissionsToSend(['a.x'], [])).toEqual(['a.x']);
		// After a conflict the draft is unknown: never send a guess.
		expect(permissionsToSend(null, ['a.x'])).toBeUndefined();
	});

	it('an unregistered key stays in the draft unless unchecked (sent back = kept, not sent = removed)', async () => {
		const { permissionsToSend, withPermission } = await import('./usersAdmin');
		const base = ['alarm.ack', 'old.gone'];
		// Check a registered one: the unregistered one is still in the draft, so it is sent back.
		expect(permissionsToSend(withPermission(base, 'equipment.operate', true), base)).toEqual([
			'alarm.ack',
			'equipment.operate',
			'old.gone'
		]);
		// Uncheck it: it is not sent, so the server drops it.
		expect(permissionsToSend(withPermission(base, 'old.gone', false), base)).toEqual(['alarm.ack']);
	});
});
