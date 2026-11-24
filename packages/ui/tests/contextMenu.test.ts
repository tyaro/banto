// @vitest-environment jsdom
/**
 * The context menu of `@banto/ui` (#889): a `Menu` without a `trigger`,
 * opened by `openAt({ x, y })` at a viewport point - placed like a trigger
 * menu (zero-size anchor, flipped / clamped), the same keyboard, focus back
 * to the element that had it (when it still exists), `closeOpenMenus` closes
 * it, and an open during a held pointer button waits for its release
 * (`pointerGesture.ts`). Real placement and light dismiss are browser
 * behaviour (e2e: the users list's row menu in e2e/tests/smoke.spec.ts).
 *
 * Same Popover API stand-in as menu.test.ts (jsdom has none), plus what the
 * browser's hide does before `toggle`: a synchronous `beforetoggle`, then focus
 * still inside goes back to the element focused when the popover was shown
 * (the HTML hide-popover steps) - the move that would otherwise beat a
 * `returnFocus` to it (#889 review; the real browser: e2e/visual/ui-overlays.spec.ts).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeOpenMenus } from '../src/index';
import ContextMenuHarness from './fixtures/ContextMenuHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

function fireToggle(el: HTMLElement, newState: 'open' | 'closed'): void {
	queueMicrotask(() => {
		const event = new Event('toggle');
		Object.defineProperty(event, 'newState', { value: newState });
		el.dispatchEvent(event);
	});
}

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	const shownFrom = new WeakMap<HTMLElement, Element | null>();
	proto.showPopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen === 'true') throw new Error('already open');
		shownFrom.set(this, document.activeElement);
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
		fireToggle(this, 'open');
	};
	proto.hidePopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen !== 'true') return;
		const before = new Event('beforetoggle');
		Object.defineProperty(before, 'newState', { value: 'closed' });
		this.dispatchEvent(before);
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
		const previous = shownFrom.get(this);
		if (this.contains(document.activeElement) && previous instanceof HTMLElement) {
			previous.focus();
		}
		fireToggle(this, 'closed');
	};
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	const root = document.documentElement as unknown as Record<string, unknown>;
	delete root.clientHeight;
	delete root.clientWidth;
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const item = (label: string) => screen.getByText(label).closest('button') as HTMLElement;

function setup(props: { showRow?: boolean } = {}) {
	const onEdit = vi.fn();
	const onDelete = vi.fn();
	const view = render(ContextMenuHarness, { onEdit, onDelete, ...props });
	const menu = screen.getByRole('menu', { hidden: true });
	type OpenAt = (
		p: { x: number; y: number },
		options?: { returnFocus?: HTMLElement | null }
	) => void;
	const openAt: OpenAt = (point, options) =>
		(view.component as unknown as { openAt: OpenAt }).openAt(point, options);
	return { ...view, menu, openAt, onEdit, onDelete };
}

/** A 960 x 480 viewport and a 200 x 100 menu. */
function stubGeometry(menu: HTMLElement): void {
	const root = document.documentElement;
	Object.defineProperty(root, 'clientHeight', { configurable: true, value: 480 });
	Object.defineProperty(root, 'clientWidth', { configurable: true, value: 960 });
	vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
		top: 0,
		bottom: 100,
		left: 0,
		right: 200,
		width: 200,
		height: 100,
		x: 0,
		y: 0,
		toJSON: () => ({})
	});
}

