// @vitest-environment jsdom
//
// Auto-hide in the DOM (#694 PR-3): the pin button on a docked region, the edge
// band, sliding a pane out and back (band tab, Esc, outside press, focus leaving,
// the top layer is not "outside"), pinning it back, and where the focus goes
// each time (the band tab, the pane, the region's pin button).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { compile } from 'svelte/compiler';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import autoHideSource from '../src/DockAutoHide.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import hostSource from '../src/DockHost.svelte?raw';
import { createDockState } from '../src/state.svelte';
import type { DockCapabilities } from '../src/core/policy';
import type { DockLayout } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const layout = (): DockLayout => ({
	version: 4,
	floating: [],
	docked: {
		type: 'split',
		id: 'root',
		direction: 'row',
		sizes: [0.7, 0.3],
		children: [
			{ type: 'panel', id: 'M', title: 'Main' },
			{ type: 'panel', id: 'R', title: 'Props' }
		]
	}
});

/** The main region: kept in place, no pin. */
const capabilities = (id: string): DockCapabilities | undefined =>
	id === 'M' ? { close: false, move: false, undock: false, autoHide: false } : undefined;

const settle = async () => {
	flushSync();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
};

function pointerdown(target: EventTarget) {
	const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: 1, clientY: 1, pointerId: 1, button: 0 });
	target.dispatchEvent(ev);
}

const bandTab = () => document.querySelector<HTMLElement>('[data-dock-band-tab="R"]')!;
const flyout = () => document.querySelector<HTMLElement>('[data-dock-flyout="R"]');

async function unpin() {
	screen.getByRole('button', { name: 'Propsを自動で隠す（ピンを外す）' }).click();
	await settle();
}

