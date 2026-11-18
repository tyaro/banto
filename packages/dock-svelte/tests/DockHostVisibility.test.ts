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
		expect(calls).toEqual([{ kind: 'close', panelId: 'a' }]);
		expect(docked(dock)).toEqual(['a', 'b']);

		allow = true;
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(docked(dock)).toEqual(['b']);
		expect(dock.isVisible('a')).toBe(false);
		// Already hidden: nothing to ask.
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(calls).toHaveLength(2);
	});

	it('unchecking a keepMounted pane hides it (hide, not close)', async () => {
		const calls: DockPanelChange[] = [];
		const { dock, host } = mount({
			beforePanelChange: (c: DockPanelChange) => (calls.push(c), true),
			keepMounted: (id: string) => id === 'a'
		});
		expect(await host().setPanelVisible('a', false)).toBe('applied');
		expect(calls).toEqual([{ kind: 'hide', panelId: 'a', remount: true }]);
		expect(dock.isVisible('a')).toBe(false);

		// Its content is still mounted (hidden) in the floating layer: re-docking it is asked as a dock.
		expect(await host().showPanel('a')).toBe('applied');
		expect(calls[1]).toEqual({ kind: 'dock', panelId: 'a', remount: true });
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
