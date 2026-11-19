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
import {
	captureDockSlot as mainCapture,
	restoreDockSlot as mainRestore
} from './fixtures/slot-main';
import {
	enumerateSequences,
	keyOf,
	simDismiss,
	simRun,
	simShow,
	type Sim,
	type SlotImpl
} from './fixtures/visibility-sim';

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

	// #727: the split is re-made around the whole row `a` and `b` are in again, so both are asked.
	it('restoring around a whole inner split asks every pane of it (reparent)', async () => {
		const asked: DockPanelChange[] = [];
		let allow = false;
		const hook = (change: DockPanelChange) => {
			asked.push(change);
			return allow;
		};
		const dock = createDockState(
			{
				version: 2,
				floating: [],
				docked: {
					type: 'split',
					id: 's',
					direction: 'column',
					sizes: [0.5, 0.5],
					children: [
						{
							type: 'split',
							id: 'in',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [panel('a'), panel('b')]
						},
						panel('c')
					]
				}
			},
			counterMakeId()
		);
		const lifecycle = new PanelLifecycle(dock, () => ({
			beforePanelChange: hook,
			isStructureChangeDeferred: () => false
		}));
		dock.dismiss('a');
		dock.dismiss('c');
		dock.show('a'); // row[a, b] is the root
		const before = JSON.stringify(dock.layout);

		expect(await lifecycle.show('c')).toBe('refused');
		expect(asked).toEqual([{ kind: 'reparent', panelId: 'a', cause: 'c', remount: true }]);
		expect(JSON.stringify(dock.layout)).toBe(before);

		allow = true;
		asked.length = 0;
		expect(await lifecycle.show('c')).toBe('applied');
		expect(asked).toEqual([
			{ kind: 'reparent', panelId: 'a', cause: 'c', remount: true },
			{ kind: 'reparent', panelId: 'b', cause: 'c', remount: true }
		]);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'c'] });
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
					// Up to 4! x 4! runs: an explicit timeout for a slow CI runner (2-3 times slower).
					it(
						`${kind} [${ids.join(',')}] hide ${hidden.join(',')} (every order x every order)`,
						{ timeout: 60_000 },
						() => {
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
						}
					);
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
		innerFirst = true,
		sameDirection = false
	): DockNode => {
		const innerNode: DockNode = {
			type: 'split',
			id: 'in',
			direction: sameDirection ? outer : outer === 'row' ? 'column' : 'row',
			sizes: even(inner.length),
			children: inner.map(panel)
		};
		const children = innerFirst ? [innerNode, ...rest.map(panel)] : [...rest.map(panel), innerNode];
		return { type: 'split', id: 'out', direction: outer, sizes: even(children.length), children };
	};

	it('row[row[a,b], p]: hide a and b, show a then b -> the inner row again (not row[a,b,p])', () => {
		const make = () => nested('row', ['a', 'b'], ['p'], true, true);
		const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
		dock.dismiss('a');
		dock.dismiss('b');
		dock.show('a');
		dock.show('b');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ row: ['a', 'b'] }, 'p'] });
	});

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
		'column[c, row[a,b]]': () => nested('column', ['a', 'b'], ['c'], false),
		// The same direction inside (an edge dock wraps the root even then; cross-review P2 on #725).
		'row[row[a,b], p]': () => nested('row', ['a', 'b'], ['p'], true, true),
		'row[p, row[a,b,c]]': () => nested('row', ['a', 'b', 'c'], ['p'], false, true),
		'column[column[a,b,c], p]': () => nested('column', ['a', 'b', 'c'], ['p'], true, true),
		// #727: two outer siblings (`c` came back around the anchor `b`, not around `row[a,b]`).
		'column[row[a,b], c, d]': () => nested('column', ['a', 'b'], ['c', 'd']),
		'column[c, d, row[a,b]]': () => nested('column', ['a', 'b'], ['c', 'd'], false),
		// Codex P2 on #732: four splits deep (`L` below; the describe body runs after the module).
		'column[row[a,column[row[b,c],d]],e]': () => L['column[row[a,column[row[b,c],d]],e]'](),
		// Codex P2 on #732 (the second one): tab groups inside a split inside a split, five panes
		// (every pane too). Six and seven: the walk with merged states below.
		'column[tabs[a,b],row[c,tabs[d,e]]]': () => L['column[tabs[a,b],row[c,tabs[d,e]]]'](),
		'row[a,column[tabs[b,c],tabs[d,e]]]': () => L['row[a,column[tabs[b,c],tabs[d,e]]]']()
	};
	for (const [name, make] of Object.entries(layouts)) {
		const ids = collectPanelIds(make());
		// #727: every pane too (k = n), and every hide order (an inner pane before the outer sibling).
		for (let k = 2; k <= ids.length; k++) {
			for (const hidden of subsets(ids, k)) {
				// Up to 5! x 5! runs (7-9 s on CI): an explicit timeout, as for the walks below.
				it(
					`${name} hide ${hidden.join(',')} (every order x every order)`,
					{ timeout: 60_000 },
					() => {
						const want = JSON.stringify(shapeOf(make()));
						const failures: string[] = [];
						for (const hideOrder of permutations(hidden)) {
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
					}
				);
			}
		}
	}
});

