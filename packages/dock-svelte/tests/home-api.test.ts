// `hasHome` / `dockBack` / `backTree` / `homeMark` (#782 PR8a, PR8c): the ways to go "back", by
// the pane's id alone - the place is the pane's tombstone in the shadow tree.
import { describe, expect, it } from 'vitest';
import { createDockState, homeMark, type DockState } from '../src/state.svelte';
import type { DockNode, DockPanelNode } from '../src/types';
import { counterMakeId } from './fixtures/dock-properties';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });

const row = (): DockNode => ({
	type: 'split',
	id: 's',
	direction: 'row',
	sizes: [0.2, 0.3, 0.5],
	children: ['a', 'b', 'c'].map(panel)
});

const dockOf = (docked: DockNode): DockState =>
	createDockState({ version: 4, floating: [], docked }, counterMakeId());

describe('hasHome / dockBack / backTree / homeMark', () => {
	it('a pane that never left the tree has no home: false / null / undefined', () => {
		const dock = dockOf(row());
		expect(dock.hasHome('a')).toBe(false);
		expect(dock.backTree('a')).toBeNull();
		expect(dock.dockBack('a')).toBe(false);
		expect(homeMark(dock, 'a')).toBeUndefined();
	});

	it('an unknown id is the same', () => {
		const dock = dockOf(row());
		expect(dock.hasHome('nope')).toBe(false);
		expect(dock.backTree('nope')).toBeNull();
		expect(dock.dockBack('nope')).toBe(false);
		expect(homeMark(dock, 'nope')).toBeUndefined();
	});

	it('a floated pane: backTree gives the tree it goes back to, and dockBack docks it there', () => {
		const dock = dockOf(row());
		dock.undockPanel('b');
		expect(dock.hasHome('b')).toBe(true);
		expect(homeMark(dock, 'b')).toBeDefined();
		const viaId = dock.backTree('b', () => 'x');
		expect(viaId).toEqual(row());
		// Pure: the layout does not change.
		const before = dock.layout;
		dock.backTree('b');
		expect(dock.layout).toBe(before);
		expect(dock.dockBack('b', () => 'x')).toBe(true);
		expect(dock.layout.docked).toEqual(viaId);
		expect(dock.hasHome('b')).toBe(false);
		expect(homeMark(dock, 'b')).toBeUndefined();
	});

	it('a closed floating window: backTree answers, dockBack does not dock it', () => {
		const dock = dockOf(row());
		dock.undockPanel('b');
		dock.close('b');
		expect(dock.backTree('b')).not.toBeNull();
		expect(dock.dockBack('b')).toBe(false);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['b']);
	});

	it('homeMark is another object once the pane is docked and floated again', () => {
		const dock = dockOf(row());
		dock.undockPanel('b');
		const first = homeMark(dock, 'b');
		expect(first).toBeDefined();
		expect(homeMark(dock, 'b')).toBe(first);
		expect(dock.dockBack('b')).toBe(true);
		dock.undockPanel('b');
		expect(homeMark(dock, 'b')).not.toBe(first);
	});
});
