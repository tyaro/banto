// Which docked panes a structure change pushes out (#666, `core/mounts.ts`):
// the mount key follows how `DockedTree` draws the tree (root by type, each
// child by type + id, a tab only while active or keepMounted).
import { describe, expect, it } from 'vitest';
import { displacedChanges, mountedPanes } from '../src/core/mounts';
import type { DockNode } from '../src/types';

const panel = (id: string) => ({ type: 'panel' as const, id, title: id });
const split = (id: string, children: DockNode[]): DockNode => ({
	type: 'split',
	id,
	direction: 'row',
	sizes: children.map(() => 1 / children.length),
	children
});
const tabs = (id: string, ids: string[], activeIndex = 0): DockNode => ({
	type: 'tabs',
	id,
	activeIndex,
	children: ids.map(panel)
});
const never = () => false;

describe('mountedPanes', () => {
	it('lists the shown panes and keepMounted background tabs only', () => {
		const tree = split('s', [tabs('t', ['x', 'y', 'z']), panel('p')]);
		expect([...mountedPanes(tree, (id) => id === 'z').entries()]).toEqual([
			['x', { key: 'split/tabs:t/tab:x', shown: true }],
			['z', { key: 'split/tabs:t/tab:z', shown: false }],
			['p', { key: 'split/panel:p', shown: true }]
		]);
	});
});

describe('displacedChanges', () => {
	it('a root split replaced by another split keeps its children (the root is drawn by type)', () => {
		const before = split('s1', [panel('a'), panel('b')]);
		const after = split('s2', [panel('b'), panel('c')]);
		expect(displacedChanges(before, after, 'a', never)).toEqual([]);
	});

	it('a bare pane wrapped into a split is re-mounted: reparent', () => {
		const after = split('n', [panel('a'), panel('b')]);
		expect(displacedChanges(panel('a'), after, 'b', never)).toEqual([
			{ kind: 'reparent', panelId: 'a', cause: 'b', remount: true }
		]);
	});

	it('a group wrapped into a split: its active tab and its keepMounted tabs', () => {
		const before = tabs('t', ['x', 'y', 'z']);
		const after = split('n', [tabs('t', ['x', 'y', 'z']), panel('b')]);
		expect(displacedChanges(before, after, 'b', (id) => id === 'y')).toEqual([
			{ kind: 'reparent', panelId: 'x', cause: 'b', remount: true },
			{ kind: 'reparent', panelId: 'y', cause: 'b', remount: true }
		]);
	});

	it('a new active tab: tab-switch from the old one (kept when keepMounted)', () => {
		const before = tabs('t', ['x', 'y']);
		const after = tabs('t', ['x', 'y', 'f'], 2);
		expect(displacedChanges(before, after, 'f', never)).toEqual([
			{ kind: 'tab-switch', groupId: 't', from: 'x', to: 'f', remount: true }
		]);
		expect(displacedChanges(before, after, 'f', () => true)).toEqual([
			{ kind: 'tab-switch', groupId: 't', from: 'x', to: 'f', remount: false }
		]);
	});

	it('a bare pane made a background tab of a new group: tab-switch, always re-mounted', () => {
		const after = tabs('g', ['a', 'f'], 1);
		expect(displacedChanges(panel('a'), after, 'f', () => true)).toEqual([
			{ kind: 'tab-switch', groupId: 'g', from: 'a', to: 'f', remount: true }
		]);
	});

	it('the moved pane itself is not listed; a split it leaves collapses and re-mounts the other', () => {
		const before = split('s', [panel('a'), panel('b')]);
		expect(displacedChanges(before, panel('b'), 'a', never)).toEqual([
			{ kind: 'reparent', panelId: 'b', cause: 'a', remount: true }
		]);
		const kept = split('s', [panel('a'), panel('b'), panel('c')]);
		expect(displacedChanges(kept, split('s', [panel('b'), panel('c')]), 'a', never)).toEqual([]);
	});

	it('a persistent pane (#663 ④) is moved, not re-mounted: no reparent, a tab-switch kept', () => {
		const before = split('s', [panel('a'), panel('b')]);
		const always = () => true;
		expect(displacedChanges(before, panel('b'), 'a', always, always)).toEqual([]);
		const after = tabs('g', ['b', 'f'], 1);
		expect(displacedChanges(panel('b'), after, 'f', always, always)).toEqual([
			{ kind: 'tab-switch', groupId: 'g', from: 'b', to: 'f', remount: false }
		]);
	});
});