// Codex P2 on #725 (the last tab recorded as a `tab` slot): the tab group's place in the outer
// split must still be counted among that split's children by the panes hidden after it.
describe('slot memory: a hidden container still holds its place in the outer split', () => {
	it('row[tabs[a,b],c,d]: hide b,a,c, show a, hide d, show b,c,d -> the old shape', () => {
		const make = (): DockNode => ({
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.4, 0.3, 0.3],
			children: [
				{ type: 'tabs', id: 't', activeIndex: 0, children: [panel('a'), panel('b')] },
				panel('c'),
				panel('d')
			]
		});
		const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
		for (const id of ['b', 'a', 'c']) dock.dismiss(id);
		dock.show('a');
		dock.dismiss('d');
		for (const id of ['b', 'c', 'd']) dock.show(id);
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});

	it('row[a,column[b,c],d]: hide b,a, show b, hide d,c, show d,c,a -> the old shape (Codex P2)', () => {
		// a's slot (taken while b was hidden) names only c, d; b is back in the column when c
		// leaves, so c is not the whole surviving child and keeps its place in the column.
		const make = (): DockNode => ({
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.3, 0.4, 0.3],
			children: [
				panel('a'),
				{
					type: 'split',
					id: 'in',
					direction: 'column',
					sizes: [0.5, 0.5],
					children: [panel('b'), panel('c')]
				},
				panel('d')
			]
		});
		const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
		for (const id of ['b', 'a']) dock.dismiss(id);
		dock.show('b');
		for (const id of ['d', 'c']) dock.dismiss(id);
		for (const id of ['d', 'c', 'a']) dock.show(id);
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});
});

// The layouts of the checks below: split / tab group ids fixed, sizes even.
const evenSizes = (n: number) => Array.from({ length: n }, () => 1 / n);
const splitNode = (id: string, direction: 'row' | 'column', children: DockNode[]): DockNode => ({
	type: 'split',
	id,
	direction,
	sizes: evenSizes(children.length),
	children
});
const tabsNode = (id: string, ids: string[]): DockNode => ({
	type: 'tabs',
	id,
	activeIndex: 0,
	children: ids.map(panel)
});
/**
 * `-x` hides x, `+x` shows it, `~x` floats it (`undockPanel`, #734), `^x` puts it back where it
 * was (`dockAtSlot` with its `homeSlot`, the panel menu's "back"), with `createDockState`.
 */
const runSteps = (make: () => DockNode, steps: string[]): DockState => {
	const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
	for (const step of steps) {
		const id = step.slice(1);
		if (step[0] === '-') dock.dismiss(id);
		else if (step[0] === '+') dock.show(id);
		else if (step[0] === '~') dock.undockPanel(id);
		else {
			const slot = dock.homeSlot(id);
			if (slot) dock.dockAtSlot(id, slot);
		}
	}
	return dock;
};
const mainSlot: SlotImpl = { capture: mainCapture, restore: mainRestore };
const nowSlot: SlotImpl = { capture: captureDockSlot, restore: restoreDockSlot };

