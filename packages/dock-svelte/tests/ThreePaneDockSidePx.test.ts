// @vitest-environment jsdom
//
// Issue #892: `ThreePaneDock`'s `sideWidthUnit="px"` - the sides keep their px when the width
// changes and the centre takes the rest; a divider moved sets the new px; a pane hidden / shown
// keeps the px of the others; the narrow display keeps nothing and the wide one comes back at the
// px; a restore takes the px off the saved shares. The saved value stays the version-4 layout of
// shares, and a width change alone is not reported (`onLayoutCommit`).
//
// jsdom: no layout; the host width is a variable (`width`) and the ResizeObserver is a stub whose
// callbacks the tests call (`resize`).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ThreePaneDockHarness from './ThreePaneDockHarness.svelte';
import { validateDockLayout } from '../src/core/validate';
import { createDockState, type DockState } from '../src/state.svelte';
import {
	THREE_PANE_DEFAULTS,
	threePaneDockLayout,
	threePaneSavedLayout,
	type ThreePaneExtraPanelDef,
	type ThreePaneLayoutCommitReason,
	type ThreePaneSavedLayout,
	type ThreePaneSideWidthUnit
} from '../src/threePane';
import type { DockSplitNode } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];
let width = 1280;
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
	width = 1280;
});
afterEach(() => {
	cleanup();
	observers.clear();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
	flushSync();
}

async function resize(to: number): Promise<void> {
	width = to;
	for (const cb of [...observers]) cb();
	await settle();
}

function mount(
	props: {
		sideWidthUnit?: ThreePaneSideWidthUnit;
		initialLayout?: unknown;
		initialLeftOpen?: boolean;
		narrowOverride?: boolean;
		extra?: ThreePaneExtraPanelDef[];
	} = {}
) {
	const dock: DockState = createDockState();
	const commits: [ThreePaneSavedLayout, ThreePaneLayoutCommitReason][] = [];
	const view = render(ThreePaneDockHarness, {
		props: {
			sideWidthUnit: 'px' as const,
			...props,
			dock,
			onLayoutCommit: (value: ThreePaneSavedLayout, reason: ThreePaneLayoutCommitReason) =>
				commits.push([value, reason])
		}
	});
	flushSync();
	return {
		dock,
		commits,
		harness: view.component,
		api: () => view.component.api(),
		/** The centre's row's children (by id) and their px at the current width. */
		px: () => {
			let row = dock.layout.docked as DockSplitNode;
			// Under a column (an extra panel along the bottom edge): its first child.
			if (row.direction === 'column') row = row.children[0] as DockSplitNode;
			return Object.fromEntries(row.children.map((c, i) => [c.id, row.sizes[i] * width]));
		}
	};
}

const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

describe("ThreePaneDock sideWidthUnit='px' (#892)", () => {
	it('keeps the sides at their px as the width changes, with no drift and no report', async () => {
		const { px, commits, dock } = mount();
		await settle();
		near(px().left, 280);
		near(px().right, 360);
		for (const to of [1600, 1000, 1920, 1280]) {
			await resize(to);
			near(px().left, 280);
			near(px().right, 360);
			expect(px().center).toBeCloseTo(to - 640, 6);
			expect(validateDockLayout(dock.layout).ok).toBe(true);
		}
		expect(commits).toEqual([]);
	});

	it('shrinks the sides in proportion to keep the centre minimum, and gives them back', async () => {
		const { px } = mount({ narrowOverride: false });
		await settle();
		await resize(800);
		expect(px().center).toBeGreaterThanOrEqual(THREE_PANE_DEFAULTS.centerMinWidth - 1e-6);
		near(px().left / px().right, 280 / 360);
		await resize(700);
		// 700 - 320 = 380 for 640 px of sides: under the side minimum, held at it.
		expect(px().left).toBeGreaterThanOrEqual(THREE_PANE_DEFAULTS.sideMinWidth - 1e-6);
		await resize(1500);
		near(px().left, 280);
		near(px().right, 360);
	});

	it('keeps the px of the row under a column (an extra panel along the bottom edge)', async () => {
		const { px, dock } = mount({
			extra: [{ id: 'log', title: 'Log', initial: { edge: 'bottom' } }]
		});
		await settle();
		expect((dock.layout.docked as DockSplitNode).direction).toBe('column');
		near(px().left, 280);
		await resize(1700);
		near(px().left, 280);
		near(px().right, 360);
	});

	it("'share' (the default) keeps the shares: the sides grow with the width", async () => {
		const { px } = mount({ sideWidthUnit: 'share' });
		await settle();
		await resize(1600);
		near(px().left, (280 / 1280) * 1600);
	});

	it('takes a divider the user moved as the new px, reported once', async () => {
		const { px, commits, dock } = mount();
		await settle();
		dock.resizeSplit('three-pane:root', 0, 100 / 1280);
		await settle();
		near(px().left, 380);
		expect(commits.map(([, reason]) => reason)).toEqual(['user']);
		await resize(1700);
		near(px().left, 380);
		near(px().right, 360);
		expect(commits).toHaveLength(1);
	});

	it('keeps the other side at its px when one is hidden, and brings it back at its own', async () => {
		const { px, api, commits, dock } = mount();
		await settle();
		expect(await api().setVisible('left', false)).toBe('applied');
		await settle();
		near(px().right, 360);
		near(px().center, 1280 - 360);
		// Reported once, as shown (fitted).
		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual([threePaneSavedLayout(dock.savedLayout()), 'user']);
		await resize(1500);
		expect(await api().setVisible('left', true)).toBe('applied');
		await settle();
		near(px().left, 280);
		near(px().right, 360);
		expect(commits).toHaveLength(2);
		expect(commits[1]).toEqual([threePaneSavedLayout(dock.savedLayout()), 'user']);
	});

	it('shows a side hidden at mount at its default px (the other at its own meanwhile)', async () => {
		const { px, api, commits } = mount({ initialLeftOpen: false });
		await settle();
		// The default layout gives the hidden side's room to the others: fitted, not reported.
		near(px().right, 360);
		expect(commits).toEqual([]);
		await resize(1600);
		near(px().right, 360);
		expect(await api().setVisible('left', true)).toBe('applied');
		await settle();
		near(px().left, 280);
		near(px().right, 360);
	});

	it('keeps nothing while narrow and comes back wide at the px', async () => {
		const { px, harness, api, dock } = mount();
		await settle();
		dock.resizeSplit('three-pane:root', 0, 100 / 1280);
		await settle();
		const before = api().layoutSnapshot();
		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		// The value to save is the kept wide layout (version 4, shares).
		expect(api().layoutSnapshot()).toEqual(before);
		await resize(1800);
		expect(harness.isNarrow()).toBe(false);
		near(px().left, 380);
		near(px().right, 360);
	});

	it('reads the px off the shares of a restored layout and of a reset', async () => {
		const { px, api } = mount();
		await settle();
		const stored = threePaneSavedLayout(
			threePaneDockLayout({
				hostWidth: 2000,
				leftWidth: 500,
				rightWidth: 300,
				panels: { left: { title: 'L' }, center: { title: 'C' }, right: { title: 'R' } }
			})
		);
		await api().restoreLayout(stored);
		await settle();
		// Shown at 1280: the shares at this width (the saved value holds no px).
		near(px().left, (500 / 2000) * 1280);
		await resize(1600);
		near(px().left, (500 / 2000) * 1280);
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		near(px().left, 280);
		await resize(1280);
		near(px().left, 280);
		near(px().right, 360);
		expect(api().layoutSnapshot().layout.version).toBe(4);
	});
});

function firePointer(target: EventTarget, type: string, x: number): void {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: 100, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
}

/** The divider between the left pane and the centre (the root row's first). */
const leftDivider = () => screen.getAllByRole('separator')[0];

describe("ThreePaneDock sideWidthUnit='px': the divider (#892 review)", () => {
	it('moves a side under the dock minimum share by a small drag, never jumping it the other way', async () => {
		const { px, api, commits } = mount();
		await resize(2000);
		const stored = threePaneSavedLayout(
			threePaneDockLayout({
				hostWidth: 2000,
				leftWidth: 120,
				rightWidth: 360,
				panels: { left: { title: 'L' }, center: { title: 'C' }, right: { title: 'R' } }
			})
		);
		await api().restoreLayout(stored);
		await settle();
		near(px().left, 120);
		// 1 px narrower: it stays (the dock's minimum share is 200 px here), not 200 px.
		firePointer(leftDivider(), 'pointerdown', 120);
		firePointer(window, 'pointermove', 119);
		firePointer(window, 'pointerup', 119);
		await settle();
		near(px().left, 120);
		// 1 px wider: 121 px, the new px.
		firePointer(leftDivider(), 'pointerdown', 120);
		firePointer(window, 'pointermove', 121);
		firePointer(window, 'pointerup', 121);
		await settle();
		near(px().left, 121);
		await resize(2400);
		near(px().left, 121);
		near(px().right, 360);
		expect(commits).toHaveLength(1);
	});

	it('puts a drag cancelled after a width change back at the px of its press', async () => {
		const { px, commits } = mount();
		await settle();
		near(px().left, 280);
		firePointer(leftDivider(), 'pointerdown', 280);
		firePointer(window, 'pointermove', 330);
		await settle();
		near(px().left, 330);
		await resize(1600);
		near(px().left, 330);
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await settle();
		near(px().left, 280);
		near(px().right, 360);
		// Nothing changed by the user: nothing reported.
		expect(commits).toEqual([]);
		// A pointercancel the same way.
		firePointer(leftDivider(), 'pointerdown', 280);
		firePointer(window, 'pointermove', 250);
		await settle();
		await resize(1280);
		firePointer(window, 'pointercancel', 250);
		await settle();
		near(px().left, 280);
		near(px().right, 360);
		expect(commits).toEqual([]);
	});

	it('puts a drag cancelled by the switch to the narrow display back at the px of its press', async () => {
		const { px, harness } = mount();
		await settle();
		firePointer(leftDivider(), 'pointerdown', 280);
		firePointer(window, 'pointermove', 330);
		await settle();
		near(px().left, 330);
		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		// The drag is over (cancelled by the switch): a late pointerup changes nothing.
		firePointer(window, 'pointerup', 330);
		await settle();
		await resize(1600);
		expect(harness.isNarrow()).toBe(false);
		near(px().left, 280);
		near(px().right, 360);
	});

	it('takes a drag committed after a width change at the px it is drawn at', async () => {
		const { px, commits } = mount();
		await settle();
		firePointer(leftDivider(), 'pointerdown', 280);
		firePointer(window, 'pointermove', 330);
		await settle();
		await resize(1600);
		firePointer(window, 'pointerup', 330);
		await settle();
		near(px().left, 330);
		near(px().right, 360);
		expect(commits).toHaveLength(1);
	});
});

describe("ThreePaneDock sideWidthUnit='px': drawn with bands and dividers (#892 review)", () => {
	// What the docked tree takes off a row, as the probes measure it (jsdom lays nothing out).
	const BAND = 32;
	const DIVIDER = 6;
	let rect: PropertyDescriptor | undefined;
	beforeAll(() => {
		rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
		const original = Element.prototype.getBoundingClientRect;
		Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
			configurable: true,
			writable: true,
			value: function (this: Element) {
				const w = this.classList.contains('band-probe')
					? BAND
					: this.classList.contains('divider-probe')
						? DIVIDER
						: null;
				return w === null ? original.call(this) : new DOMRect(0, 0, w, 0);
			}
		});
	});
	afterAll(() => {
		if (rect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
	});

	/**
	 * The px the root row's regions are drawn at, from the DOM as `DockedTree` renders it (a
	 * collapsed region a band, the open ones growing by their `flex-grow` in the room the bands, the
	 * dividers and the auto-hide edge bands leave), by the layout's ids.
	 */
	/** `flex-grow` reads back with 6 significant digits: a px within a hundredth. */
	const nearPx = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 2);

	function drawn(dock: DockState): Record<string, number> {
		const split = document.querySelector('[data-dock-host] .dock-split')!;
		const kids = [...split.children].filter((el) => el.classList.contains('split-child'));
		const dividers = [...split.children].filter((el) => el.classList.contains('divider')).length;
		const edges = new Set(dock.autoHidden.map((e) => e.edge));
		const shut = kids.map((el) => el.classList.contains('collapsed'));
		const room =
			width -
			BAND * ((edges.has('left') ? 1 : 0) + (edges.has('right') ? 1 : 0)) -
			BAND * shut.filter(Boolean).length -
			DIVIDER * dividers;
		const grows = kids.map((el, i) => (shut[i] ? 0 : Number((el as HTMLElement).style.flexGrow)));
		const total = grows.reduce((a, b) => a + b, 0);
		const row = dock.layout.docked as DockSplitNode;
		return Object.fromEntries(
			row.children.map((c, i) => [
				c.id,
				shut[i] ? BAND : room * (total < 1 ? grows[i] : grows[i] / total)
			])
		);
	}

	it('draws the sides at their px (the dividers taken off) as the width changes', async () => {
		const { dock } = mount();
		await settle();
		for (const to of [1280, 1600, 1000]) {
			await resize(to);
			nearPx(drawn(dock).left, 280);
			nearPx(drawn(dock).right, 360);
			nearPx(drawn(dock).center, to - 2 * DIVIDER - 640);
		}
	});

	it('keeps the open side at its px beside a side collapsed to a band, as the width changes', async () => {
		const { dock, commits } = mount();
		await settle();
		dock.setDockedCollapsed('left', true);
		await settle();
		expect(dock.layout.docked?.type === 'split' && dock.layout.docked.children[0]).toMatchObject({
			collapsed: true
		});
		nearPx(drawn(dock).right, 360);
		nearPx(drawn(dock).center, 1280 - BAND - 2 * DIVIDER - 360);
		// Reported once, as shown.
		expect(commits).toHaveLength(1);
		expect(commits[0][0]).toEqual(threePaneSavedLayout(dock.savedLayout()));
		await resize(1600);
		nearPx(drawn(dock).right, 360);
		nearPx(drawn(dock).center, 1600 - BAND - 2 * DIVIDER - 360);
		dock.setDockedCollapsed('left', false);
		await settle();
		nearPx(drawn(dock).left, 280);
		nearPx(drawn(dock).right, 360);
		nearPx(drawn(dock).center, 1600 - 2 * DIVIDER - 640);
	});

	it('keeps the open side at its px beside an auto-hide edge band, as the width changes', async () => {
		const { dock } = mount();
		await settle();
		expect(dock.autoHideRegion('left')).toBe(true);
		await settle();
		nearPx(drawn(dock).right, 360);
		nearPx(drawn(dock).center, 1280 - BAND - DIVIDER - 360);
		await resize(1600);
		nearPx(drawn(dock).right, 360);
		nearPx(drawn(dock).center, 1600 - BAND - DIVIDER - 360);
	});
});
