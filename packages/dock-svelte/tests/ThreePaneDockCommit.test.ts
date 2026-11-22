// @vitest-environment jsdom
//
// `ThreePaneDock`'s `onLayoutCommit` and the settled `layoutSnapshot()` (#791 first half,
// downstream-requests-2026-11-plan §4.6 / §10-18):
//  - the narrow display's state is settled in the step that puts the layout in, so an effect on
//    `dock.layout` never reads `layoutSnapshot()` as the narrow display - also when the focus is
//    inside the frame (`replaceLayout` then waits a tick for the focus repair: the root cause);
//  - `onLayoutCommit` reports the value to save once per settled change, with its reason
//    (`'user'` / `'reset'` / `'narrow-switch'`), and nothing for the mount, a restore, a refused
//    change, a change to the narrow display or this component's own follow-ups (`panels`).
//
// jsdom: the same stubs as `ThreePaneDockNarrow.test.ts` (the width is a variable, the
// ResizeObserver's callbacks are called by `resize`).
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ThreePaneDockHarness from './ThreePaneDockHarness.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import { collectPanelIds } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import type {
	ThreePaneExtraPanelDef,
	ThreePaneLayoutCommitReason,
	ThreePaneSavedLayout
} from '../src/threePane';
import type { DockSplitNode } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];
let width = 1000;
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
	width = 1000;
});
afterEach(() => {
	cleanup();
	observers.clear();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
	flushSync();
}

/** The component width changes (the ResizeObserver fires). */
async function resize(to: number): Promise<void> {
	width = to;
	for (const cb of [...observers]) cb();
	await settle();
}

function mount(
	props: {
		dock?: DockState;
		extra?: ThreePaneExtraPanelDef[];
		initialLayout?: unknown;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		arrange?: boolean;
		onSave?: (snapshot: ThreePaneSavedLayout) => void;
	} = {}
) {
	const dock = props.dock ?? createDockState();
	const commits: [string, ThreePaneLayoutCommitReason][] = [];
	const view = render(ThreePaneDockHarness, {
		props: {
			...props,
			dock,
			onLayoutCommit: (value: ThreePaneSavedLayout, reason: ThreePaneLayoutCommitReason) =>
				commits.push([JSON.stringify(value), reason])
		}
	});
	flushSync();
	const api = () => view.component.api();
	return {
		dock,
		view,
		commits,
		api,
		harness: view.component,
		snapshot: () => JSON.stringify(api().layoutSnapshot())
	};
}

/** Give the left pane 40% (the app's own `DockState` change). */
function widenLeft(dock: DockState): void {
	const root = dock.layout.docked as DockSplitNode;
	const sizes = root.sizes.map((_, i) => (i === 0 ? 0.4 : 0.6 / (root.sizes.length - 1)));
	dock.layout = { ...dock.layout, docked: { ...root, sizes } };
}

describe('ThreePaneDock: layoutSnapshot is settled with the layout (#791)', () => {
	for (const focused of [false, true]) {
		it(`wide -> narrow -> wide never shows the narrow display to an effect on dock.layout${focused ? ' (focus inside the frame)' : ''}`, async () => {
			const saves: string[] = [];
			const { view, snapshot, harness } = mount({
				onSave: (value) => saves.push(JSON.stringify(value))
			});
			await settle();
			const wide = snapshot();
			const focus = () => {
				if (focused)
					view.container.querySelector<HTMLInputElement>('[aria-label="center input"]')!.focus();
			};
			saves.length = 0;
			focus();
			await resize(800);
			expect(harness.isNarrow()).toBe(true);
			expect(snapshot()).toBe(wide);
			focus();
			await resize(1000);
			expect(harness.isNarrow()).toBe(false);
			expect(snapshot()).toBe(wide);
			// The effect ran for both switches, and every value it read was the wide layout.
			expect(saves.length).toBeGreaterThanOrEqual(2);
			expect([...new Set(saves)]).toEqual([wide]);
		});
	}

	it('a reset while narrow (focus inside) is read as the kept default at once', async () => {
		const saves: string[] = [];
		const { api, dock, view, snapshot } = mount({
			onSave: (value) => saves.push(JSON.stringify(value))
		});
		widenLeft(dock);
		await settle();
		await resize(800);
		view.container.querySelector<HTMLInputElement>('[aria-label="center input"]')!.focus();
		saves.length = 0;
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		// Never the narrow display, never the custom layout the reset replaced.
		expect([...new Set(saves)]).toEqual([snapshot()]);
		expect(collectPanelIds(JSON.parse(snapshot()).layout.docked)).toEqual([
			'left',
			'center',
			'right'
		]);
	});
});

describe('ThreePaneDock onLayoutCommit', () => {
	it('is not called at mount (the default measured, or narrow from the start)', async () => {
		const wide = mount();
		await settle();
		expect(wide.commits).toEqual([]);
		cleanup();
		width = 800;
		const narrow = mount();
		await settle();
		expect(narrow.harness.isNarrow()).toBe(true);
		expect(narrow.commits).toEqual([]);
	});

	it("setVisible, a leftOpen write and the app's own DockState change report 'user' once each", async () => {
		const { api, dock, commits, harness, snapshot } = mount();
		await settle();
		expect(await api().setVisible('right', false)).toBe('applied');
		await settle();
		expect(commits).toEqual([[snapshot(), 'user']]);
		harness.setOpen('left', false);
		await settle();
		expect(commits).toHaveLength(2);
		expect(commits[1]).toEqual([snapshot(), 'user']);
		harness.setOpen('left', true);
		await settle();
		widenLeft(dock);
		await settle();
		expect(commits).toHaveLength(4);
		expect(commits[3]).toEqual([snapshot(), 'user']);
	});

	it('a keyboard step on a divider reports once', async () => {
		const { view, commits, snapshot } = mount();
		await settle();
		const divider = view.container.querySelector<HTMLElement>('[role="separator"]')!;
		divider.focus();
		divider.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
		);
		await settle();
		expect(commits).toEqual([[snapshot(), 'user']]);
	});

	it('a refused change, and a change refused by arrange={false}, report nothing', async () => {
		const refused = mount({ beforePanelChange: () => false });
		await settle();
		expect(await refused.api().setVisible('left', false)).toBe('refused');
		expect(await refused.api().resetLayout()).toBe('applied'); // nothing to ask: the same layout
		refused.commits.length = 0;
		refused.dock.undockPanel('left');
		await settle();
		refused.commits.length = 0;
		expect(await refused.api().resetLayout()).toBe('refused');
		await settle();
		expect(refused.commits).toEqual([]);
		cleanup();
		const kiosk = mount({ arrange: false });
		await settle();
		expect(await kiosk.api().resetLayout()).toBe('refused');
		expect(await kiosk.api().setVisible('left', false)).toBe('refused');
		await settle();
		expect(kiosk.commits).toEqual([]);
	});

	it("resetLayout reports 'reset' exactly once - not 'user' too - with the default", async () => {
		const { api, dock, commits, snapshot } = mount();
		await settle();
		const fresh = snapshot();
		widenLeft(dock);
		await settle();
		expect(commits.map((c) => c[1])).toEqual(['user']);
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		expect(commits.slice(1)).toEqual([[fresh, 'reset']]);
		// Already the default: still reported (the app may delete what it saved).
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		expect(commits.slice(1).map((c) => c[1])).toEqual(['reset', 'reset']);
	});

	it('restoreLayout reports nothing, and later changes are compared with the restored value', async () => {
		const { api, dock, commits, snapshot } = mount();
		await settle();
		widenLeft(dock);
		await settle();
		const custom = snapshot();
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		commits.length = 0;
		expect((await api().restoreLayout(custom)).outcome).toBe('applied');
		await settle();
		expect(snapshot()).toBe(custom);
		expect(commits).toEqual([]);
		expect(await api().setVisible('right', false)).toBe('applied');
		await settle();
		expect(commits).toEqual([[snapshot(), 'user']]);
	});

	it('the narrow switch reports nothing while the value to save is the same, nor do changes to the narrow display', async () => {
		const { api, dock, commits, snapshot, harness } = mount();
		await settle();
		widenLeft(dock);
		await settle();
		const custom = snapshot();
		commits.length = 0;
		await resize(800);
		expect(harness.isNarrow()).toBe(true);
		// A change to the narrow display (not saved): the left band goes away.
		expect(await api().setVisible('left', false)).toBe('applied');
		await settle();
		expect(snapshot()).toBe(custom);
		await resize(1000);
		expect(harness.isNarrow()).toBe(false);
		expect(snapshot()).toBe(custom);
		expect(commits).toEqual([]);
	});

	it("a reset while narrow reports 'reset' with the kept default; coming back wide reports 'narrow-switch' when the value changed", async () => {
		const { api, dock, commits, snapshot } = mount();
		await settle();
		widenLeft(dock);
		await settle();
		await resize(800);
		commits.length = 0;
		expect(await api().resetLayout()).toBe('applied');
		await settle();
		// The kept layout (the default measured at the narrow width), not the narrow display.
		expect(commits).toEqual([[snapshot(), 'reset']]);
		const kept = snapshot();
		await resize(1000);
		// The default is measured again at the width it comes back at: a new value to save.
		expect(snapshot()).not.toBe(kept);
		expect(commits.slice(1)).toEqual([[snapshot(), 'narrow-switch']]);
	});

	it('a restore while narrow reports nothing, then or when the width comes back', async () => {
		const { api, dock, commits, snapshot } = mount();
		await settle();
		widenLeft(dock);
		await settle();
		const custom = snapshot();
		expect(await api().resetLayout()).toBe('applied');
		await resize(800);
		commits.length = 0;
		expect((await api().restoreLayout(custom)).outcome).toBe('applied');
		await settle();
		expect(snapshot()).toBe(custom);
		await resize(1000);
		expect(snapshot()).toBe(custom);
		expect(commits).toEqual([]);
	});

	it('a change of panels by the app (an extra panel renamed, then removed) reports nothing', async () => {
		const LOG: ThreePaneExtraPanelDef = { id: 'log', title: 'Log', initial: { edge: 'bottom' } };
		const { view, commits, dock, snapshot } = mount({ extra: [LOG] });
		await settle();
		expect(collectPanelIds(dock.layout.docked)).toContain('log');
		// Titles only: written directly.
		await view.rerender({ extra: [{ ...LOG, title: 'Journal' }] });
		await settle();
		expect(snapshot()).toContain('Journal');
		// A structure change: through `replaceLayout`.
		await view.rerender({ extra: [] });
		await settle();
		expect(collectPanelIds(dock.layout.docked)).not.toContain('log');
		expect(commits).toEqual([]);
		// The next change is compared with what was followed.
		expect(await view.component.api().setVisible('right', false)).toBe('applied');
		await settle();
		expect(commits).toEqual([[snapshot(), 'user']]);
	});
});
