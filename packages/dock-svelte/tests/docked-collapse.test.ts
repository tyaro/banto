// @vitest-environment jsdom
//
// Docked collapse (#663 ③-B): a panel / tab group that is a child of a split can be collapsed
// to a band. Covers the pure tree rules (when the flag is dropped, what can be collapsed),
// DockState (sizes untouched, show / slot / move do not carry it, JSON round trip), and the
// mounted DockedTree (button aria, one element across the toggle, focus hand-off, dividers next
// to a band, the pixel -> fraction unit, not a drop target).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import { dockWithDefault } from './fixtures/visibility-layouts';
import {
	canCollapseRegion,
	dockPanelIntoTree,
	expandRegionOf,
	normalizeCollapsed,
	removePanel,
	setRegionCollapsed
} from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import type {
	DockLayout,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode
} from '../src/types';

const restore: Array<() => void> = [];
function stub(proto: object, key: string, descriptor: PropertyDescriptor): void {
	const original = Object.getOwnPropertyDescriptor(proto, key);
	Object.defineProperty(proto, key, { configurable: true, ...descriptor });
	restore.push(() => {
		if (original) Object.defineProperty(proto, key, original);
		else delete (proto as Record<string, unknown>)[key];
	});
}

/** What `elementFromPoint` returns (the host when null). */
let hit: Element | null = null;

/** The width of a band in the stubbed layout (the split itself is 1000 wide). */
const BAND_PX = 40;

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	const size = (full: number) =>
		function (this: HTMLElement) {
			return this.classList.contains('split-child') && this.classList.contains('collapsed')
				? BAND_PX
				: full;
		};
	stub(HTMLElement.prototype, 'clientWidth', { get: size(1000) });
	stub(HTMLElement.prototype, 'clientHeight', { get: size(600) });
	stub(document, 'elementFromPoint', {
		value: () => hit ?? document.querySelector('[data-dock-host]')
	});
});

afterAll(() => {
	for (const undo of restore.reverse()) undo();
});

afterEach(() => {
	hit = null;
	cleanup();
});

function firePointer(target: EventTarget, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0 });
	target.dispatchEvent(ev);
}

const panel = (id: string, collapsed?: boolean): DockPanelNode => ({
	type: 'panel',
	id,
	title: id.toUpperCase(),
	...(collapsed ? { collapsed } : {})
});
const tabs = (
	id: string,
	ids: string[],
	collapsed?: boolean,
	activeIndex = 0
): DockTabGroupNode => ({
	type: 'tabs',
	id,
	children: ids.map((i) => panel(i)),
	activeIndex,
	...(collapsed ? { collapsed } : {})
});
const split = (
	id: string,
	direction: 'row' | 'column',
	children: DockNode[],
	sizes?: number[]
): DockSplitNode => ({
	type: 'split',
	id,
	direction,
	children,
	sizes: sizes ?? children.map(() => 1 / children.length)
});
const layoutOf = (docked: DockNode | null): DockLayout => ({ version: 4, floating: [], docked });

