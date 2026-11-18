// @vitest-environment jsdom
//
// The pane lifecycle of DockHost (#432, shared-primitives-upstream-plan §3.5 /
// §4.2 / D3-c / D4, PR-9): `beforePanelChange` is asked before every structure
// change (dock / undock / move-docked / reparent / tab-switch / hide / close) and a
// refusal - sync or async - leaves the layout alone; an async answer is not
// applied once the structure changed or the host unmounted; re-entrant hooks;
// `keepMounted` panes keep the same DOM nodes (`hidden` + `inert`) across a tab
// switch and a hide; hide vs close; structure changes are held during IME
// composition and resume on `compositionend`.
//
// jsdom has no layout engine: the host size is a controllable `clientWidth` /
// `clientHeight` and `elementFromPoint` returns `hit()` (the host = "free
// floating space" unless a test points it at a docked frame); all restored in
// afterAll. Pointer events are plain `Event`s with the fields assigned.
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import type { DockLayout, DockTabGroupNode } from '../src/types';

let hit: () => Element | null = () => document.querySelector('[data-dock-host]');
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
	stub(document, 'elementFromPoint', { writable: true, value: () => hit() });
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	hit = () => document.querySelector('[data-dock-host]');
});

function firePointer(target: EventTarget, type: string, x: number, y: number): void {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
}

/** A press that crosses the drag threshold and is released at (x2, y2). */
function dragFrom(target: EventTarget, x2 = 300, y2 = 300): void {
	firePointer(target, 'pointerdown', 100, 100);
	firePointer(window, 'pointermove', 130, 130);
	firePointer(window, 'pointermove', x2, y2);
	firePointer(window, 'pointerup', x2, y2);
	flushSync();
}

/** A press without movement (a tab click). */
function clickPress(target: EventTarget): void {
	firePointer(target, 'pointerdown', 10, 10);
	firePointer(window, 'pointerup', 10, 10);
	flushSync();
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

const floating = (): DockLayout => ({
	version: 2,
	floating: [
		{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true },
		{ id: 'b', title: 'B', x: 500, y: 300, width: 300, height: 200, open: true }
	],
	docked: null
});

/** A tab group (x, y) next to a plain pane (p), plus one floating window (f). */
const mixed = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.5, 0.5],
		children: [
			{
				type: 'tabs',
				id: 't',
				activeIndex: 0,
				children: [
					{ type: 'panel', id: 'x', title: 'X' },
					{ type: 'panel', id: 'y', title: 'Y' }
				]
			},
			{ type: 'panel', id: 'p', title: 'P' }
		]
	}
});

type Props = {
	beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (panelId: string) => boolean;
	isStructureChangeDeferred?: () => boolean;
};

function mount(layout: DockLayout, props: Props = {}) {
	const dock = createDockState(layout);
	const view = render(DockHostHarness, { dock, ...props });
	return { dock, view, host: () => view.component.host() };
}

const winOf = (dock: DockState, id: string) => dock.layout.floating.find((w) => w.id === id);
const groupOf = (dock: DockState) => {
	const split = dock.layout.docked as { children: DockTabGroupNode[] };
	return split.children[0];
};
const closeButton = (name: string) =>
	screen.getByRole('button', { name: `${name}を閉じる` }) as HTMLButtonElement;
const inputOf = (name: string) =>
	document.querySelector(`input[aria-label="${name} input"]`) as HTMLInputElement | null;
const dialogOf = (name: string) =>
	document.querySelector(`[role="dialog"][aria-label="${name}"]`) as HTMLElement | null;
// Svelte sets the `hidden` / `inert` PROPERTIES; browsers reflect them to the
// attributes (what `[hidden]` CSS and the a11y tree see), jsdom does not.
const isHiddenInert = (el: Element | null) =>
	el instanceof HTMLElement &&
	el.hidden &&
	(el as HTMLElement & { inert?: boolean }).inert === true;

