// @vitest-environment jsdom
//
// `ThreePaneDock` (#663 ④, three-pane-dock-plan §4.1 / §4.4 / §4.7 / §4.8 / §4.9): the starting
// layout, the API (visibility, float / dock back / move, reset, restore), the View menu items, the
// centre as the main region, `leftOpen` / `rightOpen` as the one visibility state, and the extra
// panels' id check. Every change goes through `beforePanelChange`.
//
// jsdom: no layout; the host size is stubbed (1000 x 600).
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ThreePaneDockHarness from './ThreePaneDockHarness.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import { collectPanelIds, findNode } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import { threePaneDockLayout, type ThreePaneExtraPanelDef } from '../src/threePane';
import type { DockLayout, DockSplitNode } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];

function stub(target: object, prop: string, descriptor: PropertyDescriptor): void {
	saved.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
	Object.defineProperty(target, prop, { configurable: true, ...descriptor });
}

beforeAll(() => {
	stub(globalThis, 'ResizeObserver', {
		writable: true,
		value: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	});
	stub(HTMLElement.prototype, 'clientWidth', { get: () => 1000 });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

afterEach(() => cleanup());

const PANES = {
	left: { title: '左のペイン' },
	center: { title: '中央のペイン' },
	right: { title: '右のペイン' }
};

function mount(
	props: {
		dock?: DockState;
		extra?: ThreePaneExtraPanelDef[];
		initialLayout?: unknown;
		initialLeftOpen?: boolean;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		onRestore?: (status: string) => void;
	} = {}
) {
	const dock = props.dock ?? createDockState();
	const view = render(ThreePaneDockHarness, { props: { ...props, dock } });
	flushSync();
	return { dock, view, api: () => view.component.api(), harness: view.component };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await tick();
	flushSync();
}

describe('ThreePaneDock: the starting layout', () => {
	it('lays left | centre | right like ThreePaneLayout, measured at the host width', () => {
		const statuses: string[] = [];
		const { dock, view } = mount({ onRestore: (s) => statuses.push(s) });
		expect(statuses).toEqual(['fresh']);
		const root = dock.layout.docked as DockSplitNode;
		expect(root.children.map((c) => c.id)).toEqual(['left', 'center', 'right']);
		expect(root.sizes[0]).toBeCloseTo(0.28);
		expect(root.sizes[2]).toBeCloseTo(0.36);
		for (const pane of ['left', 'center', 'right'])
			expect(view.container.querySelector(`[data-pane="${pane}"]`)).not.toBeNull();
		// The centre is drawn once, persistent (moved into its place).
		expect(view.container.querySelectorAll('[data-pane="center"]')).toHaveLength(1);
		expect(
			view.container.querySelector('[data-dock-persistent="center"] [data-pane="center"]')
		).not.toBeNull();
	});

	it('starts with a side hidden when its *Open is false at mount', () => {
		const { dock, harness } = mount({ initialLeftOpen: false });
		expect(collectPanelIds(dock.layout.docked)).toEqual(['center', 'right']);
		expect(harness.open()).toEqual({ left: false, right: true });
	});

	it('repairs a saved layout that hides the centre, and writes the restored visibility back', () => {
		const statuses: string[] = [];
		const behind: DockLayout = {
			version: 2,
			docked: {
				type: 'tabs',
				id: 'g',
				activeIndex: 0,
				children: [
					{ type: 'panel', id: 'right', title: 'R' },
					{ type: 'panel', id: 'center', title: 'C' }
				]
			},
			floating: [{ id: 'left', title: 'L', x: 0, y: 0, width: 100, height: 100, open: false }]
		};
		const { dock, harness } = mount({ initialLayout: behind, onRestore: (s) => statuses.push(s) });
		expect(statuses).toEqual(['repaired']);
		expect(findNode(dock.layout.docked, 'g')).toMatchObject({ activeIndex: 1 });
		expect(findNode(dock.layout.docked, 'center')).toMatchObject({ title: '中央のペイン' });
		expect(harness.open()).toEqual({ left: false, right: true });
	});

	it('falls back to the default for a saved centre that floats', () => {
		const statuses: string[] = [];
		const { dock } = mount({
			initialLayout: {
				version: 2,
				docked: { type: 'panel', id: 'left', title: 'L' },
				floating: [{ id: 'center', title: 'C', x: 0, y: 0, width: 100, height: 100, open: true }]
			},
			onRestore: (s) => statuses.push(s)
		});
		expect(statuses).toEqual(['default']);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
	});

	it('throws for an extra panel whose id is one of the three', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => mount({ extra: [{ id: 'right', title: 'X' }] })).toThrow(/reserved/);
		vi.restoreAllMocks();
	});
});

