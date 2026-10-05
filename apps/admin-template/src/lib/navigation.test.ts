/**
 * #332: under a non-empty `BASE_PATH` (the GitHub Pages demo) `page.url.pathname`
 * carries the base while the nav tables hold base-less paths. `isPathActive` /
 * `pageTitle` / `navBadges` must still match. `$app/paths`' `resolve` is mocked
 * to prepend a configurable base (SvelteKit 3: `resolve('items')` -> `base/items`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidate, onInvalidate } from '@banto/admin-core';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => ({
	resolve: (path: string) => `${state.base}/${path}`
}));

import { isPathActive, navItems, pageTitle, type AppPath } from './navigation';
import { navBadges } from './navBadges.svelte';
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
		expect(pageTitle(at(first.path))).toBe(m[first.labelKey]());
		expect(pageTitle(at(`${first.path}/3`))).toBe(m[first.labelKey]());
		expect(pageTitle(at('/nowhere'))).toBe('Banto');
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