const L = {
	'row[a,tabs[b,c],column[d,e]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			tabsNode('t', ['b', 'c']),
			splitNode('in', 'column', [panel('d'), panel('e')])
		]),
	'row[a,column[b,c],d]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('in', 'column', [panel('b'), panel('c')]),
			panel('d')
		]),
	'row[tabs[a,b],c,d]': () =>
		splitNode('s', 'row', [tabsNode('t', ['a', 'b']), panel('c'), panel('d')]),
	'row[row[a,b],p]': () =>
		splitNode('s', 'row', [splitNode('in', 'row', [panel('a'), panel('b')]), panel('p')]),
	'column[a,row[b,c],d]': () =>
		splitNode('s', 'column', [
			panel('a'),
			splitNode('in', 'row', [panel('b'), panel('c')]),
			panel('d')
		]),
	'row[a,b,c,d]': () => splitNode('s', 'row', ['a', 'b', 'c', 'd'].map(panel)),
	'row[column[a,b],c,d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [panel('a'), panel('b')]),
			panel('c'),
			panel('d')
		]),
	'row[column[a,b,c],d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [panel('a'), panel('b'), panel('c')]),
			panel('d')
		]),
	'row[a,column[b,row[c,d]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('in', 'column', [panel('b'), splitNode('in2', 'row', [panel('c'), panel('d')])])
		]),
	'row[column[tabs[a,b],c],d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [tabsNode('t', ['a', 'b']), panel('c')]),
			panel('d')
		]),
	'row[row[a,b],column[c,d]]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'row', [panel('a'), panel('b')]),
			splitNode('in2', 'column', [panel('c'), panel('d')])
		]),
	'column[tabs[a,b,c],row[d,e]]': () =>
		splitNode('s', 'column', [
			tabsNode('t', ['a', 'b', 'c']),
			splitNode('in', 'row', [panel('d'), panel('e')])
		]),
	'row[tabs[a,b],column[c,d],e]': () =>
		splitNode('s', 'row', [
			tabsNode('t', ['a', 'b']),
			splitNode('in', 'column', [panel('c'), panel('d')]),
			panel('e')
		]),
	'column[row[a,tabs[b,c]],row[d,e]]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [panel('a'), tabsNode('t', ['b', 'c'])]),
			splitNode('r2', 'row', [panel('d'), panel('e')])
		]),
	// #727: two outer siblings of an inner split.
	'column[row[a,b],c,d]': () =>
		splitNode('s', 'column', [
			splitNode('in', 'row', [panel('a'), panel('b')]),
			panel('c'),
			panel('d')
		]),
	// Codex P2 on #732: four splits deep (a slot's `outer` chain was cut here when `MAX_SLOT_DEPTH`
	// was 4).
	'column[row[a,column[row[b,c],d]],e]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [
				panel('a'),
				splitNode('c1', 'column', [splitNode('r2', 'row', [panel('b'), panel('c')]), panel('d')])
			]),
			panel('e')
		]),
	// Codex P2 on #732 (the second one): tab groups inside a split inside a split.
	'row[b,c,column[tabs[d,e],tabs[f,g]]]': () =>
		splitNode('s', 'row', [
			panel('b'),
			panel('c'),
			splitNode('c1', 'column', [tabsNode('t1', ['d', 'e']), tabsNode('t2', ['f', 'g'])])
		]),
	'column[tabs[a,b],row[c,tabs[d,e]]]': () =>
		splitNode('s', 'column', [
			tabsNode('t1', ['a', 'b']),
			splitNode('r', 'row', [panel('c'), tabsNode('t2', ['d', 'e'])])
		]),
	'row[a,column[tabs[b,c],tabs[d,e]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [tabsNode('t1', ['b', 'c']), tabsNode('t2', ['d', 'e'])])
		]),
	'row[a,column[b,row[tabs[c,d],e]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [
				panel('b'),
				splitNode('r', 'row', [tabsNode('t1', ['c', 'd']), panel('e')])
			])
		]),
	'column[row[a,tabs[b,c]],tabs[d,e],f]': () =>
		splitNode('s', 'column', [
			splitNode('r', 'row', [panel('a'), tabsNode('t1', ['b', 'c'])]),
			tabsNode('t2', ['d', 'e']),
			panel('f')
		]),
	'row[column[tabs[a,b],c],column[d,tabs[e,f]]]': () =>
		splitNode('s', 'row', [
			splitNode('c1', 'column', [tabsNode('t1', ['a', 'b']), panel('c')]),
			splitNode('c2', 'column', [panel('d'), tabsNode('t2', ['e', 'f'])])
		]),
	// A tab group five containers deep (its last tab's `outer` chain was cut when `MAX_SLOT_DEPTH`
	// was 4, and the tab opened floating).
	'column[row[a,column[row[tabs[b,c],x],d]],e]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [
				panel('a'),
				splitNode('c1', 'column', [
					splitNode('r2', 'row', [tabsNode('t', ['b', 'c']), panel('x')]),
					panel('d')
				])
			]),
			panel('e')
		]),
	// A tab group five containers deep the other way round (cut, too, when the limit was 4).
	'row[a,column[b,row[c,column[tabs[d,e],f]]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [
				panel('b'),
				splitNode('r', 'row', [
					panel('c'),
					splitNode('c2', 'column', [tabsNode('t', ['d', 'e']), panel('f')])
				])
			])
		])
} satisfies Record<string, () => DockNode>;