describe('tree: collapsed rules', () => {
	it('keeps the flag only on a split child that has an open sibling', () => {
		const ok = split('s', 'row', [panel('a', true), panel('b')]);
		expect(normalizeCollapsed(ok)).toBe(ok);
	});

	it('drops it on a root region and on a panel inside a tab group', () => {
		expect(normalizeCollapsed(panel('a', true))).toEqual(panel('a'));
		const group = tabs('g', ['a', 'b']);
		(group.children[0] as DockPanelNode).collapsed = true;
		expect((normalizeCollapsed(group) as DockTabGroupNode).children[0].collapsed).toBeUndefined();
		const rootGroup = normalizeCollapsed(tabs('g', ['a', 'b'], true)) as DockTabGroupNode;
		expect(rootGroup.collapsed).toBeUndefined();
	});

	it('drops every flag of a split whose children are all collapsed', () => {
		const out = normalizeCollapsed(
			split('s', 'row', [panel('a', true), tabs('g', ['b', 'c'], true)])
		) as DockSplitNode;
		expect(out.children.map((c) => (c.type === 'split' ? false : c.collapsed))).toEqual([
			undefined,
			undefined
		]);
	});

	it('a split sibling counts as open (and nested splits are checked on their own)', () => {
		const inner = split('i', 'column', [panel('x', true), panel('y')]);
		const tree = split('s', 'row', [panel('a', true), inner]);
		expect(normalizeCollapsed(tree)).toBe(tree);
		// the inner split has no open child left -> only ITS flags go
		const bad = split('s', 'row', [
			panel('a', true),
			split('i', 'column', [panel('x', true), panel('y', true)])
		]);
		const out = normalizeCollapsed(bad) as DockSplitNode;
		expect((out.children[0] as DockPanelNode).collapsed).toBe(true);
		const innerOut = out.children[1] as DockSplitNode;
		expect(innerOut.children.every((c) => (c as DockPanelNode).collapsed === undefined)).toBe(true);
	});

	it('canCollapseRegion: not the root, not the last open child, not a split, not a tab', () => {
		const tree = split('s', 'row', [panel('a'), tabs('g', ['b', 'c']), panel('d', true)]);
		expect(canCollapseRegion(tree, 'a')).toBe(true);
		expect(canCollapseRegion(tree, 'g')).toBe(true);
		expect(canCollapseRegion(tree, 'd')).toBe(true); // already collapsed: stays valid
		expect(canCollapseRegion(tree, 's')).toBe(false);
		expect(canCollapseRegion(tree, 'b')).toBe(false); // a tab
		expect(canCollapseRegion(panel('a'), 'a')).toBe(false);
		expect(canCollapseRegion(tree, 'nope')).toBe(false);
		const two = split('s', 'row', [panel('a', true), panel('b')]);
		expect(canCollapseRegion(two, 'b')).toBe(false); // the last open one
	});

	it('setRegionCollapsed leaves sizes alone, refuses the last open child, expands', () => {
		const tree = split('s', 'column', [panel('a'), panel('b')], [0.3, 0.7]);
		const once = setRegionCollapsed(tree, 'a', true) as DockSplitNode;
		expect(once.sizes).toEqual([0.3, 0.7]);
		expect((once.children[0] as DockPanelNode).collapsed).toBe(true);
		expect(setRegionCollapsed(once, 'b', true)).toBe(once);
		const back = setRegionCollapsed(once, 'a', false) as DockSplitNode;
		expect('collapsed' in back.children[0]).toBe(false);
		expect(back.sizes).toEqual([0.3, 0.7]);
	});

	it('expandRegionOf reaches the group of a tab and the panel itself', () => {
		const tree = split('s', 'row', [tabs('g', ['b', 'c'], true), panel('a')]);
		const out = expandRegionOf(tree, 'c') as DockSplitNode;
		expect((out.children[0] as DockTabGroupNode).collapsed).toBeUndefined();
		const bare = split('s', 'row', [panel('a', true), panel('b')]);
		const out2 = expandRegionOf(bare, 'a') as DockSplitNode;
		expect((out2.children[0] as DockPanelNode).collapsed).toBeUndefined();
	});

	it('removing the last open sibling expands the rest, removing one of three keeps the flag', () => {
		const three = split('s', 'row', [panel('a', true), panel('b'), panel('c')]);
		const fewer = normalizeCollapsed(removePanel(three, 'b')) as DockSplitNode;
		expect((fewer.children[0] as DockPanelNode).collapsed).toBe(true);
		const two = split('s', 'row', [panel('a', true), panel('b')]);
		// the split disappears and `a` becomes the root: not collapsed
		const lone = removePanel(two, 'b') as DockPanelNode;
		expect(lone.id).toBe('a');
		expect(lone.collapsed).toBeUndefined();
	});

	it('a collapsed tab group that shrinks to one panel stays collapsed on that panel', () => {
		const tree = split('s', 'row', [tabs('g', ['b', 'c'], true), panel('a')]);
		const out = removePanel(tree, 'c') as DockSplitNode;
		expect(out.children[0]).toMatchObject({ type: 'panel', id: 'b', collapsed: true });
	});

	it('a lone child lifted out of a split into a bigger split is expanded', () => {
		const inner = split('i', 'column', [panel('x', true), panel('y')]);
		const tree = split('s', 'row', [panel('a'), inner]);
		const out = removePanel(tree, 'y') as DockSplitNode;
		expect(out.children[1]).toMatchObject({ type: 'panel', id: 'x' });
		expect((out.children[1] as DockPanelNode).collapsed).toBeUndefined();
	});

	it('a drop onto a collapsed target expands it; a dropped panel brings no flag', () => {
		const tree = split('s', 'row', [panel('a', true), panel('b')]);
		const center = dockPanelIntoTree(
			tree,
			panel('z', true),
			'a',
			'center',
			() => 't'
		) as DockSplitNode;
		const group = center.children[0] as DockTabGroupNode;
		expect(group.type).toBe('tabs');
		expect(group.collapsed).toBeUndefined();
		expect(group.children.every((c) => c.collapsed === undefined)).toBe(true);
		const withGroup = split('s', 'row', [tabs('g', ['a', 'b'], true), panel('c')]);
		const appended = dockPanelIntoTree(withGroup, panel('z'), 'g', 'center') as DockSplitNode;
		expect((appended.children[0] as DockTabGroupNode).collapsed).toBeUndefined();
	});
});

