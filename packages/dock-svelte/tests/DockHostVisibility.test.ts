// @vitest-environment jsdom
//
// The View-menu side of DockHost (#663 ①-A): `dock.panels` is reactive (a
// menu's checkboxes follow the ✕ button); `setPanelVisible(id, false)` is the
// ✕ path (keepMounted = hide, otherwise close, asked through
// `beforePanelChange`, `capabilities.close: false` refused); `true` /
// `showPanel` re-docks a hidden pane into its remembered place.
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import PanelsMenuHarness from './PanelsMenuHarness.svelte';
import { collectPanelIds } from '../src/core/tree';
import type { DockPanelChange } from '../src/core/lifecycle';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockTabGroupNode } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const layout = (): DockLayout => ({
	version: 2,
	floating: [],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.3, 0.7],
		children: [
			{ type: 'panel', id: 'a', title: 'A' },
			{ type: 'panel', id: 'b', title: 'B' }
		]
	}
});

function mount(props: Record<string, unknown> = {}, initial: DockLayout = layout()) {
	const dock = createDockState(initial);
	const view = render(DockHostHarness, { dock, ...props });
	const host = () => view.component.host();
	render(PanelsMenuHarness, {
		dock,
		onToggle: (id: string, visible: boolean) => void host().setPanelVisible(id, visible)
	});
	return { dock, host };
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const docked = (dock: DockState) => collectPanelIds(dock.layout.docked);

describe('a View menu built on dock.panels', () => {
	it('follows the ✕ button, and checking re-docks the pane in its old place', async () => {
		const { dock } = mount();
		expect(checkbox('A').checked).toBe(true);

		(screen.getByRole('button', { name: 'Aを閉じる' }) as HTMLButtonElement).click();
		flushSync();
		expect(checkbox('A').checked).toBe(false);
		expect(checkbox('A').dataset.placement).toBe('docked');

		checkbox('A').click();
		await Promise.resolve();
		flushSync();
		expect(docked(dock)).toEqual(['a', 'b']);
		expect((dock.layout.docked as { sizes: number[] }).sizes[0]).toBeCloseTo(0.3);
		expect(checkbox('A').checked).toBe(true);
	});

	it('unchecking is the ✕ path: close, asked through beforePanelChange (a veto keeps it)', async () => {
		const calls: DockPanelChange[] = [];
		let allow = false;
		const { dock, host } = mount({
			beforePanelChange: (c: DockPanelChange) => (calls.push(c), allow)
		});

		expect(await host().setPanelVisible('a', false)).toBe('refused');
		// The split shrinks to B, which is mounted again: asked first (#682).
		expect(calls).toEqual([{ kind: 'reparent', panelId: 'b', cause: 'a', remount: true }]);
		expect(docked(dock)).toEqual(['a', 'b']);

		allow = true;
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(docked(dock)).toEqual(['b']);
		expect(dock.isVisible('a')).toBe(false);
		expect(calls).toHaveLength(3); // reparent b (refused), reparent b, close a
		// Already hidden: nothing to ask.
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(calls).toHaveLength(3);
	});

	it('unchecking a keepMounted pane hides it (hide, not close)', async () => {
		const calls: DockPanelChange[] = [];
		const { dock, host } = mount({
			beforePanelChange: (c: DockPanelChange) => (calls.push(c), true),
			keepMounted: (id: string) => id === 'a'
		});
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(calls).toEqual([
			{ kind: 'reparent', panelId: 'b', cause: 'a', remount: true },
			{ kind: 'hide', panelId: 'a', remount: true }
		]);
		expect(dock.isVisible('a')).toBe(false);

		// Its content is still mounted (hidden) in the floating layer: re-docking it is asked as a dock,
		// after the bare pane B that a split is re-made around (re-mounted, #666).
		expect(await host().showPanel('a')).toBe('applied');
		expect(calls.slice(2)).toEqual([
			{ kind: 'reparent', panelId: 'b', cause: 'a', remount: true },
			{ kind: 'dock', panelId: 'a', remount: true }
		]);
		expect(docked(dock)).toEqual(['a', 'b']);
	});

	it('a pane with capabilities.close: false is not taken off the screen', async () => {
		const { dock, host } = mount({
			capabilities: (id: string) => (id === 'a' ? { close: false } : undefined)
		});
		expect(await host().setPanelVisible('a', false)).toBe('refused');
		expect(docked(dock)).toEqual(['a', 'b']);
	});

	it('showPanel of an unknown id is stale and changes nothing', async () => {
		const { dock, host } = mount();
		const before = dock.serialize();
		expect(await host().showPanel('nope')).toBe('stale');
		expect(dock.serialize()).toBe(before);
	});
});

// PR #665 review (Codex P1): re-docking into a tab group makes the reopened
// pane the active tab, which unmounts the active one - asked like a tab click.
describe('showPanel into a tab group', () => {
	const tabsLayout = (): DockLayout => ({
		version: 2,
		floating: [],
		docked: {
			type: 'tabs',
			id: 't',
			activeIndex: 0,
			children: [
				{ type: 'panel', id: 'a', title: 'A' },
				{ type: 'panel', id: 'b', title: 'B' },
				{ type: 'panel', id: 'c', title: 'C' }
			]
		}
	});
	const group = (dock: DockState) => dock.layout.docked as DockTabGroupNode;

	it('asks a tab-switch from the active pane: a veto keeps it hidden, an approval re-docks it active', async () => {
		const calls: DockPanelChange[] = [];
		let allowSwitch = false;
		const { dock, host } = mount(
			{
				beforePanelChange: (c: DockPanelChange) => (
					calls.push(c),
					c.kind === 'tab-switch' ? allowSwitch : true
				)
			},
			tabsLayout()
		);
		expect(await host().setPanelVisible('b', false)).toBe('applied');
		const before = dock.serialize();

		expect(await host().showPanel('b')).toBe('refused');
		expect(calls[1]).toEqual({
			kind: 'tab-switch',
			groupId: 't',
			from: 'a',
			to: 'b',
			remount: true
		});
		expect(dock.serialize()).toBe(before);
		expect(checkbox('B').checked).toBe(false);

		allowSwitch = true;
		expect(await host().setPanelVisible('b', true)).toBe('applied');
		flushSync();
		expect(group(dock).children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
		expect(group(dock).activeIndex).toBe(1);
		expect(checkbox('B').checked).toBe(true);
	});
});

// PR #681 review (Codex P2): an open floating window is brought to the front, as before #666.
describe('showPanel of an open floating window', () => {
	const withWindows = (): DockLayout => ({
		...layout(),
		floating: [
			{ id: 'f', title: 'F', x: 40, y: 40, width: 300, height: 200, open: true },
			{ id: 'g', title: 'G', x: 80, y: 80, width: 300, height: 200, open: true }
		]
	});

	it('brings it to the front without asking, and setPanelVisible(true) is applied', async () => {
		const calls: DockPanelChange[] = [];
		const { dock, host } = mount(
			{ beforePanelChange: (c: DockPanelChange) => (calls.push(c), false) },
			withWindows()
		);
		expect(await host().showPanel('f')).toBe('applied');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['g', 'f']);
		expect(await host().setPanelVisible('g', true)).toBe('applied');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f', 'g']);
		expect(calls).toEqual([]);
		expect(docked(dock)).toEqual(['a', 'b']);
	});
});

// #739 review (Codex): a whole saved layout put in by `replaceLayout` has shares that do not count
// the floated panes' places of the layout replaced, so those places are dropped, as by `hydrate`.
describe('replaceLayout with a saved layout drops the floated panes places (#739 review)', () => {
	it('row[a .2, b .3, c .5]: float a, hide b, replace with the saved layout, show b -> 3 : 5', async () => {
		const panel = (id: string) => ({ type: 'panel' as const, id, title: id });
		const initial: DockLayout = {
			version: 2,
			floating: [],
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.2, 0.3, 0.5],
				children: ['a', 'b', 'c'].map(panel)
			}
		};
		const { dock, host } = mount({}, initial);
		dock.undockPanel('a');
		dock.dismiss('b');
		expect(await host().replaceLayout(JSON.parse(dock.serialize()) as DockLayout)).toBe('applied');
		expect(dock.homeSlot('a')).toBeUndefined();
		dock.show('b');
		const root = dock.layout.docked;
		expect(root?.type === 'split' && root.sizes[0]).toBeCloseTo(0.375, 9);
	});
});