describe('beforePanelChange is asked for every kind, and a sync refusal leaves the layout', () => {
	it('close (✕ of a floating window that is not keepMounted)', () => {
		const calls: DockPanelChange[] = [];
		let allow = false;
		const { dock } = mount(floating(), {
			beforePanelChange: (c) => (calls.push(c), allow)
		});
		closeButton('A').click();
		flushSync();
		expect(calls).toEqual([{ kind: 'close', panelId: 'a' }]);
		expect(winOf(dock, 'a')!.open).toBe(true);
		allow = true;
		closeButton('A').click();
		flushSync();
		expect(winOf(dock, 'a')!.open).toBe(false);
		expect(dialogOf('A')).toBeNull();
	});

	it('hide (✕ of a keepMounted floating window)', () => {
		const calls: DockPanelChange[] = [];
		const { dock } = mount(floating(), {
			beforePanelChange: (c) => (calls.push(c), false),
			keepMounted: (id) => id === 'a'
		});
		closeButton('A').click();
		flushSync();
		expect(calls).toEqual([{ kind: 'hide', panelId: 'a', remount: false }]);
		expect(winOf(dock, 'a')!.open).toBe(true);
	});

	it('hide / close of a docked pane (✕); a docked keepMounted pane re-mounts', () => {
		const calls: DockPanelChange[] = [];
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) => (calls.push(c), false),
			keepMounted: (id) => id === 'x'
		});
		closeButton('X').click();
		closeButton('P').click();
		flushSync();
		expect(calls).toEqual([
			{ kind: 'hide', panelId: 'x', remount: true },
			{ kind: 'close', panelId: 'p' }
		]);
		expect(dock.layout).toEqual(mixed());
	});

	it('tab-switch by click and by arrow key', () => {
		const calls: DockPanelChange[] = [];
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) => (calls.push(c), false),
			keepMounted: (id) => id === 'x'
		});
		clickPress(screen.getByRole('tab', { name: 'Y' }));
		const tabX = screen.getByRole('tab', { name: 'X' });
		tabX.focus();
		tabX.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
		);
		flushSync();
		const expected = { kind: 'tab-switch', groupId: 't', from: 'x', to: 'y', remount: false };
		expect(calls).toEqual([expected, expected]);
		expect(groupOf(dock).activeIndex).toBe(0);
		// A refused arrow does not move the focus either.
		expect(document.activeElement).toBe(tabX);
	});

	it('undock (docked pane dropped on free space)', () => {
		const calls: DockPanelChange[] = [];
		const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(c), false) });
		dragFrom(screen.getByRole('toolbar', { name: 'P' }));
		expect(calls).toEqual([{ kind: 'undock', panelId: 'p', remount: true }]);
		expect(dock.layout).toEqual(mixed());
		expect(document.querySelector('.drag-ghost')).toBeNull();
	});

	it('dock (floating window dropped on a docked pane) and move-docked (docked onto docked)', () => {
		const calls: DockPanelChange[] = [];
		// The pushed-out pane (P becomes a background tab, #666) agrees; the moved pane's own change is refused.
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) => (calls.push(c), c.kind === 'tab-switch')
		});
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragFrom(dialogOf('F')!.querySelector('.titlebar')!);
		dragFrom(screen.getByRole('tab', { name: 'X' }));
		expect(calls).toEqual([
			{ kind: 'tab-switch', groupId: 'f:dropped', from: 'p', to: 'f', remount: true },
			{ kind: 'dock', panelId: 'f', remount: true },
			{ kind: 'tab-switch', groupId: 'x:dropped', from: 'p', to: 'x', remount: true },
			{ kind: 'move-docked', panelId: 'x', remount: true }
		]);
		expect(dock.layout).toEqual(mixed());
	});

	it('an allowed change applies; a geometry-only drag and the app API are not asked', () => {
		const hook = vi.fn(() => true);
		const { dock } = mount(mixed(), { beforePanelChange: hook });
		dragFrom(screen.getByRole('toolbar', { name: 'P' }));
		expect(winOf(dock, 'p')?.open).toBe(true);
		hook.mockClear();
		dragFrom(dialogOf('F')!.querySelector('.titlebar')!); // free space = a move
		dock.close('f');
		flushSync();
		expect(hook).not.toHaveBeenCalled();
	});

	it('a throwing hook refuses', () => {
		const { dock } = mount(floating(), {
			beforePanelChange: () => {
				throw new Error('boom');
			}
		});
		closeButton('A').click();
		flushSync();
		expect(winOf(dock, 'a')!.open).toBe(true);
	});
});