describe('DockState: docked collapse', () => {
	// The layout it starts with is its default layout: where a hidden pane is shown again (#782 PR5).
	const make = () =>
		dockWithDefault(
			layoutOf(split('s', 'row', [panel('a'), tabs('g', ['b', 'c']), panel('d')], [0.2, 0.5, 0.3]))
		);

	it('collapses and expands without touching sizes, and drops the field on expand', () => {
		const dock = make();
		expect(dock.isDockedCollapsed('a')).toBe(false);
		expect(dock.canCollapseDocked('a')).toBe(true);
		dock.setDockedCollapsed('a', true);
		expect(dock.isDockedCollapsed('a')).toBe(true);
		expect((dock.layout.docked as DockSplitNode).sizes).toEqual([0.2, 0.5, 0.3]);
		dock.setDockedCollapsed('a', false);
		expect(dock.serialize()).not.toContain('collapsed');
	});

	it('is a no-op for the last open region, a root region, a tab and unknown ids', () => {
		const dock = make();
		dock.setDockedCollapsed('a', true);
		dock.setDockedCollapsed('g', true);
		const before = dock.layout;
		dock.setDockedCollapsed('d', true); // the last open one
		dock.setDockedCollapsed('b', true); // a tab
		dock.setDockedCollapsed('nope', true);
		expect(dock.layout).toBe(before);
		expect(dock.canCollapseDocked('d')).toBe(false);
		const root = createDockState(layoutOf(panel('only')));
		root.setDockedCollapsed('only', true);
		expect(root.isDockedCollapsed('only')).toBe(false);
		expect(root.canCollapseDocked('only')).toBe(false);
	});

	it('does not confuse the floating collapse with the docked one', () => {
		const dock = createDockState({
			version: 4,
			floating: [{ id: 'f', title: 'F', x: 0, y: 0, width: 100, height: 100, open: true }],
			docked: split('s', 'row', [panel('a'), panel('b')])
		});
		dock.setDockedCollapsed('f', true);
		expect(dock.isCollapsed('f')).toBe(false);
		dock.setCollapsed('a', true);
		expect(dock.isDockedCollapsed('a')).toBe(false);
	});

	it('closing the last open neighbour expands the collapsed region (every assignment is normalized)', () => {
		const dock = createDockState(layoutOf(split('s', 'row', [panel('a'), panel('b'), panel('c')])));
		dock.setDockedCollapsed('a', true);
		dock.setDockedCollapsed('b', true);
		dock.dismiss('c');
		expect(dock.isDockedCollapsed('a')).toBe(false);
		expect(dock.isDockedCollapsed('b')).toBe(false);
	});

	it('hydrate drops a flag that does not fit and keeps one that does', () => {
		const dock = createDockState();
		const json = JSON.stringify(layoutOf(split('s', 'row', [panel('a', true), panel('b', true)])));
		expect(dock.hydrate(json)).toBe(true);
		expect(dock.serialize()).not.toContain('collapsed');
		const good = JSON.stringify(layoutOf(split('s', 'row', [panel('a', true), panel('b')])));
		expect(dock.hydrate(good)).toBe(true);
		expect(dock.isDockedCollapsed('a')).toBe(true);
		// round trip
		const again = createDockState(dock.serialize());
		expect(again.isDockedCollapsed('a')).toBe(true);
	});

	it('an old layout without the field reads as expanded', () => {
		const dock = createDockState(layoutOf(split('s', 'row', [panel('a'), panel('b')])));
		expect(dock.isDockedCollapsed('a')).toBe(false);
	});

	it('show expands the region that holds the pane (bare panel, tab group)', () => {
		const dock = make();
		dock.setDockedCollapsed('a', true);
		dock.setDockedCollapsed('g', true);
		expect(dock.show('c')).toBe('docked');
		expect(dock.isDockedCollapsed('g')).toBe(false);
		expect((dock.layout.docked as DockSplitNode).children[1]).toMatchObject({ activeIndex: 1 });
		expect(dock.isDockedCollapsed('a')).toBe(true);
		dock.show('a');
		expect(dock.isDockedCollapsed('a')).toBe(false);
	});

	it('showing a hidden pane that goes back into a collapsed group expands that group', () => {
		const dock = make();
		dock.dismiss('c');
		dock.setDockedCollapsed('g', true);
		expect(dock.layout.docked && (dock.layout.docked as DockSplitNode).children[1].type).toBe(
			'panel'
		);
		// the group collapsed into the bare panel `b`; collapse it and show `c` again
		dock.setDockedCollapsed('b', true);
		expect(dock.isDockedCollapsed('b')).toBe(true);
		expect(dock.show('c')).toBe('docked');
		const regions = (dock.layout.docked as DockSplitNode).children;
		const regroup = regions.find((r) => r.type === 'tabs') as DockTabGroupNode;
		expect(regroup.children.map((p) => p.id).sort()).toEqual(['b', 'c']);
		expect(regroup.collapsed).toBeUndefined();
		expect(dock.isDockedCollapsed(regroup.id)).toBe(false);
	});

	it('a collapsed pane that is hidden and shown again does not come back collapsed', () => {
		const dock = make();
		dock.setDockedCollapsed('a', true);
		dock.dismiss('a');
		expect(dock.layout.floating[0].dockShare).toBeDefined();
		expect(JSON.stringify(dock.layout.floating[0])).not.toContain('collapsed');
		dock.show('a');
		expect(dock.isDockedCollapsed('a')).toBe(false);
	});

	it('moving or floating a collapsed pane never carries the flag', () => {
		const dock = make();
		dock.setDockedCollapsed('a', true);
		dock.dockExisting('a', 'd', 'bottom');
		expect(JSON.stringify(dock.layout.docked)).not.toContain('"a","title":"A","collapsed"');
		expect(dock.isDockedCollapsed('a')).toBe(false);
		dock.setDockedCollapsed('d', true);
		dock.undockPanel('d');
		expect(dock.layout.floating[0].collapsed).toBeUndefined();
		dock.dockPanel('d', 'g', 'center');
		expect(dock.isDockedCollapsed('d')).toBe(false);
	});
});

