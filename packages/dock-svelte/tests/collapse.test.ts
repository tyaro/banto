// @vitest-environment jsdom
//
// Collapse (#663 ③-A): a floating window can be collapsed to its title bar. Covers the
// state methods, the layout JSON round trip / validation, and the mounted DockWindow
// (button aria, focus hand-off, no resize while collapsed, collapsing during a gesture).
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

const layout = (collapsed?: boolean): DockLayout => ({
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
			...(collapsed === undefined ? {} : { collapsed })
		}
	],
	docked: null
});

describe('DockState collapse', () => {
	it('defaults to expanded; setCollapsed toggles, keeps the geometry and drops the field', () => {
		const dock = createDockState(layout());
		expect(dock.isCollapsed('a')).toBe(false);
		dock.setCollapsed('a', true);
		expect(dock.isCollapsed('a')).toBe(true);
		expect(dock.layout.floating[0]).toMatchObject({ collapsed: true, height: 200 });
		dock.setCollapsed('a', false);
		expect('collapsed' in dock.layout.floating[0]).toBe(false);
		expect(dock.layout.floating[0].height).toBe(200);
		expect(dock.serialize()).not.toContain('collapsed');
	});

	it('ignores unknown and docked ids', () => {
		const dock = createDockState({
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.setCollapsed('d', true);
		dock.setCollapsed('nope', true);
		expect(dock.isCollapsed('d')).toBe(false);
		expect(dock.layout.floating).toHaveLength(0);
	});

	it('resize does nothing while collapsed; move still works; independent of locked', () => {
		const dock = createDockState(layout());
		dock.setCollapsed('a', true);
		dock.resize('a', 'se', 40, 40, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200 });
		dock.move('a', 50, 50, 800, 600);
		expect(dock.layout.floating[0]).toMatchObject({ x: 60, y: 70 });
		dock.setLocked('a', true);
		expect(dock.isCollapsed('a')).toBe(true);
		dock.setCollapsed('a', false);
		expect(dock.isLocked('a')).toBe(true);
	});

	it('keeps collapsed across close / open and a layout round trip', () => {
		const dock = createDockState(layout());
		dock.setCollapsed('a', true);
		dock.close('a');
		dock.open('a');
		expect(dock.isCollapsed('a')).toBe(true);
		expect(createDockState(dock.serialize()).isCollapsed('a')).toBe(true);
	});

	it('is dropped when the window docks, and a pane pulled out again starts expanded', () => {
		const dock = createDockState({
			version: 2,
			floating: [
				{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true, collapsed: true }
			],
			docked: { type: 'panel', id: 'd', title: 'D' }
		});
		dock.dockPanel('a', 'd', 'center');
		dock.undockPanel('a');
		expect(dock.layout.floating[0].id).toBe('a');
		expect(dock.isCollapsed('a')).toBe(false);
	});
});

describe('validateDockLayout collapsed', () => {
	it('reads an old layout without collapsed, and accepts a boolean', () => {
		expect(validateDockLayout(layout()).ok).toBe(true);
		const ok = validateDockLayout(layout(true));
		expect(ok.ok && ok.layout.floating[0].collapsed).toBe(true);
	});

	it('rejects a non-boolean collapsed', () => {
		const bad = layout() as unknown as { floating: Record<string, unknown>[] };
		bad.floating[0].collapsed = 'yes';
		const result = validateDockLayout(bad);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues).toContainEqual({
			code: 'shape',
			path: 'floating[0].collapsed'
		});
	});
});