describe('async answers', () => {
	it('applies on true, not on false or rejection', async () => {
		let answer = deferred<boolean>();
		const { dock, host } = mount(floating(), { beforePanelChange: () => answer.promise });
		const first = host().closePanel('a');
		expect(winOf(dock, 'a')!.open).toBe(true);
		answer.resolve(false);
		expect(await first).toBe('refused');
		expect(winOf(dock, 'a')!.open).toBe(true);

		answer = deferred<boolean>();
		const second = host().closePanel('a');
		answer.resolve(true);
		expect(await second).toBe('applied');
		expect(winOf(dock, 'a')!.open).toBe(false);

		const { dock: d2, host: h2 } = mount(floating(), {
			beforePanelChange: () => Promise.reject(new Error('no'))
		});
		expect(await h2().closePanel('b')).toBe('refused');
		expect(winOf(d2, 'b')!.open).toBe(true);
	});

	it('is not applied when the structure changed while pending; geometry changes do not count', async () => {
		let answer = deferred<boolean>();
		const { dock, host } = mount(floating(), { beforePanelChange: () => answer.promise });
		const stale = host().closePanel('a');
		dock.close('b'); // a structure change meanwhile
		answer.resolve(true);
		expect(await stale).toBe('stale');
		expect(winOf(dock, 'a')!.open).toBe(true);
		// Only the target was left alone: B's change is kept.
		expect(winOf(dock, 'b')!.open).toBe(false);

		answer = deferred<boolean>();
		const ok = host().closePanel('a');
		dock.move('a', 30, 30, 1000, 600);
		dock.focus('a');
		answer.resolve(true);
		expect(await ok).toBe('applied');
		expect(winOf(dock, 'a')!.open).toBe(false);
	});

	it('is not applied after the host unmounted', async () => {
		const answer = deferred<boolean>();
		const { dock, host, view } = mount(floating(), { beforePanelChange: () => answer.promise });
		const pending = host().closePanel('a');
		view.unmount();
		answer.resolve(true);
		expect(await pending).toBe('disposed');
		expect(winOf(dock, 'a')!.open).toBe(true);
	});

	it('a double click while the answer is pending asks once', async () => {
		const answer = deferred<boolean>();
		const hook = vi.fn(() => answer.promise);
		const { dock } = mount(floating(), { beforePanelChange: hook });
		closeButton('A').click();
		closeButton('A').click();
		expect(hook).toHaveBeenCalledTimes(1);
		answer.resolve(true);
		await nextTask();
		expect(winOf(dock, 'a')!.open).toBe(false);
	});
});

describe('async answers: identity and generation (PR #448 review)', () => {
	it('a drop on Y while a drop on X waits is asked on its own; X approved first applies, Y is then stale', async () => {
		const answers = [deferred<boolean>(), deferred<boolean>()];
		const calls: DockPanelChange[] = [];
		// Both drops push a pane out first (#666): those are the answers that wait; the docks are allowed.
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) =>
				c.kind === 'tab-switch' ? (calls.push(c), answers[calls.length - 1].promise) : true
		});
		const titlebar = () => dialogOf('F')!.querySelector('.titlebar')!;
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragFrom(titlebar());
		hit = () => document.querySelector('[data-dock-drop-id="t"]');
		dragFrom(titlebar());
		expect(calls).toHaveLength(2);
		answers[1].resolve(true); // the later drop (onto the tab group) is approved first
		await nextTask();
		expect(winOf(dock, 'f')).toBeUndefined();
		expect(JSON.stringify(groupOf(dock))).toContain('"f"');
		const afterY = JSON.parse(JSON.stringify(dock.layout)) as DockLayout;
		answers[0].resolve(true);
		await nextTask();
		// The approval for P is stale: F stays where the approved drop put it.
		expect(dock.layout).toEqual(afterY);
	});

	it('close -> open (a fresh mount) while a close waits: the old approval does not close the new content', async () => {
		const answer = deferred<boolean>();
		const { dock, host } = mount(floating(), { beforePanelChange: () => answer.promise });
		const pending = host().closePanel('a');
		dock.close('a');
		flushSync();
		dock.open('a');
		flushSync();
		inputOf('A')!.value = 'typed into the new mount';
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a')!.open).toBe(true);
		expect(inputOf('A')!.value).toBe('typed into the new mount');
	});
});

