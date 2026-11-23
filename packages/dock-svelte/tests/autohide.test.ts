// @vitest-environment jsdom
//
// Auto-hide (#694 PR-3): a docked region (a panel or a tab group) leaves the
// tree for a band on the host's edge and goes back to its place. Covers the pure
// helpers (`core/autohide.ts`), `DockState`
// (layout JSON, panels, flyout, dismiss), `validateDockLayout` (older JSON, bad
// entries), and the order / refusal / stale rules of `PanelLifecycle.autoHide` /
// `restoreAutoHidden`.
import { describe, expect, it } from 'vitest';
import { autoHideEdge, mainRegionId, regionOf, regionRects } from '../src/core/autohide';
import { PanelLifecycle, type DockPanelChange } from '../src/core/lifecycle';
import { collectPanelIds, findNode, structureKey } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import type { DockLayout, DockNode } from '../src/types';

/** row[ L 0.2 | column[ M 0.7 / tabs T(B1, B2) 0.3 ] 0.6 | R 0.2 ] */
const tree = (): DockNode => ({
	type: 'split',
	id: 'root',
	direction: 'row',
	sizes: [0.2, 0.6, 0.2],
	children: [
		{ type: 'panel', id: 'L', title: 'L' },
		{
			type: 'split',
			id: 'mid',
			direction: 'column',
			sizes: [0.7, 0.3],
			children: [
				{ type: 'panel', id: 'M', title: 'M' },
				{
					type: 'tabs',
					id: 'T',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: 'B1', title: 'B1' },
						{ type: 'panel', id: 'B2', title: 'B2' }
					]
				}
			]
		},
		{ type: 'panel', id: 'R', title: 'R' }
	]
});

const layout = (): DockLayout => ({ version: 4, floating: [], docked: tree() });

describe('core/autohide: edge and main region', () => {
	it('picks the side seen from the main region, or from the middle', () => {
		const root = tree();
		expect(autoHideEdge(root, 'L', 'M')).toBe('left');
		expect(autoHideEdge(root, 'R', 'M')).toBe('right');
		expect(autoHideEdge(root, 'T', 'M')).toBe('bottom');
		expect(autoHideEdge(root, 'T', null)).toBe('bottom');
		expect(autoHideEdge(root, 'M', null)).toBe('top');
		// The main region itself is measured from the middle.
		expect(autoHideEdge(root, 'M', 'M')).toBe('top');
		// A lone region is in the middle: left.
		expect(autoHideEdge({ type: 'panel', id: 'x', title: 'X' }, 'x', null)).toBe('left');
	});

	it('measures regions on the split shares', () => {
		const rects = regionRects(tree());
		expect(rects.get('L')).toEqual({ x: 0, y: 0, w: 0.2, h: 1 });
		expect(rects.get('T')!.y).toBeCloseTo(0.7);
		expect(rects.has('B1')).toBe(false);
	});

	it('finds the first region whose panes are all main', () => {
		expect(mainRegionId(tree(), (id) => id === 'M')).toBe('M');
		expect(mainRegionId(tree(), (id) => id === 'B1')).toBeNull();
		expect(mainRegionId(tree(), (id) => id === 'B1' || id === 'B2')).toBe('T');
	});

	it('regionOf lifts a tab to its group', () => {
		expect(regionOf(tree(), 'B2')?.id).toBe('T');
		expect(regionOf(tree(), 'mid')).toBeNull();
	});
});

