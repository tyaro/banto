// @vitest-environment jsdom
/**
 * @banto/ui ThreePaneLayout (Issue #631 PR-1) and its pure width rules
 * (`threePane.ts`): the band's toggles (fold when wide, drawer when narrow),
 * the resize handles' ARIA values and keys / drag within the minimum, the
 * maximum and the centre's minimum, the narrow switch from the frame's own
 * width (ResizeObserver stubbed), Esc / scrim / focus return of the drawers,
 * and the overlapping cases (a drag when the frame turns narrow, a drawer
 * left open when it turns wide). Look and motion are the browser's.
 *
 * jsdom lays nothing out: `getClientRects()` is given one rect for connected
 * elements (as in commandPalette.test.ts) so focus restore sees them.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	clampPaneWidth,
	defaultUiMessages,
	fitPaneWidths,
	isNarrowWidth,
	paneMaxWidth
} from '../src/index';
import ThreePaneHarness from './fixtures/ThreePaneHarness.svelte';

const observers = new Set<{ callback: ResizeObserverCallback }>();

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
	};
	globalThis.ResizeObserver = class {
		callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
			observers.add(this);
		}
		observe() {}
		unobserve() {}
		disconnect() {
			observers.delete(this);
		}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Report a new frame width to every observer. */
async function resize(width: number): Promise<void> {
	for (const observer of observers) {
		observer.callback(
			[{ contentRect: { width } } as unknown as ResizeObserverEntry],
			observer as unknown as ResizeObserver
		);
	}
	await flush();
}

type State = {
	leftWidth: number;
	rightWidth: number;
	leftCollapsed: boolean;
	rightCollapsed: boolean;
	leftDrawerOpen: boolean;
	rightDrawerOpen: boolean;
	narrow: boolean;
};
const state = (): State => JSON.parse(screen.getByTestId('state').textContent ?? '{}');

const L = defaultUiMessages.threePaneLeft();
const R = defaultUiMessages.threePaneRight();
const leftToggle = () => screen.getByRole('button', { name: L, hidden: true });
const rightToggle = () => screen.getByRole('button', { name: R, hidden: true });
const controlled = (toggle: HTMLElement) =>
	document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
const leftPane = () => controlled(leftToggle());
const rightPane = () => controlled(rightToggle());
/** Svelte sets `inert` as a property; jsdom does not reflect it to the attribute. */
const isInert = (el: HTMLElement) =>
	el.hasAttribute('inert') || (el as HTMLElement & { inert?: boolean }).inert === true;
const handle = (name: string) => screen.getByRole('separator', { name });
const leftHandle = () => handle(defaultUiMessages.threePaneResizeLeft());
const rightHandle = () => handle(defaultUiMessages.threePaneResizeRight());
const values = (el: HTMLElement) =>
	['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((a) => Number(el.getAttribute(a)));
const center = () => screen.getByText('Body').closest('.three-pane__center') as HTMLElement;

function pointer(target: EventTarget, type: string, init: Record<string, number>): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { button: 0, pointerId: 1, ...init });
	target.dispatchEvent(event);
}

async function mount(props: Record<string, unknown> = {}, width = 1200) {
	const result = render(ThreePaneHarness, props);
	await resize(width);
	return result;
}

