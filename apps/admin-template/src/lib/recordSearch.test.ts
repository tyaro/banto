/**
 * #711: record search in the command palette - the sources derived from the
 * resource definitions (RBAC, query shape, limit, abort) and the recent
 * records (RBAC at read time, opens the drawer URL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppResourceDefinition } from '#lib/resource/types.js';

const session = vi.hoisted(() => ({ publicViewer: false, role: 'viewer', authDisabled: false }));
const getList = vi.hoisted(() => vi.fn());
const recents = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('./session.svelte', () => ({ sessionStore: session }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => `/${path}` }));
vi.mock('./banto/logout.svelte', () => ({ logoutAndLeave: vi.fn() }));
vi.mock('./banto/logoutNotice', () => ({ notifyLogoutOutcome: vi.fn() }));
vi.mock('./settings.svelte', () => ({ settings: {} }));
vi.mock('./resource/recentRecords', () => ({ loadRecentRecords: () => recents.list }));
vi.mock('@banto/admin-core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@banto/admin-core')>()),
	getDataProvider: () => ({ getList }),
	currentSessionScope: () => ({ generation: 1, owner: 'u' }),
	isCurrentSessionScope: () => true
}));

const def = (
	name: string,
	options: { list?: boolean; nav?: AppResourceDefinition['nav'] } = {}
): AppResourceDefinition =>
	({
		name,
		label: `${name} label`,
		path: `/${name}`,
		schema: { fields: [] },
		capabilities: { list: options.list ?? true },
		nav: options.nav
	}) as AppResourceDefinition;

const navEntry = (extra: Record<string, unknown> = {}) => ({ icon: {}, ...extra });

async function load(defs: AppResourceDefinition[]) {
	vi.resetModules();
	vi.doMock('./banto/resources', () => ({ resources: defs }));
	return import('./recordSearch');
}

afterEach(() => {
	vi.doUnmock('./banto/resources');
	vi.resetModules();
	getList.mockReset();
	recents.list = [];
	session.publicViewer = false;
	session.role = 'viewer';
});

describe('recordSources', { timeout: 30_000 }, () => {
	it('makes one source per resource and asks the provider for a few quick-search hits', async () => {
		const { recordSources } = await load([def('a', { nav: navEntry() as never })]);
		getList.mockResolvedValue({ rows: [{ id: 7, name: 'Widget' }], totalCount: 1 });
		const [source] = recordSources();
		expect(source.id).toBe('records.a');
		const found = await source.search('wid', new AbortController().signal);
		expect(getList).toHaveBeenCalledWith('a', {
			pagination: { offset: 0, limit: 5 },
			sort: [],
			filters: [],
			search: 'wid'
		});
		expect(found.map((c) => [c.id, c.title, c.group])).toEqual([
			['record.a.7', 'Widget', 'a label']
		]);
	});

	it('opens the list with ?id= (the drawer)', async () => {
		const { recordSources } = await load([def('a', { nav: navEntry() as never })]);
		getList.mockResolvedValue({ rows: [{ id: 'x y', name: 'N' }], totalCount: 1 });
		const [found] = await recordSources()[0].search('n', new AbortController().signal);
		await found.run();
		const { goto } = await import('$app/navigation');
		expect(goto).toHaveBeenCalledWith('/a?id=x%20y');
	});

	it('drops an answer that arrives after the request was aborted', async () => {
		const { recordSources } = await load([def('a', { nav: navEntry() as never })]);
		const controller = new AbortController();
		getList.mockImplementation(async () => {
			controller.abort();
			return { rows: [{ id: 1, name: 'Late' }], totalCount: 1 };
		});
		expect(await recordSources()[0].search('l', controller.signal)).toEqual([]);
	});

	it('RBAC: not listable, hidden nav entries and the viewer-public allowlist are not offered', async () => {
		const { recordSources } = await load([
			def('open', { nav: navEntry() as never }),
			def('nolist', { list: false, nav: navEntry() as never }),
			def('admin', { nav: navEntry({ adminOnly: true }) as never }),
			def('pub', { nav: navEntry({ publicViewer: true }) as never }),
			def('hidden-nav')
		]);
		const visible = () =>
			recordSources()
				.filter((s) => s.visible?.() ?? true)
				.map((s) => s.id.slice('records.'.length));

		session.role = 'viewer';
		expect(visible()).toEqual(['open', 'pub', 'hidden-nav']);
		session.role = 'admin';
		expect(visible()).toEqual(['open', 'admin', 'pub', 'hidden-nav']);
		session.role = 'viewer';
		session.publicViewer = true;
		expect(visible()).toEqual(['pub']);
	});
});

describe('recentRecordCommands', { timeout: 30_000 }, () => {
	it('lists the stored records under the recent heading, skipping unknown resources', async () => {
		const { recentRecordCommands } = await load([def('a', { nav: navEntry() as never })]);
		recents.list = [
			{ resource: 'a', id: 3, title: 'Three' },
			{ resource: 'gone', id: 1, title: 'Gone' }
		];
		const commands = recentRecordCommands();
		expect(commands.map((c) => [c.id, c.title])).toEqual([['record.a.3', 'Three']]);
		expect(commands[0].group).toBeTruthy();
	});

	it('a recent record of a resource the session cannot read is not visible (follows the session)', async () => {
		const { recentRecordCommands } = await load([
			def('admin', { nav: navEntry({ adminOnly: true }) as never })
		]);
		recents.list = [{ resource: 'admin', id: 3, title: 'Secret' }];
		const [command] = recentRecordCommands();
		session.role = 'viewer';
		expect(command.visible?.()).toBe(false);
		session.role = 'admin';
		expect(command.visible?.()).toBe(true);
	});
});