describe('DockState auto-hide', () => {
	it('moves a region to its band, saves it, and puts it back in its place', () => {
		const dock = createDockState(layout());
		expect(dock.autoHideRegion('B2', { mainId: 'M', size: 0.25 })).toBe(true);
		expect(dock.autoHidden).toHaveLength(1);
		expect(dock.autoHidden[0]).toMatchObject({ edge: 'bottom', size: 0.25, node: { id: 'T' } });
		expect(dock.isAutoHidden('B1')).toBe(true);
		expect(dock.isAutoHidden('T')).toBe(true);
		expect(dock.isVisible('B2')).toBe(true);
		const copy = createDockState(dock.serialize());
		expect(copy.autoHidden).toEqual(dock.autoHidden);
		expect(dock.restoreAutoHidden('B1')).toBe(true);
		expect(dock.layout.docked).toEqual(tree());
		expect('autoHidden' in dock.layout).toBe(false);
		expect(dock.serialize()).not.toContain('autoHidden');
	});

	it('docks at its edge when the remembered place is gone', () => {
		const dock = createDockState(layout());
		dock.autoHideRegion('L', { mainId: 'M' });
		dock.layout = { ...dock.layout, docked: { type: 'panel', id: 'M', title: 'M' } };
		dock.restoreAutoHidden('L');
		const root = dock.layout.docked!;
		expect(root.type === 'split' && root.direction).toBe('row');
		expect(root.type === 'split' && root.children.map((c) => c.id)).toEqual(['L', 'M']);
	});

	it('lists auto-hidden panes as visible docked rows and never adds them again', () => {
		const dock = createDockState(layout());
		dock.autoHideRegion('T');
		const rows = dock.panels.filter((p) => p.autoHidden);
		expect(rows.map((r) => r.id)).toEqual(['B1', 'B2']);
		expect(rows.every((r) => r.visible && r.placement === 'docked')).toBe(true);
		dock.ensureWindow({ id: 'B1', title: 'B1' }, 800, 600);
		dock.ensurePanel({ id: 'B2', title: 'B2' }, 800, 600);
		expect(dock.layout.floating).toHaveLength(0);
	});

	it('slides a pane out (a group shows it) and back; restore and dismiss clear it', () => {
		const dock = createDockState(layout());
		dock.autoHideRegion('T');
		const before = dock.structureRevision;
		dock.openFlyout('B2');
		expect(dock.flyoutPanel).toBe('B2');
		expect(dock.autoHidden[0].node.type === 'tabs' && dock.autoHidden[0].node.activeIndex).toBe(1);
		// The group's active pane (a structure change) and the slide-out (a mount change).
		expect(dock.structureRevision).toBe(before + 2);
		dock.closeFlyout();
		expect(dock.flyoutPanel).toBeNull();
		dock.openFlyout('T'); // a group id is not a pane
		expect(dock.flyoutPanel).toBeNull();
		expect(dock.show('B1')).toBe('docked');
		expect(dock.flyoutPanel).toBe('B1');
		dock.restoreAutoHidden('B1');
		expect(dock.flyoutPanel).toBeNull();
	});

	it('dismiss takes one pane out of its band as a closed window hidden from the dock: shown at its default place (#782 PR5)', () => {
		const dock = createDockState(layout());
		dock.defaultLayout = layout();
		dock.autoHideRegion('T');
		dock.openFlyout('B1');
		dock.dismiss('B1');
		expect(dock.flyoutPanel).toBeNull();
		expect(dock.autoHidden[0].node).toMatchObject({ type: 'panel', id: 'B2' });
		const win = dock.layout.floating.find((w) => w.id === 'B1')!;
		expect(win.open).toBe(false);
		// No place: only the share its region held when it went to the band.
		expect(win).not.toHaveProperty('dockSlot');
		expect(win.dockShare).toBeGreaterThan(0);
		expect(win.dockShare).toBeLessThan(1);
		dock.dismiss('B2');
		expect(dock.autoHidden).toHaveLength(0);
		// Both come back docked (not to the band), in the tab group of the default layout.
		expect(dock.show('B2')).toBe('docked');
		expect(dock.show('B1')).toBe('docked');
		expect(dock.layout.floating).toEqual([]);
		expect(collectPanelIds(dock.layout.docked)).toEqual(collectPanelIds(layout().docked));
		expect(findNode(dock.layout.docked, 'T')).toMatchObject({
			type: 'tabs',
			children: [{ id: 'B1' }, { id: 'B2' }]
		});
	});

	it('does nothing for a split, an unknown id, or a pane not auto-hidden', () => {
		const dock = createDockState(layout());
		expect(dock.autoHideRegion('mid')).toBe(false);
		expect(dock.autoHideRegion('nope')).toBe(false);
		expect(dock.restoreAutoHidden('L')).toBe(false);
		expect(dock.layout.docked).toEqual(tree());
	});

	it('counts the band in the structure key only when there is one', () => {
		const plain = layout();
		expect(JSON.parse(structureKey(plain))).toHaveLength(2);
		const dock = createDockState(layout());
		dock.autoHideRegion('R');
		expect(JSON.parse(structureKey(dock.layout))).toHaveLength(3);
	});
});