// Codex P2 on #725 (the fifth on the same place) and what walking every sequence (below) found
// next to it: each comes back to the old shape on main (82b82246), not with the slot of 0f354140.
describe('slot memory: regressions found by walking every sequence (#721)', () => {
	const cases: [keyof typeof L, string, string][] = [
		[
			'row[a,tabs[b,c],column[d,e]]',
			'-d -a -c +d -b -e +b +e +a +c',
			// When e leaves, b's `outer` (the tab group's place in the row) names d, shown again
			// into e's column: e is not the whole column, it keeps its slot there.
			'an outer slot names a pane docked beside the last child'
		],
		[
			'row[a,column[b,row[c,d]]]',
			'-c -a +c -d -b +d -d +b +a +d',
			// a's slot names d, but d is in a row with c now, not where the outer row was (the root).
			'the last child is not where the gone split was'
		],
		[
			'column[row[a,tabs[b,c]],row[d,e]]',
			'-a -b +a -c -a +a +c +b',
			// b's outer (the group in the column) is older than c's (the group in a's row).
			'an older slot of a container is not its place'
		],
		[
			'column[row[a,tabs[b,c]],row[d,e]]',
			'-b -a +b -c -b +b +c +a',
			// a's row names c, whose group names b: the row's place is the one b holds.
			'a hidden container whose panes lead to a docked pane is not a sibling'
		],
		[
			'row[column[tabs[a,b],c],d]',
			'-a -c +a -b -d +b +c +d -d -c +d +c',
			// c's column names b, whose group names a, docked again: the column's place is a's.
			'a hidden container whose panes lead to a docked pane is not a sibling'
		],
		// #727, found while walking every sequence with the fix half done:
		[
			'row[a,column[b,row[c,d]]]',
			'-b -a -c +b -b +c +a +b -b -c +b +c',
			// When c leaves, `in` (gone) and `s` (gone) both name the row: the inner one, `in`.
			'the innermost gone split is the place of the last child'
		],
		[
			'row[column[tabs[a,b],c],d]',
			'-a -d +a -c +d -d +c +d -d -c +d +c',
			// The column is all that is left of the row `s` (d hidden), with the tab group in it.
			'a container in a gone split names a tab group inside it'
		],
		// Codex P2 on #732, found by the walk below once the deep layout was in it:
		[
			'column[row[a,column[row[b,c],d]],e]',
			'-a -b -e +a +e -e -a +b +e +a',
			// b's row is gone, but the column around it is still in a's row: b is one of that
			// row's panes when e leaves (so e goes beside the whole row again, not beside d).
			'a pane hidden out of a gone split inside a docked one'
		]
	];
	for (const [name, steps, why] of cases) {
		it(`${name}: ${steps} -> the old shape (${why})`, () => {
			const make = L[name];
			const want = shapeOf(make());
			expect(shapeOf(simRun(mainSlot, make(), steps.split(' ')).docked)).toEqual(want);
			expect(shapeOf(runSteps(make, steps.split(' ')).layout.docked)).toEqual(want);
		});
	}
});

// Codex P2 on #732: b's slot names `r2`, and the chain of the splits around it (c1, r1, s) was cut at
// `MAX_SLOT_DEPTH` (4 then; 8 now) before the root. The place of `s` that another hidden pane (a) remembers is
// still b's place: b goes back into the row, not floating. (The main before #727, 82b82246, brings this
// one back too; 243958c5, before #725, did not.)
it('column[row[a,column[row[b,c],d]],e]: -a -e -c -d -b +d +b +e +c +a -> the old shape (an outer chain four splits deep)', () => {
	const make = L['column[row[a,column[row[b,c],d]],e]'];
	const dock = runSteps(make, '-a -e -c -d -b +d +b +e +c +a'.split(' '));
	expect(dock.layout.floating).toEqual([]);
	expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
});