describe('re-entrant hooks', () => {
	it('a hook that makes another structure change: the old decision is not applied, the new change is', () => {
		const ref: { m?: ReturnType<typeof mount> } = {};
		const calls: string[] = [];
		const m = mount(floating(), {
			beforePanelChange: (c) => {
				calls.push(c.kind + ':' + ('panelId' in c ? c.panelId : ''));
				if ('panelId' in c && c.panelId === 'a') void ref.m!.host().closePanel('b');
				return true;
			}
		});
		ref.m = m;
		closeButton('A').click();
		flushSync();
		expect(calls).toEqual(['close:a', 'close:b']);
		expect(winOf(m.dock, 'b')!.open).toBe(false);
		expect(winOf(m.dock, 'a')!.open).toBe(true);
	});

	it('a hook that unmounts the host: nothing is applied and nothing throws', () => {
		const ref: { m?: ReturnType<typeof mount> } = {};
		const m = mount(floating(), {
			beforePanelChange: () => {
				ref.m!.view.unmount();
				return true;
			}
		});
		ref.m = m;
		expect(() => closeButton('A').click()).not.toThrow();
		expect(winOf(m.dock, 'a')!.open).toBe(true);
	});

	it('a hook that unmounts the host from a drag commit leaves no ghost and no change', () => {
		const ref: { m?: ReturnType<typeof mount> } = {};
		const m = mount(mixed(), {
			beforePanelChange: () => {
				ref.m!.view.unmount();
				return true;
			}
		});
		ref.m = m;
		dragFrom(screen.getByRole('toolbar', { name: 'P' }));
		expect(m.dock.layout).toEqual(mixed());
		expect(document.querySelector('.drag-ghost')).toBeNull();
	});
});

describe('keepMounted keeps the same DOM (hidden + inert)', () => {
	it('across a tab switch; a pane that is not keepMounted is unmounted', () => {
		const { dock } = mount(mixed(), { keepMounted: (id) => id === 'x' });
		const input = inputOf('X')!;
		input.value = 'unsaved';
		clickPress(screen.getByRole('tab', { name: 'Y' }));
		expect(groupOf(dock).activeIndex).toBe(1);
		expect(inputOf('X')).toBe(input);
		expect(isHiddenInert(input.closest('.tab-content'))).toBe(true);
		const inputY = inputOf('Y')!;
		expect(isHiddenInert(inputY.closest('.tab-content'))).toBe(false);

		clickPress(screen.getByRole('tab', { name: 'X' }));
		expect(inputOf('X')).toBe(input);
		expect(input.value).toBe('unsaved');
		expect(isHiddenInert(input.closest('.tab-content'))).toBe(false);
		expect(inputOf('Y')).toBeNull(); // Y is not keepMounted
	});

	it('across a hide of a floating window, and shown again by open', () => {
		const { dock } = mount(floating(), { keepMounted: (id) => id === 'a' });
		const dialog = dialogOf('A')!;
		const input = inputOf('A')!;
		input.value = 'unsaved';
		closeButton('A').click();
		flushSync();
		expect(winOf(dock, 'a')!.open).toBe(false);
		expect(dialogOf('A')).toBe(dialog);
		expect(isHiddenInert(dialog)).toBe(true);
		expect(dialog.classList.contains('frontmost')).toBe(false);

		dock.open('a');
		flushSync();
		expect(dialogOf('A')).toBe(dialog);
		expect(isHiddenInert(dialog)).toBe(false);
		expect(inputOf('A')!.value).toBe('unsaved');
	});

	it('without keepMounted nothing changes: closing a window unmounts it', () => {
		const { dock } = mount(floating());
		closeButton('A').click();
		flushSync();
		expect(dialogOf('A')).toBeNull();
		dock.open('a');
		flushSync();
		expect(inputOf('A')!.value).toBe('');
	});

	it('hiding a window ends its keyboard mode', () => {
		const { dock } = mount(floating(), { keepMounted: () => true });
		const modeButton = screen.getByRole('button', { name: /Aをキーボードで移動/ });
		modeButton.focus();
		modeButton.click();
		flushSync();
		expect(modeButton.getAttribute('aria-pressed')).toBe('true');
		dock.close('a');
		flushSync();
		expect(modeButton.getAttribute('aria-pressed')).toBe('false');
		// The owner is free again: B's mode can start.
		const modeB = screen.getByRole('button', { name: /Bをキーボードで移動/ });
		modeB.focus();
		modeB.click();
		flushSync();
		expect(modeB.getAttribute('aria-pressed')).toBe('true');
	});
});

