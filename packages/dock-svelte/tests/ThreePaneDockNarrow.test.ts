// @vitest-environment jsdom
//
// `ThreePaneDock`'s narrow display, `arrange={false}` and the touch sizing of the drop guides
// (#663 ④ PR-4, three-pane-dock-plan §4.5 / §6-3 / §6-7): crossing the breakpoint keeps the saved
// value and never re-mounts the centre; with `arrange={false}` the operations of the §4.5 table
// are refused by pointer, keyboard and method alike.
//
// jsdom: no layout; the host width is a variable (`width`) and the ResizeObserver is a stub whose
// callbacks the tests call (`resize`).
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ThreePaneDockHarness from './ThreePaneDockHarness.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import { autoHiddenPanelIds } from '../src/core/autohide';
import {
	crossButtons,
	GUIDE_BUTTON_SIZE,
	guideButtonSize,
	readGuideSizing
} from '../src/core/dropzones';
import { edgeButtons } from '../src/core/edges';
import { collectPanelIds } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState, type DockState } from '../src/state.svelte';
import {
	threePaneDockLayout,
	threePaneNarrowLayout,
	type ThreePaneExtraPanelDef,
	type ThreePanePanels,
	type ThreePaneSavedLayout
} from '../src/threePane';
import type { DockLayout, DockSplitNode } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];
let width = 1000;
const observers = new Set<() => void>();

function stub(target: object, prop: string, descriptor: PropertyDescriptor): void {
	saved.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
	Object.defineProperty(target, prop, { configurable: true, ...descriptor });
}

