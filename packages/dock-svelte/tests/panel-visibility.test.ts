// 隠す順 × 戻す順の総当たりと旧実装（`fixtures/slot-main.ts`）との比較は #782 PR5 で削った（Issue #782 の
// 2026-11-22 の方針変更の 9）。性質は `default-place.test.ts` と `place-properties.test.ts`。ここには事例を残す。
// Hiding and showing a docked pane, and the View-menu API (#663 ①-A, #782 PR5): a docked pane that
// is hidden / closed (`DockState.dismiss`) remembers no place; `show` docks it at its DEFAULT place
// (`DockState.defaultLayout`, `core/defaultPlace.ts`), with the share it held. The docks here take
// the layout they start with as the default (`dockWithDefault`), so "the old shape" below is the
// default shape. Without a default place the pane opens floating; `dockShare` survives
// `serialize` / `hydrate`; `panels` lists every pane in a stable order with visible flags.
// A pane floated out of the tree still goes back to where it was (`hasHome` / `dockBack`, its tombstone in the shadow tree).
import { describe, expect, it, vi } from 'vitest';
import { PanelLifecycle, type DockPanelChange } from '../src/core/lifecycle';
import { collectPanelIds, findNode } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockNode, DockSplitNode, DockTabGroupNode } from '../src/types';
import {
	L,
	counterMakeId,
	dockWithDefault,
	nested,
	panel,
	runSteps,
	shapeOf,
	splitNode
} from './fixtures/visibility-layouts';

const winOf = (dock: DockState, id: string) => dock.layout.floating.find((w) => w.id === id);

/** split s (row): [tabs t [x, y, z] (0.6), p (0.4)] + floating f */
const tabsLayout = (): DockLayout => ({
	version: 4,
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
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		dock.dismiss('y');
		expect(collectPanelIds(dock.layout.docked)).toEqual(['x', 'z', 'p']);
		// No place is remembered: only that it was hidden from the dock, and its group's share.
		expect(winOf(dock, 'y')).toMatchObject({ open: false, dockShare: 0.6 });
		expect(winOf(dock, 'y')).not.toHaveProperty('dockSlot');

		expect(dock.show('y')).toBe('docked');
		const group = findNode(dock.layout.docked, 't') as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['x', 'y', 'z']);
		expect(group.activeIndex).toBe(1);
		expect(winOf(dock, 'y')).toBeUndefined();
	});

	it('a group that collapsed to one tab is made again around the anchor', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
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
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		dock.dismiss('y');
		dock.dismiss('x');
		dock.show('y');
		expect(order(dock)).toEqual(['y', 'z']);
		dock.show('x');
		expect(order(dock)).toEqual(['x', 'y', 'z']);
	});

	it('mirrored: hide y, hide z (lone x), show y = [x, y] (y was after x)', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
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
		const dock = dockWithDefault(layout, counterMakeId());
		dock.dismiss('z');
		dock.dismiss('x');
		dock.show('z');
		expect(order(dock)).toEqual(['y', 'z', 'w']);
	});

	const four = (): DockState => {
		const layout = tabsLayout();
		const t = splitOf(layout.docked).children[0] as DockTabGroupNode;
		t.children.push(panel('w'));
		return dockWithDefault(layout, counterMakeId());
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
});

describe('slot memory: split', () => {
	it('a pane of a 2-way split comes back on the same side with the same share', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
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
		const dock = dockWithDefault(
			{
				version: 4,
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
		const dock = dockWithDefault({ version: 4, floating: [], docked: panel('only') });
		dock.dismiss('only');
		expect(dock.layout.docked).toBeNull();
		expect(winOf(dock, 'only')?.dockShare).toBe(1);
		expect(dock.show('only')).toBe('docked');
		expect(dock.layout.docked).toEqual(panel('only'));
	});
});

describe('no default pane is docked, or no default place', () => {
	it('docks along its default edge when no pane of the default layout is docked', () => {
		const dock = dockWithDefault(
			{
				version: 4,
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
		expect(dock.showPlacement('l')).toBe('docked');

		// l is the first child of the default row: the left edge, with the half it held.
		expect(dock.show('l')).toBe('docked');
		expect(winOf(dock, 'l')).toBeUndefined();
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['l', 'f'] });
		expect(splitOf(dock.layout.docked).sizes).toEqual([0.5, 0.5]);
	});

	it('opens floating without a default layout, and for a pane the default layout does not dock', () => {
		const layout = (): DockLayout => ({
			version: 4,
			floating: [{ id: 'f', title: 'F', x: 10, y: 10, width: 300, height: 200, open: true }],
			docked: splitNode('s', 'row', [panel('l'), panel('r')])
		});
		// `DockHost` used directly, no `defaultLayout`: a hidden pane opens floating.
		const plain = createDockState(layout(), counterMakeId());
		plain.dismiss('l');
		expect(plain.panels.find((p) => p.id === 'l')?.placement).toBe('floating');
		expect(plain.showPlacement('l')).toBe('floating');
		expect(plain.show('l')).toBe('floating');
		expect(winOf(plain, 'l')).toMatchObject({ open: true });
		expect(winOf(plain, 'l')?.dockShare).toBeUndefined();
		expect(collectPanelIds(plain.layout.docked)).toEqual(['r']);

		// f floats by default: docked by the user and hidden from the dock, it opens floating too.
		const dock = dockWithDefault(layout(), counterMakeId());
		dock.dockPanel('f', 'r', 'right');
		dock.dismiss('f');
		expect(dock.show('f')).toBe('floating');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['l', 'r'] });
	});

	it('a pane that is the whole default tree has no sibling and no edge: floating once something else is docked', () => {
		const dock = dockWithDefault({
			version: 4,
			floating: [{ id: 'f', title: 'F', x: 0, y: 0, width: 300, height: 200, open: true }],
			docked: panel('only')
		});
		dock.dismiss('only');
		dock.ensurePanel({ id: 'g', title: 'G' }, 800, 600, 'center', 'any');
		expect(dock.show('only')).toBe('floating');
	});
});

