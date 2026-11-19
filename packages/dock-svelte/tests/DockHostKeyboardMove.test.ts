// @vitest-environment jsdom
//
// Re-docking a pane without a drag (#663 ④, three-pane-dock-plan §4.6): `DockHost.movePanel`
// and the "panel actions" menu (`DockPanelMenu.svelte`) - outer edges, into a tab group, next to
// a pane (the side submenu), floating and back to where it was, through the drag's own drop path
// (capabilities, `dropCenter` / `dropSplit`, the `beforePanelChange` kinds, stale checks); a
// refused / unavailable move changes nothing; the result is announced politely; the menu is a
// WAI-ARIA menu button (keys, Esc back to the button) and is closed before any confirm; a locked
// window does not move; the focus lands on the moved pane's title bar.
//
// jsdom: no layout and no Popover API (the menu is drawn in place); host size stubbed.
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import type { DockCapabilities } from '../src/core/policy';
import { collectPanelIds, findParent } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockPanelNode } from '../src/types';

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

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });

/** tree | main | detail in a row, plus a floating window `w`. */
function layout(): DockLayout {
	return {
		version: 2,
		docked: {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.25, 0.5, 0.25],
			children: [panel('tree'), panel('main'), panel('detail')]
		},
		floating: [{ id: 'w', title: 'W', x: 10, y: 10, width: 200, height: 150, open: true }]
	};
}

function mount(
	props: {
		dock?: DockState;
		capabilities?: (id: string) => DockCapabilities | undefined;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	} = {}
) {
	const dock = props.dock ?? createDockState(layout());
	const view = render(DockHostHarness, {
		props: {
			dock,
			capabilities: props.capabilities,
			beforePanelChange: props.beforePanelChange
		}
	});
	const host = () => view.component.host();
	return { dock, host, container: view.container };
}

const menuButton = (id: string) =>
	document.querySelector<HTMLButtonElement>(`[data-dock-menu-for="${id}"]`);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const labelOf = (el: Element | null) => el?.textContent?.replace('▸', '').trim();
const labels = () => items().map((el) => labelOf(el));
const live = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

/** Let the menu's ticks, the lifecycle's promises and the announcement settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await tick();
		await Promise.resolve();
	}
	flushSync();
}

async function openWithKeyboard(id: string): Promise<HTMLButtonElement> {
	const button = menuButton(id);
	if (!button) throw new Error(`no menu button for ${id}`);
	button.focus();
	key(button, 'Enter');
	await settle();
	return button;
}

/** Arrow down to the item with this label, then Enter. */
async function chooseByKeyboard(label: string): Promise<void> {
	const at = labels().indexOf(label);
	if (at < 0) throw new Error(`no item "${label}" in ${JSON.stringify(labels())}`);
	for (let i = 0; i < at; i++) key(document.activeElement as Element, 'ArrowDown');
	expect(labelOf(document.activeElement)).toBe(label);
	key(document.activeElement as Element, 'Enter');
	await settle();
}

