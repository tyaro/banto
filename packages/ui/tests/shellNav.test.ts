/**
 * resolveShellNav (#850). The cases the two downstream copies' `mobileNav.test.ts`
 * pin (banto-hub: a narrow sidebar is a drawer; ChronoGazer: a narrow sidebar stays
 * a column and only the menu bar's stand-in is a drawer), through one entry point.
 */
import { describe, expect, it } from 'vitest';
import { resolveShellNav, type ShellNavView } from '../src/index';

const view = (v: Partial<ShellNavView>): ShellNavView => ({
	showBar: false,
	showSidebar: false,
	drawerMode: false,
	showDrawerButton: false,
	...v
});

describe('resolveShellNav: menu bar layout', () => {
	it('above 900px: the bar only, no sidebar', () => {
		expect(resolveShellNav('menubar', false, false)).toEqual(view({ showBar: true }));
	});

	it('at <=900px: no bar, the sidebar is the drawer', () => {
		expect(resolveShellNav('menubar', true, false)).toEqual(
			view({ showSidebar: true, drawerMode: true, showDrawerButton: true })
		);
	});

	it('above 900px but the bar does not fit: the drawer stands in, the bar stays mounted', () => {
		expect(resolveShellNav('menubar', false, true)).toEqual(
			view({ showBar: true, showSidebar: true, drawerMode: true, showDrawerButton: true })
		);
	});

	it('the room comes back (flag re-measured to false): back to the bar', () => {
		expect(resolveShellNav('menubar', false, true).showSidebar).toBe(true);
		expect(resolveShellNav('menubar', false, false)).toEqual(view({ showBar: true }));
	});

	it('the flag is ignored at <=900px', () => {
		expect(resolveShellNav('menubar', true, true)).toEqual(resolveShellNav('menubar', true, false));
	});

	it('narrowSidebar does not change the menu bar layout', () => {
		for (const narrowSidebar of ['drawer', 'column'] as const) {
			for (const [narrow, insufficient] of [
				[false, false],
				[true, false],
				[false, true]
			] as const) {
				expect(resolveShellNav('menubar', narrow, insufficient, { narrowSidebar })).toEqual(
					resolveShellNav('menubar', narrow, insufficient)
				);
			}
		}
	});
});

describe('resolveShellNav: sidebar layout', () => {
	it("banto-hub / template ('drawer', the default): drawer at <=900px, column above", () => {
		const column = view({ showSidebar: true });
		const drawer = view({ showSidebar: true, drawerMode: true, showDrawerButton: true });
		expect(resolveShellNav('sidebar', false, false)).toEqual(column);
		expect(resolveShellNav('sidebar', true, false)).toEqual(drawer);
		expect(resolveShellNav('sidebar', true, false, { narrowSidebar: 'drawer' })).toEqual(drawer);
	});

	it("ChronoGazer ('column'): a column at any width, never a drawer", () => {
		for (const narrow of [false, true]) {
			expect(resolveShellNav('sidebar', narrow, false, { narrowSidebar: 'column' })).toEqual(
				view({ showSidebar: true })
			);
		}
	});

	it('the insufficient flag only counts for the menu bar', () => {
		expect(resolveShellNav('sidebar', false, true)).toEqual(view({ showSidebar: true }));
	});
});

describe('resolveShellNav: launcher layout', () => {
	it('no sidebar, no bar and no toggle at any width or flag', () => {
		for (const narrowSidebar of ['drawer', 'column'] as const) {
			for (const narrow of [false, true]) {
				for (const insufficient of [false, true]) {
					expect(resolveShellNav('launcher', narrow, insufficient, { narrowSidebar })).toEqual(
						view({})
					);
				}
			}
		}
	});
});