describe('ThreePaneLayout - wide', () => {
	it('lays out the panes, the band (toggles + title) and the handles', async () => {
		await mount();
		expect(leftPane().tagName).toBe('ASIDE');
		expect(leftPane().getAttribute('aria-label')).toBe(L);
		expect(rightPane().getAttribute('aria-label')).toBe(R);
		expect(leftToggle().getAttribute('aria-expanded')).toBe('true');
		expect(rightToggle().getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByText('Line 1')).toBeTruthy();
		expect(leftHandle().getAttribute('aria-orientation')).toBe('vertical');
		expect(leftHandle().getAttribute('aria-controls')).toBe(leftPane().id);
		expect(rightHandle().getAttribute('aria-controls')).toBe(rightPane().id);
		// 1200 - 360 (right) - 320 (centre) = 520 > 480 (left max).
		expect(values(leftHandle())).toEqual([280, 200, 480]);
		// 1200 - 280 - 320 = 600 < 640.
		expect(values(rightHandle())).toEqual([360, 240, 600]);
		expect(state().narrow).toBe(false);
	});

	it('moves the left handle with the arrows, Home and End, within its bounds', async () => {
		await mount();
		const h = leftHandle();
		await fireEvent.keyDown(h, { key: 'ArrowRight' });
		expect(state().leftWidth).toBe(296);
		await fireEvent.keyDown(h, { key: 'ArrowLeft' });
		await fireEvent.keyDown(h, { key: 'ArrowLeft' });
		expect(state().leftWidth).toBe(264);
		await fireEvent.keyDown(h, { key: 'Home' });
		expect(state().leftWidth).toBe(200);
		await fireEvent.keyDown(h, { key: 'ArrowLeft' });
		expect(state().leftWidth).toBe(200);
		await fireEvent.keyDown(h, { key: 'End' });
		expect(state().leftWidth).toBe(480);
		await fireEvent.keyDown(h, { key: 'ArrowRight' });
		expect(state().leftWidth).toBe(480);
		expect(values(h)[0]).toBe(480);
	});

	it('grows the right pane with ArrowLeft (its edge is on its left) and honours resizeStep', async () => {
		await mount({ resizeStep: 10 });
		const h = rightHandle();
		await fireEvent.keyDown(h, { key: 'ArrowLeft' });
		expect(state().rightWidth).toBe(370);
		await fireEvent.keyDown(h, { key: 'ArrowRight' });
		expect(state().rightWidth).toBe(360);
		await fireEvent.keyDown(h, { key: 'End' });
		expect(state().rightWidth).toBe(600);
	});

	it('keeps the centre at its minimum: the right pane gives way first, the asked-for width is kept', async () => {
		await mount({}, 920);
		// 280 + 360 + 320 = 960 > 920: the right pane shows 320, still asked 360.
		expect(values(rightHandle())[0]).toBe(320);
		expect(state().rightWidth).toBe(360);
		// The left may grow only into what the centre does not need.
		expect(values(leftHandle())).toEqual([280, 200, 280]);
		await resize(1400);
		expect(values(rightHandle())[0]).toBe(360);
	});

	it('drags a handle, focuses it, and stops at pointer up', async () => {
		await mount();
		const h = leftHandle();
		pointer(h, 'pointerdown', { clientX: 100 });
		expect(document.activeElement).toBe(h);
		pointer(window, 'pointermove', { clientX: 150 });
		await flush();
		expect(state().leftWidth).toBe(330);
		pointer(window, 'pointermove', { clientX: 1000 });
		await flush();
		expect(state().leftWidth).toBe(480);
		pointer(window, 'pointerup', { clientX: 1000 });
		pointer(window, 'pointermove', { clientX: 0 });
		await flush();
		expect(state().leftWidth).toBe(480);
	});

	it('ends a drag when the frame turns narrow mid-drag', async () => {
		await mount();
		pointer(leftHandle(), 'pointerdown', { clientX: 100 });
		await resize(800);
		expect(screen.queryByRole('separator')).toBeNull();
		pointer(window, 'pointermove', { clientX: 300 });
		await flush();
		expect(state().leftWidth).toBe(280);
		await resize(1200);
		pointer(window, 'pointermove', { clientX: 300 });
		await flush();
		expect(state().leftWidth).toBe(280);
	});

	it('folds a pane from its toggle, and focus inside a pane folded by the app goes to the toggle', async () => {
		const { rerender } = await mount();
		await fireEvent.click(leftToggle());
		expect(state().leftCollapsed).toBe(true);
		expect(leftPane().hidden).toBe(true);
		expect(leftToggle().getAttribute('aria-expanded')).toBe('false');
		expect(
			screen.queryByRole('separator', { name: defaultUiMessages.threePaneResizeLeft() })
		).toBeNull();
		// The right pane can take the room the left gave back.
		expect(values(rightHandle())[2]).toBe(640);
		await fireEvent.click(leftToggle());
		expect(state().leftCollapsed).toBe(false);

		screen.getByText('Detail').focus();
		await rerender({ rightCollapsed: true });
		await flush();
		expect(document.activeElement).toBe(rightToggle());
	});
});