// Codex P2 on #732 (the third one): the last tab c of a tab group five containers deep. Its chain
// (t, r2, c1, r1) was cut at `MAX_SLOT_DEPTH` (4 then) at a split that is gone, so c opened
// floating; with the limit at 8 it goes back beside e, and the rest follow.
it('column[row[a,column[row[tabs[b,c],x],d]],e]: -a -b -x -d -c +c +d +x +b +a -> the old shape (a chain five containers deep)', () => {
	const make = L['column[row[a,column[row[tabs[b,c],x],d]],e]'];
	const dock = runSteps(make, '-a -b -x -d -c +c +d +x +b +a'.split(' '));
	expect(dock.layout.floating).toEqual([]);
	expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
});

// PR #732 review: a layout with a slot more than four deep is saved as `version: 3` (the releases
// before #727 reject such a slot as a whole), a shallow one stays 2; the v3 JSON reads back.
describe('the saved version follows the slot depth', () => {
	it('a shallow layout stays version 2', () => {
		const dock = runSteps(L['row[a,tabs[b,c],column[d,e]]'], '-b -d -a'.split(' '));
		expect(dock.layout.version).toBe(2);
		expect(JSON.parse(dock.serialize()).version).toBe(2);
	});

	it('column[row[a,column[row[tabs[b,c],x],d]],e]: -a -b -x -d -c is version 3, and reads back', () => {
		const make = L['column[row[a,column[row[tabs[b,c],x],d]],e]'];
		const dock = runSteps(make, '-a -b -x -d -c'.split(' '));
		const json = dock.serialize();
		expect(JSON.parse(json).version).toBe(3);
		const back = createDockState(json, counterMakeId());
		expect(back.layout).toEqual(dock.layout);
		for (const id of 'c d x b a'.split(' ')) back.show(id);
		expect(back.layout.floating).toEqual([]);
		expect(shapeOf(back.layout.docked)).toEqual(shapeOf(make()));
		// Every pane back: the deep slots are gone, and so is version 3.
		expect(JSON.parse(back.serialize()).version).toBe(2);
	});
});

// Codex P2 on #732 (the second one): g's tab group `t2` is all that is left of the column `c1`, so
// g's slot remembers `t2` with `outer` = `c1`'s place, and the row `s` is `outer.outer`. The
// group of d and e (gone too) still counts among the row's children for b and c hidden after it.
it('row[b,c,column[tabs[d,e],tabs[f,g]]]: -g -d -e -f -b -c +f +b +c +d +g +e -> the old shape (a container counted by a nested outer)', () => {
	const make = L['row[b,c,column[tabs[d,e],tabs[f,g]]]'];
	const dock = runSteps(make, '-g -d -e -f -b -c +f +b +c +d +g +e'.split(' '));
	expect(dock.layout.floating).toEqual([]);
	expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
});

// Codex P2 on #732 (the second one): every hide order of every set of panes, then every show order,
// with the states merged on the way (`keyOf`), so six and seven panes fit - not every order x
// every order run one by one (7! x 7! of them). Run with main's slot (82b82246) beside the current
// one: every one comes back to the old shape (`all`), or at least every one that does on main.
describe('slot memory: every hide order then every show order (merged states)', () => {
	const cases: [keyof typeof L, 'all' | 'main'][] = [
		['row[b,c,column[tabs[d,e],tabs[f,g]]]', 'all'],
		['row[a,column[b,row[tabs[c,d],e]]]', 'all'],
		['column[row[a,tabs[b,c]],tabs[d,e],f]', 'all'],
		['row[column[tabs[a,b],c],column[d,tabs[e,f]]]', 'all'],
		// A tab group five containers deep. With `MAX_SLOT_DEPTH` at 4, the last tab's chain
		// (t, r2, c1, r1) was cut at a split that is gone, and `restoreDockSlot` had nothing to go
		// on with: the tab opened floating (`-a -b -x -d -c +c ...`), where main puts it beside e.
		// The limit is 8 now (#727).
		['column[row[a,column[row[tabs[b,c],x],d]],e]', 'all'],
		['row[a,column[b,row[c,column[tabs[d,e],f]]]]', 'all']
	];
	for (const [name, want] of cases) {
		it(
			`${name} (${want === 'all' ? 'every one' : 'every one main brings back'})`,
			{ timeout: 60_000 },
			() => {
				const make = L[name];
				const ids = collectPanelIds(make());
				const shape = JSON.stringify(shapeOf(make()));
				const ok = (sim: Sim) =>
					sim.floating.length === 0 && JSON.stringify(shapeOf(sim.docked)) === shape;
				interface Entry {
					main: Sim;
					now: Sim;
					showing: boolean;
					steps: string[];
				}
				const start: Sim = { docked: make(), hidden: [], floating: [] };
				let level: Entry[] = [{ main: start, now: start, showing: false, steps: [] }];
				const failures: string[] = [];
				let checked = 0;
				while (level.length > 0) {
					const next = new Map<string, Entry>();
					const add = (e: Entry) => {
						const key = `${e.showing}${keyOf(e.main)}${keyOf(e.now)}`;
						if (!next.has(key)) next.set(key, e);
					};
					for (const e of level) {
						// The panes to show: hidden in the current run (a floating one is not docked again).
						const hidden = e.now.hidden.map((h) => h.id);
						if (e.showing && hidden.length === 0) {
							checked++;
							if (!ok(e.now) && (want === 'all' || ok(e.main)))
								failures.push(
									`${e.steps.join(' ')} -> ${JSON.stringify(shapeOf(e.now.docked))} floating [${e.now.floating}]`
								);
							continue;
						}
						const step = (id: string, show: boolean): Entry => ({
							main: show ? simShow(mainSlot, e.main, id) : simDismiss(mainSlot, e.main, id),
							now: show ? simShow(nowSlot, e.now, id) : simDismiss(nowSlot, e.now, id),
							showing: show,
							steps: [...e.steps, `${show ? '+' : '-'}${id}`]
						});
						if (e.showing) {
							for (const id of hidden) add(step(id, true));
							continue;
						}
						if (hidden.length > 0) add({ ...e, showing: true });
						for (const id of ids) if (findNode(e.now.docked, id)) add(step(id, false));
					}
					level = [...next.values()];
				}
				expect(checked).toBeGreaterThan(0);
				expect(failures.slice(0, 5)).toEqual([]);
			}
		);
	}
});

