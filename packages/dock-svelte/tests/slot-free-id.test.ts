// A split / tab group made again by `core/slot.ts` takes the id its slot names when that id is
// free. Free of the whole layout - the regions in the edge bands and the floating windows too -,
// not only of the docked tree (#782 PR6; the same rule as `DockState.shownTree`'s `taken`): a
// layout that holds an id twice is refused by `validateDockLayout`, so it could not be loaded again.
import { describe, expect, it } from 'vitest';
import { captureDockSlot, restoreDockSlot } from '../src/core/slot';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import type { DockLayout, DockNode, DockPanelNode } from '../src/types';
import { counterMakeId } from './fixtures/dock-properties';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });

/** Every id of the layout: docked nodes, band regions with their panes, floating windows. */
function allIds(layout: DockLayout): string[] {
	const out: string[] = [];
	const walk = (node: DockNode | null): void => {
		if (node === null) return;
		out.push(node.id);
		if (node.type !== 'panel') node.children.forEach(walk);
	};
	walk(layout.docked);
	for (const entry of layout.autoHidden ?? []) walk(entry.node);
	for (const win of layout.floating) out.push(win.id);
	return out;
}

const twice = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);

/** `row[x, tabs(t1)[b, c, d, e]]`. */
const tree = (): DockNode => ({
	type: 'split',
	id: 's1',
	direction: 'row',
	sizes: [0.5, 0.5],
	children: [
		panel('x'),
		{ type: 'tabs', id: 't1', activeIndex: 0, children: ['b', 'c', 'd', 'e'].map(panel) }
	]
});

describe('an id made again by a slot is free of the whole layout (#782 PR6)', () => {
	it('a tab group in an edge band keeps its id: the group made again around an anchor takes another', () => {
		const dock = createDockState({ version: 2, floating: [], docked: tree() }, counterMakeId());
		// A slot of `b` in the group t1 taken by the caller (`dockAtSlot` with a slot of one's own).
		const slot = captureDockSlot(dock.layout.docked, 'b')!;
		dock.undockPanel('b');
		// `c` leaves the group and stays docked; what is left of the group goes to a band as `t1`.
		dock.dockExistingAtEdge('c', 'left');
		expect(dock.autoHideRegion('d')).toBe(true);
		expect(dock.layout.autoHidden?.[0].node.id).toBe('t1');
		// `b` goes back beside its anchor `c`: the group is made again - not as `t1`.
		expect(dock.dockAtSlot('b', slot)).toBe(true);
		expect(twice(allIds(dock.layout))).toEqual([]);
		expect(validateDockLayout(JSON.parse(dock.serialize())).ok).toBe(true);
	});

	it('restoreDockSlot: an id in `taken` is not used again', () => {
		const root: DockNode = {
			type: 'split',
			id: 's1',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [panel('x'), panel('c')]
		};
		const slot = captureDockSlot(tree(), 'b')!;
		const made = restoreDockSlot(root, panel('b'), slot, () => 'new', [], new Set(['t1']));
		expect(JSON.stringify(made)).not.toContain('"t1"');
		expect(JSON.stringify(made)).toContain('"new"');
		// Without it the slot's own id is taken, as before.
		expect(JSON.stringify(restoreDockSlot(root, panel('b'), slot, () => 'new'))).toContain('"t1"');
	});
});
