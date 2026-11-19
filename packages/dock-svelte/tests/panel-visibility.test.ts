// The remembered docked place and the View-menu API (#663 ①-A): a docked pane
// that is hidden / closed remembers where it was (`DockState.dismiss`,
// `core/slot.ts`) and `show` puts it back there (tab group / split, with its
// share of the space); when that place is gone it opens floating; the slot
// survives `serialize` / `hydrate` (old JSON without it still loads);
// `panels` lists every pane in a stable order with visible flags.
import { describe, expect, it, vi } from 'vitest';
import { PanelLifecycle, type DockPanelChange } from '../src/core/lifecycle';
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

// The order next to the anchors is kept, not the absolute index (#665 review):
// a group that lost other tabs meanwhile (or collapsed to one pane) must not
// flip the restored tab to the other side of its neighbour.
describe('slot memory: tab order relative to the anchors', () => {
	/** The tabs (everything docked but `p`, in order); every case keeps them in one group. */
	const order = (dock: DockState): string[] =>
		collectPanelIds(dock.layout.docked).filter((id) => id !== 'p');

	it('[x, y, z]: hide y, hide x (lone z), show y = [y, z] (y was before z)', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('y');
		dock.dismiss('x');
		dock.show('y');
		expect(order(dock)).toEqual(['y', 'z']);
		dock.show('x');
		expect(order(dock)).toEqual(['x', 'y', 'z']);
	});

	it('mirrored: hide y, hide z (lone x), show y = [x, y] (y was after x)', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('y');
		dock.dismiss('z');
		dock.show('y');
		expect(order(dock)).toEqual(['x', 'y']);
		dock.show('z');
		expect(order(dock)).toEqual(['x', 'y', 'z']);
	});

	it('an existing group that lost the tabs before the pane keeps it after its anchor', () => {
		// [x, y, z, w]: hide z (index 2), hide x, show z -> [y, z, w], not [y, w, z].
		const layout = tabsLayout();
		const t = splitOf(layout.docked).children[0] as DockTabGroupNode;
		t.children.push(panel('w'));
		const dock = createDockState(layout, counterMakeId());
		dock.dismiss('z');
		dock.dismiss('x');
		dock.show('z');
		expect(order(dock)).toEqual(['y', 'z', 'w']);
	});

	const four = (): DockState => {
		const layout = tabsLayout();
		const t = splitOf(layout.docked).children[0] as DockTabGroupNode;
		t.children.push(panel('w'));
		return createDockState(layout, counterMakeId());
	};
	// Every order of hiding two / three tabs of [x, y, z, w] and showing them again.
	const permutations = (ids: string[]): string[][] =>
		ids.length <= 1
			? [ids]
			: ids.flatMap((id, i) =>
					permutations([...ids.slice(0, i), ...ids.slice(i + 1)]).map((rest) => [id, ...rest])
				);
	for (const hidden of [
		['x', 'y'],
		['y', 'z'],
		['x', 'w'],
		['x', 'y', 'z'],
		['y', 'z', 'w'],
		['x', 'z', 'w']
	]) {
		for (const hideOrder of permutations(hidden)) {
			for (const showOrder of permutations(hidden)) {
				it(`hide ${hideOrder.join(',')} then show ${showOrder.join(',')} = [x, y, z, w]`, () => {
					const dock = four();
					for (const id of hideOrder) dock.dismiss(id);
					for (const id of showOrder) dock.show(id);
					expect(order(dock)).toEqual(['x', 'y', 'z', 'w']);
				});
			}
		}
	}

	it('a slot saved without the relative order (any old JSON) still restores at a sensible place', () => {
		const dock = createDockState(
			{
				version: 2,
				floating: [
					{
						id: 'q',
						title: 'Q',
						x: 0,
						y: 0,
						width: 100,
						height: 100,
						open: false,
						dockSlot: { kind: 'tab', groupId: 't', index: 9, anchors: [] }
					}
				],
				docked: tabsLayout().docked
			},
			counterMakeId()
		);
		dock.show('q');
		expect(order(dock)).toEqual(['x', 'y', 'z', 'q']);
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

	it('a split slot keeps `otherAnchors` through a round trip; a malformed one is rejected (#720 review)', () => {
		const dock = createDockState(
			{
				version: 2,
				floating: [],
				docked: {
					type: 'split',
					id: 's',
					direction: 'row',
					sizes: [0.3, 0.3, 0.4],
					children: [panel('a'), panel('b'), panel('c')]
				}
			},
			counterMakeId()
		);
		dock.dismiss('b');
		const slot = winOf(dock, 'b')?.dockSlot;
		expect(slot).toMatchObject({ kind: 'split', anchors: ['c'], otherAnchors: ['a'] });
		const restored = createDockState(dock.serialize(), counterMakeId());
		expect(winOf(restored, 'b')?.dockSlot).toEqual(slot);
		const bad = JSON.parse(dock.serialize());
		bad.floating[0].dockSlot.otherAnchors = [1];
		expect(validateDockLayout(bad).ok).toBe(false);
	});

	it('`outer` (#721) survives a round trip; a tab outer, a bad outer or one nested too deep is rejected', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('x');
		const slot = winOf(dock, 'x')?.dockSlot;
		expect(slot).toMatchObject({
			kind: 'tab',
			groupId: 't',
			outer: { kind: 'split', splitId: 's', neighborId: 'p', side: 'before' }
		});
		const restored = createDockState(dock.serialize(), counterMakeId());
		expect(winOf(restored, 'x')?.dockSlot).toEqual(slot);
		const withOuter = (outer: unknown) => {
			const raw = JSON.parse(dock.serialize());
			raw.floating.find((w: { id: string }) => w.id === 'x').dockSlot.outer = outer;
			return validateDockLayout(raw).ok;
		};
		expect(withOuter({ kind: 'root' })).toBe(true);
		expect(withOuter({ kind: 'tab', groupId: 'g', index: 0, anchors: [] })).toBe(false);
		expect(withOuter({ kind: 'split', splitId: 's' })).toBe(false);
		expect(withOuter('root')).toBe(false);
		// Nesting is headroom for later (one level is written today), but bounded.
		let deep: Record<string, unknown> = { kind: 'root' };
		for (let i = 0; i < 8; i++) deep = { ...(slot?.kind === 'tab' ? slot.outer : {}), outer: deep };
		expect(withOuter(deep)).toBe(false);
	});

	it('the last tab of a group remembers the group, not the bare place it had (#721)', () => {
		const dock = createDockState(tabsLayout(), counterMakeId());
		dock.dismiss('x');
		dock.dismiss('y');
		dock.dismiss('z');
		expect(winOf(dock, 'z')?.dockSlot).toMatchObject({
			kind: 'tab',
			groupId: 't',
			index: 2,
			anchors: ['y', 'x'],
			outer: { kind: 'split', splitId: 's', neighborId: 'p' }
		});
		// x first: neither the group nor an anchor is docked, so x takes the group's place next to p.
		expect(dock.show('x')).toBe('docked');
		expect(dock.show('z')).toBe('docked');
		expect(dock.show('y')).toBe('docked');
		const s = splitOf(dock.layout.docked);
		expect(s.children.map((c) => c.type)).toEqual(['tabs', 'panel']);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['x', 'y', 'z', 'p']);
	});

	it('a hidden pane that is docked again (a stale entry) does not make a last pane of it (#721)', () => {
		const root: DockNode = {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [panel('a'), panel('b')]
		};
		const stale = {
			id: 'a',
			slot: { kind: 'tab' as const, groupId: 'gone', index: 0, anchors: ['b'] }
		};
		expect(captureDockSlot(root, 'b', [stale])).toMatchObject({ kind: 'split', splitId: 's' });
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

// PR #665 review (Codex P1): putting a hidden pane back as the ACTIVE tab of a
// group takes the group's active pane off the screen (unmounted unless
// keepMounted), so it is asked like a tab click (`tab-switch`, IME hold).
describe('show() into a tab group is asked as a tab-switch from the active pane', () => {
	function setup(options: {
		hook?: (change: DockPanelChange) => boolean | Promise<boolean>;
		keepMounted?: (id: string) => boolean;
		deferred?: () => boolean;
	}) {
		const dock = createDockState(tabsLayout(), counterMakeId());
		const lifecycle = new PanelLifecycle(dock, () => ({
			beforePanelChange: options.hook,
			keepMounted: options.keepMounted,
			isStructureChangeDeferred: options.deferred ?? (() => false)
		}));
		return { dock, lifecycle };
	}
	const groupT = (dock: DockState) => findNode(dock.layout.docked, 't') as DockTabGroupNode;
	const activeOf = (dock: DockState) => groupT(dock).children[groupT(dock).activeIndex].id;

	it('a veto from the active (not keepMounted) pane keeps the pane hidden and changes nothing', async () => {
		const hook = vi.fn((change: DockPanelChange) => change.kind !== 'tab-switch');
		const { dock, lifecycle } = setup({ hook });
		dock.dismiss('y');
		const before = JSON.stringify(dock.layout);

		expect(await lifecycle.show('y')).toBe('refused');
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith({
			kind: 'tab-switch',
			groupId: 't',
			from: 'x',
			to: 'y',
			remount: true
		});
		expect(JSON.stringify(dock.layout)).toBe(before);
		expect(dock.isVisible('y')).toBe(false);
	});

	it('allowed: restored in its old place as the active tab; keepMounted from = remount false', async () => {
		const hook = vi.fn(() => true);
		const { dock, lifecycle } = setup({ hook, keepMounted: (id) => id === 'x' });
		dock.dismiss('y');

		expect(await lifecycle.show('y')).toBe('applied');
		expect(hook).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'tab-switch', from: 'x', to: 'y', remount: false })
		);
		expect(groupT(dock).children.map((c) => c.id)).toEqual(['x', 'y', 'z']);
		expect(activeOf(dock)).toBe('y');
	});

	it('a bare anchor made into a group again is asked too (re-mounted: remount true)', async () => {
		const hook = vi.fn(() => false);
		const { dock, lifecycle } = setup({ hook, keepMounted: () => true });
		dock.dismiss('z');
		dock.dismiss('x'); // t collapses to the bare panel y
		lifecycle.discarded.add('x'); // closed, not hidden: nothing of x is mounted

		expect(await lifecycle.show('x')).toBe('refused');
		expect(hook).toHaveBeenCalledWith({
			kind: 'tab-switch',
			groupId: 't',
			from: 'y',
			to: 'x',
			remount: true
		});
		expect(findNode(dock.layout.docked, 't')).toBeNull();
		expect(dock.isVisible('x')).toBe(false);
	});

	it('held while an IME composition is open, asked and applied after it ends', async () => {
		let composing = true;
		const hook = vi.fn(() => true);
		const { dock, lifecycle } = setup({ hook, deferred: () => composing });
		dock.dismiss('y');

		const pending = lifecycle.show('y');
		expect(hook).not.toHaveBeenCalled();
		expect(dock.isVisible('y')).toBe(false);
		composing = false;
		lifecycle.resumeDeferred();
		expect(await pending).toBe('applied');
		expect(hook).toHaveBeenCalledTimes(1);
		expect(activeOf(dock)).toBe('y');
	});

	it('a keepMounted pane still mounted is asked twice: tab-switch first, then dock', async () => {
		const asked: string[] = [];
		const hook = vi.fn((change: DockPanelChange) => {
			asked.push(change.kind);
			return true;
		});
		const { dock, lifecycle } = setup({ hook, keepMounted: () => true });
		dock.dismiss('y');

		expect(await lifecycle.show('y')).toBe('applied');
		expect(asked).toEqual(['tab-switch', 'dock']);
		expect(activeOf(dock)).toBe('y');
	});

	// #665 review: the two answers of a retained pane are one decision - a tab
	// change between them must not apply the dock over a pane never asked. The
	// dock request is made right after the tab-switch approval, on the structure
	// it was approved on (#666), so synchronous answers leave no gap at all.
	it('retained: synchronous answers apply at once, with no gap between the two', () => {
		const asked: string[] = [];
		const hook = vi.fn((change: DockPanelChange) => {
			asked.push(
				change.kind === 'tab-switch' ? `tab-switch ${change.from}>${change.to}` : change.kind
			);
			return true;
		});
		const { dock, lifecycle } = setup({ hook, keepMounted: () => true });
		dock.dismiss('y'); // t = [x, z], x active

		void lifecycle.show('y');
		expect(asked).toEqual(['tab-switch x>y', 'dock']);
		expect(activeOf(dock)).toBe('y');
	});

	it('retained: a tab change while the dock answer is pending makes it stale too', async () => {
		let answer: (ok: boolean) => void = () => {};
		const hook = vi.fn((change: DockPanelChange) =>
			change.kind === 'dock' ? new Promise<boolean>((r) => (answer = r)) : true
		);
		const { dock, lifecycle } = setup({ hook, keepMounted: () => true });
		dock.dismiss('y');

		const pending = lifecycle.show('y');
		await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(2));
		dock.setActiveTab('t', 1);
		answer(true);
		expect(await pending).toBe('stale');
		expect(dock.isVisible('y')).toBe(false);
		expect(activeOf(dock)).toBe('z');
	});

	it('not retained: a tab change while the tab-switch answer is pending makes it stale', async () => {
		let answer: (ok: boolean) => void = () => {};
		const hook = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
		const { dock, lifecycle } = setup({ hook });
		dock.dismiss('y');

		const pending = lifecycle.show('y');
		dock.setActiveTab('t', 1);
		answer(true);
		expect(await pending).toBe('stale');
		expect(hook).toHaveBeenCalledTimes(1);
		expect(dock.isVisible('y')).toBe(false);
		expect(activeOf(dock)).toBe('z');
	});

	// #666: a split re-made around the neighbour re-mounts the neighbour's mounted content.
	it('restoring into a split re-made around the neighbour asks its mounted panes (reparent)', async () => {
		const hook = vi.fn(() => false);
		const { dock, lifecycle } = setup({ hook });
		dock.dismiss('p'); // s collapses: t is the root
		const before = JSON.stringify(dock.layout);

		expect(await lifecycle.show('p')).toBe('refused');
		// x is t's active tab; y and z are not mounted (not keepMounted), so nothing of theirs is lost.
		expect(hook.mock.calls).toEqual([
			[{ kind: 'reparent', panelId: 'x', cause: 'p', remount: true }]
		]);
		expect(JSON.stringify(dock.layout)).toBe(before);

		hook.mockReturnValue(true);
		expect(await lifecycle.show('p')).toBe('applied');
		expect(collectPanelIds(dock.layout.docked)).toEqual(['x', 'y', 'z', 'p']);
	});
});