// Codex kept finding regressions in orders that interleave hiding and showing (#725). Every
// sequence of hide / show steps up to `steps` long on these layouts, run with main's slot
// (`fixtures/slot-main.ts`, 82b82246) and the current one side by side (`fixtures/visibility-sim.ts`):
// every sequence that comes back to the old shape on main must still do so. The steps are as
// many as fit in a second or two per layout (12 for 4 panes, 10 for 5; 14 for all of them was
// run once by hand, with no regression). A sequence of odd length never shows every pane again.
describe('slot memory: no hide / show sequence regresses from main (every sequence)', () => {
	for (const [name, make] of Object.entries(L)) {
		// Six panes and more: 8 steps (10 takes 20 s for seven; the merged walk below covers every
		// pane hidden then shown).
		const n = collectPanelIds(make()).length;
		const steps = n <= 4 ? 12 : n === 5 ? 10 : 8;
		it(`${name}: every sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSlot, nowSlot, steps);
			expect(result.mainRestores).toBeGreaterThan(0);
			expect(result.regressions.slice(0, 5)).toEqual([]);
		});
	}
});

// Longer sequences than the walk above, at random (fixed seed), run with `createDockState`: every
// one that comes back to the old shape with main's slot must still do so. The model the walk uses
// is checked against `createDockState` on the way.
describe('slot memory: interleaved hide / show orders do not regress', () => {
	// mulberry32: a small seeded generator, so the sequences are the same on every run.
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	/**
	 * `-x` hides x, `+x` shows it; 10 to 16 steps (the count random too) with at least one show
	 * between hides, then the rest shown.
	 */
	const sequences = (ids: string[], count: number, seed: number): string[] => {
		const random = rng(seed);
		const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
		const out = new Set<string>();
		for (let tries = 0; out.size < count && tries < count * 20; tries++) {
			const hidden: string[] = [];
			const steps: string[] = [];
			const length = 10 + Math.floor(random() * 7);
			for (let i = 0; i < length; i++) {
				const docked = ids.filter((id) => !hidden.includes(id));
				const show = hidden.length > 0 && (docked.length === 0 || random() < 0.4);
				const id = pick(show ? hidden : docked);
				if (show) hidden.splice(hidden.indexOf(id), 1);
				else hidden.push(id);
				steps.push(`${show ? '+' : '-'}${id}`);
			}
			while (hidden.length > 0)
				steps.push(`+${hidden.splice(Math.floor(random() * hidden.length), 1)[0]}`);
			// Interleaved only: a show before the last hide.
			const lastHide = steps.map((s) => s[0]).lastIndexOf('-');
			if (steps.slice(0, lastHide).some((s) => s[0] === '+')) out.add(steps.join(' '));
		}
		return [...out];
	};
	const COUNT = 600;
	for (const [name, make] of Object.entries(L)) {
		it(`${name}: ${COUNT} interleaved sequences`, () => {
			const want = JSON.stringify(shapeOf(make()));
			const failures: string[] = [];
			for (const seq of sequences(collectPanelIds(make()), COUNT, 721)) {
				const steps = seq.split(' ');
				const got = JSON.stringify(shapeOf(runSteps(make, steps).layout.docked));
				// The model of the walk above gives the same tree as `createDockState`.
				expect(JSON.stringify(shapeOf(simRun(nowSlot, make(), steps).docked)), seq).toBe(got);
				const onMain = JSON.stringify(shapeOf(simRun(mainSlot, make(), steps).docked));
				if (onMain === want && got !== want) failures.push(seq);
			}
			expect(failures).toEqual([]);
		});
	}
});

// #734: a pane floated out of the tree (`undockPanel`, its `homeSlot`) and a pane hidden from it
// (`dismiss`, its closed window's `dockSlot`) count each other, whichever is put back first.
// Before, `dismiss` counted the closed windows only (the floated panes' places were kept by the
// `DragController`), so `~b -a ^b +a` on row[a,b,c] came back as row[b,a,c].
describe('slot memory: floated and hidden panes out of the same container (#734)', () => {
	const mainSplit: SlotImpl = { ...mainSlot, split: true };
	const row3 = () => splitNode('s', 'row', ['a', 'b', 'c'].map(panel));

	it('row[a,b,c]: ~b -a ^b +a -> the old shape (row[b,a,c] before #734)', () => {
		const steps = '~b -a ^b +a'.split(' ');
		const want = shapeOf(row3());
		expect(shapeOf(simRun(mainSplit, row3(), steps).docked)).toEqual({ row: ['b', 'a', 'c'] });
		expect(shapeOf(simRun(nowSlot, row3(), steps).docked)).toEqual(want);
		expect(shapeOf(runSteps(row3, steps).layout.docked)).toEqual(want);
	});

	it('row[a,b,c]: -b ~a +b ^a -> the old shape (the float counts the hidden pane, as before)', () => {
		const steps = '-b ~a +b ^a'.split(' ');
		expect(shapeOf(runSteps(row3, steps).layout.docked)).toEqual(shapeOf(row3()));
	});

	it('row[a,b,c]: every mixed sequence up to 8 steps comes back to the old shape', () => {
		const result = enumerateSequences(row3, mainSplit, nowSlot, 8, { mixed: true });
		expect(result.regressions).toEqual([]);
		expect(result.improvements).toBeGreaterThan(0);
		expect(result.nowRestores).toBe(result.sequences);
	});

	// Every sequence of hide / show / float / back steps, run with main's slot and main's wiring
	// (`split`: `dismiss` did not count the floated panes) beside the current ones: every sequence
	// that comes back to the old shape on main still does. Up to five panes, the steps as many as
	// fit in a few seconds (a docked pane can be hidden or floated: twice the branches).
	for (const [name, make] of Object.entries(L)) {
		const n = collectPanelIds(make()).length;
		if (n > 5) continue;
		const steps = n <= 3 ? 8 : 6;
		it(`${name}: every mixed sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSplit, nowSlot, steps, { mixed: true });
			expect(result.mainRestores).toBeGreaterThan(0);
			expect(result.regressions.slice(0, 5)).toEqual([]);
		});
	}

	// Longer mixed sequences at random (fixed seed) with `createDockState`, checked against the
	// model of the walk above and against main.
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	/** 10 to 16 steps, each pane out of the tree hidden or floated at random, with both kinds in each. */
	const sequences = (ids: string[], count: number, seed: number): string[] => {
		const random = rng(seed);
		const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
		const out = new Set<string>();
		for (let tries = 0; out.size < count && tries < count * 20; tries++) {
			const away = new Map<string, '-' | '~'>();
			const steps: string[] = [];
			const length = 10 + Math.floor(random() * 7);
			for (let i = 0; i < length; i++) {
				const docked = ids.filter((id) => !away.has(id));
				const back = away.size > 0 && (docked.length === 0 || random() < 0.4);
				const id = pick(back ? [...away.keys()] : docked);
				if (back) {
					steps.push(`${away.get(id) === '-' ? '+' : '^'}${id}`);
					away.delete(id);
				} else {
					const kind = random() < 0.5 ? '-' : '~';
					away.set(id, kind);
					steps.push(`${kind}${id}`);
				}
			}
			for (const [id, kind] of away) steps.push(`${kind === '-' ? '+' : '^'}${id}`);
			const kinds = new Set(steps.map((s) => s[0]));
			if (kinds.has('-') && kinds.has('~')) out.add(steps.join(' '));
		}
		return [...out];
	};
	const COUNT = 300;
	for (const [name, make] of Object.entries(L)) {
		it(`${name}: ${COUNT} mixed sequences with createDockState`, () => {
			const want = JSON.stringify(shapeOf(make()));
			const failures: string[] = [];
			for (const seq of sequences(collectPanelIds(make()), COUNT, 734)) {
				const steps = seq.split(' ');
				const got = JSON.stringify(shapeOf(runSteps(make, steps).layout.docked));
				expect(JSON.stringify(shapeOf(simRun(nowSlot, make(), steps).docked)), seq).toBe(got);
				const onMain = JSON.stringify(shapeOf(simRun(mainSplit, make(), steps).docked));
				if (onMain === want && got !== want) failures.push(seq);
			}
			expect(failures).toEqual([]);
		});
	}
});

