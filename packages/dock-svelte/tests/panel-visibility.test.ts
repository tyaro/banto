// The remembered docked place and the View-menu API (#663 ①-A): a docked pane
// that is hidden / closed remembers where it was (`DockState.dismiss`,
// `core/slot.ts`) and `show` puts it back there (tab group / split, with its
// share of the space); when that place is gone it opens floating; the slot
// survives `serialize` / `hydrate` (old JSON without it still loads);
// `panels` lists every pane in a stable order with visible flags.
import { describe, expect, it } from 'vitest';
import { captureDockSlot, restoreDockSlot } from '../src/core/slot';
import { collectPanelIds, findNode } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockNode, DockSplitNode, DockTabGroupNode } from '../src/types';

function counterMakeId(): () => string {
	let n = 0;
	return () => `gen-${n++}`;
}

const panel = (id: string) => ({ type: 'panel' as const, id, title: id.toUpperCase() });
const winOf = (dock: DockState, id: string) => dock.layout.floating.find((w) => w.id === id);

/** split s (row): [tabs t [x, y, z] (0.6), p (0.4)] + floating f */
const tabsLayout = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'f', title: 'F', x: 10, y: 10, width: 300, height: 200, open: true }],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.6, 0.4],
		children: [
			{ type: 'tabs', id: 't', activeIndex: 0, children: [panel('x'), panel('y'), panel('z')] },
			panel('p')
		]
	}
});

const splitOf = (node: DockNode | null): DockSplitNode => {
	if (node?.type !== 'split') throw new Error(`not a split: ${JSON.stringify(node)}`);
	return node;
};

describe('slot memory: tab group', () => {
	it('a hidden tab goes back to its group at the same index, as the active tab', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('y');
		expect(collectPanelIds(dock.layout.docked)).toEqual(['x', 'z', 'p']);
		expect(winOf(dock, 'y')).toMatchObject({
			open: false,
			dockSlot: { kind: 'tab', groupId: 't', index: 1 }
		});

		expect(dock.show('y')).toBe('docked');
		const group = findNode(dock.layout.docked, 't') as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['x', 'y', 'z']);
		expect(group.activeIndex).toBe(1);
		expect(winOf(dock, 'y')).toBeUndefined();
	});

	it('a group that collapsed to one tab is made again around the anchor', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('z');
		dock.dismiss('x'); // t collapses to the bare panel y
		expect(findNode(dock.layout.docked, 't')).toBeNull();

		dock.show('x');
		const group = findNode(dock.layout.docked, 't') as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['x', 'y']);
		expect(group.activeIndex).toBe(0);
		dock.show('z');
		expect(group.id).toBe('t');
		expect(
			(findNode(dock.layout.docked, 't') as DockTabGroupNode).children.map((c) => c.id)
		).toEqual(['x', 'y', 'z']);
	});
});

describe('slot memory: split', () => {
	it('a pane of a 2-way split comes back on the same side with the same share', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('p'); // s collapses to the tab group t
		expect(dock.layout.docked?.id).toBe('t');

		dock.show('p');
		const s = splitOf(dock.layout.docked);
		expect(s).toMatchObject({ id: 's', direction: 'row' });
		expect(s.children.map((c) => c.id)).toEqual(['t', 'p']);
		expect(s.sizes[0]).toBeCloseTo(0.6);
		expect(s.sizes[1]).toBeCloseTo(0.4);
	});

	it('a pane of a 3-way split goes back to its index with its share', () => {
		const dock = createDockState(
			{
				version: 2,
				floating: [],
				docked: {
					type: 'split',
					id: 's',
					direction: 'column',
					sizes: [0.2, 0.3, 0.5],
					children: [panel('a'), panel('b'), panel('c')]
				}
			},
			counterMakeId()
		);
		dock.dismiss('b');
		expect(splitOf(dock.layout.docked).children.map((c) => c.id)).toEqual(['a', 'c']);
		dock.show('b');
		const s = splitOf(dock.layout.docked);
		expect(s.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
		[0.2, 0.3, 0.5].forEach((v, i) => expect(s.sizes[i]).toBeCloseTo(v));
	});

	it('the whole docked tree when it was the only docked pane (and the tree is still empty)', () => {
		const dock = createDockState({ version: 2, floating: [], docked: panel('only') });
		dock.dismiss('only');
		expect(dock.layout.docked).toBeNull();
		expect(winOf(dock, 'only')?.dockSlot).toEqual({ kind: 'root' });
		expect(dock.show('only')).toBe('docked');
		expect(dock.layout.docked).toEqual(panel('only'));
	});
});