describe('DockWindow collapse button', () => {
	it('toggles aria-expanded / label, wires aria-controls, hides the body, keeps focus on the button', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		const button = screen.getByRole('button', { name: 'Aを折りたたむ' });
		const body = dialog.querySelector('.body') as HTMLElement;
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-controls')).toBe(body.id);
		expect(body.hidden).toBe(false);
		button.focus();
		button.click();
		flushSync();
		const expand = screen.getByRole('button', { name: 'Aを展開' });
		expect(expand.getAttribute('aria-expanded')).toBe('false');
		expect(body.hidden).toBe(true);
		expect((body as HTMLElement & { inert?: boolean }).inert).toBe(true);
		expect(dock.isCollapsed('a')).toBe(true);
		expect(document.activeElement).toBe(expand);
		// the content stays mounted
		expect(dialog.querySelector('input')).not.toBeNull();
		expand.click();
		flushSync();
		expect(dock.isCollapsed('a')).toBe(false);
		expect(body.hidden).toBe(false);
	});

	it('has no resize handles or resize-mode button while collapsed, but keeps the move button', () => {
		const dock = createDockState(layout(true));
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		expect(dialog.querySelectorAll('.handle')).toHaveLength(0);
		expect(dialog.querySelectorAll('button.key-btn')).toHaveLength(1);
		expect(dialog.style.height).toBe('auto');
	});

	it('moves focus from inside the body to the collapse button, also for an API collapse', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const input = screen.getByLabelText('A input');
		input.focus();
		expect(document.activeElement).toBe(input);
		dock.setCollapsed('a', true);
		flushSync();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aを展開' }));
	});

	it('does not take a focus that is elsewhere', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();
		dock.setCollapsed('a', true);
		flushSync();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('collapsing during the keyboard resize mode cancels it and restores the geometry', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const resizeBtn = screen.getByRole('button', { name: /Aをキーボードでサイズ変更/ });
		resizeBtn.focus();
		resizeBtn.click();
		flushSync();
		resizeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(dock.layout.floating[0].width).toBe(310);
		dock.setCollapsed('a', true);
		flushSync();
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200, collapsed: true });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aを展開' }));
		// the owner is free again: the move mode can start
		const move = screen.getByRole('button', { name: /Aをキーボードで移動/ });
		move.click();
		flushSync();
		expect(move.getAttribute('aria-pressed')).toBe('true');
	});

	it('collapsing during a pointer resize cancels it', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const dialog = screen.getByRole('dialog', { name: 'A' });
		firePointer(dialog.querySelector('.handle-se')!, 'pointerdown', 310, 220);
		firePointer(window, 'pointermove', 340, 250);
		expect(dock.layout.floating[0].width).toBe(330);
		dock.setCollapsed('a', true);
		flushSync();
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200, collapsed: true });
		firePointer(window, 'pointermove', 400, 300);
		firePointer(window, 'pointerup', 400, 300);
		expect(dock.layout.floating[0]).toMatchObject({ width: 300, height: 200 });
	});

	it('a collapsed window can still be locked', () => {
		const dock = createDockState(layout(true));
		render(DockHostHarness, { dock });
		screen.getByRole('button', { name: /の位置と大きさを固定/ }).click();
		flushSync();
		expect(dock.isLocked('a')).toBe(true);
		expect(dock.isCollapsed('a')).toBe(true);
	});
});

describe('DockWindow lock focus hand-off (#685)', () => {
	const unlockBtn = () => screen.getByRole('button', { name: /固定を外す/ });
	const moveBtn = () => screen.getByRole('button', { name: /をキーボードで移動/ });
	const resizeBtn = () => screen.getByRole('button', { name: /をキーボードでサイズ変更/ });

	it('moves focus from the move button to the lock button on an API lock', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		moveBtn().focus();
		dock.setLocked('a', true);
		flushSync();
		expect(document.activeElement).toBe(unlockBtn());
	});

	it('moves focus from the resize button to the lock button on an API lock', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		resizeBtn().focus();
		dock.setLocked('a', true);
		flushSync();
		expect(document.activeElement).toBe(unlockBtn());
	});

	it('leaves the focus in the body input and outside the window alone', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const input = screen.getByLabelText('A input');
		input.focus();
		dock.setLocked('a', true);
		flushSync();
		expect(document.activeElement).toBe(input);
		dock.setLocked('a', false);
		flushSync();
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();
		dock.setLocked('a', true);
		flushSync();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('keeps the focus on the lock button when it is pressed', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		const lock = screen.getByRole('button', { name: /の位置と大きさを固定$/ });
		lock.focus();
		lock.click();
		flushSync();
		expect(document.activeElement).toBe(unlockBtn());
	});

	it('locking a collapsed window and collapsing a locked one never drop to body', () => {
		const dock = createDockState(layout(true));
		render(DockHostHarness, { dock });
		moveBtn().focus();
		dock.setLocked('a', true);
		flushSync();
		expect(document.activeElement).toBe(unlockBtn());
		dock.setLocked('a', false);
		dock.setCollapsed('a', false);
		flushSync();
		dock.setLocked('a', true);
		flushSync();
		unlockBtn().focus();
		dock.setCollapsed('a', true);
		flushSync();
		expect(document.activeElement).toBe(unlockBtn());
	});

	it('locking and collapsing in the same flush from the resize button lands on a live button', () => {
		const dock = createDockState(layout());
		render(DockHostHarness, { dock });
		resizeBtn().focus();
		dock.setLocked('a', true);
		dock.setCollapsed('a', true);
		flushSync();
		expect(document.activeElement).not.toBe(document.body);
		expect(document.activeElement?.tagName).toBe('BUTTON');
	});
});
