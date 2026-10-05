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

import { isPathActive, pageTitle, type AppPath } from './navigation';
import { navBadges } from './navBadges.svelte';
import * as m from '#lib/paraglide/messages.js';

const items = '/items' as AppPath;

describe.each(['', '/banto'])('base=%j', (base) => {
	afterEach(() => {
		state.base = '';
	});
	const at = (p: string) => {
		state.base = base;
		return `${base}${p}`;
	};

	it('isPathActive owns the path and its sub-paths only', () => {
		expect(isPathActive(items, at('/items'))).toBe(true);
		expect(isPathActive(items, at('/items/3'))).toBe(true);
		expect(isPathActive(items, at('/items-other'))).toBe(false);
		expect(isPathActive(items, at('/dashboard'))).toBe(false);
	});

	it('pageTitle resolves the entry title from a base-carrying pathname', () => {
		expect(pageTitle(at('/dashboard'))).toBe(m['nav.dashboard']());
		expect(pageTitle(at('/items/3'))).toBe(m['nav.items']());
		expect(pageTitle(at('/nowhere'))).toBe('Banto');
	});

	it('navBadges counts elsewhere, not on the owning page, and clears on arrival', () => {
		const key = '/nbt-items' as AppPath;
		const off = onInvalidate('nbt-items', (_r, reason) =>
			navBadges.noteInvalidation(key, at('/dashboard'), reason)
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