describe('Menu.openAt (context menu, #889)', () => {
	it('renders no trigger and opens at the point with the first enabled item focused', async () => {
		const { menu, openAt } = setup();
		expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
		stubGeometry(menu);
		screen.getByTestId('row').focus();
		openAt({ x: 300, y: 120 });
		await flush();
		expect(menu.dataset.popoverOpen).toBe('true');
		// Below-right of the point (bottom-start of a zero-size anchor, 4px gap).
		expect(menu.style.left).toBe('300px');
		expect(menu.style.top).toBe('124px');
		expect(document.activeElement).toBe(item('Edit'));
	});

	it('flips above and clamps to the viewport near the bottom-right corner', async () => {
		const { menu, openAt } = setup();
		stubGeometry(menu);
		openAt({ x: 950, y: 470 });
		await flush();
		expect(menu.style.left).toBe(`${960 - 200 - 4}px`);
		expect(menu.style.top).toBe(`${470 - 100 - 4}px`);
	});

	it('shares the keyboard of Menu: arrows skip disabled items and wrap, Home / End', async () => {
		const { menu, openAt } = setup();
		openAt({ x: 10, y: 10 });
		await flush();
		await fireEvent.keyDown(menu, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(item('Delete'));
		await fireEvent.keyDown(menu, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(item('Edit'));
		await fireEvent.keyDown(menu, { key: 'End' });
		expect(document.activeElement).toBe(item('Delete'));
		await fireEvent.keyDown(menu, { key: 'Home' });
		expect(document.activeElement).toBe(item('Edit'));
	});

	it('runs the item, closes and returns focus to the row it was opened from', async () => {
		const { menu, openAt, onDelete } = setup();
		const row = screen.getByTestId('row');
		row.focus();
		openAt({ x: 10, y: 10 });
		await flush();
		await fireEvent.click(item('Delete'));
		// Focus is back before the menu hides: a dialog the item opens records
		// the row, not the hidden item, as its opener.
		expect(document.activeElement).toBe(row);
		await flush();
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(menu.dataset.popoverOpen).toBeUndefined();
		expect(document.activeElement).toBe(row);
	});

	it('returns focus to the row on a close with focus still in the menu (Escape)', async () => {
		const { menu, openAt } = setup();
		const row = screen.getByTestId('row');
		row.focus();
		openAt({ x: 10, y: 10 });
		await flush();
		expect(document.activeElement).toBe(item('Edit'));
		(menu as PopoverElement).hidePopover(); // what the browser does on Escape
		await flush();
		expect(document.activeElement).toBe(row);
	});

	it('returns focus to `returnFocus`, not to the element focused at open (Escape, an item)', async () => {
		const { menu, openAt } = setup();
		const row = screen.getByTestId('row');
		const other = screen.getByTestId('other');
		row.focus();
		openAt({ x: 10, y: 10 }, { returnFocus: other });
		await flush();
		(menu as PopoverElement).hidePopover();
		await flush();
		expect(document.activeElement).toBe(other);
		row.focus();
		openAt({ x: 10, y: 10 }, { returnFocus: other });
		await flush();
		await fireEvent.click(item('Edit'));
		await flush();
		expect(document.activeElement).toBe(other);
	});

	it('Tab leaves focus to the browser (back where it opened from), not to `returnFocus`', async () => {
		const { menu, openAt } = setup();
		const row = screen.getByTestId('row');
		row.focus();
		openAt({ x: 10, y: 10 }, { returnFocus: screen.getByTestId('other') });
		await flush();
		await fireEvent.keyDown(menu, { key: 'Tab' });
		await flush();
		expect(menu.dataset.popoverOpen).toBeUndefined();
		expect(document.activeElement).toBe(row);
	});

	it('returnFocus: null leaves focus nowhere, not on the element focused at open', async () => {
		const { menu, openAt } = setup();
		screen.getByTestId('row').focus();
		openAt({ x: 10, y: 10 }, { returnFocus: null });
		await flush();
		(menu as PopoverElement).hidePopover();
		await flush();
		expect(document.activeElement).toBe(document.body);
	});

	it('keeps a focus move made outside the menu before it closes', async () => {
		const { menu, openAt } = setup();
		screen.getByTestId('row').focus();
		openAt({ x: 10, y: 10 });
		await flush();
		const other = screen.getByTestId('other');
		other.focus(); // an outside click focuses before the light dismiss
		(menu as PopoverElement).hidePopover();
		await flush();
		expect(document.activeElement).toBe(other);
	});

	it('leaves focus alone when the row is gone by the time it closes', async () => {
		const { menu, openAt, rerender } = setup();
		screen.getByTestId('row').focus();
		openAt({ x: 10, y: 10 });
		await flush();
		await rerender({ showRow: false });
		const other = screen.getByTestId('other');
		const focusSpy = vi.spyOn(other, 'focus');
		(menu as PopoverElement).hidePopover();
		await flush();
		expect(focusSpy).not.toHaveBeenCalled();
		expect(screen.queryByTestId('row')).toBeNull();
	});

	it('moves an open menu to the new point and keeps the first return target', async () => {
		const { menu, openAt } = setup();
		stubGeometry(menu);
		const row = screen.getByTestId('row');
		row.focus();
		openAt({ x: 10, y: 10 });
		await flush();
		openAt({ x: 400, y: 200 });
		await flush();
		expect(menu.dataset.popoverOpen).toBe('true');
		expect(menu.style.left).toBe('400px');
		expect(document.activeElement).toBe(item('Edit'));
		(menu as PopoverElement).hidePopover();
		await flush();
		expect(document.activeElement).toBe(row);
	});

	it('is closed by closeOpenMenus like a trigger menu (a modal opening)', async () => {
		const { menu, openAt } = setup();
		openAt({ x: 10, y: 10 });
		await flush();
		expect(closeOpenMenus()).toContain(menu);
		await flush();
		expect(menu.dataset.popoverOpen).toBeUndefined();
	});

	it('waits for the release when opened while a pointer button is held', async () => {
		const { menu, openAt } = setup();
		window.dispatchEvent(new Event('pointerdown'));
		openAt({ x: 10, y: 10 });
		await flush();
		expect(menu.dataset.popoverOpen).toBeUndefined();
		window.dispatchEvent(new Event('pointerup'));
		await flush();
		await flush();
		expect(menu.dataset.popoverOpen).toBe('true');
	});

	for (const [name, end] of [
		['pointercancel', () => window.dispatchEvent(new Event('pointercancel'))],
		['a window blur', () => window.dispatchEvent(new Event('blur'))]
	] as const) {
		it(`never opens when the press ends in ${name} (and moves no focus)`, async () => {
			const { menu, openAt } = setup();
			const row = screen.getByTestId('row');
			row.focus();
			window.dispatchEvent(new Event('pointerdown'));
			openAt({ x: 10, y: 10 });
			end();
			await flush();
			// A later release (of a new press) does not run the dropped open either.
			window.dispatchEvent(new Event('pointerdown'));
			window.dispatchEvent(new Event('pointerup'));
			await flush();
			await flush();
			expect(menu.dataset.popoverOpen).toBeUndefined();
			expect(document.activeElement).toBe(row);
		});
	}

	it('drops an open superseded by a later one during the same press', async () => {
		const { menu, openAt } = setup();
		stubGeometry(menu);
		window.dispatchEvent(new Event('pointerdown'));
		openAt({ x: 10, y: 10 });
		openAt({ x: 300, y: 50 });
		window.dispatchEvent(new Event('pointerup'));
		await flush();
		await flush();
		expect(menu.style.left).toBe('300px');
	});
});