describe('ThreePaneDock: the centre is the main region', () => {
	it('has no close / collapse / auto-hide control and cannot be hidden or moved', async () => {
		const asked: DockPanelChange[] = [];
		const { view, api, dock } = mount({ beforePanelChange: (c) => (asked.push(c), true) });
		const frame = view.container.querySelector('[data-dock-drop-id="center"]')!;
		expect(frame.querySelector('[aria-label="中央のペインを閉じる"]')).toBeNull();
		expect(frame.querySelector('.pin-btn')).toBeNull();
		// (the same controls exist on a side pane)
		const side = view.container.querySelector('[data-dock-drop-id="left"]')!;
		expect(side.querySelector('.pin-btn')).not.toBeNull();
		expect(side.querySelector<HTMLButtonElement>('.collapse-btn')?.disabled).toBe(false);
		expect(frame.querySelector<HTMLButtonElement>('.collapse-btn')?.disabled).toBe(true);
		expect(await api().setVisible('center', false)).toBe('refused');
		expect(await api().toggle('center')).toBe('refused');
		expect(await api().float('center')).toBe('unavailable');
		expect(await api().move('center', { edge: 'left' })).toBe('unavailable');
		expect(dock.isVisible('center')).toBe(true);
		expect(asked).toEqual([]);
	});
});

describe('ThreePaneDock: the API', () => {
	it('toggles a side through beforePanelChange and mirrors it in leftOpen', async () => {
		const asked: DockPanelChange[] = [];
		const { api, harness, dock } = mount({ beforePanelChange: (c) => (asked.push(c), true) });
		expect(await api().toggle('left')).toBe('applied');
		await settle();
		expect(asked.map((c) => c.kind)).toContain('close');
		expect(dock.isVisible('left')).toBe(false);
		expect(api().isVisible('left')).toBe(false);
		expect(harness.open().left).toBe(false);
		expect(await api().toggle('left')).toBe('applied');
		await settle();
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
		expect(harness.open().left).toBe(true);
	});

	it('keeps leftOpen true when the hide is refused, and asks once for a repeated toggle', async () => {
		let answer!: (ok: boolean) => void;
		const asked: DockPanelChange[] = [];
		const { api, harness, dock } = mount({
			beforePanelChange: (c) => {
				asked.push(c);
				return new Promise<boolean>((r) => (answer = r));
			}
		});
		const first = api().toggle('left');
		const second = api().toggle('left');
		await tick();
		expect(asked).toHaveLength(1);
		answer(false);
		expect(await first).toBe('refused');
		expect(await second).toBe('refused');
		await settle();
		expect(dock.isVisible('left')).toBe(true);
		expect(harness.open().left).toBe(true);
	});

	it('takes writes to leftOpen as a request, and writes the real state back after a refusal', async () => {
		let allow = false;
		const { harness, dock } = mount({ beforePanelChange: () => allow });
		harness.setOpen('left', false);
		await settle();
		expect(dock.isVisible('left')).toBe(true);
		expect(harness.open().left).toBe(true);
		allow = true;
		harness.setOpen('left', false);
		await settle();
		expect(dock.isVisible('left')).toBe(false);
		expect(harness.open().left).toBe(false);
	});

	it('moves the focus to the centre when a hide drops it', async () => {
		const { api, view } = mount();
		const input = view.container.querySelector<HTMLInputElement>('[aria-label="left input"]')!;
		input.focus();
		expect(await api().setVisible('left', false)).toBe('applied');
		await settle();
		const region = view.container.querySelector('[data-dock-drop-id="center"] [role="region"]');
		expect(document.activeElement).toBe(region);
	});

	it('floats a side and docks it back to its place', async () => {
		const { api, dock } = mount();
		expect(await api().float('right')).toBe('applied');
		expect(dock.layout.floating.find((w) => w.id === 'right')?.open).toBe(true);
		expect(await api().dockBack('right')).toBe('applied');
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
		expect(await api().dockBack('right')).toBe('unavailable');
	});

	it('docks a side floated before this mount along its home edge (#721: no remembered place)', async () => {
		const layout = threePaneDockLayout({
			hostWidth: 1000,
			panels: PANES
		});
		const floated: DockLayout = {
			...layout,
			docked: { type: 'panel', id: 'center', title: 'C' },
			floating: [
				{ id: 'left', title: 'L', x: 0, y: 0, width: 200, height: 200, open: true },
				{ id: 'right', title: 'R', x: 0, y: 0, width: 200, height: 200, open: true }
			]
		};
		const { api, dock } = mount({ initialLayout: floated });
		expect(await api().dockBack('left')).toBe('applied');
		const root = dock.layout.docked as DockSplitNode;
		expect(root.children[0]).toMatchObject({ id: 'left' });
	});

	it('leaves an extra panel without a home edge floating when its place is unknown', async () => {
		const { api, dock } = mount({
			initialLayout: {
				version: 2,
				docked: {
					type: 'split',
					id: 's',
					direction: 'row',
					sizes: [0.3, 0.4, 0.3],
					children: [
						{ type: 'panel', id: 'left', title: 'L' },
						{ type: 'panel', id: 'center', title: 'C' },
						{ type: 'panel', id: 'right', title: 'R' }
					]
				},
				floating: [{ id: 'log', title: 'Log', x: 0, y: 0, width: 200, height: 200, open: true }]
			},
			extra: [{ id: 'log', title: 'Log' }]
		});
		expect(await api().dockBack('log')).toBe('unavailable');
		expect(dock.layout.floating.find((w) => w.id === 'log')?.open).toBe(true);
	});

	it('moves a side through DockHost.movePanel', async () => {
		const asked: DockPanelChange[] = [];
		const { api, dock } = mount({ beforePanelChange: (c) => (asked.push(c), true) });
		expect(await api().move('right', { tabWith: 'left' })).toBe('applied');
		expect(asked.some((c) => c.kind === 'move-docked' && c.panelId === 'right')).toBe(true);
		expect(findNode(dock.layout.docked, 'right')).not.toBeNull();
		expect(await api().move('nope', { edge: 'left' })).toBe('unavailable');
	});

	it('resets to the default through beforePanelChange; a refusal changes nothing', async () => {
		let allow = false;
		const asked: DockPanelChange[] = [];
		const { api, dock, harness } = mount({
			extra: [{ id: 'log', title: 'Log', initial: 'floating' }],
			beforePanelChange: (c) => (asked.push(c), allow)
		});
		allow = true;
		await api().setVisible('left', false);
		await api().float('right');
		const before = dock.serialize();
		allow = false;
		asked.length = 0;
		expect(await api().resetLayout()).toBe('refused');
		expect(dock.serialize()).toBe(before);
		allow = true;
		asked.length = 0;
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		// The floating right pane is docked again (asked); left was not mounted (not asked).
		expect(asked).toEqual([{ kind: 'dock', panelId: 'right', remount: true }]);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
		expect(dock.layout.floating.map((w) => [w.id, w.open])).toEqual([['log', true]]);
		expect(harness.open()).toEqual({ left: true, right: true });
	});

	it('makes a pending reset stale when the layout changes meanwhile', async () => {
		let answer!: (ok: boolean) => void;
		let pending = false;
		const { api, dock } = mount({
			beforePanelChange: () => (pending ? new Promise<boolean>((r) => (answer = r)) : true)
		});
		await api().float('right');
		pending = true;
		const reset = api().resetLayout();
		await tick();
		pending = false;
		expect(await api().setVisible('left', false)).toBe('applied');
		answer(true);
		expect(await reset).toBe('stale');
		expect(dock.isVisible('left')).toBe(false);
	});

	it('restores a saved value after mount and gives it back with layoutSnapshot', async () => {
		const { api, dock } = mount();
		await api().float('right');
		const snapshot = api().layoutSnapshot();
		expect(snapshot.schema).toBe(1);
		await api().resetLayout();
		const result = await api().restoreLayout(JSON.stringify(snapshot));
		expect(result).toEqual({ status: 'restored', outcome: 'applied' });
		expect(dock.layout.floating.find((w) => w.id === 'right')?.open).toBe(true);
	});
});

