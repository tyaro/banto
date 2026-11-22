// @vitest-environment jsdom
/**
 * createShellDrawer (#850): open / toggle / close, and closing once the
 * caller's `isDrawer()` turns false (the `applyNarrowChange` case of the
 * downstream `mobileNav.test.ts`, generalised: any reason the drawer is gone).
 */
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellDrawer, resolveShellNav, type ShellNavLayout } from '../src/index';

let teardown: (() => void) | undefined;
afterEach(() => {
	teardown?.();
	teardown = undefined;
});

/** Run `body` in an effect root (the state registers an effect, so it needs one). */
function inRoot<T>(body: () => T): T {
	let result!: T;
	teardown = $effect.root(() => {
		result = body();
	});
	flushSync();
	return result;
}

describe('createShellDrawer', () => {
	it('starts closed; toggle opens and closes; close is idempotent', () => {
		const drawer = inRoot(() => createShellDrawer({ isDrawer: () => true }));
		expect(drawer.open).toBe(false);
		drawer.toggle();
		expect(drawer.open).toBe(true);
		drawer.toggle();
		expect(drawer.open).toBe(false);
		drawer.toggle();
		drawer.close();
		drawer.close();
		expect(drawer.open).toBe(false);
	});

	it('does not open while it is not a drawer', () => {
		const drawer = inRoot(() => createShellDrawer({ isDrawer: () => false }));
		drawer.toggle();
		expect(drawer.open).toBe(false);
	});

	it('closes when it stops being a drawer, and stays closed when it comes back', () => {
		const s = $state({ isDrawer: true });
		const drawer = inRoot(() => createShellDrawer({ isDrawer: () => s.isDrawer }));
		drawer.toggle();
		expect(drawer.open).toBe(true);
		s.isDrawer = false;
		flushSync();
		expect(drawer.open).toBe(false);
		s.isDrawer = true;
		flushSync();
		expect(drawer.open).toBe(false);
	});

	it('stays open while it remains a drawer', () => {
		const s = $state({ tick: 0 });
		const drawer = inRoot(() =>
			createShellDrawer({
				isDrawer: () => {
					void s.tick;
					return true;
				}
			})
		);
		drawer.toggle();
		s.tick++;
		flushSync();
		expect(drawer.open).toBe(true);
	});
});

describe('createShellDrawer with resolveShellNav', () => {
	function shell(layout: ShellNavLayout, narrowSidebar?: 'drawer' | 'column') {
		const s = $state({ narrow: true, insufficient: false });
		const drawer = inRoot(() =>
			createShellDrawer({
				isDrawer: () =>
					resolveShellNav(layout, s.narrow, s.insufficient, { narrowSidebar }).drawerMode
			})
		);
		return { s, drawer };
	}

	it("banto-hub's shape: a narrow sidebar is a drawer; widening closes it", () => {
		const { s, drawer } = shell('sidebar', 'drawer');
		drawer.toggle();
		expect(drawer.open).toBe(true);
		s.narrow = false;
		flushSync();
		expect(drawer.open).toBe(false);
	});

	it("ChronoGazer's shape: a narrow sidebar is a column, so there is no drawer to open", () => {
		const { drawer } = shell('sidebar', 'column');
		drawer.toggle();
		expect(drawer.open).toBe(false);
	});

	it("ChronoGazer's shape: the menu bar's stand-in is a drawer", () => {
		const { s, drawer } = shell('menubar', 'column');
		drawer.toggle();
		expect(drawer.open).toBe(true);
		s.narrow = false;
		flushSync();
		expect(drawer.open).toBe(false);
		s.insufficient = true;
		flushSync();
		drawer.toggle();
		expect(drawer.open).toBe(true);
		// The room came back and the bar measured again: back to the bar, drawer gone.
		s.insufficient = false;
		flushSync();
		expect(drawer.open).toBe(false);
	});

	it('the dock layout: switching to it closes an open drawer and there is nothing to open', () => {
		const s = $state<{ layout: ShellNavLayout }>({ layout: 'sidebar' });
		const drawer = inRoot(() =>
			createShellDrawer({ isDrawer: () => resolveShellNav(s.layout, true, false).drawerMode })
		);
		drawer.toggle();
		expect(drawer.open).toBe(true);
		s.layout = 'launcher';
		flushSync();
		expect(drawer.open).toBe(false);
		drawer.toggle();
		expect(drawer.open).toBe(false);
	});
});
