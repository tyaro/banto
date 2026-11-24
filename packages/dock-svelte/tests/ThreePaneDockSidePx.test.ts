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
import { cleanup, render } from '@testing-library/svelte';
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