describe('hide vs close (D4-a)', () => {
	it('closePanel discards a keepMounted pane; opening it again mounts a fresh one', async () => {
		const calls: DockPanelChange[] = [];
		const { dock, host } = mount(floating(), {
			keepMounted: (id) => id === 'a',
			beforePanelChange: (c) => (calls.push(c), true)
		});
		inputOf('A')!.value = 'unsaved';
		expect(await host().hidePanel('a')).toBe('applied');
		flushSync();
		expect(isHiddenInert(dialogOf('A'))).toBe(true);
		// The hidden content can still be discarded - that is a close.
		expect(await host().closePanel('a')).toBe('applied');
		flushSync();
		expect(dialogOf('A')).toBeNull();
		expect(calls.map((c) => c.kind)).toEqual(['hide', 'close']);
		// Already hidden and not kept: nothing to ask.
		expect(await host().closePanel('a')).toBe('applied');
		expect(await host().hidePanel('a')).toBe('applied');
		expect(calls).toHaveLength(2);

		dock.open('a');
		flushSync();
		expect(inputOf('A')!.value).toBe('');
		// Shown again, so a later hide keeps it again.
		closeButton('A').click();
		flushSync();
		expect(isHiddenInert(dialogOf('A'))).toBe(true);
		expect(winOf(dock, 'a')!.width).toBe(320); // geometry kept throughout
	});

	it('hiding a docked keepMounted pane leaves it mounted in a hidden floating window', () => {
		const { dock } = mount(mixed(), { keepMounted: (id) => id === 'p' });
		closeButton('P').click();
		flushSync();
		expect(winOf(dock, 'p')?.open).toBe(false);
		expect(isHiddenInert(dialogOf('P'))).toBe(true);
		expect(inputOf('P')).not.toBeNull();
	});

	it('unknown ids are stale and not asked', async () => {
		const hook = vi.fn(() => true);
		const { host } = mount(floating(), { beforePanelChange: hook });
		expect(await host().closePanel('nope')).toBe('stale');
		expect(await host().hidePanel('nope')).toBe('stale');
		expect(hook).not.toHaveBeenCalled();
	});
});

describe('IME composition holds structure changes', () => {
	function compose(target: Element, type: 'compositionstart' | 'compositionend'): void {
		target.dispatchEvent(new Event(type, { bubbles: true }));
	}

	it('a close requested during composition is asked and applied after compositionend', async () => {
		const hook = vi.fn(() => true);
		const { dock } = mount(floating(), { beforePanelChange: hook });
		const input = inputOf('B')!;
		input.focus();
		compose(input, 'compositionstart');
		closeButton('A').click();
		flushSync();
		expect(hook).not.toHaveBeenCalled();
		expect(winOf(dock, 'a')!.open).toBe(true);

		compose(input, 'compositionend');
		expect(winOf(dock, 'a')!.open).toBe(true); // not before the next task
		await nextTask();
		expect(hook).toHaveBeenCalledWith({ kind: 'close', panelId: 'a' });
		expect(winOf(dock, 'a')!.open).toBe(false);
	});

	it('a tab click during composition switches after compositionend', async () => {
		const { dock } = mount(mixed());
		const input = inputOf('X')!;
		input.focus();
		compose(input, 'compositionstart');
		clickPress(screen.getByRole('tab', { name: 'Y' }));
		expect(groupOf(dock).activeIndex).toBe(0);
		compose(input, 'compositionend');
		await nextTask();
		expect(groupOf(dock).activeIndex).toBe(1);
	});

	it('a drag does not start during composition; resize still does', () => {
		const { dock } = mount(mixed());
		const input = inputOf('P')!;
		input.focus();
		compose(input, 'compositionstart');
		const toolbar = screen.getByRole('toolbar', { name: 'P' });
		firePointer(toolbar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 200, 200);
		flushSync();
		expect(document.querySelector('.drag-ghost')).toBeNull();
		firePointer(window, 'pointerup', 200, 200);
		flushSync();
		expect(dock.layout).toEqual(mixed());

		const handle = dialogOf('F')!.querySelector('.handle-se')!;
		firePointer(handle, 'pointerdown', 900, 500);
		firePointer(window, 'pointermove', 920, 500);
		firePointer(window, 'pointerup', 920, 500);
		expect(winOf(dock, 'f')!.width).toBe(320);
	});

	it('a removed composing element does not hold changes forever', () => {
		const { dock } = mount(floating());
		const input = inputOf('B')!;
		input.focus();
		compose(input, 'compositionstart');
		input.remove(); // no compositionend from some browsers
		closeButton('A').click();
		flushSync();
		expect(winOf(dock, 'a')!.open).toBe(false);
	});

	it('a custom predicate holds until resumeDeferredChange; a newer request supersedes the held one', async () => {
		let deferring = true;
		const hook = vi.fn(() => true);
		const { dock, host } = mount(floating(), {
			beforePanelChange: hook,
			isStructureChangeDeferred: () => deferring
		});
		const first = host().closePanel('a');
		const second = host().closePanel('b');
		expect(await first).toBe('superseded');
		host().resumeDeferredChange(); // still deferring: nothing happens
		expect(hook).not.toHaveBeenCalled();
		deferring = false;
		host().resumeDeferredChange();
		expect(await second).toBe('applied');
		expect(winOf(dock, 'a')!.open).toBe(true);
		expect(winOf(dock, 'b')!.open).toBe(false);
	});

	it('a held change resolves disposed when the host unmounts', async () => {
		const { dock, host, view } = mount(floating(), { isStructureChangeDeferred: () => true });
		const held = host().closePanel('a');
		view.unmount();
		expect(await held).toBe('disposed');
		expect(winOf(dock, 'a')!.open).toBe(true);
	});
});

