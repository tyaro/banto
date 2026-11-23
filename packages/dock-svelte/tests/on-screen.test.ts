// `DockState.isOnScreen` / `panels[].onScreen` (#792): really on screen, unlike `isVisible`
// ("not closed"). Five false cases and three true cases, plus the flyout closing.
import { describe, expect, it } from 'vitest';
import { createDockState } from '../src/state.svelte';
import type { DockAutoHidden, DockLayout, FloatingWindow } from '../src/types';

const win = (id: string, extra: Partial<FloatingWindow> = {}): FloatingWindow => ({
	id,
	title: id,
	x: 0,
	y: 0,
	width: 200,
	height: 100,
	open: true,
	...extra
});

const hidden = (id: string): DockAutoHidden => ({
	node: { type: 'panel', id, title: id },
	edge: 'left'
});

function make() {
	const dock = createDockState();
	dock.layout = {
		version: 4,
		floating: [win('fo'), win('fc', { collapsed: true }), win('fx', { open: false })],
		docked: {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.3, 0.4, 0.3],
			children: [
				{ type: 'panel', id: 'cp', title: 'cp', collapsed: true },
				{
					type: 'tabs',
					id: 'g',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: 'front', title: 'front' },
						{ type: 'panel', id: 'back', title: 'back' }
					]
				},
				{
					type: 'tabs',
					id: 'cg',
					activeIndex: 0,
					collapsed: true,
					children: [
						{ type: 'panel', id: 'cgf', title: 'cgf' },
						{ type: 'panel', id: 'cgb', title: 'cgb' }
					]
				}
			]
		},
		autoHidden: [hidden('ah')]
	} as DockLayout;
	return dock;
}

describe('DockState.isOnScreen', () => {
	it('is false for a collapsed region, a back tab, a hidden band pane, a collapsed or closed window', () => {
		const dock = make();
		for (const id of ['cp', 'cgf', 'back', 'ah', 'fc', 'fx', 'nope']) {
			expect(dock.isOnScreen(id), id).toBe(false);
		}
		expect(dock.isVisible('back')).toBe(true);
		expect(dock.isVisible('ah')).toBe(true);
	});

	it('is true for the front tab, an open floating window and the slid-out pane', () => {
		const dock = make();
		expect(dock.isOnScreen('front')).toBe(true);
		expect(dock.isOnScreen('fo')).toBe(true);
		dock.openFlyout('ah');
		expect(dock.flyoutPanel).toBe('ah');
		expect(dock.isOnScreen('ah')).toBe(true);
	});

	it('goes back to false when the flyout closes, and follows panels[].onScreen', () => {
		const dock = make();
		dock.openFlyout('ah');
		const row = (id: string) => dock.panels.find((p) => p.id === id)?.onScreen;
		expect(row('ah')).toBe(true);
		expect(row('front')).toBe(true);
		expect(row('back')).toBe(false);
		dock.closeFlyout();
		expect(dock.isOnScreen('ah')).toBe(false);
		expect(row('ah')).toBe(false);
		expect(row('fc')).toBe(false);
	});
});