describe('ThreePaneLayout - narrow', () => {
	it('switches at the frame width <= narrowBreakpoint (default 900, configurable)', async () => {
		await mount({}, 901);
		expect(state().narrow).toBe(false);
		await resize(900);
		expect(state().narrow).toBe(true);
		expect(isInert(leftPane())).toBe(true);
		expect(leftToggle().getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('separator')).toBeNull();
		await resize(0); // not laid out: keep the last answer
		expect(state().narrow).toBe(true);
		cleanup();
		await mount({ narrowBreakpoint: 600 }, 700);
		expect(state().narrow).toBe(false);
	});

	it('opens the left drawer: focus in, centre inert, Esc closes and focus returns', async () => {
		await mount({}, 800);
		leftToggle().focus();
		await fireEvent.click(leftToggle());
		await flush();
		expect(state().leftDrawerOpen).toBe(true);
		expect(isInert(leftPane())).toBe(false);
		expect(leftPane().hasAttribute('data-esc-layer')).toBe(true);
		expect(isInert(center())).toBe(true);
		expect(document.activeElement).toBe(screen.getByText('Node A'));
		await fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
		await flush();
		expect(state().leftDrawerOpen).toBe(false);
		expect(isInert(center())).toBe(false);
		expect(document.activeElement).toBe(leftToggle());
		// The target's name stays in the band.
		expect(screen.getByText('Line 1')).toBeTruthy();
	});

	it('closes on Esc from anywhere, but not when the Esc was already consumed', async () => {
		await mount({}, 800);
		await fireEvent.click(rightToggle());
		await flush();
		const consume = (event: KeyboardEvent) => event.preventDefault();
		document.addEventListener('keydown', consume);
		await fireEvent.keyDown(screen.getByText('Outside'), { key: 'Escape' });
		document.removeEventListener('keydown', consume);
		expect(state().rightDrawerOpen).toBe(true);
		await fireEvent.keyDown(screen.getByText('Outside'), { key: 'Escape' });
		expect(state().rightDrawerOpen).toBe(false);
	});

	it('closes on a scrim click and puts dropped focus back on the opener', async () => {
		const { container } = await mount({}, 800);
		leftToggle().focus();
		await fireEvent.click(leftToggle());
		await flush();
		(document.activeElement as HTMLElement).blur();
		await fireEvent.click(container.querySelector('.three-pane__scrim') as Element);
		await flush();
		expect(state().leftDrawerOpen).toBe(false);
		expect(container.querySelector('.three-pane__scrim')).toBeNull();
		expect(document.activeElement).toBe(leftToggle());
	});

	it('returns focus to the toggle when the app closes the drawer after a pick', async () => {
		await mount({}, 800);
		await fireEvent.click(leftToggle());
		await flush();
		await fireEvent.click(screen.getByText('Pick B'));
		await flush();
		expect(state().leftDrawerOpen).toBe(false);
		expect(document.activeElement).toBe(leftToggle());
	});

	it('keeps one drawer at a time', async () => {
		const { rerender } = await mount({}, 800);
		await fireEvent.click(leftToggle());
		await flush();
		await rerender({ rightDrawerOpen: true });
		await flush();
		expect(state().rightDrawerOpen).toBe(true);
		expect(state().leftDrawerOpen).toBe(false);
		expect(document.activeElement).toBe(screen.getByText('Detail'));
	});

	it('resets an open drawer when the frame turns wide, leaving focus in the pane', async () => {
		await mount({}, 800);
		await fireEvent.click(leftToggle());
		await flush();
		expect(document.activeElement).toBe(screen.getByText('Node A'));
		await resize(1200);
		expect(state().leftDrawerOpen).toBe(false);
		expect(isInert(leftPane())).toBe(false);
		expect(isInert(center())).toBe(false);
		expect(document.activeElement).toBe(screen.getByText('Node A'));
		// Back to narrow: the drawer is closed, focus inside goes to the toggle.
		await resize(800);
		expect(state().leftDrawerOpen).toBe(false);
		expect(document.activeElement).toBe(leftToggle());
	});

	it('moves focus out of a pane that retreats when the frame turns narrow', async () => {
		await mount();
		screen.getByText('Detail').focus();
		await resize(700);
		expect(document.activeElement).toBe(rightToggle());
	});
});