describe('the panel actions menu (WAI-ARIA menu button)', () => {
	it('opens from the keyboard on the first item, arrows wrap, Esc closes it back on the button', async () => {
		mount();
		const button = await openWithKeyboard('tree');
		expect(button.getAttribute('aria-haspopup')).toBe('menu');
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(menu()?.id).toBe(button.getAttribute('aria-controls'));
		expect(labels()).toEqual([
			'左端にドッキング',
			'右端にドッキング',
			'上端にドッキング',
			'下端にドッキング',
			'MAINとタブにまとめる',
			'DETAILとタブにまとめる',
			'MAINの隣にドッキング',
			'DETAILの隣にドッキング',
			'浮かせる'
		]);
		expect(document.activeElement).toBe(items()[0]);
		key(items()[0], 'ArrowUp');
		expect(document.activeElement).toBe(items()[items().length - 1]);
		key(document.activeElement as Element, 'Home');
		expect(document.activeElement).toBe(items()[0]);
		key(document.activeElement as Element, 'End');
		expect(labelOf(document.activeElement)).toBe('浮かせる');
		const esc = key(document.activeElement as Element, 'Escape');
		await settle();
		expect(esc.defaultPrevented).toBe(true);
		expect(menu()).toBeNull();
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(button);
		// ArrowUp on the button opens on the last item.
		key(button, 'ArrowUp');
		await settle();
		expect(labelOf(document.activeElement)).toBe('浮かせる');
	});

	it('a floating window offers the edges, the tabs and the splits, not "float"; no "back" before it was floated here', async () => {
		mount();
		await openWithKeyboard('w');
		expect(labels()).toContain('右端にドッキング');
		expect(labels()).toContain('TREEとタブにまとめる');
		expect(labels()).not.toContain('浮かせる');
		expect(labels()).not.toContain('元の場所に戻す');
	});

	it('the side submenu: ArrowRight opens it, ArrowLeft / Esc come back to its item', async () => {
		mount();
		await openWithKeyboard('tree');
		await chooseByKeyboard('MAINの隣にドッキング');
		expect(labels()).toEqual(['左に', '右に', '上に', '下に', '戻る']);
		expect(document.activeElement).toBe(items()[0]);
		key(items()[0], 'ArrowLeft');
		await settle();
		expect(labelOf(document.activeElement)).toBe('MAINの隣にドッキング');
		key(document.activeElement as Element, 'ArrowRight');
		await settle();
		expect(labels()[0]).toBe('左に');
		key(document.activeElement as Element, 'Escape');
		await settle();
		expect(menu()).not.toBeNull();
		expect(labelOf(document.activeElement)).toBe('MAINの隣にドッキング');
	});

	it('keys inside the menu do not reach the tab strip around the button', async () => {
		const dock = createDockState({
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'tabs', id: 'g', activeIndex: 0, children: [panel('a'), panel('b')] },
					panel('c')
				]
			},
			floating: []
		});
		mount({ dock });
		await openWithKeyboard('a');
		key(items()[0], 'ArrowRight');
		key(items()[0], 'End');
		await settle();
		// Still tab `a` active (the strip's ArrowRight / End would have switched tabs).
		expect(findParent(dock.layout.docked, 'a')).toMatchObject({ activeIndex: 0 });
		expect(menu()).not.toBeNull();
	});
});

