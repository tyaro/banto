/**
 * The palette's navigation commands follow `navSections()` (sidebar / dock):
 * a LAN viewer-public session (ADR-0012) and non-admin roles do not see pages
 * they cannot open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppResourceDefinition } from '#lib/resource/types.js';

const session = vi.hoisted(() => ({ publicViewer: false, role: 'viewer', authDisabled: false }));
vi.mock('./session.svelte', () => ({ sessionStore: session }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => `/${path}` }));
vi.mock('./banto/logout.svelte', () => ({ logoutAndLeave: vi.fn() }));
vi.mock('./banto/logoutNotice', () => ({ notifyLogoutOutcome: vi.fn() }));
vi.mock('./settings.svelte', () => ({ settings: {} }));

import { buildCommands } from './commands';
import { navItems } from './navigation';

function visibleNavPaths(): string[] {
	return buildCommands()
		.filter((c) => c.id.startsWith('nav.') && (c.visible?.() ?? true))
		.map((c) => c.id.slice('nav.'.length));
}

describe('navigation commands visibility', () => {
	it('publicViewer session sees only the allowlisted pages', () => {
		session.publicViewer = true;
		session.role = 'viewer';
		const allowed = navItems.filter((i) => i.publicViewer).map((i) => i.path);
		expect(visibleNavPaths()).toEqual(allowed);
		for (const i of navItems.filter((i) => !i.publicViewer)) {
			expect(visibleNavPaths()).not.toContain(i.path);
		}
	});

	it('publicViewer session never sees adminOnly pages, even with an admin role', () => {
		session.publicViewer = true;
		session.role = 'admin';
		for (const i of navItems.filter((i) => i.adminOnly)) {
			expect(visibleNavPaths()).not.toContain(i.path);
		}
	});

	it('a normal viewer sees everything except adminOnly', () => {
		session.publicViewer = false;
		session.role = 'viewer';
		expect(visibleNavPaths()).toEqual(navItems.filter((i) => !i.adminOnly).map((i) => i.path));
	});

	it('a normal admin sees every page', () => {
		session.publicViewer = false;
		session.role = 'admin';
		expect(visibleNavPaths()).toEqual(navItems.map((i) => i.path));
	});
});

// ADR-0030 §8: "Create <label>" commands derive from the resource definitions.
// `resources` is mocked per case and the module re-imported, so the cases do
// not depend on which scaffold preset the copy is.
describe('create commands derived from resource definitions', () => {
	const def = (name: string, capabilities: AppResourceDefinition['capabilities']) =>
		({
			name,
			label: `${name} label`,
			path: `/${name}`,
			schema: { fields: [] },
			capabilities
		}) as AppResourceDefinition;

	async function load(defs: AppResourceDefinition[]) {
		vi.resetModules();
		vi.doMock('./banto/resources', () => ({ resources: defs }));
		return import('./commands');
	}

	function visibleCreateIds(commands: { id: string; visible?: () => boolean }[]): string[] {
		return commands
			.filter((c) => c.id.startsWith('create.') && (c.visible?.() ?? true))
			.map((c) => c.id);
	}

	afterEach(() => {
		vi.doUnmock('./banto/resources');
		vi.resetModules();
		session.publicViewer = false;
	});

	const full = { list: true, create: true, edit: true, delete: true };

	it.each(['admin', 'editor'])('%s sees a create command for creatable resources', async (role) => {
		session.role = role;
		const { buildCommands } = await load([def('a', full), def('b', { list: true })]);
		const commands = buildCommands();
		expect(visibleCreateIds(commands)).toEqual(['create.a']);
		expect(commands.find((c) => c.id === 'create.a')?.title).toContain('a label');
	});

	it('viewer (incl. the viewer-public session) sees no create command', async () => {
		const { buildCommands } = await load([def('a', full)]);
		session.role = 'viewer';
		expect(visibleCreateIds(buildCommands())).toEqual([]);
		session.publicViewer = true;
		expect(visibleCreateIds(buildCommands())).toEqual([]);
	});

	it('follows the session role at call time', async () => {
		const { buildCommands } = await load([def('a', full)]);
		const commands = buildCommands();
		session.role = 'viewer';
		expect(visibleCreateIds(commands)).toEqual([]);
		session.role = 'editor';
		expect(visibleCreateIds(commands)).toEqual(['create.a']);
	});

	it('navigates to <path>/new', async () => {
		session.role = 'admin';
		const { buildCommands } = await load([def('a', full)]);
		const { goto } = await import('$app/navigation');
		await buildCommands()
			.find((c) => c.id === 'create.a')
			?.run();
		expect(goto).toHaveBeenCalledWith('/a/new');
	});

	it('no resources, no create commands', async () => {
		session.role = 'admin';
		const { buildCommands } = await load([]);
		expect(buildCommands().filter((c) => c.id.startsWith('create.'))).toEqual([]);
	});
});
