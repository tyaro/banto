/**
 * #332: under a non-empty `BASE_PATH` (the GitHub Pages demo) `page.url.pathname`
 * carries the base while the nav tables hold base-less paths. `isPathActive` /
 * `pageTitle` / `navBadges` must still match. `$app/paths`' `resolve` is mocked
 * to prepend a configurable base (SvelteKit 3: `resolve('items')` -> `base/items`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidate, onInvalidate } from '@banto/admin-core';
import type { RouteId } from '$app/types';
import { resources } from './banto/resources';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => ({
	resolve: (path: string) => `${state.base}/${path}`
}));

import {
	isPathActive,
	navBarEntries,
	navItems,
	navLabel,
	navSections,
	pageTitle,
	type AppPath,
	type NavItem
} from './navigation';
import { navBadges } from './navBadges.svelte';
import type { AppResourceDefinition } from './resource/types';
import type { Component } from 'svelte';
import * as m from '#lib/paraglide/messages.js';

// Scaffold presets remove nav entries (items, dashboard, ...), so the cases below
// derive their paths and titles from whatever `navItems` the copy still has.
const first = navItems[0];
const other = navItems[1];

describe.each(['', '/banto'])('base=%j', (base) => {
	afterEach(() => {
		state.base = '';
	});
	const at = (p: string) => {
		state.base = base;
		return `${base}${p}`;
	};

	it('isPathActive owns the path and its sub-paths only', () => {
		expect(isPathActive(first.path, at(first.path))).toBe(true);
		expect(isPathActive(first.path, at(`${first.path}/3`))).toBe(true);
		expect(isPathActive(first.path, at(`${first.path}-other`))).toBe(false);
		expect(isPathActive(other.path, at(first.path))).toBe(false);
	});

	it('pageTitle resolves the entry title from a base-carrying pathname', () => {
		expect(pageTitle(at(first.path))).toBe(navLabel(first));
		expect(pageTitle(at(`${first.path}/3`))).toBe(navLabel(first));
		expect(pageTitle(at('/nowhere'))).toBe('Banto');
	});

	it('uses exact route titles and preserves entry and unknown-route fallbacks', () => {
		for (const entry of navItems) {
			for (const [route, title] of Object.entries(entry.pageTitles ?? {})) {
				const routeId = route as RouteId;
				const path = route.replace(/\/\([^/]+\)/g, '').replace(/\[[^/]+\]/g, 'record-42');
				const label = resources.find(
					(resource) => resource.name === entry.pageTitleResource
				)?.label;
				expect(pageTitle(at(path), routeId)).toBe(title(label ?? navLabel(entry)));
				expect(pageTitle(at(`${path}/`), routeId)).toBe(title(label ?? navLabel(entry)));
				expect(pageTitle(at(path))).toBe(navLabel(entry));
				expect(pageTitle(at(path), null)).toBe(navLabel(entry));
				expect(pageTitle(at('/nowhere'), routeId)).toBe('Banto');
				// Keep the route group, but choose an unconfigured static sibling.
				const reportRoute = route.replace(/\/[^/]+$/, '/report') as RouteId;
				expect(pageTitle(at(`${entry.path}/report`), reportRoute)).toBe(navLabel(entry));

				const resourceIndex = resources.findIndex(
					(resource) => resource.name === entry.pageTitleResource
				);
				if (resourceIndex >= 0) {
					const original = resources[resourceIndex];
					try {
						resources[resourceIndex] = { ...original, label: 'Replacement resource' };
						expect(pageTitle(at(path), routeId)).toBe(title('Replacement resource'));
					} finally {
						resources[resourceIndex] = original;
					}
				}
			}
		}
	});

	it('navBadges counts elsewhere, not on the owning page, and clears on arrival', () => {
		const key = '/nbt-items' as AppPath;
		const off = onInvalidate('nbt-items', (_r, reason) =>
			navBadges.noteInvalidation(key, at(first.path), reason)
		);
		invalidate('nbt-items');
		expect(navBadges.count(key)).toBe(1);
		navBadges.noteInvalidation(key, at('/nbt-items/3'), 'change');
		expect(navBadges.count(key)).toBe(1);
		navBadges.clearFor(at('/nbt-items/3'));
		expect(navBadges.count(key)).toBe(0);
		off();
	});
});

// navSections() (nav-launcher-plan PR-1): expectations derive from `navItems` so the
// table also holds for scaffold presets that remove entries.
describe('navSections', () => {
	const paths = (items: { path: string }[]) => items.map((item) => item.path);
	const normal = navItems.filter((item) => !item.adminOnly);
	const adminOnly = navItems.filter((item) => item.adminOnly);
	const publicOnly = navItems.filter((item) => item.publicViewer);

	it.each([
		{ name: 'viewer', publicViewer: false, role: 'viewer' as const, main: normal, admin: [] },
		{ name: 'editor', publicViewer: false, role: 'editor' as const, main: normal, admin: [] },
		{ name: 'admin', publicViewer: false, role: 'admin' as const, main: normal, admin: adminOnly },
		{
			name: 'publicViewer',
			publicViewer: true,
			role: 'viewer' as const,
			main: publicOnly,
			admin: []
		},
		{
			name: 'publicViewer with role admin',
			publicViewer: true,
			role: 'admin' as const,
			main: publicOnly,
			admin: []
		}
	])('$name: main/admin contents and order', ({ publicViewer, role, main, admin }) => {
		const sections = navSections({ publicViewer, role });
		expect(paths(sections.main)).toEqual(paths(main));
		expect(paths(sections.admin)).toEqual(paths(admin));
	});

	it('never lists a demoOnly entry in a non-demo build', () => {
		for (const publicViewer of [false, true]) {
			const { main, admin } = navSections({ publicViewer, role: 'admin' });
			expect([...main, ...admin].some((item) => item.demoOnly)).toBe(false);
		}
	});

	it('keeps admin-only entries out of main for every session', () => {
		for (const publicViewer of [false, true]) {
			expect(navSections({ publicViewer, role: 'admin' }).main.some((i) => i.adminOnly)).toBe(
				false
			);
		}
	});
});

// ADR-0030 §8: the entries for resources are derived from the resource definitions.
// The module reads `resources` once at import, so each case mocks the array and
// re-imports `./navigation` (independent of which scaffold preset the copy is).
// navBarEntries() (nav-menubar-plan §4.10): the group sits at its first member's position.
describe('navBarEntries', () => {
	const item = (path: string, extra: Partial<NavItem> = {}) =>
		({ path, icon: 'dashboard', ...extra }) as NavItem;
	const shape = (items: NavItem[]) =>
		navBarEntries(items).map((e) =>
			e.kind === 'item' ? e.item.path : `${e.key}[${e.items.map((i) => i.path).join(',')}]`
		);

	it('no groups: every entry stays a standalone item, in order', () => {
		expect(shape([item('/a'), item('/b'), item('/c')])).toEqual(['/a', '/b', '/c']);
		expect(navBarEntries([])).toEqual([]);
	});

	it('a group sits at its first member and gathers distant members in original order', () => {
		const g = { group: 'nav.group.demo' } as const;
		expect(shape([item('/a'), item('/x', g), item('/b'), item('/y', g), item('/c')])).toEqual([
			'/a',
			'nav.group.demo[/x,/y]',
			'/b',
			'/c'
		]);
	});

	it('a single-member group stays a group', () => {
		expect(shape([item('/a'), item('/x', { group: 'nav.group.demo' })])).toEqual([
			'/a',
			'nav.group.demo[/x]'
		]);
	});

	it('ignores group on adminOnly entries', () => {
		expect(
			shape([
				item('/a', { group: 'nav.group.demo' }),
				item('/u', { group: 'nav.group.demo', adminOnly: true })
			])
		).toEqual(['nav.group.demo[/a]', '/u']);
	});

	it('holds after the public-viewer narrowing (a group with no public member disappears)', () => {
		const g = { group: 'nav.group.demo' } as const;
		const all = [
			item('/a', { publicViewer: true }),
			item('/x', g),
			item('/y', { ...g, publicViewer: true }),
			item('/z', g)
		];
		expect(shape(all.filter((i) => i.publicViewer))).toEqual(['/a', 'nav.group.demo[/y]']);
		expect(shape(all.filter((i) => i.publicViewer && (i.path as string) === '/a'))).toEqual(['/a']);
	});

	it('works on the real navSections() output', () => {
		const { main } = navSections({ publicViewer: false, role: 'admin' });
		expect(navBarEntries(main).flatMap((e) => (e.kind === 'item' ? [e.item] : e.items))).toEqual(
			expect.arrayContaining(main)
		);
	});
});

describe('navigation derived from resource definitions', () => {
	const Icon = (() => {}) as unknown as Component;
	const def = (
		name: string,
		nav: AppResourceDefinition['nav'],
		path = `/${name}` as AppPath
	): AppResourceDefinition => ({
		name,
		label: `${name} label`,
		path,
		nav,
		schema: { fields: [] },
		capabilities: { list: true }
	});

	async function load(defs: AppResourceDefinition[]) {
		vi.resetModules();
		vi.doMock('./banto/resources/index.js', () => ({ resources: defs }));
		return import('./navigation');
	}

	afterEach(() => {
		vi.doUnmock('./banto/resources/index.js');
		vi.resetModules();
	});

	// The fixed pages differ by scaffold preset (display swaps the dashboard for
	// /monitor), so read them from a copy with no resources instead of hard-coding.
	const fixedPaths = async () => (await load([])).navItems.map((item) => item.path);
	const fixedPublicPaths = async () => (await load([])).publicNavItems().map((item) => item.path);

	it('passes nav.group through to the entry', async () => {
		const nav = await load([
			def('alpha', { icon: Icon, group: 'nav.group.demo' }),
			def('beta', { icon: Icon })
		]);
		expect(nav.navItems.find((i) => (i.path as string) === '/alpha')?.group).toBe('nav.group.demo');
		expect(nav.navItems.find((i) => (i.path as string) === '/beta')?.group).toBeUndefined();
	});

	it('lists nav resources in array order, right after the first fixed page', async () => {
		const [home] = await fixedPaths();
		const nav = await load([
			def('alpha', { icon: Icon, label: () => 'Alpha nav' }),
			def('hidden', false),
			def('unset', undefined),
			def('beta', { icon: Icon })
		]);
		const paths = nav.navItems.map((item) => item.path);
		expect(paths.slice(0, 3)).toEqual([home, '/alpha', '/beta']);
		expect(paths).not.toContain('/hidden');
		expect(paths).not.toContain('/unset');
		const [, alpha, beta] = nav.navItems;
		expect(alpha.icon).toBe(Icon);
		expect(nav.navLabel(alpha)).toBe('Alpha nav');
		// label defaults to the resource label
		expect(nav.navLabel(beta)).toBe('beta label');
	});

	it('carries badge / adminOnly / publicViewer from nav', async () => {
		const fixedPublic = await fixedPublicPaths();
		const nav = await load([
			def('seen', { icon: Icon, badge: true, publicViewer: true }),
			def('plain', { icon: Icon }),
			def('secret', { icon: Icon, adminOnly: true })
		]);
		const by = (path: string) => nav.navItems.find((item) => item.path === path)!;
		expect(by('/seen').badgeResource).toBe('seen');
		expect(by('/plain').badgeResource).toBeUndefined();
		expect(by('/secret').adminOnly).toBe(true);
		const paths = (items: { path: string }[]) => items.map((item) => item.path);
		const viewer = nav.navSections({ publicViewer: false, role: 'viewer' });
		expect(paths(viewer.main)).toEqual(expect.arrayContaining(['/seen', '/plain']));
		expect(paths(viewer.main)).not.toContain('/secret');
		expect(paths(nav.navSections({ publicViewer: false, role: 'admin' }).admin)).toContain(
			'/secret'
		);
		// viewer-public sessions see only publicViewer entries (the fixed public pages + 'seen')
		const publicPaths = paths(nav.publicNavItems());
		expect(publicPaths).toContain('/seen');
		expect(publicPaths.filter((path) => path !== '/seen')).toEqual(fixedPublic);
		expect(paths(nav.navSections({ publicViewer: true, role: 'viewer' }).main)).toEqual(
			publicPaths
		);
	});

	it('works with no resources (display preset): fixed pages only', async () => {
		const nav = await load([]);
		const paths = nav.navItems.map((item) => item.path);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths).toContain('/settings');
		expect(nav.navItems.every((item) => item.labelKey !== undefined)).toBe(true);
		expect(nav.pageTitle('/nowhere')).toBe('Banto');
	});

	it('derives the create / edit page titles from the resource path', async () => {
		const nav = await load([def('parts', { icon: Icon })]);
		expect(nav.pageTitle('/parts', '/(app)/parts' as RouteId)).toBe('parts label');
		expect(nav.pageTitle('/parts/new', '/(app)/parts/new' as RouteId)).toBe(
			m['resource.createTitle']({ resource: 'parts label' })
		);
		expect(nav.pageTitle('/parts/7', '/(app)/parts/[id]' as RouteId)).toBe(
			m['resource.editTitle']({ resource: 'parts label' })
		);
	});
});