describe('validateDockLayout autoHidden', () => {
	const withBand = (entry: unknown): unknown => ({
		version: 4,
		floating: [],
		docked: { type: 'panel', id: 'M', title: 'M' },
		autoHidden: [entry]
	});
	const good = {
		node: { type: 'panel', id: 'L', title: 'L', collapsed: true },
		edge: 'left',
		size: 0.3
	};

	it('reads a layout without it (older JSON) and one with it, dropping `collapsed`', () => {
		const old = validateDockLayout(layout());
		expect(old.ok && 'autoHidden' in old.layout).toBe(false);
		const result = validateDockLayout(withBand(good));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.layout.autoHidden![0].node).toEqual({ type: 'panel', id: 'L', title: 'L' });
		const empty = validateDockLayout({ ...layout(), autoHidden: [] });
		expect(empty.ok && 'autoHidden' in empty.layout).toBe(false);
	});

	it('rejects bad entries and ids that collide with the tree', () => {
		const cases: [unknown, string][] = [
			[{ ...good, edge: 'middle' }, 'autoHidden[0].edge'],
			[{ ...good, size: 0 }, 'autoHidden[0].size'],
			[{ ...good, size: 'x' }, 'autoHidden[0].size'],
			[
				{ ...good, node: { type: 'split', id: 's', direction: 'row', children: [], sizes: [] } },
				'autoHidden[0].node'
			],
			[{ ...good, node: { type: 'panel', id: 'M', title: 'M' } }, 'autoHidden[0].node.id']
		];
		for (const [entry, path] of cases) {
			const result = validateDockLayout(withBand(entry));
			expect(result.ok).toBe(false);
			expect(!result.ok && result.issues.map((i) => i.path)).toContain(path);
		}
		expect(validateDockLayout({ ...layout(), autoHidden: {} }).ok).toBe(false);
	});

	it('rejects (does not throw on) a malformed tabs node in a band', () => {
		for (const node of [
			{ type: 'tabs', id: 'g' },
			{ type: 'tabs', id: 'g', activeIndex: 0, children: [null] }
		]) {
			const result = validateDockLayout(withBand({ ...good, node }));
			expect(result.ok).toBe(false);
		}
	});
});