describe('open / close keep their floating-only meaning', () => {
	it('open() of a pane hidden from the tree opens it floating: it is no longer hidden from the dock', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		dock.dismiss('p');
		expect(winOf(dock, 'p')?.dockShare).toBeCloseTo(0.4);
		dock.open('p');
		expect(winOf(dock, 'p')).toMatchObject({ open: true });
		expect(winOf(dock, 'p')?.dockShare).toBeUndefined();
		dock.close('p');
		expect(dock.show('p')).toBe('floating');
	});

	it('isOpen stays floating-only; isVisible counts docked panes', () => {
		const dock = dockWithDefault(tabsLayout());
		expect(dock.isOpen('x')).toBe(false);
		expect(dock.isVisible('x')).toBe(true);
		expect(dock.isVisible('f')).toBe(true);
		dock.dismiss('x');
		expect(dock.isVisible('x')).toBe(false);
	});

	it('ensureWindow does not add a floating copy of a docked id', () => {
		const dock = dockWithDefault(tabsLayout());
		dock.ensureWindow({ id: 'x', title: 'X' }, 800, 600);
		expect(winOf(dock, 'x')).toBeUndefined();
	});

	it('show() of a docked background tab activates it; unknown ids are null', () => {
		const dock = dockWithDefault(tabsLayout());
		expect(dock.show('z')).toBe('docked');
		expect((findNode(dock.layout.docked, 't') as DockTabGroupNode).activeIndex).toBe(2);
		expect(dock.show('nope')).toBeNull();
	});
});

describe('serialize / hydrate', () => {
	it('`dockShare` survives a round trip; the default layout is not saved (the app gives it again)', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		dock.dismiss('p');
		const json = dock.serialize();
		expect(JSON.parse(json).version).toBe(4);
		expect(JSON.parse(json).floating.find((w: { id: string }) => w.id === 'p')).not.toHaveProperty(
			'dockSlot'
		);

		const restored = createDockState(json, counterMakeId());
		expect(winOf(restored, 'p')?.dockShare).toBeCloseTo(0.4);
		expect(restored.defaultLayout).toBeNull();
		expect(restored.showPlacement('p')).toBe('floating');
		restored.defaultLayout = dock.defaultLayout;
		expect(restored.showPlacement('p')).toBe('docked');
		restored.show('p');
		const s = splitOf(restored.layout.docked);
		expect(s.children.map((c) => c.id)).toEqual(['t', 'p']);
		expect(s.sizes[1]).toBeCloseTo(0.4);
	});

	it('the tabs of a group all hidden: the group is made again beside its default neighbour (#721)', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		dock.dismiss('x');
		dock.dismiss('y');
		dock.dismiss('z');
		// x first: no tab of its group is docked, so x takes the group's default place next to p.
		expect(dock.show('x')).toBe('docked');
		expect(dock.show('z')).toBe('docked');
		expect(dock.show('y')).toBe('docked');
		const s = splitOf(dock.layout.docked);
		expect(s.children.map((c) => c.type)).toEqual(['tabs', 'panel']);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['x', 'y', 'z', 'p']);
	});

	it('JSON of an earlier version (1 - 3) is not read (#782 PR8b); a closed window without `dockShare` opens floating', () => {
		const closed = [{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: false }];
		const dock = createDockState();
		expect(dock.hydrate(JSON.stringify({ version: 1, floating: closed }))).toBe(false);
		for (const version of [2, 3])
			expect(dock.hydrate(JSON.stringify({ ...tabsLayout(), floating: [], version }))).toBe(false);
		expect(dock.panels).toEqual([]);

		expect(dock.hydrate(JSON.stringify({ version: 4, floating: closed, docked: null }))).toBe(true);
		expect(dock.show('a')).toBe('floating');

		expect(dock.hydrate(JSON.stringify({ ...tabsLayout(), floating: [] }))).toBe(true);
		expect(dock.panels.map((r) => r.id)).toEqual(['x', 'y', 'z', 'p']);
	});

	it('a `dockSlot` of the releases before #782 PR5 is dropped (the window opens floating); a malformed `dockShare` rejects the payload', () => {
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
		// Whatever the old slot holds (this one is malformed): not read, not kept.
		const read = validateDockLayout(bad);
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.layout.floating[0]).not.toHaveProperty('dockSlot');
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		expect(dock.hydrate(JSON.stringify(bad))).toBe(true);
		expect(dock.show('q')).toBe('floating');

		for (const dockShare of [-0.5, 1.5, '0.5', null]) {
			const floating = [{ ...bad.floating[0], dockSlot: undefined, dockShare }];
			const result = validateDockLayout({ ...bad, floating });
			expect(result.ok, String(dockShare)).toBe(false);
			if (!result.ok)
				expect(result.issues).toContainEqual({ code: 'shape', path: 'floating[0].dockShare' });
		}
		expect(
			validateDockLayout({
				...bad,
				floating: [{ ...bad.floating[0], dockSlot: undefined, dockShare: 1 }]
			}).ok
		).toBe(true);
	});
});