describe('movePanel through the menu: every target', () => {
	it('outer edge: the pane wraps the root on that side (a quarter), announced, focus on its title bar', async () => {
		const asked: DockPanelChange[] = [];
		const { dock } = mount({ beforePanelChange: (c) => (asked.push(c), true) });
		await openWithKeyboard('tree');
		await chooseByKeyboard('右端にドッキング');
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'row',
			sizes: [0.75, 0.25],
			children: [{ id: 's' }, { id: 'tree' }]
		});
		// The drag's requests: the panes the wrap re-mounts (`reparent`), then the moved one.
		expect(asked.at(-1)).toEqual({ kind: 'move-docked', panelId: 'tree', remount: true });
		expect(asked.slice(0, -1).every((c) => c.kind === 'reparent')).toBe(true);
		expect(live()).toBe('TREEを右端にドッキングしました');
		expect(document.activeElement).toBe(menuButton('tree'));
	});

	it('tabs: the pane joins the target as a tab; the focus is on its tab', async () => {
		const { dock } = mount();
		await openWithKeyboard('tree');
		await chooseByKeyboard('DETAILとタブにまとめる');
		const group = findParent(dock.layout.docked, 'tree');
		expect(group?.type).toBe('tabs');
		expect(group && 'children' in group && group.children.map((c) => c.id)).toEqual([
			'detail',
			'tree'
		]);
		expect(live()).toBe('TREEをDETAILとタブにまとめました');
		const tab = document.querySelector('[role="tab"][data-dock-tab-id="tree"]');
		expect(tab).not.toBeNull();
		expect(document.activeElement).toBe(tab);
	});

	it('split: next to the target on the chosen side', async () => {
		const { dock } = mount();
		await openWithKeyboard('detail');
		await chooseByKeyboard('TREEの隣にドッキング');
		await chooseByKeyboard('下に');
		const parent = findParent(dock.layout.docked, 'detail');
		expect(parent).toMatchObject({ type: 'split', direction: 'column' });
		expect(parent && 'children' in parent && parent.children.map((c) => c.id)).toEqual([
			'tree',
			'detail'
		]);
		expect(live()).toBe('DETAILをTREEの下にドッキングしました');
	});

	it('float, then back: the pane goes back to exactly where it was', async () => {
		const { dock } = mount();
		const before = JSON.parse(JSON.stringify(dock.layout.docked));
		await openWithKeyboard('main');
		await chooseByKeyboard('浮かせる');
		expect(collectPanelIds(dock.layout.docked)).toEqual(['tree', 'detail']);
		expect(dock.layout.floating.find((w) => w.id === 'main')?.open).toBe(true);
		expect(live()).toBe('MAINを浮かせました');
		// The focus is on the new window's title bar (its menu button), which is frontmost.
		expect(document.activeElement).toBe(menuButton('main'));
		expect(dock.layout.floating.at(-1)?.id).toBe('main');

		await openWithKeyboard('main');
		expect(labels()).toContain('元の場所に戻す');
		await chooseByKeyboard('元の場所に戻す');
		expect(dock.layout.docked).toEqual(before);
		expect(dock.layout.floating.some((w) => w.id === 'main')).toBe(false);
		expect(live()).toBe('MAINを元の場所に戻しました');
	});

	it('the API: same targets, same results; the outcome is returned', async () => {
		const { dock, host } = mount();
		expect(await host().movePanel('w', { edge: 'left' })).toBe('applied');
		expect(dock.layout.docked).toMatchObject({ children: [{ id: 'w' }, { id: 's' }] });
		expect(await host().movePanel('w', { splitWith: 'main', side: 'top' })).toBe('applied');
		expect(findParent(dock.layout.docked, 'w')).toMatchObject({ direction: 'column' });
		expect(await host().movePanel('w', { tabWith: 'main' })).toBe('applied');
		expect(findParent(dock.layout.docked, 'w')?.type).toBe('tabs');
		expect(await host().movePanel('w', { float: true })).toBe('applied');
		expect(await host().movePanel('w', { back: true })).toBe('applied');
		expect(findParent(dock.layout.docked, 'w')?.type).toBe('tabs');
	});
});

