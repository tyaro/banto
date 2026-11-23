// @vitest-environment jsdom
//
// Lock (#663 ②, the "pin" before #694 PR-3): a floating window can be locked from
// its title bar; locked, its position and size stay put. Covers the state methods
// (and the deprecated `isPinned` / `setPinned` aliases), the layout JSON round trip /
// validation (an older JSON's `pinned: true` reads as `locked`), and the mounted
// DockWindow (button, drag, handles, the deprecated message keys).
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

const layout = (locked?: boolean, key: 'locked' | 'pinned' = 'locked'): DockLayout => ({
	version: 4,
	floating: [
		{
			id: 'a',
			title: 'A',
			x: 10,
			y: 20,
			width: 300,
			height: 200,
			open: true,
			...(locked === undefined ? {} : { [key]: locked })
		}
	],
	docked: null
});

describe('DockState lock', () => {
	it('defaults to not locked; setLocked toggles and drops the field when unlocked', () => {
		const dock = createDockState(layout());
		expect(dock.isLocked('a')).toBe(false);
		dock.setLocked('a', true);
		expect(dock.isLocked('a')).toBe(true);
		expect(dock.layout.floating[0].locked).toBe(true);
		dock.setLocked('a', false);
		expect(dock.isLocked('a')).toBe(false);
		expect('locked' in dock.layout.floating[0]).toBe(false);
		expect(dock.serialize()).not.toContain('locked');
		expect(dock.serialize()).not.toContain('pinned');
	});

	it('the deprecated isPinned / setPinned are aliases that write `locked`', () => {
		const dock = createDockState(layout());
		dock.setPinned('a', true);
		expect(dock.isLocked('a')).toBe(true);
		expect(dock.isPinned('a')).toBe(true);
		expect(dock.layout.floating[0]).toMatchObject({ locked: true });
		expect('pinned' in dock.layout.floating[0]).toBe(false);
		dock.setPinned('a', false);
		expect(dock.isLocked('a')).toBe(false);
	});

	it('a `pinned: true` assigned without validation counts as locked, and setLocked drops it', () => {
		const dock = createDockState(layout());
		dock.layout = { ...dock.layout, floating: [{ ...dock.layout.floating[0], pinned: true }] };
		expect(dock.isLocked('a')).toBe(true);
		dock.setLocked('a', true);
		expect(dock.layout.floating[0]).toMatchObject({ locked: true });
		expect('pinned' in dock.layout.floating[0]).toBe(false);
	});

	it('ignores unknown and docked ids', () => {
		const dock = createDockState({
			version: 4,
			floating: [],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.setLocked('d', true);
		dock.setLocked('nope', true);
		expect(dock.isLocked('d')).toBe(false);
		expect(dock.layout.floating).toHaveLength(0);
	});

	it('move and resize do nothing while locked, and work again after unlocking', () => {
		const dock = createDockState(layout());
		dock.setLocked('a', true);
		dock.move('a', 50, 50, 800, 600);
		dock.resize('a', 'se', 40, 40, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
		dock.setLocked('a', false);
		dock.move('a', 50, 50, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ x: 60, y: 70 });
	});

	it('keeps locked across close / open and a layout round trip', () => {
		const dock = createDockState(layout());
		dock.setLocked('a', true);
		dock.close('a');
		dock.open('a');
		expect(dock.isLocked('a')).toBe(true);
		const copy = createDockState(dock.serialize());
		expect(copy.isLocked('a')).toBe(true);
	});

	it('is dropped when the window docks, and a pane pulled out again starts unlocked', () => {
		const dock = createDockState({
			version: 4,
			floating: [
				{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true, locked: true }
			],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.dockPanel('a', 'd', 'center');
		dock.undockPanel('a');
		expect(dock.layout.floating[0].id).toBe('a');
		expect(dock.isLocked('a')).toBe(false);
	});
});

describe('validateDockLayout locked / pinned', () => {
	it('reads an old layout without the field, and accepts a boolean', () => {
		expect(validateDockLayout(layout()).ok).toBe(true);
		const ok = validateDockLayout(layout(true));
		expect(ok.ok && ok.layout.floating[0].locked).toBe(true);
	});

	it('reads an older JSON`s `pinned: true` as `locked: true` without mutating the input', () => {
		const input = layout(true, 'pinned');
		const result = validateDockLayout(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.layout.floating[0].locked).toBe(true);
		expect('pinned' in result.layout.floating[0]).toBe(false);
		expect(input.floating[0].pinned).toBe(true);
		const dropped = validateDockLayout(layout(false, 'pinned'));
		expect(dropped.ok && dropped.layout.floating[0]).not.toHaveProperty('pinned');
		expect(dropped.ok && dropped.layout.floating[0]).not.toHaveProperty('locked');
		const dock = createDockState(JSON.stringify(input));
		expect(dock.isLocked('a')).toBe(true);
		expect(dock.serialize()).not.toContain('pinned');
	});

	it('rejects a non-boolean locked / pinned', () => {
		for (const key of ['locked', 'pinned']) {
			const bad = layout() as unknown as { floating: Record<string, unknown>[] };
			bad.floating[0][key] = 'yes';
			const result = validateDockLayout(bad);
			expect(result.ok).toBe(false);
			expect(!result.ok && result.issues).toContainEqual({
				code: 'shape',
				path: `floating[0].${key}`
			});
		}
	});
});

describe('DockWindow lock button', () => {
	it('toggles aria-pressed and keeps focus on the button', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const button = screen.getByRole('button', { name: /の位置と大きさを固定/ });
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(button.classList.contains('lock-btn')).toBe(true);
		button.focus();
		button.click();
		flushSync();
		const pressed = screen.getByRole('button', { name: /固定を外す/ });
		expect(pressed.getAttribute('aria-pressed')).toBe('true');
		expect(dock.isLocked('a')).toBe(true);
		expect(document.activeElement).toBe(pressed);
		pressed.click();
		flushSync();
		expect(dock.isLocked('a')).toBe(false);
	});

	it('uses lockWindow / unlockWindow, and still honours the deprecated pinWindow / unpinWindow', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, {
			dock,
			messages: { pinWindow: (t: string) => `pin ${t}`, unpinWindow: (t: string) => `unpin ${t}` }
		});
		screen.getByRole('button', { name: 'pin A' }).click();
		flushSync();
		expect(screen.getByRole('button', { name: 'unpin A' })).toBeTruthy();
		cleanup();
		const dock2 = createDockState(layout());
		render(DockHostHarness, {
			dock: dock2,
			messages: { lockWindow: (t: string) => `lock ${t}`, pinWindow: (t: string) => `pin ${t}` }
		});
		expect(screen.getByRole('button', { name: 'lock A' })).toBeTruthy();
	});

	it('a locked window cannot be dragged and has no resize handles or keyboard mode buttons', () => {
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

	it('an unlocked window still has handles; locking during a drag cancels it', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		expect(dialog.querySelectorAll('.handle')).toHaveLength(8);

		firePointer(dialog.querySelector('.handle-se')!, 'pointerdown', 310, 220);
		firePointer(window, 'pointermove', 340, 250);
		expect(dock.layout.floating[0].width).toBe(330);
		dock.setLocked('a', true);
		flushSync();
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200 });
		firePointer(window, 'pointermove', 400, 300);
		firePointer(window, 'pointerup', 400, 300);
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200, locked: true });
	});
});