// #720 review (3 回目の同種の指摘): 同じタブの組・同じ split から何枚隠しても、どの順で
// 戻しても、全部戻せば元の並びになる。途中の並びは問わない。3〜5 枚から 2〜3 枚を選び、
// 隠す順 × 戻す順のすべてを総当たりで確かめる（タブの組と、split の向き両方）。
// 1 枚は残す: 全部を隠すと最後の 1 枚は `root` の slot になり、先に戻すものの手がかりが無い。
/**
 * The tree's shape (#721): kind, direction and child ids - not generated ids of splits / groups,
 * sizes or the active tab. A tab put back as a split's sibling does not match a tab group.
 */
const shapeOf = (node: DockNode | null): unknown =>
	node === null
		? null
		: node.type === 'panel'
			? node.id
			: node.type === 'tabs'
				? { tabs: node.children.map((c) => c.id) }
				: { [node.direction]: node.children.map(shapeOf) };

// #721: up to "every pane of the container" (k = n), with and without a neighbour `p` next to the
// container, and the whole tree's shape compared (not only the order of the panel ids).
describe('slot memory: every hide order x every show order comes back to the old shape', () => {
	const permutations = (ids: string[]): string[][] =>
		ids.length <= 1
			? [ids]
			: ids.flatMap((id, i) =>
					permutations([...ids.slice(0, i), ...ids.slice(i + 1)]).map((rest) => [id, ...rest])
				);
	const subsets = (ids: string[], k: number): string[][] =>
		k === 0
			? [[]]
			: ids.flatMap((id, i) => subsets(ids.slice(i + 1), k - 1).map((rest) => [id, ...rest]));
	const names = ['a', 'b', 'c', 'd', 'e'];
	const even = (ids: string[]) => ids.map(() => 1 / ids.length);
	const split = (direction: 'row' | 'column', ids: string[]): DockNode => ({
		type: 'split',
		id: 's',
		direction,
		sizes: even(ids),
		children: ids.map(panel)
	});
	const tabs = (ids: string[]): DockNode => ({
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: ids.map(panel)
	});
	// The container next to `p` in an outer split of the other direction (a split's child never has its direction).
	const besideP = (inner: DockNode, direction: 'row' | 'column'): DockNode => ({
		type: 'split',
		id: 'o',
		direction,
		sizes: [0.6, 0.4],
		children: [inner, panel('p')]
	});
	const layouts: Record<string, (ids: string[]) => DockNode> = {
		'tabs beside p': (ids) => besideP(tabs(ids), 'row'),
		'tabs alone': (ids) => tabs(ids),
		'row beside p': (ids) => besideP(split('row', ids), 'column'),
		'row alone': (ids) => split('row', ids),
		'column beside p': (ids) => besideP(split('column', ids), 'row'),
		'column alone': (ids) => split('column', ids)
	};
	for (const [kind, make] of Object.entries(layouts)) {
		for (const n of [2, 3, 4, 5]) {
			const ids = names.slice(0, n);
			// Every pane (k = n) up to 4 panes: 5! x 5! runs per case would be too slow.
			const ks = [2, 3, 4].filter((k) => k <= n && (n <= 4 || k <= 3));
			for (const k of ks) {
				for (const hidden of subsets(ids, k)) {
					it(`${kind} [${ids.join(',')}] hide ${hidden.join(',')} (every order x every order)`, () => {
						const want = JSON.stringify(shapeOf(make(ids)));
						const failures: string[] = [];
						for (const hideOrder of permutations(hidden)) {
							for (const showOrder of permutations(hidden)) {
								const dock = createDockState(
									{ version: 2, floating: [], docked: make(ids) },
									counterMakeId()
								);
								for (const id of hideOrder) dock.dismiss(id);
								for (const id of showOrder) dock.show(id);
								const got = JSON.stringify(shapeOf(dock.layout.docked));
								if (got !== want) failures.push(`hide ${hideOrder} show ${showOrder} -> ${got}`);
							}
						}
						expect(failures).toEqual([]);
					});
				}
			}
		}
	}
});