describe('panels', () => {
	it('lists every pane in first-seen order with visible / placement', () => {
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
		expect(dock.panels).toEqual([
			{ id: 'x', title: 'X', icon: undefined, placement: 'docked', visible: true, onScreen: true },
			{ id: 'y', title: 'Y', icon: undefined, placement: 'docked', visible: true, onScreen: false },
			{ id: 'z', title: 'Z', icon: undefined, placement: 'docked', visible: true, onScreen: false },
			{ id: 'p', title: 'P', icon: undefined, placement: 'docked', visible: true, onScreen: true },
			{ id: 'f', title: 'F', icon: undefined, placement: 'floating', visible: true, onScreen: true }
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
		const dock = dockWithDefault(tabsLayout(), counterMakeId());
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
		const dock = dockWithDefault(
			{
				version: 4,
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

// Codex P2 on #725: the surviving child of a split that is gone is itself a split. One pane of
// that child is not "the whole child", so it keeps its slot in the child (not the gone split's).
describe('slot memory: the surviving child of a gone split is a split', () => {
	it('row[row[a,b], p]: hide a and b, show a then b -> the inner row again (not row[a,b,p])', () => {
		const make = () => nested('row', ['a', 'b'], ['p'], true, true);
		const dock = dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());
		dock.dismiss('a');
		dock.dismiss('b');
		dock.show('a');
		dock.show('b');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ row: ['a', 'b'] }, 'p'] });
	});

	it('row[column[a,b,c], d]: hide d then a, show d then a -> the old shape', () => {
		const make = () => nested('row', ['a', 'b', 'c'], ['d']);
		const dock = dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());
		dock.dismiss('d');
		dock.dismiss('a');
		dock.show('d');
		dock.show('a');
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});
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
		const dock = dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());
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
		const dock = dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());
		for (const id of ['b', 'a']) dock.dismiss(id);
		dock.show('b');
		for (const id of ['d', 'c']) dock.dismiss(id);
		for (const id of ['d', 'c', 'a']) dock.show(id);
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});
});

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