describe('DockHost auto-hide', () => {
	it('shows the pin only where capabilities allow, and unpinning moves the region to its band', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		expect(screen.queryByRole('button', { name: /Mainを自動で隠す/ })).toBeNull();
		const pin = screen.getByRole('button', { name: 'Propsを自動で隠す（ピンを外す）' });
		pin.focus();
		await unpin();
		expect(dock.autoHidden[0]).toMatchObject({ edge: 'right', node: { id: 'R' } });
		const band = screen.getByRole('group', { name: '右に自動で隠したパネル' });
		expect(band.contains(bandTab())).toBe(true);
		// The focused pin button left with the region: the focus went to its band tab.
		expect(document.activeElement).toBe(bandTab());
		expect(bandTab().getAttribute('aria-expanded')).toBe('false');
		expect(flyout()).toBeNull();
	});

	it('the band tab slides the pane out (focus inside); Esc slides it back (focus to the tab)', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		await unpin();
		bandTab().click();
		await settle();
		expect(dock.flyoutPanel).toBe('R');
		expect(bandTab().getAttribute('aria-expanded')).toBe('true');
		expect(flyout()!.hidden).toBe(false);
		expect(flyout()!.textContent).toContain('Props');
		expect(flyout()!.contains(document.activeElement)).toBe(true);
		document.activeElement!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await settle();
		expect(dock.flyoutPanel).toBeNull();
		// Not kept mounted: the content is gone.
		expect(flyout()).toBeNull();
		expect(document.activeElement).toBe(bandTab());
		// Pressing the tab twice toggles.
		bandTab().click();
		await settle();
		bandTab().click();
		await settle();
		expect(dock.flyoutPanel).toBeNull();
	});

	it('an outside press slides it back, a press in the top layer or its own tab does not', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		await unpin();
		bandTab().click();
		await settle();
		const pop = document.createElement('div');
		pop.setAttribute('popover', '');
		flyout()!.querySelector('.body')!.appendChild(pop);
		pointerdown(pop);
		const dialog = document.createElement('dialog');
		dialog.setAttribute('open', '');
		document.body.appendChild(dialog);
		pointerdown(dialog);
		pointerdown(bandTab());
		await settle();
		expect(dock.flyoutPanel).toBe('R');
		pointerdown(document.querySelector('[data-dock-drop-id="M"]')!);
		await settle();
		expect(dock.flyoutPanel).toBeNull();
		dialog.remove();
	});

	it('the focus leaving the pane slides it back; leaving into the top layer does not', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		await unpin();
		bandTab().click();
		await settle();
		const dialog = document.createElement('dialog');
		dialog.setAttribute('open', '');
		const inDialog = document.createElement('button');
		dialog.appendChild(inDialog);
		document.body.appendChild(dialog);
		inDialog.focus();
		await settle();
		expect(dock.flyoutPanel).toBe('R');
		flyout()!.querySelector<HTMLElement>('.body')!.focus();
		screen.getByRole('textbox', { name: 'Main input' }).focus();
		await settle();
		expect(dock.flyoutPanel).toBeNull();
		// The host / user moved the focus: it is not taken back.
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Main input' }));
		dialog.remove();
	});

	/**
	 * The DOM of `@banto/ui`'s OverlayPanel (Modal / ConfirmDialog): a scrim
	 * `div[role=presentation]` around a `div` with `role="dialog"` /
	 * `"alertdialog"` and `aria-modal="true"`, not a native `<dialog>` (#700).
	 */
	function overlayPanel(role: 'dialog' | 'alertdialog') {
		const overlay = document.createElement('div');
		overlay.className = 'overlay overlay--modal';
		overlay.setAttribute('role', 'presentation');
		const panel = document.createElement('div');
		panel.className = 'panel panel--modal';
		panel.setAttribute('role', role);
		panel.setAttribute('aria-modal', 'true');
		panel.setAttribute('aria-label', 'Confirm');
		const button = document.createElement('button');
		button.textContent = 'OK';
		panel.appendChild(button);
		overlay.appendChild(panel);
		document.body.appendChild(overlay);
		return { overlay, panel, button };
	}

	it('a modal layer (OverlayPanel) opened from the pane is not "outside": focus, press, scrim', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		await unpin();
		bandTab().click();
		await settle();
		for (const role of ['alertdialog', 'dialog'] as const) {
			const { overlay, panel, button } = overlayPanel(role);
			flyout()!.querySelector<HTMLElement>('.body')!.focus();
			button.focus();
			await settle();
			pointerdown(button);
			pointerdown(panel);
			pointerdown(overlay);
			await settle();
			expect(dock.flyoutPanel).toBe('R');
			overlay.remove();
		}
		// A layer that is leaving (`data-layer-inactive`) is no longer modal.
		const leaving = overlayPanel('alertdialog');
		leaving.panel.setAttribute('data-layer-inactive', 'true');
		pointerdown(leaving.button);
		await settle();
		expect(dock.flyoutPanel).toBeNull();
		leaving.overlay.remove();
	});

	it('a non-modal role="dialog" (a floating DockWindow) is still outside', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities });
		await unpin();
		bandTab().click();
		await settle();
		const win = document.createElement('div');
		win.setAttribute('role', 'dialog');
		win.setAttribute('aria-label', 'Window');
		const button = document.createElement('button');
		win.appendChild(button);
		document.body.appendChild(win);
		flyout()!.querySelector<HTMLElement>('.body')!.focus();
		button.focus();
		await settle();
		expect(dock.flyoutPanel).toBeNull();
		win.remove();
	});

	it('the pin of the slid-out pane puts the region back, the focus on its pin button', async () => {
		const asked: string[] = [];
		const dock = createDockState(layout());
		render(DockHostHarness, {
			dock,
			capabilities,
			beforePanelChange: (c) => {
				asked.push(`${c.kind}:${'panelId' in c ? c.panelId : ''}`);
				return true;
			}
		});
		await unpin();
		bandTab().click();
		await settle();
		asked.length = 0;
		screen.getByRole('button', { name: 'Propsを元の場所に固定（ピンを留める）' }).click();
		await settle();
		expect(dock.layout.docked).toEqual(layout().docked);
		expect(dock.autoHidden).toHaveLength(0);
		expect(asked).toEqual(['reparent:M', 'auto-hide:R']);
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Propsを自動で隠す（ピンを外す）' })
		);
	});

	it('a keepMounted pane stays mounted (hidden) while slid back', async () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock, capabilities, keepMounted: (id: string) => id === 'R' });
		await unpin();
		expect(flyout()!.hidden).toBe(true);
		bandTab().click();
		await settle();
		const input = screen.getByRole('textbox', { name: 'Props input' });
		input.focus();
		(input as HTMLInputElement).value = 'typed';
		dock.closeFlyout();
		await settle();
		expect(flyout()!.hidden).toBe(true);
		expect(flyout()!.querySelector('input')).toBe(input);
		expect((input as HTMLInputElement).value).toBe('typed');
		expect(document.activeElement).toBe(bandTab());
	});
});