describe('validate: collapsed', () => {
	it('rejects a non-boolean collapsed on a panel and on a tab group', () => {
		const bad = layoutOf(split('s', 'row', [panel('a'), tabs('g', ['b', 'c'])]));
		const nodes = (bad.docked as DockSplitNode).children as unknown as Record<string, unknown>[];
		nodes[0].collapsed = 'yes';
		nodes[1].collapsed = 1;
		const result = validateDockLayout(bad);
		expect(result.ok).toBe(false);
		const paths = !result.ok ? result.issues.map((i) => i.path) : [];
		expect(paths).toContain('docked.children[0].collapsed');
		expect(paths).toContain('docked.children[1].collapsed');
	});

	it('accepts true / false and normalizes false-like flags that do not fit', () => {
		const ok = validateDockLayout(
			layoutOf(split('s', 'row', [panel('a', true), tabs('g', ['b', 'c'], true), panel('d')]))
		);
		expect(ok.ok).toBe(true);
	});
});

describe('DockedTree: collapse button and band', () => {
	const row = (collapsedIds: string[] = []): DockLayout =>
		layoutOf(
			split(
				's',
				'row',
				[
					panel('a', collapsedIds.includes('a')),
					panel('b', collapsedIds.includes('b')),
					tabs('g', ['c', 'd'], collapsedIds.includes('g'))
				],
				[0.2, 0.4, 0.4]
			)
		);
	const frameOf = (name: string) => screen.getByRole('group', { name });

	it('has aria-expanded, aria-controls to the body, and the label of the pane', () => {
		render(DockHostHarness, { dock: createDockState(row()) });
		const button = screen.getByRole('button', { name: 'Aを帯に折りたたむ' });
		const body = frameOf('A').querySelector('.body') as HTMLElement;
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-controls')).toBe(body.id);
		expect(body.id).not.toBe('');
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it('the tab group button names the front tab', () => {
		render(DockHostHarness, { dock: createDockState(row()) });
		expect(screen.getByRole('button', { name: 'Cを帯に折りたたむ' })).toBeTruthy();
	});

	it('is one element across the toggle and keeps the DOM focus when pressed', () => {
		const dock = createDockState(row());
		render(DockHostHarness, { dock });
		const button = screen.getByRole('button', { name: 'Aを帯に折りたたむ' });
		button.focus();
		button.click();
		flushSync();
		expect(dock.isDockedCollapsed('a')).toBe(true);
		const same = screen.getByRole('button', { name: 'Aを帯から展開' });
		expect(same).toBe(button);
		expect(document.activeElement).toBe(button);
		expect(button.getAttribute('aria-expanded')).toBe('false');
		button.click();
		flushSync();
		expect(dock.isDockedCollapsed('a')).toBe(false);
		expect(screen.getByRole('button', { name: 'Aを帯に折りたたむ' })).toBe(button);
		expect(document.activeElement).toBe(button);
	});

	it('keeps the content mounted but hidden and inert; no pop-out / close in the band', () => {
		const dock = createDockState(row());
		render(DockHostHarness, { dock });
		const input = screen.getByLabelText('A input');
		dock.setDockedCollapsed('a', true);
		flushSync();
		expect(document.querySelector('input[aria-label="A input"]')).toBe(input);
		const body = frameOf('A').querySelector('.body') as HTMLElement & { inert?: boolean };
		expect(body.hidden).toBe(true);
		expect(body.inert).toBe(true);
		expect(frameOf('A').querySelector('.close-btn')).toBeNull();
		expect(frameOf('A').classList.contains('band-row')).toBe(true);
	});

	it('is disabled for the last open region and re-enabled when another is expanded', () => {
		const dock = createDockState(row(['a', 'b']));
		render(DockHostHarness, { dock });
		const last = screen.getByRole('button', { name: 'Cを帯に折りたたむ' }) as HTMLButtonElement;
		expect(last.disabled).toBe(true);
		const expandA = screen.getByRole('button', { name: 'Aを帯から展開' }) as HTMLButtonElement;
		expect(expandA.disabled).toBe(false);
		expandA.click();
		flushSync();
		expect(last.disabled).toBe(false);
	});

	it('is disabled for a lone root region', () => {
		render(DockHostHarness, { dock: createDockState(layoutOf(panel('only'))) });
		const button = screen.getByRole('button', {
			name: 'ONLYを帯に折りたたむ'
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it('a tab group band shows the front tab and is not a drop target', () => {
		const dock = createDockState(row(['g']));
		render(DockHostHarness, { dock });
		const group = frameOf('C');
		expect(group.querySelector('[role="tablist"]')).toBeNull();
		expect(group.querySelector('.tab-header .title')?.textContent).toBe('C');
		expect(group.hasAttribute('data-dock-drop-id')).toBe(false);
		expect(group.hasAttribute('data-dock-no-drop')).toBe(true);
		expect(frameOf('B').getAttribute('data-dock-drop-id')).toBe('b');
		// both tabs stay mounted
		expect(document.querySelector('input[aria-label="C input"]')).not.toBeNull();
		expect(document.querySelector('input[aria-label="D input"]')).toBeNull();
	});

	it('a column split gets a horizontal band', () => {
		const dock = createDockState(
			layoutOf(split('s', 'column', [panel('a', true), panel('b')], [0.5, 0.5]))
		);
		render(DockHostHarness, { dock });
		expect(frameOf('A').classList.contains('band-row')).toBe(false);
		expect(frameOf('A').classList.contains('collapsed')).toBe(true);
	});

	it('the band does not start a drag', () => {
		const dock = createDockState(row(['a']));
		render(DockHostHarness, { dock });
		const titlebar = frameOf('A').querySelector('.titlebar') as HTMLElement;
		firePointer(titlebar, 'pointerdown', 10, 10);
		firePointer(window, 'pointermove', 400, 300);
		firePointer(window, 'pointerup', 400, 300);
		expect(dock.layout.floating).toHaveLength(0);
		expect(document.querySelector('.ghost, [data-dock-ghost]')).toBeNull();
	});

	it('a drop on a band does nothing: not a pane to drop onto, and not free space either', () => {
		const dock = createDockState(row(['a']));
		render(DockHostHarness, { dock });
		const before = dock.layout;
		firePointer(frameOf('B').querySelector('.titlebar')!, 'pointerdown', 300, 10);
		firePointer(window, 'pointermove', 100, 100);
		hit = frameOf('A').querySelector('.titlebar');
		firePointer(window, 'pointermove', 10, 100);
		firePointer(window, 'pointerup', 10, 100);
		expect(dock.layout).toBe(before);
		expect(dock.layout.floating).toHaveLength(0);
	});

	it('control: the same drop on free space of the host floats the pane', () => {
		const dock = createDockState(row(['a']));
		render(DockHostHarness, { dock });
		firePointer(frameOf('B').querySelector('.titlebar')!, 'pointerdown', 300, 10);
		firePointer(window, 'pointermove', 100, 100);
		firePointer(window, 'pointerup', 10, 100);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['b']);
	});

	it('moves focus from the body (also on an API collapse) to the button; leaves other focus alone', () => {
		const dock = createDockState(row());
		render(DockHostHarness, { dock });
		const input = screen.getByLabelText('A input');
		input.focus();
		dock.setDockedCollapsed('a', true);
		flushSync();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aを帯から展開' }));
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();
		dock.setDockedCollapsed('b', true);
		flushSync();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('moves focus from a tab (strip replaced) to the button', () => {
		const dock = createDockState(row());
		render(DockHostHarness, { dock });
		const tab = screen.getByRole('tab', { name: 'C' });
		tab.focus();
		dock.setDockedCollapsed('g', true);
		flushSync();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cを帯から展開' }));
	});

	it('closing the last open neighbour expands the band and the button follows', () => {
		const dock = createDockState(row(['a', 'b']));
		render(DockHostHarness, { dock });
		dock.dismiss('c');
		dock.dismiss('d');
		flushSync();
		expect(dock.isDockedCollapsed('a')).toBe(false);
		expect(dock.isDockedCollapsed('b')).toBe(false);
		expect(screen.getByRole('button', { name: 'Aを帯に折りたたむ' })).toBeTruthy();
	});
});

describe('DockedTree: dividers next to a band', () => {
	const sizes = (dock: ReturnType<typeof createDockState>) =>
		(dock.layout.docked as DockSplitNode).sizes;
	const mount = (collapsedIds: string[]) => {
		const dock = createDockState(
			layoutOf(
				split(
					's',
					'row',
					[
						panel('a', collapsedIds.includes('a')),
						panel('b', collapsedIds.includes('b')),
						panel('c', collapsedIds.includes('c'))
					],
					[0.2, 0.4, 0.4]
				)
			)
		);
		render(DockHostHarness, { dock });
		return dock;
	};
	const press = (el: HTMLElement, key: string) =>
		el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

	it('a divider that touches a band is disabled; the other one is not', () => {
		mount(['a']);
		const [first, second] = screen.getAllByRole('separator');
		expect(first.getAttribute('aria-disabled')).toBe('true');
		expect(first.getAttribute('tabindex')).toBe('-1');
		expect(second.hasAttribute('aria-disabled')).toBe(false);
		expect(second.getAttribute('tabindex')).toBe('0');
	});

	it('does not move by pointer or keyboard while locked', () => {
		const dock = mount(['a']);
		const first = screen.getAllByRole('separator')[0];
		firePointer(first, 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		firePointer(window, 'pointerup', 600, 100);
		press(first, 'ArrowRight');
		press(first, 'End');
		expect(sizes(dock)).toEqual([0.2, 0.4, 0.4]);
	});

	it('the other divider converts pixels with only the room the open children share', () => {
		const dock = mount(['a']);
		const second = screen.getAllByRole('separator')[1];
		firePointer(second, 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 596, 100);
		firePointer(window, 'pointerup', 596, 100);
		// 96px of the (1000 - 40) open px, which share sizes 0.4 + 0.4: 96 / 960 * 0.8 = 0.08
		expect(sizes(dock)[1]).toBeCloseTo(0.48);
		expect(sizes(dock)[2]).toBeCloseTo(0.32);
		expect(sizes(dock)[0]).toBe(0.2);
	});

	it('the open children grow to fill the room the band leaves (grow factors normalized)', () => {
		const dock = mount(['a']);
		const grows = [...document.querySelectorAll<HTMLElement>('.dock-split > .split-child')].map(
			(el) => el.style.flexGrow
		);
		// sizes 0.4 + 0.4 of the open children add up to 0.8: each grows by 0.5, together 1
		expect(grows).toEqual(['0', '0.5', '0.5']);
		expect(sizes(dock)).toEqual([0.2, 0.4, 0.4]);
	});

	it('without a band the plain px / size is used (unchanged)', () => {
		const dock = mount([]);
		const second = screen.getAllByRole('separator')[1];
		firePointer(second, 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		firePointer(window, 'pointerup', 600, 100);
		expect(sizes(dock)[1]).toBeCloseTo(0.5);
	});

	it('a keyboard step of the open divider is a share of the visible split', () => {
		const dock = mount(['a']);
		const second = screen.getAllByRole('separator')[1];
		press(second, 'ArrowRight');
		// 2% of 1000px = 20px of 960px open px, shared by 0.8 of sizes
		expect(sizes(dock)[1]).toBeCloseTo(0.4 + (20 / 960) * 0.8);
	});

	it('collapsing a region next to the divider mid-drag cancels the drag', () => {
		const dock = mount([]);
		const second = screen.getAllByRole('separator')[1];
		firePointer(second, 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 560, 100);
		expect(sizes(dock)[1]).toBeCloseTo(0.46);
		dock.setDockedCollapsed('c', true);
		flushSync();
		expect(sizes(dock)).toEqual([0.2, 0.4, 0.4]);
		firePointer(window, 'pointermove', 700, 100);
		firePointer(window, 'pointerup', 700, 100);
		expect(sizes(dock)).toEqual([0.2, 0.4, 0.4]);
		// the owner is free again
		dock.setDockedCollapsed('c', false);
		flushSync();
		firePointer(screen.getAllByRole('separator')[1], 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 550, 100);
		expect(sizes(dock)[1]).toBeCloseTo(0.45);
		firePointer(window, 'pointerup', 550, 100);
	});
});

describe('DockHost: showPanel expands a band', () => {
	it('showPanel / setPanelVisible(true) on a collapsed docked pane expands it', async () => {
		const dock = createDockState(
			layoutOf(split('s', 'row', [panel('a', true), tabs('g', ['b', 'c'], true), panel('d')]))
		);
		const { component } = render(DockHostHarness, { dock });
		const host = (
			component as unknown as {
				host(): {
					showPanel(id: string): Promise<string>;
					setPanelVisible(id: string, v: boolean): Promise<string>;
				};
			}
		).host();
		expect(await host.showPanel('a')).toBe('applied');
		expect(dock.isDockedCollapsed('a')).toBe(false);
		expect(await host.setPanelVisible('c', true)).toBe('applied');
		expect(dock.isDockedCollapsed('g')).toBe(false);
		expect((dock.layout.docked as DockSplitNode).children[1]).toMatchObject({ activeIndex: 1 });
	});

	it('showing the already-front tab of a collapsed group expands it too', async () => {
		const dock = createDockState(
			layoutOf(split('s', 'row', [tabs('g', ['b', 'c'], true), panel('d')]))
		);
		const { component } = render(DockHostHarness, { dock });
		const host = (
			component as unknown as { host(): { showPanel(id: string): Promise<string> } }
		).host();
		expect(await host.showPanel('b')).toBe('applied');
		expect(dock.isDockedCollapsed('g')).toBe(false);
	});

	it('a refused tab switch leaves the band collapsed', async () => {
		const dock = createDockState(
			layoutOf(split('s', 'row', [tabs('g', ['b', 'c'], true), panel('d')]))
		);
		const { component } = render(DockHostHarness, {
			dock,
			beforePanelChange: () => false
		});
		const host = (
			component as unknown as { host(): { showPanel(id: string): Promise<string> } }
		).host();
		expect(await host.showPanel('c')).toBe('refused');
		expect(dock.isDockedCollapsed('g')).toBe(true);
	});
});
