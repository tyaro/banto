// @vitest-environment jsdom
//
// Auto-hide in the DOM (#694 PR-3): the pin button on a docked region, the edge
// band, sliding a pane out and back (band tab, Esc, outside press, focus leaving,
// the top layer is not "outside"), pinning it back, and where the focus goes
// each time (the band tab, the pane, the region's pin button).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
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
	version: 2,
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