// Codex P2 on #725: the surviving child of a split that is gone is itself a split. One pane of
// that child is not "the whole child", so it keeps its slot in the child (not the gone split's).
describe('slot memory: the surviving child of a gone split is a split', () => {
	const even = (n: number) => Array.from({ length: n }, () => 1 / n);
	const nested = (
		outer: 'row' | 'column',
		inner: string[],
		rest: string[],
		innerFirst = true
	): DockNode => {
		const innerNode: DockNode = {
			type: 'split',
			id: 'in',
			direction: outer === 'row' ? 'column' : 'row',
			sizes: even(inner.length),
			children: inner.map(panel)
		};
		const children = innerFirst ? [innerNode, ...rest.map(panel)] : [...rest.map(panel), innerNode];
		return { type: 'split', id: 'out', direction: outer, sizes: even(children.length), children };
	};

	it('row[column[a,b,c], d]: hide d then a, show d then a -> the old shape', () => {
		const make = () => nested('row', ['a', 'b', 'c'], ['d']);
		const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
		dock.dismiss('d');
		dock.dismiss('a');
		dock.show('d');
		dock.show('a');
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});

	const permutations = (ids: string[]): string[][] =>
		ids.length <= 1
			? [ids]
			: ids.flatMap((id, i) =>
					permutations([...ids.slice(0, i), ...ids.slice(i + 1)]).map((rest) => [id, ...rest])
				);
	const subsets = (ids: string[], k: number): string[][] =>
		k === 0
			? [[]]
			: ids.flatMap((id, i) => subsets(ids.slice(i + 1), k - 1).map((rest) => [id, ...rest]));
	const layouts: Record<string, () => DockNode> = {
		'row[column[a,b,c], d]': () => nested('row', ['a', 'b', 'c'], ['d']),
		'row[d, column[a,b,c]]': () => nested('row', ['a', 'b', 'c'], ['d'], false),
		'column[row[a,b], c]': () => nested('column', ['a', 'b'], ['c']),
		'column[c, row[a,b]]': () => nested('column', ['a', 'b'], ['c'], false)
	};
	// Not covered yet (they failed before #721 too): a pane of the inner split hidden before the
	// outer sibling, every pane hidden, or two outer siblings (`column[row[a,b], c, d]` hide c, d:
	// `c` comes back around the anchor `b`, not around the whole `row[a,b]`).
	// The panes outside the inner split (`d` / `c`) first: the inner one is gone only after.
	const outerFirst = (inner: string[]) => (order: string[]) =>
		order.every((id, i) => i === 0 || inner.includes(id) || !inner.includes(order[i - 1]));
	for (const [name, make] of Object.entries(layouts)) {
		const ids = collectPanelIds(make());
		const inner = collectPanelIds(findNode(make(), 'in')!);
		for (let k = 2; k < ids.length; k++) {
			for (const hidden of subsets(ids, k)) {
				it(`${name} hide ${hidden.join(',')} (every order x every order)`, () => {
					const want = JSON.stringify(shapeOf(make()));
					const failures: string[] = [];
					for (const hideOrder of permutations(hidden).filter(outerFirst(inner))) {
						for (const showOrder of permutations(hidden)) {
							const dock = createDockState(
								{ version: 2, floating: [], docked: make() },
								counterMakeId()
							);
							for (const id of hideOrder) dock.dismiss(id);
							for (const id of showOrder) dock.show(id);
							const got = JSON.stringify(shapeOf(dock.layout.docked));
							if (got !== want) failures.push(`hide ${hideOrder} show ${showOrder} -> ${got}`);
						}
					}
					expect(failures).toEqual([]);
				});
			}
		}
	}
});