describe('refused / unavailable: nothing changes', () => {
	it('beforePanelChange says no: layout unchanged, announced, focus back on the button', async () => {
		const { dock } = mount({ beforePanelChange: () => false });
		const before = JSON.stringify(dock.layout);
		const button = await openWithKeyboard('tree');
		await chooseByKeyboard('左端にドッキング');
		expect(JSON.stringify(dock.layout)).toBe(before);
		expect(live()).toBe('TREEの移動は取り消されました');
		expect(document.activeElement).toBe(button);
	});

	it('the menu is closed before the app is asked (no confirm over an open menu)', async () => {
		let menuOpenWhenAsked: boolean | null = null;
		mount({
			beforePanelChange: () => {
				menuOpenWhenAsked = menu() !== null;
				return true;
			}
		});
		await openWithKeyboard('tree');
		await chooseByKeyboard('浮かせる');
		expect(menuOpenWhenAsked).toBe(false);
	});

	it('the structure changes while the answer waits: stale, the later layout is kept', async () => {
		let resolve!: (ok: boolean) => void;
		const { dock, host } = mount({
			beforePanelChange: (c) =>
				c.kind === 'move-docked' ? new Promise<boolean>((r) => (resolve = r)) : true
		});
		const pending = host().movePanel('tree', { tabWith: 'detail' });
		await settle();
		dock.dockExistingAtEdge('main', 'bottom');
		const after = JSON.stringify(dock.layout);
		resolve(true);
		expect(await pending).toBe('stale');
		expect(JSON.stringify(dock.layout)).toBe(after);
		await settle();
		expect(live()).toContain('移動できません');
	});

	it('capabilities: `move: false` = no menu, `unavailable`; `undock: false` = no float', async () => {
		const { dock, host } = mount({
			capabilities: (id) =>
				id === 'main' ? { move: false } : id === 'tree' ? { undock: false } : undefined
		});
		const before = JSON.stringify(dock.layout);
		expect(menuButton('main')).toBeNull();
		expect(await host().movePanel('main', { edge: 'left' })).toBe('unavailable');
		expect(await host().movePanel('tree', { float: true })).toBe('unavailable');
		expect(JSON.stringify(dock.layout)).toBe(before);
		await settle();
		expect(live()).toBe('移動できません: TREEはその場所へ移せません');
		await openWithKeyboard('tree');
		expect(labels()).not.toContain('浮かせる');
	});

	it('a target withholding `dropCenter` / `dropSplit` is not offered, as in the cross guide', async () => {
		const { dock, host } = mount({
			capabilities: (id) => (id === 'main' ? { dropCenter: false, dropSplit: false } : undefined)
		});
		const before = JSON.stringify(dock.layout);
		await openWithKeyboard('tree');
		expect(labels()).not.toContain('MAINとタブにまとめる');
		expect(labels()).not.toContain('MAINの隣にドッキング');
		expect(await host().movePanel('tree', { tabWith: 'main' })).toBe('unavailable');
		expect(await host().movePanel('tree', { splitWith: 'main', side: 'left' })).toBe('unavailable');
		expect(JSON.stringify(dock.layout)).toBe(before);
	});

	it('no "back" for a pane that was never floated here; joining its own group is not offered', async () => {
		const dock = createDockState({
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'tabs', id: 'g', activeIndex: 0, children: [panel('a'), panel('b')] },
					panel('c')
				]
			},
			floating: []
		});
		const { host } = mount({ dock });
		expect(await host().movePanel('a', { back: true })).toBe('unavailable');
		expect(await host().movePanel('a', { tabWith: 'b' })).toBe('unavailable');
		await openWithKeyboard('a');
		expect(labels()).not.toContain('Bとタブにまとめる');
		// Next to its own tab-mate is a real move (the group shrinks to b).
		expect(labels()).toContain('Bの隣にドッキング');
	});
});

describe('a locked floating window does not move', () => {
	it('no menu button and `unavailable`; locking with the focus in the menu hands it to the next button', async () => {
		const { dock, host } = mount();
		await openWithKeyboard('w');
		expect(menu()).not.toBeNull();
		dock.setLocked('w', true);
		flushSync();
		await settle();
		expect(menu()).toBeNull();
		expect(menuButton('w')).toBeNull();
		const win = document.querySelector('[data-dock-window-id="w"]');
		expect(win?.contains(document.activeElement)).toBe(true);
		expect(document.activeElement?.tagName).toBe('BUTTON');
		const before = JSON.stringify(dock.layout);
		expect(await host().movePanel('w', { edge: 'left' })).toBe('unavailable');
		expect(JSON.stringify(dock.layout)).toBe(before);
		// Closing / raising still work.
		dock.focus('w');
		expect(await host().closePanel('w')).toBe('applied');
	});
});

describe('the live region', () => {
	it('one polite, atomic region in the host; repeated sentences are re-announced', async () => {
		const { host, container } = mount();
		const regions = container.querySelectorAll('[aria-live]');
		expect(regions).toHaveLength(1);
		expect(regions[0].getAttribute('aria-live')).toBe('polite');
		expect(regions[0].getAttribute('aria-atomic')).toBe('true');
		const spy = vi.fn();
		const observer = new MutationObserver(spy);
		observer.observe(regions[0], { childList: true, characterData: true, subtree: true });
		await host().movePanel('main', { move: true } as never);
		await settle();
		await host().movePanel('main', { move: true } as never);
		await settle();
		expect(live()).toBe('移動できません: MAINはその場所へ移せません');
		// Cleared and set again (the second sentence is a new mutation, not a no-op).
		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
		observer.disconnect();
	});
});