describe('ThreePaneDock: the View menu', () => {
	it('lists left, right and the extra panels (not the centre), a separator and reset', async () => {
		const { api } = mount({ extra: [{ id: 'log', title: 'Log' }] });
		const items = api().viewMenuItems({ resetLayout: 'Reset layout' });
		expect(
			items.map((i) => [
				i.kind,
				i.id,
				'label' in i ? i.label : '',
				'checked' in i ? i.checked : null
			])
		).toEqual([
			['checkbox', 'panel:left', '左のペイン', true],
			['checkbox', 'panel:right', '右のペイン', true],
			['checkbox', 'panel:log', 'Log', false],
			['separator', 'separator', '', null],
			['action', 'reset-layout', 'Reset layout', null]
		]);
		const log = items[2];
		if (log.kind !== 'checkbox') throw new Error('checkbox expected');
		log.onSelect();
		await settle();
		expect(api().viewMenuItems({ resetLayout: 'R' })[2]).toMatchObject({ checked: true });
	});

	it('has no entry for a side without a pane', () => {
		const view = render(ThreePaneDockHarness, {
			props: { dock: createDockState(), withRight: false }
		});
		flushSync();
		const ids = view.component
			.api()
			.viewMenuItems({ resetLayout: 'R' })
			.map((i) => i.id);
		expect(ids).toEqual(['panel:left', 'separator', 'reset-layout']);
	});
});