// #735: a floated pane's `homeSlot` is dropped once the pane is not a floating window any more,
// whichever path docked it (before, only a drop through the `DragController` did).
describe('homeSlot follows the layout, not the path (#735)', () => {
	const make = () => splitNode('s', 'row', ['a', 'b', 'c'].map(panel));
	const fresh = () =>
		createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());

	it('docked through the API, then floated again: back puts it at the new place', () => {
		const dock = fresh();
		dock.undockPanel('a');
		expect(dock.homeSlot('a')).toBeDefined();
		dock.dockPanel('a', 'c', 'right');
		expect(dock.homeSlot('a')).toBeUndefined();
		dock.undockPanel('a');
		const slot = dock.homeSlot('a');
		expect(slot).toBeDefined();
		expect(dock.dockAtSlot('a', slot!)).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c', 'a'] });
		expect(dock.homeSlot('a')).toBeUndefined();
	});

	it('docked by `layout = ...`, or gone and loaded again floating: forgotten', () => {
		const dock = fresh();
		dock.undockPanel('a');
		const json = dock.serialize();
		dock.layout = { ...dock.layout, floating: [], docked: make() };
		expect(dock.homeSlot('a')).toBeUndefined();
		// The saved layout with `a` floating: no place comes back with it (not saved).
		expect(dock.hydrate(json)).toBe(true);
		expect(dock.homeSlot('a')).toBeUndefined();
	});

	// #738 review: the id stays floating across the swap, so the setter alone would keep it.
	it('another layout hydrated with the same pane floating: forgotten; a rejected one keeps it', () => {
		const dock = fresh();
		dock.undockPanel('a');
		expect(dock.hydrate('{ not json')).toBe(false);
		expect(dock.hydrate(JSON.stringify({ version: 2, floating: 1, docked: null }))).toBe(false);
		expect(dock.homeSlot('a')).toBeDefined();
		const other = createDockState(
			{ version: 2, floating: [], docked: splitNode('t', 'column', ['a', 'b', 'c'].map(panel)) },
			counterMakeId()
		);
		other.undockPanel('a');
		expect(dock.hydrate(other.serialize())).toBe(true);
		expect(dock.layout.floating.some((w) => w.id === 'a')).toBe(true);
		expect(dock.homeSlot('a')).toBeUndefined();
	});

	it('reset re-creating the same pane as a floating window: forgotten', () => {
		const dock = fresh();
		dock.undockPanel('a');
		dock.reset([{ id: 'a', title: 'A' }], 1000, 800);
		expect(dock.homeSlot('a')).toBeUndefined();
	});

	it('hidden and shown in its new place: the old place is not kept', () => {
		const dock = fresh();
		dock.undockPanel('b');
		dock.dockPanel('b', 'c', 'right');
		dock.dismiss('b');
		expect(dock.show('b')).toBe('docked');
		expect(dock.homeSlot('b')).toBeUndefined();
	});

	it('a floated window closed and opened again keeps its place (as before)', () => {
		const dock = fresh();
		dock.undockPanel('b');
		dock.close('b');
		expect(dock.homeSlot('b')).toBeDefined();
		dock.open('b');
		expect(dock.dockAtSlot('b', dock.homeSlot('b')!)).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});
});