beforeAll(() => {
	stub(globalThis, 'ResizeObserver', {
		writable: true,
		value: class {
			#cb: () => void;
			constructor(cb: (entries: unknown[]) => void) {
				this.#cb = () => cb([]);
			}
			observe() {
				observers.add(this.#cb);
			}
			unobserve() {}
			disconnect() {
				observers.delete(this.#cb);
			}
		}
	});
	stub(HTMLElement.prototype, 'clientWidth', { get: () => width });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

beforeEach(() => {
	width = 1000;
});
afterEach(() => {
	cleanup();
	observers.clear();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
	flushSync();
}

/** The component width changes (the ResizeObserver fires). */
async function resize(to: number): Promise<void> {
	width = to;
	for (const cb of [...observers]) cb();
	await settle();
}

function mount(
	props: {
		dock?: DockState;
		extra?: ThreePaneExtraPanelDef[];
		initialLayout?: unknown;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		narrowOverride?: boolean;
		arrange?: boolean;
		onSave?: (snapshot: ThreePaneSavedLayout) => void;
		withLeft?: boolean;
	} = {}
) {
	const dock = props.dock ?? createDockState();
	const mounts: string[] = [];
	const view = render(ThreePaneDockHarness, {
		props: { ...props, dock, onCenterMounted: (id: string) => mounts.push(id) }
	});
	flushSync();
	return { dock, view, mounts, api: () => view.component.api(), harness: view.component };
}

const PANES: ThreePanePanels = {
	left: { title: 'L' },
	center: { title: 'C' },
	right: { title: 'R' },
	extra: [{ id: 'log', title: 'Log', initial: { edge: 'bottom' } }]
};

describe('threePaneNarrowLayout', () => {
	it('docks the centre alone, puts the shown sides in their bands and hides the rest', () => {
		const wide = threePaneDockLayout({ hostWidth: 1200, panels: PANES });
		const narrow = threePaneNarrowLayout(wide, { panels: PANES });
		expect(validateDockLayout(narrow).ok).toBe(true);
		expect(narrow.docked).toMatchObject({ type: 'panel', id: 'center' });
		expect(narrow.autoHidden?.map((e) => [e.node.id, e.edge])).toEqual([
			['left', 'left'],
			['right', 'right']
		]);
		expect(narrow.floating).toMatchObject([{ id: 'log', open: false }]);
		expect(narrow.floating[0].dockSlot).toBeUndefined();
		// `wide` is left as it was.
		expect(collectPanelIds(wide.docked)).toEqual(['left', 'center', 'right', 'log']);
	});

	it('keeps a side hidden in the wide layout hidden, and puts `shown` panes on their own edge', () => {
		const wide = threePaneDockLayout({ hostWidth: 1200, panels: PANES, leftOpen: false });
		expect(autoHiddenPanelIds(threePaneNarrowLayout(wide, { panels: PANES }))).toEqual(['right']);
		const narrow = threePaneNarrowLayout(wide, { panels: PANES, shown: ['log', 'left'] });
		expect(narrow.autoHidden?.map((e) => [e.node.id, e.edge])).toEqual([
			['left', 'left'],
			['log', 'bottom']
		]);
		expect(narrow.floating.map((w) => [w.id, w.open])).toEqual([['right', false]]);
		expect(validateDockLayout(narrow).ok).toBe(true);
	});
});

describe('ThreePaneDock: the narrow display', () => {
	it('crosses the breakpoint both ways without changing the saved value or re-mounting the centre', async () => {
		const { api, dock, view, mounts, harness } = mount();
		const before = JSON.stringify(api().layoutSnapshot());
		const centre = view.container.querySelector('[data-pane="center"]');
		const input = view.container.querySelector<HTMLInputElement>('[aria-label="probe input"]')!;
		input.value = 'typed';
		expect(harness.isNarrow()).toBe(false);

		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		expect(dock.layout.docked).toMatchObject({ type: 'panel', id: 'center' });
		expect(autoHiddenPanelIds(dock.layout)).toEqual(['left', 'right']);
		expect(JSON.stringify(api().layoutSnapshot())).toBe(before);
		// The sides are still "open" (in their bands): leftOpen / rightOpen do not flip.
		expect(harness.open()).toEqual({ left: true, right: true });

		await resize(1200);
		expect(harness.isNarrow()).toBe(false);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
		expect(JSON.stringify(api().layoutSnapshot())).toBe(before);
		expect(view.container.querySelector('[data-pane="center"]')).toBe(centre);
		expect(view.container.querySelector<HTMLInputElement>('[aria-label="probe input"]')).toBe(
			input
		);
		expect(input.value).toBe('typed');
		expect(mounts).toEqual(['center']);
	});

	// #739 review (Codex): a floated pane's place is not saved, so the kept wide layout is saved -
	// and shown again - with the hidden panes' shares taken without it, as before the switch.
	it('keeps the wide layout as saved: a floated pane is not counted in the hidden ones', async () => {
		const { api, dock } = mount();
		dock.undockPanel('left');
		dock.dismiss('right');
		const wide = api().layoutSnapshot();
		const share = (layout: DockLayout) => {
			const slot = layout.floating.find((w) => w.id === 'right')?.dockSlot;
			return slot?.kind === 'split' ? slot.share : undefined;
		};
		expect(share(wide.layout)).not.toBe(share(dock.layout));
		await resize(700);
		expect(api().layoutSnapshot()).toEqual(wide);
		await resize(1000);
		expect(share(dock.layout)).toBe(share(wide.layout));
	});

	// #739 review (Codex): a closed floated pane stays floating in the narrow display; its place is
	// forgotten, so `right` comes back by the kept share (not scaled by `left` again).
	it('a closed floated pane: its place is forgotten across the narrow display', async () => {
		const { api, dock } = mount();
		dock.undockPanel('left');
		dock.close('left');
		dock.dismiss('right');
		const kept = api().layoutSnapshot();
		const slot = kept.layout.floating.find((w) => w.id === 'right')?.dockSlot;
		await resize(700);
		expect(dock.homeSlot('left')).toBeUndefined();
		await resize(1000);
		dock.show('right');
		const root = dock.layout.docked as DockSplitNode;
		const at = root.children.findIndex((c) => c.id === 'right');
		expect(slot?.kind === 'split' && slot.share).toBeTruthy();
		expect(root.sizes[at]).toBeCloseTo(slot?.kind === 'split' ? slot.share! : NaN, 9);
	});

	it('does not save what is changed while narrow, and goes back to the kept layout', async () => {
		const { api, dock } = mount();
		const root = dock.layout.docked as DockSplitNode;
		const shares = [...root.sizes];
		await resize(700);
		await api().setVisible('right', false);
		expect(dock.isVisible('right')).toBe(false);
		expect(api().layoutSnapshot().layout.docked).toMatchObject({ sizes: shares });
		await resize(1000);
		expect(dock.isVisible('right')).toBe(true);
		expect((dock.layout.docked as DockSplitNode).sizes).toEqual(shares);
	});

	it('installs the narrow display at mount without asking, when the first measurement is narrow', async () => {
		width = 600;
		const asked: DockPanelChange[] = [];
		const { dock, harness, mounts } = mount({ beforePanelChange: (c) => (asked.push(c), true) });
		await settle();
		expect(harness.isNarrow()).toBe(true);
		expect(dock.layout.docked).toMatchObject({ id: 'center' });
		expect(asked).toEqual([]);
		// The kept default is measured again at the wide width.
		await resize(1000);
		const root = dock.layout.docked as DockSplitNode;
		expect(root.sizes[0]).toBeCloseTo(0.28);
		expect(mounts).toEqual(['center']);
	});

	it('starts narrow before the first render with narrowOverride, and follows it', async () => {
		const { dock, harness, view } = mount({ narrowOverride: true });
		await settle();
		expect(harness.isNarrow()).toBe(true);
		expect(view.container.querySelector('[data-dock-drop-id="left"]')).toBeNull();
		await view.rerender({ narrowOverride: false });
		await settle();
		expect(harness.isNarrow()).toBe(false);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
	});

	it('asks beforePanelChange for the switch; a refusal keeps the display until the next crossing', async () => {
		let allow = false;
		const { dock, harness, api } = mount({ beforePanelChange: () => allow });
		const before = JSON.stringify(dock.layout);
		await resize(800);
		expect(harness.isNarrow()).toBe(false);
		expect(JSON.stringify(dock.layout)).toBe(before);
		await resize(850);
		expect(harness.isNarrow()).toBe(false);
		allow = true;
		await resize(1000);
		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		expect(JSON.stringify(api().layoutSnapshot().layout)).toBe(before);
	});

	it('opens a band pane from the View menu as a flyout, and a hidden pane in its band', async () => {
		const { api, dock } = mount({ extra: [{ id: 'log', title: 'Log' }] });
		await resize(800);
		const items = api().viewMenuItems({ resetLayout: 'reset' });
		const left = items.find((i) => i.id === 'panel:left');
		if (left?.kind !== 'checkbox') throw new Error('no left item');
		left.onSelect();
		await settle();
		expect(dock.flyoutPanel).toBe('left');
		expect(dock.isAutoHidden('left')).toBe(true);
		const log = items.find((i) => i.id === 'panel:log');
		if (log?.kind !== 'checkbox') throw new Error('no log item');
		expect(log.checked).toBe(false);
		log.onSelect();
		await settle();
		expect(dock.isAutoHidden('log')).toBe(true);
		expect(dock.flyoutPanel).toBe('log');
		// Still narrow: the saved value does not know the band.
		expect(api().layoutSnapshot().layout.autoHidden).toBeUndefined();
	});

	it('resets while narrow to a default shown when the width comes back', async () => {
		const { api, dock } = mount();
		await api().setVisible('left', false);
		await resize(800);
		expect(await api().resetLayout()).toBe('applied');
		expect(dock.isAutoHidden('left')).toBe(true);
		await resize(1000);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
	});

	it('lets an effect on dock.layout save the default after a reset while narrow (PR #726 review)', async () => {
		const saves: string[] = [];
		const { api, dock } = mount({ onSave: (snapshot) => saves.push(JSON.stringify(snapshot)) });
		const fresh = JSON.stringify(api().layoutSnapshot());
		const root = dock.layout.docked as DockSplitNode;
		const sizes = root.sizes.map((_, i) => (i === 0 ? 0.4 : 0.6 / (root.sizes.length - 1)));
		dock.layout = { ...dock.layout, docked: { ...root, sizes } };
		await settle();
		const custom = JSON.stringify(api().layoutSnapshot());
		expect(custom).not.toBe(fresh);
		await resize(800);
		expect(saves.at(-1)).toBe(custom);
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		// The default measured at today's (narrow) width: not the custom shares, and what it keeps.
		expect(saves.at(-1)).not.toBe(custom);
		expect(saves.at(-1)).toBe(JSON.stringify(api().layoutSnapshot()));
		await resize(1000);
		expect(saves.at(-1)).toBe(fresh);
	});

	it('puts a left pane given while narrow in its band, and docks it on the left when wide (PR #726 review)', async () => {
		const { view, dock, harness } = mount({ withLeft: false });
		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		await view.rerender({ withLeft: true });
		await settle();
		expect(harness.isNarrow()).toBe(true);
		expect(dock.layout.docked).toMatchObject({ type: 'panel', id: 'center' });
		expect(autoHiddenPanelIds(dock.layout)).toEqual(['left', 'right']);
		expect(validateDockLayout(dock.layout).ok).toBe(true);
		await resize(1000);
		expect(collectPanelIds(dock.layout.docked)).toEqual(['left', 'center', 'right']);
	});
});

describe('ThreePaneDock: arrange={false} (plan §4.5 table)', () => {
	it('refuses every rearranging method with nothing changed; restoreLayout still works', async () => {
		const asked: DockPanelChange[] = [];
		const { api, dock, harness } = mount({
			arrange: false,
			beforePanelChange: (c) => (asked.push(c), true)
		});
		const before = JSON.stringify(dock.layout);
		expect(await api().setVisible('left', false)).toBe('refused');
		expect(await api().toggle('right')).toBe('refused');
		expect(await api().float('left')).toBe('unavailable');
		expect(await api().move('left', { edge: 'right' })).toBe('unavailable');
		expect(await api().dockBack('left')).toBe('unavailable');
		expect(await api().resetLayout()).toBe('refused');
		harness.setOpen('left', false);
		await settle();
		expect(harness.open()).toEqual({ left: true, right: true });
		expect(JSON.stringify(dock.layout)).toBe(before);
		expect(api().viewMenuItems({ resetLayout: 'reset' })).toEqual([]);
		expect(asked).toEqual([]);

		const saved = threePaneDockLayout({ hostWidth: 1000, panels: PANES, rightOpen: false });
		const { outcome } = await api().restoreLayout(saved);
		expect(outcome).toBe('applied');
		expect(dock.isVisible('right')).toBe(false);
	});

	it('draws no close / collapse / pin / panel-actions control, and fixes the dividers', async () => {
		const { view, dock } = mount({ arrange: false });
		const host = view.container;
		for (const selector of [
			'.close-btn',
			'.collapse-btn',
			'.pin-btn',
			'.popout-btn',
			'[data-dock-menu-for]'
		])
			expect(host.querySelector(selector), selector).toBeNull();
		const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
		expect(divider.getAttribute('aria-disabled')).toBe('true');
		expect(divider.tabIndex).toBe(-1);
		const sizes = [...(dock.layout.docked as DockSplitNode).sizes];
		await fireEvent.keyDown(divider, { key: 'ArrowRight' });
		await fireEvent.keyDown(divider, { key: 'End' });
		await fireEvent.pointerDown(divider, { button: 0, clientX: 300, clientY: 10, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 500, clientY: 10, pointerId: 1 });
		await fireEvent.pointerUp(window, { clientX: 500, clientY: 10, pointerId: 1 });
		expect((dock.layout.docked as DockSplitNode).sizes).toEqual(sizes);
		// Switching tabs and the like are not touched: the title of a pane can still be pressed.
		expect(host.querySelector('[data-dock-drop-id="left"]')).not.toBeNull();
	});

	it('fixes a floating window: no move / resize / lock / collapse control, no resize handle', async () => {
		const { api, view } = mount();
		expect(await api().float('left')).toBe('applied');
		await settle();
		const win = () => view.container.querySelector('[data-dock-window-id="left"]')!;
		expect(win().querySelector('.lock-btn')).not.toBeNull();
		expect(win().querySelectorAll('.key-btn').length).toBeGreaterThan(0);
		await view.rerender({ arrange: false });
		await settle();
		for (const selector of ['.key-btn', '.lock-btn', '.collapse-btn', '.close-btn'])
			expect(win().querySelector(selector), selector).toBeNull();
		expect(win().parentElement?.querySelector('.handle')).toBeNull();
	});

	it('keeps an auto-hidden pane able to slide out, without its pin-back button (narrow kiosk)', async () => {
		const { dock, view } = mount({ arrange: false, narrowOverride: true });
		await settle();
		dock.openFlyout('left');
		await settle();
		const flyout = view.container.querySelector('[data-dock-flyout="left"]')!;
		expect(flyout).not.toBeNull();
		expect(flyout.querySelector('.pin-btn')).toBeNull();
		expect(flyout.querySelector('.close-btn')).toBeNull();
	});

	it('turning it off makes a change still being asked stale, and moves a focus whose control goes away', async () => {
		let answer: (ok: boolean) => void = () => {};
		const { api, dock, view } = mount({
			beforePanelChange: () => new Promise<boolean>((resolve) => (answer = resolve))
		});
		const pending = api().setVisible('left', false);
		await settle();
		const menu = view.container.querySelector<HTMLElement>('[data-dock-menu-for="right"]')!;
		menu.focus();
		expect(document.activeElement).toBe(menu);
		await view.rerender({ arrange: false });
		await settle();
		answer(true);
		expect(await pending).toBe('stale');
		expect(dock.isVisible('left')).toBe(true);
		// The menu button is gone; the focus is in the right pane (its body), not on <body>.
		expect(menu.isConnected).toBe(false);
		const right = view.container.querySelector('[data-dock-drop-id="right"]')!;
		expect(right.contains(document.activeElement)).toBe(true);
	});
});

// #741: the kept wide layout is a saved value. A hidden panel removed from `panels` while narrow
// releases its share there (no `DockState` holds that layout), and the places of the panes floated
// while narrow belong to the narrow tree: they do not outlive the switch back.
describe('ThreePaneDock: the kept wide layout and the shares (#741)', () => {
	const LOG: ThreePaneExtraPanelDef = { id: 'log', title: 'Log' };
	const row = (): DockLayout => ({
		version: 2,
		floating: [],
		docked: {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.2, 0.3, 0.5],
			children: [
				{ type: 'panel', id: 'log', title: 'Log' },
				{ type: 'panel', id: 'right', title: 'R' },
				{ type: 'panel', id: 'center', title: 'C' }
			]
		}
	});

	it('a hidden panel removed from panels while narrow: right comes back at .375 when wide again', async () => {
		const { dock, view, api } = mount({ withLeft: false, extra: [LOG], initialLayout: row() });
		dock.dismiss('log');
		dock.dismiss('right');
		await resize(700);
		expect(view.component.isNarrow()).toBe(true);
		await view.rerender({ extra: [] });
		await settle();
		const kept = api().layoutSnapshot().layout as DockLayout;
		const slot = kept.floating.find((w) => w.id === 'right')?.dockSlot;
		expect(kept.floating.map((w) => w.id)).toEqual(['right']);
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.375, 9);
		await resize(1000);
		expect(view.component.isNarrow()).toBe(false);
		dock.show('right');
		expect((dock.layout.docked as DockSplitNode).sizes[0]).toBeCloseTo(0.375, 9);
	});

	it('a pane floated while narrow: its place is forgotten when the wide layout comes back', async () => {
		const { dock, view } = mount({ extra: [{ ...LOG, initial: 'floating' }] });
		await resize(700);
		expect(view.component.isNarrow()).toBe(true);
		dock.open('log');
		dock.dockPanel('log', 'center', 'right');
		dock.undockPanel('log');
		expect(dock.homeSlot('log')).toBeDefined();
		await resize(1000);
		expect(view.component.isNarrow()).toBe(false);
		expect(dock.layout.floating.map((w) => w.id)).toContain('log');
		expect(dock.homeSlot('log')).toBeUndefined();
	});
});

describe('touch: the drop guides follow the density token', () => {
	it('reads --banto-dock-guide-button-size and does not shrink below the default size', () => {
		const el = document.createElement('div');
		document.body.append(el);
		expect(readGuideSizing(el)).toEqual({});
		el.style.setProperty('--banto-dock-guide-button-size', '40px');
		expect(readGuideSizing(el)).toEqual({ size: 40, min: GUIDE_BUTTON_SIZE });
		el.remove();
		// 40px buttons where they fit; none where even the default does not.
		expect(guideButtonSize(400, 400, 40, 32)).toBe(40);
		expect(guideButtonSize(100, 100, 40, 32)).toBe(0);
		expect(guideButtonSize(100, 100)).toBe(25);
		expect(
			crossButtons({ x: 0, y: 0, width: 400, height: 400 }, { size: 40, min: 32 })[0].rect
		).toMatchObject({ width: 40, height: 40 });
		expect(edgeButtons(800, 600, { size: 40, min: 32 })[0].rect.width).toBe(40);
	});
});