// #666: a drop also pushes other docked panes out - a new split or tab group
// made around a pane re-mounts it (Svelte cannot move a component to another
// parent), a new active tab takes the old one off the screen. Those panes are
// asked first, like a tab click (refused = nothing changes; IME hold; an
// approval whose structure moved meanwhile is stale), then the dropped pane.
describe('a drop asks the docked panes it pushes out (#666)', () => {
	/** A pane frame of 1000 x 600 at the origin, so a release near an edge is an edge drop. */
	function paneRects(): void {
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			left: 0,
			top: 0,
			right: 1000,
			bottom: 600,
			width: 1000,
			height: 600,
			x: 0,
			y: 0,
			toJSON: () => ({})
		} as DOMRect);
	}
	const titlebarF = () => dialogOf('F')!.querySelector('.titlebar')!;
	/** F dropped on the bottom edge of the bare pane P: a new column split is made around P. */
	function dropFBelowP(): void {
		paneRects();
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragFrom(titlebarF(), 500, 590);
	}
	/** F dropped in the middle of the tab group t (X active). */
	function dropFOnTabs(): void {
		hit = () => document.querySelector('[data-dock-drop-id="t"]');
		dragFrom(titlebarF());
	}
	const label = (c: DockPanelChange) =>
		c.kind === 'tab-switch'
			? `tab-switch ${c.from}>${c.to}${c.remount ? '' : ' kept'}`
			: `${c.kind} ${c.panelId}`;

	describe('a new split around a bare pane', () => {
		it('refused: nothing changes, the dropped pane is not asked, focus and ghost are left alone', () => {
			const calls: string[] = [];
			const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), false) });
			const input = inputOf('X')!;
			input.focus();
			dropFBelowP();
			expect(calls).toEqual(['reparent p']);
			expect(dock.layout).toEqual(mixed());
			expect(document.activeElement).toBe(input);
			expect(document.querySelector('.drag-ghost')).toBeNull();
			expect(document.querySelector('.snap-guide')).toBeNull();
		});

		it('allowed: P is asked, then F; F docks below P and P is mounted again', () => {
			const calls: string[] = [];
			const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), true) });
			const before = inputOf('P');
			dropFBelowP();
			expect(calls).toEqual(['reparent p', 'dock f']);
			const root = dock.layout.docked as { children: unknown[] };
			expect(root.children[1]).toMatchObject({
				type: 'split',
				direction: 'column',
				children: [{ id: 'p' }, { id: 'f' }]
			});
			// What the question is about: the content really is a new mount.
			expect(inputOf('P')).not.toBeNull();
			expect(inputOf('P')).not.toBe(before);
		});

		it('keepMounted does not save it: still asked with remount true', () => {
			const asked: DockPanelChange[] = [];
			mount(mixed(), {
				beforePanelChange: (c) => (asked.push(c), false),
				keepMounted: () => true
			});
			dropFBelowP();
			expect(asked).toEqual([{ kind: 'reparent', panelId: 'p', cause: 'f', remount: true }]);
		});

		it('held while deferred (IME), asked and applied after resume', async () => {
			let deferring = false;
			let answer: (ok: boolean) => void = () => {};
			const calls: string[] = [];
			const { dock, host } = mount(mixed(), {
				beforePanelChange: (c) => {
					calls.push(label(c));
					return c.kind === 'reparent' ? new Promise<boolean>((r) => (answer = r)) : true;
				},
				isStructureChangeDeferred: () => deferring
			});
			dropFBelowP();
			deferring = true; // a composition starts while the answer is pending
			answer(true);
			await nextTask();
			expect(calls).toEqual(['reparent p']);
			expect(dock.layout).toEqual(mixed());
			deferring = false;
			host().resumeDeferredChange();
			expect(calls).toEqual(['reparent p', 'dock f']);
			expect(winOf(dock, 'f')).toBeUndefined();
		});

		it('an approval whose structure changed meanwhile is stale: F is not asked nor docked', async () => {
			let answer: (ok: boolean) => void = () => {};
			const calls: string[] = [];
			const { dock } = mount(mixed(), {
				beforePanelChange: (c) => (calls.push(label(c)), new Promise<boolean>((r) => (answer = r)))
			});
			dropFBelowP();
			dock.setActiveTab('t', 1); // the app switches a tab while the answer waits
			answer(true);
			await nextTask();
			expect(calls).toEqual(['reparent p']);
			expect(winOf(dock, 'f')?.open).toBe(true);
		});
	});

	describe('a drop on a tab group', () => {
		it('refused: the active tab stays, nothing changes, the dropped pane is not asked', () => {
			const asked: DockPanelChange[] = [];
			const { dock } = mount(mixed(), { beforePanelChange: (c) => (asked.push(c), false) });
			dropFOnTabs();
			expect(asked).toEqual([
				{ kind: 'tab-switch', groupId: 't', from: 'x', to: 'f', remount: true }
			]);
			expect(dock.layout).toEqual(mixed());
		});

		it('allowed: the old active tab, then F; F is the active tab', () => {
			const calls: string[] = [];
			const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), true) });
			dropFOnTabs();
			expect(calls).toEqual(['tab-switch x>f', 'dock f']);
			const group = groupOf(dock);
			expect(group.children.map((c) => c.id)).toEqual(['x', 'y', 'f']);
			expect(group.activeIndex).toBe(2);
		});

		it('a keepMounted active tab: remount false, and its DOM is kept', () => {
			const calls: string[] = [];
			mount(mixed(), {
				beforePanelChange: (c) => (calls.push(label(c)), true),
				keepMounted: (id) => id === 'x'
			});
			const before = inputOf('X');
			dropFOnTabs();
			expect(calls).toEqual(['tab-switch x>f kept', 'dock f']);
			expect(inputOf('X')).toBe(before);
			expect(isHiddenInert(before!.closest('.tab-content'))).toBe(true);
		});

		it('held while deferred (IME), asked and applied after resume', async () => {
			let deferring = false;
			let answer: (ok: boolean) => void = () => {};
			const calls: string[] = [];
			const { dock, host } = mount(mixed(), {
				beforePanelChange: (c) => {
					calls.push(label(c));
					return c.kind === 'tab-switch' ? new Promise<boolean>((r) => (answer = r)) : true;
				},
				isStructureChangeDeferred: () => deferring
			});
			dropFOnTabs();
			deferring = true;
			answer(true);
			await nextTask();
			expect(groupOf(dock).activeIndex).toBe(0);
			deferring = false;
			host().resumeDeferredChange();
			expect(calls).toEqual(['tab-switch x>f', 'dock f']);
			expect(groupOf(dock).children[groupOf(dock).activeIndex].id).toBe('f');
		});

		it('a docked pane moved onto the group asks the active tab too', () => {
			const calls: string[] = [];
			const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), false) });
			hit = () => document.querySelector('[data-dock-drop-id="t"]');
			dragFrom(screen.getByRole('toolbar', { name: 'P' }));
			expect(calls).toEqual(['tab-switch x>p']);
			expect(dock.layout).toEqual(mixed());
		});
	});
});