// #1043: an open slide-out is above the floating windows. The order is the layers' (CSS), so
// the components' own style sheets are put in the document (the test build injects none):
// compiled as they are, minus the scoping class.
describe('the slide-out and the floating windows (#1043)', () => {
	function addStyles(): () => void {
		const added = [hostSource, autoHideSource].map((source: string) => {
			const { css } = compile(source, { css: 'external', cssHash: () => 'scoped' });
			const el = document.createElement('style');
			el.textContent = css!.code.replaceAll('.scoped', '');
			document.head.append(el);
			return el;
		});
		return () => added.forEach((el) => el.remove());
	}

	const withWindows = (): DockLayout => ({
		...layout(),
		floating: [
			{ id: 'a', title: 'Memo', x: 500, y: 100, width: 300, height: 200, open: true },
			{ id: 'b', title: 'Stock', x: 560, y: 160, width: 300, height: 200, open: true }
		]
	});
	const z = (el: Element) => Number(getComputedStyle(el).zIndex);
	const area = () => document.querySelector<HTMLElement>('.flyout-area')!;
	const floatingLayer = () => document.querySelector<HTMLElement>('.floating-layer')!;
	const windowZ = () =>
		[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map((w) => [
			w.getAttribute('aria-label'),
			w.style.zIndex
		]);

	it('the slide-out layer is above the floating layer, whatever window was raised; closing it leaves their order', async () => {
		const removeStyles = addStyles();
		try {
			const dock = createDockState(withWindows());
			render(DockHostHarness, { dock, capabilities });
			await unpin();
			// Raise the back window first: it is the front-most floating window from here on.
			dock.focus('a');
			await settle();
			const order = windowZ();
			const saved = dock.layout.floating.map((w) => w.id);
			expect(order).toEqual([
				['Memo', '2'],
				['Stock', '1']
			]);

			bandTab().click();
			await settle();
			expect(flyout()!.hidden).toBe(false);
			// Both layers are boxes of the host (one stacking context decides between them: the
			// auto-hide root in between has no box), and the windows' own z-index only counts
			// inside the floating layer.
			const host = document.querySelector('[data-dock-host]')!;
			const root = area().parentElement!;
			expect(getComputedStyle(root).display).toBe('contents');
			expect(root.parentElement).toBe(host);
			expect(floatingLayer().parentElement).toBe(host);
			expect(area().contains(flyout())).toBe(true);
			expect(getComputedStyle(area()).position).toBe('absolute');
			expect(z(floatingLayer())).toBe(1);
			expect(z(area())).toBe(2);
			expect(z(area())).toBeGreaterThan(z(floatingLayer()));
			// Still below what a drag draws over everything (the snap guide is 20).
			expect(z(area())).toBeLessThan(20);

			// A window raised while it is open (by the app): the slide-out stays above.
			dock.focus('b');
			await settle();
			expect(dock.flyoutPanel).toBe('R');
			expect(windowZ()).toEqual([
				['Memo', '1'],
				['Stock', '2']
			]);
			expect(z(area())).toBeGreaterThan(z(floatingLayer()));
			dock.focus('a');
			await settle();

			// Closed (Esc): the windows are in the order they were in.
			flyout()!.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
			await settle();
			expect(dock.flyoutPanel).toBeNull();
			expect(windowZ()).toEqual(order);
			expect(dock.layout.floating.map((w) => w.id)).toEqual(saved);
		} finally {
			removeStyles();
		}
	});

	it('a modal shown inside the slide-out is not held in its layer (it goes above the page by its own z-index)', async () => {
		const removeStyles = addStyles();
		try {
			const dock = createDockState(withWindows());
			render(DockHostHarness, { dock, capabilities });
			await unpin();
			bandTab().click();
			await settle();
			expect(z(area())).toBe(2);
			const modal = document.createElement('div');
			modal.setAttribute('aria-modal', 'true');
			flyout()!.append(modal);
			expect(getComputedStyle(area()).zIndex).not.toBe('2');
			modal.remove();
			expect(z(area())).toBe(2);
		} finally {
			removeStyles();
		}
	});
});
