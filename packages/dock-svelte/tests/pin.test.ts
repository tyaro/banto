// @vitest-environment jsdom
//
// Pin (#663 ②): a floating window can be pinned from its title bar; pinned,
// its position and size stay put. Covers the state methods, the layout JSON
// round trip / validation, and the mounted DockWindow (button, drag, handles).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import { validateDockLayout } from '../src/core/validate';
import type { DockLayout } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return 800;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return 600;
		}
	});
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		value: () => document.querySelector('[data-dock-host]')
	});
});

afterEach(cleanup);

function firePointer(target: EventTarget, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0 });
	target.dispatchEvent(ev);
}

const layout = (pinned?: boolean): DockLayout => ({
	version: 2,
	floating: [
		{
			id: 'a',
			title: 'A',
			x: 10,
			y: 20,
			width: 300,
			height: 200,
			open: true,
			...(pinned === undefined ? {} : { pinned })
		}
	],
	docked: null
});

describe('DockState pin', () => {
	it('defaults to not pinned; setPinned toggles and drops the field when unpinned', () => {
		const dock = createDockState(layout());
		expect(dock.isPinned('a')).toBe(false);
		dock.setPinned('a', true);
		expect(dock.isPinned('a')).toBe(true);
		expect(dock.layout.floating[0].pinned).toBe(true);
		dock.setPinned('a', false);
		expect(dock.isPinned('a')).toBe(false);
		expect('pinned' in dock.layout.floating[0]).toBe(false);
		expect(dock.serialize()).not.toContain('pinned');
	});

	it('ignores unknown and docked ids', () => {
		const dock = createDockState({
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.setPinned('d', true);
		dock.setPinned('nope', true);
		expect(dock.isPinned('d')).toBe(false);
		expect(dock.layout.floating).toHaveLength(0);
	});

	it('move and resize do nothing while pinned, and work again after unpinning', () => {
		const dock = createDockState(layout());
		dock.setPinned('a', true);
		dock.move('a', 50, 50, 800, 600);
		dock.resize('a', 'se', 40, 40, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
		dock.setPinned('a', false);
		dock.move('a', 50, 50, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ x: 60, y: 70 });
	});

	it('keeps pinned across close / open and a layout round trip', () => {
		const dock = createDockState(layout());
		dock.setPinned('a', true);
		dock.close('a');
		dock.open('a');
		expect(dock.isPinned('a')).toBe(true);
		const copy = createDockState(dock.serialize());
		expect(copy.isPinned('a')).toBe(true);
	});

	it('is dropped when the window docks, and a pane pulled out again starts unpinned', () => {
		const dock = createDockState({
			version: 2,
			floating: [
				{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true, pinned: true }
			],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.dockPanel('a', 'd', 'center');
		dock.undockPanel('a');
		expect(dock.layout.floating[0].id).toBe('a');
		expect(dock.isPinned('a')).toBe(false);
	});
});

describe('validateDockLayout pinned', () => {
	it('reads an old layout without pinned, and accepts a boolean', () => {
		expect(validateDockLayout(layout()).ok).toBe(true);
		const ok = validateDockLayout(layout(true));
		expect(ok.ok && ok.layout.floating[0].pinned).toBe(true);
	});

	it('rejects a non-boolean pinned', () => {
		const bad = layout() as unknown as { floating: Record<string, unknown>[] };
		bad.floating[0].pinned = 'yes';
		const result = validateDockLayout(bad);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues).toContainEqual({
			code: 'shape',
			path: 'floating[0].pinned'
		});
	});
});

describe('DockWindow pin button', () => {
	it('toggles aria-pressed and keeps focus on the button', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const button = screen.getByRole('button', { name: /の位置と大きさを固定/ });
		expect(button.getAttribute('aria-pressed')).toBe('false');
		button.focus();
		button.click();
		flushSync();
		const pressed = screen.getByRole('button', { name: /固定を外す/ });
		expect(pressed.getAttribute('aria-pressed')).toBe('true');
		expect(dock.isPinned('a')).toBe(true);
		expect(document.activeElement).toBe(pressed);
		pressed.click();
		flushSync();
		expect(dock.isPinned('a')).toBe(false);
	});

	it('a pinned window cannot be dragged and has no resize handles or keyboard mode buttons', () => {
		const dock = createDockState(layout(true));
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		expect(dialog.querySelectorAll('.handle')).toHaveLength(0);
		expect(dialog.querySelectorAll('button.key-btn')).toHaveLength(0);

		const titlebar = dialog.querySelector('.titlebar')!;
		firePointer(titlebar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130);
		firePointer(window, 'pointermove', 300, 300);
		firePointer(window, 'pointerup', 300, 300);
		expect(dock.layout.floating[0]).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
	});

	it('an unpinned window still has handles; pinning during a drag cancels it', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		expect(dialog.querySelectorAll('.handle')).toHaveLength(8);

		firePointer(dialog.querySelector('.handle-se')!, 'pointerdown', 310, 220);
		firePointer(window, 'pointermove', 340, 250);
		expect(dock.layout.floating[0].width).toBe(330);
		dock.setPinned('a', true);
		flushSync();
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200 });
		firePointer(window, 'pointermove', 400, 300);
		firePointer(window, 'pointerup', 400, 300);
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200, pinned: true });
	});
});