describe('slot memory: the place is gone', () => {
	it('opens floating when neither the neighbour nor an anchor is docked any more', () => {
		const dock = createDockState(
			{
				version: 2,
				floating: [{ id: 'f', title: 'F', x: 10, y: 10, width: 300, height: 200, open: true }],
				docked: {
					type: 'split',
					id: 's',
					direction: 'row',
					sizes: [0.5, 0.5],
					children: [panel('l'), panel('r')]
				}
			},
			counterMakeId()
		);
		dock.dismiss('l');
		dock.dockPanel('f', 'r', 'center');
		dock.undockPanel('r'); // the tree is now just f; r floats
		expect(dock.showPlacement('l')).toBe('floating');

		expect(dock.show('l')).toBe('floating');
		expect(winOf(dock, 'l')).toMatchObject({ open: true });
		expect(winOf(dock, 'l')?.dockSlot).toBeUndefined();
		expect(collectPanelIds(dock.layout.docked)).toEqual(['f']);
	});

	it('a root slot opens floating once something else is docked', () => {
		const dock = createDockState({
			version: 2,
			floating: [{ id: 'f', title: 'F', x: 0, y: 0, width: 300, height: 200, open: true }],
			docked: panel('only')
		});
		dock.dismiss('only');
		dock.ensurePanel({ id: 'g', title: 'G' }, 800, 600, 'center', 'any');
		expect(dock.show('only')).toBe('floating');
	});

	it('restoreDockSlot returns null instead of duplicating an id', () => {
		const root = tabsLayout().docked;
		const slot = captureDockSlot(root, 'y')!;
		expect(restoreDockSlot(root, panel('y'), slot, counterMakeId())).toBeNull();
	});
});

describe('open / close keep their floating-only meaning', () => {
	it('open() of a pane hidden from the tree opens it floating and forgets the slot', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('p');
		dock.open('p');
		expect(winOf(dock, 'p')).toMatchObject({ open: true });
		expect(winOf(dock, 'p')?.dockSlot).toBeUndefined();
		dock.close('p');
		expect(dock.show('p')).toBe('floating');
	});

	it('isOpen stays floating-only; isVisible counts docked panes', () => {
		const dock = createDockState(tabsLayout());
		expect(dock.isOpen('x')).toBe(false);
		expect(dock.isVisible('x')).toBe(true);
		expect(dock.isVisible('f')).toBe(true);
		dock.dismiss('x');
		expect(dock.isVisible('x')).toBe(false);
	});

	it('ensureWindow does not add a floating copy of a docked id', () => {
		const dock = createDockState(tabsLayout());
		dock.ensureWindow({ id: 'x', title: 'X' }, 800, 600);
		expect(winOf(dock, 'x')).toBeUndefined();
	});

	it('show() of a docked background tab activates it; unknown ids are null', () => {
		const dock = createDockState(tabsLayout());
		expect(dock.show('z')).toBe('docked');
		expect((findNode(dock.layout.docked, 't') as DockTabGroupNode).activeIndex).toBe(2);
		expect(dock.show('nope')).toBeNull();
	});
});

describe('serialize / hydrate', () => {
	it('the remembered place survives a round trip', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('p');
		const json = dock.serialize();
		expect(JSON.parse(json).version).toBe(2);

		const restored = createDockState(json, counterMakeId());
		expect(winOf(restored, 'p')?.dockSlot).toEqual(winOf(dock, 'p')?.dockSlot);
		restored.show('p');
		expect(splitOf(restored.layout.docked).children.map((c) => c.id)).toEqual(['t', 'p']);
	});

	it('old JSON (v1, and v2 without dockSlot) still loads; a closed window there opens floating', () => {
		const v1 = JSON.stringify({
			version: 1,
			floating: [{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: false }]
		});
		const dock = createDockState();
		expect(dock.hydrate(v1)).toBe(true);
		expect(dock.show('a')).toBe('floating');

		const v2 = JSON.stringify({ ...tabsLayout(), floating: [] });
		expect(dock.hydrate(v2)).toBe(true);
		expect(dock.panels.map((r) => r.id)).toEqual(['x', 'y', 'z', 'p']);
	});

	it('a malformed dockSlot rejects the payload as a whole', () => {
		const bad = {
			...tabsLayout(),
			floating: [
				{
					id: 'q',
					title: 'Q',
					x: 0,
					y: 0,
					width: 300,
					height: 200,
					open: false,
					dockSlot: { kind: 'split', splitId: 's' }
				}
			]
		};
		const result = validateDockLayout(bad);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual({ code: 'shape', path: 'floating[0].dockSlot' });
	});
});

describe('panels', () => {
	it('lists every pane in first-seen order with visible / placement', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		expect(dock.panels).toEqual([
			{ id: 'x', title: 'X', icon: undefined, placement: 'docked', visible: true },
			{ id: 'y', title: 'Y', icon: undefined, placement: 'docked', visible: true },
			{ id: 'z', title: 'Z', icon: undefined, placement: 'docked', visible: true },
			{ id: 'p', title: 'P', icon: undefined, placement: 'docked', visible: true },
			{ id: 'f', title: 'F', icon: undefined, placement: 'floating', visible: true }
		]);

		dock.dismiss('y');
		dock.close('f');
		dock.focus('f');
		const rows = dock.panels;
		expect(rows.map((r) => r.id)).toEqual(['x', 'y', 'z', 'p', 'f']);
		expect(rows.find((r) => r.id === 'y')).toMatchObject({ placement: 'docked', visible: false });
		expect(rows.find((r) => r.id === 'f')).toMatchObject({ placement: 'floating', visible: false });

		dock.ensureWindow({ id: 'n', title: 'N' }, 800, 600);
		expect(dock.panels.map((r) => r.id)).toEqual(['x', 'y', 'z', 'p', 'f', 'n']);
	});
});