// The saved version is 4, whatever the layout holds (#782 PR8b: nothing in it is a slot any more -
// until then a slot more than four deep made it `version: 3`, PR #732 review).
describe('the saved version: hidden panes hold no slot', () => {
	it('a shallow layout is version 4', () => {
		const dock = runSteps(L['row[a,tabs[b,c],column[d,e]]'], '-b -d -a'.split(' '));
		expect(dock.layout.version).toBe(4);
		expect(JSON.parse(dock.serialize()).version).toBe(4);
	});

	it('column[row[a,column[row[tabs[b,c],x],d]],e]: -a -b -x -d -c is version 4, and reads back', () => {
		const make = L['column[row[a,column[row[tabs[b,c],x],d]],e]'];
		const dock = runSteps(make, '-a -b -x -d -c'.split(' '));
		const json = dock.serialize();
		expect(JSON.parse(json).version).toBe(4);
		const back = createDockState(json, counterMakeId());
		back.defaultLayout = dock.defaultLayout;
		expect(back.layout).toEqual(dock.layout);
		for (const id of 'c d x b a'.split(' ')) back.show(id);
		expect(back.layout.floating).toEqual([]);
		expect(shapeOf(back.layout.docked)).toEqual(shapeOf(make()));
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

// #734 made a pane floated out of the tree (`undockPanel`, its remembered place) and a pane hidden from
// it count each other. Since #782 PR5 a hidden pane holds no place: it comes back at its default
// place, and a floated pane's remembered place no longer counts it.
describe('floated and hidden panes out of the same container (#734, #782 PR5)', () => {
	const row3 = () => splitNode('s', 'row', ['a', 'b', 'c'].map(panel));

	it('row[a,b,c]: ~b -a ^b +a -> the old shape (the hidden pane comes back at its default place)', () => {
		const steps = '~b -a ^b +a'.split(' ');
		expect(shapeOf(runSteps(row3, steps).layout.docked)).toEqual(shapeOf(row3()));
	});

	// b is hidden (it holds no place), then a floated: a's place - its tombstone in the shadow
	// tree - is the default sibling b is shown beside, after it as in the default layout (#782 PR6:
	// the default place is worked out on the shadow tree). So a goes back before b. With PR5 alone
	// this was row[b,a,c]: b went beside c, and a back to "the left of c".
	it('row[a,b,c]: -b ~a +b ^a -> row[a,b,c] (a hidden pane is shown beside the place of a floated one)', () => {
		const steps = '-b ~a +b ^a'.split(' ');
		const dock = runSteps(row3, '-b ~a +b'.split(' '));
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c'] });
		expect(shapeOf(runSteps(row3, steps).layout.docked)).toEqual(shapeOf(row3()));
	});
});

// #735: a floated pane's remembered place is dropped once the pane is not a floating window any more,
// whichever path docked it (before, only a drop through the `DragController` did).
describe('the remembered place follows the layout, not the path (#735)', () => {
	const make = () => splitNode('s', 'row', ['a', 'b', 'c'].map(panel));
	const fresh = () =>
		dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());

	it('docked through the API, then floated again: back puts it at the new place', () => {
		const dock = fresh();
		dock.undockPanel('a');
		expect(dock.hasHome('a')).toBe(true);
		dock.dockPanel('a', 'c', 'right');
		expect(dock.hasHome('a')).toBe(false);
		dock.undockPanel('a');
		expect(dock.hasHome('a')).toBe(true);
		expect(dock.dockBack('a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c', 'a'] });
		expect(dock.hasHome('a')).toBe(false);
	});

	it('docked by `layout = ...`, or gone and loaded again floating: forgotten', () => {
		const dock = fresh();
		dock.undockPanel('a');
		const json = dock.serialize();
		dock.layout = { ...dock.layout, floating: [], docked: make() };
		expect(dock.hasHome('a')).toBe(false);
		// The saved layout with `a` floating: no place comes back with it (not saved).
		expect(dock.hydrate(json)).toBe(true);
		expect(dock.hasHome('a')).toBe(false);
	});

	// #738 review: the id stays floating across the swap, so the setter alone would keep it.
	it('another layout hydrated with the same pane floating: forgotten; a rejected one keeps it', () => {
		const dock = fresh();
		dock.undockPanel('a');
		expect(dock.hydrate('{ not json')).toBe(false);
		expect(dock.hydrate(JSON.stringify({ version: 4, floating: 1, docked: null }))).toBe(false);
		expect(dock.hasHome('a')).toBe(true);
		const other = dockWithDefault(
			{ version: 4, floating: [], docked: splitNode('t', 'column', ['a', 'b', 'c'].map(panel)) },
			counterMakeId()
		);
		other.undockPanel('a');
		expect(dock.hydrate(other.serialize())).toBe(true);
		expect(dock.layout.floating.some((w) => w.id === 'a')).toBe(true);
		expect(dock.hasHome('a')).toBe(false);
	});

	it('reset re-creating the same pane as a floating window: forgotten', () => {
		const dock = fresh();
		dock.undockPanel('a');
		dock.reset([{ id: 'a', title: 'A' }], 1000, 800);
		expect(dock.hasHome('a')).toBe(false);
	});

	it('hidden and shown in its new place: the old place is not kept', () => {
		const dock = fresh();
		dock.undockPanel('b');
		dock.dockPanel('b', 'c', 'right');
		dock.dismiss('b');
		expect(dock.show('b')).toBe('docked');
		expect(dock.hasHome('b')).toBe(false);
	});

	it('a floated window closed and opened again keeps its place (as before)', () => {
		const dock = fresh();
		dock.undockPanel('b');
		dock.close('b');
		expect(dock.hasHome('b')).toBe(true);
		dock.open('b');
		expect(dock.dockBack('b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
	});
});