describe('ThreePaneLayout - text', () => {
	it('renders the title snippet and takes messages', async () => {
		await mount({
			withTitleSnippet: true,
			messages: { threePaneLeft: () => 'Tree', threePaneResizeLeft: () => 'Tree width' }
		});
		expect(screen.getByText('Snippet title')).toBeTruthy();
		expect(screen.queryByText('Line 1')).toBeNull();
		expect(screen.getByRole('complementary', { name: 'Tree' })).toBeTruthy();
		expect(screen.getByRole('separator', { name: 'Tree width' })).toBeTruthy();
	});
});

describe('threePane width rules', () => {
	it('clampPaneWidth: bounds, non-finite values, a max below the min', () => {
		expect(clampPaneWidth(100, 200, 480)).toBe(200);
		expect(clampPaneWidth(500, 200, 480)).toBe(480);
		expect(clampPaneWidth(200, 200, 480)).toBe(200);
		expect(clampPaneWidth(480, 200, 480)).toBe(480);
		expect(clampPaneWidth(Number.NaN, 200, 480)).toBe(200);
		expect(clampPaneWidth(0, 200, 480)).toBe(200);
		expect(clampPaneWidth(300, 200, 100)).toBe(200);
	});

	it('fitPaneWidths: right first, then left, never below the minimums', () => {
		const base = { leftMin: 200, rightMin: 240, centerMin: 320 };
		expect(fitPaneWidths({ ...base, available: null, left: 280, right: 360 })).toEqual({
			left: 280,
			right: 360
		});
		expect(fitPaneWidths({ ...base, available: 960, left: 280, right: 360 })).toEqual({
			left: 280,
			right: 360
		});
		expect(fitPaneWidths({ ...base, available: 900, left: 280, right: 360 })).toEqual({
			left: 280,
			right: 300
		});
		expect(fitPaneWidths({ ...base, available: 700, left: 280, right: 360 })).toEqual({
			left: 200,
			right: 240
		});
		expect(fitPaneWidths({ ...base, available: 600, left: 280, right: 0 })).toEqual({
			left: 280,
			right: 0
		});
		expect(fitPaneWidths({ ...base, available: 500, left: 280, right: 0 })).toEqual({
			left: 200,
			right: 0
		});
	});

	it('paneMaxWidth and isNarrowWidth', () => {
		const opts = { max: 480, min: 200, centerMin: 320 };
		expect(paneMaxWidth({ ...opts, available: null, other: 0 })).toBe(480);
		expect(paneMaxWidth({ ...opts, available: 1000, other: 360 })).toBe(320);
		expect(paneMaxWidth({ ...opts, available: 600, other: 360 })).toBe(200);
		expect(isNarrowWidth(900, 900)).toBe(true);
		expect(isNarrowWidth(901, 900)).toBe(false);
		expect(isNarrowWidth(0, 900)).toBe(false);
		expect(isNarrowWidth(null, 900)).toBe(false);
	});
});