describe('PanelLifecycle auto-hide requests', () => {
	function setup(hook?: (c: DockPanelChange) => boolean | Promise<boolean>, keep?: string[]) {
		const dock = createDockState(layout());
		const asked: DockPanelChange[] = [];
		const lifecycle = new PanelLifecycle(dock, () => ({
			beforePanelChange: (c) => {
				asked.push(c);
				return hook ? hook(c) : true;
			},
			keepMounted: (id) => keep?.includes(id) ?? false
		}));
		return { dock, lifecycle, asked };
	}

	it('asks the pane a shrinking split leaves first, then the mounted panes of the region', async () => {
		const { dock, lifecycle, asked } = setup(undefined, ['B2']);
		expect(await lifecycle.autoHide('B1', { mainId: 'M' })).toBe('applied');
		expect(asked).toEqual([
			{ kind: 'reparent', panelId: 'M', cause: 'B1', remount: true },
			{ kind: 'auto-hide', panelId: 'B1', to: 'band', remount: true },
			{ kind: 'auto-hide', panelId: 'B2', to: 'band', remount: true }
		]);
		expect(dock.autoHidden[0]).toMatchObject({ edge: 'bottom', node: { id: 'T' } });
	});

	it('a refusal leaves the tree as it was', async () => {
		const { dock, lifecycle } = setup((c) => c.kind !== 'reparent');
		expect(await lifecycle.autoHide('T')).toBe('refused');
		expect(dock.layout.docked).toEqual(tree());
		expect(dock.autoHidden).toHaveLength(0);
	});

	it('a structure change while the hook waits is stale', async () => {
		let release: (v: boolean) => void = () => {};
		const { dock, lifecycle } = setup(() => new Promise<boolean>((r) => (release = r)));
		const pending = lifecycle.autoHide('R');
		dock.setActiveTab('T', 1);
		release(true);
		expect(await pending).toBe('stale');
		expect(dock.isAutoHidden('R')).toBe(false);
	});

	it('pinning back asks the pushed-out pane, then the slid-out / kept panes', async () => {
		const { dock, lifecycle, asked } = setup(undefined, ['B2']);
		dock.autoHideRegion('T', { mainId: 'M' });
		dock.openFlyout('B1');
		asked.length = 0;
		expect(await lifecycle.restoreAutoHidden('B1')).toBe('applied');
		expect(asked).toEqual([
			{ kind: 'reparent', panelId: 'M', cause: 'B1', remount: true },
			{ kind: 'auto-hide', panelId: 'B1', to: 'tree', remount: true },
			{ kind: 'auto-hide', panelId: 'B2', to: 'tree', remount: true }
		]);
		expect(dock.layout.docked).toEqual(tree());
	});

	it('pinning back is stale when the flyout changes while the hook waits', async () => {
		let release: (v: boolean) => void = () => {};
		const { dock, lifecycle } = setup(() => new Promise<boolean>((r) => (release = r)));
		dock.autoHideRegion('L');
		dock.openFlyout('L');
		const pending = lifecycle.restoreAutoHidden('L');
		dock.closeFlyout();
		release(true);
		expect(await pending).toBe('stale');
		expect(dock.isAutoHidden('L')).toBe(true);
	});

	it('pinning back is stale after a close -> open of the same pane while the hook waits (re-mounted)', async () => {
		let release: (v: boolean) => void = () => {};
		let questions = 0;
		const { dock, lifecycle } = setup(() => {
			questions++;
			return new Promise<boolean>((r) => (release = r));
		});
		dock.autoHideRegion('L');
		dock.openFlyout('L');
		const pending = lifecycle.restoreAutoHidden('L');
		dock.closeFlyout();
		dock.openFlyout('L');
		expect(dock.flyoutPanel).toBe('L');
		release(true);
		expect(await pending).toBe('stale');
		expect(questions).toBe(1);
		expect(dock.isAutoHidden('L')).toBe(true);
	});

	it('opening the pane already slid out is not a new generation', () => {
		const { dock } = setup();
		dock.autoHideRegion('L');
		dock.openFlyout('L');
		const revision = dock.structureRevision;
		dock.openFlyout('L');
		expect(dock.structureRevision).toBe(revision);
		dock.closeFlyout();
		expect(dock.structureRevision).toBe(revision + 1);
		dock.closeFlyout();
		expect(dock.structureRevision).toBe(revision + 1);
	});

	it('hide / close of an auto-hidden pane are asked with remount, show slides it out', async () => {
		const { dock, lifecycle, asked } = setup(undefined, ['L']);
		dock.autoHideRegion('L');
		asked.length = 0;
		expect(await lifecycle.show('L')).toBe('applied');
		expect(dock.flyoutPanel).toBe('L');
		expect(asked).toEqual([]);
		expect(await lifecycle.hide('L')).toBe('applied');
		expect(asked).toEqual([{ kind: 'hide', panelId: 'L', remount: true }]);
		expect(dock.isAutoHidden('L')).toBe(false);
		expect(dock.layout.floating.find((w) => w.id === 'L')?.open).toBe(false);
	});
});
